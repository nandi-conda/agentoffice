// AT Protocol OAuth sign-in. A finished OAuth flow proves the visitor
// controls a DID; we then hand them a signed cookie holding just that DID,
// and the office only ever trusts DIDs that come from that cookie.
//
// Runtime-neutral on purpose: only fetch, Request/Response and Web Crypto,
// so the same module runs under Node and on Cloudflare Workers.
//
// Two client modes:
//  - loopback (no PUBLIC_URL, local dev): no hosting needed. The client_id
//    is `http://localhost?...` and the redirect goes to http://127.0.0.1:PORT.
//  - public web client: PUBLIC_URL=https://office.example.com, and we serve
//    the client metadata at /oauth/client-metadata.json.

import { OAuthClient } from '@atproto/oauth-client';
import { JoseKey } from '@atproto/jwk-jose';
import { buildAtprotoLoopbackClientId } from '@atproto/oauth-types';
import { identityResolver } from './atproto.js';

export const COOKIE = 'ao_session';
const MAX_AGE = 30 * 24 * 3600; // seconds
const SCOPE = 'atproto';
// How long a stored OAuth session (DPoP key + refresh token) is kept. It is
// used to talk to freeq as the signed-in person (see freeq.js).
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const isLoopbackUrl = (u) => !u || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(u);

export function clientMetadata({ publicUrl, port }) {
  if (isLoopbackUrl(publicUrl)) {
    const redirect = `http://127.0.0.1:${port}/oauth/callback`;
    return {
      loopback: true,
      origin: `http://127.0.0.1:${port}`,
      metadata: {
        client_id: buildAtprotoLoopbackClientId({ scope: SCOPE, redirect_uris: [redirect] }),
        redirect_uris: [redirect],
        scope: SCOPE,
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        dpop_bound_access_tokens: true,
      },
    };
  }
  const base = publicUrl.replace(/\/$/, '');
  return {
    loopback: false,
    origin: base,
    metadata: {
      client_id: `${base}/oauth/client-metadata.json`,
      client_name: 'Agent Office',
      client_uri: base,
      redirect_uris: [`${base}/oauth/callback`],
      scope: SCOPE,
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    },
  };
}

// ---- signed session cookie (HMAC-SHA256 via Web Crypto) ---------------------

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signSession(did, secret, now = Date.now()) {
  const exp = Math.floor(now / 1000) + MAX_AGE;
  const body = b64url(enc.encode(JSON.stringify({ did, exp })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    // subtle.verify compares in constant time.
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body)))) return null;
    const { did, exp } = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (typeof did !== 'string' || !did.startsWith('did:') || exp * 1000 < now) return null;
    return did;
  } catch { return null; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- OAuth stores -----------------------------------------------------------

// In-memory store with expiry: fine for one Node process. On Workers, pass a
// KV / Durable Object backed store with the same get/set/del shape, because
// /oauth/login and /oauth/callback can land on different isolates.
export function memoryStore(ttlMs) {
  const m = new Map();
  return {
    async set(k, v) { m.set(k, { v, at: Date.now() }); },
    async get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (Date.now() - e.at > ttlMs) { m.delete(k); return undefined; }
      return e.v;
    },
    async del(k) { m.delete(k); },
  };
}

// Stores only ever see plain JSON: the DPoP key goes in as a private JWK.
// The OAuth client wraps errors ("Failed to resolve identity: x"); surface the cause too.
const reason = (e) => [e?.message, e?.cause?.message].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i).join(': ');

function jsonKeyStore(store) {
  return {
    async set(k, { dpopKey, ...data }) { await store.set(k, { ...data, dpopJwk: dpopKey.privateJwk }); },
    async get(k) {
      const r = await store.get(k);
      if (!r) return undefined;
      const { dpopJwk, ...data } = r;
      return { ...data, dpopKey: await JoseKey.fromJWK(dpopJwk) };
    },
    async del(k) { await store.del(k); },
  };
}

// ---- the auth handler -------------------------------------------------------

// secret: string used to sign session cookies (keep it stable across restarts).
// stateStore/sessionStore: optional JSON stores (see memoryStore).
export function createAuth({ publicUrl, port = 8080, secret, stateStore, sessionStore, fetch: fetchImpl }) {
  if (!secret) throw new Error('createAuth needs a session secret');
  const cfg = clientMetadata({ publicUrl, port });
  const locks = new Map();
  const client = new OAuthClient({
    responseMode: 'query',
    clientMetadata: cfg.metadata,
    // Handle (DoH, .well-known, public API) and DID document resolution live
    // in atproto.js; see the note there on why.
    identityResolver,
    fetch: fetchImpl,
    stateStore: jsonKeyStore(stateStore || memoryStore(15 * 60 * 1000)),
    sessionStore: jsonKeyStore(sessionStore || memoryStore(SESSION_TTL_MS)),
    runtimeImplementation: {
      createKey: (algs) => JoseKey.generate(algs),
      getRandomValues: (n) => crypto.getRandomValues(new Uint8Array(n)),
      digest: async (bytes, alg) => new Uint8Array(await crypto.subtle.digest(alg.name.replace('sha', 'SHA-'), bytes)),
      // Serialise refreshes per key within this process.
      requestLock: async (name, fn) => {
        const prev = locks.get(name) || Promise.resolve();
        const run = prev.then(fn, fn);
        locks.set(name, run.catch(() => {}));
        return run;
      },
    },
  });
  const secure = cfg.origin.startsWith('https:');
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
  const fail = (msg) => redirect('/?auth_error=' + encodeURIComponent(msg));

  return {
    ...cfg,

    // The verified DID from a request's Cookie header, or null.
    didFromCookie(header) { return verifySession(parseCookies(header)[COOKIE], secret); },

    // What freeq's SASL "pds-oauth" method needs to check a signed-in person
    // with their PDS: the DPoP-bound access token, and a DPoP proof for
    // GET {pds}/xrpc/com.atproto.server.getSession (freeq forwards both).
    // `nonce` is the PDS's DPoP nonce when freeq has relayed one.
    async freeqCredentials(did, nonce = null) {
      let session;
      try { session = await client.restore(did); } catch { throw new Error('sign in again to talk on freeq'); }
      const pds = (await session.getTokenInfo()).aud.replace(/\/$/, '');
      const url = `${pds}/xrpc/com.atproto.server.getSession`;
      if (!nonce) {
        // Asking the PDS ourselves checks the token and learns its DPoP nonce.
        const r = await session.fetchHandler('/xrpc/com.atproto.server.getSession');
        if (!r.ok) throw new Error(`your PDS refused the sign-in token (${r.status})`);
        nonce = await Promise.resolve().then(() => session.server.dpopNonces.get(new URL(pds).origin)).catch(() => undefined);
      }
      // getTokenSet is the library's own accessor; it refreshes when needed.
      const { access_token: accessToken } = await session.getTokenSet('auto');
      const key = session.server.dpopKey;
      const algs = session.serverMetadata.dpop_signing_alg_values_supported || ['ES256'];
      const alg = key.algorithms.find((a) => algs.includes(a)) || key.algorithms[0];
      const ath = b64url(await crypto.subtle.digest('SHA-256', enc.encode(accessToken)));
      const dpopProof = await key.createJwt(
        { alg, typ: 'dpop+jwt', jwk: key.bareJwk },
        { iat: Math.floor(Date.now() / 1000), jti: b64url(crypto.getRandomValues(new Uint8Array(12))), htm: 'GET', htu: url, nonce: nonce || undefined, ath },
      );
      return { did, pds, accessToken, dpopProof };
    },

    // Handles /oauth/* routes. Returns a Response, or null if not ours.
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname === '/oauth/client-metadata.json' && !cfg.loopback) {
        return new Response(JSON.stringify(client.clientMetadata), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' } });
      }
      if (url.pathname === '/oauth/login') {
        // Loopback redirects always land on 127.0.0.1, so start there too or
        // the cookie would end up on a different origin from the page.
        if (cfg.loopback && url.host !== new URL(cfg.origin).host) return redirect(`${cfg.origin}${url.pathname}${url.search}`);
        const handle = (url.searchParams.get('handle') || '').trim().replace(/^@/, '');
        if (!handle || handle.length > 253) return fail('enter your handle first');
        try {
          const to = await client.authorize(handle, { scope: SCOPE, signal: request.signal });
          return redirect(to.toString());
        } catch (e) {
          return fail(`couldn't start sign-in for @${handle}: ${reason(e)}`);
        }
      }
      if (url.pathname === '/oauth/callback') {
        try {
          const { session } = await client.callback(url.searchParams);
          const did = session.did;
          // The session (scope `atproto`: identity only, no repo access) is
          // kept so freeq can check who you are when you talk there.
          return redirect('/?signedin=1', { 'set-cookie': cookie(await signSession(did, secret), MAX_AGE) });
        } catch (e) {
          return fail(`sign-in failed: ${reason(e)}`);
        }
      }
      if (url.pathname === '/oauth/logout' && request.method === 'POST') {
        const did = await verifySession(parseCookies(request.headers.get('cookie'))[COOKIE], secret);
        if (did) await client.revoke(did).catch(() => {});
        return new Response(null, { status: 204, headers: { 'set-cookie': cookie('', 0) } });
      }
      return null;
    },
  };
}

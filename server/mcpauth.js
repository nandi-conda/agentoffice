// OAuth 2.1 for the MCP server (the MCP authorization spec). The office is
// its own authorization server: MCP clients such as Claude Code find it from
// the 401 on /mcp, register themselves, and send the person here to sign in.
// Signing in is the office's AT Protocol sign-in (auth.js: handle → PDS
// consent), so the access token they get back stands for that person's DID.
//
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728, points at us
//   /.well-known/oauth-authorization-server        RFC 8414
//   POST /oauth/mcp/register                       RFC 7591 dynamic registration
//   GET  /oauth/mcp/authorize                      code + PKCE (S256 only)
//   GET/POST /oauth/mcp/consent                    sign in, then allow or deny
//   POST /oauth/mcp/token                          authorization_code, refresh_token
//   POST /oauth/mcp/revoke                         RFC 7009
//
// Tokens are opaque random strings; only their SHA-256 is stored. Like
// auth.js this is runtime-neutral (fetch, Request/Response, Web Crypto), and
// every store is { get, set, del } JSON with its own expiry: on Workers they
// live in the World's SQLite, on Node in DATA_DIR.

import { log } from './logs.js';
import { identityResolver } from './atproto.js';

export const ACCESS_PREFIX = 'mcpat_';
const REFRESH_PREFIX = 'mcprt_';
export const TTL = {
  client: 365 * 24 * 3600 * 1000,
  request: 15 * 60 * 1000,
  code: 2 * 60 * 1000,
  access: 3600 * 1000,
  refresh: 30 * 24 * 3600 * 1000,
};
const SCOPE = 'office';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// MCP clients run in browsers too (the MCP Inspector), so the OAuth
// endpoints answer cross-origin requests. None of them use cookies.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...headers },
});
const oauthError = (status, error, description) => json(status, { error, error_description: description });

const isLoopbackHost = (h) => ['localhost', '127.0.0.1', '[::1]'].includes(h);

// https anywhere, http only back to this machine, or an app's own scheme
// (cursor://…); never script or data URLs.
export function validRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(u.protocol);
}

// Registered URIs must match exactly, except that a loopback redirect may
// come back on any port (RFC 8252 §7.3).
function redirectMatches(registered, uri) {
  if (registered.includes(uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) return false;
  return registered.some((r) => {
    try { const v = new URL(r); v.port = u.port; return v.href === u.href; } catch { return false; }
  });
}

async function readForm(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return await request.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

// auth: the browser sign-in from createAuth (origin, loopback, didFromCookie),
// or a function returning it (the Worker builds it on first request).
// stores(name, ttlMs): returns a JSON store for clients, requests, codes,
// tokens and refresh tokens. publicUrl pins the issuer (else request origin).
// resolve(did) → { handle }, only used to greet people by handle.
export function createMcpOAuth({ auth: authOrFn, stores, publicUrl, resolve = (did) => identityResolver.resolve(did) }) {
  const getAuth = typeof authOrFn === 'function' ? authOrFn : () => authOrFn;
  const clients = stores('mcp-client', TTL.client);
  const requests = stores('mcp-req', TTL.request);
  const codes = stores('mcp-code', TTL.code);
  const tokens = stores('mcp-at', TTL.access);
  const refresh = stores('mcp-rt', TTL.refresh);
  const handles = new Map();

  const base = (url) => (publicUrl || url.origin).replace(/\/$/, '');

  async function handleOf(did) {
    if (handles.has(did)) return handles.get(did);
    let h = null;
    try {
      const t = new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000));
      const r = await Promise.race([resolve(did), t]);
      h = r?.handle && r.handle !== 'handle.invalid' ? r.handle : null;
    } catch { /* show the DID instead */ }
    if (handles.size > 500) handles.clear();
    handles.set(did, h);
    return h;
  }

  async function issue({ did, handle, client_id, resource }) {
    const access = ACCESS_PREFIX + random();
    const rt = REFRESH_PREFIX + random();
    const rec = { did, handle, client_id, resource, scope: SCOPE };
    await tokens.set(await sha256(access), { ...rec, exp: Date.now() + TTL.access });
    await refresh.set(await sha256(rt), { ...rec, exp: Date.now() + TTL.refresh });
    return { access_token: access, token_type: 'Bearer', expires_in: TTL.access / 1000, refresh_token: rt, scope: SCOPE };
  }

  // ---- pages ----------------------------------------------------------------

  const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Agent Office</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--card:#fff;--fg:#1d1b18;--mute:#6b665e;--accent:#3b6ee8;--line:#ddd6c9}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--card:#20232a;--fg:#ecebe8;--mute:#9a978f;--accent:#7aa2ff;--line:#33363e}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px}.mute{color:var(--mute);font-size:14px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.go{background:var(--accent);border-color:var(--accent);color:#fff}a{color:var(--accent)}code{font-size:14px}
</style></head><body><main>${body}</main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'none'" } });

  const clientName = (c) => c.client_name || new URL(c.redirect_uris[0]).host || 'An MCP client';

  function signInPage(req, client, id, note = '') {
    return page('Sign in', `<h1>Sign in to Agent Office</h1>
<p><b>${esc(clientName(client))}</b> wants to use the office's MCP server as you. Sign in with your AT Protocol handle (Bluesky or any PDS).</p>
${note ? `<p class="mute">${esc(note)}</p>` : ''}
<form method="get" action="/oauth/login">
<input name="handle" placeholder="you.bsky.social" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<input type="hidden" name="next" value="/oauth/mcp/consent?req=${esc(id)}">
<div class="row"><button class="go" type="submit">Continue</button></div></form>`);
  }

  async function consentPage(req, client, id, did) {
    const handle = await handleOf(did);
    const who = handle ? `@${handle}` : did;
    return page('Allow access', `<h1>Allow ${esc(clientName(client))}?</h1>
<p>It will act in the office as <b>${esc(who)}</b>: join, move, chat and use whatever your role allows, until you sign out of it.</p>
<p class="mute">It goes back to <code>${esc(new URL(req.redirect_uri).origin === 'null' ? req.redirect_uri : new URL(req.redirect_uri).origin)}</code>.
Not you? <a href="/oauth/mcp/consent?req=${esc(id)}&amp;switch=1">Use another account</a>.</p>
<form method="post" action="/oauth/mcp/consent"><input type="hidden" name="req" value="${esc(id)}">
<div class="row"><button name="decision" value="deny" type="submit">Deny</button><button class="go" name="decision" value="allow" type="submit">Allow</button></div></form>`);
  }

  const back = (req, params) => {
    const u = new URL(req.redirect_uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    if (req.state != null) u.searchParams.set('state', req.state);
    return new Response(null, { status: 302, headers: { location: u.href, 'cache-control': 'no-store' } });
  };

  // ---- endpoints ------------------------------------------------------------

  async function authorize(url) {
    const auth = getAuth();
    // Loopback dev: the sign-in cookie lives on 127.0.0.1 (see auth.js), so
    // the whole flow happens there.
    if (auth.loopback && url.host !== new URL(auth.origin).host) {
      return new Response(null, { status: 302, headers: { location: `${auth.origin}${url.pathname}${url.search}` } });
    }
    const q = Object.fromEntries(url.searchParams);
    const client = q.client_id && await clients.get(q.client_id);
    if (!client) return page('Unknown app', '<h1>Unknown app</h1><p>This app isn\'t registered with the office. Remove the MCP server from it and add it again.</p>', 400);
    if (!q.redirect_uri || !redirectMatches(client.redirect_uris, q.redirect_uri)) return page('Bad redirect', '<h1>Bad redirect</h1><p>The app asked to go back somewhere it didn\'t register.</p>', 400);
    // From here on errors go back to the app.
    const req = { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state ?? null };
    if (q.response_type !== 'code') return back(req, { error: 'unsupported_response_type' });
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return back(req, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    Object.assign(req, { code_challenge: q.code_challenge, resource: q.resource || null });
    const id = random(18);
    await requests.set(id, req);
    return new Response(null, { status: 302, headers: { location: `/oauth/mcp/consent?req=${id}`, 'cache-control': 'no-store' } });
  }

  async function consent(request, url) {
    const form = request.method === 'POST' ? await readForm(request) : {};
    const id = form.req || url.searchParams.get('req') || '';
    const req = id && await requests.get(id);
    if (!req) return page('Expired', '<h1>This sign-in expired</h1><p>Go back to your MCP client and connect again.</p>', 400);
    const client = await clients.get(req.client_id);
    if (!client) return page('Unknown app', '<h1>Unknown app</h1>', 400);
    const did = await getAuth().didFromCookie(request.headers.get('cookie'));
    if (request.method !== 'POST') {
      if (!did || url.searchParams.has('switch')) return signInPage(req, client, id);
      return consentPage(req, client, id, did);
    }
    // The session cookie is SameSite=Lax, so another site's form posting
    // here arrives without it; checking Origin as well costs nothing.
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null' && new URL(origin).host !== url.host) return page('Forbidden', '<h1>Forbidden</h1>', 403);
    if (!did) return signInPage(req, client, id, 'Your sign-in ran out; sign in again.');
    await requests.del(id);
    if (form.decision !== 'allow') {
      log('info', 'auth', `${did} denied MCP access to ${clientName(client)}`);
      return back(req, { error: 'access_denied' });
    }
    const code = random();
    await codes.set(await sha256(code), { ...req, did, handle: await handleOf(did), exp: Date.now() + TTL.code });
    log('info', 'auth', `${did} allowed MCP access for ${clientName(client)}`);
    return back(req, { code });
  }

  async function register(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return oauthError(400, 'invalid_client_metadata', 'send JSON client metadata');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length < 2000 && validRedirect(u))) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be https, http://localhost or an app scheme');
    }
    const client = {
      client_id: `mcp-${random(18)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    };
    await clients.set(client.client_id, client);
    log('info', 'auth', `MCP client registered: ${client.client_name || client.client_id}`);
    return json(201, client);
  }

  async function token(request) {
    const f = await readForm(request);
    if (f.grant_type === 'authorization_code') {
      const key = await sha256(f.code || '');
      const c = await codes.get(key);
      await codes.del(key); // one use, even when the rest is wrong
      if (!c || c.exp < Date.now()) return oauthError(400, 'invalid_grant', 'code expired or already used');
      if (c.client_id !== f.client_id || c.redirect_uri !== f.redirect_uri) return oauthError(400, 'invalid_grant', 'code was issued to another client or redirect');
      if (!f.code_verifier || await sha256(f.code_verifier) !== c.code_challenge) return oauthError(400, 'invalid_grant', 'PKCE check failed');
      return json(200, await issue({ did: c.did, handle: c.handle, client_id: c.client_id, resource: f.resource || c.resource }));
    }
    if (f.grant_type === 'refresh_token') {
      const key = await sha256(f.refresh_token || '');
      const r = await refresh.get(key);
      if (!r || r.exp < Date.now() || (f.client_id && f.client_id !== r.client_id)) return oauthError(400, 'invalid_grant', 'refresh token expired or revoked; sign in again');
      await refresh.del(key); // rotated
      return json(200, await issue(r));
    }
    return oauthError(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  async function revoke(request) {
    const f = await readForm(request);
    const t = f.token || '';
    const key = await sha256(t);
    if (t.startsWith(ACCESS_PREFIX)) await tokens.del(key);
    else if (t.startsWith(REFRESH_PREFIX)) await refresh.del(key);
    return new Response(null, { status: 200, headers: CORS });
  }

  return {
    // The WWW-Authenticate value for a 401 on /mcp.
    challenge(url, error) {
      return `Bearer resource_metadata="${base(url)}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}`;
    },

    // An access token's { did, handle, client_id }, or null.
    async verify(accessToken) {
      if (typeof accessToken !== 'string' || !accessToken.startsWith(ACCESS_PREFIX)) return null;
      const t = await tokens.get(await sha256(accessToken));
      return t && t.exp > Date.now() ? t : null;
    },

    isToken: (s) => typeof s === 'string' && s.startsWith(ACCESS_PREFIX),

    // Returns a Response for our paths, else null.
    async handle(request) {
      const url = new URL(request.url);
      const p = url.pathname;
      const ours = p.startsWith('/.well-known/oauth-') || p.startsWith('/oauth/mcp/');
      if (!ours) return null;
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      try {
        if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
          return json(200, {
            resource: `${base(url)}/mcp`,
            authorization_servers: [base(url)],
            bearer_methods_supported: ['header'],
            scopes_supported: [SCOPE],
            resource_name: 'Agent Office',
          }, { 'cache-control': 'public, max-age=300' });
        }
        if (p === '/.well-known/oauth-authorization-server') {
          const b = base(url);
          return json(200, {
            issuer: b,
            authorization_endpoint: `${b}/oauth/mcp/authorize`,
            token_endpoint: `${b}/oauth/mcp/token`,
            registration_endpoint: `${b}/oauth/mcp/register`,
            revocation_endpoint: `${b}/oauth/mcp/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            scopes_supported: [SCOPE],
          }, { 'cache-control': 'public, max-age=300' });
        }
        if (p === '/oauth/mcp/register' && request.method === 'POST') return await register(request);
        if (p === '/oauth/mcp/authorize' && request.method === 'GET') return await authorize(url);
        if (p === '/oauth/mcp/consent') return await consent(request, url);
        if (p === '/oauth/mcp/token' && request.method === 'POST') return await token(request);
        if (p === '/oauth/mcp/revoke' && request.method === 'POST') return await revoke(request);
      } catch (e) {
        log('error', 'auth', `MCP OAuth ${p}: ${e.message}`);
        return oauthError(500, 'server_error', e.message);
      }
      return p.startsWith('/.well-known/') ? null : oauthError(404, 'invalid_request', 'not an endpoint');
    },
  };
}

// A store in memory with expiry, for tests and the fallback when nothing
// durable is given.
export function memoryStores() {
  const all = new Map();
  return (name, ttlMs) => {
    if (!all.has(name)) all.set(name, new Map());
    const m = all.get(name);
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
  };
}

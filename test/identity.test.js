import test from 'node:test';
import assert from 'node:assert/strict';
import { identityResolver } from '../server/atproto.js';
import { createAuth } from '../server/auth.js';

// Each test gets its own DID because atproto.js caches DID documents.
let DID;
const nextDid = (c) => (DID = `did:plc:${c.repeat(24)}`);
const PDS = 'https://pds.example.com';
const doc = (handle) => ({
  id: DID,
  alsoKnownAs: [`at://${handle}`],
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
});

let n = 0;

// Stubs fetch, and makes Request behave like Cloudflare Workers, which
// throws on `redirect: 'error'` (the bug that broke sign-in there).
function stubNet(routes) {
  const realFetch = globalThis.fetch, RealRequest = globalThis.Request;
  const seen = [];
  globalThis.Request = class extends RealRequest {
    constructor(input, init) {
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      super(input, init);
    }
  };
  globalThis.fetch = async (input) => {
    const url = String(input instanceof RealRequest ? input.url : input);
    seen.push(url);
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) {
        return typeof body === 'string'
          ? new Response(body, { headers: { 'content-type': 'text/plain' } })
          : Response.json(body, { headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('nope', { status: 404 });
  };
  return { seen, restore() { globalThis.fetch = realFetch; globalThis.Request = RealRequest; } };
}

test('resolves a handle over DoH and checks the DID document', async (t) => {
  nextDid(String.fromCharCode(97 + (++n % 26)));
  const net = stubNet([
    ['https://cloudflare-dns.com/dns-query?name=_atproto.dns.test', { Status: 0, Answer: [{ type: 16, data: `"did=${DID}"` }] }],
    [`https://plc.directory/${DID}`, doc('dns.test')],
  ]);
  t.after(() => net.restore());
  const r = await identityResolver.resolve('@DNS.test');
  assert.equal(r.did, DID);
  assert.equal(r.handle, 'dns.test');
  assert.equal(r.didDoc.service[0].serviceEndpoint, PDS);
});

test('falls back to .well-known, then the public resolver', async (t) => {
  nextDid(String.fromCharCode(97 + (++n % 26)));
  const net = stubNet([
    ['https://wk.test/.well-known/atproto-did', `${DID}\n`],
    [`https://plc.directory/${DID}`, doc('wk.test')],
  ]);
  t.after(() => net.restore());
  assert.equal((await identityResolver.resolve('wk.test')).did, DID);

  nextDid('z');
  const net2 = stubNet([
    ['https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=api.test', { did: DID }],
    [`https://plc.directory/${DID}`, doc('api.test')],
  ]);
  t.after(() => net2.restore());
  assert.equal((await identityResolver.resolve('api.test')).did, DID);
});

test('rejects a handle the DID document does not claim', async (t) => {
  nextDid(String.fromCharCode(97 + (++n % 26)));
  const net = stubNet([
    ['https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=liar.test', { did: DID }],
    [`https://plc.directory/${DID}`, doc('someone-else.test')],
  ]);
  t.after(() => net.restore());
  await assert.rejects(identityResolver.resolve('liar.test'), /doesn't list/);
});

test('sign-in gets past identity resolution under Workers rules', async (t) => {
  nextDid(String.fromCharCode(97 + (++n % 26)));
  const net = stubNet([
    ['https://cloudflare-dns.com/dns-query?name=_atproto.flow.test', { Status: 0, Answer: [{ type: 16, data: `"did=${DID}"` }] }],
    [`https://plc.directory/${DID}`, doc('flow.test')],
  ]);
  t.after(() => net.restore());
  const auth = createAuth({ port: 8080, secret: 's' });
  const r = await auth.handle(new Request('http://127.0.0.1:8080/oauth/login?handle=flow.test'));
  const err = new URL(r.headers.get('location'), 'http://x').searchParams.get('auth_error');
  // The stub has no PDS, so it stops at the OAuth metadata step, after
  // the identity was resolved.
  assert.doesNotMatch(err, /resolve identity/);
  assert.ok(net.seen.some((u) => u.startsWith(`${PDS}/.well-known/oauth-protected-resource`)), err);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, parseCookies, clientMetadata, createAuth, COOKIE } from '../server/auth.js';

const SECRET = 'test-secret';

test('session cookies round-trip and reject tampering', async () => {
  const tok = await signSession('did:plc:abc', SECRET);
  assert.equal(await verifySession(tok, SECRET), 'did:plc:abc');
  assert.equal(await verifySession(tok, 'other-secret'), null);
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ did: 'did:plc:victim', exp: 9e9 })).toString('base64url');
  assert.equal(await verifySession(`${forged}.${sig}`, SECRET), null);
  assert.equal(await verifySession(`${body}.`, SECRET), null);
  assert.equal(await verifySession('garbage!!.@@', SECRET), null);
  assert.equal(await verifySession(undefined, SECRET), null);
});

test('session cookies expire', async () => {
  const tok = await signSession('did:plc:abc', SECRET, Date.UTC(2020, 0, 1));
  assert.equal(await verifySession(tok, SECRET, Date.UTC(2020, 0, 2)), 'did:plc:abc');
  assert.equal(await verifySession(tok, SECRET, Date.UTC(2020, 3, 1)), null);
});

test('parses cookies', () => {
  assert.deepEqual(parseCookies(`a=1; ${COOKIE}=x.y; b=%20`), { a: '1', [COOKIE]: 'x.y', b: ' ' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('local dev uses the loopback client on 127.0.0.1', () => {
  const c = clientMetadata({ port: 8080 });
  assert.equal(c.loopback, true);
  assert.equal(c.metadata.redirect_uris[0], 'http://127.0.0.1:8080/oauth/callback');
  assert.ok(c.metadata.client_id.startsWith('http://localhost?'));
  assert.equal(clientMetadata({ publicUrl: 'http://localhost:3000', port: 3000 }).loopback, true);
});

test('PUBLIC_URL switches to a hosted client metadata document', () => {
  const c = clientMetadata({ publicUrl: 'https://office.example.com/', port: 8080 });
  assert.equal(c.loopback, false);
  assert.equal(c.metadata.client_id, 'https://office.example.com/oauth/client-metadata.json');
  assert.deepEqual(c.metadata.redirect_uris, ['https://office.example.com/oauth/callback']);
  assert.equal(c.metadata.scope, 'atproto');
});

test('fetch-style handler: loopback hop, logout, and non-oauth paths', async () => {
  const auth = createAuth({ port: 8080, secret: SECRET });
  let r = await auth.handle(new Request('http://localhost:8080/oauth/login?handle=ada.test'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'http://127.0.0.1:8080/oauth/login?handle=ada.test');
  r = await auth.handle(new Request('http://127.0.0.1:8080/oauth/login'));
  assert.match(r.headers.get('location'), /auth_error=/);
  r = await auth.handle(new Request('http://127.0.0.1:8080/oauth/logout', { method: 'POST' }));
  assert.equal(r.status, 204);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await auth.handle(new Request('http://127.0.0.1:8080/api/me')), null);
  const tok = await signSession('did:plc:abc', SECRET);
  assert.equal(await auth.didFromCookie(`x=1; ${COOKIE}=${tok}`), 'did:plc:abc');
  assert.equal(await auth.didFromCookie(undefined), null);
});

test('hosted mode serves its client metadata', async () => {
  const auth = createAuth({ publicUrl: 'https://office.example.com', secret: SECRET });
  const r = await auth.handle(new Request('https://office.example.com/oauth/client-metadata.json'));
  const m = await r.json();
  assert.equal(m.client_id, 'https://office.example.com/oauth/client-metadata.json');
  assert.equal(m.dpop_bound_access_tokens, true);
});

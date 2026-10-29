import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Office } from '../server/office.js';
import { AgentAuth } from '../server/agentauth.js';
import { McpHub } from '../server/mcp.js';
import { handleApi } from '../server/app.js';
import { createMcpOAuth, memoryStores, validRedirect } from '../server/mcpauth.js';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'https://office.test';
const REDIRECT = 'http://localhost:33418/callback';

// The browser sign-in is faked: a `who=<did>` cookie means signed in.
function setup() {
  const auth = { loopback: false, origin: B, didFromCookie: async (c) => (c || '').match(/who=([^;]+)/)?.[1] || null };
  const mcpOAuth = createMcpOAuth({ auth, stores: memoryStores(), resolve: async () => ({ handle: 'ada.test' }) });
  const office = new Office({});
  const mcp = new McpHub({ office, auth: new AgentAuth({}), oauth: mcpOAuth, token: 'op-token' });
  const fetch = async (url, init) => (await handleApi(new Request(url, init), { office, auth, mcp, mcpOAuth })) || new Response('not found', { status: 404 });
  return { fetch, mcpOAuth };
}

const s256 = async (v) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))).toString('base64url');
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

// Discovery → registration → authorize → consent → token, as an MCP client does it.
async function signIn(fetch, { allow = true } = {}) {
  const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${B}/mcp`);
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  const verifier = 'v'.repeat(50);
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 'xyz', resource: `${B}/mcp` });
  let r = await fetch(`${as.authorization_endpoint}?${q}`);
  assert.equal(r.status, 302);
  const consentUrl = new URL(r.headers.get('location'), B).href;
  // Not signed in yet: the handle form, which goes through the office's AT Protocol sign-in.
  r = await fetch(consentUrl);
  const html = await r.text();
  assert.match(html, /action="\/oauth\/login"/);
  assert.match(html, /name="next" value="\/oauth\/mcp\/consent\?req=/);
  // Back from the PDS with the session cookie: the consent page.
  r = await fetch(consentUrl, { headers: { cookie: `who=${DID}` } });
  assert.match(await r.text(), /Allow Claude Code\?[\s\S]*@ada\.test/);
  const req = new URL(consentUrl).searchParams.get('req');
  r = await fetch(`${B}/oauth/mcp/consent`, { ...form({ req, decision: allow ? 'allow' : 'deny' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `who=${DID}`, origin: B } });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');
  if (!allow) return { error: back.searchParams.get('error') };
  const code = back.searchParams.get('code');
  r = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }));
  assert.equal(r.status, 200);
  const tok = await r.json();
  // A code works once.
  r = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }));
  assert.equal(r.status, 400);
  return { client, tok, as };
}

const connect = async (fetch, path, headers = {}) => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${B}${path}`), { fetch, requestInit: { headers } }));
  return c;
};
const whoami = async (c) => JSON.parse((await c.callTool({ name: 'whoami', arguments: {} })).content[0].text);

test('redirect URIs: https, loopback http, app schemes; never script', () => {
  assert.ok(validRedirect('https://app.example/cb'));
  assert.ok(validRedirect('http://127.0.0.1:9999/cb'));
  assert.ok(validRedirect('cursor://anysphere.cursor-retrieval/oauth/callback'));
  assert.ok(!validRedirect('http://evil.example/cb'));
  assert.ok(!validRedirect('javascript:alert(1)'));
  assert.ok(!validRedirect('data:text/html,hi'));
});

test('/mcp answers 401 with resource metadata; /mcp/public stays read-only', async () => {
  const { fetch } = setup();
  const r = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${B}/.well-known/oauth-protected-resource/mcp"`);
  const c = await connect(fetch, '/mcp/public');
  assert.equal((await whoami(c)).canAct, false);
  await c.close();
  // The operator token still works on /mcp.
  const op = await connect(fetch, '/mcp', { authorization: 'Bearer op-token' });
  assert.equal((await whoami(op)).operator, true);
  await op.close();
});

test('OAuth sign-in gives an MCP session the signed-in DID', async () => {
  const { fetch } = setup();
  const { tok } = await signIn(fetch);
  assert.match(tok.access_token, /^mcpat_/);
  const c = await connect(fetch, '/mcp', { authorization: `Bearer ${tok.access_token}` });
  const me = await whoami(c);
  assert.deepEqual(me.identity, { did: DID, handle: 'ada.test' });
  assert.equal(me.canAct, true);
  const joined = JSON.parse((await c.callTool({ name: 'join_office', arguments: { name: 'Ada' } })).content[0].text);
  assert.equal(joined.signedIn, true);
  await c.close();
});

test('bad tokens get invalid_token; refresh tokens rotate', async () => {
  const { fetch } = setup();
  const { tok, client, as } = await signIn(fetch);
  await assert.rejects(connect(fetch, '/mcp', { authorization: 'Bearer mcpat_nope' }));
  const r1 = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }));
  assert.equal(r1.status, 200);
  const next = await r1.json();
  assert.notEqual(next.access_token, tok.access_token);
  const r2 = await fetch(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }));
  assert.equal(r2.status, 400);
  // Revoked access tokens stop working.
  await fetch(`${B}/oauth/mcp/revoke`, form({ token: next.access_token }));
  await assert.rejects(connect(fetch, '/mcp', { authorization: `Bearer ${next.access_token}` }));
});

test('deny goes back with access_denied; bad redirects are refused', async () => {
  const { fetch } = setup();
  assert.equal((await signIn(fetch, { allow: false })).error, 'access_denied');
  const reg = await (await fetch(`${B}/oauth/mcp/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) }));
  assert.equal(reg.status, 400);
});

test('consent refuses a cross-site post', async () => {
  const { fetch } = setup();
  const reg = await (await fetch(`${B}/oauth/mcp/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'abc', code_challenge_method: 'S256' });
  const loc = (await fetch(`${B}/oauth/mcp/authorize?${q}`)).headers.get('location');
  const req = new URL(loc, B).searchParams.get('req');
  const r = await fetch(`${B}/oauth/mcp/consent`, { ...form({ req, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `who=${DID}`, origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  // Without PKCE the client is sent back with an error.
  const noPkce = await fetch(`${B}/oauth/mcp/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT })}`);
  assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');
});

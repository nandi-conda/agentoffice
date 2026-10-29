import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Office, KICKED } from '../server/office.js';
import { wasmPlugins, until } from './support/plugins.js';
import { McpHub } from '../server/mcp.js';
import { AgentAuth } from '../server/agentauth.js';
import { bootstrap, effectiveRole, grantError, can } from '../public/js/roles.js';
import { describeApi, generatedTools, renderPages } from '../server/apidoc.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closedWith = code; this.readyState = 3; }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const OWNER = 'did:plc:owner', ADA = 'did:plc:ada', BOB = 'did:plc:bob';

async function join(office, name, did = null) {
  const ws = new FakeWs();
  office.connect(ws, { did });
  ws.msg({ t: 'hello', name });
  await tick();
  return { ws, id: ws.last('welcome')?.you.id };
}
const mod = async (c, m) => { c.ws.msg({ t: 'mod', ref: 1, ...m }); await tick(); return c.ws.last('modres').result; };

test('roles: env bootstrap, defaults, and who may grant what', () => {
  assert.deepEqual(bootstrap({ ADMIN_DIDS: 'did:plc:a, did:plc:b' }), { owners: ['did:plc:a'], admins: ['did:plc:b'] });
  assert.deepEqual(bootstrap({ OWNER_DIDS: 'did:plc:o', ADMIN_DIDS: 'did:plc:a' }), { owners: ['did:plc:o'], admins: ['did:plc:a'] });
  const env = { owners: [OWNER], admins: [ADA] };
  assert.equal(effectiveRole({ did: OWNER }, {}, env), 'owner');
  assert.equal(effectiveRole({ did: ADA }, { [ADA]: { role: 'banned' } }, env), 'admin', 'env admins cannot be banned');
  assert.equal(effectiveRole({ did: BOB }, {}, env), 'member');
  assert.equal(effectiveRole({ did: BOB, kind: 'agent' }, {}, env), 'agent');
  assert.equal(effectiveRole({ did: BOB }, { [BOB]: { role: 'moderator' } }, env), 'moderator');
  assert.equal(effectiveRole({}, {}, env), 'guest');
  assert.equal(effectiveRole({ mcp: true }, {}, env), 'observer');
  assert.equal(effectiveRole({ operator: true }, {}, env), 'owner');
  assert.equal(grantError('admin', 'member', 'moderator'), null);
  assert.match(grantError('admin', 'member', 'admin'), /only owners/);
  assert.match(grantError('admin', 'admin', 'member'), /an admin/);
  assert.match(grantError('moderator', 'member', 'moderator'), /only admins/);
  assert.equal(grantError('owner', 'admin', 'owner'), null);
  assert.ok(can('moderator', 'people.kick') && !can('moderator', 'logs') && can('admin', 'logs') && !can('banned', 'people.kick'));
});

test('roles: an env owner makes a moderator, who kicks, mutes and moves people but not the owner', async () => {
  const o = new Office({}, { roles: { owners: [OWNER], admins: [] }, plugins: wasmPlugins() });
  await o.ready;
  const owner = await join(o, 'Olive', OWNER), ada = await join(o, 'Ada', ADA), guest = await join(o, 'guest');
  assert.equal(owner.ws.last('welcome').you.role, 'owner');
  assert.equal(guest.ws.last('welcome').peers.find((p) => p.id === ada.id).role, 'member');

  // Members can't moderate; the World refuses before anything happens.
  assert.match((await mod(ada, { op: 'kick', to: 'guest' })).error, /needs the moderator role/);
  assert.deepEqual(await mod(owner, { op: 'grant', to: 'Ada', role: 'moderator' }), { did: ADA, role: 'moderator' });
  await tick();
  assert.equal(guest.ws.sent.filter((m) => m.t === 'peer' && m.id === ada.id).at(-1).role, 'moderator', 'everyone sees the new badge');
  assert.equal((await o.ref(`actor:${ADA}`).role()).role, 'moderator', 'the actor keeps its copy');
  assert.equal((await o.ref('roles:main').view())[OWNER].env, true);

  // Mute: no chat, mic off, even after leaving and coming back.
  const m = await mod(ada, { op: 'mute', to: 'guest', minutes: 5 });
  assert.ok(m.until > Date.now());
  guest.ws.msg({ t: 'chat', text: 'hello?' }); await tick();
  assert.match(guest.ws.last('error').message, /muted you/);
  guest.ws.msg({ t: 'audio', on: true }); await tick();
  assert.equal(guest.ws.sent.filter((x) => x.t === 'peer' && x.id === guest.id).at(-1).audio, false);
  assert.ok(await mod(ada, { op: 'unmute', to: 'guest' }));

  // Move, then kick: their client is told and closed for good.
  assert.deepEqual(await mod(ada, { op: 'move', to: 'guest', place: 'kitchen' }), { ok: true, zone: 'kitchen' });
  assert.equal(guest.ws.last('bounce').moved, true);
  assert.match((await mod(ada, { op: 'kick', to: 'Olive' })).error, /owner/);
  assert.deepEqual(await mod(ada, { op: 'kick', to: 'guest', reason: 'spam' }), { ok: true });
  assert.match(guest.ws.last('kicked').text, /spam/);
  assert.equal(guest.ws.closedWith, KICKED);
  assert.ok(!o.peers.has(guest.id));

  // Moderators take down anyone's notice, but can't grant roles.
  owner.ws.msg({ t: 'note', op: 'add', text: 'owner note' });
  await until(() => o.notes.length);
  ada.ws.msg({ t: 'note', op: 'remove', id: o.notes[0].id });
  await until(() => !o.notes.length);
  assert.match((await mod(ada, { op: 'grant', to: OWNER, role: 'member' })).error, /needs the admin role/);
  const people = await mod(ada, { op: 'people' });
  assert.deepEqual(people.online.map((p) => p.role).sort(), ['moderator', 'owner']);
});

test('roles: banned people are sent off and can\'t come back in', async () => {
  const o = new Office({}, { roles: { owners: [OWNER], admins: [] } });
  await o.ready;
  const owner = await join(o, 'Olive', OWNER), bob = await join(o, 'Bob', BOB);
  assert.equal((await mod(owner, { op: 'grant', to: 'Bob', role: 'banned' })).role, 'banned');
  await tick();
  assert.match(bob.ws.last('kicked').text, /banned/);
  const again = await join(o, 'Bob', BOB);
  assert.equal(again.ws.last('welcome'), undefined);
  assert.equal(again.ws.closedWith, KICKED);
  assert.equal((await mod(owner, { op: 'grant', to: BOB, role: 'member' })).role, 'member');
  assert.ok((await join(o, 'Bob', BOB)).id);
});

function hubSetup() {
  const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('getSession')) return Response.json({ did, handle: 'bot.roost.test' });
    if (u.pathname.endsWith('putRecord')) { fetch.rec = JSON.parse(init.body).record; return Response.json({ uri: 'at://x', cid: 'y' }); }
    if (u.pathname.endsWith('getRecord')) return Response.json({ value: fetch.rec });
    return new Response('?', { status: 404 });
  };
  const auth = new AgentAuth({ fetch, resolve: async () => ({ did, handle: 'bot.roost.test', pds: 'https://roost.test' }) });
  const office = new Office({}, { roles: { owners: [OWNER], admins: [] } });
  const hub = new McpHub({ office, auth, token: 'op-token' });
  const connect = async (headers = {}) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), { fetch: (u, i) => hub.fetch(new Request(u, i)), requestInit: { headers } }));
    return client;
  };
  return { did, office, connect };
}
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

test('roles: MCP lists tools by role, and a grant shows the new ones', async () => {
  const { did, office, connect } = hubSetup();
  const agent = await connect({ authorization: 'Bearer rmcp_good' });
  const changed = [];
  agent.setNotificationHandler(ToolListChangedNotificationSchema, () => changed.push(1));
  assert.equal((await call(agent, 'whoami')).role, 'agent');
  let list = await names(agent);
  assert.ok(list.includes('join_office') && list.includes('desk_claim'));
  assert.ok(!list.includes('mod_kick') && !list.includes('mod_grant') && !list.includes('logs_tail'));

  // The operator token is an owner: everything.
  const op = await connect({ authorization: 'Bearer op-token' });
  list = await names(op);
  for (const t of ['mod_kick', 'mod_mute', 'mod_move', 'mod_people', 'mod_removeItem', 'mod_grant', 'logs_tail']) assert.ok(list.includes(t), `operator misses ${t}`);
  await call(op, 'join_office', { name: 'Op' });
  assert.equal((await call(op, 'mod_grant', { to: did, role: 'moderator' })).role, 'moderator');
  await tick(20);
  assert.ok(changed.length, 'tools/list_changed was sent');
  list = await names(agent);
  assert.ok(list.includes('mod_kick') && !list.includes('mod_grant'));
  await call(agent, 'join_office', { name: 'Modbot' });
  assert.equal((await call(agent, 'mod_people')).online.find((p) => p.name === 'Modbot').role, 'moderator');
  assert.match((await agent.callTool({ name: 'mod_kick', arguments: { to: 'Op' } })).content[0].text, /owner/);
  for (const c of [agent, op]) await c.close();
  office.peers.clear();
});

test('roles: the docs and generated tools say which role each tool needs', () => {
  const tools = generatedTools(describeApi());
  assert.equal(tools.find((t) => t.name === 'mod_kick').role, 'moderator');
  assert.equal(tools.find((t) => t.name === 'mod_grant').role, 'admin');
  assert.equal(tools.find((t) => t.name === 'desk_view').role, 'observer');
  assert.equal(tools.find((t) => t.name === 'desk_claim').role, 'guest');
  const { pages } = renderPages(describeApi());
  assert.match(pages['api/index.md'], /`mod_kick` \| moderator and up/);
  assert.match(pages['api/mod.md'], /role ≥ admin/);
  assert.match(pages['api/gallery.md'], /moderators may for anyone \(uploads\.remove\)/);
});

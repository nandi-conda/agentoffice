import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Office } from '../server/office.js';
import { AgentAuth, PROOF_COLLECTION } from '../server/agentauth.js';
import { McpHub, resolvePlace } from '../server/mcp.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A fake PDS + DID resolver: records live in `repo`, tokens map to DIDs.
function fakeAtproto() {
  const repo = new Map();
  const tokens = { rmcp_good: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const bearer = (init.headers?.authorization || '').replace('Bearer ', '');
    if (u.pathname.endsWith('getSession')) {
      const did = tokens[bearer];
      return did ? Response.json({ did, handle: 'bot.roost.test' }) : new Response('no', { status: 401 });
    }
    if (u.pathname.endsWith('putRecord')) {
      const b = JSON.parse(init.body);
      if (tokens[bearer] !== b.repo) return new Response('no', { status: 403 });
      repo.set(`${b.repo}/${b.collection}/${b.rkey}`, b.record);
      return Response.json({ uri: 'at://x', cid: 'y' });
    }
    if (u.pathname.endsWith('getRecord')) {
      const v = repo.get(`${u.searchParams.get('repo')}/${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`);
      return v ? Response.json({ value: v }) : new Response('{}', { status: 400 });
    }
    return new Response('?', { status: 404 });
  };
  const resolve = async (id) => ({ did: id.startsWith('did:') ? id : 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'bot.roost.test', pds: 'https://roost.test' });
  return { repo, fetch, resolve };
}

async function setup() {
  const at = fakeAtproto();
  const auth = new AgentAuth({ fetch: at.fetch, resolve: at.resolve });
  const office = new Office({});
  const hub = new McpHub({ office, auth, token: 'op-token' });
  // headers: e.g. { authorization: 'Bearer rmcp_good' }; none = read-only.
  const connect = async (headers = {}) => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), {
      fetch: (url, init) => hub.fetch(new Request(url, init)),
      requestInit: { headers },
    });
    await client.connect(transport);
    return client;
  };
  return { at, auth, office, hub, connect };
}

const OP = { authorization: 'Bearer op-token' };

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};

test('tools cover the whole client protocol', async () => {
  const { connect } = await setup();
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const t of ['join_office', 'move', 'chat', 'status', 'emote', 'sit', 'desk', 'pomo', 'wb', 'note', 'coffee', 'score', 'wave', 'audio', 'rtc', 'send', 'whoami', 'read_events', 'walk_to', 'look', 'roost_signup', 'roost_sign_in', 'atproto_challenge', 'atproto_verify']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  await c.close();
});

test('an MCP agent joins, chats and hears people', async () => {
  const { office, connect } = await setup();
  const human = new FakeWs();
  office.connect(human);
  human.msg({ t: 'hello', name: 'ada' });
  await tick();

  const c = await connect(OP);
  const logs = [];
  c.setNotificationHandler(LoggingMessageNotificationSchema, (n) => logs.push(n.params.data));
  const j = await call(c, 'join_office', { name: 'Helper Bot', note: 'helping' });
  assert.equal(j.you.kind, 'agent');
  assert.ok(human.sent.some((m) => m.t === 'join' && m.peer.name === 'Helper Bot'));

  const look = await call(c, 'look');
  assert.equal(look.people[0].name, 'ada');

  await call(c, 'chat', { text: 'hello office', shout: true });
  await tick();
  assert.ok(human.sent.some((m) => m.t === 'chat' && m.text === 'hello office' && m.scope === 'office'));

  const { next } = await call(c, 'read_events', { wait_seconds: 0 });
  human.msg({ t: 'chat', text: '@HelperBot can you help?' });
  const r = await call(c, 'read_events', { since: next, wait_seconds: 2, types: ['chat'] });
  const ev = r.events.find((e) => e.text?.includes('can you help'));
  assert.ok(ev && ev.mention && ev.from === 'ada');
  await tick(50);
  assert.ok(logs.some((e) => e.type === 'chat' && e.mention), 'mention streamed as a log notification');
  await c.close();
});

test('read_events long-polls until something happens', async () => {
  const { office, connect } = await setup();
  const c = await connect(OP);
  await call(c, 'join_office', { name: 'waiter' });
  const first = await call(c, 'read_events', { wait_seconds: 0 });
  const human = new FakeWs();
  office.connect(human);
  setTimeout(() => human.msg({ t: 'hello', name: 'grace' }), 100);
  const t0 = Date.now();
  const r = await call(c, 'read_events', { since: first.next, wait_seconds: 5 });
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(r.events.some((e) => e.type === 'join' && e.name === 'grace'));
  await c.close();
});

test('roost sign-in proves the DID and joins verified', async () => {
  const { at, connect, office } = await setup();
  const c = await connect();
  await assert.rejects(call(c, 'roost_sign_in', { token: 'rmcp_bad', pds: 'https://roost.test' }));
  const v = await call(c, 'roost_sign_in', { token: 'rmcp_good', pds: 'https://roost.test' });
  assert.equal(v.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok([...at.repo.keys()][0].endsWith(`${PROOF_COLLECTION}/self`));
  const j = await call(c, 'join_office', { name: 'roostbot' });
  assert.equal(j.signedIn, true);
  const me = office.summary().online.find((p) => p.name === 'roostbot');
  assert.equal(me.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  await c.close();
});

test('manual challenge: a wrong or reused nonce is refused', async () => {
  const { at, auth } = await setup();
  const ch = auth.challenge();
  await assert.rejects(auth.verify('bot.roost.test', ch.nonce), /no org\.agentoffice\.proof/);
  at.repo.set(`did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/${ch.collection}/${ch.rkey}`, { ...ch.record, nonce: 'other' });
  await assert.rejects(auth.verify('bot.roost.test', ch.nonce), /different nonce/);
  at.repo.set(`did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/${ch.collection}/${ch.rkey}`, ch.record);
  const v = await auth.verify('bot.roost.test', ch.nonce);
  assert.ok(v.grant);
  await assert.rejects(auth.verify('bot.roost.test', ch.nonce), /expired nonce/);
  assert.ok(auth.redeem(v.grant));
  assert.equal(auth.redeem(v.grant), null);
});

test('places resolve to coordinates', () => {
  assert.ok(resolvePlace('kitchen'));
  assert.ok(resolvePlace('coffee'));
  assert.ok(resolvePlace('desk-3-chair'));
  assert.equal(resolvePlace('narnia'), null);
});

test('without credentials a session is a read-only observer', async () => {
  const { office, connect } = await setup();
  const c = await connect();
  const who = await call(c, 'whoami');
  assert.equal(who.canAct, false);
  await assert.rejects(call(c, 'join_office', { name: 'sneaky' }), /Read-only until you sign in/);
  await assert.rejects(call(c, 'chat', { text: 'hi' }), /join_office first/);
  const { next } = await call(c, 'read_events', { wait_seconds: 0 });
  const human = new FakeWs();
  office.connect(human);
  human.msg({ t: 'hello', name: 'grace' });
  const r = await call(c, 'read_events', { since: next, wait_seconds: 2 });
  assert.ok(r.events.some((e) => e.type === 'join' && e.name === 'grace'));
  const look = await call(c, 'look');
  assert.equal(look.you.observer, true);
  assert.equal(look.people[0].name, 'grace');
  human.emit('close');
  const r2 = await call(c, 'read_events', { since: r.next, wait_seconds: 2 });
  assert.ok(r2.events.some((e) => e.type === 'leave' && e.name === 'grace'));
  await c.close();
});

test('a Roost token in the Authorization header signs the session in', async () => {
  const { connect, office } = await setup();
  const c = await connect({ authorization: 'Bearer rmcp_good', 'x-atproto-pds': 'https://roost.test' });
  assert.equal((await call(c, 'whoami')).identity.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  await call(c, 'join_office', { name: 'headerbot' });
  assert.equal(office.summary().online.find((p) => p.name === 'headerbot').did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  await c.close();
  await assert.rejects(connect({ authorization: 'Bearer rmcp_bad', 'x-atproto-pds': 'https://roost.test' }));
});

test('a wrong bearer is refused at initialize', async () => {
  const hub = new McpHub({ office: new Office(), auth: new AgentAuth({ fetch: async () => new Response('no', { status: 401 }) }), token: 's3cret' });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const r = await hub.fetch(new Request('http://x/mcp', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) }));
  assert.equal(r.status, 401);
});

test('agents book, list and cancel meeting rooms over MCP', async () => {
  const { office, connect } = await setup();
  const c = await connect(OP);
  await call(c, 'join_office', { name: 'Sched Bot' });
  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { booked } = await call(c, 'book_room', { room: 'huddle', title: 'Retro', start, minutes: 45, invitees: ['ada.bsky.social'], lock: true });
  assert.equal(booked.room, 'huddle');
  assert.equal(booked.locked, true);
  assert.equal(office.bookings.length, 1);
  await tick();
  const rooms = await call(c, 'rooms');
  assert.equal(rooms.bookings[0].title, 'Retro');
  assert.equal(rooms.rooms.find((r) => r.id === 'board').av, true);
  await assert.rejects(call(c, 'book_room', { room: 'huddle', start, minutes: 30 }), /booked/);
  await call(c, 'manage_booking', { id: booked.id, op: 'cancel' });
  assert.equal(office.bookings.length, 0);
  await c.close();
});

// Workers' fetch throws "Illegal invocation" unless called with `this` =
// globalThis (or nothing); Node doesn't care, so emulate the rule here.
test('verify works under the Workers fetch `this` rule', async (t) => {
  const at = fakeAtproto();
  const real = globalThis.fetch;
  globalThis.fetch = function (...a) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    return at.fetch(...a);
  };
  t.after(() => { globalThis.fetch = real; });
  const auth = new AgentAuth({ resolve: at.resolve }); // default fetch, as in worker/index.js
  const office = new Office({});
  const hub = new McpHub({ office, auth, token: 'op-token' });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), {
    fetch: (url, init) => hub.fetch(new Request(url, init)),
    requestInit: { headers: OP },
  }));
  const ch = await call(client, 'atproto_challenge');
  await assert.rejects(call(client, 'atproto_verify', { handle: 'bot.roost.test', nonce: 'nope' }), /unknown or expired nonce/);
  at.repo.set(`did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/${ch.collection}/${ch.rkey}`, ch.record);
  const v = await call(client, 'atproto_verify', { handle: 'bot.roost.test', nonce: ch.nonce });
  assert.equal(v.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  await assert.rejects(call(client, 'atproto_verify', { handle: 'bot.roost.test', nonce: ch.nonce }), /unknown or expired nonce/);
  const j = await call(client, 'join_office', { name: 'bodhi' });
  assert.equal(j.signedIn, true);
  const me = office.summary().online.find((p) => p.name === 'bodhi');
  assert.equal(me.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  // roost_sign_in goes through the same fetch
  const r = await call(client, 'roost_sign_in', { token: 'rmcp_good', pds: 'https://roost.test' });
  assert.equal(r.did, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  await client.close();
});

test('a session outlives a restart and its agent is put back in the office', async () => {
  const at = fakeAtproto();
  const auth = new AgentAuth({ fetch: at.fetch, resolve: at.resolve });
  const rows = new Map();
  const store = { get: (k) => rows.get(k), set: (k, v) => rows.set(k, v), del: (k) => rows.delete(k) };
  let hub = new McpHub({ office: new Office({}), auth, token: 'op-token', store });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), {
    fetch: (url, init) => hub.fetch(new Request(url, init)),
    requestInit: { headers: OP },
  }));
  await call(client, 'join_office', { name: 'Bodhi', note: 'salon' });
  assert.equal(rows.size, 1);

  // A deploy: a fresh office and hub, same storage, same client.
  const office = new Office({});
  hub = new McpHub({ office, auth, token: 'op-token', store });
  const me = await call(client, 'whoami');
  assert.equal(me.operator, true);
  assert.equal(me.inOffice, true);
  assert.ok([...office.peers.values()].some((p) => p.ready && p.name === 'Bodhi'));

  await call(client, 'leave_office');
  assert.equal(JSON.parse([...rows.values()][0]).joined, null);
  await client.close();
});

test('an MCP agent takes a desk and uses its workstation', async () => {
  const { connect } = await setup();
  const c = await connect(OP);
  await call(c, 'join_office', { name: 'Desk Bot' });
  await assert.rejects(call(c, 'workstation_desktop'), /sit at a desk/);
  const { desk } = await call(c, 'take_desk', { goal: 'triage' });
  assert.ok(desk);
  await call(c, 'workstation_todoAdd', { text: 'answer the mentions' });
  const r = await call(c, 'workstation_run', { line: 'todo' });
  assert.match(r.out, /\[ \] answer the mentions/);
  const n = await call(c, 'workstation_noteSave', { title: 'Log', text: 'started' });
  const d = await call(c, 'workstation_desktop');
  assert.equal(d.owner, 'agent:Desk Bot');
  assert.equal(d.notes[0].id, n.id);
  await c.close();
});

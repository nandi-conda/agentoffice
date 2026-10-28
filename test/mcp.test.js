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
  const hub = new McpHub({ office, auth, token: '' });
  const connect = async () => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('http://office.test/mcp'), {
      fetch: (url, init) => hub.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    return client;
  };
  return { at, auth, office, hub, connect };
}

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
  for (const t of ['join_office', 'move', 'chat', 'status', 'emote', 'sit', 'desk', 'pomo', 'wb', 'note', 'coffee', 'score', 'wave', 'audio', 'rtc', 'send', 'read_events', 'walk_to', 'look', 'roost_signup', 'roost_sign_in', 'atproto_challenge', 'atproto_verify']) {
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

  const c = await connect();
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
  const c = await connect();
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

test('MCP_TOKEN guards the endpoint', async () => {
  const hub = new McpHub({ office: new Office(), auth: new AgentAuth(), token: 's3cret' });
  const r = await hub.fetch(new Request('http://x/mcp', { method: 'POST', body: '{}' }));
  assert.equal(r.status, 401);
});

test('agents book, list and cancel meeting rooms over MCP', async () => {
  const { office, connect } = await setup();
  const c = await connect();
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

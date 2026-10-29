import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { FreeqBridge } from '../server/freeq.js';
import { ZONES, SEATS, SPAWN, W, H, applyWing, isBlocked, zoneAt, findPath } from '../public/js/map.js';
import { buildWing, roomRect, slugOf, MAX_ROOMS } from '../public/js/wing.js';
import { evaluate, summary, cleanPolicy } from '../public/js/policy.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));

async function join(office, name, auth = {}, extra = {}) {
  const ws = new FakeWs();
  office.connect(ws, auth);
  ws.msg({ t: 'hello', name, ...extra });
  await tick();
  return { ws, id: ws.last('welcome').you.id, p: [...office.peers.values()].find((q) => q.name === name) };
}
const at = async (c, x, y) => { c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true }); await tick(); };
const inside = (zoneId) => {
  const z = ZONES.find((x) => x.id === zoneId);
  for (let y = z.y0; y <= z.y1; y++) for (let x = z.x0; x <= z.x1; x++) if (!isBlocked(x, y)) return { x: x + 0.5, y: y + 0.5 };
  return null;
};

// #freeq's live policy (irc.freeq.at/api/v1/policy/%23freeq, 2026-10-29):
// accept the code of conduct to join; GitHub collaborators on chad/freeq get op.
const FREEQ_POLICY = {
  policy: {
    channel_id: '#freeq', version: 5,
    requirements: { type: 'ACCEPT', hash: '0b5752faf791ed46e09cd1dd12d787695437fcb8c7bd6392791c8efcab2b9e7f' },
    role_requirements: { op: { type: 'PRESENT', credential_type: 'github_repo', issuer: 'did:web:irc.freeq.at:verify' } },
    credential_endpoints: { github_repo: { issuer: 'did:web:irc.freeq.at:verify', url: '/verify/github/start?repo=chad/freeq', label: 'GitHub Repo Collaborator' } },
  },
};
const FREEQ_RULES = { channel: '#freeq', hash: FREEQ_POLICY.policy.requirements.hash, text: '#freeq Code of Conduct — Be respectful and assume good faith.' };

test('the wing is the same for everyone, and every room and seat is reachable', () => {
  const rooms = Array.from({ length: MAX_ROOMS }, (_, i) => ({ id: `ch-c${i}`, channel: `#c${i}`, slot: i, tier: ['s', 'm', 'l'][i % 3] }));
  assert.deepEqual(buildWing(rooms), buildWing(structuredClone(rooms)));
  applyWing(rooms);
  assert.ok(W > 48 && H > 32, 'the map grew');
  for (const z of ZONES) {
    const s = z.channel ? inside(z.id) : { x: Math.floor((z.x0 + z.x1) / 2), y: Math.floor((z.y0 + z.y1) / 2) };
    assert.ok(s, `nowhere to stand in ${z.id}`);
    if (z.gen) assert.ok(findPath(SPAWN.x, SPAWN.y, s.x, s.y), `${z.id} unreachable`);
  }
  for (const s of SEATS.filter((x) => x.zone)) assert.ok(findPath(SPAWN.x, SPAWN.y, s.x, s.y), `seat ${s.id} unreachable`);
  // A room's door faces its hall, and the spot outside it is the hall.
  const r = roomRect(7, 'm');
  assert.match(zoneAt(r.outside.x, r.outside.y).id, /^hall-1$/);
  applyWing([]);
  assert.equal(W, 48); assert.equal(H, 32);
  assert.ok(!ZONES.some((z) => z.gen));
});

test('policies: freeq\'s DSL, accepted rules, invites, bans and vouching', () => {
  const p = cleanPolicy({ source: 'freeq', require: FREEQ_POLICY.policy.requirements, rulesHash: FREEQ_RULES.hash, deny: ['did:plc:troll'] });
  assert.deepEqual(summary(p), { icon: '📜', text: 'accept rules', open: false });
  assert.equal(evaluate(p, {}).ok, false);
  assert.equal(evaluate(p, {}).needs[0].type, 'ACCEPT');
  assert.equal(evaluate(p, { accepted: new Set([FREEQ_RULES.hash]) }).ok, true);
  assert.equal(evaluate(p, { did: 'did:plc:troll', allowed: true }).ok, false, 'a ban beats everything');
  assert.equal(evaluate(p, { allowed: true }).ok, true);
  const gh = cleanPolicy({ require: { type: 'ANY', requirements: [{ type: 'PRESENT', credential_type: 'github_repo' }, { type: 'INVITE' }] }, endpoints: { github_repo: { label: 'GitHub Repo Collaborator', url: 'https://irc.freeq.at/verify/github/start' } } });
  assert.equal(summary(gh).text, 'invite only + credential');
  assert.equal(evaluate(gh, { invited: true }).ok, true);
  assert.equal(evaluate(gh, {}).needs[0].url, 'https://irc.freeq.at/verify/github/start');
  assert.equal(evaluate(cleanPolicy({ require: { type: 'WHATEVER' } }), {}).ok, false, 'unknown requirements fail closed');
  assert.equal(summary(null).text, 'open');
});

test('#freeq gets a room whose door wants its code of conduct accepted, for people and agents', async () => {
  const office = new Office({}, { loadActor: null });
  const fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/v1/channels')) return Response.json([{ name: '#general', members: 4 }]);
    if (u.includes('/policy/%23freeq/rules')) return Response.json(FREEQ_RULES);
    if (u.includes('/policy/%23freeq')) return Response.json(FREEQ_POLICY);
    return new Response('No policy for this channel', { status: 404 });
  };
  const bridge = new FreeqBridge({ office, log: () => {}, always: '#freeq', fetch, keyStore: { get: async () => null, set: async () => {} }, openSocket: async () => { throw new Error('offline'); } });
  bridge.listener = { channels: new Set(), join() {}, part() {}, send() {} }; // pretend we're listening
  await bridge.refresh();
  const room = office.wing.find((r) => r.channel === '#freeq');
  assert.ok(room, '#freeq has a room though it isn\'t in the channel list');
  assert.equal(room.id, `ch-${slugOf('#freeq')}`);
  assert.deepEqual(room.access, { icon: '📜', text: 'accept rules', open: false });
  assert.match(room.policy.rules, /Code of Conduct/);
  assert.equal(room.policy.endpoints.github_repo.url, 'https://irc.freeq.at/verify/github/start?repo=chad/freeq');
  assert.equal(office.wing.find((r) => r.channel === '#general').access.open, true);
  await tick();

  const alice = await join(office, 'Alice', { did: 'did:plc:alice' });
  const inFreeq = inside(room.id);
  const door = roomRect(room.slot, room.tier).outside;
  await at(alice, door.x, door.y);
  await at(alice, inFreeq.x, inFreeq.y);
  const bounce = alice.ws.last('bounce');
  assert.ok(bounce?.door, 'the door stays shut');
  assert.match(bounce.text, /accept rules.*accept the channel rules to get in/);
  assert.notEqual(zoneAt(alice.p.x, alice.p.y)?.id, room.id);

  // The sign says what to do; accepting the current rules opens the door.
  alice.ws.msg({ t: 'chan', op: 'check', room: room.id, ref: 1 }); await tick();
  const check = alice.ws.last('chan').result;
  assert.equal(check.ok, false);
  assert.equal(check.needs[0].hash, FREEQ_RULES.hash);
  alice.ws.msg({ t: 'chan', op: 'accept', room: room.id, hash: 'stale' }); await tick();
  assert.match(alice.ws.last('error').message, /current rules/);
  alice.ws.msg({ t: 'chan', op: 'accept', room: room.id, hash: FREEQ_RULES.hash }); await tick();
  await at(alice, inFreeq.x, inFreeq.y);
  assert.equal(zoneAt(alice.p.x, alice.p.y)?.id, room.id);

  // An agent is held to the same door, through the generated API too.
  const bot = await join(office, 'Bot', { did: 'did:plc:bot' }, { kind: 'agent' });
  await at(bot, door.x, door.y);
  await at(bot, inFreeq.x, inFreeq.y);
  assert.ok(bot.ws.last('bounce')?.door);
  const r = await office.call(bot.p, `chan:${room.id}`, 'check');
  assert.equal(r.ok, false);
  await office.call(bot.p, `chan:${room.id}`, 'accept', [FREEQ_RULES.hash]);
  await at(bot, inFreeq.x, inFreeq.y);
  assert.equal(zoneAt(bot.p.x, bot.p.y)?.id, room.id);

  // What's said inside is kept, and shown to the next one in.
  alice.ws.msg({ t: 'chat', text: 'hello #freeq' }); await tick();
  assert.deepEqual((await office.ref(`chan:${room.id}`).history()).map((l) => l.text), ['hello #freeq']);
});

test('rooms people open: invite only, knock and let in; the wing keeps slots', async () => {
  const office = new Office({}, { loadActor: null });
  const guest = await join(office, 'Gus');
  guest.ws.msg({ t: 'chan', op: 'open', name: '#nope' }); await tick();
  assert.match(guest.ws.last('error').message, /sign in/);

  const ada = await join(office, 'Ada', { did: 'did:plc:ada' });
  ada.ws.msg({ t: 'chan', op: 'open', name: '#design', access: 'invite', ref: 'a' }); await tick();
  const room = ada.ws.last('chan').room;
  assert.equal(room.channel, '#design');
  assert.equal(room.access.text, 'invite only');
  assert.ok(ada.ws.last('wing').rooms.some((r) => r.id === room.id), 'everyone gets the new map');
  await tick();

  const spot = inside(room.id), door = roomRect(room.slot, room.tier).outside;
  // The opener walks straight in.
  await at(ada, door.x, door.y); await at(ada, spot.x, spot.y);
  assert.equal(zoneAt(ada.p.x, ada.p.y)?.id, room.id);
  // Bob knocks; Ada lets him in.
  const bob = await join(office, 'Bob', { did: 'did:plc:bob' });
  await at(bob, door.x, door.y); await at(bob, spot.x + 1, spot.y);
  assert.ok(bob.ws.last('bounce')?.door);
  bob.ws.msg({ t: 'chan', op: 'knock', room: room.id }); await tick();
  const knock = ada.ws.last('wave');
  assert.equal(knock.kind, 'knock'); assert.equal(knock.chanRoom, room.id);
  ada.ws.msg({ t: 'chan', op: 'admit', room: room.id, to: bob.id }); await tick();
  await at(bob, spot.x + 1, spot.y);
  assert.equal(zoneAt(bob.p.x, bob.p.y)?.id, room.id);

  // Opening it to all, then a second room takes the next slot.
  ada.ws.msg({ t: 'chan', op: 'access', name: '#design', access: 'open' }); await tick();
  assert.equal(office.wing.find((r) => r.id === room.id).access.open, true);
  ada.ws.msg({ t: 'chan', op: 'open', name: 'random' }); await tick();
  const second = office.wing.find((r) => r.channel === '#random');
  assert.equal(second.slot, room.slot + 1);
  // Only the opener can let it go.
  bob.ws.msg({ t: 'chan', op: 'close', name: '#random' }); await tick();
  assert.match(bob.ws.last('error').message, /only Ada/);
});

test('a room opened "open to anyone" lets anyone walk straight in', async () => {
  const office = new Office({}, { loadActor: null });
  const ada = await join(office, 'Ada', { did: 'did:plc:ada' });
  // What the Open a room form sends with 🚪 Anyone ticked.
  ada.ws.msg({ t: 'chan', op: 'open', name: 'hangout', access: 'open', ref: 'o' }); await tick();
  const room = ada.ws.last('chan').room;
  assert.deepEqual(room.access, { icon: '🚪', text: 'open', open: true });
  assert.equal(room.policy, null);
  await tick();
  const spot = inside(room.id), door = roomRect(room.slot, room.tier).outside;
  for (const [name, auth] of [['Bob', { did: 'did:plc:bob' }], ['Gus', {}]]) {
    const c = await join(office, name, auth);
    await at(c, door.x, door.y); await at(c, spot.x, spot.y);
    assert.equal(c.ws.last('bounce'), undefined, `${name} was turned away`);
    assert.equal(zoneAt(c.p.x, c.p.y)?.id, room.id);
    c.ws.msg({ t: 'chan', op: 'check', room: room.id, ref: 'c' }); await tick();
    assert.equal(c.ws.last('chan').result.ok, true);
  }
});

test('a room opened in the office is bridged to the freeq channel of the same name', async () => {
  const office = new Office({}, { loadActor: null });
  const fetch = async (url) => (String(url).endsWith('/api/v1/channels') ? Response.json([]) : new Response('No policy for this channel', { status: 404 }));
  const bridge = new FreeqBridge({ office, log: () => {}, always: '', fetch, keyStore: { get: async () => null, set: async () => {} }, openSocket: async () => { throw new Error('offline'); } });
  const joined = [];
  bridge.listener = { channels: new Set(), join(ch) { joined.push(ch); }, part() {}, send() {} };
  const ada = await join(office, 'Ada', { did: 'did:plc:ada' });
  ada.ws.msg({ t: 'chan', op: 'open', name: 'hangout', access: 'open', ref: 'o' }); await tick();
  const room = ada.ws.last('chan').room;
  await new Promise((r) => setTimeout(r, 700)); // the bridge picks it up without waiting for its refresh
  assert.equal(bridge.bindings.get(room.id)?.channel, '#hangout');
  assert.ok(joined.includes('#hangout'), 'the listener joined (and so created) #hangout');
  // Lines from freeq are heard in the room.
  await at(ada, roomRect(room.slot, room.tier).outside.x, roomRect(room.slot, room.tier).outside.y);
  const spot = inside(room.id); await at(ada, spot.x, spot.y);
  bridge.heard('#hangout', 'zed', null, 'hi from freeq', { ts: Date.now() }); await tick();
  assert.equal(ada.ws.last('chat')?.text, 'hi from freeq');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { ROOMS, MIN, checkSlot, roomStatus, isHolder, parseInvitees } from '../public/js/rooms.js';
import { zoneAt, isBlocked, findPath, SPAWN, FURNITURE } from '../public/js/map.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
  all(t) { return this.sent.filter((m) => m.t === t); }
}
const tick = () => new Promise((r) => setImmediate(r));
const T0 = Date.UTC(2026, 9, 28, 14, 0); // on a 5 minute boundary

function office() {
  const clock = { t: T0 };
  const o = new Office({}, { now: () => clock.t });
  return { o, clock };
}
async function join(o, name, { did, kind = 'human', handle } = {}) {
  const ws = new FakeWs();
  const p = o.connect(ws, { did });
  ws.msg({ t: 'hello', name, kind });
  await tick();
  if (handle) p.handle = handle;
  return { ws, p };
}
const place = async (c, x, y) => { c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true }); await tick(); };
const book = async (c, m) => { c.ws.msg({ t: 'book', op: 'create', ...m }); await tick(); return c.ws.last('booked')?.booking; };

test('bookable rooms have a walkable door spot and a panel', () => {
  assert.deepEqual(ROOMS.map((r) => r.id).sort(), ['board', 'booth1', 'booth2', 'booth3', 'huddle']);
  for (const r of ROOMS) {
    assert.equal(isBlocked(Math.floor(r.door.x), Math.floor(r.door.y)), false, `${r.id} door blocked`);
    assert.notEqual(zoneAt(r.door.x, r.door.y)?.id, r.id, `${r.id} door is inside`);
    assert.ok(findPath(SPAWN.x, SPAWN.y, r.door.x, r.door.y), `${r.id} door unreachable`);
    assert.ok(FURNITURE.some((f) => f.type === 'panel' && f.zone === r.id), `${r.id} has no panel`);
  }
  assert.deepEqual(ROOMS.filter((r) => r.av).map((r) => r.id).sort(), ['board', 'huddle']);
});

test('slots snap, respect limits and refuse overlaps', () => {
  const now = T0;
  assert.match(checkSlot([], { room: 'nope', start: now, end: now + 30 * MIN }, now).error, /no such room/);
  assert.match(checkSlot([], { room: 'board', start: now, end: now + 5 * MIN }, now).error, /at least 15/);
  assert.match(checkSlot([], { room: 'board', start: now, end: now + 5 * 60 * MIN }, now).error, /at most 4/);
  assert.match(checkSlot([], { room: 'board', start: now - 60 * MIN, end: now - 30 * MIN }, now).error, /passed/);
  assert.match(checkSlot([], { room: 'board', start: now + 20 * 24 * 60 * MIN, end: now + 20 * 24 * 60 * MIN + 30 * MIN }, now).error, /14 days/);
  const ok = checkSlot([], { room: 'board', start: now + 2 * MIN, end: now + 31 * MIN }, now);
  assert.deepEqual(ok, { start: now, end: now + 30 * MIN });
  const list = [{ id: 'a', room: 'board', start: now, end: now + 30 * MIN, title: 'x' }];
  assert.match(checkSlot(list, { room: 'board', start: now + 15 * MIN, end: now + 45 * MIN }, now).error, /booked/);
  assert.ok(!checkSlot(list, { room: 'board', start: now + 30 * MIN, end: now + 60 * MIN }, now).error, 'back to back is fine');
  assert.ok(!checkSlot(list, { room: 'huddle', start: now, end: now + 30 * MIN }, now).error, 'other rooms are separate');
  assert.equal(roomStatus(list, 'board', now).state, 'busy');
  assert.equal(roomStatus(list, 'board', now - 10 * MIN).state, 'soon');
  assert.equal(roomStatus(list, 'board', now - 60 * MIN).state, 'free');
});

test('holders: owner, invited handle or DID, invited agent name, admitted', () => {
  const b = { owner: 'did:plc:own', invitees: parseInvitees('@Ada.bsky.social, did:plc:bob StandupBot'), admitted: ['human:walkin'] };
  assert.ok(isHolder(b, { did: 'did:plc:own', kind: 'human', name: 'x' }));
  assert.ok(isHolder(b, { did: 'did:plc:zzz', handle: 'ada.bsky.social', kind: 'human', name: 'x' }));
  assert.ok(isHolder(b, { did: 'did:plc:bob', kind: 'human', name: 'x' }));
  assert.ok(isHolder(b, { kind: 'agent', name: 'Standup Bot' }));
  assert.ok(isHolder(b, { kind: 'human', name: 'walkin' }));
  assert.ok(!isHolder(b, { kind: 'human', name: 'standupbot' }), 'a guest cannot borrow an agent name');
});

test('guests cannot book; signed-in people and agents can', async () => {
  const { o } = office();
  const guest = await join(o, 'guest');
  guest.ws.msg({ t: 'book', op: 'create', room: 'board', start: T0, minutes: 30, ref: 1 });
  await tick();
  assert.match(guest.ws.last('error').message, /sign in/);
  assert.equal(guest.ws.last('error').ref, 1);
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const b = await book(ada, { room: 'board', start: T0 + 60 * MIN, minutes: 30, title: 'Design review' });
  assert.equal(b.title, 'Design review');
  assert.equal(b.owner, 'did:plc:ada');
  assert.equal(guest.ws.last('bookings').bookings.length, 1, 'everyone sees the schedule');
  const bot = await join(o, 'BuildBot', { kind: 'agent' });
  assert.ok(await book(bot, { room: 'huddle', start: new Date(T0 + 60 * MIN).toISOString(), end: new Date(T0 + 90 * MIN).toISOString() }));
  assert.deepEqual(Object.keys(o.persisted()).includes('bookings'), true);
});

test('only the booker can cancel or extend; extending checks the next booking', async () => {
  const { o } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  const b = await book(ada, { room: 'huddle', start: T0, minutes: 30 });
  await book(bob, { room: 'huddle', start: T0 + 45 * MIN, minutes: 30 });
  bob.ws.msg({ t: 'book', op: 'cancel', id: b.id }); await tick();
  assert.match(bob.ws.last('error').message, /only the person/);
  ada.ws.msg({ t: 'book', op: 'extend', id: b.id, minutes: 15 }); await tick();
  assert.equal(o.bookings.find((x) => x.id === b.id).end, T0 + 45 * MIN);
  ada.ws.msg({ t: 'book', op: 'extend', id: b.id, minutes: 15 }); await tick();
  assert.match(ada.ws.last('error').message, /booked/);
  ada.ws.msg({ t: 'book', op: 'cancel', id: b.id }); await tick();
  assert.equal(o.bookings.length, 1);
});

test('a locked booking keeps others out, shows them out at the start, and holders can admit', async () => {
  const { o, clock } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  const cat = await join(o, 'cat', { did: 'did:plc:cat', handle: 'cat.test' });
  await place(bob, 40, 8); // bob is camped in the boardroom
  const b = await book(ada, { room: 'board', start: T0 + 10 * MIN, minutes: 30, lock: true, invitees: 'cat.test', title: 'Offsite plan' });
  clock.t = T0 + 10 * MIN; o.tickRooms();
  assert.equal(zoneAt(o.peers.get(bob.p.id).x, o.peers.get(bob.p.id).y).id, 'open', 'bob was shown out');
  assert.match(bob.ws.last('bounce').text, /Offsite plan/);
  assert.match(ada.ws.last('roomnote').text, /starting now/);
  // bob can't walk back in, cat (invited) and ada can
  await place(bob, 40, 8);
  assert.notEqual(zoneAt(o.peers.get(bob.p.id).x, o.peers.get(bob.p.id).y)?.id, 'board');
  await place(cat, 40, 8);
  assert.equal(zoneAt(o.peers.get(cat.p.id).x, o.peers.get(cat.p.id).y).id, 'board');
  cat.ws.msg({ t: 'book', op: 'admit', id: b.id, to: bob.p.id }); await tick();
  await place(bob, 40, 8);
  assert.equal(zoneAt(o.peers.get(bob.p.id).x, o.peers.get(bob.p.id).y).id, 'board');
  assert.match(bob.ws.last('roomnote').text, /let you in/);
});

test('an unlocked booking only announces; reminders and end notes go out once', async () => {
  const { o, clock } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  await place(bob, 36.5, 13.5);
  const b = await book(ada, { room: 'huddle', start: T0 + 30 * MIN, minutes: 30, title: 'Sync' });
  clock.t = T0 + 26 * MIN; o.tickRooms(); o.tickRooms();
  assert.equal(ada.ws.all('roomnote').filter((m) => m.kind === 'soon').length, 1);
  clock.t = T0 + 30 * MIN; o.tickRooms();
  assert.equal(zoneAt(o.peers.get(bob.p.id).x, o.peers.get(bob.p.id).y).id, 'huddle', 'not locked, so bob stays');
  assert.match(bob.ws.last('roomnote').text, /booked now for “Sync”/);
  await place(ada, 39, 13);
  clock.t = T0 + 56 * MIN; o.tickRooms();
  assert.match(ada.ws.last('roomnote').text, /minutes left/);
  clock.t = T0 + 60 * MIN; o.tickRooms();
  assert.equal(ada.ws.last('roomnote').kind, 'ended');
  assert.ok(o.bookings.find((x) => x.id === b.id), 'kept as history for a day');
  clock.t = T0 + 25 * 60 * MIN; o.tickRooms();
  assert.equal(o.bookings.length, 0);
});

test('rooms nobody turns up to are released after the grace period', async () => {
  const { o, clock } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await book(ada, { room: 'booth1', start: T0, minutes: 60 });
  await book(ada, { room: 'booth2', start: T0, minutes: 60, autoRelease: false });
  assert.ok(o.nextRoomEvent() > T0);
  clock.t = T0 + 11 * MIN; o.tickRooms();
  assert.deepEqual(o.bookings.map((b) => b.room), ['booth2']);
  assert.match(ada.ws.last('roomnote').text, /Nobody turned up/);
});

test('turning up in time keeps the booking', async () => {
  const { o, clock } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await book(ada, { room: 'booth1', start: T0, minutes: 60 });
  clock.t = T0 + 5 * MIN;
  await place(ada, 2.5, 15.5);
  clock.t = T0 + 11 * MIN; o.tickRooms();
  assert.equal(o.bookings.length, 1);
});

test('camera and screen flags only stick inside an A/V room', async () => {
  const { o } = office();
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob');
  await place(ada, 2.5, 15.5); // booth: voice only
  ada.ws.msg({ t: 'av', video: true, screen: true }); await tick();
  assert.equal(o.peers.get(ada.p.id).video, false);
  await place(ada, 40, 8);
  ada.ws.msg({ t: 'av', video: true, screen: true }); await tick();
  assert.equal(bob.ws.last('peer').video, true);
  assert.equal(bob.ws.last('peer').screen, true);
});

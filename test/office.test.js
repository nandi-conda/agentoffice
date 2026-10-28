import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { SEATS } from '../public/js/map.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
  all(t) { return this.sent.filter((m) => m.t === t); }
}

const tick = () => new Promise((r) => setImmediate(r));

async function join(office, name, extra = {}, auth = {}) {
  const ws = new FakeWs();
  office.connect(ws, auth);
  ws.msg({ t: 'hello', name, ...extra });
  await tick();
  const w = ws.last('welcome');
  return { ws, id: w.you.id };
}

const place = async (o, c, x, y) => { c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true }); await tick(); };

test('welcome lists the people already here', async () => {
  const o = new Office();
  const a = await join(o, 'ada');
  const b = await join(o, 'grace');
  assert.equal(b.ws.last('welcome').peers.length, 1);
  assert.equal(a.ws.last('join').peer.name, 'grace');
});

test('chat reaches only people who can hear, plus @mentions', async () => {
  const o = new Office();
  const a = await join(o, 'ada'), b = await join(o, 'grace'), c = await join(o, 'linus');
  await place(o, a, 20, 7); await place(o, b, 21, 7); await place(o, c, 40, 8);
  a.ws.msg({ t: 'chat', text: 'hi' }); await tick();
  assert.equal(b.ws.last('chat')?.text, 'hi');
  assert.equal(c.ws.last('chat'), undefined);
  a.ws.msg({ t: 'chat', text: '@linus got a minute?' }); await tick();
  assert.equal(c.ws.last('chat').mention, true);
  a.ws.msg({ t: 'chat', text: '/shout lunch!' }); await tick();
  assert.equal(c.ws.last('chat').text, 'lunch!');
  assert.equal(c.ws.last('chat').scope, 'office');
});

test('private rooms keep chat inside', async () => {
  const o = new Office();
  const a = await join(o, 'ada'), b = await join(o, 'grace'), c = await join(o, 'eve');
  await place(o, a, 36, 8); await place(o, b, 45, 2); await place(o, c, 33, 8);
  a.ws.msg({ t: 'chat', text: 'secret plans' }); await tick();
  assert.equal(b.ws.last('chat').scope, 'Boardroom');
  assert.equal(c.ws.last('chat'), undefined);
});

test('desk claims are exclusive while the owner is around', async () => {
  const saves = [];
  const o = new Office({}, { onChange: () => saves.push(1) });
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  a.ws.msg({ t: 'desk', action: 'claim', desk: 'desk-1', goal: 'parser' }); await tick();
  assert.equal(o.desks['desk-1'].name, 'ada');
  b.ws.msg({ t: 'desk', action: 'claim', desk: 'desk-1' }); await tick();
  assert.equal(o.desks['desk-1'].name, 'ada');
  assert.match(b.ws.last('error').message, /ada's desk/);
  a.ws.msg({ t: 'desk', action: 'claim', desk: 'desk-2' }); await tick();
  assert.equal(o.desks['desk-1'], undefined, 'claiming a new desk frees the old one');
  assert.equal(o.runtime.data['desk:desk-2'].state.holder.name, 'ada', 'the desk entity keeps its own state');
});

test('sitting snaps to the seat and blocks double booking', async () => {
  const o = new Office();
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  const seat = SEATS.find((s) => s.id === 'bean1');
  await place(o, a, seat.x + 1, seat.y); await place(o, b, seat.x + 1, seat.y + 0.5);
  a.ws.msg({ t: 'sit', seat: 'bean1' }); await tick();
  assert.equal(b.ws.last('move').seat, 'bean1');
  b.ws.msg({ t: 'sit', seat: 'bean1' }); await tick();
  assert.ok(b.ws.last('error'));
});

test('shared pomodoro runs in the den', async () => {
  let now = 1000;
  const o = new Office({}, { now: () => now });
  const a = await join(o, 'ada');
  await place(o, a, 5, 10);
  a.ws.msg({ t: 'pomo', action: 'start', focusMin: 25, breakMin: 5 }); await tick();
  const p = a.ws.last('pomo').pomo.focus;
  assert.equal(p.phase, 'focus');
  assert.equal(p.endsAt, 1000 + 25 * 60000);
  a.ws.msg({ t: 'pomo', action: 'stop' }); await tick();
  assert.equal(a.ws.last('pomo').pomo.focus.phase, 'idle');
});

test('rtc signals are relayed only to the addressed peer', async () => {
  const o = new Office();
  const a = await join(o, 'ada'), b = await join(o, 'grace'), c = await join(o, 'eve');
  a.ws.msg({ t: 'rtc', to: b.id, data: { sdp: 'x' } }); await tick();
  assert.equal(b.ws.last('rtc').from, a.id);
  assert.equal(c.ws.last('rtc'), undefined);
});

test('whiteboard strokes are clamped and shared', async () => {
  const o = new Office();
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  a.ws.msg({ t: 'wb', op: 'stroke', points: [[0, 0], [2, -1]], color: 'red', size: 99 }); await tick();
  const s = b.ws.last('wb').stroke;
  assert.deepEqual(s.points[1], [1, 0]);
  assert.equal(s.color, '#1f2937');
  assert.equal(s.size, 24);
});

test('signed-in DIDs load the character server-side', async () => {
  const o = new Office({}, { loadActor: async (id) => ({ did: id, handle: 'ada.test', displayName: 'Ada L', sprite: { sheet: '/api/blob?x' }, stats: [] }) });
  const a = await join(o, '', {}, { did: 'did:plc:abc' });
  const you = a.ws.last('welcome').you;
  assert.equal(you.did, 'did:plc:abc');
  assert.equal(you.handle, 'ada.test');
  assert.equal(you.name, 'Ada L');
  assert.equal(you.actor.sprite.sheet, '/api/blob?x');
});

test('an unverified handle in hello is ignored', async () => {
  const calls = [];
  const o = new Office({}, { loadActor: async (id) => { calls.push(id); return { did: 'did:plc:victim', handle: id, sprite: null, stats: [] }; } });
  const a = await join(o, 'mallory', { handle: 'victim.test', did: 'did:plc:victim' });
  const you = a.ws.last('welcome').you;
  assert.equal(calls.length, 0);
  assert.equal(you.did, null);
  assert.equal(you.handle, null);
  assert.match(a.ws.last('error').message, /sign in/);
});

test('the signed-in DID wins over whatever hello claims', async () => {
  const o = new Office({}, { loadActor: async (id) => ({ did: id, handle: 'ada.test', sprite: null, stats: [] }) });
  const a = await join(o, 'ada', { handle: 'victim.test' }, { did: 'did:plc:abc' });
  assert.equal(a.ws.last('welcome').you.did, 'did:plc:abc');
  assert.equal(a.ws.last('welcome').you.handle, 'ada.test');
});

test('a newer connection for the same identity replaces the older one', async () => {
  const o = new Office({}, { loadActor: async (id) => ({ did: id, handle: 'ada.test', sprite: null, stats: [] }) });
  const watcher = await join(o, 'grace');
  const tab1 = await join(o, 'ada', {}, { did: 'did:plc:ada' });
  tab1.ws.close = (code) => { tab1.closedWith = code; };
  const tab2 = await join(o, 'ada', {}, { did: 'did:plc:ada' });
  assert.equal(tab1.closedWith, 4001);
  assert.ok(tab1.ws.last('replaced'));
  assert.equal([...o.peers.values()].filter((p) => p.did === 'did:plc:ada').length, 1);
  assert.equal(watcher.ws.last('leave').id, tab1.id);
  assert.equal(tab2.ws.last('welcome').peers.length, 1); // just grace
  // Guests have no identity to match on, so two of them are two people.
  await join(o, 'guest'); await join(o, 'guest');
  assert.equal(o.summary().online.filter((p) => p.name === 'guest').length, 2);
});

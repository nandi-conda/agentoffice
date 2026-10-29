import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { Entity, LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { MIN } from '../public/js/rooms.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const tick = () => new Promise((r) => setImmediate(r));
async function join(o, name, { did, kind = 'human' } = {}) {
  const ws = new FakeWs();
  const p = o.connect(ws, { did });
  ws.msg({ t: 'hello', name, kind });
  await tick();
  return { ws, p };
}

test('entities talk: direct RPC, tell → onMessage, and pub/sub topics', async () => {
  const heard = [];
  class Echo extends Entity {
    static rpc = ['ping'];
    ping(x) { return `pong ${x} from ${this.name}`; }
    async setup() { await this.subscribe('news'); }
    onMessage(m) { heard.push(['msg', this.name, m.type, m.data, m.from]); }
    onEvent(topic, ev, from) { heard.push(['event', this.name, topic, ev.n, from]); }
  }
  const rt = new LocalRuntime({ kinds: { ...KINDS, echo: Echo } });
  rt.setWorld({ apply: () => true });
  assert.equal(await rt.ref('echo:a').ping(1), 'pong 1 from a');
  await rt.ref('echo:b').view(); // b exists, so it's subscribed too
  await rt.ref('echo:a').receive({ type: 'hi', data: { x: 1 }, from: 'echo:b' });
  const delivered = await rt.ref('topic:news').publish({ n: 7 }, 'echo:a');
  assert.equal(delivered, 1, "the publisher doesn't hear itself");
  assert.deepEqual(heard, [['msg', 'a', 'hi', { x: 1 }, 'echo:b'], ['event', 'b', 'news', 7, 'echo:a']]);
  await assert.rejects(rt.ref('echo:a').save(), /no method save/, 'only rpc methods are callable');
});

test('calls are structured-cloned, like Durable Object RPC', async () => {
  const rt = new LocalRuntime({ kinds: KINDS });
  rt.setWorld({ apply: () => true });
  await assert.rejects(rt.ref('arcade:main').score({ name: 'x', fn() {} }, 5));
});

test('the old single-object state moves into the entities on first start', async () => {
  const legacy = {
    desks: { 'desk-3': { owner: 'did:plc:ada', name: 'ada', goal: 'parser', since: 1, seen: 1 } },
    notes: [{ id: 'n1', text: 'hi', by: 'ada', owner: 'did:plc:ada', ts: 1, color: '#fde68a' }],
    strokes: [{ points: [[0, 0], [1, 1]], color: '#000000', size: 3, by: 'ada' }],
    scores: [{ name: 'ada', score: 50, ts: 1 }],
    counters: { coffees: 4, pomodoros: 2, waves: 9 },
    bookings: [{ id: 'b1', room: 'board', title: 'x', start: Date.now() + 60 * MIN, end: Date.now() + 90 * MIN, owner: 'did:plc:ada', name: 'ada', invitees: [], admitted: [], sent: {} }],
  };
  const o = new Office(legacy);
  await o.ready;
  assert.equal(o.desks['desk-3'].goal, 'parser');
  assert.equal(o.notes.length, 1);
  assert.equal(o.strokes.length, 1);
  assert.equal(o.scores[0].score, 50);
  assert.deepEqual(o.counters, { coffees: 4, pomodoros: 2, waves: 9 });
  assert.equal(o.bookings[0].room, 'board');
  assert.deepEqual(o.persisted(), { migrated: true, counters: { waves: 9 } });
  // A World starting again over the same entities doesn't seed twice.
  const again = new Office({ ...legacy, migrated: true }, { runtime: o.runtime });
  await again.ready;
  assert.equal(again.notes.length, 1);
});

test('actors remember status and keep notes for when their person is away', async () => {
  const clock = { t: Date.UTC(2026, 9, 28, 14, 0) };
  const o = new Office({}, { now: () => clock.t });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  ada.ws.msg({ t: 'status', status: 'focus', note: 'writing' }); await tick();
  ada.ws.msg({ t: 'book', op: 'create', room: 'booth1', start: clock.t, minutes: 60 }); await tick();
  ada.ws.readyState = 3; o.leave(ada.p); await tick();
  clock.t += 11 * MIN;
  await o.tickRooms();
  assert.equal(o.bookings.length, 0, 'released, nobody came');
  const back = await join(o, 'ada', { did: 'did:plc:ada' });
  const you = back.ws.last('welcome').you;
  assert.equal(you.status, 'focus');
  assert.equal(you.note, 'writing');
  assert.match(back.ws.last('roomnote').text, /Nobody turned up/, 'the note waited in the actor');
});

test('rooms hear people walk in over their zone topic', async () => {
  const clock = { t: Date.UTC(2026, 9, 28, 14, 0) };
  const o = new Office({}, { now: () => clock.t });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  ada.ws.msg({ t: 'book', op: 'create', room: 'booth1', start: clock.t, minutes: 60 }); await tick();
  assert.equal(o.bookings[0].seen, false);
  ada.ws.msg({ t: 'move', x: 2.5, y: 15.5, teleport: true }); await tick();
  assert.equal(o.bookings[0].seen, true);
});

test('pomodoro timers turn over on their own alarm', async () => {
  let now = 1000;
  const o = new Office({}, { now: () => now });
  const a = await join(o, 'ada');
  a.ws.msg({ t: 'move', x: 5, y: 10, teleport: true }); await tick();
  a.ws.msg({ t: 'pomo', action: 'start', focusMin: 1, breakMin: 1 }); await tick();
  now += MIN;
  await o.runtime.host('pomodoro:focus').alarm();
  assert.equal(a.ws.last('pomo').pomo.focus.phase, 'break');
  assert.equal(o.counters.pomodoros, 1);
  o.runtime.stop();
});

test('a character without a sprite is looked up again soon, and on every join', async () => {
  let t = 1_000_000, sprite = null;
  const calls = [];
  const loadActor = async (did, opts) => { calls.push(opts); return { did, handle: 'bodhi.test', sprite, stats: [] }; };
  const rt = new LocalRuntime({ kinds: KINDS, now: () => t, services: { loadActor } });
  const actor = rt.ref('actor:did:plc:cpnshgqvlkxpku2c235m6dzf');
  assert.equal((await actor.arrive()).profile.sprite, null);
  sprite = { sheet: '/api/blob?x' }; // they upload one a minute later
  t += 5_000;
  assert.equal((await actor.profile()).sprite, null, 'a miss is still believed for a few seconds');
  t += 30_000;
  assert.deepEqual((await actor.profile()).sprite, sprite, 'but not for long');
  // Rejoining with no sprite skips every cache.
  sprite = null;
  await actor.profile({ fresh: true });
  sprite = { sheet: '/api/blob?y' };
  assert.deepEqual((await actor.arrive()).profile.sprite, sprite);
  assert.equal(calls.at(-1).fresh, true);
  // With a sprite, the 10-minute cache holds.
  sprite = { sheet: '/api/blob?z' };
  t += 60_000;
  assert.deepEqual((await actor.arrive()).profile.sprite, { sheet: '/api/blob?y' });
});

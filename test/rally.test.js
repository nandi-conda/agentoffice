import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { LocalRuntime, MemoryStorage } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { PluginHost, sanitize } from '../server/plugins.js';
import { FURNITURE, ZONES, isBlocked } from '../public/js/map.js';
import { Rally, rally, CHECKPOINTS, LEGS, GATHER_MS, RACE_MS, WARN_MS, clock } from '../plugins/rally/src/rally.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
async function join(o, name, extra = {}) {
  const ws = new FakeWs();
  o.connect(ws);
  ws.msg({ t: 'hello', name, ...extra });
  await settle();
  return { ws, id: ws.last('welcome').you.id, items: () => ws.last('inv')?.items ?? ws.last('welcome').items };
}
const at = async (c, x, y) => { c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true }); await settle(); };
const flag = () => { const f = FURNITURE.find((x) => x.id === 'rally'); return { x: f.x + 0.5, y: f.y + 1.5 }; };
// A free tile in the middle of a zone.
function inZone(id) {
  const z = ZONES.find((q) => q.id === id);
  const cx = Math.floor((z.x0 + z.x1) / 2), cy = Math.floor((z.y0 + z.y1) / 2);
  for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (!isBlocked(cx + dx, cy + dy)) return { x: cx + dx + 0.5, y: cy + dy + 0.5 };
  }
  throw new Error(`no free tile in ${id}`);
}
const said = (c) => c.ws.sent.filter((m) => m.t === 'obj' && m.say).at(-1)?.say;
const cooldown = () => new Promise((r) => setTimeout(r, 450));
const ada = { id: 'p1', did: 'did:plc:ada', name: 'Ada Lovelace', kind: 'human' };
const bob = { id: 'p2', did: null, name: 'Bob', kind: 'human' };

test('the rally game: gather, race the route in order, medals, board, history', async () => {
  const game = new Rally(new MemoryStorage(), { rand: () => 0 });
  let t = 1_000_000;
  const call = (actor, action) => game.interact({ actor, action, now: t });

  let r = await call(ada, 'join');
  assert.match(r.say, /Ada wants to race/);
  assert.equal(r.wakeAt, t + GATHER_MS, 'the countdown is an alarm');
  assert.equal(r.ui.buttons.find((b) => b.action === 'start').label, 'Start now');
  r = await call(bob, 'join');
  assert.match(r.say, /2 racing/);
  assert.match((await call(bob, 'join')).toast, /You're in/);

  t += GATHER_MS;
  r = await call({ id: 'system', kind: 'system' }, 'tick');
  assert.match(r.say, /GO! Rally #1/);
  assert.equal(r.ui, undefined, 'ticks never open a panel');
  const { route } = await game.round();
  assert.equal(route.length, LEGS + 1);
  assert.equal(route.at(-1), 'lobby');
  assert.deepEqual(r.watch.sort(), [...new Set(route)].sort(), 'asks the office to watch the route');
  assert.equal(r.wakeAt, t + RACE_MS - WARN_MS);
  assert.ok(route.slice(0, LEGS).every((z) => CHECKPOINTS.some((c) => c.id === z)));
  assert.match((await call({ id: 'p3', name: 'Cy', kind: 'human' }, 'join')).toast, /A race is on/);

  // Out of order doesn't count; in order does.
  assert.deepEqual(await call(ada, `enter:${route[1]}`).then((x) => x.toast ?? null), null);
  t += 5000;
  r = await call(ada, `enter:${route[0]}`);
  assert.match(r.toast, /1\/4/);
  for (const z of route.slice(1, -1)) { t += 5000; await call(ada, `enter:${z}`); }
  t += 5000;
  r = await call(ada, 'enter:lobby');
  assert.match(r.say, /Ada finished the rally 1st in 0:20.0/);
  assert.equal(r.give[0].kind, 'rally:gold');
  assert.equal(r.watch, undefined, 'Bob is still racing');

  // Bob gives up: everyone's done, the round ends and stops watching.
  r = await call(bob, 'leave');
  assert.match(r.say, /Bob gave up[\s\S]*Rally #1 is over. 🥇 Ada 0:20.0/);
  assert.deepEqual(r.watch, []);
  assert.equal(r.wakeAt, null);
  assert.equal((await game.round()).phase, 'idle');

  const board = (await call(bob, 'board')).ui;
  assert.equal(board.list.rows.length, 1, 'only finishers have a time');
  assert.match(board.list.rows[0], /Ada Lovelace: 0:20.0 · 1 win, 1 race/);
  const stats = await game.leaderboard();
  assert.equal(stats.find((s) => s.key === 'name:bob').races, 1);
  assert.match((await call(bob, 'use')).ui.list.title, /Last race \(#1\)/);
});

test('the rally warns at a minute left, then calls time', async () => {
  const game = new Rally(new MemoryStorage());
  let t = 0;
  await game.interact({ actor: ada, action: 'join', now: t });
  await game.interact({ actor: ada, action: 'start', now: t });
  t = RACE_MS - WARN_MS;
  let r = await game.interact({ actor: { id: 'system', kind: 'system' }, action: 'tick', now: t });
  assert.match(r.say, /One minute left/);
  assert.equal(r.wakeAt, RACE_MS);
  r = await game.interact({ actor: { id: 'system', kind: 'system' }, action: 'tick', now: RACE_MS });
  assert.match(r.say, /Nobody made it back in time/);
  assert.deepEqual(r.watch, []);
  assert.equal(clock(83_400), '1:23.4');
});

test('the built-in copy keeps the rally in state, and the answer survives sanitize', async () => {
  let state = null;
  const play = async (actor, action) => { const r = await rally({ actor, action, state, now: 5 }); state = r.state; return r; };
  await play(ada, 'join');
  assert.ok(state.kv.round && state.kv['racer:p1']);
  const r = sanitize(await play(ada, 'start'));
  assert.ok(r.watch.includes('lobby'));
});

test('in the office: the flag watches the route, walking it wins a medal', async () => {
  const rnd = Math.random; Math.random = () => 0;
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: new PluginHost() } });
  try {
    const o = new Office({}, { runtime: rt });
    await o.ready;
    const a = await join(o, 'ada');
    const b = await join(o, 'bea');
    for (const c of [a, b]) await at(c, flag().x, flag().y);
    a.ws.msg({ t: 'use', id: 'rally', action: 'join' }); await settle();
    assert.match(said(a), /ada wants to race/);
    b.ws.msg({ t: 'use', id: 'rally', action: 'join' }); await settle();
    await cooldown();
    a.ws.msg({ t: 'use', id: 'rally', action: 'start' }); await settle();
    assert.match(said(b), /GO!/);
    const entity = (await rt.ref('plugin:rally').inspect()).state;
    const route = entity.data.kv.round.route;
    assert.deepEqual([...entity.watch].sort(), [...new Set(route)].sort());
    assert.equal(await rt.ref('topic:zone:lobby').view(), 1, 'subscribed to the lobby');

    for (const z of route) {
      await at(a, inZone(z).x, inZone(z).y);
      if (z !== 'lobby') assert.match(a.ws.last('objui').toast, /✓/);
      assert.ok(!('ui' in a.ws.last('objui')), 'a checkpoint only toasts');
    }
    assert.match(said(a), /ada finished the rally 1st/);
    const medal = a.items().find((s) => s.kind === 'rally:gold');
    assert.equal(medal.from, 'Office Rally');
    assert.ok(!b.items().some((s) => s.kind.startsWith('rally:')), 'only the finisher gets one');

    // Time runs out for bea: the alarm ends it and the flag stops watching.
    await rt.host('plugin:rally').alarm(); // the one-minute warning
    await rt.host('plugin:rally').alarm(); // ...not yet time: nothing happens
    const kv = (await rt.ref('plugin:rally').inspect()).state.data.kv;
    kv.round.endsAt = 0; // time's up
    rt.data['plugin:rally'].state.data.kv = kv;
    rt.hosts.delete('plugin:rally');
    await rt.host('plugin:rally').alarm();
    await settle();
    assert.match(said(a), /Rally #1 is over. 🥇 ada/);
    assert.deepEqual((await rt.ref('plugin:rally').inspect()).state.watch, []);
    assert.equal(await rt.ref('topic:zone:lobby').view(), 0, 'unsubscribed');
  } finally { Math.random = rnd; rt.stop(); }
});

test('over a binding the rally keeps its state in the plugin, and uploads can\'t watch', async () => {
  const store = new MemoryStorage(); // stands in for the RallyRoom Durable Object
  const env = { PLUGIN_RALLY: { interact: (req) => new Rally(store).interact(req) } };
  const host = new PluginHost({ env });
  const object = { id: 'rally', plugin: 'rally', name: 'Office Rally', zone: 'lobby' };
  const r = await host.interact({ object, actor: ada, action: 'join', state: null });
  assert.equal(r.via, 'binding');
  assert.equal(r.state, null, 'the office keeps nothing');
  assert.equal((await store.get('round')).racers[0], 'p1');
  assert.deepEqual(sanitize({ watch: ['lobby', 'lobby', 'nowhere', 'kitchen'] }).watch, ['lobby', 'kitchen']);
});

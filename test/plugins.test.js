import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost, sanitize, cleanRequest, bindingName } from '../server/plugins.js';
import { jukebox, vending, eightball, kiosk, TRACKS } from '../plugins/objects/src/objects.js';
import { PLUGIN_OBJECTS } from '../public/js/map.js';

const actor = { id: 'p1', did: 'did:plc:ada', handle: 'ada.test', name: 'Ada Lovelace', kind: 'human' };
const juke = { id: 'jukebox', plugin: 'jukebox', name: 'Jukebox', zone: 'lounge' };

test('every plugin object on the map has a built-in fallback', () => {
  assert.ok(PLUGIN_OBJECTS.length >= 4);
  const host = new PluginHost();
  for (const f of PLUGIN_OBJECTS) assert.equal(host.status([f.plugin])[f.plugin].via, 'builtin', f.id);
});

test('binding names', () => {
  assert.equal(bindingName('jukebox'), 'PLUGIN_JUKEBOX');
  assert.equal(bindingName('help-kiosk'), 'PLUGIN_HELP_KIOSK');
});

test('a bound plugin is called over its binding and its state comes back', async () => {
  const calls = [];
  const env = { PLUGIN_JUKEBOX: { interact: async (req) => { calls.push(req); return { state: { n: (req.state?.n || 0) + 1 }, say: 'hi' }; } } };
  const host = new PluginHost({ env });
  const r1 = await host.interact({ object: juke, actor, action: 'use' });
  assert.equal(r1.via, 'binding');
  assert.deepEqual(r1.state, { n: 1 });
  const r2 = await host.interact({ object: juke, actor, action: 'use', state: r1.state });
  assert.deepEqual(r2.state, { n: 2 });
  assert.equal(calls[0].actor.did, 'did:plc:ada');
  assert.equal(calls[0].object.kind, 'jukebox');
});

test('a missing or failing binding falls back to the built-in', async () => {
  const env = { PLUGIN_JUKEBOX: { interact: async () => { throw new Error('Worker not found'); } } };
  const host = new PluginHost({ env });
  const r = await host.interact({ object: juke, actor, action: `play:${TRACKS[0].id}` });
  assert.equal(r.via, 'builtin');
  assert.match(r.result.say, /Now playing/);
  assert.equal(host.status(['jukebox']).jukebox.problem.message, 'Worker not found');
});

test('a slow plugin times out into the fallback', async () => {
  const env = { PLUGIN_JUKEBOX: { interact: () => new Promise(() => {}) } };
  const host = new PluginHost({ env, timeoutMs: 20 });
  const r = await host.interact({ object: juke, actor });
  assert.equal(r.via, 'builtin');
});

test('an unknown plugin with no binding is out of order, and keeps its state', async () => {
  const host = new PluginHost();
  const r = await host.interact({ object: { id: 'x', plugin: 'teleporter', name: 'Teleporter' }, actor, state: { a: 1 } });
  assert.equal(r.via, 'offline');
  assert.deepEqual(r.state, { a: 1 });
  assert.match(r.result.toast, /Teleporter is out of order/);
});

test('oversized state is not saved', async () => {
  const env = { PLUGIN_JUKEBOX: { interact: async () => ({ state: 'x'.repeat(40000) }) } };
  const r = await new PluginHost({ env }).interact({ object: juke, actor, state: { keep: true } });
  assert.deepEqual(r.state, { keep: true });
});

test('sanitize drops what the client can\'t safely show', () => {
  const s = sanitize({
    say: 'x'.repeat(500),
    display: { label: 'on', glow: 'red; background:url(x)' },
    ui: { title: 'T', text: '<b>hi</b>', items: [{ label: 'ok', action: 'play:1' }, { label: 'bad', action: 'a b' }], buttons: [{ label: 'go' }], input: { action: 'ask', maxLength: 99999 } },
  });
  assert.equal(s.say.length, 280);
  assert.equal(s.display.glow, null);
  assert.equal(s.ui.items.length, 1);
  assert.equal(s.ui.buttons.length, 0);
  assert.equal(s.ui.input.maxLength, 500);
  assert.equal(s.ui.text, '<b>hi</b>'); // escaped by the client, never trusted as HTML
  assert.deepEqual(sanitize(null), { say: null, toast: null, display: null, ui: null, wakeAt: null, give: [], take: [] });
});

test('cleanRequest', () => {
  assert.deepEqual(cleanRequest({ action: 'buy:chips', input: 'x' }), { action: 'buy:chips', input: 'x' });
  assert.deepEqual(cleanRequest({ action: '<script>' }), { action: 'use', input: null });
});

test('jukebox plays, queues, skips and advances with time', async () => {
  let st = null, now = 1000;
  const play = async (id, who = actor) => { const r = await jukebox({ actor: who, action: `play:${id}`, state: st, now }); st = r.state; return r; };
  let r = await play('rain');
  assert.match(r.say, /Now playing “Rain on the Skylight”.*Ada/);
  r = await play('deploy');
  assert.match(r.say, /queued/);
  assert.equal(r.ui.list.rows.length, 1);
  now += 3 * 60000 + 1;
  r = await jukebox({ actor, action: 'use', state: st, now });
  assert.equal(r.state.playing.id, 'deploy');
  r = await jukebox({ actor, action: 'skip', state: r.state, now });
  assert.equal(r.state.playing, null);
  assert.equal(r.display.label, null);
});

test('vending machine runs out and restocks', async () => {
  const rnd = Math.random; Math.random = () => 0.5;
  try {
    let st = null, now = 0, r;
    for (let i = 0; i < 4; i++) { r = await vending({ actor, action: 'buy:gum', state: st, now }); st = r.state; }
    assert.equal(st.stock.gum, 0);
    r = await vending({ actor, action: 'buy:gum', state: st, now });
    assert.match(r.toast, /sold out/);
    assert.ok(r.ui.items.find((i) => i.action === 'buy:gum').disabled);
  } finally { Math.random = rnd; }
});

test('8-ball needs a question', async () => {
  let r = await eightball({ actor, action: 'use', state: null });
  assert.equal(r.ui.input.action, 'ask');
  r = await eightball({ actor, action: 'ask', input: 'Ship it?', state: r.state });
  assert.match(r.say, /Ship it\?/);
  assert.equal(r.state.asked, 1);
});

test('kiosk answers with AI when bound, canned otherwise', async () => {
  const req = { object: { zone: 'lobby' }, actor, action: 'ask', input: 'where is the coffee?', state: null, nearby: [] };
  let r = await kiosk(req, {});
  assert.match(r.say, /Kitchen/);
  r = await kiosk(req, { AI: { run: async () => ({ response: 'In the kitchen, friend.' }) } });
  assert.match(r.say, /friend/);
  r = await kiosk(req, { AI: { run: async () => { throw new Error('no AI'); } } });
  assert.match(r.say, /Kitchen/);
});

// ---- in the office ------------------------------------------------------------------
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
  said() { return this.sent.filter((m) => m.t === 'obj' && m.say).at(-1)?.say; }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function join(o, name) {
  const ws = new FakeWs();
  o.connect(ws);
  ws.msg({ t: 'hello', name });
  await settle();
  return ws;
}
const jukeboxSpot = () => { const f = PLUGIN_OBJECTS.find((x) => x.id === 'jukebox'); return { x: f.x + 0.5, y: f.y + 1.5 }; };

test('using an object in the office: panel to the user, speech and display to everyone', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  const s = jukeboxSpot();
  a.msg({ t: 'move', ...s, dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox', action: 'use' });
  await settle();
  assert.equal(a.last('objui').ui.title, '🎵 Jukebox');
  assert.equal(a.last('objui').via, 'builtin');
  a.msg({ t: 'use', id: 'jukebox', action: 'play:rain' });
  await new Promise((r) => setTimeout(r, 450)); // past the button-mash cooldown
  a.msg({ t: 'use', id: 'jukebox', action: 'play:rain' });
  await settle();
  assert.match(b.said(), /Now playing|queued/);
  assert.match(b.sent.find((m) => m.t === 'obj' && m.display?.label)?.display.label, /Rain on the Skylight/);
  const c = await join(o, 'linus');
  assert.match(c.last('welcome').objects.jukebox.label, /Rain/);
  assert.equal(o.summary().objects.jukebox, 'builtin');
});

test('objects only work up close', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'use', id: 'jukebox' });
  await settle();
  assert.match(a.last('objui').toast, /Walk up/);
});

test('a runtime-provided plugin host (the service binding) is used over the built-in', async () => {
  const env = { PLUGIN_JUKEBOX: { interact: async (req) => ({ say: `remote ${req.actor.name}`, state: { remote: true } }) } };
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: new PluginHost({ env }) } });
  const o = new Office({}, { runtime: rt });
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'move', ...jukeboxSpot(), dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox' });
  await settle();
  assert.equal(a.said(), 'remote ada');
  assert.equal(a.last('objui').via, 'binding');
  assert.deepEqual((await rt.ref('plugin:jukebox').inspect()).state.data, { remote: true });
  rt.stop();
});

test('kiosk skips a retired model, reads both answer shapes, and says why it is offline', async () => {
  const req = { object: { zone: 'lobby' }, actor, action: 'ask', input: 'what is this place?', state: null, nearby: [] };
  const tried = [];
  const AI = { run: async (model) => { tried.push(model); if (tried.length === 1) throw new Error('model deprecated'); return { choices: [{ message: { content: 'An office, friend.' } }] }; } };
  let r = await kiosk(req, { AI });
  assert.equal(r.say, '🤖 An office, friend.');
  assert.equal(tried.length, 2);
  r = await kiosk(req, { AI: { run: async () => { throw new Error('No such model'); } } });
  assert.match(r.ui.text, /offline: Workers AI failed: .*No such model/);
  assert.doesNotMatch(r.say, /No such model/);
  r = await kiosk(req, {});
  assert.match(r.ui.text, /offline: no Workers AI binding/);
  r = await kiosk(req, { KIOSK_MODEL: '@cf/x/y', AI: { run: async (m) => ({ response: m }) } });
  assert.equal(r.say, '🤖 @cf/x/y');
});

// ---- jukebox music ----------------------------------------------------------------
import { TUNES, bar } from '../public/js/music.js';

test('every jukebox track has a tune, and a tune plays the same everywhere', () => {
  for (const t of TRACKS) assert.ok(TUNES[t.id], t.id);
  for (const id of Object.keys(TUNES)) {
    assert.deepEqual(bar(TUNES[id], 5), bar(TUNES[id], 5));
    assert.ok(bar(TUNES[id], 0).some((n) => n.voice === 'bass'));
  }
});

test('jukebox: the display carries the music and asks to be woken when the song ends', async () => {
  let r = await jukebox({ actor, action: 'play:rain', state: null, now: 1000 });
  assert.deepEqual(r.display.music, { id: 'rain', at: 1000 });
  assert.equal(r.wakeAt, 1000 + 3 * 60000);
  r = await jukebox({ actor, action: 'play:coffee', state: r.state, now: 2000 });
  r = await jukebox({ actor: { id: 'system', name: 'the office' }, action: 'tick', state: r.state, now: 1000 + 3 * 60000 });
  assert.match(r.say, /Now playing “Second Espresso”/);
  assert.equal(r.display.music.id, 'coffee');
  r = await jukebox({ actor, action: 'tick', state: r.state, now: 1000 + 6 * 60000 });
  assert.equal(r.display.music, undefined);
  assert.equal(r.wakeAt, null);
  assert.equal(sanitize({ display: { music: { id: '../x', at: 1 } } }).display.music, null);
});

test('the jukebox moves on by itself: the entity alarm calls the plugin with tick', async () => {
  let clock = 1_000_000;
  const rt = new LocalRuntime({ kinds: KINDS, now: () => clock });
  const o = new Office({}, { runtime: rt, now: () => clock });
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'move', ...jukeboxSpot(), dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox', action: 'play:coffee' });
  await settle();
  clock += 500;
  a.msg({ t: 'use', id: 'jukebox', action: 'play:rain' });
  await settle();
  assert.equal((await rt.ref('plugin:jukebox').inspect()).state.wakeAt, 1_000_000 + 2 * 60000);
  clock += 2 * 60000;
  await rt.host('plugin:jukebox').alarm();
  await settle();
  assert.match(a.said(), /Now playing “Rain on the Skylight”/);
  assert.equal(a.sent.filter((m) => m.t === 'obj' && m.display?.music).at(-1).display.music.id, 'rain');
  rt.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost, sanitize, cleanRequest, workersAi } from '../server/plugins.js';
import { checkUpload } from '../server/sandbox.js';
import { PLUGIN_OBJECTS } from '../public/js/map.js';
import { WS_APPS } from '../public/js/apps.js';
import { wasmPlugins, wasmFile, fakePlugins, until } from './support/plugins.js';

const actor = { id: 'p1', did: 'did:plc:ada', handle: 'ada.test', name: 'Ada Lovelace', kind: 'human' };
const juke = { id: 'jukebox', plugin: 'jukebox', name: 'Jukebox', zone: 'lounge', wasm: 'jukebox.wasm' };
const obj = (id) => { const f = PLUGIN_OBJECTS.find((x) => x.id === id); return { id: f.id, plugin: f.plugin, name: f.name, zone: 'lounge', wasm: f.wasm }; };

test('every plugin object on the map and every workstation app is a WASM module that passes the upload checks', async () => {
  assert.ok(PLUGIN_OBJECTS.length >= 5);
  for (const f of [...PLUGIN_OBJECTS, ...WS_APPS]) {
    assert.match(f.wasm || '', /^[\w-]+\.wasm$/, `${f.id} names its module`);
    const info = checkUpload('wasm', new Uint8Array(await wasmFile(f.wasm)));
    assert.ok(info.manifest?.name, `${f.wasm} has a manifest`);
  }
});

test('the host runs the object\'s module with a seed, and its state comes back', async () => {
  const calls = [];
  const host = fakePlugins((req) => { calls.push(req); return { state: { n: (req.state?.n || 0) + 1 }, say: 'hi' }; });
  const r1 = await host.interact({ object: juke, actor, action: 'use' });
  assert.equal(r1.via, 'fake');
  assert.deepEqual(r1.state, { n: 1 });
  const r2 = await host.interact({ object: juke, actor, action: 'use', state: r1.state });
  assert.deepEqual(r2.state, { n: 2 });
  assert.equal(calls[0].actor.did, 'did:plc:ada');
  assert.equal(calls[0].object.kind, 'jukebox');
  assert.ok(Number.isSafeInteger(calls[0].seed) && calls[0].seed !== calls[1].seed, 'a fresh random seed per call');
});

test('no sandbox, or a failing or slow one: out of order, state kept', async () => {
  let r = await new PluginHost().interact({ object: juke, actor, state: { a: 1 } });
  assert.equal(r.via, 'offline');
  assert.deepEqual(r.state, { a: 1 });
  assert.match(r.result.toast, /Jukebox is out of order/);
  r = await fakePlugins(() => { throw new Error('boom'); }).interact({ object: juke, actor });
  assert.match(r.result.toast, /\(boom\)/);
  r = await fakePlugins(() => new Promise(() => {}), { timeoutMs: 20 }).interact({ object: juke, actor });
  assert.equal(r.via, 'offline');
  r = await fakePlugins(() => ({})).interact({ object: { ...juke, wasm: null }, actor });
  assert.match(r.result.toast, /no plugin/);
});

test('oversized state is not saved', async () => {
  const r = await fakePlugins(() => ({ state: 'x'.repeat(40000) })).interact({ object: juke, actor, state: { keep: true } });
  assert.deepEqual(r.state, { keep: true });
});

test('ask: the office runs the model and calls back with the reply, keeping the first state', async () => {
  const calls = [], asked = [];
  const fn = (req) => {
    calls.push(req);
    if (!req.reply) return { state: { q: 1 }, ask: { prompt: 'where?', system: 'be brief', maxTokens: 9999 }, say: 'ignored' };
    return { say: req.reply.text || `offline: ${req.reply.error}` };
  };
  const ai = async (q) => { asked.push(q); return { text: 'kitchen', model: 'm1' }; };
  const r = await fakePlugins(fn, { ai }).interact({ object: juke, actor, action: 'ask', input: 'where?' });
  assert.equal(r.result.say, 'kitchen');
  assert.deepEqual(r.state, { q: 1 }, 'the second answer left state out: the first one\'s is kept');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'ask');
  assert.equal(calls[1].input, 'where?');
  assert.deepEqual(calls[1].state, { q: 1 });
  assert.deepEqual(calls[1].reply, { text: 'kitchen', model: 'm1' });
  assert.deepEqual(asked, [{ prompt: 'where?', system: 'be brief', maxTokens: 400 }]);

  // No model, a failing one, or an upload asking: an error reply, not a crash.
  assert.equal((await fakePlugins(fn).interact({ object: juke, actor })).result.say, 'offline: this office has no model');
  const broken = fakePlugins(fn, { ai: async () => { throw new Error('quota'); } });
  assert.equal((await broken.interact({ object: juke, actor })).result.say, 'offline: quota');
  const upload = { id: 'u-1', plugin: 'upload', name: 'Up', upload: { id: 'u-1', version: 'v', lang: 'wasm', code: '' } };
  assert.match((await fakePlugins(fn, { ai }).interact({ object: upload, actor })).result.say, /only the office's own objects/);
  assert.equal(asked.length, 1, 'uploads never reach the model');
});

test('workersAi tries the models in turn and reads both answer shapes', async () => {
  const tried = [];
  const ai = { run: async (m, input) => { tried.push(m); if (tried.length === 1) throw new Error('retired'); return { choices: [{ message: { content: ` hi (${input.messages.length}) ` } }] }; } };
  const r = await workersAi(ai, { model: '@cf/x/first' })({ system: 's', prompt: 'p' });
  assert.deepEqual(r, { text: 'hi (2)', model: tried[1] });
  assert.equal(tried[0], '@cf/x/first');
  await assert.rejects(workersAi({ run: async () => ({ response: '' }) })({ prompt: 'p' }), /empty answer/);
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
  assert.deepEqual(sanitize(null), { say: null, toast: null, display: null, ui: null, wakeAt: null, watch: null, give: [], take: [] });
});

test('cleanRequest', () => {
  assert.deepEqual(cleanRequest({ action: 'buy:chips', input: 'x' }), { action: 'buy:chips', input: 'x' });
  assert.deepEqual(cleanRequest({ action: '<script>' }), { action: 'use', input: null });
});

// ---- the real modules (their game rules are tested in Rust: just plugin-test) ----

test('the WASM objects answer in the sandbox: jukebox, vending, 8-ball, kiosk', async () => {
  const host = wasmPlugins({ ai: async ({ system, prompt }) => ({ text: `Kitchen! (${/help kiosk/.test(system)}, ${prompt})`, model: 'fake' }) });
  let r = await host.interact({ object: obj('jukebox'), actor, action: 'play:rain' });
  assert.equal(r.via, 'worker-thread');
  assert.match(r.result.say, /Now playing “Rain on the Skylight”.*Ada/);
  assert.equal(r.result.display.music.id, 'rain');
  assert.ok(r.result.wakeAt > Date.now());
  r = await host.interact({ object: obj('jukebox'), actor, action: 'play:deploy', state: r.state });
  assert.deepEqual(r.result.ui.list.rows, ['Friday Deploy (Ada)']);

  r = await host.interact({ object: obj('vending'), actor, action: 'use' });
  assert.equal(r.result.ui.items.length, 5);
  assert.equal(r.state.stock.cookie, 4);

  r = await host.interact({ object: obj('eightball'), actor, action: 'ask', input: 'Ship it?' });
  assert.match(r.result.say, /^🎱 Ada asked “Ship it\?” … /);

  r = await host.interact({ object: obj('kiosk'), actor, action: 'ask', input: 'coffee?' });
  assert.equal(r.result.say, '🤖 Kitchen! (true, coffee?)');
  assert.deepEqual(r.state, { questions: 1 });
  r = await wasmPlugins().interact({ object: obj('kiosk'), actor, action: 'ask', input: 'where is the coffee?' });
  assert.match(r.result.say, /coffee machine is in the Kitchen/);
  assert.match(r.result.ui.text, /offline: this office has no model/);
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
  const o = new Office({}, { plugins: wasmPlugins() });
  await o.ready;
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  const s = jukeboxSpot();
  a.msg({ t: 'move', ...s, dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox', action: 'use' });
  const panel = await until(() => a.last('objui'));
  assert.equal(panel.ui.title, '🎵 Jukebox');
  assert.equal(panel.via, 'worker-thread');
  await new Promise((r) => setTimeout(r, 450)); // past the button-mash cooldown
  a.msg({ t: 'use', id: 'jukebox', action: 'play:rain' });
  assert.match(await until(() => b.said()), /Now playing/);
  const shown = await until(() => b.sent.find((m) => m.t === 'obj' && m.display?.label));
  assert.match(shown.display.label, /Rain on the Skylight/);
  const c = await join(o, 'linus');
  assert.match(c.last('welcome').objects.jukebox.label, /Rain/);
  assert.equal(o.summary().objects.jukebox, 'worker-thread');
  o.runtime.stop();
});

test('without a sandbox the objects are out of order', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'move', ...jukeboxSpot(), dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox' });
  assert.match((await until(() => a.last('objui'))).toast, /out of order/);
  o.runtime.stop();
});

test('objects only work up close', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'use', id: 'jukebox' });
  await settle();
  assert.match(a.last('objui').toast, /Walk up/);
  o.runtime.stop();
});

test('a runtime-provided plugin host is the one used', async () => {
  const host = fakePlugins((req) => ({ say: `remote ${req.actor.name}`, state: { remote: true } }));
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: host } });
  const o = new Office({}, { runtime: rt });
  await o.ready;
  const a = await join(o, 'ada');
  a.msg({ t: 'move', ...jukeboxSpot(), dir: 0, moving: false, teleport: true });
  await settle();
  a.msg({ t: 'use', id: 'jukebox' });
  await settle();
  assert.equal(a.said(), 'remote ada');
  assert.equal(a.last('objui').via, 'fake');
  assert.deepEqual((await rt.ref('plugin:jukebox').inspect()).state.data, { remote: true });
  rt.stop();
});

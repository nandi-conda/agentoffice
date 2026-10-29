// The Office Rally flag: a WASM plugin (plugins/wasm-rally, built into
// public/plugins/rally.wasm) the office runs in the uploads sandbox. Its game
// rules are tested in Rust (`just plugin-test rally`); this is the office's
// side: the bundled module runs, `watch` subscribes the object to the route's
// zones, walking in calls it back, medals land in the inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { PluginHost, sanitize } from '../server/plugins.js';
import { NodeSandbox } from '../server/sandbox-node.js';
import { bundledWasm, checkUpload } from '../server/sandbox.js';
import { FURNITURE, ZONES, PLUGIN_OBJECTS, isBlocked, zoneAt } from '../public/js/map.js';

const wasmFile = (f) => readFile(new URL(`../public/plugins/${f}`, import.meta.url));

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
// WASM calls go through a worker thread, so wait on what we expect.
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
}
async function join(o, name) {
  const ws = new FakeWs();
  o.connect(ws);
  ws.msg({ t: 'hello', name });
  await until(() => ws.last('welcome'));
  return { ws, id: ws.last('welcome').you.id, items: () => ws.last('inv')?.items ?? ws.last('welcome').items };
}
const at = (c, x, y) => c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true });
const says = (c) => c.ws.sent.filter((m) => m.t === 'obj' && m.say).map((m) => m.say);
const flag = () => { const f = FURNITURE.find((x) => x.id === 'rally'); return { x: f.x + 0.5, y: f.y + 1.5 }; };
function inZone(id) {
  const z = ZONES.find((q) => q.id === id);
  const cx = Math.floor((z.x0 + z.x1) / 2), cy = Math.floor((z.y0 + z.y1) / 2);
  for (let r = 0; r < 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (!isBlocked(cx + dx, cy + dy) && zoneAt(cx + dx + 0.5, cy + dy + 0.5)?.id === id) return { x: cx + dx + 0.5, y: cy + dy + 0.5 };
  }
  throw new Error(`no free tile in ${id}`);
}

test('the rally ships as a WASM module that passes the upload checks', async () => {
  const f = PLUGIN_OBJECTS.find((x) => x.id === 'rally');
  assert.equal(f.wasm, 'rally.wasm');
  const info = checkUpload('wasm', new Uint8Array(await wasmFile(f.wasm)));
  assert.equal(info.manifest.name, 'Office Rally');
  assert.ok(info.manifest.api.join && info.manifest.api.start);
  const load = bundledWasm(wasmFile);
  const a = await load('rally.wasm');
  assert.equal(a, await load('rally.wasm'), 'read once');
  assert.match(a.version, /^[0-9a-f]{12}$/);
  await assert.rejects(load('../secrets.wasm'), /bad wasm file/);
});

test('without a sandbox the rally is out of order, not a crash', async () => {
  const host = new PluginHost();
  const r = await host.interact({ object: { id: 'rally', plugin: 'rally', name: 'Office Rally', wasm: 'rally.wasm' }, actor: { id: 'p1', name: 'Ada', kind: 'human' } });
  assert.equal(r.via, 'offline');
});

test('in the office: the flag watches the route, walking it wins a medal', async () => {
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: new PluginHost({ sandbox: new NodeSandbox({ timeoutMs: 4000 }), wasm: bundledWasm(wasmFile) }) } });
  try {
    const o = new Office({}, { runtime: rt });
    await o.ready;
    const a = await join(o, 'ada');
    const b = await join(o, 'bea');
    for (const c of [a, b]) at(c, flag().x, flag().y);
    await new Promise((r) => setTimeout(r, 50));
    a.ws.msg({ t: 'use', id: 'rally', action: 'join' });
    await until(() => says(a).some((s) => /ada wants to race/.test(s)));
    assert.equal(a.ws.last('objui').via, 'worker-thread', 'it ran the WASM');
    b.ws.msg({ t: 'use', id: 'rally', action: 'join' });
    await until(() => says(a).some((s) => /bea joined/.test(s)));
    await new Promise((r) => setTimeout(r, 450)); // the button-mashing cooldown
    a.ws.msg({ t: 'use', id: 'rally', action: 'start' });
    const go = await until(() => says(b).find((s) => /GO!/.test(s)));

    const entity = (await rt.ref('plugin:rally').inspect()).state;
    const route = entity.data.route;
    assert.equal(route.length, 4);
    assert.equal(route.at(-1), 'lobby');
    assert.deepEqual([...entity.watch].sort(), [...new Set(route)].sort());
    assert.equal(await rt.ref('topic:zone:lobby').view(), 1, 'the flag subscribed to the lobby');
    assert.match(go, /Racing: ada, bea/);

    for (const [i, z] of route.entries()) {
      const n = a.ws.sent.length;
      at(a, inZone(z).x, inZone(z).y);
      if (z === 'lobby') break;
      const m = await until(() => a.ws.sent.slice(n).find((x) => x.t === 'objui' && x.toast));
      assert.match(m.toast, new RegExp(`\\(${i + 1}/4\\)`));
      assert.ok(!('ui' in m), 'a checkpoint only toasts');
    }
    await until(() => says(a).some((s) => /ada finished the rally 1st/.test(s)));
    const medal = await until(() => a.items().find((s) => s.kind === 'rally:gold'));
    assert.equal(medal.from, 'Office Rally');
    assert.ok(!b.items().some((s) => s.kind.startsWith('rally:')), 'only the finisher gets one');

    // bea gives up: the race is over and the flag stops watching.
    await new Promise((r) => setTimeout(r, 450));
    b.ws.msg({ t: 'use', id: 'rally', action: 'leave' });
    await until(() => says(a).some((s) => /Rally #1 is over. 🥇 ada/.test(s)));
    assert.deepEqual((await rt.ref('plugin:rally').inspect()).state.watch, []);
    assert.equal(await rt.ref('topic:zone:lobby').view(), 0, 'unsubscribed');
  } finally { rt.stop(); }
});

test('watch is cleaned: known zones only, no repeats, at most 12', () => {
  assert.deepEqual(sanitize({ watch: ['lobby', 'lobby', 'nowhere', 'kitchen'] }).watch, ['lobby', 'kitchen']);
  assert.equal(sanitize({}).watch, null);
});

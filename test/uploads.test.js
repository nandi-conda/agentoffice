import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { PluginHost } from '../server/plugins.js';
import { NodeSandbox } from '../server/sandbox-node.js';
import { checkUpload, inspectWasm, toBase64, DynamicSandbox, WRAPPERS, runWasm } from '../server/sandbox.js';
import { placeNear, MAX_PER_OWNER } from '../server/entities/gallery.js';

const GUESTBOOK = new Uint8Array(readFileSync(new URL('../public/plugins/guestbook.wasm', import.meta.url)));
const b64 = toBase64(GUESTBOOK);

// A tiny module in raw bytes: exports memory, alloc, interact, and imports what we say.
function wasm({ imports = [], exports = ['memory', 'alloc', 'interact'] } = {}) {
  const name = (s) => [s.length, ...new TextEncoder().encode(s)];
  const section = (id, body) => [id, body.length, ...body];
  const out = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  if (imports.length) out.push(...section(2, [imports.length, ...imports.flatMap(([m, n]) => [...name(m), ...name(n), 0, 0])]));
  out.push(...section(5, [1, 0, 1]));
  const kinds = { memory: 2, alloc: 0, interact: 0 };
  out.push(...section(7, [exports.length, ...exports.flatMap((e) => [...name(e), kinds[e] ?? 0, 0])]));
  return new Uint8Array(out);
}

test('checkUpload reads exports and imports without compiling', () => {
  assert.deepEqual(checkUpload('wasm', GUESTBOOK).exports.sort(), ['alloc', 'interact', 'memory']);
  assert.ok(inspectWasm(wasm()).memory);
  assert.throws(() => checkUpload('wasm', new TextEncoder().encode('hello')), /not a WebAssembly file/);
  assert.throws(() => checkUpload('wasm', wasm({ exports: ['memory'] })), /must export alloc, interact/);
  assert.throws(() => checkUpload('wasm', wasm({ imports: [['wasi_snapshot_preview1', 'fd_write']] })), /no WASI/);
  assert.doesNotThrow(() => checkUpload('wasm', wasm({ imports: [['office', 'log']] })));
  assert.throws(() => checkUpload('js', new TextEncoder().encode('export const x = 1')), /interact/);
  assert.equal(checkUpload('js', new TextEncoder().encode('export function interact(r) { return {} }')).size, 41);
});

test('runWasm speaks the JSON ABI (the guestbook example)', async () => {
  const r = await runWasm(GUESTBOOK, { object: { id: 'u-x' }, actor: { name: 'Ada' }, action: 'sign', input: 'hi there', state: null, now: 5, nearby: [] });
  assert.equal(r.state.entries[0].text, 'hi there');
  assert.match(r.say, /Ada signed/);
  assert.equal(r.ui.input.action, 'sign');
});

test('the Node sandbox runs uploads in a thread and gives up on endless loops', async () => {
  const sb = new NodeSandbox({ timeoutMs: 2000 });
  const r = await sb.run({ id: 'u-1', version: 'v', lang: 'wasm', code: b64 }, { actor: { name: 'Grace' }, action: 'use', state: null, now: 1 });
  assert.equal(r.ui.title, '📖 Guestbook');
  // (func (export "interact") (param i32 i32) (result i64) (loop br 0) unreachable)
  const loop = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 1, 127, 1, 127, 96, 2, 127, 127, 1, 126, 3, 3, 2, 0, 1, 5, 3, 1, 0, 1,
    7, 29, 3, 6, 109, 101, 109, 111, 114, 121, 2, 0, 5, 97, 108, 108, 111, 99, 0, 0, 8, 105, 110, 116, 101, 114, 97, 99, 116, 0, 1,
    10, 15, 2, 4, 0, 65, 0, 11, 8, 0, 3, 64, 12, 0, 11, 0, 11]);
  const slow = new NodeSandbox({ timeoutMs: 300 });
  await assert.rejects(slow.run({ id: 'u-2', version: 'v', lang: 'wasm', code: toBase64(loop) }, { now: 1 }), /no answer within 300 ms/);
});

test('the Dynamic Worker sandbox loads one isolate per version, cut off from the network', async () => {
  const calls = [];
  const loader = {
    get(id, cb) { calls.push({ id, code: cb() }); return { getEntrypoint: () => ({ interact: async (req) => ({ say: `ran ${req.action}` }) }) }; },
  };
  const sb = new DynamicSandbox(loader);
  const r = await sb.run({ id: 'u-1', version: 'abc', lang: 'wasm', code: b64 }, { action: 'use' });
  assert.equal(r.say, 'ran use');
  const { id, code } = calls[0];
  assert.equal(id, 'u-1@abc');
  assert.equal(code.globalOutbound, null);
  assert.deepEqual(code.env, {});
  assert.ok(code.limits.cpuMs > 0);
  assert.equal(code.modules['plugin.wasm'].wasm.byteLength, GUESTBOOK.length);
  assert.equal(code.modules['main.js'], WRAPPERS.wasm);
  assert.match(WRAPPERS.wasm, /async function runWasm/);
});

test('placing next to someone avoids walls, furniture and other uploads', () => {
  const a = placeNear(20.5, 26.5, []);
  assert.ok(a);
  const b = placeNear(20.5, 26.5, [a]);
  assert.notDeepEqual(a, b);
});

// ---- in the office ---------------------------------------------------------------

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const settle = async (ms = 0) => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); if (ms) await new Promise((r) => setTimeout(r, ms)); };
async function join(o, name, did = null) {
  const ws = new FakeWs();
  o.connect(ws, { did });
  ws.msg({ t: 'hello', name });
  await settle();
  ws.msg({ t: 'move', x: 20.5, y: 26.5, dir: 0, moving: false, teleport: true });
  await settle();
  return ws;
}
const office = (admins = []) => {
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: new PluginHost({ sandbox: new NodeSandbox() }), roles: { owners: [], admins } } });
  return { o: new Office({}, { runtime: rt }), rt };
};
const upload = { name: 'Guestbook', lang: 'wasm', code: b64, prompt: 'Sign the guestbook', emoji: '📖' };

test('a signed-in person uploads an object, everyone sees it, and anyone nearby can use it', async () => {
  const { o, rt } = office();
  await o.ready;
  const guest = await join(o, 'guest');
  guest.msg({ t: 'gallery', op: 'upload', rid: 1, req: upload });
  await settle();
  assert.match(guest.last('galleryres').result.error, /sign in/);

  const ada = await join(o, 'ada', 'did:plc:ada');
  ada.msg({ t: 'gallery', op: 'upload', rid: 2, req: upload });
  await settle(50);
  const res = ada.last('galleryres').result;
  assert.equal(res.ok, true, JSON.stringify(res));
  const item = res.object;
  assert.equal(item.owner.did, 'did:plc:ada');
  assert.equal(guest.last('gallery').items[0].id, item.id);
  assert.ok(Math.hypot(item.x + 0.5 - 20.5, item.y + 0.5 - 26.5) < 3);

  guest.msg({ t: 'use', id: item.id, action: 'sign', input: 'hello from a guest' });
  await settle(300);
  assert.equal(guest.last('objui').via, 'worker-thread');
  assert.match(ada.sent.filter((m) => m.t === 'obj' && m.say).at(-1).say, /guest signed/);
  assert.equal(guest.sent.filter((m) => m.t === 'obj' && m.display).at(-1).display.label, '1 signature');
  assert.equal(o.summary().uploads[item.id], 'worker-thread');
  const late = await join(o, 'linus');
  assert.equal(late.last('welcome').gallery.length, 1);
  assert.equal(late.last('welcome').objects[item.id].label, '1 signature');

  // Only the uploader can take it away.
  guest.msg({ t: 'gallery', op: 'remove', rid: 3, req: { id: item.id } });
  await settle();
  assert.match(guest.last('galleryres').result.error, /only/);
  ada.msg({ t: 'gallery', op: 'remove', rid: 4, req: { id: item.id } });
  await settle();
  assert.equal(ada.last('galleryres').result.ok, true);
  assert.deepEqual(guest.last('gallery').items, []);
  assert.equal(await rt.host(`uobj:${item.id}`).storage.get('code'), undefined);
  rt.stop();
});

test('uploads are checked, capped per person, and admins (moderators and up) can remove any', async () => {
  const { o, rt } = office(['did:plc:mod']);
  await o.ready;
  const ada = await join(o, 'ada', 'did:plc:ada');
  ada.msg({ t: 'gallery', op: 'upload', rid: 1, req: { ...upload, code: toBase64(new TextEncoder().encode('nope')) } });
  await settle();
  assert.match(ada.last('galleryres').result.error, /not a WebAssembly file/);
  ada.msg({ t: 'gallery', op: 'upload', rid: 1, req: { ...upload, lang: 'js', code: toBase64(new TextEncoder().encode('export function interact() {}')) } });
  await settle();
  assert.match(ada.last('galleryres').result.error, /runs wasm uploads, not js/);
  for (let i = 0; i < MAX_PER_OWNER; i++) { ada.msg({ t: 'gallery', op: 'upload', rid: i, req: upload }); await settle(20); }
  ada.msg({ t: 'gallery', op: 'upload', rid: 9, req: upload });
  await settle(20);
  assert.match(ada.last('galleryres').result.error, /remove one first/);
  const mod = await join(o, 'mod', 'did:plc:mod');
  const id = mod.last('welcome').gallery[0].id;
  mod.msg({ t: 'gallery', op: 'remove', rid: 1, req: { id } });
  await settle();
  assert.equal(mod.last('galleryres').result.ok, true);
  rt.stop();
});

test('without a sandbox the office refuses uploads and says why', async () => {
  const o = new Office();
  await o.ready;
  const ada = await join(o, 'ada', 'did:plc:ada');
  ada.msg({ t: 'gallery', op: 'upload', rid: 1, req: upload });
  await settle();
  assert.match(ada.last('galleryres').result.error, /Worker Loader/);
});

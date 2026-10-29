import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { DESKS, SPAWN } from '../public/js/map.js';
import { describeApi, generatedTools } from '../server/apidoc.js';
import { wasmPlugins, wasmFile, until } from './support/plugins.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
async function join(o, name, { did, kind = 'human' } = {}) {
  const ws = new FakeWs();
  const p = o.connect(ws, { did });
  ws.msg({ t: 'hello', name, kind });
  await tick();
  return { ws, p };
}
// Stand at a desk's chair (teleporting there, as a test may), or away from it.
async function toDesk(u, id = 'desk-1') {
  const { seat } = DESKS.find((d) => d.id === id);
  u.ws.msg({ t: 'move', x: seat.x, y: seat.y, teleport: true }); await tick();
}
async function walkAway(u) { u.ws.msg({ t: 'move', x: SPAWN.x, y: SPAWN.y, teleport: true }); await tick(); }
// A workstation call over the socket, as the browser makes it.
let ref = 0;
async function ws(u, method, ...args) {
  const r = ++ref;
  u.ws.msg({ t: 'ws', ref: r, method, args });
  for (let i = 0; i < 400; i++) {
    await tick();
    const m = u.ws.sent.find((x) => x.t === 'wsr' && x.ref === r);
    if (m) { if (m.error) throw new Error(m.error); return m.result; }
  }
  throw new Error('no answer');
}

test('the desk computer needs you at a desk, and is yours at any desk', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await assert.rejects(ws(ada, 'desktop'), /walk up to a desk/);
  await toDesk(ada);
  const d = await ws(ada, 'desktop');
  assert.equal(d.owner, 'did:plc:ada');
  assert.ok(d.apps.some((a) => a.id === 'oracle'));
  const n = await ws(ada, 'noteSave', { text: 'Plan\n- ship the workstation' });
  assert.equal(n.title, 'Plan', 'the first line names it');
  await ws(ada, 'todoAdd', 'write tests');
  const t = await ws(ada, 'todoAdd', 'push to main');
  await ws(ada, 'todoSet', { id: t.id, done: true });

  // Another desk, same computer.
  await toDesk(ada, 'desk-2');
  const again = await ws(ada, 'desktop');
  assert.equal(again.notes[0].text, 'Plan\n- ship the workstation');
  assert.deepEqual(again.todos.map((x) => [x.text, x.done]), [['write tests', false], ['push to main', true]]);

  // Someone else at ada's old desk gets their own.
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  await toDesk(bob);
  const theirs = await ws(bob, 'desktop');
  assert.equal(theirs.owner, 'did:plc:bob');
  assert.equal(theirs.notes.length, 0);
  // prefs is internal for MCP but the browser keeps its layout with it.
  assert.equal(await ws(bob, 'prefs', { wallpaper: 'night' }), true);
  assert.equal((await ws(bob, 'desktop')).prefs.wallpaper, 'night');
  o.runtime.stop();
});

test('the shell runs office commands against your workstation', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await toDesk(ada);
  assert.match((await ws(ada, 'run', 'help')).out, /todo add/);
  assert.match((await ws(ada, 'run', 'who')).out, /ada/);
  assert.match((await ws(ada, 'run', 'todo add buy milk')).out, /1\. +\[ \] buy milk/);
  assert.match((await ws(ada, 'run', 'todo done 1')).out, /\[x\] buy milk/);
  await ws(ada, 'run', 'jot remember the standup');
  await ws(ada, 'run', 'jot and the retro');
  assert.match((await ws(ada, 'run', 'cat 1')).out, /# Scratch\n.*remember the standup\n.*and the retro/);
  assert.deepEqual(await ws(ada, 'run', 'open notes'), { out: 'Opening notes…', open: 'notes' });
  assert.equal((await ws(ada, 'run', 'open example.com')).url, 'https://example.com/');
  assert.match((await ws(ada, 'run', 'rm -rf /')).out, /command not found/);
  assert.match((await ws(ada, 'run', 'todo done 9')).out, /no #9/);
  o.runtime.stop();
});

test('the focus timer rings through your actor, even after you left', async () => {
  let now = 1_000_000;
  const o = new Office({}, { now: () => now, plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await toDesk(ada);
  const t = await ws(ada, 'timerStart', { minutes: 25, label: 'Deep work' });
  assert.equal(t.endsAt, now + 25 * 60000);
  ada.ws.readyState = 3; o.leave(ada.p); await tick();
  now += 25 * 60000;
  await o.runtime.host('workstation:did:plc:ada').alarm();
  const back = await join(o, 'ada', { did: 'did:plc:ada' });
  assert.match(back.ws.last('toast').text, /Deep work: your 25-minute timer is up/);
  await toDesk(back);
  assert.equal((await ws(back, 'desktop')).timer, null);
  o.runtime.stop();
});

test('apps on WASM plugins answer with panels; guests get a workstation that goes with them', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  const guest = await join(o, 'visitor');
  await toDesk(guest);
  const d = await ws(guest, 'desktop');
  assert.equal(d.guest, true);
  await ws(guest, 'noteSave', { text: 'hello' });
  const r = await ws(guest, 'app', { app: 'oracle', action: 'use' });
  assert.equal(r.via, 'worker-thread');
  assert.match(r.ui.title, /8-ball/);
  await new Promise((res) => setTimeout(res, 320));
  const a = await ws(guest, 'app', { app: 'oracle', action: 'ask', input: 'Will it ship?' });
  assert.match(a.ui.text, /Will it ship/);
  await assert.rejects(ws(guest, 'app', { app: 'nope' }), /no app/);
  assert.equal((await ws(guest, 'desktop')).notes.length, 1);
  guest.ws.readyState = 3; o.leave(guest.p);
  assert.equal(guest.p.station, null, 'gone when they leave');
  o.runtime.stop();
});

test('walking away switches the computer off and ends a share to the desk monitor', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  ada.ws.msg({ t: 'av', screen: true }); await tick();
  assert.equal(ada.p.screen, false, 'no screen share out in the open');
  await toDesk(ada);
  ada.ws.msg({ t: 'ws', method: 'power', on: true });
  ada.ws.msg({ t: 'av', screen: true }); await tick();
  assert.equal(ada.p.pc, true);
  assert.equal(ada.p.screen, true, 'shared to the desk monitor');
  assert.ok(bob.ws.sent.some((m) => m.t === 'peer' && m.id === ada.p.id && m.pc === true));
  await walkAway(ada);
  assert.equal(ada.p.pc, false);
  assert.equal(ada.p.screen, false);
  assert.deepEqual(bob.ws.last('peer'), { t: 'peer', id: ada.p.id, pc: false, screen: false });
  o.runtime.stop();
});

test('workstation MCP tools are always your own: no name to pick, at a desk', () => {
  const tools = generatedTools(describeApi()).filter((t) => t.kind === 'workstation');
  const names = tools.map((t) => t.name).sort();
  assert.ok(names.includes('workstation_desktop') && names.includes('workstation_run') && names.includes('workstation_todoAdd'));
  assert.ok(!names.includes('workstation_prefs'), 'layout is the browser\'s business');
  for (const t of tools) {
    assert.ok(!('name' in t.input.properties), `${t.name} takes no entity name`);
    assert.equal(t.readOnly, false);
    assert.equal(t.address({ name: 'did:plc:someone-else' }), 'workstation:self');
    assert.match(t.description, /at a desk/);
  }
});

test('bookmarks are http(s) or office pages', async () => {
  const o = new Office({}, { plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await toDesk(ada);
  assert.equal((await ws(ada, 'linkAdd', { url: 'example.com/a' })).url, 'https://example.com/a');
  assert.equal((await ws(ada, 'linkAdd', { url: '/docs/' })).url, '/docs/');
  await assert.rejects(ws(ada, 'linkAdd', { url: 'javascript:alert(1)' }), /only http/);
  await assert.rejects(ws(ada, 'linkAdd', { url: 'data:text/html,hi' }), /only http/);
  o.runtime.stop();
});

test('the program is WASM: saved workstations load, a big one fits, and without a sandbox it is out of order', async () => {
  const saved = { notes: [{ id: 'n1', title: 'From before', text: 'x'.repeat(20000), updated: 5 }], todos: [{ id: 't1', text: 'kept', done: false, at: 1 }], links: [], prefs: { wallpaper: 'night' } };
  const o = new Office({}, { plugins: wasmPlugins() });
  o.runtime.data['workstation:did:plc:ada'] = { state: structuredClone(saved) };
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await toDesk(ada);
  const d = await ws(ada, 'desktop');
  assert.equal(d.notes[0].title, 'From before');
  assert.equal(d.todos[0].text, 'kept');
  assert.equal(d.prefs.wallpaper, 'night', 'the layout stays with the host');
  // Thirty full notes: far more than an object on the map may keep.
  for (let i = 1; i < 30; i++) await ws(ada, 'noteSave', { text: `${i}`.repeat(20000) });
  await assert.rejects(ws(ada, 'noteSave', { text: 'one more' }), /30 notes at most/);
  assert.equal((await ws(ada, 'desktop')).notes.length, 30);
  assert.match((await ws(ada, 'run', 'notes')).out, /20000 chars/);
  o.runtime.stop();

  const off = new Office({});
  const bob = await join(off, 'bob', { did: 'did:plc:bob' });
  await toDesk(bob);
  await assert.rejects(ws(bob, 'desktop'), /workstation is out of order/);
  off.runtime.stop();
});

test('an uploaded workstation stands as a computer you can use, with its own state per person', async () => {
  let now = 1_000_000;
  const o = new Office({}, { now: () => now, plugins: wasmPlugins() });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await toDesk(ada);
  await ws(ada, 'noteSave', { text: 'desk note' });
  await walkAway(ada);

  // Uploaded with no look of its own: the manifest makes it a computer.
  const code = (await wasmFile('workstation.wasm')).toString('base64');
  ada.ws.msg({ t: 'gallery', op: 'upload', rid: 1, req: { lang: 'wasm', code } });
  const res = await until(() => ada.ws.last('galleryres'));
  assert.equal(res.result.ok, true, JSON.stringify(res.result));
  const pc = res.result.object;
  assert.equal(pc.look, 'computer');

  // Next to it counts as being at a desk: it runs that upload, on a state of
  // its own, so the desk's notes stay out of it.
  const d = await ws(ada, 'desktop');
  assert.equal(d.notes.length, 0);
  await ws(ada, 'noteSave', { text: 'computer note' });
  await ws(ada, 'todoAdd', 'from the computer');
  assert.match((await ws(ada, 'run', 'notes')).out, /computer note/);
  const t = await ws(ada, 'timerStart', { minutes: 5, label: 'Short' });
  assert.equal(t.endsAt, now + 5 * 60000);
  const station = o.runtime.host('workstation:did:plc:ada');
  assert.equal(station.entity.state.computers[pc.id].notes[0].text, 'computer note');
  assert.equal(station.entity.state.notes.length, 1, 'the desk keeps its own');

  // Its timer rings like the desk's.
  now += 5 * 60000;
  await station.alarm();
  assert.match(ada.ws.last('toast').text, /Short: your 5-minute timer is up/);
  assert.equal(station.entity.state.computers[pc.id].timer, undefined);

  // Back at a desk: the desk's notes.
  await toDesk(ada);
  assert.deepEqual((await ws(ada, 'desktop')).notes.map((n) => n.text), ['desk note']);
  // Away from both: nothing.
  ada.ws.msg({ t: 'move', x: 20.5, y: 26.5, teleport: true }); await tick();
  await assert.rejects(ws(ada, 'desktop'), /walk up to a desk/);
  o.runtime.stop();
});

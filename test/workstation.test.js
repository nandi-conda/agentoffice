import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { describeApi, generatedTools } from '../server/apidoc.js';
import { cleanUrl } from '../server/entities/workstation.js';

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
// Sit on a desk chair (teleporting next to it first, as a test may).
async function sit(u, seat = 'desk-1-chair', at = { x: 17, y: 2.5 }) {
  u.ws.msg({ t: 'move', ...at, teleport: true }); await tick();
  u.ws.msg({ t: 'sit', seat }); await tick();
}
// A workstation call over the socket, as the browser makes it.
let ref = 0;
async function ws(u, method, ...args) {
  const r = ++ref;
  u.ws.msg({ t: 'ws', ref: r, method, args });
  for (let i = 0; i < 40; i++) {
    await tick();
    const m = u.ws.sent.find((x) => x.t === 'wsr' && x.ref === r);
    if (m) { if (m.error) throw new Error(m.error); return m.result; }
  }
  throw new Error('no answer');
}

test('the desk computer needs you sitting at a desk, and is yours wherever you sit', async () => {
  const o = new Office({});
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await assert.rejects(ws(ada, 'desktop'), /sit at a desk/);
  await sit(ada);
  const d = await ws(ada, 'desktop');
  assert.equal(d.owner, 'did:plc:ada');
  assert.ok(d.apps.some((a) => a.id === 'oracle'));
  const n = await ws(ada, 'noteSave', { text: 'Plan\n- ship the workstation' });
  assert.equal(n.title, 'Plan', 'the first line names it');
  await ws(ada, 'todoAdd', 'write tests');
  const t = await ws(ada, 'todoAdd', 'push to main');
  await ws(ada, 'todoSet', { id: t.id, done: true });

  // Another desk, same computer.
  ada.ws.msg({ t: 'sit', seat: null }); await tick();
  await sit(ada, 'desk-2-chair', { x: 19, y: 2.5 });
  const again = await ws(ada, 'desktop');
  assert.equal(again.notes[0].text, 'Plan\n- ship the workstation');
  assert.deepEqual(again.todos.map((x) => [x.text, x.done]), [['write tests', false], ['push to main', true]]);

  // Someone else at ada's old desk gets their own.
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  await sit(bob);
  const theirs = await ws(bob, 'desktop');
  assert.equal(theirs.owner, 'did:plc:bob');
  assert.equal(theirs.notes.length, 0);
  // prefs is internal for MCP but the browser keeps its layout with it.
  assert.equal(await ws(bob, 'prefs', { wallpaper: 'night' }), true);
  assert.equal((await ws(bob, 'desktop')).prefs.wallpaper, 'night');
  o.runtime.stop();
});

test('the shell runs office commands against your workstation', async () => {
  const o = new Office({});
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await sit(ada);
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
  const o = new Office({}, { now: () => now });
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  await sit(ada);
  const t = await ws(ada, 'timerStart', { minutes: 25, label: 'Deep work' });
  assert.equal(t.endsAt, now + 25 * 60000);
  ada.ws.readyState = 3; o.leave(ada.p); await tick();
  now += 25 * 60000;
  await o.runtime.host('workstation:did:plc:ada').alarm();
  const back = await join(o, 'ada', { did: 'did:plc:ada' });
  assert.match(back.ws.last('toast').text, /Deep work: your 25-minute timer is up/);
  await sit(back);
  assert.equal((await ws(back, 'desktop')).timer, null);
  o.runtime.stop();
});

test('apps on plugin Workers answer with panels; guests get a workstation that goes with them', async () => {
  const o = new Office({});
  const guest = await join(o, 'visitor');
  await sit(guest);
  const d = await ws(guest, 'desktop');
  assert.equal(d.guest, true);
  await ws(guest, 'noteSave', { text: 'hello' });
  const r = await ws(guest, 'app', { app: 'oracle', action: 'use' });
  assert.equal(r.via, 'builtin');
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

test('standing up switches the computer off and ends a share to the desk monitor', async () => {
  const o = new Office({});
  const ada = await join(o, 'ada', { did: 'did:plc:ada' });
  const bob = await join(o, 'bob', { did: 'did:plc:bob' });
  ada.ws.msg({ t: 'av', screen: true }); await tick();
  assert.equal(ada.p.screen, false, 'no screen share out in the open');
  await sit(ada);
  ada.ws.msg({ t: 'ws', method: 'power', on: true });
  ada.ws.msg({ t: 'av', screen: true }); await tick();
  assert.equal(ada.p.pc, true);
  assert.equal(ada.p.screen, true, 'shared to the desk monitor');
  assert.ok(bob.ws.sent.some((m) => m.t === 'peer' && m.id === ada.p.id && m.pc === true));
  ada.ws.msg({ t: 'sit', seat: null }); await tick();
  assert.equal(ada.p.pc, false);
  assert.equal(ada.p.screen, false);
  assert.deepEqual(bob.ws.last('peer'), { t: 'peer', id: ada.p.id, seat: null, pc: false, screen: false });
  o.runtime.stop();
});

test('workstation MCP tools are always your own: no name to pick, sitting at a desk', () => {
  const tools = generatedTools(describeApi()).filter((t) => t.kind === 'workstation');
  const names = tools.map((t) => t.name).sort();
  assert.ok(names.includes('workstation_desktop') && names.includes('workstation_run') && names.includes('workstation_todoAdd'));
  assert.ok(!names.includes('workstation_prefs'), 'layout is the browser\'s business');
  for (const t of tools) {
    assert.ok(!('name' in t.input.properties), `${t.name} takes no entity name`);
    assert.equal(t.readOnly, false);
    assert.equal(t.address({ name: 'did:plc:someone-else' }), 'workstation:self');
    assert.match(t.description, /sitting at a desk/);
  }
});

test('bookmarks are http(s) or office pages', () => {
  assert.equal(cleanUrl('example.com/a'), 'https://example.com/a');
  assert.equal(cleanUrl('/docs/'), '/docs/');
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('data:text/html,hi'), null);
});

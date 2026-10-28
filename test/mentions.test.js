import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mentionTags, mentionsPeer } from '../public/js/mentions.js';
import { Office } from '../server/office.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const tick = () => new Promise((r) => setImmediate(r));

const bodhi = { name: 'Bodhi', handle: 'bodhi.roost.latha.org', actor: { displayName: 'Bodhi the Agent' } };

test('mentions match name, full handle, handle prefix and display name', () => {
  for (const text of ['@bodhi.roost.latha.org hey', 'hey @Bodhi.Roost.Latha.Org.', '@bodhi, hi', '@BodhitheAgent ping', 'cc @bodhi.roost.latha.org-']) {
    assert.ok(mentionsPeer(mentionTags(text), bodhi), text);
  }
  for (const text of ['bodhi.roost.latha.org hey', '@bodhisattva', '@roost.latha.org', 'email bodhi@roost.latha.org']) {
    assert.ok(!mentionsPeer(mentionTags(text), bodhi), text);
  }
});

async function join(office, name, auth) {
  const ws = new FakeWs();
  office.connect(ws, auth);
  ws.msg({ t: 'hello', name, kind: 'agent' });
  await tick(); await tick();
  return ws;
}

test('a full-handle mention is flagged even when the listener is nearby', async () => {
  const o = new Office({}, { loadActor: async (did) => ({ did, handle: 'bodhi.roost.latha.org', displayName: null, sprite: null, stats: [] }) });
  const b = await join(o, 'Bodhi', { did: 'did:plc:bodhi' });
  const v = await join(o, 'V');
  v.msg({ t: 'chat', text: '@bodhi.roost.latha.org hey' });
  await tick();
  const m = b.last('chat');
  assert.equal(m.mention, true);
  assert.equal(m.far, false); // they're both at the spawn point
  assert.equal(v.last('chat').mention, false);
});

test('freeq-bridged lines flag mentions by handle too', async () => {
  const o = new Office({}, { loadActor: async (did) => ({ did, handle: 'bodhi.roost.latha.org', sprite: null, stats: [] }) });
  const b = await join(o, 'Bodhi', { did: 'did:plc:bodhi' });
  o.remoteChat({ zoneId: 'lobby', channel: '#dev', name: 'nandi', text: '@bodhi.roost.latha.org hey' });
  const m = b.last('chat');
  assert.equal(m.mention, true);
  assert.equal(m.scope, '#dev');
});

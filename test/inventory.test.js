import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Office } from '../server/office.js';
import { LocalRuntime } from '../server/entities/runtime.js';
import { KINDS } from '../server/entities/kinds.js';
import { PluginHost, sanitize } from '../server/plugins.js';
import { FURNITURE } from '../public/js/map.js';
import { cleanItem, addItems, takeItems, applyChange, useLine, GUEST_SLOTS, MAX_QTY } from '../public/js/items.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  msg(m) { this.emit('message', JSON.stringify(m)); }
  last(t) { return this.sent.filter((m) => m.t === t).at(-1); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
async function join(o, name, extra = {}) {
  const ws = new FakeWs();
  o.connect(ws);
  ws.msg({ t: 'hello', name, ...extra });
  await settle();
  return { ws, id: ws.last('welcome').you.id, items: () => ws.last('inv')?.items ?? ws.last('welcome').items };
}
const at = async (c, x, y) => { c.ws.msg({ t: 'move', x, y, dir: 0, moving: false, teleport: true }); await settle(); };
const spot = (id) => { const f = FURNITURE.find((x) => x.id === id); return { x: f.x + 0.5, y: f.y + 1.5 }; };
const cooldown = () => new Promise((r) => setTimeout(r, 450));

test('items: cleaning, stacking, taking, all or nothing', () => {
  assert.equal(cleanItem({ kind: 'Bad Kind' }), null);
  assert.equal(cleanItem(null), null);
  const c = cleanItem({ kind: 'cookie', name: '<b>x</b>'.repeat(20), qty: 999, verb: 'eats!!', data: { big: 'x'.repeat(600) } }, { from: 'Vending machine', now: 5 });
  assert.equal(c.name.length, 40);
  assert.equal(c.qty, MAX_QTY);
  assert.equal(c.verb, 'eats'); // the bad verb falls back to the office's own
  assert.equal(c.data, undefined);
  assert.equal(c.from, 'Vending machine');
  assert.equal(cleanItem({ kind: 'coffee' }).emoji, '☕');

  let { items } = addItems([], [cleanItem({ kind: 'coffee', qty: 2 }), cleanItem({ kind: 'coffee' })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 3);
  ({ items } = addItems(items, [cleanItem({ kind: 'badge', data: { n: 1 } }), cleanItem({ kind: 'badge', data: { n: 2 } })]));
  assert.equal(items.length, 3, 'items carrying data never stack');
  assert.match(addItems(items, [cleanItem({ kind: 'gum' })], { slots: 3 }).error, /hands are full/);

  const t = takeItems(items, [{ kind: 'coffee', qty: 2 }]);
  assert.equal(t.items.find((s) => s.kind === 'coffee').qty, 1);
  assert.equal(t.taken[0].qty, 2);
  assert.match(takeItems(items, [{ kind: 'coffee', qty: 9 }]).error, /only have 3/);
  assert.match(takeItems(items, [{ kind: 'gum' }]).error, /don't have Mint Gum/);
  // Taking succeeds but giving doesn't fit: nothing changes.
  assert.ok(applyChange(items, { take: [{ kind: 'coffee' }], give: [cleanItem({ kind: 'gum' }), cleanItem({ kind: 'soda' })] }, { slots: 3 }).error);
  assert.equal(useLine(cleanItem({ kind: 'cookie' })), 'eats a Giant Cookie 🍪');
  assert.equal(useLine(cleanItem({ kind: 'badge', name: 'Badge', emoji: '📛' })), 'shows off their Badge 📛');
});

test('coffee comes with a cup you carry; drinking it uses it up for everyone to see', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada', { kind: 'agent' }), b = await join(o, 'grace');
  await at(a, spot('coffee').x, spot('coffee').y); await at(b, spot('coffee').x + 1, spot('coffee').y);
  a.ws.msg({ t: 'coffee' }); await settle();
  const cup = a.items().find((s) => s.kind === 'coffee');
  assert.ok(cup);
  assert.equal(cup.from, 'Coffee machine');
  a.ws.msg({ t: 'inv', op: 'use', id: cup.id }); await settle();
  assert.equal(a.items().length, 0);
  const line = b.ws.sent.filter((m) => m.t === 'chat' && m.action).at(-1);
  assert.match(line.text, /sips a Coffee/);
  assert.equal(b.ws.sent.filter((m) => m.t === 'peer' && m.id === a.id && m.emote === 'coffee').length, 1);
  // Far from the machine you still get a mug to show, but no cup to carry.
  await at(a, 40, 8);
  a.ws.msg({ t: 'coffee' }); await settle();
  assert.equal(a.items().length, 0);
});

test('agents and signed-in people keep their things on their actor between visits', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'bot', { kind: 'agent' });
  await at(a, spot('coffee').x, spot('coffee').y);
  a.ws.msg({ t: 'coffee' }); await settle();
  assert.equal((await o.ref('actor:agent:bot').inventory()).length, 1);
  a.ws.close?.(); o.leave(o.peers.get(a.id));
  const again = await join(o, 'bot', { kind: 'agent' });
  assert.equal(again.ws.last('welcome').items[0].kind, 'coffee');
  assert.equal(again.ws.last('welcome').keeps, true);
});

test('drop, pick up (up close only), and the floor everyone sees', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  await at(a, spot('coffee').x, spot('coffee').y);
  a.ws.msg({ t: 'coffee' }); await settle();
  const cup = a.items()[0];
  a.ws.msg({ t: 'inv', op: 'drop', id: cup.id }); await settle();
  assert.equal(a.items().length, 0);
  const lying = b.ws.last('floor').items;
  assert.equal(lying.length, 1);
  assert.equal(lying[0].item.kind, 'coffee');
  assert.equal(lying[0].by, 'ada');
  await at(b, 40, 8);
  b.ws.msg({ t: 'inv', op: 'pickup', id: lying[0].id }); await settle();
  assert.match(b.ws.last('error').message, /walk over/);
  await at(b, lying[0].x, lying[0].y - 0.3);
  b.ws.msg({ t: 'inv', op: 'pickup', id: lying[0].id }); await settle();
  assert.equal(b.items()[0].kind, 'coffee');
  assert.deepEqual(a.ws.last('floor').items, []);
  const c = await join(o, 'linus');
  assert.deepEqual(c.ws.last('welcome').floor, []);
});

test('giving: only to someone close, and it comes back when their hands are full', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'ada'), b = await join(o, 'grace');
  const p = o.peers.get(a.id), q = o.peers.get(b.id);
  await o.invApply(p, { give: [{ kind: 'cookie', qty: 2 }] });
  const id = a.items()[0].id;
  await at(a, 20, 7); await at(b, 30, 7);
  a.ws.msg({ t: 'inv', op: 'give', id, to: 'grace' }); await settle();
  assert.match(a.ws.last('error').message, /walk over to grace/);
  await at(b, 21, 7);
  a.ws.msg({ t: 'inv', op: 'give', id, to: 'grace' }); await settle();
  assert.equal(a.items()[0].qty, 1);
  assert.equal(b.items()[0].kind, 'cookie');
  assert.match(b.ws.last('toast').text, /ada gave you/);
  // Guests carry at most GUEST_SLOTS things.
  await o.invApply(q, { give: Array.from({ length: GUEST_SLOTS - 1 }, (_, i) => ({ kind: `thing${i}`, data: { i } })) });
  await o.invApply(p, { give: [{ kind: 'choc' }] });
  const choc = a.items().find((s) => s.kind === 'choc');
  a.ws.msg({ t: 'inv', op: 'give', id: choc.id, to: b.id }); await settle();
  assert.match(a.ws.last('error').message, /grace can't take it: their hands are full/);
  assert.ok(a.items().some((s) => s.kind === 'choc'), 'the giver keeps it');
  assert.equal(b.items().length, GUEST_SLOTS);
});

test('the vending machine hands you the snack; eating it uses it up', async () => {
  const rnd = Math.random; Math.random = () => 0.5;
  try {
    const o = new Office();
    await o.ready;
    const a = await join(o, 'ada');
    await at(a, spot('vending').x, spot('vending').y);
    a.ws.msg({ t: 'use', id: 'vending', action: 'buy:cookie' }); await settle();
    const snack = a.items()[0];
    assert.equal(snack.kind, 'cookie');
    assert.equal(snack.from, 'Vending machine');
    a.ws.msg({ t: 'inv', op: 'use', id: snack.id }); await settle();
    assert.equal(a.items().length, 0);
    assert.match(a.ws.sent.filter((m) => m.t === 'chat' && m.action).at(-1).text, /eats a Giant Cookie/);
  } finally { Math.random = rnd; }
});

test('plugins see your things, and a take you can\'t cover changes nothing', async () => {
  const calls = [];
  const env = {
    PLUGIN_JUKEBOX: {
      interact: async (req) => {
        calls.push(req);
        if (req.action === 'grant') return { state: { n: 1 }, give: [{ kind: 'jukebox:token', name: 'Song token', emoji: '🪙', qty: 2 }] };
        return { state: { n: 2 }, say: 'played', take: [{ kind: 'jukebox:token', qty: 5 }] };
      },
    },
  };
  const rt = new LocalRuntime({ kinds: KINDS, services: { plugins: new PluginHost({ env }) } });
  const o = new Office({}, { runtime: rt });
  await o.ready;
  const a = await join(o, 'ada');
  await at(a, spot('jukebox').x, spot('jukebox').y);
  a.ws.msg({ t: 'use', id: 'jukebox', action: 'grant' }); await settle();
  assert.equal(a.items()[0].qty, 2);
  assert.equal(a.items()[0].from, 'Jukebox');
  await cooldown();
  a.ws.msg({ t: 'use', id: 'jukebox', action: 'spend' }); await settle();
  assert.equal(calls.at(-1).inventory[0].kind, 'jukebox:token');
  assert.match(a.ws.last('objui').toast, /only have 2/);
  assert.equal(a.ws.sent.filter((m) => m.t === 'obj' && m.say).length, 0, 'nothing was said');
  assert.deepEqual((await rt.ref('plugin:jukebox').inspect()).state.data, { n: 1 }, 'the object forgot the failed turn');
  assert.equal(a.items()[0].qty, 2);
  rt.stop();
});

test('sanitize keeps at most 5 clean grants and takes', () => {
  const s = sanitize({ give: [...Array(8)].map(() => ({ kind: 'gum' })).concat([{ kind: 'NOPE' }]), take: [{ kind: 'gum', qty: 99 }, { kind: '<x>' }] });
  assert.equal(s.give.length, 5);
  assert.deepEqual(s.take, [{ kind: 'gum', qty: 20 }]);
});

test('inventory over the generated API: view, use, drop and pickup with proximity', async () => {
  const o = new Office();
  await o.ready;
  const a = await join(o, 'bot', { kind: 'agent' });
  const p = o.peers.get(a.id);
  await o.invApply(p, { give: [{ kind: 'gum', qty: 3 }] });
  const [gum] = await o.call(p, 'inventory:me', 'view');
  assert.equal(gum.qty, 3);
  const used = await o.call(p, 'inventory:me', 'use', [gum.id]);
  assert.match(used.did, /chews a Mint Gum/);
  const { floor } = await o.call(p, 'inventory:me', 'drop', [gum.id, 1]);
  await at(a, 40, 8);
  assert.match((await o.call(p, 'inventory:me', 'pickup', [floor])).error, /walk over/);
  await assert.rejects(() => o.call(null, 'inventory:me', 'view'), /join the office/);
  assert.equal((await o.call(null, 'floor:main', 'view')).length, 1);
});

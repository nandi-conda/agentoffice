import test from 'node:test';
import assert from 'node:assert/strict';
import { stockRecipe, recolor, composite, modulate } from '../public/js/stock.js';
import { stockAsset } from '../server/app.js';

test('stock recipe is deterministic per identity and varies between identities', () => {
  assert.deepEqual(stockRecipe('did:plc:abc'), stockRecipe('did:plc:abc'));
  const looks = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => JSON.stringify(stockRecipe(s))));
  assert.ok(looks.size > 4);
});

test('agents wear a lanyard and goggles; every part passes the proxy allowlist', async () => {
  const { layers } = stockRecipe('helper-bot', 'agent');
  assert.ok(layers.some((l) => l.path.includes('lanyard_keycard')));
  assert.ok(layers.some((l) => l.path.includes('safety_goggles')));
  assert.equal(layers[0].id, 'body');
  const fake = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  for (let i = 0; i < 40; i++) {
    for (const l of stockRecipe(`p${i}`, i % 3 ? 'human' : 'agent').layers) {
      for (const p of [l.path, l.map]) assert.equal((await stockAsset(p, fake)).status, 200, p);
    }
  }
});

test('stock proxy refuses paths outside the generator parts', async () => {
  let called = 0;
  const fake = async () => { called++; return new Response('x'); };
  for (const p of ['../secret.png', 'body/x.svg', 'body/../../a.png', 'accessories/hind/001_backpack.png', 'https://evil/a.png']) {
    assert.equal((await stockAsset(p, fake)).status, 404, p);
  }
  assert.equal(called, 0);
});

test('stock proxy passes upstream 404s and rejects non-PNG answers', async () => {
  assert.equal((await stockAsset('body/missing_one.png', async () => new Response('no', { status: 404 }))).status, 404);
  assert.equal((await stockAsset('body/html_one.png', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))).status, 502);
});

const px = (...rgba) => new Uint8ClampedArray(rgba);

test('recolor follows the generator sentinels and colourway channels', () => {
  const grey = [128, 128, 128, 255];
  const base = px(...grey, ...grey, ...grey, ...grey, ...grey);
  const map = px(249, 193, 157, 255, 252, 203, 10, 255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0);
  const out = recolor(base, map, { skin: '#d99f76', hair: '#ff0000', colors: { main: '#00ff00' } });
  assert.notDeepEqual([...out.slice(0, 3)], [128, 128, 128]); // skin recoloured
  assert.deepEqual([...out.slice(4, 7)], modulate('#ff0000', 128)); // hair
  assert.deepEqual([...out.slice(8, 11)], modulate('#00ff00', 128)); // main channel
  assert.equal(out[15], 0); // black map pixel erases
  assert.deepEqual([...out.slice(16, 20)], grey); // transparent map pixel leaves art alone
});

test('composite stacks layers and lets a black map pixel punch through', () => {
  const under = { base: px(10, 20, 30, 255, 10, 20, 30, 255), map: null, ctx: {} };
  const over = { base: px(0, 0, 0, 0, 200, 200, 200, 255), map: px(0, 0, 0, 255, 0, 0, 0, 0), ctx: {} };
  const out = composite([under, over], 8);
  assert.equal(out[3], 0);
  assert.deepEqual([...out.slice(4)], [200, 200, 200, 255]);
});

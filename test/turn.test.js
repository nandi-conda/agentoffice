import test from 'node:test';
import assert from 'node:assert/strict';
import { createIce, STUN } from '../server/turn.js';
import { handleApi } from '../server/app.js';

const cfAnswer = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
] };

test('without a TURN key, browsers get STUN only and nothing is fetched', async () => {
  const ice = createIce({ fetchImpl: () => { throw new Error('should not fetch'); } });
  assert.deepEqual(await ice.get(), { iceServers: STUN, ttl: 86400, turn: false });
});

test('mints Cloudflare credentials once, drops port 53, and re-mints near expiry', async () => {
  let t = 0, calls = [];
  const ice = createIce({
    keyId: 'KEY', token: 'TOK', now: () => t,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(cfAnswer)); },
  });
  const a = await ice.get();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/KEY/credentials/generate-ice-servers');
  assert.equal(calls[0].init.headers.authorization, 'Bearer TOK');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: 86400 });
  assert.equal(a.turn, true);
  assert.ok(a.iceServers.flatMap((s) => s.urls).every((u) => !u.includes(':53')));
  assert.equal(a.iceServers[1].username, 'u');
  assert.equal(a.ttl, 18 * 3600);
  t = 10 * 3600 * 1000; await ice.get();
  assert.equal(calls.length, 1, 'still fresh: cached');
  t = 19 * 3600 * 1000; await ice.get();
  assert.equal(calls.length, 2, 'under 6 h left: re-minted');
});

test('a Cloudflare error falls back to STUN when nothing valid is cached', async () => {
  const ice = createIce({ keyId: 'KEY', token: 'TOK', fetchImpl: async () => new Response('no', { status: 401 }) });
  const r = await ice.get();
  assert.equal(r.turn, false);
  assert.deepEqual(r.iceServers, STUN);
});

test('GET /api/ice serves the ICE servers without the internal error', async () => {
  const ice = createIce({ keyId: 'KEY', token: 'TOK', fetchImpl: async () => new Response('no', { status: 500 }) });
  const res = await handleApi(new Request('http://x/api/ice'), { ice });
  const body = await res.json();
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.iceServers, STUN);
  assert.equal(body.error, undefined);
});

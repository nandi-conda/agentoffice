import test from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer, redact, addSecret, log, setLogSink, forwarder } from '../server/logs.js';
import { Office } from '../server/office.js';

test('redaction hides tokens, cookies, JWTs and secret-named fields', () => {
  addSecret('super-operator-key');
  const s = redact('auth Bearer abcdefghijklmnop rmcp_123456789 cookie ao_session=did.sig key super-operator-key jwt eyJhbGciOi.eyJzdWIiOiJ4.sig_part ?code=abc&state=xyz');
  for (const leak of ['abcdefghijklmnop', 'rmcp_123456789', 'did.sig', 'super-operator-key', 'eyJzdWIiOiJ4', 'code=abc', 'state=xyz']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
  assert.deepEqual(redact({ accessToken: 'x', nested: { dpopJwk: { d: 1 }, credential: 'c' }, name: 'ok' }), { accessToken: '[redacted]', nested: { dpopJwk: '[redacted]', credential: '[redacted]' }, name: 'ok' });
  assert.match(redact('{"credential":"abcd1234efgh"}'), /\[redacted\]/);
});

test('the buffer keeps the newest entries and filters by level, source and text', () => {
  const b = new LogBuffer({ max: 3 });
  for (const [level, source, msg] of [['debug', 'mcp', 'a'], ['info', 'plugin:jukebox', 'b'], ['error', 'plugin:vending', 'c'], ['warning', 'freeq', 'd']]) b.add({ level, source, msg });
  assert.deepEqual(b.entries.map((e) => e.msg), ['b', 'c', 'd']);
  assert.deepEqual(b.since(0, { level: 'warning' }).map((e) => e.msg), ['c', 'd']);
  assert.deepEqual(b.since(0, { sources: ['plugin'] }).map((e) => e.msg), ['b', 'c']);
  assert.deepEqual(b.since(0, { grep: 'D' }).map((e) => e.msg), ['d']);
  const again = new LogBuffer();
  again.restore(b.snapshot());
  assert.equal(again.add({ msg: 'e' }).seq, 5);
});

test('entity logs reach the World: directly on Node, forwarded through apply on Workers', async () => {
  const office = new Office({});
  setLogSink({ buffer: office.logs });
  log('notice', 'room:board', 'cancel failed: not yours', undefined, { print: false });
  assert.equal(office.logs.entries.at(-1).source, 'room:board');

  // An entity object without the World in its isolate forwards in batches.
  setLogSink({ buffer: null, forward: forwarder((entries) => office.apply([{ op: 'log', from: 'plugin:jukebox', entries }])) });
  log('error', 'plugin:jukebox', 'binding timed out', undefined, { print: false });
  log('info', 'console', 'hello from Bearer rmcp_leakyleaky', undefined, { print: false });
  await new Promise((r) => setTimeout(r, 10));
  const last = office.logs.entries.slice(-2);
  assert.deepEqual(last.map((e) => [e.source, e.msg]), [['plugin:jukebox', 'binding timed out'], ['console', 'hello from Bearer rmcp_[redacted]']]);
  setLogSink({ buffer: null, forward: null });
});

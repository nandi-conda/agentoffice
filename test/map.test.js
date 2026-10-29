import test from 'node:test';
import assert from 'node:assert/strict';
import { W, H, ZONES, SEATS, DESKS, SPAWN, isBlocked, zoneAt, canHear, findPath, openSpot } from '../public/js/map.js';

test('spawn is walkable and in the lobby', () => {
  assert.equal(isBlocked(Math.floor(SPAWN.x), Math.floor(SPAWN.y)), false);
  assert.equal(zoneAt(SPAWN.x, SPAWN.y).id, 'lobby');
});

test('every zone and every seat is reachable from spawn', () => {
  for (const z of ZONES) {
    const cx = Math.floor((z.x0 + z.x1) / 2), cy = Math.floor((z.y0 + z.y1) / 2);
    assert.ok(findPath(SPAWN.x, SPAWN.y, cx, cy), `zone ${z.id} unreachable`);
  }
  for (const s of SEATS) {
    assert.equal(isBlocked(Math.floor(s.x), Math.floor(s.y)), false, `seat ${s.id} is blocked`);
    assert.ok(findPath(SPAWN.x, SPAWN.y, s.x, s.y), `seat ${s.id} unreachable`);
  }
});

test('every desk has a chair', () => {
  for (const d of DESKS) assert.ok(SEATS.find((s) => s.desk === d.id), d.id);
});

test('booths are the most specific zone', () => {
  assert.equal(zoneAt(2.5, 15.5).id, 'booth1');
  assert.equal(zoneAt(6.5, 18.5).id, 'booths');
});

test('hearing: proximity in open areas, walls around rooms', () => {
  const a = { x: 20, y: 7 }, near = { x: 22, y: 8 }, far = { x: 31, y: 16 };
  assert.ok(canHear(a, near));
  assert.ok(!canHear(a, far));
  const inBoard = { x: 40, y: 8 }, alsoBoard = { x: 45, y: 2 };
  assert.ok(canHear(inBoard, alsoBoard), 'whole room hears each other');
  assert.ok(!canHear({ x: 33, y: 7 }, inBoard), 'outside the glass cannot hear in');
  assert.ok(!canHear(inBoard, { x: 33, y: 7 }), 'inside the room cannot be heard outside');
});

test('paths never cross walls', () => {
  const p = findPath(SPAWN.x, SPAWN.y, 40, 8);
  for (const s of p) assert.equal(isBlocked(Math.floor(s.x), Math.floor(s.y)), false);
  assert.ok(W > 0 && H > 0);
});

test('openSpot finds a free walkable tile near the spawn', () => {
  assert.deepEqual(openSpot(SPAWN.x, SPAWN.y, []), { x: SPAWN.x, y: SPAWN.y });
  const s = openSpot(SPAWN.x, SPAWN.y, [SPAWN]);
  assert.ok(Math.hypot(s.x - SPAWN.x, s.y - SPAWN.y) >= 1.2);
  assert.equal(isBlocked(Math.floor(s.x), Math.floor(s.y)), false);
  assert.equal(zoneAt(s.x, s.y), zoneAt(SPAWN.x, SPAWN.y));
});

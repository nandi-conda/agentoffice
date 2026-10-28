import test from 'node:test';
import assert from 'node:assert/strict';
import { facing } from '../public/js/sprites.js';

test('facing follows the main axis from a standstill', () => {
  assert.equal(facing(0, 1, 0.2), 2);
  assert.equal(facing(0, -1, 0), 1);
  assert.equal(facing(2, 0, -1), 3);
  assert.equal(facing(3, 0, 0), 3);
});

test('a diagonal keeps whichever way you were already facing', () => {
  for (let i = 0; i < 20; i++) {
    const wobble = (i % 2 ? 1 : -1) * 0.05;
    assert.equal(facing(2, 1 + wobble, 1 - wobble), 2);
    assert.equal(facing(0, 1 + wobble, 1 - wobble), 0);
  }
});

test('turning well away from your facing turns you', () => {
  assert.equal(facing(2, 0.3, 1), 0);
  assert.equal(facing(0, -1, 0), 1);
});

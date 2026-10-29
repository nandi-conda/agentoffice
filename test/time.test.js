import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, fmtHour, fmtClock, stamp, stampRange, localize, isoize } from '../public/js/time.js';

test('times read as a 12-hour clock in the local zone', () => {
  const t = new Date(2026, 9, 29, 19, 5).getTime();
  assert.match(fmtTime(t), /^7:05\s?PM$/i);
  assert.match(fmtHour(new Date(2026, 9, 29, 7).getTime()), /^7\D*AM$/i);
  assert.match(fmtClock('00:30'), /^12:30\s?AM$/i);
});

test('server text carries stamps; browsers localize them, agents get ISO', () => {
  const start = new Date(2026, 9, 29, 9, 0).getTime(), end = start + 45 * 60000;
  const text = `booked ${stampRange({ start, end })}`;
  assert.equal(text, `booked <t:${start}>–<t:${end}>`);
  assert.match(localize(text), /^booked 9:00\s?AM–9:45\s?AM$/i);
  assert.equal(isoize(`until ${stamp(end)}`), `until ${new Date(end).toISOString()}`);
});

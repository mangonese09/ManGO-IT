import { test } from 'node:test';
import assert from 'node:assert';
import {
  romeTime, durationText, countdownText, isOtherRomeDay, romeWallToIso, agoText, whenLabel,
} from '../../js/time.js';

test('whenLabel formats the datetime chip', () => {
  assert.strictEqual(whenLabel(''), 'Now');
  assert.strictEqual(whenLabel(null), 'Now');
  assert.strictEqual(whenLabel('2026-07-28T15:30'), 'Tue 28 Jul · 15:30');
  assert.strictEqual(whenLabel('2026-12-25T06:05'), 'Fri 25 Dec · 06:05');
});

test('romeTime renders Rome wall clock regardless of host TZ', () => {
  assert.strictEqual(romeTime('2026-07-27T08:21:00Z'), '10:21'); // CEST
  assert.strictEqual(romeTime('2026-01-10T08:21:00Z'), '09:21'); // CET
  assert.strictEqual(romeTime(null), '—');
});

test('durationText', () => {
  assert.strictEqual(durationText(540), '9 min');
  assert.strictEqual(durationText(13020), '3h 37m');
});

test('countdownText near/far/past', () => {
  const now = new Date('2026-07-27T08:00:00Z').getTime();
  assert.strictEqual(countdownText('2026-07-27T08:03:00Z', now), '3 min');
  assert.strictEqual(countdownText('2026-07-27T08:00:20Z', now), 'now');
  assert.strictEqual(countdownText('2026-07-27T07:50:00Z', now), 'gone');
  assert.strictEqual(countdownText('2026-07-27T10:30:00Z', now), '2h 30m'); // >60min stays relative
});

test('isOtherRomeDay flips at Rome midnight, not device midnight', () => {
  // 22:30Z on Jul 26 is 00:30 Jul 27 in Rome → other day vs 21:00Z Jul 26 (23:00 Rome)
  const now = new Date('2026-07-26T21:00:00Z');
  assert.ok(isOtherRomeDay('2026-07-26T22:30:00Z', now));
  assert.ok(!isOtherRomeDay('2026-07-26T20:00:00Z', now));
});

test('romeWallToIso converts Rome wall time to the right instant', () => {
  assert.strictEqual(romeWallToIso('2026-07-27T08:30'), '2026-07-27T06:30:00.000Z'); // CEST +2
  assert.strictEqual(romeWallToIso('2026-01-10T08:30'), '2026-01-10T07:30:00.000Z'); // CET +1
});

test('agoText buckets', () => {
  const now = 1000 * 3600 * 24 * 400;
  assert.strictEqual(agoText(now - 30 * 1000, now), 'just now');
  assert.strictEqual(agoText(now - 5 * 60 * 1000, now), '5m ago');
  assert.strictEqual(agoText(now - 3 * 3600 * 1000, now), '3h ago');
});

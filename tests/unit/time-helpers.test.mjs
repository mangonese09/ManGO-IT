import { test } from 'node:test';
import assert from 'node:assert';
import {
  romeTime, durationText, countdownText, isOtherRomeDay, romeWallToIso, agoText, whenLabel,
  romeHour, dayPartKey, deviceZoneGap, romeNowInputValue,
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
  assert.strictEqual(countdownText('2026-08-10T08:00:00Z', now), '14d'); // days out reads as days, not "336h 00m"
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

test('romeHour returns Rome wall-clock hour regardless of host TZ', () => {
  assert.strictEqual(romeHour('2026-07-27T08:21:00Z'), 10); // CEST +2
  assert.strictEqual(romeHour('2026-07-27T22:30:00Z'), 0);  // 00:30 next Rome day
  assert.strictEqual(romeHour('2026-01-15T23:00:00Z'), 0);  // CET +1 → midnight
  assert.strictEqual(romeHour('bad'), null);
});

// The reported bug: a traveller in Sicily whose phone is still on Chicago time
// read correct Rome departures ("8:30pm and onwards") as a broken +7h
// conversion, because nothing next to the times said which zone they were in.
// The times were never wrong — the app just never owned up to the gap.
test('deviceZoneGap is silent when the device already agrees with Italy', () => {
  const summer = new Date('2026-08-09T14:41:00Z');
  assert.strictEqual(deviceZoneGap(summer, 120), null);            // Rome itself
  assert.strictEqual(deviceZoneGap(summer, 120), null);            // Berlin/Paris share the offset
  assert.strictEqual(deviceZoneGap(new Date('2026-01-10T09:00:00Z'), 60), null); // CET winter
});

test('deviceZoneGap names the offset the way the user would say it', () => {
  const summer = new Date('2026-08-09T14:41:00Z'); // Rome +2
  const chicago = deviceZoneGap(summer, -300);     // CDT −5
  assert.strictEqual(chicago.minutes, 420);
  assert.ok(chicago.ahead);
  assert.strictEqual(chicago.text, '7 hours ahead of your phone');

  const winter = new Date('2026-01-10T09:00:00Z'); // Rome +1
  assert.strictEqual(deviceZoneGap(winter, 0).text, '1 hour ahead of your phone'); // London

  // east of Rome the app is behind, and half-hour zones must not round away
  assert.strictEqual(deviceZoneGap(summer, 330).text, '3h 30m behind your phone'); // Kolkata
  assert.ok(!deviceZoneGap(summer, 330).ahead);
});

test('romeNowInputValue seeds the picker with Italy now, not the device clock', () => {
  // 14:41Z is 16:41 in Rome and 09:41 in Chicago — the picker must open on 16:41
  assert.strictEqual(romeNowInputValue(new Date('2026-08-09T14:41:00Z')), '2026-08-09T16:41');
  assert.strictEqual(romeNowInputValue(new Date('2026-01-10T23:30:00Z')), '2026-01-11T00:30'); // rolls the Rome day
});

test('dayPartKey buckets the day into morning/afternoon/evening (late night rides evening)', () => {
  assert.strictEqual(dayPartKey(4), 'morning');
  assert.strictEqual(dayPartKey(11), 'morning');
  assert.strictEqual(dayPartKey(12), 'afternoon');
  assert.strictEqual(dayPartKey(16), 'afternoon');
  assert.strictEqual(dayPartKey(17), 'evening');
  assert.strictEqual(dayPartKey(23), 'evening');
  assert.strictEqual(dayPartKey(0), 'evening');  // 00:30 tail of evening service
  assert.strictEqual(dayPartKey(3), 'evening');
});

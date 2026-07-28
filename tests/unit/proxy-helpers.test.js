'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, inSicily, dropDominated,
} = require('../../server/proxy.js');

test('dropDominated removes strictly-worse itineraries (audit fix)', () => {
  const it = (start, end) => ({ startTime: `2026-08-05T${start}:00Z`, endTime: `2026-08-05T${end}:00Z` });
  // the milk-run 16:00→20:00 is dominated by BOTH later options; the other two
  // trade off (16:05 arrives earlier, 17:00 leaves later) so both survive.
  const kept = dropDominated([
    it('16:00', '20:00'),   // dominated — dropped
    it('16:05', '19:44'),   // earlier arrival — survives
    it('17:00', '19:50'),   // later departure, slightly later arrival — survives
  ]);
  const times = kept.map((x) => x.startTime.slice(11, 16)).sort();
  assert.deepStrictEqual(times, ['16:05', '17:00'], 'drops only the strictly-dominated milk-run');
});

test('dropDominated keeps ties and Pareto-incomparable options', () => {
  const it = (start, end) => ({ startTime: `2026-08-05T${start}:00Z`, endTime: `2026-08-05T${end}:00Z` });
  assert.strictEqual(dropDominated([it('08:00', '10:00'), it('08:00', '10:00')]).length, 2); // identical: both kept
  assert.strictEqual(dropDominated([it('08:00', '10:30'), it('09:00', '11:00')]).length, 2); // trade-off: both kept
  assert.strictEqual(dropDominated([it('08:00', '11:00'), it('09:00', '11:00')]).length, 1); // same arr, later dep wins
});

test('romeNowString formats a Rome-timezone RFC1123-ish string', () => {
  // Fixed instant: 2026-07-25T14:16:02Z == 16:16:02 CEST
  const s = romeNowString(new Date('2026-07-25T14:16:02Z'));
  assert.strictEqual(s, 'Sat Jul 25 2026 16:16:02 GMT+0200');
});

test('romeNowString uses +0100 in winter (CET)', () => {
  const s = romeNowString(new Date('2026-01-10T14:00:00Z'));
  assert.strictEqual(s, 'Sat Jan 10 2026 15:00:00 GMT+0100');
});

test('parseVtStations parses pipe-delimited station lines', () => {
  const out = parseVtStations('PALERMO CENTRALE|S12002\nPALERMO NOTARBARTOLO|S12134\n');
  assert.deepStrictEqual(out, [
    { name: 'PALERMO CENTRALE', id: 'S12002' },
    { name: 'PALERMO NOTARBARTOLO', id: 'S12134' },
  ]);
});

test('parseVtTrainAutocomplete extracts train, origin, epoch', () => {
  const out = parseVtTrainAutocomplete('21757 - PALERMO CENTRALE|21757-S12002-1784930400000\n');
  assert.deepStrictEqual(out, [
    { trainNumber: '21757', originId: 'S12002', departureEpochMs: 1784930400000 },
  ]);
});

test('parseVtTrainAutocomplete tolerates garbage lines', () => {
  assert.deepStrictEqual(parseVtTrainAutocomplete('nonsense\n\n|also-bad\n'), []);
});

test('pickVtCandidate takes the run closest to now (train numbers repeat daily)', () => {
  const day = 24 * 3600 * 1000;
  const now = 10 * day;
  const picked = pickVtCandidate([
    { trainNumber: '21757', originId: 'S12002', departureEpochMs: now - 2 * day },
    { trainNumber: '21757', originId: 'S12002', departureEpochMs: now - 3600 * 1000 },
    { trainNumber: '21757', originId: 'S12002', departureEpochMs: now + day },
  ], now);
  assert.strictEqual(picked.departureEpochMs, now - 3600 * 1000);
});

test('slimVtDeparture maps the fields the UI needs', () => {
  const out = slimVtDeparture({
    numeroTreno: 21757, categoriaDescrizione: 'REG', destinazione: 'PALERMO AEROPORTO',
    partenzaTreno: 1784995980000, ritardo: 3,
    binarioProgrammatoPartenzaDescrizione: '4', binarioEffettivoPartenzaDescrizione: null,
    nonPartito: false, circolante: true, provvedimento: 0,
  });
  assert.strictEqual(out.trainNumber, 21757);
  assert.strictEqual(out.category, 'REG');
  assert.strictEqual(out.delayMin, 3);
  assert.strictEqual(out.platformScheduled, '4');
  assert.strictEqual(out.cancelled, false);
});

test('inSicily bounds: Palermo yes, Rome no, Malta no', () => {
  assert.ok(inSicily(38.1157, 13.3615));   // Palermo
  assert.ok(inSicily(36.9, 14.7));         // Ragusa area
  assert.ok(!inSicily(41.9, 12.5));        // Rome
  assert.ok(!inSicily(35.9, 14.5));        // Valletta
});

test('feedHorizon: reports a verified-through date with sane shape (audit F-6)', () => {
  const { feedHorizon } = require('../../server/proxy.js');
  const h = feedHorizon();
  assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(h.tripsToday > 1000, `tripsToday ${h.tripsToday} suspiciously low`);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(h.date >= today, `horizon ${h.date} is in the past`);
});

test('vtSilence: flags consecutive zero-parse days, quiet days do not alarm', () => {
  const { vtSilence } = require('../../server/proxy.js');
  // healthy yesterday, silent today (many requests, zero parses) -> 1 day, no alert yet
  let r = vtSilence({ '2026-07-26': { req: 20, ok: 5 }, '2026-07-27': { req: 12, ok: 0 } });
  assert.strictEqual(r.silentDays, 1);
  assert.strictEqual(r.alert, false);
  // two full silent days -> alert
  r = vtSilence({ '2026-07-25': { req: 9, ok: 3 }, '2026-07-26': { req: 8, ok: 0 }, '2026-07-27': { req: 12, ok: 0 } });
  assert.strictEqual(r.silentDays, 2);
  assert.strictEqual(r.alert, true);
  // low-traffic silent day is not evidence
  r = vtSilence({ '2026-07-26': { req: 2, ok: 0 }, '2026-07-27': { req: 1, ok: 0 } });
  assert.strictEqual(r.silentDays, 0);
});

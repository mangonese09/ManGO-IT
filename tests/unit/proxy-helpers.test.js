'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, inSicily, dropDominated,
  parseBias, geoScore, clusterStopsByProximity, clusterAreaName,
} = require('../../server/proxy.js');

test('clusterAreaName names a depot by the shared leading phrase', () => {
  assert.strictEqual(clusterAreaName([
    'LINCOLN DEI MILLE', 'STAZIONE CENTRALE LINCOLN', 'STAZIONE CENTRALE BALSAMO',
    'STAZIONE CENTRALE', 'STAZIONE CENTRALE PENSILINA ESTERNA', 'STAZIONE CENTRALE GIULIO CESARE',
    'ROMA FS', 'DEI MILLE BALSAMO',
  ]), 'STAZIONE CENTRALE');
});

test('clusterAreaName returns null when there is no ≥50% 2-token consensus', () => {
  assert.strictEqual(clusterAreaName(['Piazza A', 'Corso B', 'Via C']), null); // no consensus
  assert.strictEqual(clusterAreaName(['VIA ROMA', 'VIA MILANO', 'VIA TORINO']), null); // only "VIA" shared → too generic
  assert.strictEqual(clusterAreaName(['GARIBALDI', 'GARIBALDI']), null); // single token → keep seed name
});

// ── MAP STOP DE-DUPLICATION (dense depot/interchange collapses to one pin) ──
test('clusterStopsByProximity folds all stops within 200m into one, regardless of name', () => {
  // three station-area stops within ~60m + one 300m+ away
  const out = clusterStopsByProximity([
    { id: 'a', name: 'STAZIONE CENTRALE LINCOLN', lat: 38.11016, lon: 13.36802, modes: ['BUS'], dist: 40 },
    { id: 'b', name: 'STAZIONE CENTRALE BALSAMO', lat: 38.11024, lon: 13.36735, modes: ['TRAM'], dist: 12 }, // nearest → seed
    { id: 'c', name: 'STAZIONE CENTRALE PENSILINA', lat: 38.11031, lon: 13.36686, modes: ['BUS'], dist: 55 },
    { id: 'd', name: 'GARIBALDI', lat: 38.11362, lon: 13.36688, modes: ['BUS'], dist: 400 },
  ], 200);
  assert.strictEqual(out.length, 2, 'the three station stops collapse to one; GARIBALDI stays');
  const hub = out.find((s) => s.id === 'b');
  assert.strictEqual(hub.merged, 3, 'seed folded in the other two');
  assert.deepStrictEqual([...hub.modes].sort(), ['BUS', 'TRAM'], 'modes unioned');
  assert.strictEqual(hub.members.length, 3, 'members carry the real underlying stops');
  assert.ok(hub.members.every((m) => m.id && m.name), 'each member has its real id + specific name');
  const far = out.find((s) => s.id === 'd');
  assert.strictEqual(far.merged, 1, 'the far stop stays on its own');
  assert.strictEqual(far.members, undefined, 'a lone stop carries no members list');
});

test('clusterStopsByProximity leaves normally-spaced stops alone', () => {
  const out = clusterStopsByProximity([
    { id: 'a', name: 'X', lat: 38.1100, lon: 13.3600, modes: [], dist: 10 },
    { id: 'b', name: 'Y', lat: 38.1130, lon: 13.3600, modes: [], dist: 340 }, // ~334m away
  ], 200);
  assert.strictEqual(out.length, 2, 'stops >200m apart are not merged');
});

// ── GEOCODE LOCATION BIAS + RANKING (all-Italy addresses) ──
test('parseBias accepts a valid "lat,lon" pair', () => {
  assert.deepStrictEqual(parseBias('37.4045,13.5303'), { lat: 37.4045, lon: 13.5303 });
  assert.deepStrictEqual(parseBias('37.6,14.15'), { lat: 37.6, lon: 14.15 });
  assert.deepStrictEqual(parseBias('-12.5,-70'), { lat: -12.5, lon: -70 });
});

test('parseBias rejects malformed / out-of-range / abusive input', () => {
  for (const bad of ['', null, undefined, 'abc', '37.4', '37.4,', ',13.5', '200,13', '37,999',
    '37.4,13.5;drop', '1'.repeat(50) + ',2', '37.4 13.5']) {
    assert.strictEqual(parseBias(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('geoScore buckets by type: stop < coach < settlement < other < address', () => {
  const at = (lat, lon) => ({ lat, lon }); // mainland to isolate the bucket term
  const mainland = (o) => ({ ...o, ...at(45, 9) }); // Milan — inSicily false, no boost
  assert.ok(geoScore(mainland({ type: 'STOP', name: 'X' }), 'q')
    < geoScore(mainland({ type: 'COACH_STOP', name: 'X' }), 'q'));
  assert.ok(geoScore(mainland({ type: 'PLACE', category: 'town', name: 'X' }), 'q')
    < geoScore(mainland({ type: 'ADDRESS', name: 'Via Y' }), 'q'));
  assert.ok(geoScore(mainland({ type: 'PLACE', category: 'restaurant', name: 'Z' }), 'q')
    < geoScore(mainland({ type: 'ADDRESS', name: 'Via Y' }), 'q'));
});

test('geoScore ranks Sicily as a hard block above mainland (Sicily-first app)', () => {
  const sicAddr = { type: 'ADDRESS', name: 'Via Crocifisso', lat: 37.4045, lon: 13.5303 }; // Raffadali
  const mainAddr = { type: 'ADDRESS', name: 'Via Crocifisso', lat: 41.9, lon: 12.5 };       // Rome
  assert.ok(geoScore(sicAddr, 'via crocifisso') < geoScore(mainAddr, 'via crocifisso'));
  // Even a mainland STOP (best bucket) sits below any Sicilian result — the two
  // Puglia/Lazio "Via Crocifisso" stops must not top the Sicilian street list.
  const mainStop = { type: 'STOP', name: 'Oria - Via Crocifisso', lat: 40.5, lon: 17.6 };
  assert.ok(geoScore(sicAddr, 'q') < geoScore(mainStop, 'q'));
});

test('geoScore still orders by type within a region', () => {
  const sic = (o) => ({ ...o, lat: 37.4, lon: 13.5 });
  assert.ok(geoScore(sic({ type: 'STOP', name: 'X' }), 'q')
    < geoScore(sic({ type: 'ADDRESS', name: 'Via Y' }), 'q'));
  const main = (o) => ({ ...o, lat: 45, lon: 9 });
  assert.ok(geoScore(main({ type: 'STOP', name: 'X' }), 'q')
    < geoScore(main({ type: 'ADDRESS', name: 'Via Y' }), 'q'));
});

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
    compNumeroTreno: 'REG 21757', compOrarioPartenza: '17:33',
    orarioPartenza: 1784995980000, partenzaTreno: null, ritardo: 3,
    binarioProgrammatoPartenzaDescrizione: '4', binarioEffettivoPartenzaDescrizione: null,
    nonPartito: false, circolante: true, provvedimento: 0,
  });
  assert.strictEqual(out.trainNumber, 21757);
  assert.strictEqual(out.category, 'REG');
  assert.strictEqual(out.label, 'REG 21757');
  assert.strictEqual(out.delayMin, 3);
  assert.strictEqual(out.scheduledMs, 1784995980000);   // orarioPartenza, not the null partenzaTreno
  assert.strictEqual(out.clock, '17:33');
  assert.strictEqual(out.platform, '4');                // actual ?? scheduled
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

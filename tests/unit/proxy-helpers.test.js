'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  romeNowString, parseVtStations, parseVtTrainAutocomplete, pickVtCandidate, slimVtDeparture, inSicily, dropDominated,
  parseBias, geoScore, clusterStopsByProximity, clusterAreaName,
  HUBS, hubsInBbox, mergeDepartures,
  AIRPORTS, airportMatch, airportResult, nominatimToRow, geoDedupeKey, nearestTicketShops,
} = require('../../server/proxy.js');

// ── v1.6.0: nearest ticket sellers ──
const SHOPS = [
  { n: 'Tabaccheria Rossi', t: 'tobacco', lat: 38.1100, lon: 13.3670 },  // ~120 m N of the probe
  { n: '', t: 'newsagent', lat: 38.1092, lon: 13.3679 },                 // ~50 m — unnamed edicola
  { n: 'Biglietteria AMAT', t: 'ticket', lat: 38.1200, lon: 13.3670 },   // ~1.2 km — outside radius
];
test('nearestTicketShops filters by radius, sorts by distance, labels unnamed', () => {
  const got = nearestTicketShops(SHOPS, 38.1089, 13.3675, 600, 3);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].name, 'Edicola'); // unnamed → type label
  assert.strictEqual(got[0].kind, 'Edicola');
  assert.strictEqual(got[1].name, 'Tabaccheria Rossi');
  assert.ok(got[0].dist < got[1].dist);
  assert.ok(got.every((s) => s.dist <= 600));
});
test('nearestTicketShops respects the result cap', () => {
  assert.strictEqual(nearestTicketShops(SHOPS, 38.1089, 13.3675, 5000, 1).length, 1);
});

// ── F-6: punctuation-insensitive geocode dedupe ──
test('punctuation variants of one stop share a dedupe key', () => {
  assert.strictEqual(
    geoDedupeKey('Agrigento (P.le Rosselli)', 'Agrigento'),
    geoDedupeKey('Agrigento P.Rosselli', 'Agrigento'),
  );
});

test('genuinely distinct names keep distinct keys', () => {
  assert.notStrictEqual(geoDedupeKey('Agrigento Centrale', 'Agrigento'), geoDedupeKey('Agrigento Bassa', 'Agrigento'));
  assert.notStrictEqual(geoDedupeKey('Palermo N2', 'Palermo'), geoDedupeKey('Palermo N4', 'Palermo'));
  assert.notStrictEqual(geoDedupeKey('San Leone', 'Agrigento'), geoDedupeKey('San Leone', 'Tortorici'));
});

// ── NOMINATIM COVERAGE FALLBACK (v1.3.1) ──
test('nominatimToRow maps a jsonv2 result into the geocode row shape', () => {
  // verbatim (trimmed) from nominatim.openstreetmap.org for "Punta Bianca"
  const row = nominatimToRow({
    lat: '37.1943657', lon: '13.6611229', name: 'Punta Bianca',
    category: 'natural', type: 'cape', importance: 0.107,
    display_name: 'Punta Bianca, Agrigento, Sicilia, 92100, Italia',
    address: { city: 'Agrigento', county: 'Agrigento', state: 'Sicilia' },
  });
  assert.strictEqual(row.type, 'PLACE');
  assert.strictEqual(row.name, 'Punta Bianca');
  assert.strictEqual(row.category, 'cape');
  assert.strictEqual(row.town, 'Agrigento');
  assert.strictEqual(row.province, 'Agrigento');
  assert.ok(Math.abs(row.lat - 37.19437) < 1e-4 && Math.abs(row.lon - 13.66112) < 1e-4);
});

test('nominatimToRow survives a sparse result without inventing fields', () => {
  const row = nominatimToRow({ lat: '37.5', lon: '14.1', display_name: 'Somewhere, Sicilia' });
  assert.strictEqual(row.name, 'Somewhere');
  assert.strictEqual(row.town, null);
  assert.strictEqual(row.province, null);
  assert.strictEqual(row.category, null);
});

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

test('clusterStopsByProximity collapses same-named members (Transitous per-direction dupes)', () => {
  // Two records with the IDENTICAL name (one per direction) + a distinct one,
  // all within 200m — the cluster should count 2, not 3, and list no repeats.
  const out = clusterStopsByProximity([
    { id: 'a', name: 'Messina Marine Alagna', lat: 38.19340, lon: 15.55010, modes: ['BUS'], dist: 20 },
    { id: 'b', name: 'Messina Marine Alagna', lat: 38.19352, lon: 15.55022, modes: ['BUS'], dist: 35 },
    { id: 'c', name: "Messina Marine D' Aosta", lat: 38.19360, lon: 15.55040, modes: ['BUS'], dist: 60 },
  ], 200);
  assert.strictEqual(out.length, 1, 'all three fold into one cluster');
  const hub = out[0];
  assert.strictEqual(hub.merged, 2, 'the two identical-named records count once');
  assert.strictEqual(hub.members.length, 2, 'no repeat rows in the picker');
  const alagna = hub.members.find((m) => m.name === 'Messina Marine Alagna');
  assert.deepStrictEqual(alagna.ids.sort(), ['a', 'b'], 'both underlying ids kept on the surviving member');
  assert.ok(hub.members.some((m) => m.name === "Messina Marine D' Aosta"), 'the distinct stop is preserved');
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

test('airportMatch resolves every Sicilian IATA code, case/space-insensitively', () => {
  const codes = { PMO: 'palermo', CTA: 'catania', TPS: 'trapani', CIY: 'comiso' };
  for (const [code, town] of Object.entries(codes)) {
    for (const form of [code, code.toLowerCase(), ` ${code} `]) {
      const a = airportMatch(form);
      assert.ok(a, `${form} should match an airport`);
      assert.strictEqual(a.iata, code);
      assert.ok(new RegExp(town, 'i').test(`${a.name} ${a.town} ${a.province}`), `${code} should be the ${town} airport`);
      assert.ok(inSicily(a.lat, a.lon), `${code} coords must be in Sicily`);
    }
  }
});

test('airportMatch takes the colloquial names the geocoder gets wrong', () => {
  // measured live 2026-08-07: these returned piazzas and unrelated towns
  assert.strictEqual(airportMatch('punta raisi').iata, 'PMO');
  assert.strictEqual(airportMatch('Falcone Borsellino').iata, 'PMO');
  assert.strictEqual(airportMatch('birgi').iata, 'TPS');
  assert.strictEqual(airportMatch('aeroporto di comiso').iata, 'CIY');
});

test('airportMatch is EXACT — a code must never substring-match', () => {
  // the whole reason the alias layer is safe: "CTA" inside a longer query is
  // just letters, not an airport, or every "Catania…" search becomes noise
  for (const q of ['catania', 'Catania Centrale', 'PMO airport', 'via cta', 'aeroporto', 'Aeroporto Fontanarossa', '', 'c']) {
    assert.strictEqual(airportMatch(q), null, `${q} must not match`);
  }
});

test('an airport result outranks every other geocode row', () => {
  const pmo = airportResult(AIRPORTS.find((a) => a.iata === 'PMO'));
  const sicStop = { type: 'STOP', name: 'PALERMO CENTRALE', lat: 38.1089, lon: 13.3675 };
  assert.ok(geoScore(pmo, 'pmo') < geoScore(sicStop, 'pmo'));
  // and it survives as a normal row: coords + a name the client can render
  assert.ok(inSicily(pmo.lat, pmo.lon) && pmo.name && pmo.id === null);
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

test('hubsInBbox returns only hubs inside the viewport', () => {
  const box = [38.09, 13.34, 38.13, 13.39]; // central Palermo
  const ids = hubsInBbox(...box).map((h) => h.id);
  assert.ok(ids.includes('palermo-centrale'), 'Palermo Centrale is in-box');
  assert.ok(!ids.includes('catania-centrale'), 'Catania is not in this box');
  assert.ok(HUBS.every((h) => h.lat && h.lon && h.name && h.kind), 'every hub is well-formed');
});

test('mergeDepartures merges, drops past, sorts, caps per mode', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const rail = [{ mode: 'RAIL', line: 'R1', headsign: 'X', timeISO: '2026-08-01T08:10:00Z' }];
  const coach = [{ mode: 'COACH', line: '224', headsign: 'Pomara', timeISO: '2026-08-01T07:50:00Z' }, // past → dropped
                 { mode: 'COACH', line: '224', headsign: 'Pomara', timeISO: '2026-08-01T08:05:00Z' }];
  const out = mergeDepartures([rail, coach], now, { cap: 10, perMode: 8 });
  assert.strictEqual(out.length, 2, 'past row dropped');
  assert.strictEqual(out[0].line, '224', 'earliest first (08:05 before 08:10)');
  assert.strictEqual(out[0].minutes, 5, 'minutes computed from now');
  assert.ok(out.every((r) => r.mode && r.timeISO), 'rows keep shape');
});

test('mergeDepartures enforces per-mode then overall caps', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const mk = (mode, n) => Array.from({ length: n }, (_, i) => ({
    mode, line: String(i), headsign: 'H', timeISO: new Date(now + (i + 1) * 60000).toISOString(),
  }));
  const out = mergeDepartures([mk('BUS', 12), mk('RAIL', 12)], now, { perMode: 8, cap: 30 });
  assert.strictEqual(out.filter((r) => r.mode === 'BUS').length, 8, 'BUS capped at perMode');
  assert.strictEqual(out.filter((r) => r.mode === 'RAIL').length, 8, 'RAIL capped at perMode');
  const capped = mergeDepartures([mk('BUS', 20)], now, { perMode: 50, cap: 5 });
  assert.strictEqual(capped.length, 5, 'overall cap applied');
});

test('mergeDepartures collapses exact repeats (multi-node station dupes)', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const t = '2026-08-01T08:05:00Z';
  // same line+dest+instant from 7 platform nodes → one row; a later 101 run stays
  const dupes = Array.from({ length: 7 }, () => ({ mode: 'BUS', line: '101', headsign: 'STAZIONE CENTRALE', timeISO: t }));
  const later = { mode: 'BUS', line: '101', headsign: 'STAZIONE CENTRALE', timeISO: '2026-08-01T08:20:00Z' };
  const out = mergeDepartures([dupes, [later]], now, { perMode: 10, cap: 40 });
  assert.strictEqual(out.length, 2, 'the 7 identical rows collapse to one; the later run survives');
  assert.strictEqual(out.filter((r) => r.timeISO === t).length, 1, 'exactly one 08:05 row');
});

test('mergeDepartures keeps the realtime copy when a dupe pair disagrees', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const t = '2026-08-01T08:05:00Z';
  const out = mergeDepartures([
    [{ mode: 'RAIL', line: 'R1', headsign: 'X', timeISO: t, realtime: false }],
    [{ mode: 'RAIL', line: 'R1', headsign: 'X', timeISO: t, realtime: true }],
  ], now, { perMode: 10, cap: 40 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].realtime, true, 'live copy wins');
});

test('afterStation returns the calls after the boarding station', () => {
  const { afterStation } = require('../../server/proxy.js');
  const stops = ['CATANIA CENTRALE', 'CATANIA AEROPORTO FONTANAROSSA', 'LENTINI', 'AUGUSTA', 'SIRACUSA'];
  assert.deepStrictEqual(afterStation(stops, 'CATANIA AEROPORTO FONTANAROSSA'), ['LENTINI', 'AUGUSTA', 'SIRACUSA']);
  // partial containment either way still anchors (VT spellings drift)
  assert.deepStrictEqual(afterStation(stops, 'AEROPORTO FONTANAROSSA'), ['LENTINI', 'AUGUSTA', 'SIRACUSA']);
  // unknown station → keep the whole list so search still has something to match
  assert.deepStrictEqual(afterStation(stops, 'MESSINA CENTRALE'), stops);
  assert.deepStrictEqual(afterStation([], 'X'), []);
});

test('decodePolyline decodes the classic Google example (precision 5)', () => {
  const { decodePolyline } = require('../../server/proxy.js');
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  assert.strictEqual(pts.length, 3);
  assert.deepStrictEqual(pts[0], [38.5, -120.2]);
  assert.deepStrictEqual(pts[1], [40.7, -120.95]);
  assert.deepStrictEqual(pts[2], [43.252, -126.453]);
});

test('outOfCoverage excludes Malta but keeps the Pelagie islands and the strait (M-2)', () => {
  const { outOfCoverage } = require('../../server/proxy.js');
  // Malta: airport (the real pin that leaked onto the map) + Valletta
  assert.strictEqual(outOfCoverage(35.857, 14.478), true);
  assert.strictEqual(outOfCoverage(35.899, 14.514), true);
  // Sicilian islands FURTHER SOUTH than Malta stay in coverage
  assert.strictEqual(outOfCoverage(35.50, 12.60), false);  // Lampedusa
  assert.strictEqual(outOfCoverage(35.86, 12.87), false);  // Linosa
  assert.strictEqual(outOfCoverage(36.83, 11.95), false);  // Pantelleria
  // core coverage
  assert.strictEqual(outOfCoverage(38.11, 13.36), false);  // Palermo
  assert.strictEqual(outOfCoverage(38.22, 15.55), false);  // Villa S. Giovanni (strait)
});

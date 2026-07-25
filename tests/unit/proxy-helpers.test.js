'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  romeNowString, parseVtStations, parseVtTrainAutocomplete, slimVtDeparture, inSicily,
} = require('../../server/proxy.js');

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

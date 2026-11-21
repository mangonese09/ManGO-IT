// 1.18.6–1.18.7 design batches: short coach names, short operator names,
// tram-by-name, and the suggestion near-duplicate merge.
import { test } from 'node:test';
import assert from 'node:assert';
import { shortRouteName, directionalRouteName } from '../../js/names.js';
import { shortOperator } from '../../js/operators.js';
import { effectiveMode } from '../../js/ui.js';

test('shortRouteName keeps the towns of a terminus-address route name', () => {
  assert.strictEqual(shortRouteName('PACECO Viale Regina Margherita – PALERMO Viale dei Picciotti'), 'Paceco – Palermo');
  assert.strictEqual(shortRouteName('SAN GIOVANNI GEMINI Via Roma - AGRIGENTO (Piazzale Rosselli)'), 'San Giovanni Gemini – Agrigento');
  assert.strictEqual(shortRouteName('CATANIA (Via Fazello) - TAORMINA'), 'Catania – Taormina');
  assert.strictEqual(shortRouteName('S. Elisabetta - Palermo'), 'S. Elisabetta – Palermo');
  assert.strictEqual(shortRouteName('0 Aragona - -Raffadali'), 'Aragona – Raffadali');
  assert.strictEqual(shortRouteName('109'), '109');
  assert.strictEqual(shortRouteName('Palermo Centrale - Catania Aeroporto'), 'Palermo Centrale – Catania Aeroporto');
});

test('directionalRouteName flips the shortened name toward the destination', () => {
  assert.strictEqual(directionalRouteName('PACECO Viale Regina Margherita - PALERMO Viale dei Picciotti', 'Paceco'), 'Palermo – Paceco');
});

test('shortOperator names the operator in a word or two', () => {
  assert.strictEqual(shortOperator('SAIS Trasporti / SAIS Autolinee'), 'SAIS');
  assert.strictEqual(shortOperator('AST — Azienda Siciliana Trasporti'), 'AST');
  assert.strictEqual(shortOperator('Autolinee Lumia'), 'Lumia');
  assert.strictEqual(shortOperator('AMAT Palermo'), 'AMAT');
  assert.strictEqual(shortOperator('FlixBus'), 'FlixBus');
  assert.strictEqual(shortOperator('Interbus / Etna Trasporti'), 'Interbus');
});

test('effectiveMode treats a bus-moded "TRAM n" line as a tram, nothing else', () => {
  assert.strictEqual(effectiveMode('BUS', 'TRAM1'), 'TRAM');
  assert.strictEqual(effectiveMode('BUS', 'Tram 3'), 'TRAM');
  assert.strictEqual(effectiveMode('BUS', '101'), 'BUS');
  assert.strictEqual(effectiveMode('RAIL', 'Tram 2'), 'RAIL');
  assert.strictEqual(effectiveMode('WALK', 'Tram 2'), 'WALK');
});

import { legStripModel } from '../../js/itinerary.js';
test('legStripModel shows both end walks by one rule (over 5 min)', () => {
  const L = (mode, mins) => ({ mode, duration: mins * 60, routeShortName: mode === 'WALK' ? '' : '1' });
  const m = legStripModel([L('WALK', 7), L('COACH', 120), L('WALK', 16)]);
  assert.ok(m[0].walk && m[0].long, '7-min start walk shown');
  assert.ok(m[m.length - 1].walk && m[m.length - 1].long, '16-min end walk shown');
  const s = legStripModel([L('WALK', 3), L('COACH', 120), L('WALK', 4)]);
  assert.ok(!s[0].walk && !s[s.length - 1].walk, 'short end walks trimmed at both ends');
});

import { nearestHub } from '../../js/board.js';
test('nearestHub picks the closest hub within walking reach, else none', () => {
  const hubs = [
    { hubId: 'palermo-centrale', lat: 38.1089, lon: 13.3675 },
    { hubId: 'palermo-airport', lat: 38.1881, lon: 13.1093 },
  ];
  const near = nearestHub(hubs, { lat: 38.1157, lon: 13.3615 });
  assert.strictEqual(near.hub.hubId, 'palermo-centrale');
  assert.ok(near.d > 800 && near.d < 1000, `~900 m, got ${near.d}`);
  assert.strictEqual(nearestHub(hubs, { lat: 37.31, lon: 13.58 }), null, 'Agrigento: no hub');
  assert.strictEqual(nearestHub([], { lat: 38.1, lon: 13.3 }), null);
});

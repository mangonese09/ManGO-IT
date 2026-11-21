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

// SAIS Trasporti OD fares (harvested costo) + stop→city resolver.
import { test } from 'node:test';
import assert from 'node:assert';
import { saisOdFare, saisLocality, SAIS_OD } from '../../js/fares-od.js';

test('saisLocality resolves a feed stop to its city by prefix', () => {
  assert.strictEqual(saisLocality('AGRIGENTO (P.le Rosselli)'), 'AGRIGENTO');
  assert.strictEqual(saisLocality('CATANIA Zona Industriale'), 'CATANIA');
  assert.strictEqual(saisLocality('Nowhereville 12'), null);
});

test('saisOdFare returns the harvested city-pair price', () => {
  assert.strictEqual(saisOdFare('AGRIGENTO (P.le Rosselli)', 'CATANIA Centrale'), 13.1);
  assert.strictEqual(saisOdFare('Agrigento', 'Caltanissetta'), 6.3);
});

test('saisOdFare is null for same city or an unknown pair', () => {
  assert.strictEqual(saisOdFare('Agrigento', 'Agrigento'), null);
  assert.strictEqual(saisOdFare('Agrigento', 'Nowhereville'), null);
  assert.ok(Object.keys(SAIS_OD).length > 1000, 'OD table is populated');
});

// Place-icon resolution (v0.24.0): favourite trip endpoints show a mango-styled
// icon — an explicit pick wins, Home defaults to the house, else the pin.
import { test } from 'node:test';
import assert from 'node:assert';
import { placeIconKey, PLACE_ICONS } from '../../js/ui.js';

test('placeIconKey: explicit valid icon always wins', () => {
  assert.strictEqual(placeIconKey({ icon: 'gym' }), 'gym');
  assert.strictEqual(placeIconKey({ icon: 'coffee', home: true }), 'coffee'); // pick beats home
});

test('placeIconKey: Home with no pick → house, plain place → pin', () => {
  assert.strictEqual(placeIconKey({ home: true }), 'home');
  assert.strictEqual(placeIconKey({}), 'pin');
  assert.strictEqual(placeIconKey(null), 'pin');
});

test('placeIconKey: unknown icon key falls back (never a broken image)', () => {
  assert.strictEqual(placeIconKey({ icon: 'zzz' }), 'pin');
  assert.strictEqual(placeIconKey({ icon: 'zzz', home: true }), 'home');
});

test('PLACE_ICONS set is the expected mango set, pin present as the default', () => {
  const keys = PLACE_ICONS.map((i) => i.key);
  assert.deepStrictEqual(keys,
    ['home', 'work', 'pin', 'coffee', 'food', 'friend', 'gym', 'school', 'shopping']);
  assert.ok(keys.includes('pin'));
});

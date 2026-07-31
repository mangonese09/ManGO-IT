// Fare model + rendering helpers (review §4). No fabricated numbers: flats show
// the price, counter/booking show honest text.
import { test } from 'node:test';
import assert from 'node:assert';
import { operatorFor, fareChip, fareSummary, eur, OPERATORS } from '../../js/operators.js';

test('eur formats euros to 2dp', () => {
  assert.strictEqual(eur(1.4), '€1.40');
  assert.strictEqual(eur(13.1), '€13.10');
});

test('operatorFor matches the city-bus + new operators', () => {
  assert.strictEqual(operatorFor('AMAT').name, 'AMAT Palermo');
  assert.strictEqual(operatorFor('Azienda Municipalizzata Trasporti Catania AMTS').name, 'AMTS Catania');
  assert.strictEqual(operatorFor('TUA').name, 'TUA Agrigento');
  assert.strictEqual(operatorFor('Cuffaro').name, 'Cuffaro');
  assert.strictEqual(operatorFor('Autolinee Lumia').name, 'Autolinee Lumia');
  assert.strictEqual(operatorFor('unknown op'), null);
});

test('fareChip: flat → exact number; counter/booking → honest word, never a price', () => {
  assert.deepStrictEqual(fareChip(operatorFor('AMAT')), { state: 'exact', text: '€1.40', sub: '90 min' });
  assert.deepStrictEqual(fareChip(operatorFor('Lumia')), { state: 'counter', text: 'From driver' });
  assert.deepStrictEqual(fareChip(operatorFor('Trenitalia')), { state: 'muted', text: 'At booking' });
  assert.strictEqual(fareChip(null), null);
});

test('city buses carry exact flat fares (the confirm-it-covers-city-buses check)', () => {
  for (const n of ['AMAT', 'AMTS', 'Circumetnea', 'TUA']) {
    const f = operatorFor(n).fare;
    assert.strictEqual(f.kind, 'flat', `${n} should be a flat fare`);
    assert.ok(typeof f.single === 'number' && f.single > 0, `${n} has a numeric single fare`);
  }
});

test('fareSummary: flat lists price + passes; pass hint only fires with 2+ legs', () => {
  const amat = operatorFor('AMAT');
  const one = fareSummary(amat, 1);
  assert.ok(one.lines[0].includes('€1.40') && one.lines[0].includes('onboard'));
  assert.ok(one.lines.some((l) => l.includes('Day €3.50')));
  assert.strictEqual(one.passHint, null, 'no hint for a single leg');
  const two = fareSummary(amat, 2);
  assert.ok(two.passHint && two.passHint.includes('€3.50'), 'hint appears for a round trip');
});

test('fareSummary: counter/booking surface the note, no number invented', () => {
  const lumia = fareSummary(operatorFor('Lumia'));
  assert.ok(lumia.lines[0].toLowerCase().includes('driver'));
  const cuffaro = fareSummary(operatorFor('Cuffaro'));
  assert.ok(cuffaro.lines[0].includes('€8.60')); // published corridor price stated as text
});

test('every operator entry with a fare carries asOf', () => {
  for (const o of OPERATORS) {
    if (o.fare) assert.ok(o.fare.asOf, `${o.name} fare missing asOf`);
  }
});

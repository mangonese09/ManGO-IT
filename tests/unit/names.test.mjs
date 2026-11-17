// Display-casing of ALL-CAPS feed stop names (v0.9.5).
import { test } from 'node:test';
import assert from 'node:assert';
import { displayName, cleanRouteName } from '../../js/names.js';

const cases = [
  // all-caps feed names get title-cased
  ['CALTANISSETTA XIRBI', 'Caltanissetta Xirbi'],
  ['PALERMO CENTRALE', 'Palermo Centrale'],
  ['ENNA', 'Enna'],
  ['SAN MARCO via Calvario', 'San Marco via Calvario'],
  // already-clean names pass through untouched
  ['Palermo Lolli', 'Palermo Lolli'],
  ['Catania Aer.Font', 'Catania Aeroporto Fontanarossa'], // feed abbreviation expanded (v0.42.0)
  ['Trapani (Papa Giovanni Paolo II)', 'Trapani (Papa Giovanni Paolo II)'],
  // roman numerals survive; lowercase words inside parens are respected
  ['CATANIA (piazza Giovanni XXIII)', 'Catania (piazza Giovanni XXIII)'],
  ['VITTORIO EMANUELE III', 'Vittorio Emanuele III'],
  // apostrophes, dots, hyphens, parens capitalize each segment
  ["DELL'OVA COPERNICO", "Dell'Ova Copernico"],
  ['RAFFADALI-AGRIGENTO', 'Raffadali-Agrigento'],
  ['BV. IAZZOTTO', 'Bv. Iazzotto'],
  ['(PIAZZA MARINA)', '(Piazza Marina)'],
  ['PALERMO (via P. Balsamo)', 'Palermo (via P. Balsamo)'],
  // attached parentheticals: the all-caps half is cased, mixed half untouched
  ['CALTANISSETTA(Via Rochester)', 'Caltanissetta(Via Rochester)'],
  ['GELA(AUTOSTAZIONE)', 'Gela(Autostazione)'],
  // digit tokens, initials and road sigle keep their caps
  ['S.S.113 KM 90', 'S.S.113 Km 90'],
  ['VIA E. BASILE', 'Via E. Basile'],
  ['STAZIONE FS', 'Stazione FS'],
  // particles lowercase mid-name, capitalized when leading
  ['CORSO DELLE PROVINCE', 'Corso delle Province'],
  ['DI MARTINO', 'Di Martino'],
  // accented caps
  ['SANTA MARIA DI GESÙ', 'Santa Maria di Gesù'],
  // empty / null safe
  ['', ''],
  [null, ''],
];

for (const [input, want] of cases) {
  test(`displayName(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, () => {
    assert.strictEqual(displayName(input), want);
  });
}

// Route/line label tidy (map trace legend).
const routeCases = [
  ['0 Aragona - -Raffadali', 'Aragona – Raffadali'],   // leading-0 + doubled dash
  ['Raffadali - Eraclea MI', 'Raffadali – Eraclea MI'], // spaced hyphen → en-dash
  ['S. Elisabetta - Palermo', 'S. Elisabetta – Palermo'], // no mid-word truncation
  ['109', '109'],                                        // bare route number untouched
  ['N2', 'N2'],
  ['', ''],
  [null, ''],
];
for (const [input, want] of routeCases) {
  test(`cleanRouteName(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, () => {
    assert.strictEqual(cleanRouteName(input), want);
  });
}

test('displayName expands feed abbreviations (Aer.Font)', () => {
  assert.strictEqual(displayName('Catania Aer.Font'), 'Catania Aeroporto Fontanarossa');
  assert.strictEqual(displayName('CATANIA AER.FONT'), 'Catania Aeroporto Fontanarossa');
});

// v1.14.0: a two-way line name reads in the direction of travel
import { directionalRouteName } from '../../js/names.js';
test('directionalRouteName flips a place list toward the destination, and nothing else', () => {
  assert.strictEqual(directionalRouteName('Agrigento - Palermo', 'Agrigento'), 'Palermo – Agrigento');
  assert.strictEqual(directionalRouteName('AGRIGENTO - PALERMO', 'AGRIGENTO (P.LE ROSSELLI)'), 'Palermo – Agrigento');
  assert.strictEqual(directionalRouteName('Palermo - Agrigento', 'Agrigento'), 'Palermo – Agrigento');
  // destination is neither end: leave the filed order
  assert.strictEqual(directionalRouteName('Agrigento - Palermo', 'Lercara Friddi'), 'Agrigento – Palermo');
  // not a place list: untouched, casing included
  assert.strictEqual(directionalRouteName('REG 22012', 'Agrigento Centrale'), 'REG 22012');
  assert.strictEqual(directionalRouteName('109', 'Stazione Centrale'), '109');
  assert.strictEqual(directionalRouteName('', 'Agrigento'), '');
});

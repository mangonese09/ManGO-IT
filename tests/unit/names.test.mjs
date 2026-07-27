// Display-casing of ALL-CAPS feed stop names (v0.9.5).
import { test } from 'node:test';
import assert from 'node:assert';
import { displayName } from '../../js/names.js';

const cases = [
  // all-caps feed names get title-cased
  ['CALTANISSETTA XIRBI', 'Caltanissetta Xirbi'],
  ['PALERMO CENTRALE', 'Palermo Centrale'],
  ['ENNA', 'Enna'],
  ['SAN MARCO via Calvario', 'San Marco via Calvario'],
  // already-clean names pass through untouched
  ['Palermo Lolli', 'Palermo Lolli'],
  ['Catania Aer.Font', 'Catania Aer.Font'],
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

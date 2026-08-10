// v1.4.0 pro-benchmark round — pure helpers behind F-2 (grouped boards),
// F-3 (rail-replacement labels), F-10 (display-name cosmetics).
globalThis.document = {
  createElement: () => ({
    className: '', textContent: '', innerHTML: '',
    setAttribute() {}, addEventListener() {}, appendChild() {},
  }),
  addEventListener() {}, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

import { test } from 'node:test';
import assert from 'node:assert';
const { groupRuns, thenText } = await import('../../js/saved.js');
const { railReplacementLabel, displayName } = await import('../../js/names.js');

// ── F-2: groupRuns ──

const run = (line, head, t, extra = {}) => ({ line, headsign: head, mode: 'BUS', timeISO: t, ...extra });

test('same line+direction collapses into one group, order preserved', () => {
  const g = groupRuns([
    run('N4', 'Sarullo', '04:24'), run('N7', 'Pomara', '04:32'), run('N4', 'Sarullo', '04:55'),
  ], (r) => `${r.mode}|${r.line}|${r.headsign}`);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].first.timeISO, '04:24');
  assert.deepStrictEqual(g[0].rest.map((r) => r.timeISO), ['04:55']);
  assert.strictEqual(g[1].first.line, 'N7');
});

test('live and cancelled runs stay standalone rows', () => {
  const g = groupRuns([
    run('N4', 'Sarullo', '04:24'), run('N4', 'Sarullo', '04:55', { realtime: true }), run('N4', 'Sarullo', '05:25'),
  ], (r) => `${r.line}|${r.headsign}`, (r) => !r.realtime && !r.cancelled);
  // the live 04:55 must NOT vanish into the 04:24 group
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g[0].rest.map((r) => r.timeISO), ['05:25']);
  assert.strictEqual(g[1].first.realtime, true);
});

test('thenText caps and counts the tail', () => {
  assert.strictEqual(thenText(['04:55']), 'then 04:55');
  assert.strictEqual(thenText(['04:55', '05:25', '06:10', '07:00']), 'then 04:55 · 05:25 · 06:10 +1 more');
  assert.strictEqual(thenText([]), '');
});

// ── F-3: railReplacementLabel ──

test('a nameless Trenitalia BUS is a rail replacement run', () => {
  assert.strictEqual(railReplacementLabel('BUS', 'it-trenitalia_IT::Trip:x', ''), 'Rail replacement bus');
  assert.strictEqual(railReplacementLabel('BUS', 'it-trenitalia_IT::Trip:x', 'BUS'), 'Rail replacement bus');
});

test('named buses, other feeds and coaches are untouched', () => {
  assert.strictEqual(railReplacementLabel('BUS', 'it-trenitalia_IT::Trip:x', 'N4'), null);
  assert.strictEqual(railReplacementLabel('BUS', 'it-amat_palermo::Trip:y', ''), null);
  assert.strictEqual(railReplacementLabel('COACH', 'it-trenitalia_IT::Trip:x', ''), null);
});

// ── F-10: display cosmetics ──

test("ALL-CAPS trailing apostrophes become accents (CEFALU' → Cefalù)", () => {
  assert.strictEqual(displayName("CEFALU'"), 'Cefalù');
  assert.strictEqual(displayName("FORZA D'AGRO'"), "Forza D'Agrò");
});

test('real interior apostrophes survive', () => {
  assert.strictEqual(displayName("Sant'Agata"), "Sant'Agata");
});

test('a hyphen glued to the left word gets its space back', () => {
  assert.strictEqual(displayName('Taormina- C Ainis'), 'Taormina - C Ainis');
});

test('doubled spaces collapse', () => {
  assert.strictEqual(displayName('Palermo  Centrale'), 'Palermo Centrale');
});

// ── v1.6.0: Autolinee SAL gets its verified site; 'sal' alone must not match ──
const { operatorFor } = await import('../../js/operators.js');
test('Autolinee SAL matches its operator entry with the verified website', () => {
  const op = operatorFor('Autolinee SAL');
  assert.ok(op && op.website === 'https://www.autolineesal.it', JSON.stringify(op && op.name));
});
test("the bare letters 'sal' inside other agency names do not match SAL", () => {
  assert.notStrictEqual(operatorFor('Autolinee Salemi')?.name, 'Autolinee SAL');
  assert.notStrictEqual(operatorFor('SAIS Autolinee')?.name, 'Autolinee SAL');
});

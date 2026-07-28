// ── R-02 verification: does tapping Depart / Arrive by / the when-chip wipe a picked date? ──
// The blocker was an unscoped .field-clear::after halo resolving against .when-row,
// painting the reset button over the whole row. Usage: node qa/scripts/verify-r02.mjs [url]
import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';

const TARGET = process.argv[2] || 'https://it.mangonese.dev';
const findings = [];
const log = (id, ok, note) => { findings.push({ id, ok, note }); console.log(ok ? ' ok ' : 'FAIL', id, '—', note); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: 'networkidle' });
await page.click('#nav-home');            // view persistence restores the last tab
await page.waitForSelector('#when-display');

// Set a date the way the app does: the native input drives the chip.
const pick = '2026-08-14T09:30';
await page.$eval('#when-input', (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, pick);
await page.waitForTimeout(200);

const chipAfterPick = await page.textContent('#when-display');
log('R02-setup', chipAfterPick.trim() !== 'Now', `chip reads "${chipAfterPick.trim()}" after picking ${pick}`);

// What actually receives a tap at the centre of each control?
const hits = await page.evaluate(() => {
  const out = {};
  for (const id of ['when-toggle', 'when-display']) {
    const r = document.getElementById(id).getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out[id] = el ? (el.id || el.className || el.tagName) : null;
  }
  return out;
});
log('R02-hittest', hits['when-toggle'] === 'when-toggle' && hits['when-display'] === 'when-display',
  `elementFromPoint: Depart→${hits['when-toggle']}, chip→${hits['when-display']}`);

// The real confirmation: tap Depart, does the date survive?
await page.click('#when-toggle');
await page.waitForTimeout(200);
const chipAfterToggle = await page.textContent('#when-display');
const valAfterToggle = await page.inputValue('#when-input');
log('R02-tap-depart', valAfterToggle === pick,
  `after tapping Depart: input="${valAfterToggle}", chip="${chipAfterToggle.trim()}"`);

// And the toggle itself should have flipped mode (R-01: aria-pressed present).
const toggleState = await page.evaluate(() => {
  const b = document.getElementById('when-toggle');
  return { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') };
});
log('R01-toggle', toggleState.text === 'Arrive by' && toggleState.pressed !== null,
  `toggle now "${toggleState.text}", aria-pressed=${toggleState.pressed}`);

// Tap it back, date must still survive a second tap.
await page.click('#when-toggle');
await page.waitForTimeout(200);
const valAfterSecond = await page.inputValue('#when-input');
log('R02-tap-twice', valAfterSecond === pick, `input after second tap: "${valAfterSecond}"`);

// The reset button should still work when tapped deliberately.
const clearVisible = await page.isVisible('#when-clear');
if (clearVisible) {
  await page.click('#when-clear');
  await page.waitForTimeout(200);
  const chipAfterClear = await page.textContent('#when-display');
  log('R02-clear-works', chipAfterClear.trim() === 'Now', `chip after deliberate reset: "${chipAfterClear.trim()}"`);
} else {
  log('R02-clear-works', false, 'reset button never became visible with a date set');
}

await page.screenshot({ path: 'qa/shots/r02-when-row.png' });
await browser.close();

const failed = findings.filter((f) => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} passed`);
process.exit(failed.length ? 1 : 0);

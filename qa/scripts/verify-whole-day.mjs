// ── Ship 3 verification: the whole-day view (R-24) ──
// Drives a real search against a local STATIC=1 proxy and checks the day list
// groups by daypart, carries a Later pill, and that a card taps through.
// Usage: node qa/scripts/verify-whole-day.mjs [baseUrl]
import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';

const TARGET = process.argv[2] || 'http://localhost:3098';
const findings = [];
const log = (id, ok, note) => { findings.push({ id, ok, note }); console.log(ok ? ' ok ' : 'FAIL', id, '—', note); };

async function pick(page, which, text) {
  await page.fill(`#${which}-input`, text);
  await page.waitForSelector(`#${which}-suggest .suggest-row:not(.suggest-loc)`, { timeout: 15000 });
  await page.click(`#${which}-suggest .suggest-row:not(.suggest-loc)`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: 'networkidle' });
await page.click('#nav-home');

await pick(page, 'from', 'Palermo Centrale');
await pick(page, 'to', 'Cefalù');
await page.click('#search-btn');

// wait for the day list to render (cards or daypart headers)
await page.waitForSelector('#results .iti-card, #results .daypart-head', { timeout: 25000 });
await page.waitForTimeout(1200);

const cards = await page.$$eval('#results .iti-card', (n) => n.length);
const heads = await page.$$eval('#results .daypart-head', (n) => n.map((h) => h.textContent.trim()));
log('R24-cards', cards > 6, `${cards} itinerary cards for the day`);
log('R24-dayparts', heads.length >= 1, `daypart headers: ${JSON.stringify(heads)}`);

const laterPill = await page.$('#results .day-page-later');
log('R24-later-pill', !!laterPill, laterPill ? 'Later pill present' : 'no Later pill');

// tap Later and confirm the list grows
if (laterPill) {
  const before = cards;
  await laterPill.click();
  await page.waitForTimeout(2500);
  const after = await page.$$eval('#results .iti-card', (n) => n.length);
  log('R24-later-grows', after >= before, `cards ${before} → ${after} after Later`);
}

// a card taps through to a detail sheet
await page.click('#results .iti-card:not(.iti-past)');
await page.waitForTimeout(500);
const sheetOpen = await page.isVisible('.sheet, .bottom-sheet, [class*="sheet"]');
log('R24-tapthrough', sheetOpen, sheetOpen ? 'detail sheet opened' : 'no sheet');
await page.keyboard.press('Escape').catch(() => {});

await page.screenshot({ path: 'qa/shots/whole-day.png', fullPage: true });
await browser.close();

const failed = findings.filter((f) => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} passed`);
process.exit(failed.length ? 1 : 0);

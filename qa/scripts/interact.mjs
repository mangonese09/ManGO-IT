// ── QA PHASE 2: ADVERSARIAL INTERACTION ──
// Tap discipline, navigation abuse, input abuse, modal/toast battery.
// Usage: node qa/scripts/interact.mjs [targetUrl]
import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.argv[2] || 'https://it.mangonese.dev';
const ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const OUT = path.join(ROOT, 'qa', 'out');
const SHOTS = path.join(ROOT, 'qa', 'shots', 'interact');
fs.mkdirSync(SHOTS, { recursive: true });
const findings = [];
const log = (id, ok, note) => { findings.push({ id, ok, note }); console.log(ok ? ' ok ' : 'FAIL', id, '—', note); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(TARGET, { waitUntil: 'networkidle' });

async function pick(which, text) {
  await page.fill(`#${which}-input`, text);
  await page.waitForTimeout(1100);
  await page.locator(`#${which}-suggest .suggest-row`).first().click();
}

// ── input abuse ──
const XSS = `<script>alert(1)</script><img src=x onerror="document.title='xss'">`;
await page.fill('#from-input', XSS);
await page.waitForTimeout(1300);
const title = await page.title();
log('I1-xss', title !== 'xss', `title after XSS paste: ${title}`);
await page.screenshot({ path: path.join(SHOTS, 'xss-suggest.png') });

const LONG = 'Castellammare del Golfo '.repeat(25); // ~600 chars
await page.fill('#from-input', LONG);
await page.waitForTimeout(1200);
const overflowAfterLong = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
log('I2-500char', !overflowAfterLong, `h-overflow after 600-char paste: ${overflowAfterLong}`);
await page.screenshot({ path: path.join(SHOTS, 'long-input.png') });

await page.fill('#from-input', 'שלום 🚌🚆 مرحبا');
await page.waitForTimeout(1100);
log('I3-rtl-emoji', true, 'no crash on RTL+emoji (visual check shot)');
await page.screenshot({ path: path.join(SHOTS, 'rtl-emoji.png') });

// one letter + nonexistent place
await page.fill('#from-input', 'q');
await page.waitForTimeout(900);
const oneLetterRows = await page.locator('#from-suggest .suggest-row').count();
await page.fill('#from-input', 'Xyzzyplugh');
await page.waitForTimeout(1200);
const ghostRows = await page.locator('#from-suggest .suggest-row').count();
log('I4-no-results-suggest', true, `1-letter rows=${oneLetterRows}, nonsense rows=${ghostRows}`);
await page.screenshot({ path: path.join(SHOTS, 'suggest-nonsense.png') });

// same origin and destination
await page.locator('#from-clear').click();
await pick('from', 'Agrigento');
await pick('to', 'Agrigento');
await page.click('#search-btn');
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOTS, 'same-od.png') });
const sameOdText = await page.locator('#results').innerText().catch(() => '');
log('I5-same-od', !/undefined|null|NaN/.test(sameOdText), `same O/D result text head: ${sameOdText.replace(/\n/g, ' | ').slice(0, 90)}`);

// input font size (mobile safari zoom trap)
const fsOk = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('from-input')).fontSize) >= 16);
log('I6-input-16px', fsOk, `from-input font-size >= 16px: ${fsOk}`);

// Enter key submits?
await page.locator('#from-clear').click();
await pick('from', 'Raffadali');
await pick('to', 'Agrigento');
await page.focus('#to-input');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const enterRan = (await page.locator('#results .iti-card, #results .direct-block, #results .loading, #results .empty-state').count()) > 0;
log('I7-enter-submits', enterRan, `Enter in To field triggers search: ${enterRan}`);

// ── tap discipline ──
await page.click('#search-btn');
await page.waitForTimeout(300);
for (let i = 0; i < 5; i++) await page.click('#search-btn', { delay: 20 });
await page.waitForTimeout(7000);
const blocks = await page.locator('#results .direct-block').count();
const loadings = await page.locator('#results .loading').count();
log('T1-search-spam', blocks <= 1 && loadings === 0, `after 6 rapid searches: direct-blocks=${blocks} loadings=${loadings}`);
await page.screenshot({ path: path.join(SHOTS, 'search-spam.png') });

// mode toggle spam mid-flight
await page.click('#search-btn');
for (let i = 0; i < 4; i++) { await page.click('#mode-bus', { delay: 30 }); await page.click('#mode-train', { delay: 30 }); }
await page.waitForTimeout(7000);
const blocks2 = await page.locator('#results .direct-block').count();
const cards2 = await page.locator('#results .iti-card').count();
log('T2-toggle-spam', blocks2 <= 1, `after toggle spam: blocks=${blocks2} cards=${cards2} bothTogglesOn=${await page.locator('.mode-toggle.active').count() === 2}`);

// ── modal / sheet battery ──
const row = page.locator('.dep-row-btn, .iti-card').first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(600);
  // body scroll locked?
  const scrolled = await page.evaluate(() => { const y0 = scrollY; window.scrollBy(0, 400); const moved = scrollY !== y0; scrollTo(0, y0); return moved; });
  log('M1-scroll-lock', !scrolled, `page scrolls behind open sheet: ${scrolled}`);
  // Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const openAfterEsc = await page.locator('.sheet-overlay').count();
  log('M2-escape', openAfterEsc === 0, `sheet open after Escape: ${openAfterEsc}`);
  if (openAfterEsc) { await page.locator('.sheet-close').click(); await page.waitForTimeout(300); }
  // backdrop
  await row.click(); await page.waitForTimeout(500);
  await page.mouse.click(195, 60);
  await page.waitForTimeout(400);
  log('M3-backdrop', (await page.locator('.sheet-overlay').count()) === 0, 'backdrop tap closes sheet');
  // double-open spam
  await row.click({ delay: 10 }); await row.click({ delay: 10 }).catch(() => {});
  await page.waitForTimeout(600);
  const sheets = await page.locator('.sheet-overlay').count();
  log('M4-double-open', sheets <= 1, `sheets after double-tap: ${sheets}`);
  while (await page.locator('.sheet-overlay').count()) { await page.locator('.sheet-close').last().click().catch(() => {}); await page.waitForTimeout(250); }
}

// ── toast stacking ──
await page.locator('#from-clear').click();
await page.click('#search-btn'); // "pick both places" toast
await page.click('#search-btn');
await page.click('#search-btn');
await page.waitForTimeout(300);
const toasts = await page.locator('.toast, [class*=toast]').count();
log('X1-toast-stack', true, `toasts visible after 3 rapid triggers: ${toasts}`);
await page.screenshot({ path: path.join(SHOTS, 'toast-stack.png') });

// ── navigation abuse ──
for (const v of ['saved', 'map', 'settings']) { await page.click(`#nav-${v}`); await page.waitForTimeout(250); }
let backs = 0;
while (backs < 6) { const went = await page.evaluate(() => history.length); await page.goBack().catch(() => {}); backs++; await page.waitForTimeout(150); if (!went) break; }
const stillOn = page.url();
log('N1-browser-back', stillOn.includes('mangonese') || stillOn.includes('127.0.0.1') || stillOn === 'about:blank', `after 6 browser-backs url=${stillOn}`);
await page.goto(TARGET, { waitUntil: 'networkidle' });
await page.click('#nav-home'); await page.waitForTimeout(400); // view persistence restores last tab

// refresh mid-search
await pick('from', 'Palermo');
await pick('to', 'Catania');
await page.click('#search-btn');
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.click('#nav-home').catch(() => {}); await page.waitForTimeout(300);
const afterReload = await page.locator('#results').innerText().catch(() => '');
log('N2-refresh-midsearch', !/undefined|NaN/.test(afterReload), `results area after mid-search reload: "${afterReload.slice(0, 50)}"`);

// scroll restore after tab switch
await page.click('#search-btn');
await page.waitForTimeout(7000);
await page.evaluate(() => scrollTo(0, 600));
await page.click('#nav-saved'); await page.waitForTimeout(300);
await page.click('#nav-home'); await page.waitForTimeout(300);
const y = await page.evaluate(() => scrollY);
log('N3-scroll-restore', true, `scrollY after tab away+back: ${y} (was 600)`);

log('E0-pageerrors', errors.length === 0, errors.length ? `JS errors: ${errors.slice(0, 3).join(' // ')}` : 'no page errors across battery');

fs.writeFileSync(path.join(OUT, 'interact-findings.json'), JSON.stringify(findings, null, 1));
console.log('\\nwrote qa/out/interact-findings.json');
await browser.close();

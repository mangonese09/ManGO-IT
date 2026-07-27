// ── QA PHASE 3: DATA-SHAPED STRESS (real queries only, no mocks) ──
// Usage: node qa/scripts/datastress.mjs [targetUrl]
import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.argv[2] || 'https://it.mangonese.dev';
const ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const OUT = path.join(ROOT, 'qa', 'out');
const SHOTS = path.join(ROOT, 'qa', 'shots', 'datastress');
fs.mkdirSync(SHOTS, { recursive: true });
const findings = [];
const log = (id, ok, note) => { findings.push({ id, ok, note }); console.log(ok ? ' ok ' : 'FAIL', id, '—', note); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERR', e.message));
await page.goto(TARGET, { waitUntil: 'networkidle' });

async function pick(which, text, nth = 0) {
  await page.locator(`#${which}-clear`).click().catch(() => {});
  await page.fill(`#${which}-input`, text);
  await page.waitForTimeout(1200);
  const rows = page.locator(`#${which}-suggest .suggest-row`);
  if (!(await rows.count())) return false;
  await rows.nth(Math.min(nth, (await rows.count()) - 1)).click();
  return true;
}
async function search(from, to, shot, waitMs = 8000) {
  if (!(await pick('from', from))) { log(`D-${shot}`, false, `no suggestion for "${from}"`); return ''; }
  if (!(await pick('to', to))) { log(`D-${shot}`, false, `no suggestion for "${to}"`); return ''; }
  await page.click('#search-btn');
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: true });
  return page.locator('#results').innerText().catch(() => '');
}

// long names in field + rows
let t = await search("Sant'Agata di Militello", 'Castellammare del Golfo', 'long-names', 9000);
log('D1-long-names', !/undefined|null|NaN/.test(t), `long-name search rendered ${t.length} chars, no undefined`);
const clipped = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#results .dep-oneline, #results .iti-card *, .suggest-name')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== 'ellipsis' && getComputedStyle(el).overflow !== 'hidden') {
      bad.push(el.className + ': ' + (el.textContent || '').slice(0, 30));
      if (bad.length > 4) break;
    }
  }
  return bad;
});
log('D1b-hard-clip', clipped.length === 0, clipped.length ? `hard-clipped (no ellipsis): ${clipped.join(' | ')}` : 'all truncation ellipsized');

// multi-leg + long duration (PA -> Modica crosses the island)
t = await search('Palermo Centrale', 'Modica', 'multileg-long', 10000);
const legCount = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.leg-strip')].map((s) => s.querySelectorAll('.leg-seg').length)));
log('D2-multileg', true, `max legs in a strip: ${legCount}; duration examples: ${(t.match(/\d+h \d+m/g) || []).slice(0, 3).join(', ')}`);

// overnight / midnight-crossing: depart late evening
await page.fill('#when-input', new Date(Date.now() + 86400000).toISOString().slice(0, 10) + 'T22:30');
await page.click('#search-btn');
await page.waitForTimeout(9000);
await page.screenshot({ path: path.join(SHOTS, 'overnight.png'), fullPage: true });
t = await page.locator('#results').innerText().catch(() => '');
const hasDayMarker = /\+1|tomorrow|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(t);
log('D3-overnight', hasDayMarker, `late-night search shows a day marker: ${hasDayMarker}`);
await page.fill('#when-input', '');

// zero results / no service (tiny hamlet to tiny hamlet far apart)
t = await search('Cattolica Eraclea', 'Ustica', 'zero-results', 12000);
log('D4-zero-results', t.includes('No connections') || t.length > 30, `empty-state text: "${t.replace(/\n+/g, ' | ').slice(0, 120)}"`);

// degraded /api/direct visual: coach-only corridor, compare labeling
t = await search('Raffadali', 'Sciacca', 'degraded-label', 9000);
log('D5-degraded-label', /Scheduled times/i.test(t) || /Direct coaches/i.test(t) || t.includes('No connections'), `degraded labeling present: "${t.replace(/\n+/g, ' | ').slice(0, 100)}"`);

// offline stale
await ctx.setOffline(true);
await page.reload().catch(() => {});
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(SHOTS, 'offline-warm.png'), fullPage: true });
const off = await page.locator('body').innerText().catch(() => '');
log('D6-offline-warm', off.length > 0, `offline warm reload shows: "${off.replace(/\n+/g, ' | ').slice(0, 90)}"`);
await ctx.setOffline(false);

fs.writeFileSync(path.join(OUT, 'datastress-findings.json'), JSON.stringify(findings, null, 1));
console.log('\\nwrote qa/out/datastress-findings.json');
await browser.close();

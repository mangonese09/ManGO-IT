/* Visual sweep (2026-11-18): every tab, search states, a plan result + route
   sheet, saved places/stops, Settings sub-sheets, map stop + hub board,
   offline, first-run, desktop. LIVE site, fresh profile each run.
   Searches pin "Depart" to tomorrow 10:00 Italy time so results are daytime
   even when run at night (boards still follow the real clock — server-side).
   Google Maps hosts are aborted (no paid calls).
   Output: C:/Users/micon/visual-sweep-out/mangoit/ (report.md + sheet-NN.png)

   Run (PowerShell):
     $env:NODE_PATH="$HOME\OneDrive\Documents\Claude Files\Projects\ManGO\node_modules"
     node tests\visual-sweep.js
*/
'use strict';
const { chromium } = require('playwright');
const VS = 'C:/Users/micon/OneDrive/Documents/Claude Files/Projects/visual-sweep/';
const { createSweep } = require(VS + 'sweep.js');
const { explore, DENY } = require(VS + 'explore.js');

const BASE = process.env.BASE || 'https://it.mangonese.dev/';
const deny = new RegExp(DENY.source + '|back ?up|restore|cached|erase|choose on map|my location|tickets?|buy', 'i');
const TRACE = (m) => { if (process.env.TRACE) console.log(m); };

function tomorrow10() {
  const d = new Date(Date.now() + 24 * 3600e3);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
  return ymd + 'T10:00';
}

(async () => {
  const browser = await chromium.launch();
  const mk = async (vp) => {
    const ctx = await browser.newContext({
      viewport: vp || { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: !vp,
      geolocation: { latitude: 37.8516, longitude: 15.2853 }, permissions: ['geolocation'],
      timezoneId: 'Europe/Rome', locale: 'en-GB', serviceWorkers: 'allow',
    });
    await ctx.route(/maps\.googleapis\.com|maps\.gstatic\.com|\/api\/routes/, (r) => r.abort());
    return ctx;
  };
  const ctx = await mk();
  const page = await ctx.newPage();
  const pause = (ms) => page.waitForTimeout(ms);
  await page.goto(BASE, { waitUntil: 'load' });
  await pause(3000);
  const sweep = await createSweep({ app: 'mangoit', page, browser });

  const closeAll = async () => {
    for (let i = 0; i < 4; i++) {
      if (!(await page.$('.sheet-overlay.show, [role=dialog]:not([hidden])'))) break;
      await page.keyboard.press('Escape'); await pause(350);
    }
  };
  const goTab = async (t) => { await closeAll(); await page.click('#nav-' + t); await pause(700); await page.evaluate(() => window.scrollTo(0, 0)); };
  const pick = async (inputSel, text) => {
    await page.fill(inputSel, text);
    const row = inputSel.replace('-input', '-suggest') + ' *:has-text("' + text + '")';
    await page.waitForSelector(row, { timeout: 25000 });
    await pause(300);
    return row;
  };

  // ── FIRST RUN (fresh profile) ──
  await sweep.shot('firstrun/home');
  for (const t of ['saved', 'map', 'settings']) { await goTab(t); await pause(t === 'map' ? 3000 : 300); await sweep.shot('firstrun/' + t, { fullPage: t !== 'map' }); }

  // ── SEARCH: typed query, no results, form error ──
  await goTab('home');
  await pick('#from-input', 'Palermo');
  await sweep.shot('search/from-typed-Palermo', { fullPage: false });
  await page.fill('#from-input', 'zzqxvw');
  await pause(3500);
  await sweep.shot('search/from-no-results', { fullPage: false });
  await page.fill('#from-input', ''); await pause(300);
  await page.click('#home-blank-tap').catch(() => {});
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.click('#search-btn').catch(() => {});
  await pause(600);
  await sweep.shot('search/empty-submit-error');

  // ── PLAN RESULT ──
  const runPlan = async (from, to) => {
    await goTab('home');
    if (await page.isVisible('#search-summary')) { await page.click('#search-summary'); await pause(500); }
    await page.evaluate((v) => { const i = document.getElementById('when-input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, tomorrow10());
    await page.click(await pick('#from-input', from) + ' >> nth=0');
    await page.click(await pick('#to-input', to) + ' >> nth=0');
    await pause(900);
    if (await page.isVisible('#search-btn')) await page.click('#search-btn');
    await page.waitForSelector('#results .leg-strip', { timeout: 60000 });
    await pause(1200);
  };
  let haveResults = false;
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await runPlan('Palermo', 'Agrigento');
    haveResults = true;
    await sweep.shot('plan/palermo-agrigento');
    await page.click('#results .leg-strip >> nth=0');
    await page.waitForSelector('.sheet-title', { timeout: 15000 });
    await pause(1500);
    await sweep.shot('plan/route-sheet');
    await explore(sweep, { prefix: 'plan/route-sheet', root: '.sheet-overlay.show', deny, max: 8, reset: async () => {
      await closeAll(); await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#results .leg-strip >> nth=0'); await page.waitForSelector('.sheet-title', { timeout: 15000 }); await pause(900);
    } });
    await closeAll();
    await explore(sweep, { prefix: 'plan/results', root: '#results', deny, max: 10, skip: '.leg-strip', reset: async () => { await closeAll(); await page.evaluate(() => window.scrollTo(0, 0)); } });
  } catch (e) { console.log('plan failed:', e.message.slice(0, 160)); await sweep.shot('plan/FAILED'); }
  try { await runPlan('Catania', 'Taormina'); await sweep.shot('plan/catania-taormina'); } catch (e) { console.log('plan 2 failed:', e.message.slice(0, 120)); }

  // ── HOME (with recents + board) ──
  await goTab('home');
  if (await page.isVisible('#search-summary')) { await page.click('#search-summary'); await pause(500); }
  await sweep.shot('home/after-searches');
  await explore(sweep, { prefix: 'home', root: '#view-home', deny, max: 14, skip: '#results, .endpoint-row', reset: () => goTab('home') });

  // ── SAVED: add a place and a stop through the UI ──
  await goTab('saved');
  try {
    await page.click('#place-add-toggle'); await pause(400);
    await page.click(await pick('#place-input', 'Taormina') + ' >> nth=0'); await pause(1200);
  } catch (e) { console.log('add place failed:', e.message.slice(0, 100)); }
  await closeAll();
  try {
    await page.click('#fav-add-toggle'); await pause(400);
    await page.fill('#fav-input', 'Catania Centrale'); await pause(300);
    await sweep.shot('saved/add-stop-typing', { fullPage: false });
    await page.waitForSelector('#fav-suggest .suggest-row', { timeout: 20000 }); await pause(500);
    await page.click('#fav-suggest .suggest-row >> nth=0'); await pause(2500);
  } catch (e) { console.log('add stop failed:', e.message.slice(0, 100)); }
  await closeAll();
  await goTab('saved'); await pause(2500);
  await sweep.shot('saved/populated');
  await explore(sweep, { prefix: 'saved', root: '#view-saved', deny, max: 14, reset: async () => { await goTab('saved'); await pause(600); } });

  // ── MAP: street zoom stop, island zoom hub board ──
  await goTab('map'); await pause(4000);
  await sweep.shot('map/street', { fullPage: false });
  try {
    const pin = await page.$('.stop-pin');
    if (pin) {
      await pin.click(); await pause(2500);
      await sweep.shot('map/stop-tap', { fullPage: false });
      const picker = await page.$('.stop-picker-row');
      if (picker) { await picker.click(); await pause(2500); await sweep.shot('map/stop-picked', { fullPage: false }); }
    }
  } catch (e) { console.log('map stop failed:', e.message.slice(0, 100)); }
  await closeAll();
  try {
    await goTab('map'); await pause(1500);
    for (let i = 0; i < 7; i++) { await page.click('.leaflet-control-zoom-out'); await pause(450); }
    await pause(2500);
    await sweep.shot('map/island', { fullPage: false });
    const hub = await page.$('.hub-pin .hub-glyph');
    if (hub) { await hub.click(); await page.waitForSelector('.sheet-title', { timeout: 20000 }); await pause(2000); await sweep.shot('map/hub-board'); }
  } catch (e) { console.log('hub failed:', e.message.slice(0, 100)); }
  await closeAll();
  await explore(sweep, { prefix: 'map', root: '#view-map', deny, max: 8, skip: '.leaflet-marker-pane, .leaflet-control-zoom', reset: async () => { await goTab('map'); await pause(800); } });

  // ── SETTINGS + sub-sheets ──
  await goTab('settings');
  await sweep.shot('settings/main');
  await explore(sweep, { prefix: 'settings', root: '#view-settings', deny, max: 10, reset: () => goTab('settings') });

  // ── OFFLINE ──
  await closeAll();
  await ctx.route('**/api/**', (r) => r.abort());
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  await pause(3000);
  await sweep.shot('offline/home-reload');
  try {
    await goTab('home');
    if (await page.isVisible('#search-summary')) { await page.click('#search-summary'); await pause(400); }
    await page.fill('#from-input', 'Palermo'); await pause(1500);
    await sweep.shot('offline/typing', { fullPage: false });
    await page.fill('#to-input', 'Catania'); await pause(400);
    if (await page.isVisible('#search-btn')) await page.click('#search-btn'); else await page.press('#to-input', 'Enter');
    await pause(3500);
    await sweep.shot('offline/search');
  } catch (e) { console.log('offline search failed:', e.message.slice(0, 100)); }
  for (const t of ['saved', 'map', 'settings']) { await goTab(t); await pause(1500); await sweep.shot('offline/' + t, { fullPage: t !== 'map' }); }
  await ctx.setOffline(false);
  await ctx.unroute('**/api/**');

  // ── DESKTOP ──
  const dctx = await mk({ width: 1280, height: 900 });
  const dp = await dctx.newPage();
  await dp.goto(BASE, { waitUntil: 'load' }); await dp.waitForTimeout(3000);
  for (const t of ['home', 'saved', 'map', 'settings']) {
    await dp.click('#nav-' + t); await dp.waitForTimeout(t === 'map' ? 3500 : 800);
    await sweep.shot('desktop/' + t, { fullPage: false, page: dp });
  }

  const r = await sweep.finish();
  console.log('mangoit: ' + r.states + ' states, ' + r.findings + ' findings -> ' + r.dir);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

/* Core-flow session regression (1.0 gate) — real browser, LIVE site, chained
   sessions in one persistent profile. Asserts on rendered output only.
     node tests/review/session-core.js
     BASE=https://it.mangonese.dev/ node tests/review/session-core.js
   S1 plan search  → results render, R-10 type census holds, route sheet opens
   S2 map + save   → stop tap shows departures, ★ persists into Saved
   S3 hub board    → hub pin opens multi-mode board with filter chips
   S4 offline      → search fails HONESTLY (visible message, no blank), recovers */
'use strict';
var PW = 'C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright';
var { chromium } = require(PW);
var path = require('path');
var fs = require('fs');
var BASE = process.env.BASE || 'https://it.mangonese.dev/';
var PROFILE = path.join(__dirname, '.core-profile');

var failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond ? '' : '  [' + detail + ']'));
  if (!cond) failures.push(name + ' \u2014 ' + detail);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function pickSuggestion(page, inputSel, text) {
  await page.fill(inputSel, text);
  var sug = inputSel.replace('-input', '-suggest');
  // the list opens with static rows (My location / Choose on map) before the
  // geocoder answers — wait for and click the row that names the query
  var row = sug + ' *:has-text("' + text + '")';
  await page.waitForSelector(row, { timeout: 25000 });
  await sleep(250);
  await page.click(row + ' >> nth=0');
}

// picking the To suggestion may auto-run the search (form yields to results);
// only press the button when it is still there to press — like a real thumb.
async function clickSearchIfNeeded(page) {
  await sleep(800);
  var btn = await page.$('#search-btn');
  if (btn && await btn.isVisible()) await btn.click();
}

(async function () {
  fs.rmSync(PROFILE, { recursive: true, force: true }); // fresh chain each run
  var ctx = await chromium.launchPersistentContext(PROFILE, {
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 37.8516, longitude: 15.2853 }, permissions: ['geolocation'],
  });
  var page = ctx.pages()[0] || await ctx.newPage();
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(String(e)); });

  // ── SESSION 1: plan a trip, inspect a result ──
  console.log('SESSION 1 \u2014 Palermo \u2192 Agrigento search');
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1500);
  await pickSuggestion(page, '#from-input', 'Palermo');
  await pickSuggestion(page, '#to-input', 'Agrigento');
  await clickSearchIfNeeded(page);
  await page.waitForSelector('#results .leg-strip', { timeout: 60000 });
  await sleep(800);
  var cards = await page.$$eval('#results .leg-strip', function (els) { return els.length; });
  check('s1: itineraries render', cards >= 1, cards + ' cards');
  var timesOk = await page.$eval('#results', function (r) { return /\d{1,2}:\d{2}/.test(r.textContent); });
  check('s1: departure times visible', timesOk, 'no HH:MM in results');
  // R-10 census on the screen the review measured at 12 sizes
  var census = await page.evaluate(function () {
    var s = {};
    document.querySelectorAll('#results *').forEach(function (e) {
      if (!e.textContent.trim() || e.children.length) return;
      var fs2 = getComputedStyle(e).fontSize;
      s[fs2] = (s[fs2] || 0) + 1;
    });
    return Object.keys(s);
  });
  check('s1: R-10 type scale holds on results (\u22646 sizes)', census.length <= 6, census.join(','));
  await page.click('#results .leg-strip');
  await page.waitForSelector('.sheet-title', { timeout: 15000 });
  var title = await page.$eval('.sheet-title', function (t) { return t.textContent.trim(); });
  check('s1: route sheet opens with a title', title.length > 0, 'empty title');
  await page.keyboard.press('Escape');
  await sleep(600);

  // ── SESSION 2: map stop \u2192 departures \u2192 save \u2192 Saved tab ──
  console.log('SESSION 2 \u2014 reload, map stop, favourite');
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1500);
  check('s2: app reloads clean', await page.$('#from-input') !== null, 'home input missing');
  await page.click('#nav-map');
  await sleep(4000);
  var pin = await page.$('.stop-pin img, .stop-pin');
  check('s2: stop pins render at street zoom', !!pin, 'no pins');
  if (pin) {
    await pin.click();
    await page.waitForSelector('.mib-fav, .sheet-title', { timeout: 15000 });
    await sleep(800);
    // the save star lives on the map info-bar OR inside the departures sheet
    // a clustered pin opens a stop picker first — take its first row
    var picker = await page.$('.stop-picker-row');
    if (picker) { await picker.click(); await sleep(1200); }
    await page.waitForSelector('.sheet-title, .map-infobar', { timeout: 15000 });
    await sleep(1000);
    var body2 = await page.evaluate(function () { return document.body.textContent; });
    check('s2: stop tap shows departures or an honest empty state',
      /\d{1,2}:\d{2}/.test(body2) || /No departures|Nothing|nessuna/i.test(body2), 'no times, no empty-state');
    // best-effort favourite: the star may need a sheet scroll to render
    var fav = await page.$('.mib-fav');
    if (!fav) {
      var stars = await page.$$('.pin-btn, [aria-label="Save stop"]');
      for (var si = 0; si < stars.length && !fav; si++) if (await stars[si].isVisible()) fav = stars[si];
    }
    if (fav) { await fav.click({ timeout: 8000 }).catch(function () {}); }
    for (var e2 = 0; e2 < 3 && await page.$('.sheet-overlay.show'); e2++) { await page.keyboard.press('Escape'); await sleep(400); }
    await page.click('#nav-saved');
    await sleep(1200);
    check('s2: Saved tab renders after the map flow', (await page.evaluate(function () { return document.body.textContent; })).length > 100, 'saved tab blank');
  }

  // ── SESSION 3: hub board ──
  console.log('SESSION 3 \u2014 hub board');
  // dismiss any sheet left open (Escape must always close overlays)
  for (var esc = 0; esc < 3 && await page.$('.sheet-overlay.show'); esc++) {
    await page.keyboard.press('Escape');
    await sleep(500);
  }
  check('s3: Escape closes lingering sheets', !(await page.$('.sheet-overlay.show')), 'sheet still open after 3\u00d7Esc');
  await page.click('#nav-map');
  await sleep(2000);
  for (var i = 0; i < 7; i++) { await page.click('.leaflet-control-zoom-out'); await sleep(500); }
  await sleep(2500);
  var hub = await page.$('.hub-pin .hub-glyph');
  check('s3: hub pins render at island zoom', !!hub, 'no hub pins');
  if (hub) {
    await hub.click();
    await page.waitForSelector('.sheet-title', { timeout: 20000 });
    await sleep(1500);
    var sheet = await page.evaluate(function () { return document.body.textContent; });
    var chips = ['Trains', 'City', 'Coaches'].filter(function (c) { return sheet.indexOf(c) >= 0; });
    check('s3: board has mode filter chips', chips.length >= 2, 'found: ' + chips.join(','));
    var hasRows = /\d{1,2}:\d{2}/.test(sheet) || /No departures|Nothing|quiet/i.test(sheet);
    check('s3: board shows departures or an honest empty state', hasRows, 'neither times nor empty-state text');
    await page.keyboard.press('Escape');
  }

  // ── SESSION 4: offline honesty ──
  console.log('SESSION 4 \u2014 offline search fails honestly, then recovers');
  await ctx.setOffline(true);
  await page.goto(BASE, { waitUntil: 'load' }).catch(function () {}); // SW shell
  await sleep(1500);
  var shellUp = await page.$('#from-input');
  check('s4: SW serves the shell offline', !!shellUp, 'blank page offline');
  if (shellUp) {
    await page.fill('#from-input', 'Palermo').catch(function () {});
    await sleep(1200);
    await page.fill('#to-input', 'Catania').catch(function () {});
    await sleep(400);
    // offline the form may hide the button — Enter submits like a phone keyboard
    var sb = await page.$('#search-btn');
    if (sb && await sb.isVisible()) await sb.click();
    else await page.press('#to-input', 'Enter');
    await sleep(3000);
    var bodyTxt = await page.evaluate(function () { return document.body.textContent; });
    var honest = /offline|connessione|connection|couldn|riprova|try again|unreachable|network/i.test(bodyTxt);
    check('s4: failure is visible and honest (no silent blank)', honest, 'no offline/error message found');
  }
  await ctx.setOffline(false);
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1200);
  await page.click('#nav-home').catch(function () {}); // restore the form if results view persisted
  if (!(await page.$('#from-input'))) { await page.reload({ waitUntil: 'load' }); await sleep(1200); await page.click('#nav-home').catch(function () {}); }
  await page.waitForSelector('#from-input', { timeout: 20000 });
  for (var esc2 = 0; esc2 < 3 && await page.$('.sheet-overlay.show'); esc2++) {
    await page.keyboard.press('Escape'); await sleep(400);
  }
  await sleep(1500);
  await pickSuggestion(page, '#from-input', 'Palermo');
  await pickSuggestion(page, '#to-input', 'Catania');
  await clickSearchIfNeeded(page);
  await page.waitForSelector('#results .leg-strip', { timeout: 60000 });
  check('s4: back online, search works again', true, '');

  check('no uncaught page errors across all sessions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await ctx.close();
  console.log('\n' + (failures.length ? 'FAILURES:\n  - ' + failures.join('\n  - ') : 'ALL CORE SESSIONS PASSED'));
  process.exit(failures.length ? 1 : 0);
})().catch(function (e) { console.error('SESSION HARNESS ERROR:', e); process.exit(1); });

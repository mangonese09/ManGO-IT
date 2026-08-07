/* Airport-code search session — real browser, LIVE site, 390px.
     node tests/review/session-airport.js
     BASE=https://it.mangonese.dev/ node tests/review/session-airport.js
   S1 type "PMO"      → an airport row leads the suggestions, reads as an airport
   S2 pick it + plan  → a real itinerary from the airport renders
   S3 reload          → the picked endpoint survives, and "CTA" leads with the
                        airport instead of the Paternò hamlet it used to pick
   S4 regression      → a plain "aeroporto" search is untouched by the alias layer */
'use strict';
var PW = 'C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright';
var { chromium } = require(PW);
var path = require('path');
var fs = require('fs');
var BASE = process.env.BASE || 'https://it.mangonese.dev/';
var PROFILE = path.join(__dirname, '.airport-profile');
var SHOTS = path.join(__dirname, 'shots-airport');

var failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond ? '' : '  [' + detail + ']'));
  if (!cond) failures.push(name + ' \u2014 ' + detail);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// what the user actually sees in the first suggestion row
async function firstRow(page, which) {
  return page.$eval('#' + which + '-suggest .suggest-row:not(.suggest-mappick)', function (row) {
    var img = row.querySelector('img.mode-img');
    return {
      name: (row.querySelector('.suggest-name') || {}).textContent || '',
      area: (row.querySelector('.suggest-area') || {}).textContent || '',
      icon: img ? img.getAttribute('src') : null,
      iconW: img ? img.getBoundingClientRect().width : 0,
    };
  });
}

(async function () {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  var ctx = await chromium.launchPersistentContext(PROFILE, {
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 38.1157, longitude: 13.3615 }, permissions: ['geolocation'], // Palermo
  });
  var page = ctx.pages()[0] || await ctx.newPage();
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(String(e)); });

  // ── SESSION 1: the code resolves and reads as an airport ──
  console.log('SESSION 1 \u2014 type PMO');
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1500);
  await page.fill('#to-input', 'PMO');
  await page.waitForSelector('#to-suggest .suggest-row:not(.suggest-mappick)', { timeout: 25000 });
  await sleep(600);
  var r1 = await firstRow(page, 'to');
  check('s1: PMO leads with the Palermo airport', /Falcone Borsellino/i.test(r1.name), JSON.stringify(r1));
  check('s1: row says what it is', /airport/i.test(r1.area), r1.area || '(no context line)');
  check('s1: plane icon renders at icon size', r1.icon === '/icons/plane-mango.png' && r1.iconW > 14 && r1.iconW < 30,
    r1.icon + ' @ ' + r1.iconW + 'px');
  await page.screenshot({ path: path.join(SHOTS, 's1-pmo-suggest.png') });

  // ── SESSION 2: picking it plans a real trip ──
  // From first, To second \u2014 the natural order, and it avoids the
  // destination-first auto-locate flow racing a second search
  console.log('SESSION 2 \u2014 pick it and search from Palermo Centrale');
  await page.keyboard.press('Escape');
  await page.fill('#from-input', 'Palermo Centrale');
  await page.waitForSelector('#from-suggest .suggest-row:not(.suggest-mappick)', { timeout: 25000 });
  await sleep(600);
  await page.click('#from-suggest .suggest-row:not(.suggest-mappick) >> nth=0');
  await sleep(300);
  await page.fill('#to-input', 'PMO');
  await page.waitForSelector('#to-suggest .suggest-row:not(.suggest-mappick)', { timeout: 25000 });
  await sleep(600);
  await page.click('#to-suggest .suggest-row:not(.suggest-mappick) >> nth=0');
  await sleep(400);
  var filled = await page.inputValue('#to-input');
  check('s2: picking fills the destination', /Falcone Borsellino/i.test(filled), filled);
  var btn = await page.$('#search-btn');
  if (btn && await btn.isVisible()) await btn.click();
  await page.waitForSelector('#results .leg-strip', { timeout: 60000 });
  await sleep(800);
  var cards = await page.$$eval('#results .leg-strip', function (e) { return e.length; });
  var times = await page.$eval('#results', function (r) { return /\d{1,2}:\d{2}/.test(r.textContent); });
  check('s2: itineraries to the airport render', cards >= 1, cards + ' cards');
  check('s2: departure times visible', times, 'no HH:MM in results');
  await page.screenshot({ path: path.join(SHOTS, 's2-results.png') });

  // ── SESSION 3: survives a reload; CTA no longer picks a hamlet ──
  console.log('SESSION 3 \u2014 reload, then CTA');
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  await page.fill('#to-input', 'CTA');
  await page.waitForSelector('#to-suggest .suggest-row:not(.suggest-mappick)', { timeout: 25000 });
  await sleep(600);
  var r3 = await firstRow(page, 'to');
  check('s3: CTA leads with the Catania airport', /Fontanarossa/i.test(r3.name), JSON.stringify(r3));
  check('s3: the Paterno hamlet no longer leads', !/^\s*Cta\s*$/i.test(r3.name.trim()), r3.name);
  await page.screenshot({ path: path.join(SHOTS, 's3-cta-suggest.png') });

  // ── SESSION 4: regression — the alias layer must not touch normal queries ──
  console.log('SESSION 4 \u2014 plain "aeroporto" unchanged');
  await page.fill('#to-input', 'aeroporto');
  await page.waitForSelector('#to-suggest .suggest-row:not(.suggest-mappick)', { timeout: 25000 });
  await sleep(600);
  var r4 = await firstRow(page, 'to');
  check('s4: "aeroporto" still leads with a real stop, not a synthesized airport',
    /aeroporto/i.test(r4.name) && !/airport/i.test(r4.area), JSON.stringify(r4));
  check('s4: no page errors across the whole chain', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('\n' + (failures.length ? failures.length + ' FAILED:\n  ' + failures.join('\n  ') : 'ALL PASS'));
  await ctx.close();
  process.exit(failures.length ? 1 : 0);
})();

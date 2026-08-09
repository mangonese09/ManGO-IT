/* Whole-day view session regression (v1.2.0) — real browser, chained sessions.
     STATIC=1 node server/proxy.js          (in another shell)
     node tests/review/session-dayview.js
   Reproduces the reported trip: PMO → RAFFADALI (Via Nazionale), Sun 9 Aug 15:00.
   That Sunday genuinely has NO connection between 15:00 and 18:56, and MOTIS's
   earlier cursor walks back into SATURDAY — which the old build rendered
   unlabelled, so it read as part of the searched day.
     S1 search      → results render, the empty afternoon is stated, chips count
     S2 earlier     → pill no longer claims "today", the other day gets a header
     S3 filters     → each chip narrows honestly; empty bucket offers a way back
     S4 disruption  → reload mid-flow, double-tap search, Escape a sheet */
'use strict';
var PW = 'C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright';
var { chromium } = require(PW);
var path = require('path');
var fs = require('fs');
var BASE = process.env.BASE || 'http://localhost:3041/';
var WHEN = process.env.WHEN || '2026-08-09T15:00';
var PROFILE = path.join(__dirname, '.dayview-profile');

var failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond ? '' : '  [' + detail + ']'));
  if (!cond) failures.push(name + ' \u2014 ' + detail);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function pickSuggestion(page, inputSel, text, prefer) {
  await page.fill(inputSel, text);
  var sug = inputSel.replace('-input', '-suggest');
  var row = sug + ' .suggest-row:has-text("' + (prefer || text) + '")';
  await page.waitForSelector(row, { timeout: 25000 });
  await sleep(300);
  await page.click(row + ' >> nth=0');
}

// the when-input is visually hidden (a styled chip fronts the native picker),
// so drive it the way the picker does: set the value, fire change.
async function setWhen(page, value) {
  await page.$eval('#when-input', function (el, v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function runSearch(page) {
  var btn = await page.$('#search-btn');
  if (btn && await btn.isVisible()) await btn.click();
  await page.waitForSelector('#results .iti-card, #results .empty-state', { timeout: 60000 });
  await sleep(600);
}

function texts(page, sel) { return page.$$eval(sel, function (ns) { return ns.map(function (n) { return n.textContent.trim(); }); }); }

(async function () {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  var ctx = await chromium.launchPersistentContext(PROFILE, {
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 38.1181, longitude: 13.3614 }, permissions: ['geolocation'],
  });
  var page = ctx.pages()[0] || await ctx.newPage();
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(String(e)); });
  var consoleErrors = [];
  page.on('console', function (m) { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ── SESSION 1: the reported search ──
  console.log('SESSION 1 \u2014 PMO \u2192 Raffadali (Via Nazionale), ' + WHEN);
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1200);
  await pickSuggestion(page, '#from-input', 'PMO', 'Falcone');
  await pickSuggestion(page, '#to-input', 'raffadali', 'Nazionale');
  await setWhen(page, WHEN);
  await runSearch(page);

  var cards = await page.$$('#results .iti-card');
  check('results render', cards.length > 0, 'no itinerary cards');

  // the whole point: an empty afternoon is STATED, not silently skipped past
  var gap = await page.$('#results .gap-note');
  var gapText = gap ? (await gap.textContent()).trim() : '';
  check('empty afternoon is stated, not skipped', !!gap, 'no .gap-note rendered');
  check('gap note names the requested time', /15:00/.test(gapText), gapText || '(none)');
  check('gap note names the first real departure', /18:5\d|19:\d\d/.test(gapText), gapText || '(none)');

  // filter chips present with honest counts
  var chips = await texts(page, '#results .filter-chip');
  check('filter chips render', chips.length === 4, JSON.stringify(chips));
  check('chips are All/Direct/Train/Bus', /All/.test(chips[0] || '') && /Direct/.test(chips[1] || '')
    && /Train/.test(chips[2] || '') && /Bus/.test(chips[3] || ''), JSON.stringify(chips));

  // ── SESSION 2: page Earlier — the day-label bug ──
  console.log('SESSION 2 \u2014 Earlier page must not claim "today"');
  var pill = await page.$('.day-page-earlier');
  check('Earlier pill exists', !!pill, 'no earlier pill');
  var pillText = pill ? (await pill.textContent()).trim() : '';
  check('Earlier pill does not claim "today"', !/today/i.test(pillText), pillText);

  if (pill) {
    await pill.click();
    await sleep(4000);
  }
  var heads = await texts(page, '#results .day-head');
  var cardCount = (await page.$$('#results .iti-card')).length;
  check('Earlier page added results', cardCount > cards.length, cardCount + ' vs ' + cards.length);

  // every distinct Rome date on screen must be labelled once the list spans days
  var dayInfo = await page.evaluate(function () {
    var out = [];
    var kids = document.querySelectorAll('#results > *');
    var seenHead = null, dates = {};
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList.contains('day-head')) seenHead = k.textContent.trim();
      if (k.classList.contains('iti-card')) {
        var t = k.querySelector('.iti-time');
        dates[(seenHead || '(unlabelled)')] = (dates[(seenHead || '(unlabelled)')] || 0) + 1;
        out.push({ head: seenHead, time: t ? t.textContent.trim() : '' });
      }
    }
    return { rows: out, groups: dates };
  });
  var groupNames = Object.keys(dayInfo.groups);
  check('no result sits under an unlabelled day once days are mixed',
    groupNames.indexOf('(unlabelled)') === -1, JSON.stringify(dayInfo.groups));
  check('at least two distinct days are labelled', groupNames.length >= 2, JSON.stringify(dayInfo.groups));

  // The searched day MUST be named once the list spans days. The v1.1.0 build
  // labelled days relative to the device's today, so with a device clock behind
  // Rome the searched Sunday rows inherited the "Sat 8 Aug" heading above them.
  var searchedLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(WHEN.slice(0, 10) + 'T12:00:00Z'));
  check('the searched day is named on screen (' + searchedLabel + ')',
    heads.indexOf(searchedLabel) !== -1, JSON.stringify(heads));
  console.log('    day groups: ' + JSON.stringify(dayInfo.groups));
  console.log('    headers: ' + JSON.stringify(heads));

  // ── SESSION 3: filters ──
  console.log('SESSION 3 \u2014 result filters');
  async function tapChip(label) {
    await page.click('#results .filter-chip:has-text("' + label + '")', { timeout: 5000 });
    await sleep(500);
  }
  var before = (await page.$$('#results .iti-card')).length;
  var haveChips = (await page.$$('#results .filter-chip')).length > 0;
  if (!haveChips) {
    // a build without the feature: report it as a failure, don't crash the run
    check('result filters are present', false, 'no .filter-chip in #results');
  } else {

  await tapChip('Direct');
  var directCards = (await page.$$('#results .iti-card')).length;
  var emptyState = await page.$('#results .empty-state');
  check('Direct either narrows or explains itself',
    (directCards > 0 && directCards <= before) || !!emptyState,
    directCards + ' cards, emptyState=' + !!emptyState);
  if (directCards > 0) {
    var metas = await texts(page, '#results .iti-card .iti-meta');
    var allDirect = metas.every(function (m) { return /direct/i.test(m); });
    check('every Direct result really is direct', allDirect, JSON.stringify(metas.slice(0, 4)));
  }
  if (emptyState) {
    var back = await page.$('#results .empty-state button');
    check('empty filter offers a way back', !!back, 'no Show all button');
    if (back) {
      await back.click();
      await sleep(400);
      check('Show all restores the list', (await page.$$('#results .iti-card')).length === before,
        'expected ' + before);
    }
  } else {
    await tapChip('All');
  }

  await tapChip('Train');
  var trainCards = (await page.$$('#results .iti-card')).length;
  var trainEmpty = await page.$('#results .empty-state');
  check('Train either narrows or explains itself', trainCards > 0 || !!trainEmpty,
    trainCards + ' cards, emptyState=' + !!trainEmpty);
  if (trainCards > 0) {
    var hasRail = await page.$$eval('#results .iti-card', function (ns) {
      return ns.every(function (n) { return !!n.querySelector('.leg-seg.mode-rail'); });
    });
    check('every Train result contains a rail leg', hasRail, 'a card had no .mode-rail segment');
  }
  if (trainEmpty) { await page.click('#results .empty-state button'); await sleep(400); }
  else { await tapChip('All'); }
  check('back to the full list', (await page.$$('#results .iti-card')).length === before,
    'expected ' + before);
  }

  // ── SESSION 4: disruption ──
  console.log('SESSION 4 \u2014 disruption');
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  var survived = await page.$('#results .iti-card');
  check('reload returns a usable home screen (results not required)',
    !!(await page.$('#search-btn')) || !!survived, 'no search button after reload');

  // double-tap search with a fresh trip — the second tap must not double-render
  await pickSuggestion(page, '#from-input', 'PMO', 'Falcone');
  await pickSuggestion(page, '#to-input', 'raffadali', 'Nazionale');
  await setWhen(page, WHEN);
  var sbtn = await page.$('#search-btn');
  if (sbtn && await sbtn.isVisible()) { await sbtn.click(); await sbtn.click().catch(function () {}); }
  await page.waitForSelector('#results .iti-card, #results .empty-state', { timeout: 60000 });
  await sleep(1500);
  var chipRows = (await page.$$('#results .filter-row')).length;
  check('double-tap renders exactly one filter row', chipRows === 1, chipRows + ' filter rows');
  var staleChips = (await page.$$('#results .filter-chip.active')).length;
  check('exactly one chip is active', staleChips === 1, staleChips + ' active chips');

  // open a result sheet and Escape out of it
  var firstCard = await page.$('#results .iti-card');
  if (firstCard) {
    await firstCard.click();
    await sleep(900);
    var sheet = await page.$('.sheet, .sheet-backdrop, [role="dialog"]');
    check('result opens a detail sheet', !!sheet, 'no sheet after tapping a card');
    await page.keyboard.press('Escape');
    await sleep(600);
    var stillOpen = await page.$('.sheet-backdrop:not([hidden]), [role="dialog"]:not([hidden])');
    check('Escape closes the sheet', !stillOpen, 'sheet still open after Escape');
  }

  // ── SESSION 5: keyboard, desktop width, offline ──
  console.log('SESSION 5 — keyboard / desktop / offline');

  // chips are real buttons: reachable by Tab, operable by Enter, state announced
  var chipA11y = await page.$$eval('#results .filter-chip', function (ns) {
    return {
      allButtons: ns.every(function (n) { return n.tagName === 'BUTTON'; }),
      pressed: ns.map(function (n) { return n.getAttribute('aria-pressed'); }),
      minH: ns.map(function (n) { return Math.round(n.getBoundingClientRect().height); }),
    };
  });
  check('filter chips are <button>', chipA11y.allButtons, JSON.stringify(chipA11y));
  check('filter chips expose aria-pressed',
    chipA11y.pressed.filter(function (p) { return p === 'true'; }).length === 1,
    JSON.stringify(chipA11y.pressed));
  check('filter chips meet the 44px touch floor',
    chipA11y.minH.every(function (h) { return h >= 44; }), JSON.stringify(chipA11y.minH));

  // keyboard-only: focus the Direct chip and activate it with Enter
  var kbOk = await page.evaluate(function () {
    var chips = document.querySelectorAll('#results .filter-chip');
    if (chips.length < 2) return false;
    chips[1].focus();
    return document.activeElement === chips[1];
  });
  check('a filter chip takes keyboard focus', kbOk, 'could not focus chip');
  var ring = await page.$eval('#results .filter-chip:nth-child(2)', function (n) {
    var s = getComputedStyle(n, ':focus-visible');
    return s.outlineStyle !== 'none' || s.outlineWidth !== '0px' || s.boxShadow !== 'none';
  }).catch(function () { return false; });
  check('focused chip has a visible focus indicator', ring, 'no outline/box-shadow on :focus-visible');
  await page.keyboard.press('Enter');
  await sleep(500);
  var afterEnter = (await page.$$('#results .iti-card')).length;
  var afterEnterEmpty = await page.$('#results .empty-state');
  check('Enter activates the chip', afterEnter !== before || !!afterEnterEmpty,
    afterEnter + ' cards (was ' + before + ')');
  await page.click('#results .filter-chip:has-text("All")');
  await sleep(400);

  // desktop width: the page must not scroll sideways
  await page.setViewportSize({ width: 1280, height: 900 });
  await sleep(600);
  var overflow = await page.evaluate(function () {
    return { doc: document.documentElement.scrollWidth, win: window.innerWidth };
  });
  check('no horizontal overflow at 1280px', overflow.doc <= overflow.win + 1, JSON.stringify(overflow));
  var chipsDesktop = (await page.$$('#results .filter-chip')).length;
  check('filters still render at desktop width', chipsDesktop === 4, chipsDesktop + ' chips');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);

  // offline: a fresh search must fail visibly, never blank, and stay usable.
  // Snapshot the console first — the disconnect noise below is ours, not a bug.
  var errsBeforeOffline = consoleErrors.slice();
  await ctx.setOffline(true);
  await pickSuggestion(page, '#from-input', 'PMO', 'Falcone').catch(function () {});
  var searchBtn = await page.$('#search-btn');
  if (searchBtn && await searchBtn.isVisible()) await searchBtn.click();
  await sleep(6000);
  var offlineText = (await page.textContent('#results')) || '';
  var offlineToast = (await page.textContent('body')) || '';
  check('offline says something, never blanks',
    offlineText.trim().length > 0 || /connection|unreachable|offline|Too many/i.test(offlineToast),
    'results empty and no message');
  check('offline leaves the search button usable',
    !!(await page.$('#search-btn')), 'search button gone after offline failure');
  await ctx.setOffline(false);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no console errors before the induced outage', errsBeforeOffline.length === 0,
    errsBeforeOffline.slice(0, 3).join(' | '));
  // after the outage, only the disconnect itself may have logged — nothing thrown
  var unexpected = consoleErrors.filter(function (e) { return !/ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError/i.test(e); });
  check('the outage logged nothing beyond the disconnect', unexpected.length === 0,
    unexpected.slice(0, 3).join(' | '));

  await ctx.close();
  console.log('');
  if (failures.length) {
    console.log('FAILURES (' + failures.length + '):');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
})();

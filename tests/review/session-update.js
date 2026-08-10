/* Update-path + storage-durability proof (design §7) — real browser, real SW,
   against a THROWAWAY COPY of the working tree so the test controls the
   version. Chained sessions in one persistent profile:
     S1 seed favourites/places/recents at version A → they render
     S2 bump the copy to version B → Check for updates → ride the REAL
        controllerchange reload → version B AND every item still present
        (the regression that answers "can an update clear my data?")
     S3 a v1-shaped favstop migrates (iconMode filled) and renders
     S4 corrupt JSON is QUARANTINED, not silently emptied — and no crash
     S5 export → erase all → import → full round trip
   Run: node tests/review/session-update.js */
'use strict';
var PW = 'C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright';
var { chromium } = require(PW);
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var REPO = path.join(__dirname, '..', '..');
var TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'mangoit-upd-'));
var PROFILE = path.join(TREE, '.profile');
var PORT = 3062;
var BASE = 'http://localhost:' + PORT + '/';

var failures = [];
function check(name, cond, detail) {
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond ? '' : '  [' + detail + ']'));
  if (!cond) failures.push(name);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

for (const item of ['index.html', 'manifest.json', 'service-worker.js', 'version.json', 'css', 'js', 'icons', 'vendor']) {
  fs.cpSync(path.join(REPO, item), path.join(TREE, item), { recursive: true });
}
function treeVersion() { return JSON.parse(fs.readFileSync(path.join(TREE, 'version.json'), 'utf8')).version; }
function bumpTree(to) {
  var from = treeVersion();
  var fromCache = 'mangoit-v' + from.replace(/\./g, '');
  var toCache = 'mangoit-v' + to.replace(/\./g, '');
  for (const f of ['index.html', 'service-worker.js', 'js/version.js', 'version.json']) {
    var p = path.join(TREE, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split(from).join(to).split(fromCache).join(toCache));
  }
}
var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
var server = http.createServer(function (req, res) {
  var p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  var f = path.join(TREE, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

var SEED = {
  favstops: [{ key: 's1', name: 'PALERMO CENTRALE', kind: 'train, tram & bus station', iconMode: 'RAIL', stopId: null, lat: 38.1089, lon: 13.3675 }],
  places: [{ key: 'p1', label: 'Mondello', name: 'Mondello', lat: 38.2, lon: 13.3 }],
  recents: [{ from: { name: 'A', place: '1,1', lat: 1, lon: 1 }, to: { name: 'AGRIGENTO CENTRALE', place: '2,2', lat: 2, lon: 2 } }],
};

server.listen(PORT, async function () {
  var browser = await chromium.launchPersistentContext(PROFILE, {
    viewport: { width: 390, height: 844 }, acceptDownloads: true,
  });
  var page = browser.pages()[0] || await browser.newPage();
  var pageErrors = [];
  page.on('pageerror', function (e) { pageErrors.push(e.message); });
  var verA = treeVersion();

  console.log('SESSION 1 — seed at v' + verA);
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(2500); // let the SW install + claim
  await page.evaluate(function (seed) {
    localStorage.setItem('mangoit.favstops', JSON.stringify(seed.favstops));
    localStorage.setItem('mangoit.places', JSON.stringify(seed.places));
    localStorage.setItem('mangoit.recents', JSON.stringify(seed.recents));
  }, SEED);
  await page.reload({ waitUntil: 'load' }); await sleep(1500);
  check('s1: recents chip renders', !!(await page.$('.chip-recent')), 'no chip');
  await page.click('#nav-saved'); await sleep(1500);
  check('s1: fav stop card renders', !!(await page.$('.fav-stop-card')), 'no card');
  check('s1: place row renders', !!(await page.$('.fav-place-card')), 'no place');

  console.log('SESSION 2 — update ' + verA + ' → bumped, data must survive');
  var parts = verA.split('.').map(Number);
  var verB = parts[0] + '.' + parts[1] + '.' + (parts[2] + 1);
  bumpTree(verB);
  await page.click('#nav-settings'); await sleep(600);
  await page.click('#check-updates');
  // ride the real update: new SW installs, claims, the inline script reloads
  try {
    await page.waitForFunction(function (v) {
      var el2 = document.getElementById('current-version');
      return el2 && el2.textContent.indexOf(v) !== -1;
    }, verB, { timeout: 45000 });
  } catch (e) { /* fall through to the assert below */ }
  await sleep(1000);
  var shown = await page.$eval('#current-version', function (n) { return n.textContent; }).catch(function () { return '?'; });
  check('s2: app updated to v' + verB, shown.indexOf(verB) !== -1, shown);
  var kept = await page.evaluate(function () {
    return {
      favs: JSON.parse(localStorage.getItem('mangoit.favstops') || '[]').length,
      places: JSON.parse(localStorage.getItem('mangoit.places') || '[]').length,
      recents: JSON.parse(localStorage.getItem('mangoit.recents') || '[]').length,
    };
  });
  check('s2: UPDATE KEPT EVERY ITEM', kept.favs === 1 && kept.places === 1 && kept.recents === 1, JSON.stringify(kept));
  await page.click('#nav-saved'); await sleep(1500);
  check('s2: favourites still render post-update', !!(await page.$('.fav-stop-card')), 'no card');

  console.log('SESSION 3 — v1-shaped favstop migrates');
  await page.evaluate(function () {
    localStorage.setItem('mangoit.favstops', JSON.stringify([{ key: 'old', name: 'RAFFADALI', icon: '🚌' }]));
    localStorage.removeItem('mangoit.schemaVersion');
  });
  await page.reload({ waitUntil: 'load' }); await sleep(1500);
  var migrated = await page.evaluate(function () { return JSON.parse(localStorage.getItem('mangoit.favstops'))[0]; });
  check('s3: iconMode filled by the migration', migrated.iconMode === 'COACH', JSON.stringify(migrated));
  await page.click('#nav-saved'); await sleep(1200);
  check('s3: migrated favstop renders', !!(await page.$('.fav-stop-card')), 'no card');

  console.log('SESSION 4 — corrupt JSON is quarantined');
  await page.evaluate(function () { localStorage.setItem('mangoit.favstops', '{corrupt!!'); });
  await page.reload({ waitUntil: 'load' }); await sleep(1500);
  await page.click('#nav-saved'); await sleep(1200);
  var q = await page.evaluate(function () {
    var n = 0;
    for (var i = 0; i < localStorage.length; i++) if (localStorage.key(i).indexOf('mangoit.__quarantine.favstops') === 0) n++;
    return n;
  });
  check('s4: raw bytes quarantined', q >= 1, 'quarantine keys: ' + q);
  check('s4: Saved shows the honest empty state', (await page.textContent('#view-saved')).indexOf('Nothing pinned yet') !== -1, 'no empty state');

  console.log('SESSION 5 — export → erase → import round trip');
  await page.evaluate(function (seed) {
    localStorage.setItem('mangoit.favstops', JSON.stringify(seed.favstops));
    localStorage.setItem('mangoit.places', JSON.stringify(seed.places));
  }, SEED);
  await page.reload({ waitUntil: 'load' }); await sleep(1200);
  await page.click('#nav-settings'); await sleep(600);
  var dl = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#backup-data');
  var backupFile = await (await dl).path();
  check('s5: backup file downloaded', !!backupFile && fs.readFileSync(backupFile, 'utf8').indexOf('"mangoit"') !== -1, String(backupFile));
  await page.click('#erase-all'); await sleep(500);
  await page.click('.sheet-overlay button:has-text("Erase")');
  await sleep(2500); // erase reloads
  var wiped = await page.evaluate(function () { return localStorage.getItem('mangoit.favstops'); });
  check('s5: erase really erased', wiped === null, String(wiped));
  await page.click('#nav-settings'); await sleep(600);
  await page.setInputFiles('#restore-file', backupFile);
  await sleep(600);
  await page.click('.sheet-overlay button:has-text("Restore")');
  await sleep(2500); // import reloads
  var restored = await page.evaluate(function () {
    return { favs: JSON.parse(localStorage.getItem('mangoit.favstops') || '[]').length, places: JSON.parse(localStorage.getItem('mangoit.places') || '[]').length };
  });
  check('s5: import restored everything', restored.favs === 1 && restored.places === 1, JSON.stringify(restored));
  check('no uncaught page errors across all sessions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  try { fs.rmSync(TREE, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  console.log(failures.length ? '\nFAILURES: ' + failures.length : '\nALL UPDATE SESSIONS PASSED');
  process.exit(failures.length ? 1 : 0);
});

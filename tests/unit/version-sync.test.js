'use strict';
// Every deploy bumps package.json + version.json + js/version.js + SW cache + ?v= tags.
// This test makes a missed bump fail CI instead of shipping silently.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const vjson = JSON.parse(read('version.json'));
const vjs = read('js/version.js').match(/APP_VERSION = '([^']+)'/)[1];

test('package.json == version.json == js/version.js', () => {
  assert.strictEqual(vjson.version, pkg.version);
  assert.strictEqual(vjs, pkg.version);
});

test('index.html cache-busts css and app.js with the current version', () => {
  const html = read('index.html');
  assert.ok(html.includes(`styles.css?v=${pkg.version}`), 'styles.css ?v= stale');
  assert.ok(html.includes(`app.js?v=${pkg.version}`), 'app.js ?v= stale');
});

test('service worker precache list matches versioned URLs', () => {
  const sw = read('service-worker.js');
  assert.ok(sw.includes(`/css/styles.css?v=${pkg.version}`), 'SW styles.css entry stale');
  assert.ok(sw.includes(`/js/app.js?v=${pkg.version}`), 'SW app.js entry stale');
});

test('every js module is in the SW precache list', () => {
  const sw = read('service-worker.js');
  for (const f of fs.readdirSync(path.join(root, 'js'))) {
    assert.ok(sw.includes(`/js/${f}`), `service-worker.js missing /js/${f}`);
  }
});

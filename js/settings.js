// ── SETTINGS ── (v1.5.0 deep-dive redesign)
// Rows are whole-row taps showing the current value as muted text + chevron;
// tapping opens a styled radio sheet listing EVERY option with a description —
// discovery never mutates the setting (the old cycling pills changed it just
// to reveal the next state). Cache clearing is split from data erasure (S-1).
import { APP_VERSION } from './version.js';
import { getSettings, patchSettings, clearAllAppData, clearCachedData, getFavStops, getPlaces, getRecents, getSaved } from './store.js';
import { confirmModal, openSheet, closeSheet, el } from './ui.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { setMapStyle, getMapStyle } from './mapview.js';

const sysDark = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function initSettings() {
  applyTheme(getSettings().theme);
  // System theme follows the OS live — but only while System is selected
  sysDark?.addEventListener?.('change', () => {
    if (getSettings().theme === 'system') applyTheme('system');
  });

  wireChoiceRow('theme-row', {
    title: 'Theme',
    options: [
      { v: 'system', label: 'System', desc: 'Follow this device’s light/dark setting.' },
      { v: 'dark', label: 'Dark', desc: 'Always dark.' },
      { v: 'light', label: 'Light', desc: 'Always light.' },
    ],
    current: () => getSettings().theme,
    pick: (v) => { patchSettings({ theme: v }); applyTheme(v); },
  });

  wireChoiceRow('map-style-row', {
    title: 'Map style',
    options: [
      { v: 'auto', label: 'Auto', desc: 'Basemap follows the app theme.' },
      { v: 'dark', label: 'Dark', desc: 'Dark basemap in both themes.' },
      { v: 'light', label: 'Light', desc: 'Light basemap in both themes.' },
    ],
    current: () => getMapStyle(),
    pick: (v) => setMapStyle(v),
  });

  wireChoiceRow('span-row', {
    title: 'Search results',
    options: [
      { v: 'whole', label: 'Whole day', desc: 'Every remaining departure today, in day-part sections.' },
      { v: 'next', label: 'Next departures', desc: 'Just the first few options from now.' },
    ],
    current: () => getSettings().resultSpan === 'next' ? 'next' : 'whole',
    pick: (v) => patchSettings({ resultSpan: v }),
  });
  paintValues();

  // S-1: cache-only clear — saved stops/places/recents are untouched, so no
  // scare copy needed; a reload refetches fresh schedules.
  document.getElementById('clear-cache')?.addEventListener('click', async () => {
    const ok = await confirmModal('Clear cached schedules and map data? Your saved stops and places are kept.', { confirmText: 'Clear', danger: false });
    if (!ok) return;
    clearCachedData();
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    location.reload();
  });

  // S-1: the deliberate, red, itemized one. The modal counts what dies.
  document.getElementById('erase-all')?.addEventListener('click', async () => {
    const bits = [];
    const add = (n, word) => { if (n) bits.push(`${n} ${word}${n > 1 ? 's' : ''}`); };
    add(getFavStops().length, 'saved stop');
    add(getPlaces().length, 'place');
    add(getRecents().length, 'recent search');
    add(getSaved().length, 'saved departure');
    const what = bits.length ? `Removes ${bits.join(', ')} — and all settings. ` : 'Removes all settings. ';
    const ok = await confirmModal(`Erase everything? ${what}This cannot be undone.`, { confirmText: 'Erase' });
    if (!ok) return;
    clearAllAppData();
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    location.reload();
  });

  document.getElementById('check-updates')?.addEventListener('click', checkForUpdates);
  const ver = document.getElementById('current-version');
  if (ver) ver.textContent = `v${APP_VERSION}`;
  document.getElementById('data-info')?.addEventListener('click', openDataSheet);
  document.getElementById('about-open')?.addEventListener('click', openAboutSheet);
}

// ── CHOICE SHEETS (S-2/S-3/S-7) ──
const VALUE_LABEL = {
  system: 'System', dark: 'Dark', light: 'Light', auto: 'Auto',
  whole: 'Whole day', next: 'Next departures',
};
const ROW_VALUE_EL = { 'theme-row': 'theme-value', 'map-style-row': 'map-style-value', 'span-row': 'span-value' };
const rowConfigs = new Map();

function paintValues() {
  for (const [rowId, cfg] of rowConfigs) {
    const elv = document.getElementById(ROW_VALUE_EL[rowId]);
    if (elv) elv.textContent = VALUE_LABEL[cfg.current()] || '';
  }
}

function wireChoiceRow(rowId, cfg) {
  // Null-tolerant (v1.5.1): a torn half-updated cache can pair this module
  // with a different generation of index.html — a missing row must degrade
  // to "that row does nothing" while the SW replaces the shell, never throw.
  const row = document.getElementById(rowId);
  if (!row) return;
  rowConfigs.set(rowId, cfg);
  row.addEventListener('click', () => {
    const body = el('div', { class: 'choice-sheet' });
    for (const o of cfg.options) {
      body.appendChild(el('button', {
        class: `choice-row${cfg.current() === o.v ? ' is-active' : ''}`,
        onclick: () => {
          cfg.pick(o.v);
          paintValues();
          closeSheet();
        },
      }, [
        el('span', { class: 'choice-main' }, [
          el('span', { text: o.label }),
          o.desc ? el('span', { class: 'muted choice-desc', text: o.desc }) : null,
        ]),
        el('span', { class: 'choice-check', 'aria-hidden': 'true', text: '✓' }),
      ]));
    }
    openSheet(body, { title: cfg.title });
  });
}

// ── THEME ──
function resolvedTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return sysDark && !sysDark.matches ? 'light' : 'dark'; // system (dark-first app)
}
function applyTheme(pref) {
  document.documentElement.dataset.theme = resolvedTheme(pref);
  // an "Auto" basemap follows the applied theme — retile if the map exists
  setMapStyle(getMapStyle());
}

// ── DATA & SCHEDULES SHEET ──
// Meaningful provenance, not per-device "last fetched" clocks (which read as
// "broken/stale" for the bundled coach feed). Each source says what it is,
// how fresh it is, and when it's used.
function fmtHorizon(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d) ? null : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dataRow(title, value, desc, ok = false) {
  return el('div', { class: 'data-src' }, [
    el('div', { class: 'data-src-head' }, [
      el('span', { class: 'data-src-title', text: title }),
      el('span', { class: `data-src-value${ok ? ' data-src-ok' : ''}`, text: value }),
    ]),
    el('p', { class: 'muted data-src-desc', text: desc }),
  ]);
}

async function openDataSheet() {
  const body = el('div', { class: 'data-sheet' });
  // provisional render, then fill the coach horizon once /api/health answers
  const coachSlot = dataRow('Coach schedules', 'bundled & auto-refreshed',
    'Bundled in the app and refreshed automatically — weekly (SAIS Autolinee) and monthly (SAIS Trasporti) — from operator and Regione Siciliana timetables.');
  body.appendChild(coachSlot);
  body.appendChild(dataRow('Live trains', 'ViaggiaTreno (RFI)',
    'Real-time status, fetched live when you open a train station’s board.'));
  body.appendChild(dataRow('Routing', 'Transitous (MOTIS)',
    'Plans your A→B itineraries across trains, coaches and city transit.'));
  body.appendChild(dataRow('Fares', 'checked Jul 2026',
    'Urban flats (AMAT, AMTS, FCE, TUA) and SAIS Trasporti city-pair prices are exact; rail and most coaches are priced at booking — never estimated.'));
  openSheet(body, { title: 'Data & schedules' });

  try {
    const { data } = await api.health();
    const horizon = fmtHorizon(data?.feedHorizon?.date);
    if (horizon) {
      const val = coachSlot.querySelector('.data-src-value');
      val.textContent = `verified through ${horizon}`;
      val.classList.add('data-src-ok');
    }
  } catch { /* leave the provisional line — the feed is bundled regardless */ }
}

// ── ABOUT SHEET ── (S-6: one attribution per line + the trust line)
function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener', text });
}
function openAboutSheet() {
  const body = el('div', { class: 'about-sheet' }, [
    el('div', { class: 'about-head' }, [
      el('img', { class: 'about-logo', src: '/icons/logo.png', alt: '' }),
      el('div', {}, [
        el('div', { class: 'about-name', text: 'ManGO:IT' }),
        el('div', { class: 'muted about-tag', text: `Sicily, one view · v${APP_VERSION}` }),
      ]),
    ]),
    el('p', { class: 'muted strike-note' }, [
      el('span', { text: '⚠️ Strikes (' }), el('em', { text: 'scioperi' }),
      el('span', { text: ') are common in Italian transit and never appear in schedule data. If everything looks suspiciously quiet, check local news.' }),
    ]),
    el('p', { class: 'about-privacy', text: 'Everything stays on this device — no account, no tracking.' }),
    el('ul', { class: 'muted about-links' }, [
      el('li', {}, [el('span', { text: 'Routing by ' }), link('https://transitous.org', 'Transitous'), el('span', { text: ' · ' }), link('https://transitous.org/sources/', 'data sources')]),
      el('li', {}, [el('span', { text: 'Map data © ' }), link('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors')]),
      el('li', {}, [el('span', { text: 'Coach schedules from Regione Siciliana and operator timetables' })]),
      el('li', {}, [el('span', { text: 'Live trains via ViaggiaTreno' })]),
      el('li', {}, [link('https://github.com/mangonese09/ManGO-IT', 'Source code on GitHub')]),
    ]),
  ]);
  openSheet(body, { title: 'About' });
}

async function checkForUpdates() {
  const btn = document.getElementById('check-updates');
  if (btn.disabled) return;
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 2500);
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await res.json();
    if (version === APP_VERSION) { toast(`Up to date (v${APP_VERSION})`, 'info'); return; }
    toast(`Updating to v${version}…`, 'info');
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { location.reload(); return; }
    // Reload the moment the NEW worker takes control — that's when the fresh
    // assets are actually in place. The old code reloaded on a blind 800ms
    // timer that often fired mid-install, so the reload was served from the OLD
    // cache and nothing changed. A generous fallback covers a stuck install.
    let done = false;
    const finish = () => { if (done) return; done = true; location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', finish);
    await reg.update();
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); // activate an already-installed worker
    setTimeout(finish, 10000);
  } catch {
    toast('Could not check for updates', 'warn');
  }
}

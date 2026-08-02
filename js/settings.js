// ── SETTINGS ──
import { APP_VERSION } from './version.js';
import { getSettings, patchSettings, clearAllAppData } from './store.js';
import { confirmModal, openSheet, el } from './ui.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { setMapStyle, getMapStyle } from './mapview.js';

export function initSettings() {
  applyTheme(getSettings().theme);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = getSettings().theme === 'dark' ? 'light' : 'dark';
    patchSettings({ theme: next });
    applyTheme(next);
  });

  // Map basemap style: Auto (follows theme) → Dark → Light → Auto.
  const mapBtn = document.getElementById('map-style-toggle');
  const paintMapStyle = () => {
    const v = getMapStyle();
    if (mapBtn) mapBtn.textContent = v === 'dark' ? '🌙 Dark' : v === 'light' ? '☀️ Light' : 'Auto';
  };
  if (mapBtn) {
    paintMapStyle();
    mapBtn.addEventListener('click', () => {
      const order = ['auto', 'dark', 'light'];
      setMapStyle(order[(order.indexOf(getMapStyle()) + 1) % 3]);
      paintMapStyle();
    });
  }

  // §5.8: whole-day (default) vs the old next-6-departures view.
  const spanBtn = document.getElementById('span-toggle');
  applySpanLabel(spanBtn);
  spanBtn.addEventListener('click', () => {
    const next = getSettings().resultSpan === 'next' ? 'whole' : 'next';
    patchSettings({ resultSpan: next });
    applySpanLabel(spanBtn);
    toast(next === 'next' ? 'Showing next departures only' : 'Showing the whole day', 'info', 1600);
  });

  document.getElementById('clear-cache').addEventListener('click', async () => {
    const ok = await confirmModal('Clear all cached data and settings?', { confirmText: 'Clear' });
    if (!ok) return;
    clearAllAppData();
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    location.reload();
  });

  document.getElementById('check-updates').addEventListener('click', checkForUpdates);
  const ver = document.getElementById('current-version');
  if (ver) ver.textContent = `v${APP_VERSION}`;
  document.getElementById('data-info').addEventListener('click', openDataSheet);
  document.getElementById('about-open').addEventListener('click', openAboutSheet);
}

function applySpanLabel(btn) {
  if (btn) btn.textContent = getSettings().resultSpan === 'next' ? 'Next departures' : 'Whole day';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '🌙 Dark' : '☀️ Light';
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

// ── ABOUT SHEET ──
// The small print lives here now, off the main Settings screen.
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
    el('p', { class: 'muted attribution' }, [
      el('span', { text: 'Routing by ' }), link('https://transitous.org', 'Transitous'),
      el('span', { text: ' · ' }), link('https://transitous.org/sources/', 'data sources'),
      el('span', { text: ' · map data © ' }), link('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'),
    ]),
    el('p', { class: 'muted attribution', text:
      'Coach schedules derived from timetables published by Regione Siciliana and the operators (SAIS Autolinee via their public timetable API) · live trains via ViaggiaTreno.' }),
    el('p', { class: 'muted attribution' }, [
      link('https://github.com/mangonese09/ManGO-IT', 'Source code on GitHub'),
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

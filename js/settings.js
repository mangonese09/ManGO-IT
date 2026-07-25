// ── SETTINGS ──
import { APP_VERSION } from './version.js';
import { getSettings, patchSettings, getFreshness, clearAllAppData } from './store.js';
import { agoText } from './time.js';
import { confirmModal } from './ui.js';
import { toast } from './toast.js';

export function initSettings() {
  applyTheme(getSettings().theme);
  document.getElementById('app-version').textContent = `v${APP_VERSION}`;

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = getSettings().theme === 'dark' ? 'light' : 'dark';
    patchSettings({ theme: next });
    applyTheme(next);
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
  renderFreshness();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '🌙 Dark' : '☀️ Light';
}

export function renderFreshness() {
  const f = getFreshness();
  const rows = [
    ['Transitous routing', f.transitous],
    ['ViaggiaTreno live trains', f.viaggiatreno],
  ];
  const holder = document.getElementById('freshness');
  holder.innerHTML = '';
  for (const [label, ts] of rows) {
    const row = document.createElement('div');
    row.className = 'fresh-row';
    row.innerHTML = `<span>${label}</span><span class="muted">${ts ? agoText(ts) : 'not fetched yet'}</span>`;
    holder.appendChild(row);
  }
}

async function checkForUpdates() {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await res.json();
    if (version === APP_VERSION) { toast(`Up to date (v${APP_VERSION})`, 'info'); return; }
    toast(`Updating to v${version}…`, 'info');
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.update(); }
    setTimeout(() => location.reload(true), 800);
  } catch {
    toast('Could not check for updates', 'warn');
  }
}

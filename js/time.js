// ── ROME TIME HELPERS ──
// Everything schedule-related renders in Europe/Rome, never the device zone.
// The device is likely set to Chicago while planning and Rome while travelling.

const ROME = 'Europe/Rome';

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, weekday: 'short', day: 'numeric', month: 'short' });

export function romeTime(iso) {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d) ? '—' : hm.format(d);
}

export function romeDay(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d) ? '—' : dayFmt.format(d);
}

// Rome wall-clock hour (0–23) for an instant, device-zone-safe.
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', hour12: false });
export function romeHour(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d)) return null;
  const h = Number(hourFmt.format(d));
  return h === 24 ? 0 : h; // some ICU builds render midnight as "24"
}

// Whole-day results (§5.7) cluster into three scannable dayparts. Late-night
// (0–3, the tail of evening service) rides with the evening so a 23:40 and a
// 00:30 departure sit together. Pure over an hour number — no zone math.
export function dayPartKey(hour) {
  if (hour >= 4 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}
export const DAYPARTS = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
];

// True if `iso` falls on a different Rome calendar day than now.
export function isOtherRomeDay(iso, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: ROME, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(iso)) !== f.format(now);
}

export function durationText(seconds) {
  if (!isFinite(seconds)) return '—';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "3 min" / "now" countdown to an ISO time; negative → "gone".
// Past 60 min it stays relative ("2h 05m") — the clock time is already
// rendered alongside, so returning a clock here would duplicate it.
export function countdownText(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  const m = Math.round(ms / 60000);
  if (m <= -2) return 'gone';
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  // beyond a day — a sparse stop's next run can be days out; "336h 00m" reads
  // like a glitch, "in 14d" reads like a schedule
  if (m >= 1440) return `${Math.round(m / 1440)}d`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function agoText(epochMs, now = Date.now()) {
  if (!epochMs) return '';
  const m = Math.floor((now - epochMs) / 60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1m ago';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// datetime-local value ("2026-07-28T15:30") → chip label ("Tue 28 Jul · 15:30").
// Pure wall-clock formatting: the value already IS Italy time, so no zone math.
export function whenLabel(value) {
  if (!value) return 'Now';
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(Date.UTC(y, mo - 1, d)));
  return `${day} · ${timePart}`;
}

// Local datetime-input value (rendered in Rome time) → ISO instant string.
// input like "2026-07-27T08:30" interpreted as Rome wall clock.
export function romeWallToIso(value) {
  if (!value) return null;
  // Find the UTC instant whose Rome rendering matches the requested wall time.
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi) - 2 * 3600 * 1000; // start near CEST
  for (let i = 0; i < 3; i++) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: ROME, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const got = Date.UTC(+f.year, +f.month - 1, +f.day, f.hour === '24' ? 0 : +f.hour, +f.minute);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (got === want) break;
    guess += want - got;
  }
  return new Date(guess).toISOString();
}

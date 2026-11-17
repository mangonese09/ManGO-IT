// ── TOASTS ──
let holder = null;

// The live region must exist BEFORE text lands in it to be announced, so it
// is created at load, not with the first toast.
function ensureHolder() {
  if (holder || typeof document === 'undefined' || !document.body) return;
  holder = document.createElement('div');
  holder.className = 'toast-holder';
  holder.setAttribute('role', 'status');
  holder.setAttribute('aria-live', 'polite');
  document.body.appendChild(holder);
}
ensureHolder();

export function toast(message, kind = 'info', ms = 3200) {
  ensureHolder();
  if (!holder) return;
  // single-toast policy: a new toast replaces whatever is showing
  for (const old of [...holder.children]) old.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  if (kind === 'warn' || kind === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ── TOASTS ──
let holder = null;

export function toast(message, kind = 'info', ms = 3200) {
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'toast-holder';
    document.body.appendChild(holder);
  }
  // single-toast policy: a new toast replaces whatever is showing
  for (const old of [...holder.children]) old.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

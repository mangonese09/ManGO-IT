// ── SYNC (1.18.0) ── optional Google sign-in that carries saved places,
// favourite stops and lines across devices (shared Settings mockup
// TRK7YuPf2QsAsoHZvaNptF). Everything works signed out; nothing loads from
// Google until someone signs in or was signed in on this device before.
//
// Account: Firebase Auth in ManGO's project (mango-blueline-2026). Data:
// Firestore users/{uid}/apps/mangoit = { places, favstops, favlines, updatedAt }
// — the project's rules already give each uid its own users/{uid} subtree.
// Merge rule (no-loss, 1.18.1): a three-way merge per item key against what
// the last sync agreed on ("base"). Anything added on either side is kept;
// anything deleted on one side since the last sync is removed; an item both
// sides still have takes this phone's version. Before a pull changes this
// phone's lists, the previous lists are snapshotted (last 3 kept).
import { readSynced, applySynced, onUserWrite, SYNC_KEYS } from './store.js';

const FB = 'https://www.gstatic.com/firebasejs/11.10.0/';
const CONFIG = {
  apiKey: 'AIzaSyDCw8T-vnp1CRBl6h9wPSQMA_mWlc4kHrI',
  // same-site auth helper (nginx proxies /__/ to mango-blueline-2026.firebaseapp.com): Chrome's storage
  // partitioning broke the cross-site hand-off with "missing initial state" on Android (2026-11-19)
  authDomain: 'it.mangonese.dev',
  projectId: 'mango-blueline-2026',
  appId: '1:350555083236:web:97fdff85b58eed44f2f7f1',
};
const LS_ACTIVE = 'mangoit.__sync.active';   // "1" once signed in here: load Firebase at boot
const LS_PULLED = 'mangoit.__sync.at';       // cloud updatedAt this device last matched
const LS_BASE = 'mangoit.__sync.base';       // item keys per list at the last agreed sync
const LS_SNAP = 'mangoit.__sync.snapshots';  // [{at, data}] newest first, the lists before a pull changed them

let fb = null, user = null, unsubWrite = null, pushTimer = null, applying = false;
const listeners = new Set();
let status = { state: 'signed-out', at: null, error: null };   // signed-out | syncing | synced | error
const emit = () => { for (const fn of listeners) { try { fn(user, status); } catch { /* a view never blocks sync */ } } };
const setStatus = (s) => { status = { ...status, ...s }; emit(); };
export function onSyncChange(fn) { listeners.add(fn); fn(user, status); return () => listeners.delete(fn); }
export const currentUser = () => user;

function loadFirebase() {
  if (!fb) {
    fb = Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore-lite.js')])
      .then(([app, auth, fs]) => {
        const a = app.initializeApp(CONFIG, 'mangoit');
        return { auth, fs, a: auth.getAuth(a), db: fs.getFirestore(a) };
      })
      .catch((e) => { fb = null; throw e; });
  }
  return fb;
}

const keyOf = (x) => (x && (x.key || x.id)) || JSON.stringify(x);
const isEmpty = (d) => SYNC_KEYS.every((k) => !(d[k] || []).length);
const readJson = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota: sync still works, just less history */ } };
const baseOf = (d) => Object.fromEntries(SYNC_KEYS.map((k) => [k, (d[k] || []).map(keyOf)]));
const sameLists = (a, b) => SYNC_KEYS.every((k) => JSON.stringify(a[k] || []) === JSON.stringify(b[k] || []));

// three-way merge; exported for the unit test
export function merge3(local, cloud, base) {
  const out = {};
  for (const k of SYNC_KEYS) {
    const L = local[k] || [], C = cloud[k] || [], B = new Set((base && base[k]) || []);
    const lk = new Map(L.map((x) => [keyOf(x), x])), ck = new Map(C.map((x) => [keyOf(x), x]));
    const res = [];
    // this phone's order first: kept unless the other side deleted it since the last sync
    for (const [key, x] of lk) if (ck.has(key) || !B.has(key)) res.push(x);
    // the other side's additions (not deleted here since the last sync)
    for (const [key, x] of ck) if (!lk.has(key) && !B.has(key)) res.push(x);
    out[k] = res;
  }
  return out;
}

function snapshot(data) {
  const snaps = readJson(LS_SNAP, []);
  snaps.unshift({ at: Date.now(), data });
  writeJson(LS_SNAP, snaps.slice(0, 3));
}
export const syncSnapshots = () => readJson(LS_SNAP, []);

async function docRef() { const { fs, db } = await loadFirebase(); return fs.doc(db, 'users', user.uid, 'apps', 'mangoit'); }

async function push() {
  if (!user) return;
  const { fs } = await loadFirebase();
  const at = Date.now();
  setStatus({ state: 'syncing' });
  try {
    const data = readSynced();
    await fs.setDoc(await docRef(), { ...data, updatedAt: at });
    try { localStorage.setItem(LS_PULLED, String(at)); } catch { /* */ }
    writeJson(LS_BASE, baseOf(data));
    setStatus({ state: 'synced', at, error: null });
  } catch (e) { setStatus({ state: 'error', error: navigator.onLine === false ? 'offline' : (e.code || e.message) }); }
}
const schedulePush = () => { if (applying || !user) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); };

// first contact after sign-in or boot: merge both sides, then make them equal
async function pull() {
  const { fs } = await loadFirebase();
  setStatus({ state: 'syncing' });
  try {
    const snap = await fs.getDoc(await docRef());
    const cloud = snap.exists() ? snap.data() : null;
    const local = readSynced();
    if (!cloud || isEmpty(cloud)) { await push(); return; }
    const merged = merge3(local, cloud, readJson(LS_BASE, null));
    if (!sameLists(merged, local)) {
      snapshot(local);
      applying = true;
      try { applySynced(merged); } finally { applying = false; }
      window.dispatchEvent(new CustomEvent('mangoit:synced'));   // views re-render their lists
    }
    if (!sameLists(merged, cloud)) await push();
    else {
      try { localStorage.setItem(LS_PULLED, String(cloud.updatedAt || Date.now())); } catch { /* */ }
      writeJson(LS_BASE, baseOf(merged));
      setStatus({ state: 'synced', at: cloud.updatedAt || Date.now(), error: null });
    }
  } catch (e) { setStatus({ state: 'error', error: navigator.onLine === false ? 'offline' : (e.code || e.message) }); }
}

async function attach(u) {
  user = u;
  try { localStorage.setItem(LS_ACTIVE, '1'); } catch { /* */ }
  if (!unsubWrite) unsubWrite = onUserWrite(schedulePush);
  emit();
  await pull();
}

// Boot: only a device that signed in before loads Firebase.
let booted = false;
export async function initSync() {
  if (!watching) {
    watching = true;
    // a sign-in finished in a Chrome tab while this app window stayed open
    const recheck = () => { if (!user && (readJson(LS_TOKEN, null) || (!booted && localStorage.getItem(LS_ACTIVE) === '1'))) initSync().catch(() => {}); };
    window.addEventListener('storage', (e) => { if (e.key === LS_TOKEN || e.key === LS_ACTIVE) recheck(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
  }
  if (readJson(LS_TOKEN, null) && await finishPendingSignIn()) { booted = true; watchAuth(); return; }
  let active = false; try { active = localStorage.getItem(LS_ACTIVE) === '1'; } catch { /* */ }
  if (!active || booted) return;
  booted = true;
  watchAuth();
}
let watching = false, authWatched = false;
async function watchAuth() {
  if (authWatched) return;
  authWatched = true;
  try {
    const { auth, a } = await loadFirebase();
    auth.onAuthStateChanged(a, (u) => {
      if (u && (!user || user.uid !== u.uid)) attach(u);
      else if (!u && user) { user = null; setStatus({ state: 'signed-out' }); }
      else if (!u) setStatus({ state: 'signed-out' });
    });
  } catch { authWatched = false; setStatus({ state: 'error', error: 'offline' }); }
}

// ── SIGN-IN (1.18.4) ── a plain redirect to Google and back; no popup, no FedCM.
// On the installed Android app, Google's button fell back to a popup that
// Android opened as an ordinary Chrome tab with no way back to the app, so it
// sat on a blank accounts.google.com/gsi/transform page (field report
// 2026-11-19). Now the app navigates to Google's account chooser and Google
// sends an ID token back to /__/auth/handler (the only return address this
// OAuth client accepts; nginx serves gsi-return.html there when the request
// carries no query, and everything else still goes to Firebase). The return
// page checks state + nonce, parks the token in localStorage, and the app
// finishes with Firebase signInWithCredential: no sessionStorage, so it works
// whether Google returns inside the app or in a Chrome tab.
const GIS_CLIENT_ID = '350555083236-33udc1ou3iukrp4ka9laml8sbvrm982e.apps.googleusercontent.com';
const LS_OAUTH = 'mangoit.__sync.oauth';     // {state, nonce, at} while the round trip is open
const LS_TOKEN = 'mangoit.__sync.idtoken';   // {token, at} parked by gsi-return.html
const ROUND_TRIP_MS = 10 * 60000;
const rand = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };

export function googleAuthUrl(state, nonce, origin) {
  const q = new URLSearchParams({
    client_id: GIS_CLIENT_ID, redirect_uri: origin + '/__/auth/handler',
    response_type: 'id_token', scope: 'openid email profile',
    nonce, state, prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

function startGoogleSignIn() {
  const state = rand(), nonce = rand();
  writeJson(LS_OAUTH, { state, nonce, at: Date.now() });
  location.assign(googleAuthUrl(state, nonce, location.origin));
}

// The token gsi-return.html parked, if a sign-in round trip just finished.
async function finishPendingSignIn(onError) {
  const p = readJson(LS_TOKEN, null);
  if (!p) return false;
  try { localStorage.removeItem(LS_TOKEN); } catch { /* */ }
  if (!p.token || !(Date.now() - p.at < ROUND_TRIP_MS)) return false;
  try {
    const { auth, a } = await loadFirebase();
    const res = await auth.signInWithCredential(a, auth.GoogleAuthProvider.credential(p.token));
    await attach(res.user);
    return true;
  } catch (e) {
    const m = navigator.onLine === false ? 'You’re offline — signing in needs a connection' : 'Sign-in didn’t go through — ' + ((e && (e.code || e.message)) || 'try again');
    pendingError = m; if (onError) onError(m);
    return false;
  }
}
let pendingError = null;

// Draws the sign-in button into `container`; onError(message) reports a failed sign-in.
export async function renderSignInButton(container, { onError } = {}) {
  if (pendingError && onError) { onError(pendingError); pendingError = null; }
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'acct-google';
  // fixed markup, no interpolation: the four-colour Google "G"
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.8 6.1C12.3 13.7 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.4 0-11.7-4.2-13.6-9.9l-7.8 6.1C6.6 42.6 14.6 48 24 48z"/></svg><span>Continue with Google</span>';
  btn.addEventListener('click', () => {
    if (navigator.onLine === false) { onError && onError('You’re offline — signing in needs a connection'); return; }
    btn.disabled = true; btn.lastChild.textContent = 'Opening Google…';
    try { startGoogleSignIn(); } catch (e) { btn.disabled = false; btn.lastChild.textContent = 'Continue with Google'; onError && onError('Couldn’t open Google sign-in — try again'); }
  });
  container.replaceChildren(btn);
}

export async function signOut() {
  clearTimeout(pushTimer);
  if (user) await push().catch(() => {});   // the last change reaches the account first
  try { const { auth, a } = await loadFirebase(); await auth.signOut(a); } catch { /* offline: local state still clears */ }
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* GIS not loaded */ }
  user = null;
  try { localStorage.removeItem(LS_ACTIVE); localStorage.removeItem(LS_PULLED); localStorage.removeItem(LS_BASE); } catch { /* keep the snapshots: they are this phone's safety net */ }
  setStatus({ state: 'signed-out', at: null, error: null });
}

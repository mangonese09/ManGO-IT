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
export async function initSync() {
  let active = false; try { active = localStorage.getItem(LS_ACTIVE) === '1'; } catch { /* */ }
  if (!active) return;
  try {
    const { auth, a } = await loadFirebase();
    const r = await auth.getRedirectResult(a).catch(() => null);
    auth.onAuthStateChanged(a, (u) => {
      if (u && (!user || user.uid !== u.uid)) attach(u);
      else if (!u && user) { user = null; setStatus({ state: 'signed-out' }); }
      else if (!u) setStatus({ state: 'signed-out' });
    });
  } catch { setStatus({ state: 'error', error: 'offline' }); }
}

// ── SIGN-IN BUTTON (1.18.3) ── Google's own in-page sign-in (Google Identity
// Services, FedCM on Android Chrome). The account chooser opens over the app and
// hands back a Google ID token, which signs in to Firebase with no redirect and
// no popup returning to this origin — the installed PWA captured that return
// ("missing initial state"), and Chrome's storage partitioning broke the
// firebaseapp.com hand-off before that.
const GIS_CLIENT_ID = '350555083236-33udc1ou3iukrp4ka9laml8sbvrm982e.apps.googleusercontent.com';
let gisPromise = null;
function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(window.google.accounts.id);
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = () => (window.google && window.google.accounts ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in didn’t load')));
      sc.onerror = () => { gisPromise = null; reject(new Error('Google sign-in didn’t load — check your connection')); };
      document.head.appendChild(sc);
    });
  }
  return gisPromise;
}

// Draws Google's button into `container`; onError(message) reports a failed sign-in.
export async function renderSignInButton(container, { onError, onBusy } = {}) {
  const [gid] = await Promise.all([loadGis(), loadFirebase()]);
  gid.initialize({
    client_id: GIS_CLIENT_ID,
    use_fedcm_for_button: true,
    use_fedcm_for_prompt: true,
    ux_mode: 'popup',
    callback: async (resp) => {
      onBusy && onBusy(true);
      try {
        const { auth, a } = await loadFirebase();
        const res = await auth.signInWithCredential(a, auth.GoogleAuthProvider.credential(resp.credential));
        auth.onAuthStateChanged(a, (u) => { if (!u && user) { user = null; setStatus({ state: 'signed-out' }); } });
        await attach(res.user);
      } catch (e) { onError && onError(navigator.onLine === false ? 'You’re offline — signing in needs a connection' : 'Sign-in didn’t go through — ' + ((e && (e.code || e.message)) || 'try again')); }
      finally { onBusy && onBusy(false); }
    },
  });
  container.replaceChildren();
  gid.renderButton(container, { type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', logo_alignment: 'center', width: Math.min(400, Math.max(200, container.clientWidth || 320)) });
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

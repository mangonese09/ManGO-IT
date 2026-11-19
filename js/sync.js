// ── SYNC (1.18.0) ── optional Google sign-in that carries saved places,
// favourite stops and lines across devices (shared Settings mockup
// TRK7YuPf2QsAsoHZvaNptF). Everything works signed out; nothing loads from
// Google until someone signs in or was signed in on this device before.
//
// Account: Firebase Auth in ManGO's project (mango-blueline-2026). Data:
// Firestore users/{uid}/apps/mangoit = { places, favstops, favlines, updatedAt }
// — the project's rules already give each uid its own users/{uid} subtree.
// Merge rule: the newer side wins as a whole list set (one person, a few
// devices); the first sign-in on a device with data of its own unions both
// sides by key so nothing saved before signing in is lost.
import { readSynced, applySynced, onUserWrite, SYNC_KEYS } from './store.js';

const FB = 'https://www.gstatic.com/firebasejs/11.10.0/';
const CONFIG = {
  apiKey: 'AIzaSyDCw8T-vnp1CRBl6h9wPSQMA_mWlc4kHrI',
  authDomain: 'mango-blueline-2026.firebaseapp.com',
  projectId: 'mango-blueline-2026',
  appId: '1:350555083236:web:97fdff85b58eed44f2f7f1',
};
const LS_ACTIVE = 'mangoit.__sync.active';   // "1" once signed in here: load Firebase at boot
const LS_PULLED = 'mangoit.__sync.at';       // cloud updatedAt this device last matched

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

const keyOf = (k, x) => (x && (x.key || x.id)) || JSON.stringify(x);
function union(local, cloud) {
  const out = {};
  for (const k of SYNC_KEYS) {
    const seen = new Map();
    for (const x of (cloud[k] || [])) seen.set(keyOf(k, x), x);
    for (const x of (local[k] || [])) if (!seen.has(keyOf(k, x))) seen.set(keyOf(k, x), x);
    out[k] = [...seen.values()];
  }
  return out;
}
const isEmpty = (d) => SYNC_KEYS.every((k) => !(d[k] || []).length);

async function docRef() { const { fs, db } = await loadFirebase(); return fs.doc(db, 'users', user.uid, 'apps', 'mangoit'); }

async function push() {
  if (!user) return;
  const { fs } = await loadFirebase();
  const at = Date.now();
  setStatus({ state: 'syncing' });
  try {
    await fs.setDoc(await docRef(), { ...readSynced(), updatedAt: at });
    try { localStorage.setItem(LS_PULLED, String(at)); } catch { /* */ }
    setStatus({ state: 'synced', at, error: null });
  } catch (e) { setStatus({ state: 'error', error: navigator.onLine === false ? 'offline' : (e.code || e.message) }); }
}
const schedulePush = () => { if (applying || !user) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); };

// first contact after sign-in or boot: decide which side wins
async function pull({ firstOnThisDevice }) {
  const { fs } = await loadFirebase();
  setStatus({ state: 'syncing' });
  try {
    const snap = await fs.getDoc(await docRef());
    const cloud = snap.exists() ? snap.data() : null;
    const local = readSynced();
    const seenAt = Number(localStorage.getItem(LS_PULLED) || 0);
    if (!cloud || isEmpty(cloud)) { await push(); return; }
    let next = null;
    if (firstOnThisDevice && !isEmpty(local)) next = union(local, cloud);
    else if ((cloud.updatedAt || 0) > seenAt) next = cloud;
    if (next) {
      applying = true;
      try { applySynced(next); } finally { applying = false; }
      window.dispatchEvent(new CustomEvent('mangoit:synced'));   // views re-render their lists
      if (firstOnThisDevice && !isEmpty(local)) await push();
      else { try { localStorage.setItem(LS_PULLED, String(cloud.updatedAt || Date.now())); } catch { /* */ } setStatus({ state: 'synced', at: cloud.updatedAt || Date.now(), error: null }); }
    } else await push();
  } catch (e) { setStatus({ state: 'error', error: navigator.onLine === false ? 'offline' : (e.code || e.message) }); }
}

async function attach(u, firstOnThisDevice) {
  user = u;
  try { localStorage.setItem(LS_ACTIVE, '1'); } catch { /* */ }
  if (!unsubWrite) unsubWrite = onUserWrite(schedulePush);
  emit();
  await pull({ firstOnThisDevice });
}

// Boot: only a device that signed in before loads Firebase.
export async function initSync() {
  let active = false; try { active = localStorage.getItem(LS_ACTIVE) === '1'; } catch { /* */ }
  if (!active) return;
  try {
    const { auth, a } = await loadFirebase();
    const r = await auth.getRedirectResult(a).catch(() => null);
    auth.onAuthStateChanged(a, (u) => {
      if (u && (!user || user.uid !== u.uid)) attach(u, !!(r && r.user));
      else if (!u && user) { user = null; setStatus({ state: 'signed-out' }); }
      else if (!u) setStatus({ state: 'signed-out' });
    });
  } catch { setStatus({ state: 'error', error: 'offline' }); }
}

export async function signIn() {
  if (navigator.onLine === false) throw new Error('You’re offline — signing in needs a connection');
  const { auth, a } = await loadFirebase();
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const cred = await auth.signInWithPopup(a, provider);
    auth.onAuthStateChanged(a, (u) => { if (!u && user) { user = null; setStatus({ state: 'signed-out' }); } });
    await attach(cred.user, true);
  } catch (e) {
    const code = e.code || '';
    if (/popup-blocked|operation-not-supported/.test(code)) { try { localStorage.setItem(LS_ACTIVE, '1'); } catch { /* */ } await auth.signInWithRedirect(a, provider); return; }
    if (/popup-closed-by-user|cancelled-popup-request/.test(code)) return;
    if (/unauthorized-domain/.test(code)) throw new Error('Google sign-in isn’t switched on for it.mangonese.dev yet');
    throw e;
  }
}

export async function signOut() {
  clearTimeout(pushTimer);
  if (user) await push().catch(() => {});   // the last change reaches the account first
  try { const { auth, a } = await loadFirebase(); await auth.signOut(a); } catch { /* offline: local state still clears */ }
  user = null;
  try { localStorage.removeItem(LS_ACTIVE); localStorage.removeItem(LS_PULLED); } catch { /* */ }
  setStatus({ state: 'signed-out', at: null, error: null });
}

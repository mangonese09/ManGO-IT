// ── A→B SEARCH ──
import { api } from './api.js';
import { el, modeMeta, modeClass, modeIcon, isRailMode, liveBadge, staleChip, openSheet } from './ui.js';
import { romeTime, romeDay, durationText, isOtherRomeDay, romeWallToIso } from './time.js';
import { worstTransferMin, transferTier, transferChipText, imminentText, legStripModel } from './itinerary.js';
import { operatorFor } from './operators.js';
import { getRecents, pushRecent, removeRecent, getFavStops, addFavStop, removeFavStop } from './store.js';
import { toast } from './toast.js';

// Selected endpoints: {name, place} where place is "lat,lon" or a stopId.
const sel = { from: null, to: null };
let departMode = 'depart'; // or 'arrive'

export function initSearch() {
  wireEndpoint('from');
  wireEndpoint('to');
  document.getElementById('swap-btn').addEventListener('click', swapEndpoints);
  document.getElementById('search-btn').addEventListener('click', runSearch);
  document.getElementById('when-toggle').addEventListener('click', toggleWhen);
  initModeToggles();
  renderRecents();
}


// programmatic value changes don't fire 'input' — call after any of them
function syncClears() {
  for (const w of ['from', 'to']) {
    const i = document.getElementById(`${w}-input`);
    const b = document.getElementById(`${w}-clear`);
    if (i && b) b.hidden = !i.value;
  }
}

function wireEndpoint(which) {
  const input = document.getElementById(`${which}-input`);
  const list = document.getElementById(`${which}-suggest`);
  const clearBtn = document.getElementById(`${which}-clear`);
  let timer = null;

  const syncClear = () => { clearBtn.hidden = !input.value; };
  clearBtn.addEventListener('click', () => {
    input.value = '';
    sel[which] = null;
    list.innerHTML = '';
    list.hidden = true;
    syncClear();
    input.focus();
  });

  input.addEventListener('input', () => {
    sel[which] = null;
    syncClear();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
    timer = setTimeout(() => suggest(which, q), 300);
  });
  input.addEventListener('focus', () => {
    if (which === 'from' && !input.value.trim()) showMyLocationOption(list, input);
  });
  // QA-23: Enter searches (was never wired; enterkeyhint promised it)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    list.hidden = true;
    if (sel.from && sel.to) runSearch();
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) { list.hidden = true; }
  });
}

function showMyLocationOption(list, input) {
  list.innerHTML = '';
  list.appendChild(el('button', {
    class: 'suggest-row suggest-loc',
    onclick: () => {
      list.hidden = true;
      input.value = 'My location';
      syncClears();
      locate().then((pos) => {
        sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`, lat: pos.lat, lon: pos.lon };
      }).catch(() => {
        input.value = '';
        syncClears();
        toast('Location unavailable — type a place instead', 'warn');
      });
    },
  }, [
    el('img', { src: '/icons/place-pin.png', alt: '' }),
    el('span', { text: ' My location' }),
  ]));
  list.hidden = false;
}

// ── MODE FILTERS (v0.9.0) ──
// Two honest buckets: trains vs buses+coaches. Tram/metro/ferry are
// marginal here and always stay included. Both-off is nonsense — blocked.
const RAIL_MODES = 'RAIL,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,REGIONAL_FAST_RAIL';
const BUS_MODES = 'BUS,COACH';
const ALWAYS_MODES = 'TRAM,METRO,SUBWAY,FERRY';
let modeSel = { train: true, bus: true };
try { modeSel = { ...modeSel, ...JSON.parse(localStorage.getItem('mangoit.modes') || '{}') } } catch { /* fresh */ }

function initModeToggles() {
  for (const which of ['train', 'bus']) {
    const btn = document.getElementById(`mode-${which}`);
    btn.classList.toggle('active', modeSel[which]);
    btn.setAttribute('aria-pressed', String(modeSel[which]));
    btn.addEventListener('click', () => {
      if (modeSel[which] && !modeSel[which === 'train' ? 'bus' : 'train']) {
        toast('Keep at least one mode on', 'warn');
        return;
      }
      modeSel[which] = !modeSel[which];
      btn.classList.toggle('active', modeSel[which]);
      btn.setAttribute('aria-pressed', String(modeSel[which]));
      try { localStorage.setItem('mangoit.modes', JSON.stringify(modeSel)); } catch { /* private mode */ }
      // QA-17: debounced — toggle bursts fire one search, not one per tap
      clearTimeout(initModeToggles._t);
      if (sel.from && sel.to) initModeToggles._t = setTimeout(runSearch, 400);
    });
  }
}

function planModes() {
  if (modeSel.train && modeSel.bus) return null; // no filter
  return (modeSel.train ? RAIL_MODES : BUS_MODES) + ',' + ALWAYS_MODES;
}

// belt-and-suspenders if upstream ignores transitModes
function itineraryAllowed(it) {
  for (const l of it.legs || []) {
    if (l.mode === 'WALK') continue;
    const isRail = /RAIL|LONG_DISTANCE/.test(l.mode || '');
    const isBus = l.mode === 'BUS' || l.mode === 'COACH';
    if (isRail && !modeSel.train) return false;
    if (isBus && !modeSel.bus) return false;
  }
  return true;
}

// star a stop/station straight from the Home suggestions -> Saved favorites
function suggestStar(r, kind) {
  const key = r.type === 'STOP' && r.id ? r.id : `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  const isFav = () => getFavStops().some((f) => f.key === key);
  const star = el('span', {
    class: `pin-btn suggest-star${isFav() ? ' pinned' : ''}`,
    role: 'button', tabindex: '0', 'aria-label': 'Save stop', text: isFav() ? '★' : '☆',
    onclick: (e) => {
      e.stopPropagation();
      if (isFav()) {
        removeFavStop(key);
        star.textContent = '☆'; star.classList.remove('pinned');
        toast('Removed from Saved', 'info', 1400);
      } else {
        const iconMode = r.type === 'COACH_STOP' ? 'COACH'
          : (r.modes || []).some((x) => /RAIL|LONG_DISTANCE/.test(x || '')) ? 'RAIL' : 'BUS';
        addFavStop({ key, name: r.name, kind, iconMode, stopId: r.type === 'STOP' ? r.id : null, lat: r.lat, lon: r.lon });
        star.textContent = '★'; star.classList.add('pinned');
        toast('Saved — see the Saved tab', 'info', 1400);
      }
    },
  });
  return star;
}

const suggestSeq = { from: 0, to: 0 };
async function suggest(which, q) {
  const list = document.getElementById(`${which}-suggest`);
  const seq = ++suggestSeq[which];
  try {
    const { data } = await api.geocode(q);
    if (seq !== suggestSeq[which]) return; // a newer request superseded this one
    list.innerHTML = '';
    list.innerHTML = '';
    for (const r of data.slice(0, 8)) {
      // every result states WHAT it is: train station / metro / tram /
      // city bus stop / intercity coach stop / town / address
      let iconEl = el('span', { class: 'mode-emoji', text: '📌' });
      let kind = '';
      if (r.type === 'STOP') {
        const m = r.modes || [];
        if (m.some((x) => /RAIL|LONG_DISTANCE/.test(x || ''))) { iconEl = modeIcon('RAIL'); kind = 'train station'; }
        else if (m.some((x) => /METRO|SUBWAY/.test(x || ''))) { iconEl = modeIcon('METRO'); kind = 'metro station'; }
        else if (m.some((x) => /TRAM/.test(x || ''))) { iconEl = modeIcon('TRAM'); kind = 'tram stop'; }
        else { iconEl = modeIcon('BUS'); kind = 'city bus stop'; }
      } else if (r.type === 'COACH_STOP') {
        iconEl = modeIcon('COACH'); kind = 'coach stop';
      } else if (/^(city|town|village|hamlet)/.test(r.category || '') || (!r.category && r.type === 'PLACE')) {
        iconEl = el('span', { class: 'mode-emoji', text: '🏘️' }); kind = 'town';
      } else if (r.type === 'ADDRESS' || /^(via|viale|corso|salita|piazza)\b/i.test(r.name)) {
        kind = 'address';
      }
      // context line: "what it is · town · province", never just an echo of the name
      const bits = [];
      if (kind) bits.push(kind);
      if (r.town && r.town.toLowerCase() !== r.name.toLowerCase()) bits.push(r.town);
      if (r.province && r.province !== r.town) bits.push(`prov. ${r.province}`);
      if (!bits.length && r.province) bits.push(`prov. ${r.province}`);
      list.appendChild(el('button', {
        class: 'suggest-row',
        onclick: () => {
          sel[which] = { name: r.name, place: r.type === 'STOP' && r.id ? r.id : `${r.lat},${r.lon}`, lat: r.lat, lon: r.lon };
          document.getElementById(`${which}-input`).value = r.name;
          syncClears();
          list.hidden = true;
          // destination-first: picking a To with no From = route me there from here
          if (which === 'to' && !sel.from) {
            document.getElementById('from-input').value = 'My location';
            syncClears();
            locate().then((pos) => {
              sel.from = { name: 'My location', place: `${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`, lat: pos.lat, lon: pos.lon };
              runSearch();
            }).catch(() => {
              document.getElementById('from-input').value = '';
              toast('Location unavailable — set a starting point', 'warn');
            });
          }
        },
      }, [
        el('span', { class: 'suggest-icon' }, [iconEl]),
        el('span', { class: 'suggest-name', text: r.name }),
        bits.length ? el('span', { class: 'suggest-area', text: bits.join(' · ') }) : null,
        (r.type === 'STOP' || r.type === 'COACH_STOP') ? suggestStar(r, kind) : null,
      ]));
    }
    list.hidden = data.length === 0;
  } catch {
    list.hidden = true;
  }
}

function swapEndpoints() {
  const fi = document.getElementById('from-input');
  const ti = document.getElementById('to-input');
  [fi.value, ti.value] = [ti.value, fi.value];
  [sel.from, sel.to] = [sel.to, sel.from];
  syncClears();
}

function toggleWhen() {
  departMode = departMode === 'depart' ? 'arrive' : 'depart';
  document.getElementById('when-toggle').textContent = departMode === 'depart' ? 'Depart' : 'Arrive by';
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 120000 },
    );
  });
}

function havM(a, b) {
  const p = Math.PI / 180, dl = (b.lon - a.lon) * p, dp = (b.lat - a.lat) * p;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

let searchSeq = 0;
async function runSearch() {
  const mySeq = ++searchSeq; // rapid re-searches (mode toggles) supersede in-flight ones
  const results = document.getElementById('results');
  if (!sel.from || !sel.to) {
    toast('Pick both places from the suggestions', 'warn');
    return;
  }
  // QA-01: same place both ends -> honest refusal, not loop-bus self-trips
  if (sel.from.name === sel.to.name ||
      (sel.from.lat && sel.to.lat && havM(sel.from, sel.to) < 400)) {
    toast('Origin and destination are the same place', 'warn');
    return;
  }
  results.innerHTML = '';
  results.appendChild(el('div', { class: 'loading', text: 'Finding routes…' }));

  const whenVal = document.getElementById('when-input').value;
  const params = { fromPlace: sel.from.place, toPlace: sel.to.place };
  if (whenVal) {
    params.time = romeWallToIso(whenVal);
    if (departMode === 'arrive') params.arriveBy = true;
  }
  const modes = planModes();
  if (modes) params.modes = modes;

  // Race the plan with our own direct lookup (answers in ms): direct coaches
  // render alongside WEAK plan results too, not only on total failure —
  // Transitous can "succeed" with a 4 h rail-replacement bus while our feed
  // holds a 2 h coach it hasn't ingested yet (audit F-4).
  // explicit travel dates flow through to the direct lookup, or a date-picked
  // search would render TODAY's coaches as the answer
  const qDate = whenVal ? whenVal.slice(0, 10) : null;
  const qAfterMin = (whenVal && departMode === 'depart')
    ? Number(whenVal.slice(11, 13)) * 60 + Number(whenVal.slice(14, 16)) : null;
  const directPromise = (modeSel.bus && sel.from?.lat && sel.to?.lat)
    ? api.direct({ fromLat: sel.from.lat, fromLon: sel.from.lon,
                   toLat: sel.to.lat, toLon: sel.to.lon,
                   date: qDate || undefined, afterMin: qAfterMin ?? undefined }).catch(() => null)
    : Promise.resolve(null);

  try {
    const { data, stale, fetchedAt } = await api.plan(params);
    if (mySeq !== searchSeq) return;
    pushRecent({ from: sel.from, to: sel.to });
    renderRecents();
    const allowed = (data.itineraries || []).filter(itineraryAllowed);
    renderItineraries(allowed, { stale, fetchedAt });
    const dir = await directPromise;
    if (mySeq !== searchSeq) return;
    const runs = dir?.data?.results || [];
    const xfers = dir?.data?.transfers || [];
    const its = allowed;
    if (!its.length) {
      const ok = renderDirectBlock(runs, 'empty', xfers);
      if (!ok) await renderDeadEnd(params, whenVal);
    } else if (runs.length) {
      const bestPlanMin = Math.min(...its.map((i) => (i.duration || 1e9) / 60));
      const bestDirectMin = Math.min(...runs.map(directRunMinutes));
      if (bestDirectMin + 15 < bestPlanMin) renderDirectBlock(runs, 'faster', xfers);
    }
    maybeHorizonNote(whenVal);
  } catch (err) {
    if (mySeq !== searchSeq) return;
    results.innerHTML = '';
    const dir = await directPromise;
    if (mySeq !== searchSeq) return;
    const ok = renderDirectBlock(dir?.data?.results || [], 'down', dir?.data?.transfers || []);
    if (!ok) {
      results.appendChild(el('div', { class: 'empty-state' }, [
        el('p', { text: 'No route found — the routing service may be unreachable.' }),
        el('p', { class: 'muted', text: 'Check the operator sites directly, or retry when back online.' }),
      ]));
    }
  }
}

// ── DEAD-END FALLBACKS (audit P1) ──
// Empty results are never a bare shrug: (1) admit when the query is past
// the verified schedule horizon, (2) probe the same trip tomorrow, (3) name
// the nearest stop our data actually serves when an endpoint is uncovered.
let healthPromise = null;
function feedHorizonDate() {
  healthPromise ||= api.health().catch(() => null);
  return healthPromise.then((h) => h?.data?.feedHorizon?.date || null);
}

function romeDateStr(offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86400000));
}

function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
  return nd.toISOString().slice(0, 10);
}

async function maybeHorizonNote(whenVal) {
  const horizon = await feedHorizonDate();
  const qDate = (whenVal && whenVal.slice(0, 10)) || romeDateStr(0);
  if (!horizon || qDate <= horizon) return;
  const results = document.getElementById('results');
  if (results.querySelector('.horizon-note')) return;
  results.appendChild(el('div', { class: 'horizon-note muted', text:
    `Coach schedules are verified through ${horizon}. On later dates coaches that do run may be missing here — recheck closer to travel.` }));
}

async function renderDeadEnd(params, whenVal) {
  const results = document.getElementById('results');
  const box = el('div', { class: 'empty-state' }, [
    el('p', { text: 'No connections found for this trip.' }),
  ]);
  results.appendChild(box);

  const baseDate = (whenVal && whenVal.slice(0, 10)) || romeDateStr(0);
  const probeDate = nextDateStr(baseDate);

  // next-day probe: "nothing today" usually means "the last run left",
  // and the honest answer is when the next one goes
  try {
    const probe = await api.plan({
      fromPlace: params.fromPlace, toPlace: params.toPlace,
      time: romeWallToIso(`${probeDate}T05:00`),
    });
    const its = probe?.data?.itineraries || [];
    if (its.length) {
      const first = its[0];
      box.appendChild(el('p', { text:
        `First connection on ${romeDay(first.startTime)}: ${romeTime(first.startTime)} → ${romeTime(first.endTime)} (${durationText(first.duration)}).` }));
      box.appendChild(el('button', { class: 'btn btn-ghost btn-small', text: 'Search that day instead', onclick: () => {
        document.getElementById('when-input').value = `${probeDate}T05:00`;
        departMode = 'depart';
        runSearch();
      } }));
    }
  } catch { /* probe is best-effort */ }

  // unserved-endpoint hint: say which side has no coverage and name the
  // closest stop that does
  for (const which of ['from', 'to']) {
    const pt = sel[which];
    if (!pt?.lat) continue;
    try {
      const near = await api.nearestServed(pt.lat, pt.lon);
      const s = near?.data?.stops?.[0];
      if (s && s.m > 2000) {
        box.appendChild(el('p', { class: 'muted', text:
          `${pt.name} has no nearby stop in our coach data — nearest served: ${s.name}, ${(s.m / 1000).toFixed(1)} km away.` }));
      }
    } catch { /* hint only */ }
  }

  // QA-12: never a bare one-liner — always close with something actionable
  const horizon = await feedHorizonDate();
  box.appendChild(el('p', { class: 'muted', text:
    (horizon ? `Coach schedules are verified through ${horizon}. ` : '') +
    'Try another date, swap the direction, or check the operator sites.' }));
  maybeHorizonNote(whenVal);
}

function directRunMinutes(r) {
  const [dh, dm] = r.dep.split(':').map(Number);
  const [ah, am] = r.arr.split(':').map(Number);
  return ((ah * 60 + am) - (dh * 60 + dm) + 1440) % 1440;
}

// QA-22: compact day marker — the clock stays the loudest thing on the line
function dayTag(day) {
  if (!day || day === 'today') return '';
  if (day === 'tomorrow') return ' +1';
  const d = new Date(day + 'T12:00:00Z');
  return isNaN(d) ? ` ${day}` : ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── DIRECT-RESULT DETAIL SHEETS ──
// Every result row opens a full itinerary breakdown, same as plan cards.
function detailWalkRow(m, text) {
  return el('div', { class: 'leg leg-walk' }, [
    modeIcon('WALK', 'mode-img mode-img-sm'),
    el('span', { text: ` ${text}` }),
  ]);
}

function detailCoachLeg(leg) {
  return el('div', { class: 'leg leg-transit' }, [
    el('span', { class: 'leg-route' }, [
      modeIcon('COACH', 'mode-img mode-img-sm'),
      el('span', { text: ` ${leg.route}` }),
    ]),
    el('div', { class: 'leg-stops' }, [
      el('div', { class: 'leg-stop' }, [
        el('strong', { text: leg.dep }), el('span', { text: ` ${leg.from}` }),
      ]),
      el('div', { class: 'leg-stop' }, [
        el('strong', { text: leg.arr }), el('span', { text: ` ${leg.to}` }),
      ]),
    ]),
    el('div', { class: 'muted leg-op', text: `${leg.operator} · scheduled times, no live status` }),
  ]);
}

function openDirectDetail(r) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${r.dep} → ${r.arr}` }),
    el('span', { class: 'muted', text: `${dayTag(r.day) || ' today'} · direct coach` }),
  ]));
  if (r.fromWalkM > 400) {
    const w = walkMin(r.fromWalkM);
    body.appendChild(detailWalkRow(r.fromWalkM,
      `${w} min walk (${(r.fromWalkM / 1000).toFixed(1)} km) to ${r.from} — leave by ~${leaveBy(r.dep, w)}`));
  }
  body.appendChild(detailCoachLeg(r));
  if (r.toWalkM > 400) {
    body.appendChild(detailWalkRow(r.toWalkM,
      `${walkMin(r.toWalkM)} min walk (${(r.toWalkM / 1000).toFixed(1)} km) from ${r.to} to your destination`));
  }
  openSheet(body, { title: 'Trip detail' });
}

function openChainDetail(c) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${c.legs[0].dep} → ${c.legs[1].arr}` }),
    el('span', { class: 'muted', text: `${dayTag(c.day) || ' today'} · 1 transfer` }),
  ]));
  if (c.fromWalkM > 400) {
    const w = walkMin(c.fromWalkM);
    body.appendChild(detailWalkRow(c.fromWalkM,
      `${w} min walk (${(c.fromWalkM / 1000).toFixed(1)} km) to ${c.legs[0].from} — leave by ~${leaveBy(c.legs[0].dep, w)}`));
  }
  body.appendChild(detailCoachLeg(c.legs[0]));
  body.appendChild(el('div', { class: 'leg leg-walk' }, [
    el('span', { text: `⏱ ${c.waitMin} min at ${c.xferStop}` }),
  ]));
  body.appendChild(detailCoachLeg(c.legs[1]));
  if (c.toWalkM > 400) {
    body.appendChild(detailWalkRow(c.toWalkM,
      `${walkMin(c.toWalkM)} min walk (${(c.toWalkM / 1000).toFixed(1)} km) from ${c.legs[1].to} to your destination`));
  }
  openSheet(body, { title: 'Trip detail' });
}

// Walk legs to/from the coach network (v0.7.1): an address 4 km from the
// nearest stop still gets its route — with the walk stated, not hidden.
const WALK_M_PER_MIN = 80; // ~4.8 km/h
function walkMin(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)); }

function leaveBy(dep, wMin) {
  const [h, mm] = dep.split(':').map(Number);
  const t = ((h * 60 + mm - wMin) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function walkChip(fromWalkM, toWalkM) {
  const total = (fromWalkM > 400 ? fromWalkM : 0) + (toWalkM > 400 ? toWalkM : 0);
  if (!total) return null;
  return el('span', { class: 'chip chip-walk' }, [
    modeIcon('WALK', 'mode-img mode-img-xs'),
    el('span', { text: `${walkMin(total)} min` }),
  ]);
}


const DIRECT_HEADS = {
  down: 'Routing unavailable — our coaches only',
  empty: 'Direct coaches',
  faster: 'Faster by coach',
};

// Direct single-leg coaches + one-transfer chains from our own feed,
// honestly labeled (scheduled times only).
function renderDirectBlock(runs, reason, transfers = []) {
  if (!runs.length && !transfers.length) return false;
  const results = document.getElementById('results');
  const kids = [
    el('div', { class: 'direct-head' }, [
      el('strong', { text: DIRECT_HEADS[reason] }),
      el('p', { class: 'muted', text: 'Scheduled times · tap a trip for details' }),
    ]),
    ...runs.map((r) => el('button', { class: 'dep-row dep-row-btn', onclick: () => openDirectDetail(r) }, [
      el('span', { class: 'dep-mode' }, [modeIcon('COACH')]),
      el('div', { class: 'dep-main dep-main-tight' }, [
        el('span', { class: 'dep-route' }, [
          el('span', { text: `${r.dep} → ${r.arr}${dayTag(r.day)}` }),
          walkChip(r.fromWalkM || 0, r.toWalkM || 0),
        ]),
        el('span', { class: 'muted dep-headsign dep-oneline', text: `${r.from} → ${r.to}` }),
      ]),
      el('span', { class: 'dep-chevron', text: '›' }),
    ])),
  ];
  for (const c of transfers) {
    kids.push(el('button', { class: 'dep-row xfer-row dep-row-btn', onclick: () => openChainDetail(c) }, [
      el('span', { class: 'dep-mode' }, [modeIcon('COACH'), modeIcon('COACH')]),
      el('div', { class: 'dep-main dep-main-tight' }, [
        el('span', { class: 'dep-route' }, [
          el('span', { text: `${c.legs[0].dep} → ${c.legs[1].arr}${dayTag(c.day)} · 1 transfer` }),
          walkChip(c.fromWalkM || 0, c.toWalkM || 0),
        ]),
        el('span', { class: 'muted dep-headsign dep-oneline', text: `${c.legs[0].from} → ${c.legs[1].to}` }),
      ]),
      el('span', { class: 'dep-chevron', text: '›' }),
    ]));
  }
  results.appendChild(el('div', { class: 'direct-block' }, kids));
  return true;
}

function renderItineraries(itineraries, { stale, fetchedAt }) {
  const results = document.getElementById('results');
  results.innerHTML = '';
  results.appendChild(staleChip(fetchedAt, stale));

  if (!itineraries.length) return; // caller renders direct results or the dead-end fallbacks

  for (const it of itineraries) results.appendChild(itineraryCard(it));
}

// Result card (audit P2, competitive §1–§4): dep→arr clocks dominant,
// proportional leg strip, worst-transfer risk chip, honest live/scheduled.
function itineraryCard(it) {
  const transitLegs = it.legs.filter((l) => l.mode !== 'WALK');

  const strip = el('div', { class: 'leg-strip' });
  for (const seg of legStripModel(it.legs)) {
    if (seg.walk) {
      strip.appendChild(seg.long
        ? el('span', { class: 'leg-walk-gap leg-walk-long' }, [modeIcon('WALK', 'mode-img mode-img-sm')])
        : el('span', { class: 'leg-walk-gap', text: '›' }));
      continue;
    }
    const m = modeMeta(seg.mode);
    strip.appendChild(el('span', {
      class: `leg-seg ${modeClass(seg.mode)}`, style: `flex-grow:${seg.pct}`,
      title: `${m.label} ${seg.label}`.trim(),
    }, [
      modeIcon(seg.mode, 'mode-img leg-glyph-img'),
      seg.label ? el('span', { class: 'leg-label', text: seg.label }) : null,
    ]));
  }

  const worst = worstTransferMin(it.legs);
  const tier = transferTier(worst);
  const imminent = imminentText(it.startTime);
  const anyLive = transitLegs.some((l) => l.realTime);

  return el('button', { class: 'card iti-card', onclick: () => openItineraryDetail(it) }, [
    el('div', { class: 'iti-times' }, [
      el('span', { class: 'iti-time', text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
      imminent ? el('span', { class: 'chip chip-imminent', text: imminent }) : null,
      el('span', { class: 'iti-dur', text: durationText(it.duration) }),
    ]),
    isOtherRomeDay(it.startTime) ? el('div', { class: 'iti-day muted', text: romeDay(it.startTime) }) : null,
    strip,
    el('div', { class: 'iti-meta' }, [
      el('span', { class: 'muted', text: it.transfers === 0 ? 'direct' : `${it.transfers} transfer${it.transfers > 1 ? 's' : ''}` }),
      tier === 'calm' ? el('span', { class: 'muted', text: transferChipText(worst, tier) }) : null,
      tier === 'tight' || tier === 'risky' ? el('span', { class: `chip chip-xfer-${tier}`, text: transferChipText(worst, tier) }) : null,
      liveBadge(anyLive),
    ]),
  ]);
}

// ── ITINERARY DETAIL ──
function openItineraryDetail(it) {
  const body = el('div', { class: 'iti-detail' });
  body.appendChild(el('div', { class: 'iti-detail-head' }, [
    el('strong', { text: `${romeTime(it.startTime)} → ${romeTime(it.endTime)}` }),
    el('span', { class: 'muted', text: ` · ${durationText(it.duration)} · ${romeDay(it.startTime)}` }),
  ]));

  it.legs.forEach((leg, i) => {
    if (leg.mode === 'WALK') {
      body.appendChild(el('div', { class: 'leg leg-walk' }, [
        modeIcon('WALK', 'mode-img mode-img-sm'),
        el('span', { text: ` ${durationText(leg.duration)} walk` }),
        el('span', { class: 'muted', text: leg.to?.name ? ` to ${leg.to.name}` : '' }),
      ]));
      return;
    }
    body.appendChild(renderTransitLeg(leg, i));
  });
  openSheet(body, { title: 'Trip detail' });
}

function renderTransitLeg(leg, idx) {
  const m = modeMeta(leg.mode);
  const op = operatorFor(leg.agencyName);
  const wrap = el('div', { class: 'leg' });

  wrap.appendChild(el('div', { class: 'leg-head' }, [
    el('span', { class: 'leg-route' }, [
      modeIcon(leg.mode, 'mode-img mode-img-sm'),
      el('span', { text: ` ${leg.displayName || leg.routeShortName || m.label}` }),
    ]),
    liveBadge(leg.realTime),
    leg.cancelled ? el('span', { class: 'badge badge-cancel', text: 'CANCELLED' }) : null,
  ]));
  if (leg.headsign) wrap.appendChild(el('div', { class: 'muted leg-headsign', text: `→ ${leg.headsign}` }));

  wrap.appendChild(el('div', { class: 'leg-stops' }, [
    legEndpointRow(leg.from, leg.from?.departure || leg.startTime, true),
    intermediateBlock(leg),
    legEndpointRow(leg.to, leg.to?.arrival || leg.endTime, false),
  ]));

  if (leg.agencyName) wrap.appendChild(el('div', { class: 'muted leg-agency', text: `Operated by ${leg.agencyName}` }));

  // Live Trenitalia status for rail legs, resolved by train number.
  if (isRailMode(leg.mode) && /trenitalia/i.test(leg.agencyName || '')) {
    const trainNr = (leg.tripShortName || leg.displayName || '').replace(/\D/g, '');
    if (trainNr) {
      const slot = el('div', { class: 'leg-live muted', text: 'Checking live status…' });
      wrap.appendChild(slot);
      api.vtLive(trainNr).then(({ data }) => {
        slot.innerHTML = '';
        if (!data.live) { slot.textContent = 'No live data for this train yet.'; return; }
        if (data.cancelled) { slot.appendChild(el('span', { class: 'badge badge-cancel', text: 'CANCELLED' })); return; }
        const d = data.delayMin;
        slot.appendChild(el('span', {
          class: `delay ${d > 4 ? 'delay-bad' : d > 0 ? 'delay-mid' : 'delay-ok'}`,
          text: d === null ? 'live' : d <= 0 ? 'on time' : `+${d} min`,
        }));
        if (data.lastSeenStation) slot.appendChild(el('span', { class: 'muted', text: ` · last seen at ${data.lastSeenStation}` }));
      }).catch(() => { slot.textContent = 'Live status unavailable.'; });
    }
  }

  // Ticketing block — informational only, links out (PRD non-goal: never sell).
  if (op) {
    wrap.appendChild(el('div', { class: 'ticket-block' }, [
      el('div', { class: 'ticket-title', text: `🎫 Tickets — ${op.name}` }),
      el('p', { class: 'muted', text: op.howToBuy }),
      el('a', { class: 'ticket-link', href: op.website, target: '_blank', rel: 'noopener', text: op.website.replace('https://', '') }),
    ]));
  }
  return wrap;
}

function legEndpointRow(place, timeIso, isDep) {
  return el('div', { class: 'stop-row stop-endpoint' }, [
    el('span', { class: 'stop-time', text: romeTime(timeIso) }),
    el('span', { class: 'stop-name', text: place?.name || '—' }),
    place?.track ? el('span', { class: 'badge badge-track', text: `bin. ${place.track}` }) : null,
  ]);
}

function intermediateBlock(leg) {
  const stops = leg.intermediateStops || [];
  if (!stops.length) return null;
  const list = el('div', { class: 'stop-list', hidden: 'hidden' });
  for (const s of stops) {
    list.appendChild(el('div', { class: 'stop-row' }, [
      el('span', { class: 'stop-time muted', text: romeTime(s.arrival || s.departure) }),
      el('span', { class: 'stop-name muted', text: s.name }),
    ]));
  }
  const btn = el('button', {
    class: 'stops-toggle', text: `${stops.length} stops ▾`,
    onclick: () => {
      const open = !list.hidden;
      list.hidden = open;
      btn.textContent = `${stops.length} stops ${open ? '▾' : '▴'}`;
    },
  });
  return el('div', {}, [btn, list]);
}

// ── RECENTS ──
function renderRecents() {
  const holder = document.getElementById('recents');
  const recents = getRecents();
  holder.innerHTML = '';
  if (!recents.length) return;
  recents.forEach((r, i) => {
    holder.appendChild(el('span', { class: 'chip chip-recent chip-recent-wrap' }, [
      el('button', {
        class: 'chip-recent-go', text: `${shortName(r.from.name)} → ${shortName(r.to.name)}`,
        onclick: () => {
          sel.from = r.from; sel.to = r.to;
          document.getElementById('from-input').value = r.from.name;
          document.getElementById('to-input').value = r.to.name;
          syncClears();
          runSearch();
        },
      }),
      el('button', {
        class: 'chip-recent-x', 'aria-label': 'Remove from recents', text: '✕',
        onclick: () => { removeRecent(i); renderRecents(); },
      }),
    ]));
  });
}
function shortName(n) { return (n || '').split('(')[0].trim().slice(0, 18); }

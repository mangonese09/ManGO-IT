// ── OPERATOR TICKETING INFO + FARES ──
// Informational only — the app never sells or reserves a ticket (PRD non-goal).
// Matched against agencyName from Transitous, case-insensitive substring.
//
// `fare` states (review §4.3) — never show a number the source can't stand behind:
//   flat    — exact published flat fare (urban buses): single (+ onboard) + passes
//   counter — no published price: "pay the driver / office" as TEXT, never a number
//   booking — priced in the operator's app / at booking (rail, long-distance,
//             band-priced coaches we can't yet compute): no number, how-to-buy only
// Every priced entry carries `asOf` + `source`. City-bus flats come from open data.

export const OPERATORS = [
  {
    match: ['trenitalia'],
    name: 'Trenitalia',
    mode: 'Regional rail',
    howToBuy: 'Buy at station machines, tabaccherie, or online/app. Paper tickets with a printed date/time are ready to board; app tickets are ready as-is. Onboard purchase is banned when boarding at Palermo C., Catania C., Messina C. or Siracusa — buy first or risk a fine. Rail-replacement buses use the same train ticket.',
    website: 'https://www.trenitalia.com',
    fare: { kind: 'booking', note: 'Fare depends on distance — shown in the Trenitalia app/site when you pick the train.', asOf: '2026-07' },
  },
  {
    match: ['ast', 'azienda siciliana trasporti'],
    name: 'AST — Azienda Siciliana Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the terminal ticket office, a bar-tabacchi, or online/app. Onboard sale from the driver is treated as exceptional, not the norm — don’t count on it. Tickets are undated: stamp yours in the onboard machine when you board. On an A/R return ticket, the return leg expires 7 days after the outbound is stamped.',
    website: 'https://www.aziendasicilianatrasporti.it',
    fare: { kind: 'booking', note: 'Distance-banded fare (urban rides €1.20). Confirm the exact price at the office or in the app.', asOf: '2026-07' },
  },
  {
    match: ['sais'],
    name: 'SAIS Trasporti / SAIS Autolinee',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the terminal ticket office or online; e-tickets are accepted. On the Palermo–Catania trunk, buy before boarding. Onboard purchase exists on some routes but is not guaranteed.',
    website: 'https://www.saisautolinee.it',
    fare: { kind: 'booking', note: 'Per-route fixed fare — confirm at the office or online.', asOf: '2026-07' },
  },
  {
    match: ['interbus', 'etna trasporti', 'etna', 'segesta'],
    name: 'Interbus / Etna Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy online or at terminal offices before you reach the stop — onboard sale is not guaranteed. Online fares are often cheaper than counter fares; a same-day return discount is available.',
    website: 'https://www.interbus.it',
    fare: { kind: 'booking', note: 'Priced online / at the office; a same-day return discount applies.', asOf: '2026-07' },
  },
  {
    match: ['amat'],
    name: 'AMAT Palermo',
    mode: 'Urban bus + tram',
    howToBuy: 'Buy at tabaccherie or via app before boarding; validate on board. On-board purchase costs more and there’s no sale on the tram. Fine €52 + fare.',
    website: 'https://www.amat.pa.it',
    fare: {
      kind: 'flat', single: 1.40, onboard: 1.80, unit: '90 min',
      passes: [{ name: 'Day', price: 3.50 }, { name: '3-day', price: 8.00 }, { name: 'Week', price: 16.50 }],
      asOf: '2026-07', source: 'amat.pa.it',
    },
  },
  {
    match: ['amts', 'amt catania'],
    name: 'AMTS Catania',
    mode: 'Urban bus',
    howToBuy: 'Buy at tabaccherie, kiosks, or via app; validate on board. Onboard costs more. Fine ≈ €84.',
    website: 'https://www.amts.ct.it',
    fare: {
      kind: 'flat', single: 1.40, onboard: 2.00, unit: '90 min',
      passes: [{ name: 'Day', price: 3.50 }],
      note: 'Alibus airport line is a separate €4.00 (€4.60 onboard) ticket.',
      asOf: '2026-07', source: 'amts.ct.it',
    },
  },
  {
    match: ['circumetnea', 'fce'],
    name: 'Ferrovia Circumetnea',
    mode: 'Catania metro + Etna railway',
    howToBuy: 'Buy at station counters, machines, or the app. MetroBus combined tickets cover FCE metro + AMTS bus.',
    website: 'https://www.circumetnea.it',
    fare: {
      kind: 'flat', single: 1.00, unit: 'single',
      passes: [{ name: '24h', price: 3.00 }],
      note: '€1.40 for 120 min. Prices are for the metro; the Etna railway is priced separately.',
      asOf: '2026-07', source: 'circumetnea.it',
    },
  },
  {
    match: ['tua', 'trasporti urbani agrigento'],
    name: 'TUA Agrigento',
    mode: 'Urban bus',
    howToBuy: 'Buy at tabaccherie or the app before boarding; validate on board. Onboard costs more.',
    website: 'https://www.trasportiurbaniagrigento.it',
    fare: {
      kind: 'flat', single: 1.20, onboard: 1.70, unit: '90 min',
      passes: [{ name: 'Day', price: 3.40 }],
      asOf: '2026-07', source: 'trasportiurbaniagrigento.it',
    },
  },
  {
    match: ['cuffaro'],
    name: 'Cuffaro',
    mode: 'Intercity coach',
    howToBuy: 'Buy on the Cuffaro site, at their offices, or onboard at some stops only.',
    website: 'https://www.cuffaro.info',
    fare: { kind: 'booking', note: 'Palermo–Agrigento €8.60 (return €13.70, valid 30 days); intermediate stops priced individually.', asOf: '2026-07', source: 'cuffaro.info' },
  },
  {
    match: ['lumia'],
    name: 'Autolinee Lumia',
    mode: 'Intercity coach',
    howToBuy: 'Pay the driver — bring coins (their own notice: get a ticket or coins before boarding).',
    website: 'https://www.autolineelumia.it',
    fare: { kind: 'counter', note: 'Pay the driver — bring coins.', asOf: '2026-07' },
  },
  {
    match: ['gallo'],
    name: 'Autolinee Gallo',
    mode: 'Intercity coach',
    howToBuy: 'Pay the driver or use their booking portal — no public price list.',
    website: 'https://www.autolineegallo.it',
    fare: { kind: 'counter', note: 'Pay the driver / booking portal — no published prices.', asOf: '2026-07' },
  },
  {
    // Word-boundary test, never substring: 'autolinee sal' is a PREFIX of
    // 'autolinee salemi', and bare 'sal' lives inside half of Sicily.
    match: [],
    test: (n) => /\bautolinee\s+sal\b/.test(n),
    name: 'Autolinee SAL',
    mode: 'Intercity coach',
    howToBuy: 'Book online at autolineesal.it or buy at their listed ticket offices (see the site’s Biglietterie page). Book ahead for airport runs.',
    website: 'https://www.autolineesal.it',
    fare: { kind: 'booking', note: 'Per-route fare — book online or at the office.', asOf: '2026-08', source: 'autolineesal.it' },
  },
  {
    match: ['camilleri'],
    name: 'Camilleri Argento & Lattuca',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the ticket office or ask for a phone quote (☎ 0922 471886).',
    website: null,
    fare: { kind: 'counter', note: 'Ticket office or phone quote (☎ 0922 471886).', asOf: '2026-07' },
  },
  {
    match: ['flixbus'],
    name: 'FlixBus',
    mode: 'Long-distance coach',
    howToBuy: 'Book online or in the FlixBus app — seat is tied to the booking; on-board purchase not guaranteed.',
    website: 'https://www.flixbus.it',
    fare: { kind: 'booking', note: 'Dynamic price — shown in the FlixBus app when you book.', asOf: '2026-07' },
  },
];

export function operatorFor(agencyName) {
  if (!agencyName) return null;
  const n = agencyName.toLowerCase();
  return OPERATORS.find((o) => (o.test ? o.test(n) : o.match.some((m) => n.includes(m)))) || null;
}

// ── FARE RENDERING HELPERS (pure, unit-tested) ──
export function eur(n) { return `€${Number(n).toFixed(2)}`; }

// The inline chip on a leg row (review §4.3/§4.6). Flat → the exact number;
// counter/booking → an honest word, never a fabricated price. null = no chrome.
export function fareChip(op) {
  const f = op && op.fare;
  if (!f) return null;
  if (f.kind === 'flat') return { state: 'exact', text: eur(f.single), sub: f.unit || null };
  if (f.kind === 'counter') return { state: 'counter', text: 'From driver' };
  if (f.kind === 'booking') return { state: 'muted', text: 'At booking' };
  return null;
}

// Lines for the "How to buy" panel's fare summary. urbanLegCount = how many legs
// of this same operator ride in the itinerary (for the day-pass hint, §4.5).
export function fareSummary(op, urbanLegCount = 1) {
  const f = op && op.fare;
  if (!f) return null;
  const out = { lines: [], passHint: null };
  if (f.kind === 'flat') {
    let main = `${eur(f.single)} · ${f.unit || 'single'}`;
    if (f.onboard) main += ` (${eur(f.onboard)} onboard)`;
    out.lines.push(main);
    if (f.passes && f.passes.length) {
      out.lines.push(f.passes.map((p) => `${p.name} ${eur(p.price)}`).join(' · '));
    }
    // Day pass beats singles at 3 rides; hint when the trip already uses 2+.
    const day = (f.passes || []).find((p) => /day/i.test(p.name));
    if (day && urbanLegCount >= 2) {
      out.passHint = `Round trip or 3+ rides today? The ${eur(day.price)} day pass beats singles.`;
    }
  } else if (f.note) {
    out.lines.push(f.note);
  }
  if (f.kind === 'flat' && f.note) out.lines.push(f.note);
  return out.lines.length || out.passHint ? out : null;
}

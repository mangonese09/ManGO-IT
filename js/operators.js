// ── OPERATOR TICKETING INFO ──
// Informational only — the app never sells or reserves a ticket (PRD non-goal).
// Matched against agencyName from Transitous, case-insensitive substring.

export const OPERATORS = [
  {
    match: ['trenitalia'],
    name: 'Trenitalia',
    mode: 'Regional rail',
    howToBuy: 'Buy at station machines, tabaccherie, or online/app. Paper tickets with a printed date/time are ready to board; app tickets are ready as-is. Onboard purchase is banned when boarding at Palermo C., Catania C., Messina C. or Siracusa — buy first or risk a fine. Rail-replacement buses use the same train ticket.',
    website: 'https://www.trenitalia.com',
  },
  {
    match: ['ast', 'azienda siciliana trasporti'],
    name: 'AST — Azienda Siciliana Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the terminal ticket office, a bar-tabacchi, or online/app. Onboard sale from the driver is treated as exceptional, not the norm — don’t count on it. Tickets are undated: stamp yours in the onboard machine when you board. On an A/R return ticket, the return leg expires 7 days after the outbound is stamped.',
    website: 'https://www.aziendasicilianatrasporti.it',
  },
  {
    match: ['sais'],
    name: 'SAIS Trasporti / SAIS Autolinee',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the terminal ticket office or online; e-tickets are accepted. On the Palermo–Catania trunk, buy before boarding. Onboard purchase exists on some routes but is not guaranteed.',
    website: 'https://www.saisautolinee.it',
  },
  {
    match: ['interbus', 'etna trasporti', 'etna'],
    name: 'Interbus / Etna Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy online or at terminal offices before you reach the stop — onboard sale is not guaranteed. Online fares are often cheaper than counter fares; a same-day return discount is available.',
    website: 'https://www.interbus.it',
  },
  {
    match: ['amat'],
    name: 'AMAT Palermo',
    mode: 'Urban bus + tram',
    howToBuy: 'Buy at tabaccherie or via app before boarding; validate on board. On-board purchase costs more.',
    website: 'https://www.amat.pa.it',
  },
  {
    match: ['amts', 'amt catania'],
    name: 'AMTS Catania',
    mode: 'Urban bus',
    howToBuy: 'Buy at tabaccherie, kiosks, or via app; validate on board.',
    website: 'https://www.amts.ct.it',
  },
  {
    match: ['circumetnea', 'fce'],
    name: 'Ferrovia Circumetnea',
    mode: 'Catania metro + Etna railway',
    howToBuy: 'Buy at station counters or machines.',
    website: 'https://www.circumetnea.it',
  },
  {
    match: ['flixbus'],
    name: 'FlixBus',
    mode: 'Long-distance coach',
    howToBuy: 'Book online or in the FlixBus app — seat is tied to the booking; on-board purchase not guaranteed.',
    website: 'https://www.flixbus.it',
  },
];

export function operatorFor(agencyName) {
  if (!agencyName) return null;
  const n = agencyName.toLowerCase();
  return OPERATORS.find((o) => o.match.some((m) => n.includes(m))) || null;
}

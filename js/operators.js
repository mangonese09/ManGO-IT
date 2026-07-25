// ── OPERATOR TICKETING INFO ──
// Informational only — the app never sells or reserves a ticket (PRD non-goal).
// Matched against agencyName from Transitous, case-insensitive substring.

export const OPERATORS = [
  {
    match: ['trenitalia'],
    name: 'Trenitalia',
    mode: 'Regional rail',
    howToBuy: 'Buy at station machines, tabaccherie, or online. Paper tickets from machines no longer need validation if they carry a date/time; app tickets are ready as-is.',
    website: 'https://www.trenitalia.com',
  },
  {
    match: ['ast', 'azienda siciliana trasporti'],
    name: 'AST — Azienda Siciliana Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy on board from the driver, or at the bus terminal ticket office / nearby bar-tabacchi in larger towns. Cash preferred.',
    website: 'https://www.aziendasicilianatrasporti.it',
  },
  {
    match: ['sais'],
    name: 'SAIS Trasporti / SAIS Autolinee',
    mode: 'Intercity coach',
    howToBuy: 'Buy at the terminal ticket office or online. On-board purchase possible on many routes but not guaranteed.',
    website: 'https://www.saisautolinee.it',
  },
  {
    match: ['interbus', 'etna trasporti', 'etna'],
    name: 'Interbus / Etna Trasporti',
    mode: 'Intercity coach',
    howToBuy: 'Buy online or at terminal offices. Online fares are often cheaper than counter fares.',
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

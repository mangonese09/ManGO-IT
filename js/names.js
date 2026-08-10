// ── DISPLAY CASING FOR FEED STOP NAMES ──
// GTFS sources ship stop names in ALL CAPS ("CALTANISSETTA XIRBI",
// "CATANIA (piazza Giovanni XXIII)"). Title-case them at render time only —
// stored data, dedupe keys and API params always keep the raw name.
//
// Conservative by design: only tokens with NO lowercase letters are touched,
// so already-clean names ("Palermo Lolli", "Catania Aer.Font") pass through
// unchanged. Roman numerals, digit-bearing tokens (S.S.113), single letters
// (E.) and road sigle (FS/SS/SP/SR) keep their caps; Italian particles go
// lowercase except at the start.

const PARTICLES = new Set([
  'di', 'del', 'della', 'dei', 'delle', 'degli', 'da', 'de',
  'la', 'le', 'lo', 'il', 'i', 'gli',
  'e', 'ed', 'a', 'ai', 'al', 'allo', 'alla', 'alle', 'agli',
  'in', 'su', 'sul', 'sullo', 'sulla', 'per', 'con', 'presso',
]);

const KEEP = new Set(['FS', 'SS', 'SP', 'SR']);

// Strict roman numeral (so GIOVANNI XXIII keeps XXIII). Particles are
// checked first, which shields DI/LI-style false positives.
const ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

const hasLower = /[a-zàèéìòùáíóú]/;
const hasLetter = /[A-Za-zÀ-ÿ]/;

function cap(seg) {
  const low = seg.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}

// One run of letters between separators. Cased independently so tokens with
// an attached parenthetical — "CALTANISSETTA(Via Rochester)" — still get
// their all-caps half fixed while the mixed-case half stays untouched.
function caseSegment(seg, isLeading) {
  if (hasLower.test(seg)) return seg;              // already mixed-case — hands off
  if (seg.length <= 1) return seg;                 // E. — initials keep caps
  if (PARTICLES.has(seg.toLowerCase())) {
    return isLeading ? cap(seg) : seg.toLowerCase();
  }
  if (KEEP.has(seg)) return seg;
  if (ROMAN.test(seg)) return seg;                 // XXIII, IV …
  return cap(seg);
}

// Route/line labels ("0 Aragona - -Raffadali", "S. Elisabetta - Palermo") carry
// parse-damage artefacts: a spurious leading "0 " corsa token and doubled hyphen
// separators. Tidy those and normalise the A–B separator to a spaced en-dash,
// then title-case. Bare route numbers ("109", "N2") pass through untouched.
export function cleanRouteName(name) {
  let s = String(name || '').trim();
  s = s.replace(/^0\s+(?=\D)/, '');        // drop a parse-damage leading "0 "
  s = s.replace(/\s*-\s*-\s*/g, ' – ');    // doubled dash "- -" → en-dash
  s = s.replace(/\s+-\s+/g, ' – ');         // spaced hyphen separator → en-dash
  s = s.replace(/\s{2,}/g, ' ').trim();
  return displayName(s);
}

// F-3 (2026-08-10 walkthrough): Trenitalia's rail-replacement runs arrive as
// a nameless "BUS" with no headsign — no board row may read bare "Bus". Say
// what the run IS. Returns null for anything that has a real name.
export function railReplacementLabel(mode, ids, route) {
  const rn = String(route || '').trim();
  if (mode !== 'BUS' || (rn && rn.toUpperCase() !== 'BUS')) return null;
  return /trenitalia/i.test(String(ids || '')) ? 'Rail replacement bus' : null;
}

// Feed abbreviations worth spelling out — a suggestion row reading
// "Catania Aer.Font" isn't a name anyone searched for.
const EXPANSIONS = [
  [/\bAer\.? ?Font\.?/i, 'Aeroporto Fontanarossa'],
];

// F-10: Italian ALL-CAPS feeds write final accents as apostrophes (CEFALU' =
// Cefalù). Word-final only — "Sant'Agata"'s apostrophe is FOLLOWED by a
// letter and must survive.
const APO_ACCENT = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' };

export function displayName(name) {
  if (!name) return '';
  let s = String(name);
  for (const [re, full] of EXPANSIONS) s = s.replace(re, full);
  // F-10 cosmetics (2026-08-10 walkthrough), display layer only:
  s = s.replace(/([AaEeIiOoUu])['’](?=[\s,)]|$)/g, (m, v) => APO_ACCENT[v] || m);
  s = s.replace(/(\S)- /g, '$1 - '); // a hyphen glued to the left word
  s = s.replace(/\s{2,}/g, ' ');
  return s.split(' ').map((tok, i) => {
    if (!hasLetter.test(tok)) return tok;          // pure punctuation/numbers
    if (/\d/.test(tok)) return tok;                // S.S.113, KM90 …
    let leading = i === 0;
    return tok.replace(/[A-Za-zÀ-ÿ]+/g, (seg) => {
      const out = caseSegment(seg, leading);
      leading = false;
      return out;
    });
  }).join(' ');
}

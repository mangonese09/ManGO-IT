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

// Capitalize the first letter and any letter after a separator
// (space handled by tokenizing; here: ' . ( - / apostrophes).
function capWord(w) {
  const low = w.toLowerCase();
  return low.replace(/(^|['’.(\-/])([a-zà-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

export function displayName(name) {
  if (!name) return '';
  return String(name).split(' ').map((tok, i) => {
    if (!hasLetter.test(tok)) return tok;            // pure punctuation/numbers
    if (hasLower.test(tok)) return tok;              // already mixed-case — hands off
    if (/\d/.test(tok)) return tok;                  // S.S.113, KM90 …
    const bare = tok.replace(/[^A-ZÀ-Þ]/g, '');
    if (bare.length <= 1) return tok;                // E. — initials keep caps
    if (PARTICLES.has(bare.toLowerCase())) {
      return i === 0 ? capWord(tok) : tok.toLowerCase();
    }
    if (KEEP.has(bare)) return tok;
    if (bare.length >= 2 && ROMAN.test(bare)) return tok; // XXIII, IV …
    return capWord(tok);
  }).join(' ');
}

// Resolving a typed name to a roster entry.
//
// This is the only thing standing between a resident's thumb-typed name and the
// attendance table. Downstream, scrape_attendance.py joins the export to the
// Point_Spreadsheet.xlsx workbook on NAME — there is no email or ID in that
// path — so a row written with a name the roster doesn't contain is not a
// slightly-wrong row, it is a row whose points silently never land. Every
// accepted submission therefore writes the roster's spelling, never the typed
// one.
//
// Matching runs in the Worker against roster rows read per request rather than
// against a stored normalized column, deliberately: a `name_key` column would
// have to be populated by scripts/seed_roster.py in Python and compared here in
// JavaScript, and this repo already carries three of those hand-mirrored pairs
// (QR_PREFIXES, WEEKLY_TYPES, MULTI_DAY_WINDOWS). A drifted normalizer fails
// far more quietly than a drifted event list. The roster is ~100 rows, so
// reading it whole costs one indexed scan.

// Dropped before comparison so "Jane Smith MD", "Jane Smith, M.D." and "Jane
// Smith" are the same person. Generational suffixes are included because
// residents type them inconsistently, and the roster rarely carries them.
const IGNORED_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'do', 'mbbs', 'phd', 'mph', 'dr']);

const MAX_INPUT_LENGTH = 100;

// Folds away every difference we consider cosmetic:
//   - accents ("Núñez" -> "nunez"), so an ASCII keyboard can reach every name
//   - case
//   - apostrophes and periods, which vanish entirely ("O'Brien" -> "obrien")
//   - hyphens and underscores, which become spaces, so "Smith-Jones" tokenizes
//     as two words and matches a roster entry written "Smith Jones"
// Anything else non-alphanumeric collapses to a space.
export function normalizeName(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip the combining marks NFD just split off
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Brazeau, Nicholas" -> "Nicholas Brazeau". Residents reading their name off a
// program roster often type it the way it is printed there. Only the first
// comma is honoured, and only when both sides are non-empty, so a trailing
// "Smith, MD" is left for IGNORED_TOKENS to handle rather than being read as a
// surname of "MD".
function uncomma(raw) {
  const i = raw.indexOf(',');
  if (i === -1) return raw;
  const last = raw.slice(0, i).trim();
  const first = raw.slice(i + 1).trim();
  if (!last || !first) return raw;
  return `${first} ${last}`;
}

export function nameTokens(raw) {
  const tokens = normalizeName(uncomma(raw)).split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !IGNORED_TOKENS.has(t));
  // A name made entirely of ignored tokens ("MD") keeps nothing; return the
  // raw tokens so it fails to match a real resident rather than matching every
  // resident on an empty token list.
  return kept.length ? kept : tokens;
}

// Three escalating rules, each tried against the whole roster before the next.
// Order matters: a resident whose full name matches exactly is resolved even if
// a looser rule would also have pulled in a second, different resident.
//
//   1. every token equal, in order  — "Nicholas Brazeau" = "Nicholas Brazeau"
//   2. all word breaks removed      — "Siobhan O Brien"  = "Siobhán O'Brien"
//   3. first and last token equal    — "Nicholas Brazeau" = "Nicholas J Brazeau"
//
// Rule 2 exists because normalizeName turns an apostrophe into nothing but a
// typed space into a break, so "O'Brien", "OBrien" and "O Brien" tokenize three
// different ways for the same surname. Comparing the letters with every break
// removed collapses all three, and is still a whole-name comparison — it cannot
// match two different people the way a looser rule could.
//
// Rule 3 is what lets a resident skip a middle name the roster carries (or add
// one it doesn't). It is also why ambiguity is reported rather than guessed:
// with a "John Smith" and a "John A Smith" on the roster, rule 3 matches both,
// and picking either would file attendance against the wrong person.
const MATCH_RULES = [
  (typed, entry) => typed.length === entry.length && typed.every((t, i) => t === entry[i]),
  (typed, entry) => typed.join('') === entry.join(''),
  (typed, entry) =>
    typed.length >= 2 &&
    entry.length >= 2 &&
    typed[0] === entry[0] &&
    typed[typed.length - 1] === entry[entry.length - 1],
];

// Returns one of:
//   { status: 'matched',   entry }   - exactly one roster row, use entry.name
//   { status: 'empty' }              - nothing usable was typed
//   { status: 'not_found' }          - no roster row under any rule
//   { status: 'ambiguous', count }   - a rule matched more than one resident
//
// Never returns a best guess. The caller turns 'ambiguous' into "see a chief",
// because the alternative is attendance credited to the wrong resident, which
// nobody would notice until points were tallied at the end of the year.
export function matchRosterName(typedName, rosterRows) {
  if (typeof typedName !== 'string' || typedName.length > MAX_INPUT_LENGTH) return { status: 'empty' };

  const typed = nameTokens(typedName);
  if (!typed.length) return { status: 'empty' };

  const candidates = rosterRows.map((row) => ({ row, tokens: nameTokens(row.name) }));

  for (const rule of MATCH_RULES) {
    const hits = candidates.filter((c) => c.tokens.length && rule(typed, c.tokens));
    if (hits.length === 1) return { status: 'matched', entry: hits[0].row };
    if (hits.length > 1) {
      // Two roster rows can be the same person seeded twice under different
      // email addresses. That is a roster problem, not a resident problem, so
      // treat identical names as a single match rather than stopping a resident
      // whose only mistake was existing in the roster twice.
      const distinct = new Set(hits.map((h) => h.tokens.join(' ')));
      if (distinct.size === 1) return { status: 'matched', entry: hits[0].row };
      return { status: 'ambiguous', count: hits.length };
    }
  }

  return { status: 'not_found' };
}

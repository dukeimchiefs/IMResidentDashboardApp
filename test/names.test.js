import test from 'node:test';
import assert from 'node:assert/strict';

import { matchRosterName, normalizeName } from '../functions/_lib/names.js';

// Stands in for the roster table. Only `name` matters to the matcher; email and
// test_account ride along because callers read them off the returned entry.
const ROSTER = [
  { email: 'a@duke.edu', name: 'Nicholas Brazeau', test_account: 0 },
  { email: 'b@duke.edu', name: "Siobhán O'Brien", test_account: 0 },
  { email: 'c@duke.edu', name: 'Ana-María Núñez', test_account: 0 },
  { email: 'd@duke.edu', name: 'Robert Chen', test_account: 0 },
];

function matched(typed, roster = ROSTER) {
  const result = matchRosterName(typed, roster);
  assert.equal(result.status, 'matched', `expected ${JSON.stringify(typed)} to match, got ${result.status}`);
  return result.entry.name;
}

test('an exact name matches', () => {
  assert.equal(matched('Nicholas Brazeau'), 'Nicholas Brazeau');
});

test('case and surrounding whitespace are ignored', () => {
  assert.equal(matched('  nicholas   BRAZEAU '), 'Nicholas Brazeau');
});

test('accents can be typed without them', () => {
  // A resident on a plain keyboard has no practical way to enter "Núñez", so
  // requiring it would lock them out of their own attendance.
  assert.equal(matched('ana-maria nunez'), 'Ana-María Núñez');
});

test('apostrophes are optional', () => {
  assert.equal(matched('siobhan obrien'), "Siobhán O'Brien");
  assert.equal(matched('Siobhan O Brien'), "Siobhán O'Brien");
});

test('a hyphenated name matches when typed with a space', () => {
  assert.equal(matched('Ana Maria Nunez'), 'Ana-María Núñez');
});

test('"Last, First" matches, since that is how program rosters print names', () => {
  assert.equal(matched('Brazeau, Nicholas'), 'Nicholas Brazeau');
});

test('credentials and generational suffixes are ignored', () => {
  assert.equal(matched('Nicholas Brazeau, M.D.'), 'Nicholas Brazeau');
  assert.equal(matched('Robert Chen Jr'), 'Robert Chen');
});

test('a middle name the roster lacks still matches on first and last', () => {
  assert.equal(matched('Nicholas James Brazeau'), 'Nicholas Brazeau');
});

test('a middle name the roster has may be omitted', () => {
  const roster = [{ email: 'e@duke.edu', name: 'Nicholas J Brazeau', test_account: 0 }];
  assert.equal(matched('Nicholas Brazeau', roster), 'Nicholas J Brazeau');
});

test('the roster spelling is returned, never the typed one', () => {
  // The whole point: scrape_attendance.py joins the workbook on this string, so
  // what gets written has to be the roster's canonical spelling.
  const result = matchRosterName('nicholas brazeau md', ROSTER);
  assert.equal(result.entry.name, 'Nicholas Brazeau');
});

test('an unknown name is rejected rather than approximated', () => {
  assert.equal(matchRosterName('Nick Brazo', ROSTER).status, 'not_found');
  assert.equal(matchRosterName('Jane Doe', ROSTER).status, 'not_found');
});

test('a first name alone does not match', () => {
  // Rule 2 needs at least two tokens on each side, so a bare "Nicholas" cannot
  // silently resolve to the only Nicholas on the roster.
  assert.equal(matchRosterName('Nicholas', ROSTER).status, 'not_found');
});

test('an ambiguous name is reported, not guessed', () => {
  const roster = [
    { email: 'f@duke.edu', name: 'John Smith', test_account: 0 },
    { email: 'g@duke.edu', name: 'John A Smith', test_account: 0 },
  ];
  const result = matchRosterName('John Smith', roster);
  // "John Smith" is an exact hit on the first entry under rule 1, which runs
  // before the looser first-and-last rule that would also pull in "John A
  // Smith". Exactness wins; nobody is asked to disambiguate needlessly.
  assert.equal(result.status, 'matched');
  assert.equal(result.entry.name, 'John Smith');

  // With no exact hit, rule 2 matches both and the request must stop.
  const ambiguous = matchRosterName('John Q Smith', roster);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.count, 2);
});

test('a resident seeded twice under different emails is not treated as ambiguous', () => {
  const roster = [
    { email: 'old@duke.edu', name: 'Robert Chen', test_account: 0 },
    { email: 'new@duke.edu', name: 'Robert Chen', test_account: 0 },
  ];
  const result = matchRosterName('Robert Chen', roster);
  assert.equal(result.status, 'matched', 'a duplicated roster row is a roster problem, not the resident’s');
  assert.equal(result.entry.name, 'Robert Chen');
});

test('empty and junk input is rejected without touching the roster', () => {
  assert.equal(matchRosterName('', ROSTER).status, 'empty');
  assert.equal(matchRosterName('   ', ROSTER).status, 'empty');
  assert.equal(matchRosterName('!!! ???', ROSTER).status, 'empty');
  assert.equal(matchRosterName(null, ROSTER).status, 'empty');
  assert.equal(matchRosterName('x'.repeat(500), ROSTER).status, 'empty');
});

test('a name made only of ignored tokens matches nobody', () => {
  // "MD" normalizes to an empty token list under IGNORED_TOKENS; falling back
  // to the raw tokens is what stops it matching every resident at once.
  assert.equal(matchRosterName('MD', ROSTER).status, 'not_found');
  assert.equal(matchRosterName('Dr', ROSTER).status, 'not_found');
});

test('normalizeName folds the cosmetic differences it claims to', () => {
  assert.equal(normalizeName('Núñez'), 'nunez');
  assert.equal(normalizeName("O'Brien"), 'obrien');
  assert.equal(normalizeName('Smith-Jones'), 'smith jones');
  assert.equal(normalizeName('  Multiple   Spaces  '), 'multiple spaces');
});

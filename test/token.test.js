import test from 'node:test';
import assert from 'node:assert/strict';

import { weekAnchor, computeDailyToken, validateScannedPayload } from '../functions/_lib/token.js';

const SECRET = 'test-qr-secret';

// A single Sat-Fri lecture week. Saturday 2026-08-01 opens the week that runs
// through Friday 2026-08-07; Saturday 2026-08-08 opens the next one.
const SATURDAY = '2026-08-01';
const MONDAY = '2026-08-03';
const FRIDAY = '2026-08-07';
const NEXT_SATURDAY = '2026-08-08';

async function qrFor(type, anchorDate) {
  return `${type}:${await computeDailyToken(SECRET, anchorDate, type)}`;
}

test('every day from Saturday through Friday anchors to the same Saturday', () => {
  for (const day of [SATURDAY, '2026-08-02', MONDAY, '2026-08-04', '2026-08-05', '2026-08-06', FRIDAY]) {
    assert.equal(weekAnchor(day), SATURDAY, `${day} should anchor to ${SATURDAY}`);
  }
  // The boundary in both directions: the day before and the day after roll over.
  assert.equal(weekAnchor('2026-07-31'), '2026-07-25');
  assert.equal(weekAnchor(NEXT_SATURDAY), NEXT_SATURDAY);
});

test('one weekly QR scans on every lecture day of its week', async () => {
  const payload = await qrFor('noon', SATURDAY);
  for (const day of [MONDAY, '2026-08-04', '2026-08-05', '2026-08-06', FRIDAY]) {
    const result = await validateScannedPayload(SECRET, payload, day);
    assert.deepEqual(result, { valid: true, type: 'noon' }, `should scan on ${day}`);
  }
});

test('last week\'s QR stops working once the new week starts', async () => {
  const stale = await qrFor('noon', SATURDAY);
  // Rejected, and flagged as stale rather than unrecognised.
  assert.deepEqual(await validateScannedPayload(SECRET, stale, NEXT_SATURDAY), { valid: false, stale: true });
  assert.deepEqual(await validateScannedPayload(SECRET, stale, '2026-08-10'), { valid: false, stale: true });
});

test('a rotated-out code is reported stale, unrecognised input is not', async () => {
  // A code this secret really issued, weeks ago — the lecture-hall screen case.
  const old = await qrFor('noon', weekAnchor('2026-06-15'));
  assert.deepEqual(await validateScannedPayload(SECRET, old, MONDAY), { valid: false, stale: true });

  // Genuinely unrecognised payloads must NOT claim to be stale.
  for (const bad of ['noon:0123456789abcdef', 'noon:ffffffffffffffff']) {
    assert.deepEqual(await validateScannedPayload(SECRET, bad, MONDAY), { valid: false });
  }
  // Nor should a valid token replayed under a different event type.
  const noonToken = (await qrFor('noon', SATURDAY)).split(':')[1];
  assert.deepEqual(await validateScannedPayload(SECRET, `learning:${noonToken}`, MONDAY), { valid: false });
});

test('codes from the pre-weekly daily scheme still report as stale', async () => {
  // Every QR in circulation before 2026-07-28 was anchored to a calendar day.
  for (const day of [MONDAY, '2026-07-28', '2026-07-15']) {
    const legacy = `noon:${await computeDailyToken(SECRET, day, 'noon')}`;
    assert.deepEqual(
      await validateScannedPayload(SECRET, legacy, '2026-08-04'),
      { valid: false, stale: true },
      `legacy daily code for ${day} should read as stale`,
    );
  }
});

test('staleness recognition stops after the lookback horizon', async () => {
  const withinHorizon = await qrFor('noon', weekAnchor('2026-06-08')); // 8 weeks back
  const beyondHorizon = await qrFor('noon', weekAnchor('2026-05-25')); // 10 weeks back
  assert.deepEqual(await validateScannedPayload(SECRET, withinHorizon, MONDAY), { valid: false, stale: true });
  assert.deepEqual(await validateScannedPayload(SECRET, beyondHorizon, MONDAY), { valid: false });
});

test('an expired welcome code reports stale rather than failing generically', async () => {
  const payload = await qrFor('welcome', '2026-07-17'); // window closes 2026-08-07
  assert.deepEqual(await validateScannedPayload(SECRET, payload, '2026-08-07'), { valid: false, stale: true });
});

test('a rotation run delayed into midweek still emits this week\'s token', async () => {
  // The generator derives its token from week_anchor(run date), not the run
  // date itself — this is what makes a late GitHub Actions run harmless.
  const generatedLate = await qrFor('learning', weekAnchor('2026-08-05'));
  const generatedOnTime = await qrFor('learning', weekAnchor(SATURDAY));
  assert.equal(generatedLate, generatedOnTime);
  assert.deepEqual(
    await validateScannedPayload(SECRET, generatedLate, FRIDAY),
    { valid: true, type: 'learning' },
  );
});

test('each event type gets a distinct token for the same week', async () => {
  const tokens = await Promise.all(
    ['noon', 'learning', 'grandrounds'].map((t) => qrFor(t, SATURDAY)),
  );
  assert.equal(new Set(tokens).size, 3);
  // A valid noon token must not check in as a learning session.
  const noonToken = tokens[0].split(':')[1];
  assert.deepEqual(await validateScannedPayload(SECRET, `learning:${noonToken}`, MONDAY), { valid: false });
});

test('the fixed-window welcome QR is unaffected by weekly rotation', async () => {
  // welcome is anchored to 2026-07-17 for 21 days, independent of the lecture week.
  const payload = await qrFor('welcome', '2026-07-17');
  assert.deepEqual(
    await validateScannedPayload(SECRET, payload, '2026-08-05'),
    { valid: true, type: 'welcome' },
  );
  // ...and still expires at the end of its own window (as stale, not garbage —
  // see the dedicated expiry test below).
  assert.deepEqual(await validateScannedPayload(SECRET, payload, '2026-08-07'), { valid: false, stale: true });
});

test('malformed and wrong-secret payloads are rejected', async () => {
  for (const bad of ['', 'noon', 'noon:', 'nope:0123456789abcdef', 'noon:tooshort', null]) {
    assert.deepEqual(await validateScannedPayload(SECRET, bad, MONDAY), { valid: false });
  }
  const forged = await qrFor('noon', SATURDAY);
  assert.deepEqual(await validateScannedPayload('wrong-secret', forged, MONDAY), { valid: false });
});

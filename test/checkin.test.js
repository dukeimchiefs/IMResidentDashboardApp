import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/checkin.js';
import { createSessionCookie } from '../functions/_lib/auth.js';
import { computeDailyToken, todayET } from '../functions/_lib/token.js';
import { MULTI_DAY_WINDOWS } from '../functions/_lib/eventTypes.js';

const SESSION_SECRET = 'test-session-secret';
const QR_SECRET = 'test-qr-secret';
const RESIDENT = { email: 'resident@duke.edu', name: 'Test Resident' };

// Minimal D1 stand-in: enough of the attendance table to exercise the real
// dedupe path, dispatching on SQL text rather than parsing it. Enforces both
// uniqueness rules the production schema does — the per-date UNIQUE constraint
// and the partial UNIQUE index on welcome — so the endpoint's race-loser branch
// is reachable here too.
function fakeDb(rows = []) {
  const attendance = [...rows];
  return {
    attendance,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async first() {
          if (sql.includes('rate_limit_counters')) return { count: 1 };
          if (sql.startsWith('SELECT email, name FROM roster')) {
            return stmt.args[0] === RESIDENT.email ? { ...RESIDENT } : null;
          }
          if (sql.includes('FROM attendance WHERE email = ? AND event_type = ?')) {
            const [email, type] = stmt.args;
            return attendance.find((r) => r.email === email && r.event_type === type) ? { 1: 1 } : null;
          }
          if (sql.includes('FROM attendance WHERE email = ? AND event_date = ? AND event_type = ?')) {
            const [email, date, type] = stmt.args;
            const hit = attendance.find(
              (r) => r.email === email && r.event_date === date && r.event_type === type,
            );
            return hit ? { 1: 1 } : null;
          }
          throw new Error(`unexpected first() query: ${sql}`);
        },
        async run() {
          if (!sql.startsWith('INSERT INTO attendance')) throw new Error(`unexpected run(): ${sql}`);
          const [name, email, event_type, event_date, timestamp] = stmt.args;
          const perDateClash = attendance.some(
            (r) => r.email === email && r.event_date === event_date && r.event_type === event_type,
          );
          const welcomeClash = event_type === 'welcome' && attendance.some(
            (r) => r.email === email && r.event_type === 'welcome',
          );
          if (perDateClash || welcomeClash) throw new Error('UNIQUE constraint failed');
          attendance.push({ name, email, event_type, event_date, timestamp });
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

async function scan(db, qrType, tokenDate) {
  const token = `${qrType}:${await computeDailyToken(QR_SECRET, tokenDate, qrType)}`;
  const request = new Request('https://example.test/checkin', {
    method: 'POST',
    headers: {
      cookie: (await createSessionCookie(SESSION_SECRET, RESIDENT)).split(';')[0],
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
  const response = await onRequestPost({ request, env: { DB: db, SESSION_SECRET, QR_SECRET } });
  return { status: response.status, body: await response.json() };
}

const WELCOME_ANCHOR = MULTI_DAY_WINDOWS.welcome.anchorDate;

test('a resident can only ever check in to welcome once', async () => {
  const db = fakeDb();

  const first = await scan(db, 'welcome', WELCOME_ANCHOR);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(db.attendance.length, 1);

  // The second scan is on a *different* date than the first — the case the old
  // per-day rule allowed and an indefinitely-valid QR makes easy to hit.
  db.attendance[0].event_date = '2026-07-20';
  const second = await scan(db, 'welcome', WELCOME_ANCHOR);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_checked_in');
  assert.equal(db.attendance.length, 1, 'no second welcome row should be written');
});

test('the once-ever rejection does not claim the earlier check-in was today', async () => {
  const db = fakeDb([
    {
      name: RESIDENT.name,
      email: RESIDENT.email,
      event_type: 'welcome',
      event_date: '2026-07-20',
      timestamp: '2026-07-20T14:00:00.000Z',
    },
  ]);
  const { body } = await scan(db, 'welcome', WELCOME_ANCHOR);
  assert.match(body.message, /only need to do this once/);
  assert.doesNotMatch(body.message, /today/);
});

test('a concurrent second welcome scan loses to the unique index, not a duplicate row', async () => {
  // Skips the SELECT by racing the insert directly: both requests observe an
  // empty table, so only the index can separate them.
  const db = fakeDb();
  const [a, b] = await Promise.all([
    scan(db, 'welcome', WELCOME_ANCHOR),
    scan(db, 'welcome', WELCOME_ANCHOR),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(db.attendance.length, 1);
});

test('lectures still allow one check-in per day, not one ever', async () => {
  const db = fakeDb([
    {
      name: RESIDENT.name,
      email: RESIDENT.email,
      event_type: 'noon_conference',
      event_date: '2026-07-20',
      timestamp: '2026-07-20T16:00:00.000Z',
    },
  ]);
  // Yesterday's noon conference must not block today's.
  const { status, body } = await scan(db, 'noon', weekAnchorForToday());
  assert.equal(status, 200);
  assert.equal(body.eventType, 'noon_conference');
  assert.equal(db.attendance.length, 2);

  // ...but a second scan the same day is still a duplicate.
  const repeat = await scan(db, 'noon', weekAnchorForToday());
  assert.equal(repeat.status, 409);
  assert.match(repeat.body.message, /today/);
  assert.equal(db.attendance.length, 2);
});

// The endpoint always validates against the real current date, so a noon token
// has to be anchored to the live week rather than a fixture date.
function weekAnchorForToday() {
  const d = new Date(`${todayET()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}

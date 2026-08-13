import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestPost } from '../functions/checkin.js';
import { computeDailyToken, todayET } from '../functions/_lib/token.js';
import { MULTI_DAY_WINDOWS } from '../functions/_lib/eventTypes.js';

const QR_SECRET = 'test-qr-secret';
const TURNSTILE_HOSTNAME = 'example.test';
const RESIDENT = { email: 'resident@duke.edu', name: 'Test Resident', test_account: 0 };
// A roster entry flagged for debugging: submissions validate but are never recorded.
const TESTER = { email: 'tester@duke.edu', name: 'Flow Debugger', test_account: 1 };

const ENV = {
  QR_SECRET,
  TURNSTILE_SECRET: 'test-turnstile-secret',
  TURNSTILE_SITEKEY: '0xTESTSITEKEY',
  TURNSTILE_HOSTNAME,
};

// Turnstile's siteverify is the only outbound call this endpoint makes. Stub it
// per-test rather than globally so the "challenge failed" path can be exercised
// with the same harness.
function stubTurnstile(succeed = true) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify(
        succeed
          ? { success: true, action: 'checkin', hostname: TURNSTILE_HOSTNAME }
          : { success: false, 'error-codes': ['invalid-input-response'] }
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  return () => {
    globalThis.fetch = original;
  };
}

// Minimal D1 stand-in: enough of the roster and attendance tables to exercise
// the real matching and dedupe paths, dispatching on SQL text rather than
// parsing it. Enforces both uniqueness rules the production schema does — the
// per-date UNIQUE constraint and the partial UNIQUE index on welcome — so the
// endpoint's race-loser branch is reachable here too.
function fakeDb(rows = [], roster = [RESIDENT, TESTER]) {
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
        async all() {
          if (sql.startsWith('SELECT email, name, test_account FROM roster')) return { results: roster };
          throw new Error(`unexpected all() query: ${sql}`);
        },
        async first() {
          if (sql.includes('rate_limit_counters')) return { count: 1 };
          if (sql.includes('FROM attendance WHERE name = ? AND event_date = ? AND event_type = ?')) {
            const [name, date, type] = stmt.args;
            const hit = attendance.find((r) => r.name === name && r.event_date === date && r.event_type === type);
            return hit ? { 1: 1 } : null;
          }
          if (sql.includes('FROM attendance WHERE name = ? AND event_type = ?')) {
            const [name, type] = stmt.args;
            return attendance.find((r) => r.name === name && r.event_type === type) ? { 1: 1 } : null;
          }
          throw new Error(`unexpected first() query: ${sql}`);
        },
        async run() {
          if (!sql.startsWith('INSERT INTO attendance')) throw new Error(`unexpected run(): ${sql}`);
          const [name, event_type, event_date, timestamp] = stmt.args;
          const perDateClash = attendance.some(
            (r) => r.name === name && r.event_date === event_date && r.event_type === event_type
          );
          const welcomeClash =
            event_type === 'welcome' && attendance.some((r) => r.name === name && r.event_type === 'welcome');
          if (perDateClash || welcomeClash) throw new Error('UNIQUE constraint failed');
          attendance.push({ name, event_type, event_date, timestamp });
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

async function tokenFor(qrType, tokenDate) {
  return computeDailyToken(QR_SECRET, tokenDate, qrType);
}

// Submits the form the way a phone does: URL-encoded POST to the same URL the
// QR opened, carrying the event, token, typed name and Turnstile response.
async function submit(db, qrType, tokenDate, typedName, { token } = {}) {
  const body = new URLSearchParams({
    e: qrType,
    t: token ?? (await tokenFor(qrType, tokenDate)),
    name: typedName,
    'cf-turnstile-response': 'stub-token',
  });
  const request = new Request('https://example.test/checkin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const response = await onRequestPost({ request, env: { ...ENV, DB: db } });
  return { status: response.status, html: await response.text() };
}

async function open(db, qrType, tokenDate, { token } = {}) {
  const t = token ?? (await tokenFor(qrType, tokenDate));
  const request = new Request(`https://example.test/checkin?e=${qrType}&t=${t}`);
  const response = await onRequestGet({ request, env: { ...ENV, DB: db } });
  return { status: response.status, html: await response.text() };
}

const WELCOME_ANCHOR = MULTI_DAY_WINDOWS.welcome.anchorDate;

// The endpoint always validates against the real current date, so a lecture
// token has to be anchored to the live week rather than a fixture date.
function weekAnchorForToday() {
  const d = new Date(`${todayET()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}

test('opening a valid QR link renders the name form', async () => {
  const { status, html } = await open(fakeDb(), 'noon', weekAnchorForToday());
  assert.equal(status, 200);
  assert.match(html, /Noon Conference/);
  assert.match(html, /name="name"/);
  assert.match(html, /cf-turnstile/);
});

test('opening the form never asks for an email address', async () => {
  // The entire point of the rewrite: residents could not work the email flow.
  const { html } = await open(fakeDb(), 'noon', weekAnchorForToday());
  assert.doesNotMatch(html, /type="email"/);
  assert.doesNotMatch(html, /password/i);
});

test('a stale QR link says so rather than failing generically', async () => {
  // Last week's code: genuinely issued, since rotated.
  const lastWeek = new Date(`${weekAnchorForToday()}T00:00:00Z`);
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
  const { status, html } = await open(fakeDb(), 'noon', lastWeek.toISOString().slice(0, 10));
  assert.equal(status, 400);
  assert.match(html, /expired/i);
});

test('a garbage token is rejected without reaching the form', async () => {
  const { status, html } = await open(fakeDb(), 'noon', null, { token: '0000000000000000' });
  assert.equal(status, 400);
  assert.doesNotMatch(html, /name="name"/);
});

test('an unknown event type is rejected', async () => {
  const request = new Request('https://example.test/checkin?e=../etc&t=0000000000000000');
  const response = await onRequestGet({ request, env: { ...ENV, DB: fakeDb() } });
  assert.equal(response.status, 400);
});

test('submitting a roster name records attendance', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { status, html } = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident');
    assert.equal(status, 200);
    assert.match(html, /checked in/i);
    assert.equal(db.attendance.length, 1);
    assert.equal(db.attendance[0].event_type, 'noon_conference');
    assert.equal(db.attendance[0].name, 'Test Resident');
  } finally {
    restore();
  }
});

test('the roster spelling is stored, not what the resident typed', async () => {
  // scrape_attendance.py joins the workbook on this exact string, so a stored
  // "test resident" would be points that silently never land.
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    await submit(db, 'noon', weekAnchorForToday(), '  test   RESIDENT, M.D. ');
    assert.equal(db.attendance[0].name, 'Test Resident');
  } finally {
    restore();
  }
});

test('a name not on the roster is refused and nothing is written', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { html } = await submit(db, 'noon', weekAnchorForToday(), 'Somebody Random');
    // The apostrophe arrives HTML-escaped, which is the point of escapeHtml.
    assert.match(html, /find that name on the roster/i);
    assert.match(html, /name="name"/, 'the form must come back so they can retry');
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a rejected name is preserved in the form rather than cleared', async () => {
  const restore = stubTurnstile();
  try {
    const { html } = await submit(fakeDb(), 'noon', weekAnchorForToday(), 'Somebody Random');
    assert.match(html, /value="Somebody Random"/);
  } finally {
    restore();
  }
});

test('an ambiguous name asks for a middle initial instead of guessing', async () => {
  const restore = stubTurnstile();
  try {
    const roster = [
      { email: 'f@duke.edu', name: 'John A Smith', test_account: 0 },
      { email: 'g@duke.edu', name: 'John B Smith', test_account: 0 },
    ];
    const db = fakeDb([], roster);
    const { html } = await submit(db, 'noon', weekAnchorForToday(), 'John Smith');
    assert.match(html, /more than one resident/i);
    assert.equal(db.attendance.length, 0, 'attendance must never be filed against a guess');
  } finally {
    restore();
  }
});

test('a failed security check re-renders the form instead of dead-ending', async () => {
  const restore = stubTurnstile(false);
  try {
    const db = fakeDb();
    const { status, html } = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident');
    assert.equal(status, 200);
    assert.match(html, /name="name"/);
    assert.match(html, /value="Test Resident"/, 'the typed name must survive a Turnstile timeout');
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a valid name with an invalid token records nothing', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { status } = await submit(db, 'noon', null, 'Test Resident', { token: '0000000000000000' });
    assert.equal(status, 400);
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a resident can only ever check in to welcome once', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const first = await submit(db, 'welcome', WELCOME_ANCHOR, 'Test Resident');
    assert.equal(first.status, 200);
    assert.equal(db.attendance.length, 1);

    // The second submission is on a *different* date than the first — the case
    // the per-day rule allows and an indefinitely-valid QR makes easy to hit.
    db.attendance[0].event_date = '2026-07-20';
    const second = await submit(db, 'welcome', WELCOME_ANCHOR, 'Test Resident');
    assert.match(second.html, /already checked in/i);
    assert.equal(db.attendance.length, 1, 'no second welcome row should be written');
  } finally {
    restore();
  }
});

test('the once-ever message does not claim the earlier check-in was today', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb([
      { name: RESIDENT.name, event_type: 'welcome', event_date: '2026-07-20', timestamp: '2026-07-20T14:00:00.000Z' },
    ]);
    const { html } = await submit(db, 'welcome', WELCOME_ANCHOR, 'Test Resident');
    assert.match(html, /only needs doing once/);
    assert.doesNotMatch(html, /today/);
  } finally {
    restore();
  }
});

test('a concurrent second welcome submit loses to the unique index, not a duplicate row', async () => {
  const restore = stubTurnstile();
  try {
    // Skips the SELECT by racing the insert directly: both requests observe an
    // empty table, so only the index can separate them.
    const db = fakeDb();
    const [a, b] = await Promise.all([
      submit(db, 'welcome', WELCOME_ANCHOR, 'Test Resident'),
      submit(db, 'welcome', WELCOME_ANCHOR, 'Test Resident'),
    ]);
    assert.equal(db.attendance.length, 1);
    // Both residents are told they are checked in, because both are.
    for (const r of [a, b]) assert.match(r.html, /checked in/i);
  } finally {
    restore();
  }
});

test('lectures still allow one check-in per day, not one ever', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb([
      { name: RESIDENT.name, event_type: 'noon_conference', event_date: '2026-07-20', timestamp: '2026-07-20T16:00:00.000Z' },
    ]);
    // An earlier noon conference must not block today's.
    const first = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident');
    assert.match(first.html, /checked in/i);
    assert.equal(db.attendance.length, 2);

    // ...but a second submission the same day is still a duplicate.
    const repeat = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident');
    assert.match(repeat.html, /already checked in/i);
    assert.match(repeat.html, /today/);
    assert.equal(db.attendance.length, 2);
  } finally {
    restore();
  }
});

test('a test account submits successfully without recording attendance', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { status, html } = await submit(db, 'noon', weekAnchorForToday(), 'Flow Debugger');
    assert.equal(status, 200);
    assert.match(html, /Noon Conference/, 'the QR must still resolve to a real event');
    assert.match(html, /not recorded/);
    assert.equal(db.attendance.length, 0, 'no attendance row may be written');
  } finally {
    restore();
  }
});

test('a test account can submit the same code without limit', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    for (let i = 0; i < 5; i++) {
      const { status } = await submit(db, 'noon', weekAnchorForToday(), 'Flow Debugger');
      assert.equal(status, 200, `submission ${i + 1} should succeed`);
    }
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a test account does not consume its once-per-resident welcome', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    await submit(db, 'welcome', WELCOME_ANCHOR, 'Flow Debugger');
    await submit(db, 'welcome', WELCOME_ANCHOR, 'Flow Debugger');
    const { status, html } = await submit(db, 'welcome', WELCOME_ANCHOR, 'Flow Debugger');
    assert.equal(status, 200, 'welcome must never lock out a debug account');
    assert.match(html, /not recorded/);
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a test account still has its QR validated, not waved through', async () => {
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { status } = await submit(db, 'noon', null, 'Flow Debugger', { token: '0000000000000000' });
    assert.equal(status, 400, 'a bad token must fail for a test account too');
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

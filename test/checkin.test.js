import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestPost } from '../functions/checkin.js';
import { computeDailyToken, todayET } from '../functions/_lib/token.js';

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
// parsing it. Enforces the production table's UNIQUE (name, event_date,
// event_type) constraint, so the endpoint's race-loser branch is reachable here
// too.
function fakeDb(rows = [], roster = [RESIDENT, TESTER]) {
  const attendance = [...rows];
  const rateLimitKeys = [];
  return {
    attendance,
    rateLimitKeys,
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
          if (sql.includes('rate_limit_counters')) {
            rateLimitKeys.push(stmt.args[0]);
            return { count: 1 };
          }
          if (sql.includes('FROM attendance WHERE name = ? AND event_date = ? AND event_type = ?')) {
            const [name, date, type] = stmt.args;
            const hit = attendance.find((r) => r.name === name && r.event_date === date && r.event_type === type);
            return hit ? { 1: 1 } : null;
          }
          throw new Error(`unexpected first() query: ${sql}`);
        },
        async run() {
          if (!sql.startsWith('INSERT INTO attendance')) throw new Error(`unexpected run(): ${sql}`);
          const [name, event_type, event_date, timestamp] = stmt.args;
          const perDateClash = attendance.some(
            (r) => r.name === name && r.event_date === event_date && r.event_type === event_type
          );
          if (perDateClash) throw new Error('UNIQUE constraint failed');
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
async function submit(db, qrType, tokenDate, typedName, { token, challenge = 'stub-token' } = {}) {
  const fields = {
    e: qrType,
    t: token ?? (await tokenFor(qrType, tokenDate)),
    name: typedName,
  };
  // `challenge: null` posts the form the way a phone does when Turnstile never
  // ran at all: the field is simply absent. That is a different failure from a
  // token Cloudflare looked at and rejected, and it needs different advice.
  if (challenge !== null) fields['cf-turnstile-response'] = challenge;
  const body = new URLSearchParams(fields);
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

test('the form arms the challenge callbacks and ships the script that uses them', async () => {
  const { html } = await open(fakeDb(), 'noon', weekAnchorForToday());
  // Renaming either end of these silently un-guards the button, which is the
  // whole defect: a form that can be submitted with nothing to validate.
  assert.match(html, /data-callback="checkinChallengeReady"/);
  assert.match(html, /data-expired-callback="checkinChallengeExpired"/);
  assert.match(html, /data-error-callback="checkinChallengeFailed"/);
  assert.match(html, /src="\/checkin-form\.js"/);
  assert.match(html, /id="checkin-submit"/);
  assert.match(html, /id="checkin-form"/);
});

test('the guard script is ordered ahead of Turnstile, and neither is async', async () => {
  const { html } = await open(fakeDb(), 'noon', weekAnchorForToday());
  // Turnstile resolves the callback names once, at render, and drops any that
  // are not defined yet. Document-order `defer` is the only thing guaranteeing
  // they are; `async` on either tag turns it back into a race.
  const guard = html.indexOf('src="/checkin-form.js"');
  const turnstile = html.indexOf('turnstile/v0/api.js');
  assert.ok(guard !== -1 && turnstile !== -1);
  assert.ok(guard < turnstile, 'checkin-form.js must come before api.js');
  assert.doesNotMatch(html, /<script[^>]*\basync\b/);
});

test('result pages load no scripts at all', async () => {
  const restore = stubTurnstile();
  try {
    const { html } = await submit(fakeDb(), 'noon', weekAnchorForToday(), 'Test Resident');
    assert.match(html, /checked in/i);
    assert.doesNotMatch(html, /<script/);
  } finally {
    restore();
  }
});

test('an oversized name cannot inflate the stored rate-limit key', async () => {
  // The per-person limit runs before Turnstile, so its key is whatever a script
  // chooses to post. Uncapped, that is an arbitrary-size write to D1.
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const { html } = await submit(db, 'noon', weekAnchorForToday(), 'a'.repeat(50000));
    assert.match(html, /type your name/i);
    assert.equal(db.rateLimitKeys.length, 2);
    for (const key of db.rateLimitKeys) assert.ok(key.length < 200, `key is ${key.length} chars`);
  } finally {
    restore();
  }
});

test('a submit carrying no challenge token is not told to just tap again', async () => {
  const restore = stubTurnstile(false);
  try {
    const db = fakeDb();
    const { status, html } = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident', {
      challenge: null,
    });
    assert.equal(status, 200);
    // Matched without the apostrophe: escapeHtml renders it as &#39;.
    assert.match(html, /load on this network/i);
    // The advice that loops. Tapping again re-posts the same absent token and
    // lands right back here — which is how a resident taps through a whole
    // conference and is never recorded.
    assert.doesNotMatch(html, /Tap Check in once more/i);
    assert.match(html, /value="Test Resident"/);
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

test('a rejected token gets the wording a retry can actually fix', async () => {
  const restore = stubTurnstile(false);
  try {
    const db = fakeDb();
    const { html } = await submit(db, 'noon', weekAnchorForToday(), 'Test Resident');
    assert.match(html, /security check expired/i);
    assert.equal(db.attendance.length, 0);
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

test('a concurrent second submit loses to the unique constraint, not a duplicate row', async () => {
  const restore = stubTurnstile();
  try {
    // Skips the SELECT by racing the insert directly: both requests observe an
    // empty table, so only the constraint can separate them.
    const db = fakeDb();
    const [a, b] = await Promise.all([
      submit(db, 'noon', weekAnchorForToday(), 'Test Resident'),
      submit(db, 'noon', weekAnchorForToday(), 'Test Resident'),
    ]);
    assert.equal(db.attendance.length, 1);
    // Both residents are told they are checked in, because both are.
    for (const r of [a, b]) assert.match(r.html, /checked in/i);
  } finally {
    restore();
  }
});

test('the retired welcome event cannot be checked into', async () => {
  // Its QR was deleted on 2026-08-13, but an old photo of one still exists in
  // the world and the QR_SECRET that signed it has not been rotated. The type
  // is absent from EVENT_TYPES, so the prefix no longer parses at all.
  const restore = stubTurnstile();
  try {
    const db = fakeDb();
    const get = await open(db, 'welcome', '2026-07-17');
    assert.equal(get.status, 400);
    assert.doesNotMatch(get.html, /name="name"/, 'no form may be offered for a retired event');

    const post = await submit(db, 'welcome', '2026-07-17', 'Test Resident');
    assert.equal(post.status, 400);
    assert.equal(db.attendance.length, 0);
  } finally {
    restore();
  }
});

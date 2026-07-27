import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionCookie, verifySession, renewSessionCookie } from '../functions/_lib/auth.js';

const SECRET = 'test-session-secret';
const RESIDENT = { email: 'karen.young@duke.edu', name: 'Karen Young' };
const DAY_MS = 24 * 60 * 60 * 1000;

// The renewal boundary is defined in terms of Date.now(), so the only way to
// exercise a 20-day-old session is to mint it with the clock moved back.
async function at(whenMs, fn) {
  const realNow = Date.now;
  Date.now = () => whenMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

function cookieValue(setCookie) {
  return setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));
}

function requestWithCookie(setCookie) {
  return new Request('https://example.test/me', {
    headers: { Cookie: `session=${cookieValue(setCookie)}` },
  });
}

test('a fresh session is not renewed', async () => {
  const cookie = await createSessionCookie(SECRET, RESIDENT);
  const session = await verifySession(SECRET, requestWithCookie(cookie));

  assert.equal(session.email, RESIDENT.email);
  assert.equal(await renewSessionCookie(SECRET, session), null);
});

test('a session past the halfway mark is renewed for another full 30 days', async () => {
  const now = Date.now();
  const cookie = await at(now - 20 * DAY_MS, () => createSessionCookie(SECRET, RESIDENT));
  const session = await verifySession(SECRET, requestWithCookie(cookie));

  // 20 days in, 10 left: under the 15-day threshold, so this one renews.
  const renewed = await renewSessionCookie(SECRET, session);
  assert.ok(renewed, 'expected a refreshed Set-Cookie');

  const after = await verifySession(SECRET, requestWithCookie(renewed));
  assert.equal(after.email, RESIDENT.email);
  assert.equal(after.name, RESIDENT.name);
  assert.ok(after.exp - now > 29 * DAY_MS, 'renewed session should carry a fresh 30-day expiry');
});

test('renewal keeps an actively-used session alive indefinitely', async () => {
  const now = Date.now();
  // Sign in 90 days ago, then "use the app" every 20 days since. The original
  // fixed 30-day expiry would have signed this resident out twice over.
  let cookie = await at(now - 90 * DAY_MS, () => createSessionCookie(SECRET, RESIDENT));
  for (const daysAgo of [70, 50, 30, 10]) {
    const visitedAt = now - daysAgo * DAY_MS;
    const session = await at(visitedAt, () => verifySession(SECRET, requestWithCookie(cookie)));
    assert.ok(session, `session should still be valid ${daysAgo} days ago`);
    const renewed = await at(visitedAt, () => renewSessionCookie(SECRET, session));
    if (renewed) cookie = renewed;
  }

  assert.ok(await verifySession(SECRET, requestWithCookie(cookie)), 'should still be signed in today');
});

test('a session left unused for over 30 days still expires', async () => {
  const cookie = await at(Date.now() - 31 * DAY_MS, () => createSessionCookie(SECRET, RESIDENT));

  assert.equal(await verifySession(SECRET, requestWithCookie(cookie)), null);
});

test('renewal does not resurrect a tampered cookie', async () => {
  const cookie = await createSessionCookie(SECRET, RESIDENT);
  const forged = cookieValue(cookie).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const request = new Request('https://example.test/me', { headers: { Cookie: `session=${forged}` } });

  assert.equal(await verifySession(SECRET, request), null);
});

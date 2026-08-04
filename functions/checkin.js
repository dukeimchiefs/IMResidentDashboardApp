import { hasCheckedIn, hasEverCheckedIn, insertAttendance, getRosterEntry } from './_lib/db.js';
import { verifySession, sessionRenewalHeaders } from './_lib/auth.js';
import { validateScannedPayload, todayET } from './_lib/token.js';
import { EVENT_TYPES, isOncePerResident } from './_lib/eventTypes.js';
import { json } from './_lib/http.js';
import { checkFixedWindow } from './_lib/rateLimit.js';

// Keyed by resident (session email), not IP: many residents legitimately check
// in from the same conference-room wifi within a couple minutes of each other
// (see CLAUDE.md), so an IP-scoped limit would risk throttling a whole room.
// 4 event types/day max in practice, so this comfortably covers retries.
const EMAIL_LIMIT = 20;
const EMAIL_WINDOW_SECONDS = 600; // 20 requests / 10 minutes per resident

export async function onRequestPost({ request, env }) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false, error: 'not_authenticated' }, 401);

  // Slide the session forward on any authenticated scan, so a resident who only
  // ever opens the app straight to the scanner stays signed in the same way one
  // who lands on /me does. Attached to every response below, including the
  // rejections — the session is equally valid whichever way the scan lands.
  const renewal = await sessionRenewalHeaders(env.SESSION_SECRET, session);

  const emailOk = await checkFixedWindow(env.DB, 'rl:checkin:email', session.email, EMAIL_LIMIT, EMAIL_WINDOW_SECONDS);
  if (!emailOk) {
    return json(
      { ok: false, error: 'rate_limited', message: 'Too many requests. Please wait a few minutes and try again.' },
      429,
      renewal
    );
  }

  // Re-check roster membership on every scan rather than trusting the (up to
  // 30-day-old) session payload — a resident removed from the roster after
  // signing in would otherwise keep checking in, undermining the leaderboard's
  // trust that attendance rows always map to a currently-active resident.
  const rosterEntry = await getRosterEntry(env.DB, session.email);
  if (!rosterEntry) return json({ ok: false, error: 'not_on_roster' }, 403, renewal);

  const { token } = await request.json().catch(() => ({}));
  const result = await validateScannedPayload(env.QR_SECRET, token);
  if (!result.valid) {
    // A code that was genuinely issued but has since rotated gets its own
    // message: retrying is futile, and the fix is on the screen, not the phone.
    if (result.stale) {
      return json(
        {
          ok: false,
          error: 'stale_token',
          message: 'Stale QR Code. This code has expired — ask for the current code to be displayed, then scan again.',
        },
        400,
        renewal
      );
    }
    // Carries its own message rather than letting the client fall back to a
    // generic "Check-in failed" — that wording is indistinguishable from a
    // network error or a camera that never read anything, which sent a real
    // diagnosis down the wrong path. Say that the code *was* read and rejected.
    return json(
      {
        ok: false,
        error: 'invalid_token',
        message: "That code was scanned but isn't a valid check-in code. Make sure you're scanning the code on the screen, not a photo of an older one.",
      },
      400,
      renewal
    );
  }

  const eventInfo = EVENT_TYPES[result.type];

  // Debug accounts stop here. Everything that proves the scanner works has
  // already run — the QR was decoded, validated against the secret and resolved
  // to an event — so the response confirms a real success without writing an
  // attendance row. Scanning the same code repeatedly while working on the
  // camera therefore can't accrue points, distort the leaderboard, or burn a
  // once-per-resident event like welcome.
  //
  // The flag lives on the roster row rather than in an allowlist here because
  // this repository is public; a hardcoded address would be published with it.
  if (rosterEntry.test_account) {
    return json(
      {
        ok: true,
        testAccount: true,
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        name: rosterEntry.name,
        message: `Scan OK — ${eventInfo.label}. Test account, attendance not recorded.`,
      },
      200,
      renewal
    );
  }

  const eventDate = todayET();
  const onceEver = isOncePerResident(result.type);

  // Once-per-resident types dedupe across every date, not just today: their QR
  // never rotates, so a date-scoped check would let the same onboarding poster
  // mint a fresh row for the same resident every morning.
  const alreadyChecked = onceEver
    ? await hasEverCheckedIn(env.DB, rosterEntry.email, eventInfo.dbValue)
    : await hasCheckedIn(env.DB, rosterEntry.email, eventDate, eventInfo.dbValue);

  // "today" would be actively misleading for a once-ever type — the resident's
  // earlier check-in may well have been weeks ago.
  const duplicateMessage = onceEver
    ? `You're already checked in to ${eventInfo.label}, ${rosterEntry.name} — you only need to do this once.`
    : `You already checked in to ${eventInfo.label} today.`;

  if (alreadyChecked) {
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: duplicateMessage,
      },
      409,
      renewal
    );
  }

  const inserted = await insertAttendance(env.DB, {
    name: rosterEntry.name,
    email: rosterEntry.email,
    eventType: eventInfo.dbValue,
    eventDate,
    timestamp: new Date().toISOString(),
  });

  if (!inserted) {
    // Lost a race to a concurrent request for the same (email, date, event_type)
    // — or, for a once-per-resident type, for the same (email, event_type) on
    // any date, which the partial UNIQUE index in schema.sql rejects.
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: duplicateMessage,
      },
      409,
      renewal
    );
  }

  return json(
    {
      ok: true,
      eventType: eventInfo.dbValue,
      eventLabel: eventInfo.label,
      name: rosterEntry.name,
      message: `Checked in to ${eventInfo.label}, ${rosterEntry.name}!`,
    },
    200,
    renewal
  );
}

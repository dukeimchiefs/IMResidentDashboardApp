import { hasCheckedIn, insertAttendance, getRosterEntry } from './_lib/db.js';
import { verifySession } from './_lib/auth.js';
import { validateScannedPayload, todayET } from './_lib/token.js';
import { EVENT_TYPES } from './_lib/eventTypes.js';
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

  const emailOk = await checkFixedWindow(env.DB, 'rl:checkin:email', session.email, EMAIL_LIMIT, EMAIL_WINDOW_SECONDS);
  if (!emailOk) {
    return json(
      { ok: false, error: 'rate_limited', message: 'Too many requests. Please wait a few minutes and try again.' },
      429
    );
  }

  // Re-check roster membership on every scan rather than trusting the (up to
  // 30-day-old) session payload — a resident removed from the roster after
  // signing in would otherwise keep checking in, undermining the leaderboard's
  // trust that attendance rows always map to a currently-active resident.
  const rosterEntry = await getRosterEntry(env.DB, session.email);
  if (!rosterEntry) return json({ ok: false, error: 'not_on_roster' }, 403);

  const { token } = await request.json().catch(() => ({}));
  const result = await validateScannedPayload(env.QR_SECRET, token);
  if (!result.valid) return json({ ok: false, error: 'invalid_token' }, 400);

  const eventInfo = EVENT_TYPES[result.type];
  const eventDate = todayET();

  const alreadyChecked = await hasCheckedIn(env.DB, rosterEntry.email, eventDate, eventInfo.dbValue);
  if (alreadyChecked) {
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: `You already checked in to ${eventInfo.label} today.`,
      },
      409
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
    // Lost a race to a concurrent request for the same (email, date, event_type).
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: `You already checked in to ${eventInfo.label} today.`,
      },
      409
    );
  }

  return json({
    ok: true,
    eventType: eventInfo.dbValue,
    eventLabel: eventInfo.label,
    name: rosterEntry.name,
    message: `Checked in to ${eventInfo.label}, ${rosterEntry.name}!`,
  });
}

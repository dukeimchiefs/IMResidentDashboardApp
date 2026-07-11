import { hasCheckedIn, insertAttendance } from './_lib/db.js';
import { verifySession } from './_lib/auth.js';
import { validateScannedPayload, todayET } from './_lib/token.js';
import { EVENT_TYPES } from './_lib/eventTypes.js';
import { json } from './_lib/http.js';

export async function onRequestPost({ request, env }) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false, error: 'not_authenticated' }, 401);

  const { token } = await request.json().catch(() => ({}));
  const result = await validateScannedPayload(env.QR_SECRET, token);
  if (!result.valid) return json({ ok: false, error: 'invalid_token' }, 400);

  const eventInfo = EVENT_TYPES[result.type];
  const eventDate = todayET();

  const alreadyChecked = await hasCheckedIn(env.DB, session.email, eventDate, eventInfo.dbValue);
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
    name: session.name,
    email: session.email,
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
    name: session.name,
    message: `Checked in to ${eventInfo.label}, ${session.name}!`,
  });
}

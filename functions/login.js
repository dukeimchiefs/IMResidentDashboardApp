import { getRosterEntry, insertMagicLink, insertLoginRejection, enqueuePendingLogin } from './_lib/db.js';
import { generateRandomToken, magicLinkExpiry } from './_lib/auth.js';
import { json } from './_lib/http.js';
import { sendMagicLinkEmail } from './_lib/resend.js';
import { checkFixedWindow, checkCooldown, peekDailyCounter, incrementDailyCounter } from './_lib/rateLimit.js';

const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 600; // 10 requests / 10 minutes per IP
const EMAIL_COOLDOWN_SECONDS = 60; // 1 send / minute per roster email
const RESEND_DAILY_SOFT_CAP = 90; // stay under Resend free tier's 100/day hard cap

// Every roster-membership-dependent branch below pads its response to this floor
// so response latency can't be used to tell whether a submitted email is on the
// roster — without this, the successful-send path (which makes a live Resend API
// call) is measurably slower than the "not on roster" path (a single fast DB
// write), defeating the always-ok:true anti-enumeration response.
const MIN_RESPONSE_MS = 600;

async function padResponse(startTime) {
  const remaining = MIN_RESPONSE_MS - (Date.now() - startTime);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

// Cloudflare's log viewer is only as trusted as everyone with dashboard/API
// access to the account — keep full addresses out of it where the log line
// doesn't need one to be useful for debugging.
function redactEmail(email) {
  const at = email.indexOf('@');
  if (at <= 1) return '*'.repeat(email.length);
  return `${email[0]}***@${email.slice(at + 1)}`;
}

export async function onRequestPost({ request, env, waitUntil }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipOk = await checkFixedWindow(env.DB, 'rl:login:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipOk) {
    return json(
      { ok: false, error: 'rate_limited', message: 'Too many requests. Please wait a few minutes and try again.' },
      429
    );
  }

  const startTime = Date.now();
  const { email } = await request.json().catch(() => ({}));
  if (!email || typeof email !== 'string') {
    await padResponse(startTime);
    return json({ ok: true });
  }

  const normalizedEmail = email.toLowerCase();
  const rosterEntry = await getRosterEntry(env.DB, normalizedEmail);

  if (!rosterEntry) {
    console.warn('login_rejected_not_in_roster', redactEmail(normalizedEmail));
    await insertLoginRejection(env.DB, normalizedEmail, ip).catch((err) =>
      console.error('failed_to_log_login_rejection', err)
    );
    // Always ok:true here too, regardless of roster membership, to avoid roster-enumeration.
    await padResponse(startTime);
    return json({ ok: true });
  }

  const sentToday = await peekDailyCounter(env.DB, 'rl:login:resend_daily');
  if (sentToday >= RESEND_DAILY_SOFT_CAP) {
    await enqueuePendingLogin(env.DB, rosterEntry.email, ip, 'high_demand');
    // Body must be identical to the not-on-roster response below — any
    // roster-membership-dependent difference here re-opens the enumeration
    // oracle that padResponse()/MIN_RESPONSE_MS was added to close on timing.
    await padResponse(startTime);
    return json({ ok: true });
  }

  const allowedToSend = await checkCooldown(env.DB, 'rl:login:email', rosterEntry.email, EMAIL_COOLDOWN_SECONDS);
  if (!allowedToSend) {
    // Already sent one recently — don't duplicate-send, but don't alarm the resident either.
    await padResponse(startTime);
    return json({ ok: true });
  }

  const token = generateRandomToken();
  await insertMagicLink(env.DB, token, rosterEntry.email, magicLinkExpiry());
  const verifyUrl = new URL(request.url);
  verifyUrl.pathname = '/verify';
  verifyUrl.search = `?token=${token}`;

  // Don't make the resident's response wait on the live Resend network call.
  // Besides the latency hit, awaiting it means a slow send or a failed-then-
  // retried one runs past the padResponse() floor below and becomes an
  // observable signal that this address is on the roster — the same class of
  // leak MIN_RESPONSE_MS exists to close, just via response time instead of
  // response body. Fire it in the background instead.
  waitUntil(
    (async () => {
      const sent = await sendMagicLinkEmail(env, rosterEntry.email, verifyUrl.toString());
      if (sent) {
        await incrementDailyCounter(env.DB, 'rl:login:resend_daily');
      } else {
        await enqueuePendingLogin(env.DB, rosterEntry.email, ip, 'email_failed');
      }
    })()
  );

  await padResponse(startTime);
  return json({ ok: true });
}

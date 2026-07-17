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

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipOk = await checkFixedWindow(env.RATE_LIMIT, 'rl:login:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
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
    console.warn('login_rejected_not_in_roster', normalizedEmail);
    await insertLoginRejection(env.DB, normalizedEmail, ip).catch((err) =>
      console.error('failed_to_log_login_rejection', err)
    );
    // Always ok:true here too, regardless of roster membership, to avoid roster-enumeration.
    await padResponse(startTime);
    return json({ ok: true });
  }

  const sentToday = await peekDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');
  if (sentToday >= RESEND_DAILY_SOFT_CAP) {
    await enqueuePendingLogin(env.DB, rosterEntry.email, ip, 'high_demand');
    await padResponse(startTime);
    return json({
      ok: true,
      queued: true,
      message: "High demand right now — we'll email your sign-in link automatically as soon as we can. No need to try again.",
    });
  }

  const allowedToSend = await checkCooldown(env.RATE_LIMIT, 'rl:login:email', rosterEntry.email, EMAIL_COOLDOWN_SECONDS);
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

  const sent = await sendMagicLinkEmail(env, rosterEntry.email, verifyUrl.toString());
  if (!sent) {
    await enqueuePendingLogin(env.DB, rosterEntry.email, ip, 'email_failed');
    await padResponse(startTime);
    return json({
      ok: true,
      queued: true,
      message: "We're having trouble sending right now — you'll get an email automatically once it goes through.",
    });
  }
  await incrementDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');

  await padResponse(startTime);
  return json({ ok: true });
}

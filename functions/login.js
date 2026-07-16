import { getRosterEntry, insertMagicLink, insertLoginRejection } from './_lib/db.js';
import { generateRandomToken, magicLinkExpiry } from './_lib/auth.js';
import { json } from './_lib/http.js';
import { checkFixedWindow, checkCooldown, peekDailyCounter, incrementDailyCounter } from './_lib/rateLimit.js';

const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 600; // 10 requests / 10 minutes per IP
const EMAIL_COOLDOWN_SECONDS = 60; // 1 send / minute per roster email
const RESEND_DAILY_SOFT_CAP = 90; // stay under Resend free tier's 100/day hard cap

async function sendMagicLinkEmail(env, email, verifyUrl) {
  const body = JSON.stringify({
    from: env.RESEND_FROM || 'onboarding@resend.dev',
    to: email,
    subject: 'Your sign-in link',
    html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (res.ok) return true;
      console.error('resend_send_failed', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.error('resend_send_threw', err);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
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

  const { email } = await request.json().catch(() => ({}));
  if (!email || typeof email !== 'string') return json({ ok: true });

  const normalizedEmail = email.toLowerCase();
  const rosterEntry = await getRosterEntry(env.DB, normalizedEmail);

  if (!rosterEntry) {
    console.warn('login_rejected_not_in_roster', normalizedEmail);
    await insertLoginRejection(env.DB, normalizedEmail, ip).catch((err) =>
      console.error('failed_to_log_login_rejection', err)
    );
    // Always ok:true here too, regardless of roster membership, to avoid roster-enumeration.
    return json({ ok: true });
  }

  const sentToday = await peekDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');
  if (sentToday >= RESEND_DAILY_SOFT_CAP) {
    return json(
      { ok: false, error: 'high_demand', message: 'High demand right now — please try again in a few minutes.' },
      503
    );
  }

  const allowedToSend = await checkCooldown(env.RATE_LIMIT, 'rl:login:email', rosterEntry.email, EMAIL_COOLDOWN_SECONDS);
  if (!allowedToSend) {
    // Already sent one recently — don't duplicate-send, but don't alarm the resident either.
    return json({ ok: true });
  }

  const token = generateRandomToken();
  await insertMagicLink(env.DB, token, rosterEntry.email, magicLinkExpiry());
  const verifyUrl = new URL(request.url);
  verifyUrl.pathname = '/verify';
  verifyUrl.search = `?token=${token}`;

  const sent = await sendMagicLinkEmail(env, rosterEntry.email, verifyUrl.toString());
  if (!sent) {
    return json(
      { ok: false, error: 'email_failed', message: 'Something went wrong sending your email. Please try again in a minute.' },
      502
    );
  }
  await incrementDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');

  return json({ ok: true });
}

import { getRosterEntry, insertMagicLink } from './_lib/db.js';
import { generateRandomToken, magicLinkExpiry } from './_lib/auth.js';
import { json } from './_lib/http.js';

async function sendMagicLinkEmail(env, email, verifyUrl) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'onboarding@resend.dev',
      to: email,
      subject: 'Your sign-in link',
      html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
    }),
  });
}

export async function onRequestPost({ request, env }) {
  const { email } = await request.json().catch(() => ({}));
  if (!email || typeof email !== 'string') return json({ ok: true });

  const rosterEntry = await getRosterEntry(env.DB, email.toLowerCase());
  if (rosterEntry) {
    const token = generateRandomToken();
    await insertMagicLink(env.DB, token, rosterEntry.email, magicLinkExpiry());
    const verifyUrl = new URL(request.url);
    verifyUrl.pathname = '/verify';
    verifyUrl.search = `?token=${token}`;
    await sendMagicLinkEmail(env, rosterEntry.email, verifyUrl.toString());
  }
  // Always 200, regardless of roster membership, to avoid roster-enumeration.
  return json({ ok: true });
}

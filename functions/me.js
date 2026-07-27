import { verifySession, sessionRenewalHeaders } from './_lib/auth.js';
import { json } from './_lib/http.js';

export async function onRequestGet({ request, env }) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false }, 401);
  // scan.js calls /me on every page load, so this is where an active resident's
  // session gets its expiry pushed back out to a full 30 days.
  const headers = await sessionRenewalHeaders(env.SESSION_SECRET, session);
  return json({ ok: true, email: session.email, name: session.name }, 200, headers);
}

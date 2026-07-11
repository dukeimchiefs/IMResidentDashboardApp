import { verifySession } from './_lib/auth.js';
import { json } from './_lib/http.js';

export async function onRequestGet({ request, env }) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false }, 401);
  return json({ ok: true, email: session.email, name: session.name });
}

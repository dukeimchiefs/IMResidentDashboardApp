import { exportAttendance } from './_lib/db.js';
import { json } from './_lib/http.js';

export async function onRequestGet({ request, env }) {
  const adminKey = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_EXPORT_KEY || adminKey !== env.ADMIN_EXPORT_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const { results } = await exportAttendance(env.DB, since);
  return json({ ok: true, rows: results });
}

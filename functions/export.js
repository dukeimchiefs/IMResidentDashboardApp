import { exportAttendance } from './_lib/db.js';
import { json } from './_lib/http.js';
import { timingSafeEqualStr } from './_lib/auth.js';
import { checkFixedWindow } from './_lib/rateLimit.js';
import { recordSecurityFailure } from './_lib/securityAlerts.js';

const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 600; // 10 attempts / 10 minutes per IP

export async function onRequestGet({ request, env, waitUntil }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipOk = await checkFixedWindow(env.DB, 'rl:export:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipOk) return json({ ok: false, error: 'rate_limited' }, 429);

  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_EXPORT_KEY || !(await timingSafeEqualStr(adminKey, env.ADMIN_EXPORT_KEY))) {
    await recordSecurityFailure(env, waitUntil, 'export_auth_failure');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const { results } = await exportAttendance(env.DB, since);
  return json({ ok: true, rows: results });
}

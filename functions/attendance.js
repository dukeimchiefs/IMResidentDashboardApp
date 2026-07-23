import { verifyAdminSession, createAdminCookie, timingSafeEqualStr } from './_lib/auth.js';
import { exportAttendance, getRecentLoginRejections, countPendingLogins } from './_lib/db.js';
import { dbValueToLabel } from './_lib/eventTypes.js';
import { html } from './_lib/http.js';
import { checkFixedWindow } from './_lib/rateLimit.js';
import { recordSecurityFailure } from './_lib/securityAlerts.js';

const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 600; // 10 attempts / 10 minutes per IP

const PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem;background:#f3f2f1;color:#262626}
h1{font-size:1.25rem;color:#012169}
h2{font-size:1rem;color:#012169;margin-top:2.5rem}
table{border-collapse:collapse;width:100%;max-width:640px;background:#fff;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:0.5rem 1rem;border-bottom:1px solid #e5e5ea}
th{background:#e2e6ed}
.login-card{max-width:320px;margin:4rem auto;text-align:center}
input[type=password]{width:100%;padding:0.75rem;font-size:1rem;border:1px solid #e5e5e5;border-radius:8px;margin-bottom:1rem;box-sizing:border-box}
button{padding:0.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#00539b;color:#fff;cursor:pointer}
.error{color:#c62828}`;

// This route never renders a <script> tag, so script-src can be locked down
// entirely rather than falling back to http.js's same-origin-scripts default.
const ATTENDANCE_PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function passwordFormPage(error) {
  return `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_STYLE}</style></head>
<body>
  <div class="login-card">
    <h1>Attendance</h1>
    <form method="POST">
      <input type="password" name="password" placeholder="Password" autofocus />
      <button type="submit">View</button>
    </form>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  </div>
</body>
</html>`;
}

function attendanceTablePage(rows, rejections, pendingCount) {
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(r.event_date)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(dbValueToLabel(r.event_type))}</td></tr>`)
    .join('');
  const rejectionBody = rejections
    .map((r) => `<tr><td>${escapeHtml(r.timestamp)}</td><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.ip || '')}</td></tr>`)
    .join('');
  return `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_STYLE}</style></head>
<body>
  <h1>Attendance (${rows.length})</h1>
  <table>
    <thead><tr><th>Date</th><th>Name</th><th>Event</th></tr></thead>
    <tbody>${body}</tbody>
  </table>

  <h2>Recent sign-in attempts not on roster (${rejections.length})</h2>
  <table>
    <thead><tr><th>When</th><th>Email hint</th><th>IP</th></tr></thead>
    <tbody>${rejectionBody}</tbody>
  </table>

  <h2>Emails queued for retry (${pendingCount})</h2>
  <p>Sign-in emails that hit the Resend daily cap or failed to send — a scheduled
  Worker retries these every 15 minutes.</p>
</body>
</html>`;
}

export async function onRequestGet({ request, env }) {
  const authed = await verifyAdminSession(env.ADMIN_SESSION_SECRET, request);
  if (!authed) return html(passwordFormPage(), 200, ATTENDANCE_PAGE_HEADERS);

  const { results } = await exportAttendance(env.DB);
  const sorted = [...results].sort(
    (a, b) => b.event_date.localeCompare(a.event_date) || a.name.localeCompare(b.name)
  );
  const { results: rejections } = await getRecentLoginRejections(env.DB);
  const pendingCount = await countPendingLogins(env.DB);
  return html(attendanceTablePage(sorted, rejections, pendingCount), 200, ATTENDANCE_PAGE_HEADERS);
}

export async function onRequestPost({ request, env, waitUntil }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipOk = await checkFixedWindow(env.DB, 'rl:attendance:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipOk) {
    return html(passwordFormPage('Too many attempts. Please wait a few minutes and try again.'), 429, ATTENDANCE_PAGE_HEADERS);
  }

  const formData = await request.formData();
  const password = formData.get('password') || '';

  if (!env.ADMIN_PASSWORD || !(await timingSafeEqualStr(password, env.ADMIN_PASSWORD))) {
    await recordSecurityFailure(env, waitUntil, 'admin_auth_failure');
    return html(passwordFormPage('Incorrect password.'), 401, ATTENDANCE_PAGE_HEADERS);
  }

  const cookie = await createAdminCookie(env.ADMIN_SESSION_SECRET);
  return new Response(null, { status: 302, headers: { Location: '/attendance', 'Set-Cookie': cookie } });
}

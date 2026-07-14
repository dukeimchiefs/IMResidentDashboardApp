import { verifyAdminSession, createAdminCookie, timingSafeEqualStr } from './_lib/auth.js';
import { exportAttendance } from './_lib/db.js';
import { dbValueToLabel } from './_lib/eventTypes.js';
import { html } from './_lib/http.js';

const PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem;background:#f3f2f1;color:#262626}
h1{font-size:1.25rem;color:#012169}
table{border-collapse:collapse;width:100%;max-width:640px;background:#fff;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:0.5rem 1rem;border-bottom:1px solid #e5e5ea}
th{background:#e2e6ed}
.login-card{max-width:320px;margin:4rem auto;text-align:center}
input[type=password]{width:100%;padding:0.75rem;font-size:1rem;border:1px solid #e5e5e5;border-radius:8px;margin-bottom:1rem;box-sizing:border-box}
button{padding:0.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#00539b;color:#fff;cursor:pointer}
.error{color:#c62828}`;

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

function attendanceTablePage(rows) {
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(r.event_date)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(dbValueToLabel(r.event_type))}</td></tr>`)
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
</body>
</html>`;
}

export async function onRequestGet({ request, env }) {
  const authed = await verifyAdminSession(env.SESSION_SECRET, request);
  if (!authed) return html(passwordFormPage());

  const { results } = await exportAttendance(env.DB);
  const sorted = [...results].sort(
    (a, b) => b.event_date.localeCompare(a.event_date) || a.name.localeCompare(b.name)
  );
  return html(attendanceTablePage(sorted));
}

export async function onRequestPost({ request, env }) {
  const formData = await request.formData();
  const password = formData.get('password') || '';

  if (!env.ADMIN_PASSWORD || !timingSafeEqualStr(password, env.ADMIN_PASSWORD)) {
    return html(passwordFormPage('Incorrect password.'), 401);
  }

  const cookie = await createAdminCookie(env.SESSION_SECRET);
  return new Response(null, { status: 302, headers: { Location: '/attendance', 'Set-Cookie': cookie } });
}

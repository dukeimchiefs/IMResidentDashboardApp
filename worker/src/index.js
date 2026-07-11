import { getRosterEntry, insertMagicLink, getMagicLink, markMagicLinkUsed, hasCheckedIn, insertAttendance, exportAttendance } from './db.js';
import { generateRandomToken, createSessionCookie, clearSessionCookie, verifySession, magicLinkExpiry } from './auth.js';
import { validateScannedPayload, todayET } from './token.js';
import { EVENT_TYPES } from './eventTypes.js';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function sendMagicLinkEmail(env, email, verifyUrl) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'attendance@resend.dev',
      to: email,
      subject: 'Your sign-in link',
      html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
    }),
  });
}

async function handleLogin(request, env) {
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

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const VERIFY_PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1c1c1e}.card{text-align:center;max-width:320px;padding:2rem}button{padding:0.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer}button:disabled{opacity:0.5}p{font-size:0.95rem}`;

// GET /verify never mutates the token — it only renders a page requiring an
// explicit click. Email security gateways and link-preview scanners routinely
// GET-fetch links found in emails; if that alone consumed a single-use magic
// link, every resident's first sign-in would be silently burned before they
// ever clicked. Actual consumption happens only on the POST below.
async function handleVerifyPage(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return html(`<!doctype html><html><head><style>${VERIFY_PAGE_STYLE}</style></head><body><div class="card"><p>Missing sign-in link.</p></div></body></html>`, 400);

  const link = await getMagicLink(env.DB, token);
  if (!link || link.used || new Date(link.expires_at) < new Date()) {
    return html(
      `<!doctype html><html><head><style>${VERIFY_PAGE_STYLE}</style></head><body><div class="card"><p>This sign-in link is invalid or has expired. Request a new one from the app.</p></div></body></html>`,
      400
    );
  }

  return html(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${VERIFY_PAGE_STYLE}</style></head>
<body>
  <div class="card">
    <p>Click below to finish signing in.</p>
    <button id="confirm">Confirm sign-in</button>
    <p id="msg"></p>
  </div>
  <script>
    document.getElementById('confirm').addEventListener('click', async () => {
      const token = new URLSearchParams(window.location.search).get('token');
      const btn = document.getElementById('confirm');
      const msg = document.getElementById('msg');
      btn.disabled = true;
      try {
        const res = await fetch('/verify', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (res.ok) {
          window.location.href = '/';
        } else {
          const data = await res.json().catch(() => ({}));
          msg.textContent = data.error === 'invalid_or_expired_token'
            ? 'This link is invalid or has expired. Request a new one from the app.'
            : 'Something went wrong. Try again.';
          btn.disabled = false;
        }
      } catch {
        msg.textContent = 'Network error. Try again.';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
}

// POST /verify does the actual consuming: marks the token used and issues the
// session cookie. Only reachable via the explicit button click above.
async function handleVerifyConfirm(request, env) {
  const { token } = await request.json().catch(() => ({}));
  if (!token) return json({ ok: false, error: 'missing_token' }, 400);

  const link = await getMagicLink(env.DB, token);
  if (!link || link.used || new Date(link.expires_at) < new Date()) {
    return json({ ok: false, error: 'invalid_or_expired_token' }, 400);
  }
  await markMagicLinkUsed(env.DB, token);

  const rosterEntry = await getRosterEntry(env.DB, link.email);
  if (!rosterEntry) return json({ ok: false, error: 'not_on_roster' }, 400);

  const cookie = await createSessionCookie(env.SESSION_SECRET, { email: rosterEntry.email, name: rosterEntry.name });
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handleMe(request, env) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false }, 401);
  return json({ ok: true, email: session.email, name: session.name });
}

async function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': clearSessionCookie() },
  });
}

async function handleCheckin(request, env) {
  const session = await verifySession(env.SESSION_SECRET, request);
  if (!session) return json({ ok: false, error: 'not_authenticated' }, 401);

  const { token } = await request.json().catch(() => ({}));
  const result = await validateScannedPayload(env.QR_SECRET, token);
  if (!result.valid) return json({ ok: false, error: 'invalid_token' }, 400);

  const eventInfo = EVENT_TYPES[result.type];
  const eventDate = todayET();

  const alreadyChecked = await hasCheckedIn(env.DB, session.email, eventDate, eventInfo.dbValue);
  if (alreadyChecked) {
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: `You already checked in to ${eventInfo.label} today.`,
      },
      409
    );
  }

  const inserted = await insertAttendance(env.DB, {
    name: session.name,
    email: session.email,
    eventType: eventInfo.dbValue,
    eventDate,
    timestamp: new Date().toISOString(),
  });

  if (!inserted) {
    // Lost a race to a concurrent request for the same (email, date, event_type).
    return json(
      {
        ok: false,
        error: 'already_checked_in',
        eventType: eventInfo.dbValue,
        eventLabel: eventInfo.label,
        message: `You already checked in to ${eventInfo.label} today.`,
      },
      409
    );
  }

  return json({
    ok: true,
    eventType: eventInfo.dbValue,
    eventLabel: eventInfo.label,
    name: session.name,
    message: `Checked in to ${eventInfo.label}, ${session.name}!`,
  });
}

async function handleExport(request, env) {
  const adminKey = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_EXPORT_KEY || adminKey !== env.ADMIN_EXPORT_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const { results } = await exportAttendance(env.DB, since);
  return json({ ok: true, rows: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
      if (method === 'POST' && pathname === '/login') return handleLogin(request, env);
      if (method === 'GET' && pathname === '/verify') return handleVerifyPage(request, env);
      if (method === 'POST' && pathname === '/verify') return handleVerifyConfirm(request, env);
      if (method === 'GET' && pathname === '/me') return handleMe(request, env);
      if (method === 'GET' && pathname === '/logout') return handleLogout();
      if (method === 'POST' && pathname === '/checkin') return handleCheckin(request, env);
      if (method === 'GET' && pathname === '/export') return handleExport(request, env);
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      return json({ ok: false, error: 'internal_error', message: String(err.message || err) }, 500);
    }
  },
};

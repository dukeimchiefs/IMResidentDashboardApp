import { getMagicLink, consumeMagicLink, getRosterEntry } from './_lib/db.js';
import { createSessionCookie } from './_lib/auth.js';
import { json, html } from './_lib/http.js';

const VERIFY_PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1c1c1e}.card{text-align:center;max-width:320px;padding:2rem}button{padding:0.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer}button:disabled{opacity:0.5}p{font-size:0.95rem}`;

// generateRandomToken() produces 32 random bytes encoded as 43 base64url
// characters. Reject other shapes before touching D1, especially arbitrarily
// large attacker-controlled query/body values.
function isMagicLinkToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

// GET /verify never mutates the token — it only renders a page requiring an
// explicit click. Email security gateways and link-preview scanners routinely
// GET-fetch links found in emails; if that alone consumed a single-use magic
// link, every resident's first sign-in would be silently burned before they
// ever clicked. Actual consumption happens only on the POST below.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return html(`<!doctype html><html><head><style>${VERIFY_PAGE_STYLE}</style></head><body><div class="card"><p>Missing sign-in link.</p></div></body></html>`, 400);

  if (!isMagicLinkToken(token)) {
    return html(
      `<!doctype html><html><head><style>${VERIFY_PAGE_STYLE}</style></head><body><div class="card"><p>This sign-in link is invalid or has expired. Request a new one from the app.</p></div></body></html>`,
      400
    );
  }

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
export async function onRequestPost({ request, env }) {
  const { token } = await request.json().catch(() => ({}));
  if (!token) return json({ ok: false, error: 'missing_token' }, 400);
  if (!isMagicLinkToken(token)) {
    return json({ ok: false, error: 'invalid_or_expired_token' }, 400);
  }

  const link = await consumeMagicLink(env.DB, token, new Date().toISOString());
  if (!link) return json({ ok: false, error: 'invalid_or_expired_token' }, 400);

  const rosterEntry = await getRosterEntry(env.DB, link.email);
  if (!rosterEntry) return json({ ok: false, error: 'not_on_roster' }, 400);

  const cookie = await createSessionCookie(env.SESSION_SECRET, { email: rosterEntry.email, name: rosterEntry.name });
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

import { consumeMagicLink, getRosterEntry } from './_lib/db.js';
import { createSessionCookie } from './_lib/auth.js';
import { json, html } from './_lib/http.js';
import { checkFixedWindow } from './_lib/rateLimit.js';
import { validateTurnstile } from './_lib/turnstile.js';

const VERIFY_PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1c1c1e}.card{text-align:center;max-width:320px;padding:2rem}.challenge{display:flex;justify-content:center;margin:1rem 0}button{padding:0.75rem 1.5rem;font-size:1rem;border:none;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer}button:disabled{opacity:0.5}p{font-size:0.95rem}`;
const IP_LIMIT = 20;
const IP_WINDOW_SECONDS = 600;

// generateRandomToken() produces 32 random bytes encoded as 43 base64url
// characters. Reject other shapes before touching D1, especially arbitrarily
// large attacker-controlled query/body values.
function isMagicLinkToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

// GET /verify never queries or mutates the token — it only validates the
// unguessable token's shape and renders a page requiring an explicit click.
// This keeps link-preview scanners from consuming links and prevents cheap GET
// floods from turning into D1 lookups. Existence/expiry checks and single-use
// consumption all happen after Turnstile validation on the POST below.
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

  const sitekey = env.TURNSTILE_SITEKEY;
  if (typeof sitekey !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sitekey)) {
    console.error('turnstile_sitekey_missing');
    return html(`<!doctype html><html><head><style>${VERIFY_PAGE_STYLE}</style></head><body><div class="card"><p>Sign-in verification is temporarily unavailable. Try again later.</p></div></body></html>`, 503);
  }

  return html(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${VERIFY_PAGE_STYLE}</style></head>
<body>
  <div class="card">
    <p>Click below to finish signing in.</p>
    <div id="challenge" class="challenge"></div>
    <button id="confirm" disabled>Confirm sign-in</button>
    <p id="msg"></p>
  </div>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>
  <script>
    const btn = document.getElementById('confirm');
    const msg = document.getElementById('msg');
    let challengeToken = '';
    const widgetId = turnstile.render('#challenge', {
      sitekey: ${JSON.stringify(sitekey)},
      action: 'verify',
      callback(token) {
        challengeToken = token;
        btn.disabled = false;
        msg.textContent = '';
      },
      'expired-callback'() {
        challengeToken = '';
        btn.disabled = true;
      },
      'error-callback'() {
        challengeToken = '';
        btn.disabled = true;
        msg.textContent = 'Security check failed to load. Try again.';
        return true;
      },
    });

    document.getElementById('confirm').addEventListener('click', async () => {
      const token = new URLSearchParams(window.location.search).get('token');
      if (!challengeToken) return;
      const submittedChallenge = challengeToken;
      challengeToken = '';
      btn.disabled = true;
      try {
        const res = await fetch('/verify', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, turnstileToken: submittedChallenge }),
        });
        if (res.ok) {
          window.location.href = '/';
        } else {
          const data = await res.json().catch(() => ({}));
          msg.textContent = data.error === 'invalid_or_expired_token'
            ? 'This link is invalid or has expired. Request a new one from the app.'
            : data.error === 'challenge_failed'
              ? 'Security check expired. Complete it again.'
            : 'Something went wrong. Try again.';
          turnstile.reset(widgetId);
        }
      } catch {
        msg.textContent = 'Network error. Try again.';
        turnstile.reset(widgetId);
      }
    });
  </script>
</body>
</html>`);
}

// POST /verify does the actual consuming: marks the token used and issues the
// session cookie. Only reachable via the explicit button click above.
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipOk = await checkFixedWindow(env.DB, 'rl:verify:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipOk) return json({ ok: false, error: 'rate_limited' }, 429);

  const { token, turnstileToken } = await request.json().catch(() => ({}));
  if (!(await validateTurnstile(env, turnstileToken, ip, 'verify'))) {
    return json({ ok: false, error: 'challenge_failed' }, 403);
  }
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

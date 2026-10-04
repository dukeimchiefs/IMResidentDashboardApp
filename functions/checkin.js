// The entire resident-facing app.
//
// A phone's native camera opens /checkin?e=<type>&t=<token> straight from the
// posted QR. GET renders a form with one field; POST records the check-in and
// renders the result. No sign-in, no session, no client-side scanner, and no
// JSON API — a plain form post.
//
// The only JavaScript is Turnstile's, plus frontend/checkin-form.js, which
// guards the submit button against the two ways this form could be posted with
// no usable challenge token. Both are external files; script-src carries no
// 'unsafe-inline'. The form still renders and posts if either fails to load,
// though without Turnstile's there is no token and the post is refused.

import { getRoster, hasCheckedIn, insertAttendance } from './_lib/db.js';
import { validateScannedPayload, todayET } from './_lib/token.js';
import { EVENT_TYPES } from './_lib/eventTypes.js';
import { matchRosterName, normalizeName, MAX_INPUT_LENGTH } from './_lib/names.js';
import { html } from './_lib/http.js';
import { checkFixedWindow } from './_lib/rateLimit.js';
import { validateTurnstile } from './_lib/turnstile.js';

// Two limits, because one can't do both jobs. Residents check in from a single
// conference-room or hospital Wi-Fi that NATs the entire room behind one
// address, so a tight per-IP cap would throttle a full lecture hall — the old
// sign-in build sidestepped this by keying on the session email, which no
// longer exists. So the tight limit is keyed per person-per-IP (a resident
// retrying), and the loose one is a per-IP ceiling set above any real room but
// far below a script.
const PERSON_LIMIT = 8;
const PERSON_WINDOW_SECONDS = 600;
const IP_LIMIT = 240;
const IP_WINDOW_SECONDS = 600;

// Turnstile is embedded with implicit rendering, so it needs its script and
// frame but no inline script of our own — script-src stays free of
// 'unsafe-inline'. Overrides http.js's DEFAULT_HTML_CSP, which allows neither.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// Inlined rather than linked to /style.css: this page is the whole app, and a
// resident standing in a lecture hall on hospital Wi-Fi should get a laid-out
// page in one round trip instead of an unstyled flash if the stylesheet lags.
const PAGE_STYLE = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f2f1;color:#262626;padding:1.5rem}
.card{width:100%;max-width:24rem;text-align:center}
.event{font-size:1.5rem;font-weight:600;color:#012169;margin:0 0 .25rem}
.date{font-size:1rem;color:#57606a;margin:0 0 2rem}
label{display:block;text-align:left;font-size:1rem;font-weight:600;margin-bottom:.5rem}
input[type=text]{width:100%;padding:.9rem;font-size:1.15rem;border:1px solid #c9c9c9;border-radius:10px;margin-bottom:1rem}
button{width:100%;padding:.95rem;font-size:1.15rem;font-weight:600;border:none;border-radius:10px;background:#00539b;color:#fff;cursor:pointer}
.challenge{display:flex;justify-content:center;margin-bottom:1rem}
.result{font-size:1.35rem;font-weight:600;line-height:1.4;margin:0 0 .75rem}
.detail{font-size:1.05rem;color:#57606a;margin:0}
.ok .result{color:#1a7f37}
.bad .result{color:#c62828}
.hint{font-size:.95rem;color:#57606a;margin-top:1.5rem;line-height:1.5}
.tick{font-size:3rem;line-height:1;margin:0 0 .5rem}
`;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Turnstile, and /checkin-form.js, which keeps the submit button disabled until
// Turnstile has actually produced a token.
//
// The order and the plain `defer` are both load-bearing. Turnstile looks up the
// widget's data-*-callback names once, when it renders, and silently drops any
// that are not functions yet — for the life of the page. Deferred scripts run
// in document order, so checkin-form.js has always defined them first. With
// `async` on api.js a cached copy could run before checkin-form.js arrived,
// leaving the button held for the script's full timeout with a token already
// sitting in the form. A deferred script that fails to load is simply skipped,
// so Turnstile still runs if ours never arrives.
const FORM_SCRIPTS = `<script src="/checkin-form.js" defer></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>`;

// Only the form page gets scripts; the result pages have no widget to render
// and no form to guard.
function page(bodyHtml, status = 200, { formScripts = false } = {}) {
  return html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resident Check-In</title>
<style>${PAGE_STYLE}</style>
</head>
<body><div class="card">${bodyHtml}</div>
${formScripts ? FORM_SCRIPTS : ''}
</body>
</html>`,
    status,
    PAGE_HEADERS
  );
}

// "Tuesday, August 12" in Eastern time, matching the date the check-in is filed
// under. Purely so the resident can confirm the poster they scanned is today's.
function friendlyDate(dateStr) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', // dateStr is already an ET calendar date; don't shift it again
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function messagePage(headline, detail, tone = 'bad', status = 200) {
  return page(
    `<div class="${tone}">
      <p class="result">${escapeHtml(headline)}</p>
      ${detail ? `<p class="detail">${escapeHtml(detail)}</p>` : ''}
    </div>`,
    status
  );
}

// `error` and `prefillName` are set when re-rendering after a failed submit, so
// a resident who mistyped doesn't lose what they entered.
function formPage(eventKey, token, sitekey, { error = '', prefillName = '' } = {}) {
  const label = EVENT_TYPES[eventKey].label;
  return page(`
    <h1 class="event">${escapeHtml(label)}</h1>
    <p class="date">${escapeHtml(friendlyDate(todayET()))}</p>
    <form method="POST" id="checkin-form">
      <input type="hidden" name="e" value="${escapeHtml(eventKey)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <label for="name">Your name</label>
      <input type="text" id="name" name="name" value="${escapeHtml(prefillName)}"
             autocomplete="name" autocapitalize="words" autocorrect="off" spellcheck="false"
             enterkeyhint="done" required autofocus>
      <div class="challenge">
        <div class="cf-turnstile" data-sitekey="${escapeHtml(sitekey)}" data-action="checkin"
             data-callback="checkinChallengeReady"
             data-expired-callback="checkinChallengeExpired"
             data-error-callback="checkinChallengeFailed"
             data-refresh-expired="auto" data-retry="auto"></div>
      </div>
      <button type="submit" id="checkin-submit">Check in</button>
    </form>
    <p class="hint" id="checkin-note" hidden></p>
    ${error ? `<p class="hint" style="color:#c62828">${escapeHtml(error)}</p>` : ''}
  `, 200, { formScripts: true });
}

// Rejections that aren't the resident's fault get their own wording. A generic
// "check-in failed" reads identically whether the code is stale, the roster is
// missing them, or the network dropped — and sends the chiefs chasing the wrong
// thing.
const STALE_MESSAGE = 'This code has expired. Ask for the current code to be put back on screen, then scan it again.';

// Two different failures wore the same words until 2026-08-21, and the wording
// belonged to only one of them. A spent or timed-out token IS fixed by
// submitting again, because the re-rendered page mints a fresh one. A token
// that never existed is not: the challenge never ran, so tapping again posts
// the same nothing and gets the same refusal, indefinitely.
//
// The second message sends them back to the QR rather than to the reload
// button: this page is the response to a POST, so reloading it re-sends that
// POST — missing token included — behind a browser prompt asking whether to
// submit the form again. Scanning is a clean GET.
const CHALLENGE_EXPIRED_MESSAGE = 'The security check expired. Tap Check in once more.';
const CHALLENGE_UNAVAILABLE_MESSAGE =
  "The security check couldn't load on this network, so you are not checked in yet. Scan the code again — if it keeps failing, turn Wi-Fi off to use cellular data, or see a chief resident.";
const INVALID_MESSAGE = "This isn't a valid check-in link. Scan the code on the screen rather than a photo of an older one.";

// Shared by GET and POST: both need the same (e, t) pair validated the same way
// before anything else happens. Returns { ok: true, eventKey } or { ok: false,
// response } with the resident-facing page already built.
async function resolveEvent(env, eventKey, token) {
  if (!eventKey || !EVENT_TYPES[eventKey] || typeof token !== 'string') {
    return { ok: false, response: messagePage('Check-in link not recognised', INVALID_MESSAGE, 'bad', 400) };
  }

  // validateScannedPayload wants the original QR payload form, "<type>:<token>".
  // The URL splits the two across query parameters so the link stays readable
  // in a camera's preview banner, so put it back together here.
  const result = await validateScannedPayload(env.QR_SECRET, `${eventKey}:${token}`);
  if (!result.valid) {
    return {
      ok: false,
      response: result.stale
        ? messagePage('Expired code', STALE_MESSAGE, 'bad', 400)
        : messagePage('Check-in link not recognised', INVALID_MESSAGE, 'bad', 400),
    };
  }
  return { ok: true, eventKey: result.type };
}

function turnstileSitekey(env) {
  const sitekey = env.TURNSTILE_SITEKEY;
  return typeof sitekey === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(sitekey) ? sitekey : null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const eventKey = url.searchParams.get('e');
  const token = url.searchParams.get('t');

  // No rate limit on GET: it validates an HMAC and renders a page without
  // touching D1, so a flood costs nothing to absorb, while limiting it would
  // add a D1 write to every poster scan.
  const resolved = await resolveEvent(env, eventKey, token);
  if (!resolved.ok) return resolved.response;

  const sitekey = turnstileSitekey(env);
  if (!sitekey) {
    console.error('turnstile_sitekey_missing');
    return messagePage('Check-in is temporarily unavailable', 'Please try again in a few minutes, or tell a chief resident.', 'bad', 503);
  }

  return formPage(resolved.eventKey, token, sitekey);
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const form = await request.formData().catch(() => null);
  if (!form) return messagePage('Check-in link not recognised', INVALID_MESSAGE, 'bad', 400);

  const eventKey = form.get('e');
  const token = form.get('t');
  const typedName = String(form.get('name') || '');
  const turnstileToken = form.get('cf-turnstile-response');

  const ipOk = await checkFixedWindow(env.DB, 'rl:checkin:ip', ip, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipOk) {
    return messagePage('Too many check-ins from this network', 'Please wait a few minutes and try again.', 'bad', 429);
  }

  // Keyed on the normalized name so one resident's retries are capped without
  // the rest of the room sharing their budget. Normalizing first means
  // "Nick Brazeau" and "nick  brazeau" spend the same allowance.
  //
  // Capped because this runs ahead of Turnstile and the key is stored: without
  // it, whatever a script posts as `name` is written to D1 at full length, 240
  // times per window per address. Anything past the cap is refused by
  // matchRosterName anyway.
  const personKey = `${ip}|${normalizeName(typedName.slice(0, MAX_INPUT_LENGTH))}`;
  const personOk = await checkFixedWindow(env.DB, 'rl:checkin:person', personKey, PERSON_LIMIT, PERSON_WINDOW_SECONDS);
  if (!personOk) {
    return messagePage('Too many attempts', 'Please wait a few minutes and try again, or see a chief resident.', 'bad', 429);
  }

  const resolved = await resolveEvent(env, eventKey, token);
  if (!resolved.ok) return resolved.response;

  const sitekey = turnstileSitekey(env);
  if (!sitekey) {
    console.error('turnstile_sitekey_missing');
    return messagePage('Check-in is temporarily unavailable', 'Please try again in a few minutes, or tell a chief resident.', 'bad', 503);
  }

  // No token at all: the challenge never ran, so Cloudflare has nothing to
  // rule on. validateTurnstile returns false for this without logging anything,
  // which is why an entire conference of residents could fail this way and
  // leave no trace at all — separate it out so `wrangler pages deployment tail`
  // can tell it apart from a rejection.
  if (typeof turnstileToken !== 'string' || !turnstileToken) {
    console.warn('turnstile_missing_token', 'checkin');
    return formPage(resolved.eventKey, token, sitekey, {
      error: CHALLENGE_UNAVAILABLE_MESSAGE,
      prefillName: typedName,
    });
  }

  // Re-renders the form rather than dead-ending: a Turnstile token is
  // single-use and expires after a few minutes, so a resident who filled the
  // field and then got distracted lands here through no fault of their own.
  // /checkin-form.js resets the widget on expiry, so by the time this page is
  // back on screen the retry it suggests has a fresh token to send.
  if (!(await validateTurnstile(env, turnstileToken, ip, 'checkin'))) {
    return formPage(resolved.eventKey, token, sitekey, {
      error: CHALLENGE_EXPIRED_MESSAGE,
      prefillName: typedName,
    });
  }

  const roster = await getRoster(env.DB);
  const match = matchRosterName(typedName, roster);

  if (match.status !== 'matched') {
    const error =
      match.status === 'empty'
        ? 'Please type your name.'
        : match.status === 'ambiguous'
          ? 'More than one resident matches that name. Please add your middle name or initial.'
          : "We couldn't find that name on the roster. Check the spelling, or see a chief resident.";
    return formPage(resolved.eventKey, token, sitekey, { error, prefillName: typedName });
  }

  const rosterEntry = match.entry;
  const eventInfo = EVENT_TYPES[resolved.eventKey];

  // Debug accounts stop here. Everything that proves the flow works has already
  // run — the QR validated, the name resolved to a roster row — so the response
  // confirms a real success without writing an attendance row. Repeated testing
  // therefore can't accrue points or distort the leaderboard.
  //
  // The flag lives on the roster row rather than in an allowlist here because
  // this repository is public; a hardcoded name would be published with it.
  if (rosterEntry.test_account) {
    return messagePage(
      `Check-in OK — ${eventInfo.label}`,
      'Test account, attendance not recorded.',
      'ok'
    );
  }

  const eventDate = todayET();

  // Every live event recurs, so one check-in per resident per day per type is
  // the whole dedupe rule. The date-independent variant this used to branch on
  // existed for the retired 'welcome' onboarding poster, whose QR never expired.
  const alreadyChecked = await hasCheckedIn(env.DB, rosterEntry.name, eventDate, eventInfo.dbValue);
  const duplicateDetail = `You already checked in to ${eventInfo.label} today.`;

  if (alreadyChecked) {
    return messagePage(`You're already checked in, ${rosterEntry.name}`, duplicateDetail, 'ok');
  }

  const inserted = await insertAttendance(env.DB, {
    name: rosterEntry.name,
    eventType: eventInfo.dbValue,
    eventDate,
    timestamp: new Date().toISOString(),
  });

  // Lost a race to a concurrent submit for the same (name, date, event_type),
  // which the table's UNIQUE constraint rejects. Either way the resident is
  // checked in, which is all they care about.
  if (!inserted) {
    return messagePage(`You're already checked in, ${rosterEntry.name}`, duplicateDetail, 'ok');
  }

  return page(
    `<div class="ok">
      <p class="tick">&check;</p>
      <p class="result">You're checked in, ${escapeHtml(rosterEntry.name)}</p>
      <p class="detail">${escapeHtml(eventInfo.label)} &middot; ${escapeHtml(friendlyDate(eventDate))}</p>
    </div>`
  );
}

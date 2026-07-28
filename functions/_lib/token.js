import { QR_PREFIXES, MULTI_DAY_WINDOWS, WEEKLY_TYPES } from './eventTypes.js';
import { timingSafeEqualStr } from './auth.js';

const TOKEN_HEX_LENGTH = 16; // 16 hex chars = 8 bytes = 64 bits, plenty vs. guessing within a single day

// Calendar date in America/New_York, NOT UTC — must match scripts/generate_qr.py exactly,
// or a QR generated near Eastern midnight would encode the wrong day.
export function todayET(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // en-CA formats as YYYY-MM-DD
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// eventType is the short QR-prefix form: 'noon' | 'learning' | 'grandrounds'
export async function computeDailyToken(secret, dateStr, eventType) {
  const full = await hmacHex(secret, `${dateStr}:${eventType}`);
  return full.slice(0, TOKEN_HEX_LENGTH);
}

// QR payload format: "<type>:<token>", e.g. "noon:9f3a7c1e2b4d8801"
export function parsePayload(payload) {
  if (typeof payload !== 'string') return null;
  const i = payload.indexOf(':');
  if (i === -1) return null;
  const type = payload.slice(0, i);
  const token = payload.slice(i + 1);
  if (!QR_PREFIXES.includes(type) || token.length !== TOKEN_HEX_LENGTH) return null;
  return { type, token };
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Saturday that opens the lecture week containing dateStr. Must match
// week_anchor() in scripts/generate_qr.py exactly.
//
// Deriving the token from the week's anchor rather than the generator's run
// date is what makes the weekly rotation safe: the job can run any time between
// Saturday and Friday and still produce the token the Worker expects, so
// GitHub Actions' multi-hour cron delays can no longer strand a stale QR on
// screen during a lecture.
export function weekAnchor(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const daysSinceSaturday = (d.getUTCDay() + 1) % 7; // Sat=0, Sun=1, … Fri=6
  d.setUTCDate(d.getUTCDate() - daysSinceSaturday);
  return d.toISOString().slice(0, 10);
}

// How far back a rejected code is still recognised as merely *stale* — a real
// code that has since rotated, e.g. a printout left on a door or a lecture-hall
// screen that never got refreshed. Purely cosmetic: it only chooses the error
// message shown, and a stale code never checks anyone in.
const STALE_LOOKBACK_WEEKS = 8;

// Whether a rejected payload matches a token this secret genuinely issued for a
// nearby period, rather than being unrecognised input.
async function isStalePayload(secret, parsed, dateStr) {
  const candidates = [];
  const window = MULTI_DAY_WINDOWS[parsed.type];

  if (window) {
    // Reached only when dateStr falls outside the fixed window, so a match here
    // means the code is real but its window has passed (or not yet opened).
    candidates.push(window.anchorDate);
  } else if (WEEKLY_TYPES.includes(parsed.type)) {
    const thisWeek = weekAnchor(dateStr);
    for (let i = 1; i <= STALE_LOOKBACK_WEEKS; i++) {
      candidates.push(addDaysToDateStr(thisWeek, -7 * i));
    }
    // Also treat next week's code as stale rather than unrecognised: a rotation
    // that lands early would otherwise read as garbage to a resident.
    candidates.push(addDaysToDateStr(thisWeek, 7));
  } else {
    candidates.push(addDaysToDateStr(dateStr, -1));
  }

  for (const candidate of candidates) {
    const expected = await computeDailyToken(secret, candidate, parsed.type);
    if (await timingSafeEqualStr(expected, parsed.token)) return true;
  }
  return false;
}

// Returns { valid: boolean, stale?: true, type?: 'noon'|'learning'|'grandrounds'|'welcome' }
export async function validateScannedPayload(secret, payload, dateStr = todayET()) {
  const parsed = parsePayload(payload);
  if (!parsed) return { valid: false };

  const window = MULTI_DAY_WINDOWS[parsed.type];
  const outOfWindow = window
    && (dateStr < window.anchorDate
      || dateStr >= addDaysToDateStr(window.anchorDate, window.validDays));

  if (!outOfWindow) {
    // Fixed-window types use their own anchor, weekly lecture types use the
    // current week's Saturday, and anything else still rotates daily.
    let tokenDate = dateStr;
    if (window) tokenDate = window.anchorDate;
    else if (WEEKLY_TYPES.includes(parsed.type)) tokenDate = weekAnchor(dateStr);

    const expected = await computeDailyToken(secret, tokenDate, parsed.type);
    if (await timingSafeEqualStr(expected, parsed.token)) return { valid: true, type: parsed.type };
  }

  // Separate "a real code that has since rotated" from unrecognised input, so a
  // resident scanning yesterday's screen is told the code is stale instead of
  // being sent round the generic retry loop.
  if (await isStalePayload(secret, parsed, dateStr)) return { valid: false, stale: true };
  return { valid: false };
}

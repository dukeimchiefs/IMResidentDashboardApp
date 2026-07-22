import { QR_PREFIXES, MULTI_DAY_WINDOWS } from './eventTypes.js';
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

// Returns { valid: boolean, type?: 'noon'|'learning'|'grandrounds'|'welcome' }
export async function validateScannedPayload(secret, payload, dateStr = todayET()) {
  const parsed = parsePayload(payload);
  if (!parsed) return { valid: false };

  const window = MULTI_DAY_WINDOWS[parsed.type];
  if (window) {
    const windowEnd = addDaysToDateStr(window.anchorDate, window.validDays);
    if (dateStr < window.anchorDate || dateStr >= windowEnd) return { valid: false };
  }
  const tokenDate = window ? window.anchorDate : dateStr;

  const expected = await computeDailyToken(secret, tokenDate, parsed.type);
  const valid = await timingSafeEqualStr(expected, parsed.token);
  return valid ? { valid: true, type: parsed.type } : { valid: false };
}

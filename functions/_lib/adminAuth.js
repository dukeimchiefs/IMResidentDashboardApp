// What survived of the old _lib/auth.js after resident sign-in was removed.
//
// Residents no longer authenticate at all — they open a QR link and type their
// name — so the magic-link, session-cookie and roster-identity machinery is
// gone. Two things still need it: the chiefs' password-gated /attendance page,
// and the constant-time string compare that /export's admin key and the QR
// token check both depend on.

const ADMIN_COOKIE_NAME = 'admin_session';
const ADMIN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function base64url(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const bin = atob(padded);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64url(new Uint8Array(sig));
}

async function sha256(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(digest);
}

// Hashes both operands to a fixed-length digest before comparing, so the
// comparison never short-circuits on `a.length !== b.length` — that early
// return leaks the length of the secret (e.g. ADMIN_PASSWORD) via timing,
// even though the value itself stays hidden.
export async function timingSafeEqualStr(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Signs an expiry into "base64url(JSON) + '.' + HMAC-SHA256 signature".
async function signValue(secret, payloadObj, maxAgeSeconds) {
  const payload = { ...payloadObj, exp: Date.now() + maxAgeSeconds * 1000 };
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

// Returns the decoded payload if `value` is a signature-valid, unexpired signValue() output, else null.
async function verifySignedValue(secret, value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot === -1) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expectedSig = await hmacSign(secret, payloadB64);
  if (!(await timingSafeEqualStr(sig, expectedSig))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

// Password-gated admin cookie for the internal attendance table view. Carries no
// identity — the payload is empty and only its signature and expiry matter.
export async function createAdminCookie(secret) {
  const value = await signValue(secret, {}, ADMIN_MAX_AGE_SECONDS);
  return `${ADMIN_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_MAX_AGE_SECONDS}`;
}

export async function verifyAdminSession(secret, request) {
  const cookies = parseCookies(request);
  const payload = await verifySignedValue(secret, cookies[ADMIN_COOKIE_NAME]);
  return !!payload;
}

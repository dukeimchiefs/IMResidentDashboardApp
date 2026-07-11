const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL_MINUTES = 15;
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

export function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function generateRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

// Signs `payloadObj` plus an expiry into "base64url(JSON) + '.' + HMAC-SHA256 signature".
// Shared by the resident session cookie and the admin-page cookie below.
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
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
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

// Signed session cookie: base64url(JSON payload) + "." + HMAC-SHA256 signature
export async function createSessionCookie(secret, { email, name }) {
  const value = await signValue(secret, { email, name }, SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Returns { email, name } if the request carries a valid, unexpired session cookie, else null.
export async function verifySession(secret, request) {
  const cookies = parseCookies(request);
  const payload = await verifySignedValue(secret, cookies[SESSION_COOKIE_NAME]);
  return payload ? { email: payload.email, name: payload.name } : null;
}

export function magicLinkExpiry() {
  return new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();
}

// Password-gated admin cookie for the internal attendance table view — separate
// from the resident session cookie above (no roster/magic-link identity involved).
export async function createAdminCookie(secret) {
  const value = await signValue(secret, {}, ADMIN_MAX_AGE_SECONDS);
  return `${ADMIN_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_MAX_AGE_SECONDS}`;
}

export async function verifyAdminSession(secret, request) {
  const cookies = parseCookies(request);
  const payload = await verifySignedValue(secret, cookies[ADMIN_COOKIE_NAME]);
  return !!payload;
}

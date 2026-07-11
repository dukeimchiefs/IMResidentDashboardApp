const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL_MINUTES = 15;

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

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function generateRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

// Signed session cookie: base64url(JSON payload) + "." + HMAC-SHA256 signature
export async function createSessionCookie(secret, { email, name }) {
  const payload = { email, name, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 };
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  const value = `${payloadB64}.${sig}`;
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
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

// Returns { email, name } if the request carries a valid, unexpired session cookie, else null.
export async function verifySession(secret, request) {
  const cookies = parseCookies(request);
  const value = cookies[SESSION_COOKIE_NAME];
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
  return { email: payload.email, name: payload.name };
}

export function magicLinkExpiry() {
  return new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();
}

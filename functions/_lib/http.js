// Every response from this app is either a session-gated page/API response or
// carries no cacheable value (e.g. the /login rate-limit reply) — none of it
// should ever be stored by a shared cache or browser disk cache. Set this
// directly on the Function's own Response rather than relying on the Pages
// _headers file, whose Cache-Control rules don't reliably apply the same way
// to Functions responses as to static assets.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

// Cloudflare documents that the frontend/_headers file only applies to static
// asset responses, not to Pages Functions output — confirmed directly against
// production (GET /verify carried no CSP/X-Frame-Options/Referrer-Policy at
// all, while a static asset on the same domain carried all three from
// _headers). Every Function response needs these set here instead.
const BASE_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// JSON responses are never rendered as a page, so they get the strictest
// possible policy unconditionally.
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

// Same-origin-only baseline for HTML responses. Routes that need more (e.g.
// /verify's inline script and Turnstile embed) pass an override via `headers`.
const DEFAULT_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...NO_STORE_HEADERS,
      ...BASE_SECURITY_HEADERS,
      'Content-Security-Policy': JSON_CSP,
      ...headers,
    },
  });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...NO_STORE_HEADERS,
      ...BASE_SECURITY_HEADERS,
      'Content-Security-Policy': DEFAULT_HTML_CSP,
      ...headers,
    },
  });
}

// Every response from this app is either a session-gated page/API response or
// carries no cacheable value (e.g. the /login rate-limit reply) — none of it
// should ever be stored by a shared cache or browser disk cache. Set this
// directly on the Function's own Response rather than relying on the Pages
// _headers file, whose Cache-Control rules don't reliably apply the same way
// to Functions responses as to static assets.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE_HEADERS, ...headers },
  });
}

export function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE_HEADERS },
  });
}

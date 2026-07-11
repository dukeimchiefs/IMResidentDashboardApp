export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

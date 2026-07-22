const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

// Turnstile tokens are short-lived and single-use. Server-side validation is
// mandatory: the browser widget alone can be bypassed by calling the Function
// directly. Also bind successful validations to the expected action and
// production hostname so a token minted for another form/site is not reusable.
export async function validateTurnstile(env, token, ip, expectedAction) {
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  let response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        ...(ip && ip !== 'unknown' ? { remoteip: ip } : {}),
        idempotency_key: crypto.randomUUID(),
      }),
    });
  } catch {
    console.error('turnstile_siteverify_unreachable', expectedAction);
    return false;
  }

  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    console.error('turnstile_siteverify_invalid_response', expectedAction, response.status);
    return false;
  }

  const expectedHostname = env.TURNSTILE_HOSTNAME || 'imresidentdashboardapp.pages.dev';
  const valid =
    result.success === true &&
    result.action === expectedAction &&
    result.hostname === expectedHostname;

  if (!valid) {
    // Error codes and the expected action are enough to diagnose a failure;
    // never copy the submitted token or visitor IP into application logs.
    console.warn('turnstile_rejected', expectedAction, Array.isArray(result['error-codes']) ? result['error-codes'].join(',') : 'mismatch');
  }
  return valid;
}

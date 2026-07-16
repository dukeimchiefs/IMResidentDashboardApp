// Lightweight rate limiting backed by Cloudflare KV. KV reads-then-writes aren't
// atomic, so under true concurrent bursts a limit can be overshot by a few
// requests — an acceptable tradeoff at this app's scale (~170 users) versus the
// added complexity of a Durable Object.

export function utcDateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Buckets time into fixed windows of `windowSeconds` and returns whether this
// call is within `limit` for the current window (and records it if so).
export async function checkFixedWindow(kv, prefix, id, limit, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `${prefix}:${id}:${bucket}`;
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds + 5 });
  return true;
}

// Returns true if `id` has not hit `prefix` within the last `cooldownSeconds`,
// and marks it as hit for that duration. Used for "don't resend the same email
// twice within a minute" style checks.
export async function checkCooldown(kv, prefix, id, cooldownSeconds) {
  const key = `${prefix}:${id}`;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, '1', { expirationTtl: cooldownSeconds });
  return true;
}

// Increments a calendar-day (UTC) counter and returns the new count.
export async function incrementDailyCounter(kv, prefix, ttlSeconds = 90000) {
  const key = `${prefix}:${utcDateKey()}`;
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  await kv.put(key, String(count + 1), { expirationTtl: ttlSeconds });
  return count + 1;
}

// Reads today's counter value without incrementing it.
export async function peekDailyCounter(kv, prefix) {
  const key = `${prefix}:${utcDateKey()}`;
  const current = await kv.get(key);
  return current ? parseInt(current, 10) : 0;
}

// Rate limiting backed by D1 (not Cloudflare KV). KV's read-then-write is two
// separate round trips with no atomicity, so concurrent requests can all read
// the same stale count and all pass — confirmed via a local load test where
// 100 simultaneous requests against a limit of 10 all got through. D1 writes
// to a given database are serialized (backed by a single Durable Object under
// the hood), so an atomic upsert here genuinely holds under concurrency
// instead of just narrowing the race window.

export function utcDateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Buckets time into fixed windows of `windowSeconds` and returns whether this
// call is within `limit` for the current window (and records it if so).
// The check-and-increment is one atomic INSERT .. ON CONFLICT .. RETURNING
// statement — there's no read-then-write gap for concurrent callers to race.
export async function checkFixedWindow(db, prefix, id, limit, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `${prefix}:${id}:${bucket}`;
  const expiresAt = (bucket + 1) * windowSeconds + 5;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(key, expiresAt)
    .first();
  return row.count <= limit;
}

// Returns true if `id` has not hit `prefix` within the last `cooldownSeconds`,
// and marks it as hit for that duration. Used for "don't resend the same email
// twice within a minute" style checks. The DO UPDATE's WHERE clause only fires
// (and only then does RETURNING produce a row) if the previous cooldown has
// actually elapsed, so this is race-free the same way as checkFixedWindow.
export async function checkCooldown(db, prefix, id, cooldownSeconds) {
  const key = `${prefix}:${id}`;
  const now = nowSeconds();
  const newExpiresAt = now + cooldownSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
         WHERE rate_limit_counters.expires_at <= ?
       RETURNING 1 AS hit`
    )
    .bind(key, newExpiresAt, now)
    .first();
  return !!row;
}

// Increments a calendar-day (UTC) counter and returns the new count.
export async function incrementDailyCounter(db, prefix) {
  const key = `${prefix}:${utcDateKey()}`;
  const expiresAt = nowSeconds() + 90000; // ~25h, comfortably past day rollover
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(key, expiresAt)
    .first();
  return row.count;
}

// Reads today's counter value without incrementing it.
export async function peekDailyCounter(db, prefix) {
  const key = `${prefix}:${utcDateKey()}`;
  const row = await db.prepare('SELECT count FROM rate_limit_counters WHERE key = ?').bind(key).first();
  return row ? row.count : 0;
}

// Deletes rows whose window/cooldown/day has fully elapsed. KV entries expired
// on their own via expirationTtl; a D1 table has no equivalent, so this needs
// to be called periodically (see retry-worker's scheduled tick) or the table
// grows forever.
export async function cleanupExpiredCounters(db) {
  await db.prepare('DELETE FROM rate_limit_counters WHERE expires_at < ?').bind(nowSeconds()).run();
}

// Rate limiting backed by D1 (not Cloudflare KV). KV's read-then-write is two
// separate round trips with no atomicity, so concurrent requests can all read
// the same stale count and all pass — confirmed via a local load test where
// 100 simultaneous requests against a limit of 10 all got through. D1 writes
// to a given database are serialized (backed by a single Durable Object under
// the hood), so an atomic upsert here genuinely holds under concurrency
// instead of just narrowing the race window.

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Atomically increments a fixed-window counter and returns the new count.
export async function incrementFixedWindowCounter(db, prefix, id, windowSeconds) {
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
  return row.count;
}

// Buckets time into fixed windows of `windowSeconds` and returns whether this
// call is within `limit` for the current window (and records it if so). Unlike
// incrementFixedWindowCounter above, the conflict branch only increments WHEN
// still under `limit` — once a window is exhausted, further calls hit the
// WHERE clause, skip the UPDATE, and get nothing back from RETURNING, so a
// caller hammering a blocked window doesn't keep costing a D1 write per call.
export async function checkFixedWindow(db, prefix, id, limit, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `${prefix}:${id}:${bucket}`;
  const expiresAt = (bucket + 1) * windowSeconds + 5;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE
         SET count = count + 1
         WHERE rate_limit_counters.count < ?
       RETURNING count`
    )
    .bind(key, expiresAt, limit)
    .first();
  return !!row;
}

// Deletes rows whose window has fully elapsed. KV entries expired on their own
// via expirationTtl; a D1 table has no equivalent, so this needs to be called
// periodically (see cleanup-worker's scheduled tick) or the table grows forever.
export async function cleanupExpiredCounters(db) {
  await db.prepare('DELETE FROM rate_limit_counters WHERE expires_at < ?').bind(nowSeconds()).run();
}

export async function getRosterEntry(db, email) {
  return db.prepare('SELECT email, name FROM roster WHERE email = ?').bind(email).first();
}

export async function insertMagicLink(db, token, email, expiresAt) {
  await db
    .prepare('INSERT INTO magic_links (token, email, expires_at, used) VALUES (?, ?, ?, 0)')
    .bind(token, email, expiresAt)
    .run();
}

export async function getMagicLink(db, token) {
  return db.prepare('SELECT token, email, expires_at, used FROM magic_links WHERE token = ?').bind(token).first();
}

export async function markMagicLinkUsed(db, token) {
  await db.prepare('UPDATE magic_links SET used = 1 WHERE token = ?').bind(token).run();
}

export async function hasCheckedIn(db, email, eventDate, eventType) {
  const row = await db
    .prepare('SELECT 1 FROM attendance WHERE email = ? AND event_date = ? AND event_type = ?')
    .bind(email, eventDate, eventType)
    .first();
  return !!row;
}

// Returns true on success, false if a UNIQUE constraint violation occurred
// (race-condition safety net for concurrent double-taps of the same event).
export async function insertAttendance(db, { name, email, eventType, eventDate, timestamp }) {
  try {
    await db
      .prepare(
        'INSERT INTO attendance (name, email, event_type, event_date, timestamp) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(name, email, eventType, eventDate, timestamp)
      .run();
    return true;
  } catch (err) {
    if (String(err.message || err).toLowerCase().includes('unique')) return false;
    throw err;
  }
}

export async function insertLoginRejection(db, email, ip) {
  await db
    .prepare('INSERT INTO login_rejections (email, ip, timestamp) VALUES (?, ?, ?)')
    .bind(email, ip, new Date().toISOString())
    .run();
}

export async function getRecentLoginRejections(db, limit = 50) {
  return db
    .prepare('SELECT email, ip, timestamp FROM login_rejections ORDER BY timestamp DESC LIMIT ?')
    .bind(limit)
    .all();
}

// Retry queue for magic-link sends that hit the Resend daily cap or failed
// outright (drained by the separate scheduled retry-worker). UNIQUE(email)
// means re-triggering an already-queued email is a no-op, not a duplicate row.
export async function enqueuePendingLogin(db, email, ip, reason) {
  await db
    .prepare(
      'INSERT OR IGNORE INTO pending_login_emails (email, ip, reason, attempts, created_at) VALUES (?, ?, ?, 0, ?)'
    )
    .bind(email, ip, reason, new Date().toISOString())
    .run();
}

export async function getPendingLogins(db, limit) {
  return db
    .prepare('SELECT id, email, attempts FROM pending_login_emails ORDER BY created_at ASC LIMIT ?')
    .bind(limit)
    .all();
}

export async function countPendingLogins(db) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM pending_login_emails').first();
  return row ? row.count : 0;
}

export async function markPendingLoginAttempt(db, id) {
  await db
    .prepare('UPDATE pending_login_emails SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run();
}

export async function deletePendingLogin(db, id) {
  await db.prepare('DELETE FROM pending_login_emails WHERE id = ?').bind(id).run();
}

const RETENTION_DAYS = 30;

// Prunes data with no ongoing purpose: magic links that are used or expired
// (single-use, 15-minute TTL — nothing legitimate reads them after that), and
// login_rejections/pending_login_emails past a 30-day retention window. Called
// from the retry-worker's existing 15-minute cron tick.
export async function cleanupStaleData(db) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM magic_links WHERE used = 1 OR expires_at < ?').bind(new Date().toISOString()).run();
  await db.prepare('DELETE FROM login_rejections WHERE timestamp < ?').bind(cutoff).run();
  await db.prepare('DELETE FROM pending_login_emails WHERE created_at < ?').bind(cutoff).run();
}

export async function exportAttendance(db, since) {
  if (since) {
    return db
      .prepare('SELECT name, email, event_type, event_date, timestamp FROM attendance WHERE event_date >= ? ORDER BY event_date, event_type')
      .bind(since)
      .all();
  }
  return db
    .prepare('SELECT name, email, event_type, event_date, timestamp FROM attendance ORDER BY event_date, event_type')
    .all();
}

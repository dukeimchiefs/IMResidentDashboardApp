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

// Reads the whole roster so the Worker can resolve a typed name against it.
//
// A LIKE/= lookup on the typed string can't work: matching folds accents, case,
// punctuation, suffixes and middle names (see functions/_lib/names.js), and
// SQLite can't express that without a stored normalized column that Python and
// JavaScript would both have to compute identically. ~100 rows is a cheap read,
// and it keeps one normalizer in one language.
export async function getRoster(db) {
  const { results } = await db.prepare('SELECT email, name, test_account FROM roster').all();
  return results;
}

export async function hasCheckedIn(db, name, eventDate, eventType) {
  const row = await db
    .prepare('SELECT 1 FROM attendance WHERE name = ? AND event_date = ? AND event_type = ?')
    .bind(name, eventDate, eventType)
    .first();
  return !!row;
}

// Date-independent variant of hasCheckedIn, for ONCE_PER_RESIDENT event types
// (see functions/_lib/eventTypes.js). Their QR has no expiry, so the only thing
// stopping a resident resubmitting the same onboarding poster next week is this
// check plus the partial UNIQUE index backing it.
export async function hasEverCheckedIn(db, name, eventType) {
  const row = await db
    .prepare('SELECT 1 FROM attendance WHERE name = ? AND event_type = ?')
    .bind(name, eventType)
    .first();
  return !!row;
}

// Returns true on success, false if a UNIQUE constraint violation occurred
// (race-condition safety net for concurrent double-taps of the same event).
export async function insertAttendance(db, { name, eventType, eventDate, timestamp }) {
  try {
    await db
      .prepare('INSERT INTO attendance (name, event_type, event_date, timestamp) VALUES (?, ?, ?, ?)')
      .bind(name, eventType, eventDate, timestamp)
      .run();
    return true;
  } catch (err) {
    if (String(err.message || err).toLowerCase().includes('unique')) return false;
    throw err;
  }
}

// Shape is load-bearing: scrape_attendance.py reads {ok, rows:[{name, event_type,
// event_date, timestamp}]} and appends (date, name, event) to the workbook's
// AttendancePoints sheet. Changing a key here silently breaks the daily sync.
export async function exportAttendance(db, since) {
  if (since) {
    return db
      .prepare('SELECT name, event_type, event_date, timestamp FROM attendance WHERE event_date >= ? ORDER BY event_date, event_type')
      .bind(since)
      .all();
  }
  return db
    .prepare('SELECT name, event_type, event_date, timestamp FROM attendance ORDER BY event_date, event_type')
    .all();
}

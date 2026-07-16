CREATE TABLE roster (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('noon_conference', 'learning_session', 'grand_rounds')),
  event_date TEXT NOT NULL,          -- 'YYYY-MM-DD' in America/New_York
  timestamp TEXT NOT NULL,           -- ISO-8601 UTC insert time
  UNIQUE (email, event_date, event_type)
);

CREATE INDEX idx_attendance_date_type ON attendance (event_date, event_type);
CREATE INDEX idx_attendance_email ON attendance (email);

-- Admin-visible log of /login attempts for emails not found in the roster
-- (typos, rotated-out residents, or probing). Resident-facing response stays
-- generic regardless, to avoid roster-enumeration.
CREATE TABLE login_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_login_rejections_timestamp ON login_rejections (timestamp);

-- Roster emails whose magic-link send either hit the Resend daily cap or failed
-- outright. Drained by a separate scheduled Worker (see retry-worker/) that
-- retries them once quota/connectivity allows. One row per email at a time.
CREATE TABLE pending_login_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  ip TEXT,
  reason TEXT NOT NULL,          -- 'high_demand' | 'email_failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT
);

CREATE INDEX idx_pending_login_emails_created ON pending_login_emails (created_at);

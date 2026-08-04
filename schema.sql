CREATE TABLE roster (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Debug accounts. Their scans validate the QR and report success but never
  -- write an attendance row, so testing the scanner cannot inflate anyone's
  -- totals or consume a once-per-resident event. Set per row in the database and
  -- deliberately never listed in code: this repository is public, and a
  -- hardcoded allowlist would publish the addresses on it.
  test_account INTEGER NOT NULL DEFAULT 0
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
  event_type TEXT NOT NULL CHECK (event_type IN ('noon_conference', 'learning_session', 'grand_rounds', 'welcome')),
  event_date TEXT NOT NULL,          -- 'YYYY-MM-DD' in America/New_York
  timestamp TEXT NOT NULL,           -- ISO-8601 UTC insert time
  UNIQUE (email, event_date, event_type)
);

CREATE INDEX idx_attendance_date_type ON attendance (event_date, event_type);
CREATE INDEX idx_attendance_email ON attendance (email);

-- Onboarding happens once per resident, ever. The table's UNIQUE constraint is
-- scoped to a single event_date, which is the right rule for recurring lectures
-- but not for 'welcome': its QR has no expiry (MULTI_DAY_WINDOWS.welcome sets
-- validDays: null), so without this a resident could rescan the same poster for
-- a new row every day. Mirrors ONCE_PER_RESIDENT in functions/_lib/eventTypes.js
-- — adding a type there needs a matching partial index here.
CREATE UNIQUE INDEX idx_attendance_welcome_once ON attendance (email) WHERE event_type = 'welcome';

-- Admin-visible log of /login attempts for emails not found in the roster.
-- `email` stores only a masked hint (first character + domain), never the full
-- submitted address. Resident-facing responses remain generic to avoid
-- roster-enumeration.
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

-- Rate limiting (replaces the earlier KV-backed version — KV's read-then-write
-- isn't atomic, so concurrent bursts could bypass limits outright; D1 writes to
-- a single database are serialized, so an atomic upsert here actually holds).
-- `expires_at` is a unix-epoch-seconds cutoff used only for periodic cleanup —
-- the fixed-window/cooldown/daily-counter logic itself is driven by `key`.
CREATE TABLE rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_counters_expires ON rate_limit_counters (expires_at);

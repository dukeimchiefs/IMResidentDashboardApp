-- Re-keys attendance from email to name, and drops the email/magic-link tables.
--
-- Residents now check in by typing their name on a form the QR opens directly;
-- there is no sign-in, so no email is ever collected and email can no longer be
-- the dedupe key. The roster keeps its email column (it is still the primary
-- key, and scripts/seed_roster.py still loads it) — it just stops flowing into
-- attendance.
--
-- Run once against each database:
--   wrangler d1 execute attendance-db --file migrate_qr_form_checkin.sql --local
--   wrangler d1 execute attendance-db --file migrate_qr_form_checkin.sql --remote

-- Rebuild rather than ALTER: the UNIQUE constraint is part of the table
-- definition, and SQLite cannot drop or replace one in place.
CREATE TABLE attendance_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('noon_conference', 'learning_session', 'grand_rounds', 'welcome')),
  event_date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  UNIQUE (name, event_date, event_type)
);

-- GROUP BY, not a plain SELECT: the old UNIQUE was (email, event_date,
-- event_type), so one resident seeded under two email addresses could hold two
-- rows that collapse to a single (name, event_date, event_type) here. Keeping
-- MIN(id) preserves the earliest check-in and lets the insert succeed; without
-- it the whole migration aborts on a constraint violation partway through.
INSERT INTO attendance_new (id, name, event_type, event_date, timestamp)
SELECT MIN(id), name, event_type, event_date, MIN(timestamp)
FROM attendance
GROUP BY name, event_date, event_type;

DROP TABLE attendance;
ALTER TABLE attendance_new RENAME TO attendance;

CREATE INDEX idx_attendance_date_type ON attendance (event_date, event_type);
CREATE INDEX idx_attendance_name ON attendance (name);

-- Mirrors ONCE_PER_RESIDENT in functions/_lib/eventTypes.js, re-keyed onto name.
-- The welcome QR never expires, so this partial index is the only thing stopping
-- the same poster minting a new row for the same resident every morning.
CREATE UNIQUE INDEX idx_attendance_welcome_once ON attendance (name) WHERE event_type = 'welcome';

-- Everything below existed only to serve magic-link sign-in.
DROP TABLE IF EXISTS magic_links;
DROP TABLE IF EXISTS pending_login_emails;
DROP TABLE IF EXISTS login_rejections;

-- Counter rows are keyed by prefix and expire on their own schedule; the
-- sign-in prefixes ('rl:login:*', 'rl:verify:*', 'rl:checkin:email:*') now have
-- no writer, so clear them out rather than waiting for the cleanup tick.
DELETE FROM rate_limit_counters WHERE key LIKE 'rl:login:%' OR key LIKE 'rl:verify:%' OR key LIKE 'rl:checkin:email:%';

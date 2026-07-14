-- One-off migration: add 'grand_rounds' to the attendance.event_type CHECK constraint.
-- SQLite/D1 can't ALTER a CHECK constraint in place, so this rebuilds the table.
-- Run once against the live database:
--   wrangler d1 execute attendance-db --remote --file=./migrate_add_grand_rounds.sql
-- (use --local instead of --remote for the local dev database)

PRAGMA foreign_keys=off;

ALTER TABLE attendance RENAME TO attendance_old;

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('noon_conference', 'learning_session', 'grand_rounds')),
  event_date TEXT NOT NULL,          -- 'YYYY-MM-DD' in America/New_York
  timestamp TEXT NOT NULL,           -- ISO-8601 UTC insert time
  UNIQUE (email, event_date, event_type)
);

INSERT INTO attendance (id, name, email, event_type, event_date, timestamp)
  SELECT id, name, email, event_type, event_date, timestamp FROM attendance_old;

DROP TABLE attendance_old;

CREATE INDEX idx_attendance_date_type ON attendance (event_date, event_type);
CREATE INDEX idx_attendance_email ON attendance (email);

PRAGMA foreign_keys=on;

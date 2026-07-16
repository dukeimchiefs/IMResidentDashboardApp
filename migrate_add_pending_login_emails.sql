-- One-off migration for already-deployed databases: adds the pending_login_emails
-- table (retry queue for magic-link sends that hit the Resend daily cap or failed).
-- Safe to run against an existing DB — CREATE TABLE, no rebuild needed.
CREATE TABLE pending_login_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  ip TEXT,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT
);

CREATE INDEX idx_pending_login_emails_created ON pending_login_emails (created_at);

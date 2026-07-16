-- One-off migration for already-deployed databases: adds the login_rejections
-- table (admin-visible log of /login attempts for emails not on the roster).
-- Safe to run against an existing DB — CREATE TABLE, no rebuild needed.
CREATE TABLE login_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_login_rejections_timestamp ON login_rejections (timestamp);

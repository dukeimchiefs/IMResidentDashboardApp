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

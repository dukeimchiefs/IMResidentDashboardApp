-- Fresh-install schema. An existing database is brought here by
-- migrate_qr_form_checkin.sql instead.

CREATE TABLE roster (
  -- Still the primary key and still loaded by scripts/seed_roster.py, but no
  -- longer part of any resident-facing flow: check-in identifies a resident by
  -- the name they type, and nothing writes email into attendance. Kept because
  -- it is the one stable identifier for a resident across roster reloads, and
  -- because names alone are not unique enough to key a table on.
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Debug accounts. Their submissions validate the QR and report success but
  -- never write an attendance row, so testing the check-in flow cannot inflate
  -- anyone's totals or consume a once-per-resident event. Set per row in the
  -- database and deliberately never listed in code: this repository is public,
  -- and a hardcoded allowlist would publish those residents' names on it.
  test_account INTEGER NOT NULL DEFAULT 0
);

-- Name is the key, because name is what the resident types and what the
-- downstream workbook joins on (see functions/_lib/names.js). Only names the
-- roster already contains ever reach this table — the Worker rejects anything
-- it cannot resolve to exactly one roster row, and writes the roster's
-- spelling rather than the typed one.
--
-- 'welcome' stays in the CHECK list even though its QR was retired on
-- 2026-08-13 and nothing can write one any more. The live database holds 27
-- welcome rows that still count toward residents' points, and this file has to
-- keep describing that database exactly — a rebuild from a CHECK list without
-- 'welcome' would reject those rows on the way back in.
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('noon_conference', 'learning_session', 'grand_rounds', 'welcome')),
  event_date TEXT NOT NULL,          -- 'YYYY-MM-DD' in America/New_York
  timestamp TEXT NOT NULL,           -- ISO-8601 UTC insert time
  UNIQUE (name, event_date, event_type)
);

CREATE INDEX idx_attendance_date_type ON attendance (event_date, event_type);
CREATE INDEX idx_attendance_name ON attendance (name);

-- Retained for the same reason as the CHECK list above: it guards the 27
-- historical welcome rows against duplication. Onboarding happened once per
-- resident ever, which the table's per-date UNIQUE constraint could not express
-- on its own, since the welcome QR never expired. Nothing writes welcome any
-- more, so this index is now inert — but dropping it would let a future bulk
-- import silently double those rows.
CREATE UNIQUE INDEX idx_attendance_welcome_once ON attendance (name) WHERE event_type = 'welcome';

-- Rate limiting backed by D1 (not Cloudflare KV). KV's read-then-write isn't
-- atomic, so concurrent bursts could bypass limits outright; D1 writes to a
-- single database are serialized, so an atomic upsert here actually holds.
-- `expires_at` is a unix-epoch-seconds cutoff used only for periodic cleanup —
-- the fixed-window/cooldown logic itself is driven by `key`.
CREATE TABLE rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_counters_expires ON rate_limit_counters (expires_at);

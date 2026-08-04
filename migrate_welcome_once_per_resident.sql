-- Caps 'welcome' at one check-in per resident for all time, replacing the
-- once-per-day rule the table's UNIQUE (email, event_date, event_type) gives
-- every event type. Needed because the welcome QR no longer expires
-- (MULTI_DAY_WINDOWS.welcome now sets validDays: null), so a resident who
-- rescans the onboarding poster next week would otherwise get a second row.
--
-- Drops any pre-existing cross-date duplicates first, keeping each resident's
-- earliest welcome. As of 2026-07-31 the production table had none, so this
-- DELETE is expected to be a no-op — it exists so the migration is safe to
-- re-run and safe against rows written between now and when it's applied.
DELETE FROM attendance
WHERE event_type = 'welcome'
  AND id NOT IN (
    SELECT MIN(id) FROM attendance WHERE event_type = 'welcome' GROUP BY email
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_welcome_once
  ON attendance (email) WHERE event_type = 'welcome';

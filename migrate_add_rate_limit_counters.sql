-- One-off migration for already-deployed databases: adds the rate_limit_counters
-- table, replacing the KV-backed rate limiter (see functions/_lib/rateLimit.js
-- for why — KV's read-then-write isn't atomic and let bursts bypass limits
-- outright). Safe to run against an existing DB — CREATE TABLE, no rebuild needed.
--   wrangler d1 execute attendance-db --remote --file=./migrate_add_rate_limit_counters.sql
-- (use --local instead of --remote for the local dev database)

CREATE TABLE rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_counters_expires ON rate_limit_counters (expires_at);

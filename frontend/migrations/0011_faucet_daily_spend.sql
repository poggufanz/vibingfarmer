-- 0011: durable faucet accounting for the cost-bearing sponsor path
-- (frontend/api/faucet.js). One row per recipient plus a single '__global__' row for the
-- global daily ceiling, in aligned UTC-day windows so every isolate converges on the same
-- counters (the in-memory reserveDaily it replaces reset per isolate on cold start).
--
-- The handler's INSERT ... ON CONFLICT ... RETURNING statement keeps one current row per
-- recipient; a new aligned day replaces the previous total atomically. Same one-statement
-- race boundary as 0010_vf_cross_rate_limits.sql: never split into SELECT then UPDATE.
--
-- Rows are PK-reused each day (no per-day row growth), so no scheduled retention is needed:
-- growth is bounded by distinct recipients, and a stale row is re-keyed to the new window
-- on next use.
CREATE TABLE vf_faucet_daily_spend (
  recipient TEXT NOT NULL PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  total_base_units INTEGER NOT NULL CHECK (total_base_units >= 0),
  updated_at_ms INTEGER NOT NULL
);

-- Keeps any future stale-row selection bounded by updated_at_ms instead of requiring a
-- lifetime scan/sort as the table grows (same pattern as 0010).
CREATE INDEX vf_faucet_daily_spend_updated_at_idx
  ON vf_faucet_daily_spend (updated_at_ms);

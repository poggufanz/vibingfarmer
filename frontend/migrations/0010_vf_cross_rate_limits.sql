-- Task 15: one aligned fixed-window counter per route bucket and client IP. The
-- primary key keeps one current row per identity; a new aligned window replaces
-- the previous count atomically in the limiter's INSERT ... RETURNING statement.
CREATE TABLE vf_cross_rate_limits (
  route_bucket TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (route_bucket, client_ip)
);

-- Retention runs in bounded scheduled batches. This index keeps the stale-row selection bounded
-- by updated_at_ms instead of requiring a lifetime scan/sort as the table grows.
CREATE INDEX vf_cross_rate_limits_updated_at_idx
  ON vf_cross_rate_limits (updated_at_ms);

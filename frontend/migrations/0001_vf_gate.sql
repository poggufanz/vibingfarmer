CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  key_hint TEXT NOT NULL,
  owner TEXT NOT NULL,
  scopes TEXT NOT NULL,
  rate_limit INTEGER NOT NULL DEFAULT 60,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE usage_counters (
  key_id TEXT NOT NULL, window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);
CREATE TABLE usage_log (
  key_id TEXT NOT NULL, day TEXT NOT NULL, endpoint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day, endpoint)
);

-- Additive: persist provider identity + reported chain-tip/retention bounds per source (Pocket
-- Crew My Money Task 3 review fix — Critical 1 binds coverageProof to the real chain tip;
-- Spec-missing 5 requires the proof to persist provider identity + reported oldest/latest bounds).
-- SQLite additive ALTER only — 0002_agent_index.sql stays untouched, never rewritten.
-- NULL means "never reported" (a source that hasn't committed a page since this migration, or a
-- provider that never volunteered a bound, e.g. no oldestAvailableLedger) — never a guessed 0.
ALTER TABLE agent_index_sources ADD COLUMN provider_id TEXT;
ALTER TABLE agent_index_sources ADD COLUMN endpoint_class TEXT;
ALTER TABLE agent_index_sources ADD COLUMN reported_oldest_ledger INTEGER;
ALTER TABLE agent_index_sources ADD COLUMN reported_latest_ledger INTEGER;

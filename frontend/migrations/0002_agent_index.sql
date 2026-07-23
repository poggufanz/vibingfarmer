-- Agent owner-membership + source-coverage index (Pocket Crew My Money, Task 2). Additive only —
-- never alters or drops 0001_vf_gate.sql's api_keys/usage_counters/usage_log tables. See
-- frontend/api/agent-index/{models,store}.js for the JS-facing repository built on these tables
-- and .superpowers/sdd/pocket-crew-mm-task-2-brief.md for the schema contract this implements.

-- One row per manifest source (a funding_router or registry contract from
-- src/stellar/agentCreatorManifest.js's AGENT_CREATORS), tracking how far an indexer has durably
-- walked that source's event history. indexed_through_ledger = indexed_from_ledger - 1 is the
-- "nothing indexed yet" sentinel for a freshly-registered source — coverage completeness is never
-- inferred from a NULL cursor.
CREATE TABLE agent_index_sources (
  source_id TEXT PRIMARY KEY,                 -- `${network_id}:${creator_address}`
  network_id TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  indexed_from_ledger INTEGER NOT NULL,
  indexed_through_ledger INTEGER NOT NULL,
  finalized_through_ledger INTEGER NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_success_at INTEGER,
  last_error_at INTEGER,
  last_error_message TEXT,
  CHECK (indexed_through_ledger >= indexed_from_ledger - 1),
  CHECK (finalized_through_ledger <= indexed_through_ledger),
  CHECK (finalized_through_ledger >= indexed_from_ledger - 1)
);

-- Explicit inclusive missing ledger ranges per source. A gap is ALWAYS a row here — coverage
-- completeness is never inferred from a nullable cursor or from indexed_through_ledger alone.
CREATE TABLE agent_index_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES agent_index_sources(source_id),
  network_id TEXT NOT NULL,
  from_ledger INTEGER NOT NULL,
  through_ledger INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK (through_ledger >= from_ledger)
);
-- "Outstanding gaps" — the set a coverage proof must show empty before claiming completeness.
CREATE INDEX idx_agent_index_gaps_outstanding ON agent_index_gaps (source_id, status) WHERE status = 'open';

-- One row per discovered agent_account. Every row carries verified creation proof
-- (creation_ledger + creation_tx are NOT NULL) — an agent whose provenance isn't yet proven has
-- no row here; it is represented by an agent_index_gaps range (or awaits agent_backfill_audits)
-- instead of a placeholder membership.
CREATE TABLE agent_memberships (
  network_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('deposit', 'bridge', 'unknown')),
  creation_ledger INTEGER NOT NULL,
  creation_tx TEXT NOT NULL,
  grant_tx_hash TEXT,
  run_id TEXT,
  run_ordinal INTEGER,
  provenance TEXT NOT NULL,
  PRIMARY KEY (network_id, agent_address)
);
CREATE INDEX idx_agent_memberships_owner ON agent_memberships (network_id, owner_address);

-- One row per (owner, run, bridge-agent, Base-child) allocation leg. execution_status describes
-- job progress; custody_location separately describes where the money physically sits right now —
-- neither may be inferred from the other (docs/superpowers/plans/2026-07-22-pocket-crew-my-money.md).
CREATE TABLE agent_run_allocations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  bridge_agent_address TEXT NOT NULL,
  base_child_address TEXT,
  token TEXT NOT NULL,
  units TEXT NOT NULL,        -- decimal string — never SQLite INTEGER for token amounts
  decimals INTEGER NOT NULL,
  proxy_target TEXT,
  job_id TEXT,
  tx_id TEXT,
  execution_status TEXT NOT NULL
    CHECK (execution_status IN ('queued', 'accepted', 'burn-confirmed', 'minted', 'deposited', 'held', 'failed')),
  custody_location TEXT NOT NULL
    CHECK (custody_location IN ('owner', 'agent', 'stellar-vault', 'in-transit', 'base-proxy', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_run_allocations_run ON agent_run_allocations (network_id, run_id);
CREATE INDEX idx_agent_run_allocations_bridge_agent ON agent_run_allocations (network_id, bridge_agent_address);

-- Immutable audit attempts at proving historical (pre-tracking / direct-deploy) coverage for a
-- source. No UPDATE path exists in the repository — only INSERT (recordBackfillAudit) and read
-- (readCoverage). Only a result = 'verified' row can be treated as closing that source's
-- historical coverage gap; interpreting that is a later task's concern, not this schema's.
CREATE TABLE agent_backfill_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES agent_index_sources(source_id),
  attempted_at INTEGER NOT NULL,
  method TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('verified', 'failed')),
  from_ledger INTEGER NOT NULL,
  through_ledger INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  notes TEXT,
  CHECK (through_ledger >= from_ledger)
);

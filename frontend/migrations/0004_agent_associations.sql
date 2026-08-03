-- Relayer-attested Base child associations (Pocket Crew My Money, Task 5).
-- Additive only: historical allocation rows remain readable but have no association proof and
-- therefore surface as association='unknown'.
ALTER TABLE agent_run_allocations ADD COLUMN grant_tx_hash TEXT;
ALTER TABLE agent_run_allocations ADD COLUMN kernel_address TEXT;
ALTER TABLE agent_run_allocations ADD COLUMN mandate_binding_id TEXT;
ALTER TABLE agent_run_allocations ADD COLUMN mandate_binding_hash TEXT;
ALTER TABLE agent_run_allocations ADD COLUMN association_source TEXT
  CHECK (association_source IS NULL OR association_source = 'relayer-attested');
ALTER TABLE agent_run_allocations ADD COLUMN reported_at INTEGER;
ALTER TABLE agent_run_allocations ADD COLUMN scope_checked_at INTEGER;

-- A row's latest evidence is stored in agent_run_allocations. This append-only key journal makes
-- retries of an older, already-accepted tuple idempotent even after the latest row has advanced.
CREATE TABLE agent_association_events (
  idempotency_key TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  execution_status TEXT NOT NULL
    CHECK (execution_status IN ('queued', 'accepted', 'burn-confirmed', 'minted', 'deposited', 'held', 'failed')),
  tx_hash TEXT,
  reported_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_association_events_allocation
  ON agent_association_events (network_id, allocation_id);

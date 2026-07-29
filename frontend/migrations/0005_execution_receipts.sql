-- Durable AllocationReceiptV2 authority. Current projection rows use optimistic CAS; phase
-- evidence is an append-only journal. Exact asset units are TEXT at every SQL boundary.
CREATE TABLE execution_receipts (
  network_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  receipt_format INTEGER NOT NULL CHECK (receipt_format = 2),
  owner_address TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_allocation_id TEXT,
  child_id TEXT,
  worker_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  pull_status TEXT NOT NULL
    CHECK (pull_status IN ('not_started','submitted','confirmed','failed','unknown')),
  stellar_deposit_status TEXT NOT NULL
    CHECK (stellar_deposit_status IN ('not_started','submitted','confirmed','failed','unknown')),
  cctp_burn_status TEXT NOT NULL
    CHECK (cctp_burn_status IN ('not_started','submitted','confirmed','failed','unknown')),
  cctp_mint_status TEXT NOT NULL
    CHECK (cctp_mint_status IN ('not_started','submitted','confirmed','failed','unknown')),
  base_deposit_status TEXT NOT NULL
    CHECK (base_deposit_status IN ('not_started','submitted','confirmed','failed','unknown')),
  custody_location TEXT NOT NULL
    CHECK (custody_location IN
      ('owner','stellar-agent','stellar-vault','cctp-transit','base-kernel','base-vault','unknown')),
  custody_confirmed INTEGER NOT NULL CHECK (custody_confirmed IN (0,1)),
  custody_token TEXT,
  custody_units TEXT CHECK (
    custody_units IS NULL OR
    (typeof(custody_units) = 'text' AND custody_units GLOB '[0-9]*'
      AND custody_units NOT GLOB '*[^0-9]*')
  ),
  custody_decimals INTEGER CHECK (custody_decimals IS NULL OR custody_decimals >= 0),
  custody_reason TEXT,
  last_mutation_token TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, execution_id, allocation_id)
);
CREATE INDEX idx_execution_receipts_owner
  ON execution_receipts (network_id, owner_address, updated_at DESC);
CREATE INDEX idx_execution_receipts_agent
  ON execution_receipts (network_id, agent_address, updated_at DESC);

CREATE TRIGGER execution_receipts_monotonic_update
BEFORE UPDATE ON execution_receipts
WHEN NEW.version <> OLD.version + 1
  OR (OLD.pull_status = 'confirmed' AND NEW.pull_status <> 'confirmed')
  OR (OLD.stellar_deposit_status = 'confirmed' AND NEW.stellar_deposit_status <> 'confirmed')
  OR (OLD.cctp_burn_status = 'confirmed' AND NEW.cctp_burn_status <> 'confirmed')
  OR (OLD.cctp_mint_status = 'confirmed' AND NEW.cctp_mint_status <> 'confirmed')
  OR (OLD.base_deposit_status = 'confirmed' AND NEW.base_deposit_status <> 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'execution receipt version and confirmed evidence must be monotonic');
END;

CREATE TABLE execution_phase_attempts (
  attempt_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  attempt_kind TEXT NOT NULL
    CHECK (attempt_kind IN ('phase','revoked-scope-reconciliation')),
  phase TEXT NOT NULL
    CHECK (phase IN ('pull','stellar_deposit','cctp_burn','cctp_mint','base_deposit')),
  status TEXT NOT NULL
    CHECK (status IN ('not_started','submitted','confirmed','failed','unknown')),
  evidence_json TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  receipt_version INTEGER NOT NULL CHECK (receipt_version >= 1),
  FOREIGN KEY (network_id, execution_id, allocation_id)
    REFERENCES execution_receipts(network_id, execution_id, allocation_id)
);
CREATE INDEX idx_execution_phase_attempts_receipt
  ON execution_phase_attempts (network_id, execution_id, allocation_id, receipt_version);

CREATE TRIGGER execution_phase_attempts_no_update
BEFORE UPDATE ON execution_phase_attempts
BEGIN
  SELECT RAISE(ABORT, 'execution phase attempts are append-only');
END;
CREATE TRIGGER execution_phase_attempts_no_delete
BEFORE DELETE ON execution_phase_attempts
BEGIN
  SELECT RAISE(ABORT, 'execution phase attempts are append-only');
END;

CREATE TABLE execution_receipt_challenges (
  challenge_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_token TEXT UNIQUE,
  CHECK (
    (consumed_at IS NULL AND consume_token IS NULL) OR
    (consumed_at IS NOT NULL AND consume_token IS NOT NULL)
  )
);
CREATE INDEX idx_execution_receipt_challenges_subject
  ON execution_receipt_challenges (network_id, owner_address, agent_address, expires_at);

CREATE TABLE execution_recovery_leases (
  network_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL
    CHECK (phase IN ('pull','stellar_deposit','cctp_burn','cctp_mint','base_deposit')),
  owner_address TEXT NOT NULL,
  holder TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, execution_id, allocation_id, child_id, phase),
  CHECK (expires_at > acquired_at)
);
CREATE INDEX idx_execution_recovery_leases_owner
  ON execution_recovery_leases (network_id, owner_address, expires_at);

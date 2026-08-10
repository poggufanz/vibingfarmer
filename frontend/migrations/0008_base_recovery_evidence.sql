-- Authoritative Base-child batches and versioned recovery evidence.
-- Legacy 0006 rows intentionally keep a NULL execution_id and are not recoverable.
ALTER TABLE base_child_intents ADD COLUMN execution_id TEXT NULL;
ALTER TABLE base_child_intents
  ADD COLUMN recovery_version INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(recovery_version) = 'integer' AND recovery_version >= 0
  );

CREATE UNIQUE INDEX idx_base_child_intents_execution
  ON base_child_intents (network_id, execution_id)
  WHERE execution_id IS NOT NULL;

DROP TRIGGER base_child_intents_immutable_identity;
CREATE TRIGGER base_child_intents_immutable_identity
BEFORE UPDATE ON base_child_intents
WHEN OLD.network_id <> NEW.network_id
  OR OLD.binding_id <> NEW.binding_id
  OR OLD.allocation_id <> NEW.allocation_id
  OR OLD.child_id <> NEW.child_id
  OR OLD.owner_address <> NEW.owner_address
  OR OLD.agent_address <> NEW.agent_address
  OR OLD.intent_digest <> NEW.intent_digest
  OR OLD.intent_json <> NEW.intent_json
  OR OLD.token <> NEW.token
  OR OLD.units <> NEW.units
  OR OLD.decimals <> NEW.decimals
  OR OLD.execution_id IS NOT NEW.execution_id
BEGIN
  SELECT RAISE(ABORT, 'base child intent identity is immutable');
END;

DROP TRIGGER base_child_intents_monotonic_lifecycle;
CREATE TRIGGER base_child_intents_monotonic_lifecycle
BEFORE UPDATE ON base_child_intents
WHEN (
    OLD.lifecycle_sequence IS NOT NEW.lifecycle_sequence
    OR OLD.lifecycle_status IS NOT NEW.lifecycle_status
    OR OLD.lifecycle_evidence_json IS NOT NEW.lifecycle_evidence_json
  ) AND (
    NEW.lifecycle_sequence <> OLD.lifecycle_sequence + 1
    OR (OLD.lifecycle_status = 'confirmed' AND NEW.lifecycle_status <> 'confirmed')
  )
BEGIN
  SELECT RAISE(ABORT, 'base child lifecycle sequence and confirmed evidence must be monotonic');
END;

CREATE TRIGGER base_child_intents_recovery_version_cas
BEFORE UPDATE ON base_child_intents
WHEN OLD.recovery_version IS NOT NEW.recovery_version
  AND NEW.recovery_version <> OLD.recovery_version + 1
BEGIN
  SELECT RAISE(ABORT, 'base child recovery version must advance by one');
END;

CREATE TABLE base_child_intent_batches (
  idempotency_key TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL UNIQUE,
  network_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  grant_tx_hash TEXT NOT NULL,
  kernel_address TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  base_job_id TEXT NOT NULL,
  burn_units_7 TEXT NOT NULL CHECK (
    typeof(burn_units_7) = 'text' AND burn_units_7 GLOB '[0-9]*'
      AND burn_units_7 NOT GLOB '*[^0-9]*' AND length(burn_units_7) > 0
  ),
  child_count INTEGER NOT NULL CHECK (typeof(child_count) = 'integer' AND child_count > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE base_child_intent_batch_items (
  idempotency_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, ordinal),
  UNIQUE (idempotency_key, network_id, binding_id, execution_id, allocation_id, child_id),
  FOREIGN KEY (idempotency_key) REFERENCES base_child_intent_batches(idempotency_key),
  FOREIGN KEY (network_id, binding_id, allocation_id, child_id)
    REFERENCES base_child_intents(network_id, binding_id, allocation_id, child_id)
);

CREATE TRIGGER base_child_intent_batches_no_update
BEFORE UPDATE ON base_child_intent_batches
BEGIN
  SELECT RAISE(ABORT, 'base child intent batches are append-only');
END;
CREATE TRIGGER base_child_intent_batches_no_delete
BEFORE DELETE ON base_child_intent_batches
BEGIN
  SELECT RAISE(ABORT, 'base child intent batches are append-only');
END;

CREATE TRIGGER base_child_intent_batch_items_parent_facts
BEFORE INSERT ON base_child_intent_batch_items
WHEN NOT EXISTS (
  SELECT 1
  FROM base_child_intent_batches AS batch
  JOIN base_child_intents AS child
    ON child.network_id = NEW.network_id
   AND child.binding_id = NEW.binding_id
   AND child.execution_id = NEW.execution_id
   AND child.allocation_id = NEW.allocation_id
   AND child.child_id = NEW.child_id
  WHERE batch.idempotency_key = NEW.idempotency_key
    AND NEW.ordinal < batch.child_count
    AND batch.network_id = NEW.network_id
    AND batch.binding_id = NEW.binding_id
    AND batch.owner_address = NEW.owner_address
    AND batch.agent_address = NEW.agent_address
    AND child.owner_address = NEW.owner_address
    AND child.agent_address = NEW.agent_address
    AND child.intent_digest = NEW.intent_digest
    AND json_extract(child.intent_json, '$.runId') = batch.run_id
    AND json_extract(child.intent_json, '$.grantTxHash') = batch.grant_tx_hash
    AND json_extract(child.intent_json, '$.kernelAddress') = batch.kernel_address
    AND json_extract(child.intent_json, '$.bindingHash') = batch.binding_hash
    AND json_extract(child.intent_json, '$.baseJobId') = batch.base_job_id
)
BEGIN
  SELECT RAISE(ABORT, 'base child batch item facts do not match parent');
END;

CREATE TRIGGER base_child_intent_batch_items_no_update
BEFORE UPDATE ON base_child_intent_batch_items
BEGIN
  SELECT RAISE(ABORT, 'base child intent batch items are append-only');
END;
CREATE TRIGGER base_child_intent_batch_items_no_delete
BEFORE DELETE ON base_child_intent_batch_items
BEGIN
  SELECT RAISE(ABORT, 'base child intent batch items are append-only');
END;

CREATE TABLE base_child_phase_events (
  event_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  recovery_version INTEGER NOT NULL CHECK (
    typeof(recovery_version) = 'integer' AND recovery_version > 0
  ),
  phase TEXT NOT NULL CHECK (
    phase IN ('cctp_burn','cctp_attestation','cctp_mint','base_deposit')
  ),
  state TEXT NOT NULL CHECK (
    state IN ('submitting','submitted','confirmed','failed','unknown','blocked')
  ),
  evidence_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0),
  UNIQUE (network_id, binding_id, allocation_id, child_id, recovery_version),
  FOREIGN KEY (network_id, binding_id, allocation_id, child_id)
    REFERENCES base_child_intents(network_id, binding_id, allocation_id, child_id)
);

CREATE INDEX idx_base_child_phase_events_identity
  ON base_child_phase_events
    (network_id, binding_id, execution_id, allocation_id, child_id, recovery_version);

CREATE TRIGGER base_child_phase_events_parent_cas
BEFORE INSERT ON base_child_phase_events
WHEN NOT EXISTS (
  SELECT 1 FROM base_child_intents
  WHERE network_id = NEW.network_id
    AND binding_id = NEW.binding_id
    AND execution_id = NEW.execution_id
    AND allocation_id = NEW.allocation_id
    AND child_id = NEW.child_id
    AND owner_address = NEW.owner_address
    AND agent_address = NEW.agent_address
    AND recovery_version = NEW.recovery_version - 1
)
BEGIN
  SELECT RAISE(ABORT, 'base child phase evidence CAS conflict');
END;

CREATE TRIGGER base_child_phase_events_no_update
BEFORE UPDATE ON base_child_phase_events
BEGIN
  SELECT RAISE(ABORT, 'base child phase events are append-only');
END;
CREATE TRIGGER base_child_phase_events_no_delete
BEFORE DELETE ON base_child_phase_events
BEGIN
  SELECT RAISE(ABORT, 'base child phase events are append-only');
END;

CREATE TABLE base_child_phase_projection (
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('cctp_burn','cctp_attestation','cctp_mint','base_deposit')
  ),
  latest_event_id TEXT NOT NULL UNIQUE,
  recovery_version INTEGER NOT NULL CHECK (
    typeof(recovery_version) = 'integer' AND recovery_version > 0
  ),
  state TEXT NOT NULL CHECK (
    state IN ('submitting','submitted','confirmed','failed','unknown','blocked')
  ),
  evidence_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0),
  PRIMARY KEY (network_id, binding_id, allocation_id, child_id, phase),
  FOREIGN KEY (latest_event_id) REFERENCES base_child_phase_events(event_id),
  FOREIGN KEY (network_id, binding_id, allocation_id, child_id)
    REFERENCES base_child_intents(network_id, binding_id, allocation_id, child_id)
);

CREATE TRIGGER base_child_phase_projection_immutable_identity
BEFORE UPDATE ON base_child_phase_projection
WHEN OLD.network_id <> NEW.network_id
  OR OLD.binding_id <> NEW.binding_id
  OR OLD.execution_id <> NEW.execution_id
  OR OLD.allocation_id <> NEW.allocation_id
  OR OLD.child_id <> NEW.child_id
  OR OLD.phase <> NEW.phase
BEGIN
  SELECT RAISE(ABORT, 'base child phase projection identity is immutable');
END;

CREATE TABLE base_child_recovery_leases (
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('cctp_burn','cctp_attestation','cctp_mint','base_deposit')
  ),
  owner_address TEXT NOT NULL,
  action TEXT NOT NULL,
  evidence_version INTEGER NOT NULL CHECK (
    typeof(evidence_version) = 'integer' AND evidence_version >= 0
  ),
  holder TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  acquired_at INTEGER NOT NULL CHECK (typeof(acquired_at) = 'integer' AND acquired_at >= 0),
  expires_at INTEGER NOT NULL CHECK (
    typeof(expires_at) = 'integer' AND expires_at > acquired_at
  ),
  PRIMARY KEY (network_id, binding_id, allocation_id, child_id, phase),
  FOREIGN KEY (network_id, binding_id, allocation_id, child_id)
    REFERENCES base_child_intents(network_id, binding_id, allocation_id, child_id)
);
CREATE INDEX idx_base_child_recovery_leases_owner
  ON base_child_recovery_leases (network_id, owner_address, expires_at);
CREATE INDEX idx_base_child_recovery_leases_expiry
  ON base_child_recovery_leases (expires_at);

CREATE TRIGGER base_child_recovery_leases_immutable_facts
BEFORE UPDATE ON base_child_recovery_leases
WHEN OLD.network_id <> NEW.network_id
  OR OLD.binding_id <> NEW.binding_id
  OR OLD.execution_id <> NEW.execution_id
  OR OLD.allocation_id <> NEW.allocation_id
  OR OLD.child_id <> NEW.child_id
  OR OLD.phase <> NEW.phase
  OR OLD.owner_address <> NEW.owner_address
  OR OLD.action <> NEW.action
  OR OLD.evidence_version <> NEW.evidence_version
BEGIN
  SELECT RAISE(ABORT, 'base child recovery lease facts are immutable');
END;

-- Immutable Base-child reviewed intents. A binding can own many children: child_id remains part
-- of both the primary identity and every lifecycle/idempotency identity.
CREATE TABLE base_child_intents (
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  token TEXT NOT NULL,
  units TEXT NOT NULL CHECK (
    typeof(units) = 'text' AND units GLOB '[0-9]*' AND units NOT GLOB '*[^0-9]*'
  ),
  decimals INTEGER NOT NULL CHECK (decimals >= 0),
  lifecycle_sequence INTEGER NOT NULL CHECK (lifecycle_sequence >= 0),
  lifecycle_status TEXT NOT NULL
    CHECK (lifecycle_status IN ('planned','submitted','confirmed','failed','unknown')),
  lifecycle_evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, binding_id, allocation_id, child_id)
);
CREATE INDEX idx_base_child_intents_owner
  ON base_child_intents (network_id, owner_address, updated_at DESC);
CREATE INDEX idx_base_child_intents_agent
  ON base_child_intents (network_id, agent_address, binding_id);

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
BEGIN
  SELECT RAISE(ABORT, 'base child intent identity is immutable');
END;

CREATE TRIGGER base_child_intents_monotonic_lifecycle
BEFORE UPDATE ON base_child_intents
WHEN NEW.lifecycle_sequence <> OLD.lifecycle_sequence + 1
  OR (OLD.lifecycle_status = 'confirmed' AND NEW.lifecycle_status <> 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'base child lifecycle sequence and confirmed evidence must be monotonic');
END;

CREATE TABLE base_child_lifecycle_events (
  network_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status IN ('planned','submitted','confirmed','failed','unknown')),
  evidence_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, binding_id, allocation_id, child_id, sequence),
  FOREIGN KEY (network_id, binding_id, allocation_id, child_id)
    REFERENCES base_child_intents(network_id, binding_id, allocation_id, child_id)
);

CREATE TRIGGER base_child_lifecycle_events_no_update
BEFORE UPDATE ON base_child_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'base child lifecycle events are append-only');
END;
CREATE TRIGGER base_child_lifecycle_events_no_delete
BEFORE DELETE ON base_child_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'base child lifecycle events are append-only');
END;

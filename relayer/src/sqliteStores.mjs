// relayer/src/sqliteStores.mjs — persistent drop-ins for store.mjs / server.mjs's jobs Map /
// mandateStore.mjs, backed by node:sqlite (built-in, no native npm dep — Docker/ARM friendly).
// One DB file, three tables. Mandate rows hold session private keys: the DB file must live on a
// root-only volume (see deploy/docker-compose.yml) and rows are deleted on expiry, mirroring
// mandateStore.mjs's lazy-evict + sweep semantics so server.mjs behavior is unchanged.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAssociationOutbox } from './associationOutbox.mjs';
import { createBaseEvidenceOutbox } from './baseEvidenceOutbox.mjs';
export { buildForwardFarmIntent } from './farmIntent.mjs';
import {
  RELAY_CLAIMABLE_STATES,
  relayEnqueueDecision,
  relayClaim,
  relayRenew,
  relayRecordAttested,
  relayMarkMintSubmitting,
  relayMarkMintSubmitted,
  relayFinishMinted,
  relayFinishBlocked,
  relayFinishUncertain,
  relayRelease,
  relayReconcileExpired,
  relayStatusOf,
  relayError,
} from './store.mjs';

const HOUR_MS = 60 * 60 * 1000;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const V3_IMMUTABLE_FIELDS = [
  'approvalDigest', 'policyDigest', 'serializedApproval', 'sessionKeyDigest', 'sessionKeyAddress',
  'capabilityHash', 'stellarOwner', 'kernelAddress', 'relayerOrigin', 'validUntilSeconds',
  'bindingId', 'bindingHash', 'permissionId',
];
const MIGRATED_MANDATE_STATUS = 'activation_uncertain';
const QUARANTINED_MANDATE_STATUS = 'revoked';

function migrationDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalMandateMigrationDestinationDigest({ outcome, record }) {
  const facts = outcome === 'migrate'
    ? [
      record.approvalDigest,
      record.policyDigest,
      record.stellarOwner,
      record.kernelAddress,
      record.sessionKeyAddress,
      record.relayerOrigin,
      record.validUntilSeconds,
      record.bindingId,
      record.bindingHash,
      record.permissionId,
      record.sessionKeyDigest,
      record.createdAt,
      MIGRATED_MANDATE_STATUS,
      null,
      null,
      null,
      null,
      null,
    ]
    : [
      record.approvalDigest,
      record.stellarOwner,
      record.kernelAddress,
      record.quarantineReason,
      QUARANTINED_MANDATE_STATUS,
      null,
      null,
      null,
      null,
      null,
    ];
  return migrationDigest(JSON.stringify([
    'vf-legacy-mandate-destination-v1',
    outcome,
    facts,
  ]));
}

export function persistedMandateMigrationDestinationDigest(row) {
  if (row.status === MIGRATED_MANDATE_STATUS) {
    if (row.capability_hash !== null
      || row.activation_user_op_hash !== null
      || row.activation_tx_hash !== null
      || row.activated_at !== null
      || row.quarantine_reason !== null
      || migrationDigest(String(row.serialized_approval || '')) !== row.approval_digest) {
      throw new Error('persisted migrated destination facts are invalid');
    }
    return canonicalMandateMigrationDestinationDigest({
      outcome: 'migrate',
      record: {
        approvalDigest: row.approval_digest,
        policyDigest: row.policy_digest,
        stellarOwner: row.stellar_owner,
        kernelAddress: row.kernel_address,
        sessionKeyAddress: row.session_key_address,
        relayerOrigin: row.relayer_origin,
        validUntilSeconds: row.valid_until_seconds,
        bindingId: row.binding_id,
        bindingHash: row.binding_hash,
        permissionId: row.permission_id,
        sessionKeyDigest: row.session_key_digest,
        createdAt: row.created_at,
      },
    });
  }
  if (row.status === QUARANTINED_MANDATE_STATUS) {
    if ([
      row.policy_digest,
      row.serialized_approval,
      row.session_key_address,
      row.relayer_origin,
      row.valid_until_seconds,
      row.binding_id,
      row.binding_hash,
      row.permission_id,
      row.session_key_envelope,
      row.session_key_digest,
      row.capability_hash,
      row.activation_user_op_hash,
      row.activation_tx_hash,
      row.activated_at,
    ].some((value) => value !== null)) {
      throw new Error('persisted revoked destination retained authority');
    }
    return canonicalMandateMigrationDestinationDigest({
      outcome: QUARANTINED_MANDATE_STATUS,
      record: {
        approvalDigest: row.approval_digest,
        stellarOwner: row.stellar_owner,
        kernelAddress: row.kernel_address,
        quarantineReason: row.quarantine_reason,
      },
    });
  }
  throw new Error('persisted migration status is invalid');
}

export function mandateMigrationTargetDigest(rows) {
  const identitiesAndDigests = rows.map((row) => [
    row.mandate_id,
    persistedMandateMigrationDestinationDigest(row),
  ]).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return migrationDigest(JSON.stringify(['vf-mandate-migration-target-v1', identitiesAndDigests]));
}

const TARGET_MANDATE_TABLES = [
  'mandates_v3',
  'mandate_activation_work',
  'mandate_migration_state',
];

const PRE_POLICY_MANDATE_SCHEMA = `
  CREATE TABLE mandates_v3 (
    mandate_id TEXT PRIMARY KEY,
    approval_digest TEXT NOT NULL,
    serialized_approval TEXT,
    stellar_owner TEXT,
    kernel_address TEXT,
    session_key_address TEXT,
    relayer_origin TEXT,
    valid_until_seconds INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending_activation','active','activation_uncertain','revoked')),
    binding_id TEXT,
    binding_hash TEXT,
    permission_id TEXT,
    session_key_envelope TEXT,
    capability_hash TEXT,
    activation_user_op_hash TEXT,
    activation_tx_hash TEXT,
    activated_at INTEGER,
    quarantine_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE mandate_activation_work (
    mandate_id TEXT PRIMARY KEY,
    stellar_owner TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','submitting','submitted','done','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    user_op_hash TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (mandate_id) REFERENCES mandates_v3(mandate_id)
  );
`;

function quoteSchemaIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedSchemaSql(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1');
}

function targetSchemaFingerprint(db) {
  const directObjects = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE lower(name) IN ('mandates_v3','mandate_activation_work','mandate_migration_state')
       OR lower(tbl_name) IN ('mandates_v3','mandate_activation_work','mandate_migration_state')
  `).all();
  const directKeys = new Set(directObjects.map(({ type, name }) => `${type}\0${name}`));
  const targetReference = /(?:^|[^a-z0-9_])(mandates_v3|mandate_activation_work|mandate_migration_state)(?:$|[^a-z0-9_])/i;
  const indirectObjects = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  `).all().filter(({ type, name, sql }) => (
    !directKeys.has(`${type}\0${name}`) && targetReference.test(String(sql))
  ));
  const objects = [...directObjects, ...indirectObjects]
    .sort((left, right) => (
      left.type.localeCompare(right.type)
      || left.name.localeCompare(right.name)
      || left.tbl_name.localeCompare(right.tbl_name)
    )).map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: normalizedSchemaSql(row.sql),
  }));
  const tables = objects.filter(({ type }) => type === 'table').map(({ name }) => name);
  return {
    objects,
    tables: tables.map((name) => ({
      name,
      columns: db.prepare(`PRAGMA table_xinfo(${quoteSchemaIdentifier(name)})`).all()
        .map(({ cid, name: columnName, type, notnull, dflt_value: defaultValue, pk, hidden }) => ({
          cid,
          name: columnName,
          type,
          notnull,
          defaultValue,
          pk,
          hidden,
        })),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoteSchemaIdentifier(name)})`).all()
        .map(({ id, seq, table, from, to, on_update: onUpdate,
          on_delete: onDelete, match }) => ({
          id, seq, table, from, to, onUpdate, onDelete, match,
        })),
    })),
  };
}

let mandateSchemaReferences;

function canonicalMandateSchemaReferences() {
  if (mandateSchemaReferences) return mandateSchemaReferences;
  const capture = (setup) => {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec('PRAGMA foreign_keys=ON');
      setup(reference);
      return targetSchemaFingerprint(reference);
    } finally {
      reference.close();
    }
  };
  mandateSchemaReferences = {
    empty: capture(() => {}),
    prePolicy: capture((db) => db.exec(PRE_POLICY_MANDATE_SCHEMA)),
    currentFresh: capture((db) => db.exec(MANDATE_V3_SCHEMA)),
    currentAltered: capture((db) => {
      db.exec(PRE_POLICY_MANDATE_SCHEMA);
      db.exec(`
        ALTER TABLE mandates_v3 ADD COLUMN policy_digest TEXT;
        ALTER TABLE mandates_v3 ADD COLUMN session_key_digest TEXT;
      `);
      db.exec(MANDATE_V3_SCHEMA);
    }),
  };
  return mandateSchemaReferences;
}

function sameFingerprint(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireForeignKeys(db) {
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
    throw new Error('mandate target foreign keys are disabled');
  }
}

function validateCurrentMandateRows(db) {
  const markerRows = db.prepare(`
    SELECT id, phase, manifest_version, source_digest, target_digest,
           migrated_count, quarantined_count, updated_at,
           typeof(id) AS id_type,
           typeof(phase) AS phase_type,
           typeof(manifest_version) AS manifest_version_type,
           typeof(source_digest) AS source_digest_type,
           typeof(target_digest) AS target_digest_type,
           typeof(migrated_count) AS migrated_count_type,
           typeof(quarantined_count) AS quarantined_count_type,
           typeof(updated_at) AS updated_at_type
    FROM mandate_migration_state ORDER BY id
  `).all();
  const marker = markerRows[0];
  const canonicalPhase = marker && ['virgin', 'cleanup_pending', 'completed'].includes(marker.phase);
  const virginMetadata = marker?.phase === 'virgin'
    && [
      marker.manifest_version,
      marker.source_digest,
      marker.target_digest,
      marker.migrated_count,
      marker.quarantined_count,
    ].every((value) => value === null)
    && [
      marker.manifest_version_type,
      marker.source_digest_type,
      marker.target_digest_type,
      marker.migrated_count_type,
      marker.quarantined_count_type,
    ].every((type) => type === 'null');
  const boundMetadata = marker?.phase !== 'virgin'
    && marker?.manifest_version === 1
    && marker?.manifest_version_type === 'integer'
    && DIGEST_RE.test(marker?.source_digest || '')
    && marker?.source_digest_type === 'text'
    && DIGEST_RE.test(marker?.target_digest || '')
    && marker?.target_digest_type === 'text'
    && Number.isSafeInteger(marker?.migrated_count)
    && marker.migrated_count >= 0
    && marker?.migrated_count_type === 'integer'
    && Number.isSafeInteger(marker?.quarantined_count)
    && marker.quarantined_count >= 0
    && marker?.quarantined_count_type === 'integer';
  if (markerRows.length !== 1 || marker.id !== 1 || !canonicalPhase
    || marker.id_type !== 'integer'
    || marker.phase_type !== 'text'
    || marker.updated_at_type !== 'integer'
    || (!virginMetadata && !boundMetadata)) {
    throw new Error('mandate migration marker singleton is invalid');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new Error('mandate target foreign-key integrity failed');
  }
  const invalidWork = db.prepare(`
    SELECT 1 FROM mandate_activation_work AS work
    LEFT JOIN mandates_v3 AS mandate ON mandate.mandate_id = work.mandate_id
    WHERE mandate.mandate_id IS NULL
       OR work.stellar_owner IS NOT mandate.stellar_owner
       OR work.kernel_address IS NOT mandate.kernel_address
    LIMIT 1
  `).get();
  if (invalidWork) throw new Error('mandate activation identity integrity failed');
  if (marker.phase === 'completed') {
    try {
      const migrationRows = db.prepare(`
        SELECT * FROM mandates_v3 WHERE capability_hash IS NULL ORDER BY mandate_id
      `).all();
      const migratedCount = migrationRows
        .filter(({ status }) => status === MIGRATED_MANDATE_STATUS).length;
      const quarantinedCount = migrationRows
        .filter(({ status }) => status === QUARANTINED_MANDATE_STATUS).length;
      if (migrationRows.length !== marker.migrated_count + marker.quarantined_count
        || migratedCount !== marker.migrated_count
        || quarantinedCount !== marker.quarantined_count
        || mandateMigrationTargetDigest(migrationRows) !== marker.target_digest) {
        throw new Error('completed mandate migration target aggregate is invalid');
      }
    } catch {
      throw new Error('completed mandate migration target aggregate integrity failed');
    }
  }
  return marker;
}

export function classifyMandateSchemaEnsemble(db) {
  requireForeignKeys(db);
  const fingerprint = targetSchemaFingerprint(db);
  const references = canonicalMandateSchemaReferences();
  if (sameFingerprint(fingerprint, references.empty)) {
    return { kind: 'absent', cleanupPending: false };
  }
  if (sameFingerprint(fingerprint, references.prePolicy)) {
    const mandates = db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n;
    const work = db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n;
    if (mandates !== 0 || work !== 0 || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('nonempty pre-policy mandate target cannot be upgraded safely');
    }
    return { kind: 'pre-policy', cleanupPending: false };
  }
  if (sameFingerprint(fingerprint, references.currentFresh)
    || sameFingerprint(fingerprint, references.currentAltered)) {
    const migrationState = validateCurrentMandateRows(db);
    return {
      kind: 'current',
      cleanupPending: migrationState.phase === 'cleanup_pending',
      migrationState,
    };
  }
  throw new Error('mandate target schema ensemble is incompatible');
}

function prepareMandateSchema(db) {
  db.exec('PRAGMA foreign_keys=ON');
  const initial = classifyMandateSchemaEnsemble(db);
  if (initial.kind === 'current') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = classifyMandateSchemaEnsemble(db);
    if (locked.kind !== initial.kind) {
      throw new Error('mandate target schema changed during initialization');
    }
    if (locked.kind === 'pre-policy') {
      db.exec(`
        ALTER TABLE mandates_v3 ADD COLUMN policy_digest TEXT;
        ALTER TABLE mandates_v3 ADD COLUMN session_key_digest TEXT;
      `);
    }
    db.exec(MANDATE_V3_SCHEMA);
    if (classifyMandateSchemaEnsemble(db).kind !== 'current') {
      throw new Error('mandate target schema initialization failed');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Task 8 cctp_relay_work: checkpointed CCTP relay-work authority. The generic relay_records
// table is NEVER a fallback for this work. Column order is pinned by the RED suite; the
// evidence/confirmation CHECKs make half-written attested checkpoints and hash-less
// mint_submitted/minted rows unrepresentable at the schema level.
// Index note (deviation from the task-8 design's DDL): the design's column order
// (state, lease_expires_at, created_at, exec_id) provably cannot serve the suite-pinned
// EXPLAIN QUERY PLAN for `... WHERE state NOT IN (...) ORDER BY created_at, exec_id`
// (verified empirically against node:sqlite — a leading low-cardinality state column with a
// NOT IN constraint yields SCAN + temp b-tree, never the index). The pinned name is kept;
// leading (created_at, exec_id) is what makes the recovery listing index-backed.
const CCTP_RELAY_WORK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cctp_relay_work (
    exec_id TEXT PRIMARY KEY,
    source_domain INTEGER NOT NULL,
    burn_tx_hash TEXT NOT NULL UNIQUE,
    expectation_json TEXT NOT NULL,
    expectation_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'attestation_pending','attested','mint_submitting','mint_submitted',
      'minted','blocked','uncertain'
    )),
    message_hex TEXT,
    nonce_hex TEXT,
    message_digest TEXT,
    attestation_hex TEXT,
    attestation_digest TEXT,
    evidence_version INTEGER NOT NULL DEFAULT 0,
    mint_tx_hash TEXT,
    reason_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (state <> 'attested' OR (
      message_hex IS NOT NULL AND nonce_hex IS NOT NULL AND message_digest IS NOT NULL
      AND attestation_hex IS NOT NULL AND attestation_digest IS NOT NULL
    )),
    CHECK (state <> 'mint_submitted' OR mint_tx_hash IS NOT NULL),
    CHECK (state <> 'minted' OR mint_tx_hash IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_recovery
    ON cctp_relay_work(created_at, exec_id, state, lease_expires_at);
`;

export const MANDATE_V3_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mandates_v3 (
    mandate_id TEXT PRIMARY KEY,
    approval_digest TEXT NOT NULL,
    policy_digest TEXT,
    serialized_approval TEXT,
    stellar_owner TEXT,
    kernel_address TEXT,
    session_key_address TEXT,
    relayer_origin TEXT,
    valid_until_seconds INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending_activation','active','activation_uncertain','revoked')),
    binding_id TEXT,
    binding_hash TEXT,
    permission_id TEXT,
    session_key_envelope TEXT,
    session_key_digest TEXT,
    capability_hash TEXT,
    activation_user_op_hash TEXT,
    activation_tx_hash TEXT,
    activated_at INTEGER,
    quarantine_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mandate_activation_work (
    mandate_id TEXT PRIMARY KEY,
    stellar_owner TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','submitting','submitted','done','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    user_op_hash TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
      FOREIGN KEY (mandate_id) REFERENCES mandates_v3(mandate_id)
  );
  CREATE TABLE IF NOT EXISTS mandate_migration_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('virgin','cleanup_pending','completed')),
    manifest_version INTEGER,
    source_digest TEXT,
    target_digest TEXT,
    migrated_count INTEGER,
    quarantined_count INTEGER,
    updated_at INTEGER NOT NULL,
    CHECK (
      (phase = 'virgin'
        AND manifest_version IS NULL
        AND source_digest IS NULL
        AND target_digest IS NULL
        AND migrated_count IS NULL
        AND quarantined_count IS NULL)
      OR
      (phase IN ('cleanup_pending','completed')
        AND manifest_version = 1
        AND length(source_digest) = 64
        AND source_digest NOT GLOB '*[^0-9a-f]*'
        AND length(target_digest) = 64
        AND target_digest NOT GLOB '*[^0-9a-f]*'
        AND migrated_count >= 0
        AND quarantined_count >= 0)
    )
  );
  INSERT OR IGNORE INTO mandate_migration_state (
    id, phase, manifest_version, source_digest, target_digest,
    migrated_count, quarantined_count, updated_at
  ) VALUES (1, 'virgin', NULL, NULL, NULL, NULL, NULL, 0);
`;

export function mandateSessionAad(record) {
  return JSON.stringify([
    'vf-mandate-session-v2',
    record.mandateId,
    record.approvalDigest,
    record.policyDigest,
    record.stellarOwner,
    String(record.kernelAddress || '').toLowerCase(),
    String(record.sessionKeyAddress || '').toLowerCase(),
    record.validUntilSeconds,
    record.bindingId,
  ]);
}

export function createSqliteStores(path, {
  ttlMs = HOUR_MS,
  now = () => Date.now(),
  nowSeconds = () => Math.floor(Date.now() / 1000),
  leaseToken = randomUUID,
  sessionKeyCipher,
  outboxMaxAttempts = 5,
  farmIntentFault = () => {},
} = {}) {
  if (typeof farmIntentFault !== 'function') throw new Error('farm intent fault seam is invalid');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    prepareMandateSchema(db);
    db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS relay_records (exec_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS association_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      identity_key TEXT NOT NULL,
      child_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      report_digest TEXT NOT NULL,
      report_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','leased','delivered','dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(identity_key, sequence)
    );
    CREATE TABLE IF NOT EXISTS farm_execution_work (
      job_id TEXT PRIMARY KEY,
      burn_tx_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','running','done','uncertain')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS farm_intent_work_v2 (
      job_id TEXT PRIMARY KEY CHECK (length(job_id) = 32),
      mandate_id TEXT NOT NULL CHECK (length(mandate_id) = 32),
      request_id TEXT NOT NULL CHECK (length(request_id) = 32),
      stellar_owner TEXT NOT NULL,
      kernel_address TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
      intent_json TEXT NOT NULL,
      expectation_digest TEXT NOT NULL CHECK (length(expectation_digest) = 64),
      expectation_json TEXT NOT NULL,
      batch_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(batch_idempotency_key) = 64),
      agent_index_batch_digest TEXT NOT NULL CHECK (length(agent_index_batch_digest) = 64),
      agent_index_batch_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'intent_pending','awaiting_burn','relay_pending','deposit_pending',
        'deposit_confirming','done','blocked','uncertain'
      )),
      burn_tx_hash TEXT UNIQUE,
      relay_exec_id TEXT UNIQUE,
      ack_digest TEXT,
      ack_json TEXT,
      reason_code TEXT,
      intent_attempts INTEGER NOT NULL DEFAULT 0 CHECK (intent_attempts >= 0),
      lease_kind TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(mandate_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS base_evidence_heads (
      network_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      job_id TEXT,
      next_recovery_version INTEGER NOT NULL CHECK (next_recovery_version >= 0),
      latest_phase TEXT,
      latest_state TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (network_id,binding_id,execution_id,allocation_id,child_id)
    );
    CREATE TABLE IF NOT EXISTS base_evidence_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      network_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      expected_recovery_version INTEGER NOT NULL CHECK (expected_recovery_version >= 0),
      resulting_recovery_version INTEGER NOT NULL CHECK (resulting_recovery_version = expected_recovery_version + 1),
      phase TEXT NOT NULL,
      state TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      report_json TEXT NOT NULL,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending','leased','delivered','dead','conflict')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(network_id,binding_id,execution_id,allocation_id,child_id,expected_recovery_version),
      FOREIGN KEY (network_id,binding_id,execution_id,allocation_id,child_id)
        REFERENCES base_evidence_heads(network_id,binding_id,execution_id,allocation_id,child_id)
    );
    ${CCTP_RELAY_WORK_SCHEMA}
    CREATE INDEX IF NOT EXISTS idx_association_outbox_delivery
      ON association_outbox (status, available_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_association_outbox_child
      ON association_outbox (child_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_base_evidence_delivery
      ON base_evidence_outbox (delivery_status,available_at,lease_expires_at,id);
    CREATE INDEX IF NOT EXISTS idx_farm_intent_recovery_v2
      ON farm_intent_work_v2 (state,created_at,job_id);
    CREATE TRIGGER IF NOT EXISTS farm_intent_work_v2_immutable
      BEFORE UPDATE OF
        job_id,mandate_id,request_id,stellar_owner,kernel_address,binding_id,binding_hash,
        intent_digest,intent_json,expectation_digest,expectation_json,batch_idempotency_key,
        agent_index_batch_digest,agent_index_batch_json,created_at
      ON farm_intent_work_v2
      BEGIN
        SELECT RAISE(ABORT, 'immutable forward farm intent');
      END;
    CREATE TRIGGER IF NOT EXISTS base_evidence_outbox_immutable_update
      BEFORE UPDATE OF
        event_id,network_id,binding_id,execution_id,allocation_id,child_id,
        expected_recovery_version,resulting_recovery_version,phase,state,
        evidence_digest,report_json,created_at
      ON base_evidence_outbox
      BEGIN
        SELECT RAISE(ABORT, 'immutable Base evidence');
      END;
    CREATE TRIGGER IF NOT EXISTS base_evidence_outbox_immutable_delete
      BEFORE DELETE ON base_evidence_outbox
      BEGIN
        SELECT RAISE(ABORT, 'immutable Base evidence');
      END;
    ${MANDATE_V3_SCHEMA}
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  let enqueueAssociationInTransaction;
  let enqueueBaseEvidenceInTransaction;
  const associationOutbox = createAssociationOutbox(db, {
    maxAttempts: outboxMaxAttempts,
    now,
    registerTransactionEnqueue: (enqueue) => { enqueueAssociationInTransaction = enqueue; },
  });
  const baseEvidenceOutbox = createBaseEvidenceOutbox(db, {
    maxAttempts: outboxMaxAttempts,
    now,
    registerTransactionEnqueue: (enqueue) => { enqueueBaseEvidenceInTransaction = enqueue; },
  });

  const store = {
    get(execId) {
      const row = db.prepare('SELECT record FROM relay_records WHERE exec_id = ?').get(execId);
      return row ? JSON.parse(row.record) : null;
    },
    set(execId, record) {
      const rec = { ...record, updatedAt: now() };
      db.prepare('INSERT INTO relay_records (exec_id, record) VALUES (?, ?) ON CONFLICT(exec_id) DO UPDATE SET record = excluded.record')
        .run(execId, JSON.stringify(rec));
      return rec;
    },
    has(execId) {
      return !!db.prepare('SELECT 1 FROM relay_records WHERE exec_id = ?').get(execId);
    },
    all() {
      const rows = db.prepare('SELECT exec_id, record FROM relay_records').all();
      return Object.fromEntries(rows.map((r) => [r.exec_id, JSON.parse(r.record)]));
    },
  };

  const jobs = {
    get(jobId) {
      const row = db.prepare('SELECT job FROM jobs WHERE job_id = ?').get(jobId);
      return row ? JSON.parse(row.job) : undefined;
    },
    set(jobId, job) {
      db.prepare('INSERT INTO jobs (job_id, job) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET job = excluded.job')
        .run(jobId, JSON.stringify(job));
    },
  };

  function writeJob(jobId, job) {
    db.prepare('INSERT INTO jobs (job_id, job) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET job = excluded.job')
      .run(jobId, JSON.stringify(job));
  }

  function workRecord(row) {
    if (!row) return null;
    return {
      jobId: row.job_id,
      burnTxHash: row.burn_tx_hash,
      status: row.status,
      attempts: row.attempts,
      leaseToken: row.lease_token ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
    };
  }

  const COMMIT_EXPIRY_CLEANUP = Symbol('commitExpiryCleanup');

  function transaction(fn) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = fn();
      db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun && error?.[COMMIT_EXPIRY_CLEANUP]) {
        try {
          db.exec('COMMIT');
          begun = false;
        } catch (commitError) {
          if (begun) db.exec('ROLLBACK');
          throw commitError;
        }
        throw error;
      }
      if (begun) db.exec('ROLLBACK');
      if (/SQLITE_BUSY|database is locked/i.test(String(error?.message || ''))) {
        throw new Error('mandate store transaction is temporarily unavailable');
      }
      throw error;
    }
  }

  function checkedWork(jobId, status, token) {
    const row = db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId);
    if (!row || row.status !== status || (token != null && row.lease_token !== token)) {
      throw new Error('farm execution lease is stale or uncertain');
    }
    return row;
  }

  function farmIntentRecord(row) {
    if (!row) return null;
    return {
      jobId: row.job_id,
      mandateId: row.mandate_id,
      requestId: row.request_id,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      bindingId: row.binding_id,
      bindingHash: row.binding_hash,
      intentDigest: row.intent_digest,
      intent: JSON.parse(row.intent_json),
      expectationDigest: row.expectation_digest,
      expectation: JSON.parse(row.expectation_json),
      batchIdempotencyKey: row.batch_idempotency_key,
      batchDigest: row.agent_index_batch_digest,
      batch: JSON.parse(row.agent_index_batch_json),
      state: row.state,
      burnTxHash: row.burn_tx_hash ?? null,
      relayExecId: row.relay_exec_id ?? null,
      acknowledgement: row.ack_json ? JSON.parse(row.ack_json) : null,
      reasonCode: row.reason_code ?? null,
      intentAttempts: row.intent_attempts,
      leaseKind: row.lease_kind ?? null,
      leaseToken: row.lease_token ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const farmIntents = {
    createOrGetIntent({ normalizedIntent, now: atValue = now() }) {
      return transaction(() => {
        const intent = normalizedIntent?.intent;
        const existing = db.prepare(
          'SELECT * FROM farm_intent_work_v2 WHERE mandate_id = ? AND request_id = ?',
        ).get(intent?.mandate?.mandateId, intent?.requestId);
        if (existing) {
          const storedBatch = JSON.parse(existing.agent_index_batch_json);
          const compared = (existing.job_id !== intent.jobId
              || storedBatch.children[0]?.lifecycle?.observedAt !== normalizedIntent.batch.children[0]?.lifecycle?.observedAt)
            && typeof normalizedIntent.rebuild === 'function'
            ? normalizedIntent.rebuild({
              jobId: existing.job_id,
              observedAt: storedBatch.children[0]?.lifecycle?.observedAt,
            })
            : normalizedIntent;
          const exact = existing.job_id === compared.intent.jobId
            && existing.intent_digest === compared.intentDigest
            && existing.expectation_digest === compared.expectationDigest
            && existing.batch_idempotency_key === compared.batchIdempotencyKey
            && existing.agent_index_batch_digest === compared.batchDigest
            && existing.intent_json === JSON.stringify(compared.intent)
            && existing.expectation_json === JSON.stringify(compared.expectation)
            && existing.agent_index_batch_json === JSON.stringify(compared.batch);
          if (!exact) {
            const error = new Error('immutable forward farm intent conflict');
            error.code = 'FARM_INTENT_CONFLICT';
            throw error;
          }
          return { created: false, record: farmIntentRecord(existing) };
        }
        db.prepare(`
          INSERT INTO farm_intent_work_v2 (
            job_id,mandate_id,request_id,stellar_owner,kernel_address,binding_id,binding_hash,
            intent_digest,intent_json,expectation_digest,expectation_json,batch_idempotency_key,
            agent_index_batch_digest,agent_index_batch_json,state,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'intent_pending',?,?)
        `).run(
          intent.jobId, intent.mandate.mandateId, intent.requestId,
          intent.mandate.stellarOwner, intent.mandate.kernelAddress,
          intent.mandate.bindingId, intent.mandate.bindingHash,
          normalizedIntent.intentDigest, JSON.stringify(intent),
          normalizedIntent.expectationDigest, JSON.stringify(normalizedIntent.expectation),
          normalizedIntent.batchIdempotencyKey, normalizedIntent.batchDigest,
          JSON.stringify(normalizedIntent.batch), atValue, atValue,
        );
        writeJob(intent.jobId, {
          jobId: intent.jobId,
          requestId: intent.requestId,
          status: 'intent_pending',
          runId: intent.run.runId,
          allocations: intent.allocations.map(({ ordinal, allocationId, executionId, childId }) => ({
            ordinal, allocationId, executionId, childId,
          })),
        });
        return {
          created: true,
          record: farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id = ?').get(intent.jobId)),
        };
      });
    },
    getByJob({ mandateId, jobId }) {
      return farmIntentRecord(db.prepare(
        'SELECT * FROM farm_intent_work_v2 WHERE mandate_id = ? AND job_id = ?',
      ).get(mandateId, jobId));
    },
    getByRequest({ mandateId, requestId }) {
      return farmIntentRecord(db.prepare(
        'SELECT * FROM farm_intent_work_v2 WHERE mandate_id = ? AND request_id = ?',
      ).get(mandateId, requestId));
    },
    claimIntentDelivery({ jobId, now: atValue = now(), leaseMs = 30_000 }) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('farm intent lease is invalid');
      return transaction(() => {
        const token = leaseToken();
        const row = db.prepare(`
          UPDATE farm_intent_work_v2
          SET lease_kind='intent_delivery',lease_token=?,lease_expires_at=?,
              intent_attempts=intent_attempts+1,updated_at=?
          WHERE job_id=? AND state='intent_pending'
            AND (lease_token IS NULL OR lease_expires_at<=?)
          RETURNING *
        `).get(token, atValue + leaseMs, atValue, jobId, atValue);
        return farmIntentRecord(row);
      });
    },
    renewIntentDelivery({ jobId, leaseToken: token, now: atValue = now(), leaseMs = 30_000 }) {
      const changed = db.prepare(`
        UPDATE farm_intent_work_v2 SET lease_expires_at=?,updated_at=?
        WHERE job_id=? AND state='intent_pending' AND lease_kind='intent_delivery'
          AND lease_token=? AND lease_expires_at>?
      `).run(atValue + leaseMs, atValue, jobId, token, atValue);
      if (changed.changes !== 1) throw new Error('farm intent delivery lease is stale');
      return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(jobId));
    },
    releaseIntentDelivery({ jobId, leaseToken: token, now: atValue = now() }) {
      const changed = db.prepare(`
        UPDATE farm_intent_work_v2 SET lease_kind=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE job_id=? AND state='intent_pending' AND lease_kind='intent_delivery' AND lease_token=?
      `).run(atValue, jobId, token);
      if (changed.changes !== 1) throw new Error('farm intent delivery lease is stale');
      return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(jobId));
    },
    finishAwaitingBurn({ jobId, leaseToken: token, acknowledgement, now: atValue = now() }) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(jobId);
        if (!row) throw new Error('forward farm intent is missing');
        const ackJson = JSON.stringify(acknowledgement);
        const ackDigest = createHash('sha256').update(ackJson).digest('hex');
        if (row.state === 'awaiting_burn') {
          if (row.ack_digest !== ackDigest || row.ack_json !== ackJson) {
            throw new Error('immutable Agent Index acknowledgement conflict');
          }
          return farmIntentRecord(row);
        }
        if (row.state !== 'intent_pending' || row.lease_kind !== 'intent_delivery'
            || row.lease_token !== token || row.lease_expires_at <= atValue) {
          throw new Error('farm intent delivery lease is stale');
        }
        const batch = JSON.parse(row.agent_index_batch_json);
        const expectedIdentities = batch.children.map((child) => ({
          networkId: child.networkId,
          bindingId: child.bindingId,
          executionId: child.executionId,
          allocationId: child.allocationId,
          childId: child.childId,
        }));
        const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
        const ackKeys = ['acknowledged', 'schemaVersion', 'idempotencyKey', 'requestDigest', 'children', 'written', 'duplicates'];
        const childKeys = ['identity', 'recoveryVersion'];
        const identityKeys = ['networkId', 'bindingId', 'executionId', 'allocationId', 'childId'];
        const valid = exactKeys(acknowledgement, ackKeys)
          && acknowledgement.acknowledged === true
          && acknowledgement.schemaVersion === 1
          && acknowledgement.idempotencyKey === row.batch_idempotency_key
          && acknowledgement.requestDigest === row.agent_index_batch_digest
          && Number.isSafeInteger(acknowledgement.written)
          && Number.isSafeInteger(acknowledgement.duplicates)
          && Array.isArray(acknowledgement.children)
          && acknowledgement.children.length === expectedIdentities.length
          && acknowledgement.children.every((child, index) => exactKeys(child, childKeys)
            && exactKeys(child.identity, identityKeys)
            && identityKeys.every((key) => child.identity[key] === expectedIdentities[index][key])
            && Number.isSafeInteger(child.recoveryVersion) && child.recoveryVersion >= 0);
        if (!valid) throw new Error('Agent Index batch acknowledgement is malformed');
        acknowledgement.children.forEach((child) => {
          baseEvidenceOutbox.seed(child.identity, child.recoveryVersion, { jobId });
        });
        const changed = db.prepare(`
          UPDATE farm_intent_work_v2
          SET state='awaiting_burn',ack_digest=?,ack_json=?,lease_kind=NULL,lease_token=NULL,
              lease_expires_at=NULL,updated_at=?
          WHERE job_id=? AND state='intent_pending' AND lease_token=? AND lease_expires_at>?
        `).run(ackDigest, ackJson, atValue, jobId, token, atValue);
        if (changed.changes !== 1) throw new Error('farm intent acknowledgement CAS conflict');
        const job = jobs.get(jobId) ?? { jobId };
        writeJob(jobId, { ...job, status: 'awaiting_burn' });
        return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(jobId));
      });
    },
    attachBurnAtomic({ identity, burnTxHash, now: atValue = now() }) {
      if (!/^[0-9a-f]{64}$/.test(burnTxHash || '')) {
        throw new Error('burn transaction hash must be 64 lowercase hex');
      }
      return transaction(() => {
        const row = db.prepare(`
          SELECT * FROM farm_intent_work_v2
          WHERE mandate_id=? AND job_id=? AND binding_id=? AND intent_digest=?
        `).get(identity?.mandateId, identity?.jobId, identity?.bindingId, identity?.intentDigest);
        if (!row) throw new Error('forward farm attachment identity conflict');
        if (row.burn_tx_hash !== null || row.relay_exec_id !== null) {
          if (row.burn_tx_hash !== burnTxHash) throw new Error('forward farm already has a different burn hash');
          if (!row.relay_exec_id || !cctpGet(row.relay_exec_id)) {
            throw new Error('forward farm burn attachment is incomplete');
          }
          return { duplicate: true, record: farmIntentRecord(row) };
        }
        if (row.state !== 'awaiting_burn' || !row.ack_digest || !row.ack_json) {
          throw new Error('forward farm is not burn-ready');
        }
        const owner = db.prepare(
          'SELECT job_id FROM farm_intent_work_v2 WHERE burn_tx_hash=? AND job_id<>?',
        ).get(burnTxHash, row.job_id);
        if (owner) throw new Error('burn hash belongs to a different forward farm');
        const intent = JSON.parse(row.intent_json);
        const expectation = JSON.parse(row.expectation_json);
        const batch = JSON.parse(row.agent_index_batch_json);
        const relayExecId = `forward-farm:${row.job_id}`;
        const decision = relayEnqueueDecision({
          existing: cctpGet(relayExecId),
          hasBurnOwner: (hash) => Boolean(db.prepare(
            'SELECT 1 FROM cctp_relay_work WHERE burn_tx_hash=? AND exec_id<>?',
          ).get(hash, relayExecId)),
          execId: relayExecId,
          sourceDomain: expectation.sourceDomain,
          burnTxHash,
          expectation,
          now: atValue,
        });
        if (!decision.changed) throw new Error('unexpected preexisting CCTP relay work');
        db.prepare(`
          INSERT INTO cctp_relay_work (
            exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
            message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
            evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(decision.record.execId, ...cctpBind(decision.record));
        farmIntentFault('relay_insert');

        const evidence = {
          burnTxHash,
          expectationDigest: row.expectation_digest,
          burnUnits7: expectation.burnUnits7,
        };
        batch.children.forEach((child) => {
          const identityWithOwner = {
            networkId: child.networkId,
            owner: child.owner,
            bindingId: child.bindingId,
            executionId: child.executionId,
            allocationId: child.allocationId,
            childId: child.childId,
          };
          enqueueAssociationInTransaction({
            identity: identityWithOwner,
            expectedSequence: 0,
            lifecycle: { sequence: 1, status: 'submitted', evidence, observedAt: atValue },
          });
          enqueueBaseEvidenceInTransaction({
            identity: {
              networkId: child.networkId,
              bindingId: child.bindingId,
              executionId: child.executionId,
              allocationId: child.allocationId,
              childId: child.childId,
            },
            phase: 'cctp_burn',
            status: 'submitted',
            evidence,
            observedAt: atValue,
          });
          farmIntentFault('child_event');
        });
        farmIntentFault('outbox');
        const changed = db.prepare(`
          UPDATE farm_intent_work_v2
          SET state='relay_pending',burn_tx_hash=?,relay_exec_id=?,updated_at=?
          WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=?
            AND state='awaiting_burn' AND burn_tx_hash IS NULL AND relay_exec_id IS NULL
        `).run(
          burnTxHash, relayExecId, atValue, row.job_id, row.mandate_id,
          row.binding_id, row.intent_digest,
        );
        if (changed.changes !== 1) throw new Error('forward farm attachment CAS conflict');
        farmIntentFault('farm_cas');
        const publicJob = jobs.get(row.job_id) ?? { jobId: row.job_id };
        writeJob(row.job_id, { ...publicJob, status: 'relay_pending' });
        farmIntentFault('job_projection');
        return {
          duplicate: false,
          record: farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(row.job_id)),
        };
      });
    },
    projectMintEvidenceAtomic({ identity, relay, now: atValue = now() }) {
      return transaction(() => {
        const row = db.prepare(`
          SELECT * FROM farm_intent_work_v2
          WHERE mandate_id=? AND job_id=? AND binding_id=? AND intent_digest=?
        `).get(identity?.mandateId, identity?.jobId, identity?.bindingId, identity?.intentDigest);
        if (!row || !['relay_pending', 'deposit_pending'].includes(row.state)) {
          throw new Error('forward farm is not relay-recoverable');
        }
        if (!relay || relay.state !== 'minted' || relay.execId !== row.relay_exec_id
            || relay.burnTxHash !== row.burn_tx_hash
            || relay.expectationDigest !== row.expectation_digest) {
          throw new Error('confirmed CCTP evidence conflicts with forward farm intent');
        }
        const expectation = JSON.parse(row.expectation_json);
        const batch = JSON.parse(row.agent_index_batch_json);
        const burnEvidence = {
          burnTxHash: relay.burnTxHash,
          expectationDigest: relay.expectationDigest,
          burnUnits7: expectation.burnUnits7,
        };
        const attestationEvidence = {
          burnTxHash: relay.burnTxHash,
          expectationDigest: relay.expectationDigest,
          messageDigest: relay.messageDigest,
          attestationDigest: relay.attestationDigest,
          evidenceVersion: relay.evidenceVersion,
        };
        const mintEvidence = { ...attestationEvidence, mintTxHash: relay.mintTxHash };
        for (const child of batch.children) {
          const childIdentity = {
            networkId: child.networkId,
            bindingId: child.bindingId,
            executionId: child.executionId,
            allocationId: child.allocationId,
            childId: child.childId,
          };
          enqueueBaseEvidenceInTransaction({
            identity: childIdentity, phase: 'cctp_burn', status: 'confirmed',
            evidence: burnEvidence, observedAt: atValue,
          });
          enqueueBaseEvidenceInTransaction({
            identity: childIdentity, phase: 'cctp_attestation', status: 'confirmed',
            evidence: attestationEvidence, observedAt: atValue,
          });
          enqueueBaseEvidenceInTransaction({
            identity: childIdentity, phase: 'cctp_mint', status: 'confirmed',
            evidence: mintEvidence, observedAt: atValue,
          });
        }
        if (row.state === 'relay_pending') {
          const changed = db.prepare(`
            UPDATE farm_intent_work_v2 SET state='deposit_pending',updated_at=?
            WHERE job_id=? AND state='relay_pending' AND relay_exec_id=?
          `).run(atValue, row.job_id, row.relay_exec_id);
          if (changed.changes !== 1) throw new Error('forward farm mint projection CAS conflict');
          const publicJob = jobs.get(row.job_id) ?? { jobId: row.job_id };
          writeJob(row.job_id, { ...publicJob, status: 'deposit_pending' });
        }
        return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(row.job_id));
      });
    },
    quarantineLegacyActive({ now: atValue = now(), limit = 100 } = {}) {
      if (!Number.isSafeInteger(atValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('legacy farm quarantine limit is invalid');
      }
      return transaction(() => {
        const rows = db.prepare(`SELECT job_id,status FROM farm_execution_work
          WHERE status IN ('pending','running','done') ORDER BY created_at,job_id LIMIT ?`).all(limit);
        const quarantined = [];
        for (const row of rows) {
          if (row.status === 'done') {
            writeJob(row.job_id, { jobId: row.job_id, status: 'done' });
            continue;
          }
          const changed = db.prepare(`UPDATE farm_execution_work
            SET status='uncertain',lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE job_id=? AND status IN ('pending','running')`).run(atValue, row.job_id);
          if (changed.changes === 1) {
            writeJob(row.job_id, {
              jobId: row.job_id,
              status: 'uncertain',
              reasonCode: 'legacy_record_unrecoverable',
            });
            quarantined.push(row.job_id);
          }
        }
        return quarantined;
      });
    },
    blockEvidenceConflict(
      { identity, now: blockedAt = now() },
      { transaction: ownTransaction = true } = {},
    ) {
      const apply = () => {
        const head = db.prepare(`SELECT job_id FROM base_evidence_heads
          WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?`)
          .get(
            identity.networkId, identity.bindingId, identity.executionId,
            identity.allocationId, identity.childId,
          );
        if (!head?.job_id) throw new Error('Base evidence conflict has no owning farm job');
        const row = db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(head.job_id);
        if (!row) throw new Error('Base evidence conflict has no owning v2 farm intent');
        if (row.state !== 'blocked') {
          const changed = db.prepare(`UPDATE farm_intent_work_v2
            SET state='blocked',reason_code='base_evidence_conflict',lease_kind=NULL,
              lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE job_id=? AND state NOT IN ('done','blocked','uncertain')`)
            .run(blockedAt, row.job_id);
          if (changed.changes !== 1) throw new Error('Base evidence conflict owning farm is terminal');
          const publicJob = jobs.get(row.job_id) ?? { jobId: row.job_id };
          writeJob(row.job_id, {
            ...publicJob, status: 'blocked', reasonCode: 'base_evidence_conflict',
          });
        }
        return { jobId: row.job_id, status: 'blocked' };
      };
      return ownTransaction ? transaction(apply) : apply();
    },
    reconcileExpired({ now: atValue = now(), limit = 100 } = {}) {
      if (!Number.isSafeInteger(atValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('farm intent recovery limit is invalid');
      }
      return transaction(() => {
        const rows = db.prepare(`
          SELECT job_id FROM farm_intent_work_v2
          WHERE state='intent_pending' AND lease_kind='intent_delivery' AND lease_expires_at<=?
          ORDER BY created_at,job_id LIMIT ?
        `).all(atValue, limit);
        for (const row of rows) {
          db.prepare(`
            UPDATE farm_intent_work_v2
            SET lease_kind=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE job_id=? AND state='intent_pending' AND lease_expires_at<=?
          `).run(atValue, row.job_id, atValue);
        }
        return rows.map(({ job_id: jobId }) => farmIntentRecord(
          db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(jobId),
        ));
      });
    },
    listRecoverable({ now: atValue = now(), limit = 100 } = {}) {
      if (!Number.isSafeInteger(atValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('farm intent recovery limit is invalid');
      }
      return db.prepare(`
        SELECT * FROM farm_intent_work_v2
        WHERE state IN ('intent_pending','relay_pending','deposit_pending','deposit_confirming')
          AND (state<>'intent_pending' OR lease_token IS NULL OR lease_expires_at<=?)
        ORDER BY created_at,job_id LIMIT ?
      `).all(atValue, limit).map(farmIntentRecord);
    },
    advanceProjection({ identity, from, to, reasonCode = null, now: atValue = now() }) {
      const allowed = new Set([
        'intent_pending', 'awaiting_burn', 'relay_pending', 'deposit_pending',
        'deposit_confirming', 'done', 'blocked', 'uncertain',
      ]);
      if (!allowed.has(from) || !allowed.has(to)) throw new Error('farm projection state is invalid');
      return transaction(() => {
        const changed = db.prepare(`
          UPDATE farm_intent_work_v2 SET state=?,reason_code=?,lease_kind=NULL,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
          WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=? AND state=?
        `).run(
          to, reasonCode, atValue, identity.jobId, identity.mandateId,
          identity.bindingId, identity.intentDigest, from,
        );
        if (changed.changes !== 1) throw new Error('farm projection CAS conflict');
        const publicJob = jobs.get(identity.jobId) ?? { jobId: identity.jobId };
        writeJob(identity.jobId, { ...publicJob, status: to, ...(reasonCode ? { reasonCode } : {}) });
        return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(identity.jobId));
      });
    },
  };

  const farmExecutions = {
    prepare({ jobId, job, evidenceHeads }) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM jobs WHERE job_id=?').get(jobId)) {
          throw new Error('farm intent job already exists');
        }
        for (const head of evidenceHeads) {
          baseEvidenceOutbox.seed(head.identity, head.recoveryVersion, { jobId });
        }
        writeJob(jobId, job);
        return { jobId, evidenceHeads: evidenceHeads.length };
      });
    },
    blockEvidenceConflict({ identity, now: blockedAt = now() }, { transaction: ownTransaction = true } = {}) {
      const apply = () => {
        const row = db.prepare(`
          SELECT job_id FROM base_evidence_heads
          WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
        `).get(
          identity.networkId, identity.bindingId, identity.executionId,
          identity.allocationId, identity.childId,
        );
        if (!row?.job_id) throw new Error('Base evidence conflict has no owning farm job');
        const jobRow = db.prepare('SELECT job FROM jobs WHERE job_id=?').get(row.job_id);
        if (!jobRow) throw new Error('Base evidence conflict owning job is missing');
        const job = JSON.parse(jobRow.job);
        writeJob(row.job_id, {
          ...job,
          status: 'blocked',
          evidenceConflict: true,
        });
        db.prepare(`
          UPDATE farm_execution_work
          SET status='uncertain',lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE job_id=? AND status<>'uncertain'
        `).run(blockedAt, row.job_id);
        return { jobId: row.job_id, status: 'uncertain' };
      };
      return ownTransaction ? transaction(apply) : apply();
    },
    get(jobId) {
      return workRecord(db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId));
    },
    attach({ jobId, burnTxHash, job, reports, evidenceHeads = [] }) {
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId);
        if (existing) {
          if (existing.burn_tx_hash !== burnTxHash) {
            throw new Error('farm execution already has a different burn hash');
          }
          return { duplicate: true, work: workRecord(existing) };
        }
        const burnOwner = db.prepare('SELECT job_id FROM farm_execution_work WHERE burn_tx_hash = ?').get(burnTxHash);
        if (burnOwner && burnOwner.job_id !== jobId) {
          throw new Error('burn hash is already attached to another farm execution');
        }
        if (!db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(jobId)) {
          throw new Error('farm execution job is missing');
        }
        enqueueAssociationInTransaction(reports);
        for (const head of evidenceHeads) {
          baseEvidenceOutbox.seed(head.identity, head.recoveryVersion, { jobId });
        }
        writeJob(jobId, job);
        const timestamp = now();
        db.prepare(`
          INSERT INTO farm_execution_work
            (job_id, burn_tx_hash, status, attempts, lease_token, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, NULL, NULL, ?, ?)
        `).run(jobId, burnTxHash, timestamp, timestamp);
        return {
          duplicate: false,
          work: workRecord(db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId)),
        };
      });
    },
    claim({ jobId, now: claimNow = now(), leaseMs = 30_000 }) {
      if (!Number.isSafeInteger(claimNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error('farm execution lease requires safe integer time and positive duration');
      }
      const token = randomUUID();
      return workRecord(db.prepare(`
        UPDATE farm_execution_work
        SET status = 'running', attempts = attempts + 1, lease_token = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'pending'
        RETURNING *
      `).get(token, claimNow + leaseMs, claimNow, jobId));
    },
    renew({ jobId, leaseToken, now: renewNow = now(), leaseMs = 30_000 }) {
      if (!jobId || !leaseToken) {
        throw new Error('farm execution renewal requires jobId and leaseToken');
      }
      if (!Number.isSafeInteger(renewNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error('farm execution lease requires safe integer time and positive duration');
      }
      const result = db.prepare(`
        UPDATE farm_execution_work
        SET lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running' AND lease_token = ?
      `).run(renewNow + leaseMs, renewNow, jobId, leaseToken);
      if (result.changes !== 1) {
        throw new Error('farm execution lease is stale or uncertain');
      }
      return this.get(jobId);
    },
    listRecoverable({ now: recoveryNow = now() } = {}) {
      return db.prepare(`
        SELECT * FROM farm_execution_work
        WHERE status = 'pending'
           OR (status = 'running' AND lease_expires_at <= ?)
        ORDER BY created_at ASC, job_id ASC
      `).all(recoveryNow).map(workRecord);
    },
    checkpoint({
      jobId, leaseToken, job, reports = [], baseEvidenceReports = [],
      now: checkpointNow = now(),
    }) {
      return transaction(() => {
        checkedWork(jobId, 'running', leaseToken);
        if (reports.length > 0) enqueueAssociationInTransaction(reports);
        if (baseEvidenceReports.length > 0) {
          enqueueBaseEvidenceInTransaction(baseEvidenceReports[0]);
          for (const report of baseEvidenceReports.slice(1)) {
            enqueueBaseEvidenceInTransaction(report);
          }
        }
        writeJob(jobId, job);
        db.prepare('UPDATE farm_execution_work SET updated_at = ? WHERE job_id = ?')
          .run(checkpointNow, jobId);
        return this.get(jobId);
      });
    },
    finish({
      jobId, leaseToken, job, reports = [], baseEvidenceReports = [],
      status = 'done', now: finishNow = now(),
    }) {
      if (!['done', 'uncertain'].includes(status)) throw new Error('invalid farm execution terminal status');
      return transaction(() => {
        checkedWork(jobId, 'running', leaseToken);
        if (reports.length > 0) enqueueAssociationInTransaction(reports);
        for (const report of baseEvidenceReports) {
          enqueueBaseEvidenceInTransaction(report);
        }
        writeJob(jobId, job);
        db.prepare(`
          UPDATE farm_execution_work
          SET status = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(status, finishNow, jobId);
        return this.get(jobId);
      });
    },
    reconcileUncertain({ jobId, job, reports = [], now: reconcileNow = now() }) {
      return transaction(() => {
        const row = checkedWork(jobId, 'running');
        if (row.lease_expires_at == null || row.lease_expires_at > reconcileNow) {
          throw new Error('farm execution lease has not expired');
        }
        if (reports.length > 0) enqueueAssociationInTransaction(reports);
        writeJob(jobId, job);
        db.prepare(`
          UPDATE farm_execution_work
          SET status = 'uncertain', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(reconcileNow, jobId);
        return this.get(jobId);
      });
    },
  };

  function requireSessionKeyCipher() {
    if (typeof sessionKeyCipher?.seal !== 'function' || typeof sessionKeyCipher?.open !== 'function') {
      throw new Error('session key cipher is required for mandate persistence');
    }
    return sessionKeyCipher;
  }

  function normalizeMandate(record) {
    if (!record || typeof record.mandateId !== 'string' || !record.mandateId) {
      throw new Error('mandate ID is required');
    }
    if (!DIGEST_RE.test(record.capabilityHash || '')) {
      throw new Error('capability hash is required');
    }
    if (!DIGEST_RE.test(record.policyDigest || '')) {
      throw new Error('policy digest is required and must be canonical');
    }
    if (!DIGEST_RE.test(record.approvalDigest || '')
      || !DIGEST_RE.test(record.bindingHash || '')) {
      throw new Error('mandate digest fields are invalid');
    }
    if (!Number.isSafeInteger(record.validUntilSeconds) || record.validUntilSeconds <= 0) {
      throw new Error('mandate expiry is invalid');
    }
    if (typeof record.sessionPrivateKey !== 'string' || !record.sessionPrivateKey
      || typeof record.sessionKeyAddress !== 'string' || !record.sessionKeyAddress
      || typeof record.stellarOwner !== 'string' || !record.stellarOwner
      || typeof record.kernelAddress !== 'string' || !record.kernelAddress) {
      throw new Error('mandate identity or session authority is invalid');
    }
    return {
      ...record,
      kernelAddress: record.kernelAddress.toLowerCase(),
      sessionKeyAddress: record.sessionKeyAddress.toLowerCase(),
      relayerOrigin: record.relayerOrigin ?? null,
      bindingId: record.bindingId ?? null,
      permissionId: record.permissionId ?? null,
      sessionKeyDigest: createHash('sha256').update(record.sessionPrivateKey).digest('hex'),
      status: 'pending_activation',
    };
  }

  function mandateRow(mandateId) {
    return db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?').get(mandateId);
  }

  function mandateAuthorityRow(mandateId) {
    return db.prepare(`
      SELECT mandate_id, stellar_owner, kernel_address, relayer_origin,
             valid_until_seconds, status, binding_id, binding_hash, capability_hash
      FROM mandates_v3 WHERE mandate_id = ?
    `).get(mandateId);
  }

  function identityRow({ mandateId, stellarOwner, kernelAddress }) {
    return db.prepare(`
      SELECT * FROM mandates_v3
      WHERE mandate_id = ? AND stellar_owner = ? AND kernel_address = ?
    `).get(mandateId, stellarOwner, String(kernelAddress || '').toLowerCase());
  }

  function rowAad(row) {
    return mandateSessionAad({
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      policyDigest: row.policy_digest ?? null,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address,
      validUntilSeconds: row.valid_until_seconds,
      bindingId: row.binding_id,
    });
  }

  function publicMandate(row, status = row?.status) {
    if (!row) return { status: 'missing' };
    return {
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      policyDigest: row.policy_digest ?? null,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address ?? null,
      relayerOrigin: row.relayer_origin ?? null,
      validUntilSeconds: row.valid_until_seconds ?? null,
      status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
      permissionId: row.permission_id ?? null,
      activationUserOpHash: row.activation_user_op_hash ?? null,
      activationTxHash: row.activation_tx_hash ?? null,
      activatedAt: row.activated_at ?? null,
      quarantineReason: row.quarantine_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function internalMandate(row) {
    if (!row) return null;
    const result = {
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      policyDigest: row.policy_digest ?? null,
      serializedApproval: row.serialized_approval ?? undefined,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address ?? null,
      relayerOrigin: row.relayer_origin ?? null,
      validUntilSeconds: row.valid_until_seconds ?? null,
      status: row.status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
      permissionId: row.permission_id ?? null,
      activationUserOpHash: row.activation_user_op_hash ?? null,
      activationTxHash: row.activation_tx_hash ?? null,
      activatedAt: row.activated_at ?? null,
      quarantineReason: row.quarantine_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.capability_hash) {
      Object.defineProperty(result, 'capabilityHash', {
        value: row.capability_hash,
        enumerable: false,
      });
    }
    return result;
  }

  function internalMandateAuthority(row, status = row?.status) {
    if (!row) return null;
    const result = {
      mandateId: row.mandate_id,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      relayerOrigin: row.relayer_origin ?? null,
      validUntilSeconds: row.valid_until_seconds ?? null,
      status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
    };
    if (row.capability_hash) {
      Object.defineProperty(result, 'capabilityHash', {
        value: row.capability_hash,
        enumerable: false,
      });
    }
    return result;
  }

  function activationWork(row) {
    if (!row) return null;
    return {
      mandateId: row.mandate_id,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      status: row.status,
      attempts: row.attempts,
      leaseToken: row.lease_token ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      userOpHash: row.user_op_hash ?? null,
      txHash: row.tx_hash ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function activationRow(identity) {
    if (!identityRow(identity)) return null;
    return db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
      .get(identity.mandateId);
  }

  function safeNow(value) {
    const result = value ?? nowSeconds();
    if (!Number.isSafeInteger(result)) throw new Error('activation time is invalid');
    return result;
  }

  function assertLive(row, at) {
    if (!Number.isSafeInteger(row.valid_until_seconds) || at >= row.valid_until_seconds) {
      cleanupExpiredLocked(row, at);
      const error = new Error('mandate expiry has been reached');
      error[COMMIT_EXPIRY_CLEANUP] = true;
      throw error;
    }
  }

  function assertLease(row, token, at) {
    if (!row?.lease_token || row.lease_token !== token) throw new Error('stale activation lease token');
    if (!Number.isSafeInteger(row.lease_expires_at) || at >= row.lease_expires_at) {
      throw new Error('activation lease has expired');
    }
  }

  function conflict(existingRow, incoming) {
    const existing = {
      approvalDigest: existingRow.approval_digest,
      policyDigest: existingRow.policy_digest,
      serializedApproval: existingRow.serialized_approval,
      sessionKeyDigest: existingRow.session_key_digest,
      sessionKeyAddress: existingRow.session_key_address,
      capabilityHash: existingRow.capability_hash,
      stellarOwner: existingRow.stellar_owner,
      kernelAddress: existingRow.kernel_address,
      relayerOrigin: existingRow.relayer_origin,
      validUntilSeconds: existingRow.valid_until_seconds,
      bindingId: existingRow.binding_id,
      bindingHash: existingRow.binding_hash,
      permissionId: existingRow.permission_id,
    };
    return V3_IMMUTABLE_FIELDS.some((field) => existing[field] !== incoming[field]);
  }

  function cleanupExpiredLocked(row, at) {
    if (!row || !Number.isSafeInteger(row.valid_until_seconds)
      || at < row.valid_until_seconds) return row;
    const work = db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
      .get(row.mandate_id);
    if (work?.status === 'pending' || work?.status === 'running') {
      db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?').run(row.mandate_id);
    } else if (work?.status === 'submitting' || work?.status === 'submitted') {
      db.prepare(`
        UPDATE mandate_activation_work
        SET status = 'uncertain', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE mandate_id = ?
      `).run(at, row.mandate_id);
      db.prepare(`
        UPDATE mandates_v3 SET status = 'activation_uncertain' WHERE mandate_id = ?
      `).run(row.mandate_id);
    }
    db.prepare(`
      UPDATE mandates_v3 SET session_key_envelope = NULL, updated_at = ? WHERE mandate_id = ?
    `).run(at, row.mandate_id);
    return mandateRow(row.mandate_id);
  }

  function cleanupExpired(row, at) {
    if (!row || !Number.isSafeInteger(row.valid_until_seconds)
      || at < row.valid_until_seconds) return row;
    return transaction(() => cleanupExpiredLocked(mandateRow(row.mandate_id), at));
  }

  function cleanupAllExpiredLocked(at) {
    const rows = db.prepare(`
      SELECT * FROM mandates_v3
      WHERE valid_until_seconds IS NOT NULL AND valid_until_seconds <= ?
    `).all(at);
    for (const row of rows) cleanupExpiredLocked(row, at);
  }

  function internalWithSession(identity, initialRow, at) {
    const row = cleanupExpired(initialRow, at);
    if (!row || row.status === 'revoked' || !row.session_key_envelope
      || at >= row.valid_until_seconds) return internalMandate(row);

    const cipher = requireSessionKeyCipher();
    const opened = cipher.open(row.session_key_envelope, rowAad(row));
    const checkedAt = safeNow();
    if (checkedAt >= row.valid_until_seconds) {
      return internalMandate(cleanupExpired(identityRow(identity), checkedAt));
    }
    const replacement = opened.needsRotation
      ? cipher.seal(opened.plaintext, rowAad(row))
      : row.session_key_envelope;
    const update = opened.needsRotation
      ? db.prepare(`
          UPDATE mandates_v3 SET session_key_envelope = ?, updated_at = ?
          WHERE mandate_id = ? AND stellar_owner = ? AND kernel_address = ?
            AND session_key_envelope = ? AND status != 'revoked' AND valid_until_seconds > ?
        `).run(
          replacement, checkedAt, row.mandate_id, row.stellar_owner, row.kernel_address,
          row.session_key_envelope, checkedAt,
        )
      : db.prepare(`
          UPDATE mandates_v3 SET session_key_envelope = session_key_envelope
          WHERE mandate_id = ? AND stellar_owner = ? AND kernel_address = ?
            AND session_key_envelope = ? AND status != 'revoked' AND valid_until_seconds > ?
        `).run(
          row.mandate_id, row.stellar_owner, row.kernel_address,
          row.session_key_envelope, checkedAt,
        );
    const current = identityRow(identity);
    if (update.changes !== 1 || !current || current.status === 'revoked'
      || current.session_key_envelope !== replacement
      || checkedAt >= current.valid_until_seconds) {
      return internalMandate(cleanupExpired(current, checkedAt));
    }
    const result = internalMandate(current);
    Object.defineProperty(result, 'sessionPrivateKey', {
      value: opened.plaintext,
      enumerable: false,
    });
    return result;
  }

  let leaseCounter = 0;
  const mandatesV3 = {
    authority(mandateId) {
      let row = mandateAuthorityRow(mandateId);
      if (!row) return null;
      const at = safeNow();
      const expired = Number.isSafeInteger(row.valid_until_seconds) && at >= row.valid_until_seconds;
      if (expired) {
        cleanupExpired(row, at);
        row = mandateAuthorityRow(mandateId);
      }
      return internalMandateAuthority(row, expired ? 'expired' : row.status);
    },
    get(identity) {
      const row = identityRow(identity);
      if (!row) return null;
      const at = safeNow();
      return internalWithSession(identity, row, at);
    },
    status(identity) {
      let row = identityRow(identity);
      if (!row) return { status: 'missing' };
      const at = safeNow();
      const expired = Number.isSafeInteger(row.valid_until_seconds) && at >= row.valid_until_seconds;
      if (expired) row = cleanupExpired(row, at);
      const status = expired ? 'expired' : row.status;
      return publicMandate(row, status);
    },
    revoke(identity) {
      return transaction(() => {
        const row = identityRow(identity);
        if (!row) return null;
        const at = safeNow();
        const expired = Number.isSafeInteger(row.valid_until_seconds)
          && at >= row.valid_until_seconds;
        if (expired) {
          return publicMandate(cleanupExpiredLocked(row, at), 'expired');
        }
        db.prepare(`
          UPDATE mandates_v3
          SET status = 'revoked', session_key_envelope = NULL, updated_at = ?
          WHERE mandate_id = ?
        `).run(at, row.mandate_id);
        db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?').run(row.mandate_id);
        return publicMandate(mandateRow(row.mandate_id), 'revoked');
      });
    },
    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n;
    },
  };

  const mandateActivations = {
    enqueue({ record }) {
      const incoming = normalizeMandate(record);
      const envelope = requireSessionKeyCipher().seal(incoming.sessionPrivateKey, mandateSessionAad(incoming));
      return transaction(() => {
        const at = safeNow();
        let existing = mandateRow(incoming.mandateId);
        if (existing) {
          const expired = at >= existing.valid_until_seconds;
          if (expired) existing = cleanupExpiredLocked(existing, at);
          if (conflict(existing, incoming)) {
            const error = new Error('immutable mandate conflict');
            if (expired) error[COMMIT_EXPIRY_CLEANUP] = true;
            throw error;
          }
          return {
            duplicate: true,
            mandate: publicMandate(existing, expired ? 'expired' : existing.status),
            work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(incoming.mandateId)),
          };
        }
        if (at >= incoming.validUntilSeconds) throw new Error('mandate expiry has been reached');
        db.prepare(`
          INSERT INTO mandates_v3 (
            mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner, kernel_address,
            session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
            binding_hash, permission_id, session_key_envelope, session_key_digest, capability_hash,
            activation_user_op_hash, activation_tx_hash, activated_at, quarantine_reason,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_activation', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          incoming.mandateId, incoming.approvalDigest, incoming.policyDigest,
          incoming.serializedApproval,
          incoming.stellarOwner, incoming.kernelAddress, incoming.sessionKeyAddress,
          incoming.relayerOrigin ?? null, incoming.validUntilSeconds, incoming.bindingId ?? null,
          incoming.bindingHash ?? null, incoming.permissionId ?? null, envelope,
          incoming.sessionKeyDigest, incoming.capabilityHash, at, at,
        );
        db.prepare(`
          INSERT INTO mandate_activation_work (
            mandate_id, stellar_owner, kernel_address, status, attempts, lease_token,
            lease_expires_at, user_op_hash, tx_hash, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)
        `).run(incoming.mandateId, incoming.stellarOwner, incoming.kernelAddress, at, at);
        return {
          duplicate: false,
          mandate: publicMandate(mandateRow(incoming.mandateId)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(incoming.mandateId)),
        };
      });
    },
    get(identity) {
      let mandate = identityRow(identity);
      if (!mandate) return null;
      const at = safeNow();
      if (at >= mandate.valid_until_seconds) mandate = cleanupExpired(mandate, at);
      return activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
        .get(mandate.mandate_id));
    },
    claim({ nowSeconds: atValue, leaseSeconds = 30, ...identity }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        if (!mandate) return null;
        const at = safeNow(atValue);
        assertLive(mandate, at);
        if (mandate.status !== 'pending_activation') return null;
        if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
          throw new Error('activation lease duration is invalid');
        }
        leaseCounter += 1;
        const token = `${leaseToken()}-${leaseCounter}-${randomUUID()}`;
        const row = db.prepare(`
          UPDATE mandate_activation_work
          SET status = 'running', attempts = attempts + 1, lease_token = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE mandate_id = ? AND status = 'pending'
          RETURNING *
        `).get(
          token,
          Math.min(at + leaseSeconds, mandate.valid_until_seconds),
          at,
          mandate.mandate_id,
        );
        return activationWork(row);
      });
    },
    renew({ leaseToken: token, nowSeconds: atValue, leaseSeconds = 30, ...identity }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or missing activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (!['running', 'submitting', 'submitted'].includes(work.status)) {
          throw new Error('activation lease is terminal or not renewable');
        }
        if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
          throw new Error('activation lease duration is invalid');
        }
        const leaseExpiresAt = Math.min(at + leaseSeconds, mandate.valid_until_seconds);
        const updated = db.prepare(`
          UPDATE mandate_activation_work
          SET lease_expires_at = ?, updated_at = ?
          WHERE mandate_id = ? AND stellar_owner = ? AND kernel_address = ?
            AND lease_token = ? AND lease_expires_at > ?
            AND status IN ('running','submitting','submitted')
          RETURNING *
        `).get(
          leaseExpiresAt, at, mandate.mandate_id, mandate.stellar_owner,
          mandate.kernel_address, token, at,
        );
        if (!updated) throw new Error('stale activation lease token');
        return activationWork(updated);
      });
    },
    checkpoint({ leaseToken: token, status, userOpHash, nowSeconds: atValue, ...identity }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('activation work is missing');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (status === 'submitting') {
          if (work.status !== 'running') throw new Error('invalid activation transition');
        } else if (status === 'submitted') {
          if (work.status !== 'submitting') throw new Error('invalid activation transition to submitted');
          if (!HASH_RE.test(userOpHash || '')) throw new Error('submitted user operation hash is invalid');
        } else {
          throw new Error('invalid activation checkpoint state');
        }
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = ?, user_op_hash = CASE WHEN ? = 'submitted' THEN ? ELSE user_op_hash END,
              updated_at = ? WHERE mandate_id = ?
        `).run(status, status, userOpHash ?? null, at, mandate.mandate_id);
        return activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
          .get(mandate.mandate_id));
      });
    },
    finishActive({
      leaseToken: token, userOpHash, txHash, activatedAt, nowSeconds: atValue, ...identity
    }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or terminal activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (work.status !== 'submitted') throw new Error('activation must be submitted before finish');
        if (!HASH_RE.test(userOpHash || '') || userOpHash !== work.user_op_hash) {
          throw new Error('submitted user operation hash disagreement');
        }
        if (!HASH_RE.test(txHash || '')) throw new Error('activation transaction hash is not canonical');
        if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0) {
          throw new Error('activation time is invalid');
        }
        if (activatedAt >= mandate.valid_until_seconds) {
          throw new Error('activation time must precede mandate expiry');
        }
        db.prepare(`
          UPDATE mandates_v3
          SET status = 'active', activation_user_op_hash = ?, activation_tx_hash = ?,
              activated_at = ?, updated_at = ? WHERE mandate_id = ?
        `).run(userOpHash, txHash, activatedAt, at, mandate.mandate_id);
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = 'done', tx_hash = ?, lease_token = NULL, lease_expires_at = NULL,
              updated_at = ? WHERE mandate_id = ?
        `).run(txHash, at, mandate.mandate_id);
        return {
          mandate: publicMandate(mandateRow(mandate.mandate_id)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(mandate.mandate_id)),
        };
      });
    },
    finishUncertain({
      leaseToken: token,
      userOpHash,
      txHash,
      nowSeconds: atValue,
      ...identity
    }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or terminal activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (work.status !== 'submitting' && work.status !== 'submitted') {
          throw new Error('activation must cross the submitting or submitted fence');
        }
        if (userOpHash !== undefined && !HASH_RE.test(userOpHash)) {
          throw new Error('user operation hash is not canonical');
        }
        if (work.status === 'submitted' && userOpHash !== undefined
          && userOpHash !== work.user_op_hash) {
          throw new Error('submitted user operation hash mismatch');
        }
        const retainedUserOpHash = userOpHash ?? work.user_op_hash;
        if (txHash !== undefined && !HASH_RE.test(txHash)) {
          throw new Error('activation transaction hash is not canonical');
        }
        if (txHash !== undefined && !retainedUserOpHash) {
          throw new Error('transaction evidence requires a canonical user operation hash');
        }
        db.prepare(`UPDATE mandates_v3 SET status = 'activation_uncertain', updated_at = ? WHERE mandate_id = ?`)
          .run(at, mandate.mandate_id);
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = 'uncertain', user_op_hash = ?, tx_hash = ?,
              lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE mandate_id = ?
        `).run(
          retainedUserOpHash ?? null, txHash ?? work.tx_hash ?? null,
          at, mandate.mandate_id,
        );
        return {
          mandate: publicMandate(mandateRow(mandate.mandate_id)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(mandate.mandate_id)),
        };
      });
    },
    finishRevoked({
      leaseToken: token,
      userOpHash,
      txHash,
      activatedAt,
      nowSeconds: atValue,
      ...identity
    }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or terminal activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (work.status !== 'submitted') {
          throw new Error('activation must be submitted before receipt revocation');
        }
        if (!HASH_RE.test(userOpHash || '') || userOpHash !== work.user_op_hash) {
          throw new Error('submitted user operation hash mismatch');
        }
        if (!HASH_RE.test(txHash || '')) {
          throw new Error('activation transaction hash is not canonical');
        }
        if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0) {
          throw new Error('activation timestamp is invalid');
        }
        if (activatedAt >= mandate.valid_until_seconds) {
          throw new Error('activation timestamp must precede mandate expiry');
        }
        db.prepare(`
          UPDATE mandates_v3
          SET status = 'revoked', activation_user_op_hash = ?, activation_tx_hash = ?,
              activated_at = ?, session_key_envelope = NULL, updated_at = ?
          WHERE mandate_id = ?
        `).run(userOpHash, txHash, activatedAt, at, mandate.mandate_id);
        db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?')
          .run(mandate.mandate_id);
        return {
          mandate: publicMandate(mandateRow(mandate.mandate_id)),
          work: null,
        };
      });
    },
    listRecoverable({ nowSeconds: atValue } = {}) {
      const at = safeNow(atValue);
      return transaction(() => {
        cleanupAllExpiredLocked(at);
        return db.prepare(`
          SELECT work.* FROM mandate_activation_work AS work
          JOIN mandates_v3 AS mandate ON mandate.mandate_id = work.mandate_id
          WHERE work.status = 'pending'
            AND mandate.status = 'pending_activation'
            AND mandate.valid_until_seconds > ?
          ORDER BY work.created_at, work.mandate_id
        `).all(at).map(activationWork);
      });
    },
    reconcileExpired({ nowSeconds: atValue } = {}) {
      const at = safeNow(atValue);
      return transaction(() => {
        cleanupAllExpiredLocked(at);
        const rows = db.prepare(`
          SELECT work.* FROM mandate_activation_work AS work
          JOIN mandates_v3 AS mandate ON mandate.mandate_id = work.mandate_id
          WHERE work.status IN ('running','submitting','submitted')
            AND work.lease_expires_at <= ? AND mandate.valid_until_seconds > ?
          ORDER BY work.created_at, work.mandate_id
        `).all(at, at);
        const result = [];
        for (const row of rows) {
          const next = row.status === 'running' ? 'pending' : 'uncertain';
          db.prepare(`
            UPDATE mandate_activation_work
            SET status = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE mandate_id = ?
          `).run(next, at, row.mandate_id);
          if (next === 'uncertain') {
            db.prepare(`
              UPDATE mandates_v3 SET status = 'activation_uncertain', updated_at = ?
              WHERE mandate_id = ?
            `).run(at, row.mandate_id);
          }
          result.push(activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(row.mandate_id)));
        }
        return result;
      });
    },
  };

  function legacyMandateTables() {
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND lower(name) IN ('mandates','mandates_v2')
      ORDER BY name
    `).all().map(({ name }) => name);
  }

  // -------------------------------------------------------------------------
  // Task 8: cctpRelays — transactional SQLite implementation of the checkpointed
  // CCTP relay-work contract (same behavior as store.mjs memory/file backends;
  // the pure validation/transition functions are shared from store.mjs).
  // Multi-row/read-compare-write operations run in one BEGIN IMMEDIATE
  // transaction; transitions are conditional UPDATEs guarded by
  // (exec_id, expected state, lease_token, unexpired lease). Conflicts are typed
  // (RELAY_*) — no raw SQLite error text ever escapes.
  // -------------------------------------------------------------------------

  function relayTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      if (/SQLITE_BUSY|database is locked/i.test(String(error?.message || ''))) {
        throw relayError('RELAY_STORE_BUSY', 'relay work store is temporarily unavailable');
      }
      throw error;
    }
  }

  function cctpRowToRecord(row) {
    if (!row) return null;
    return {
      execId: row.exec_id,
      sourceDomain: row.source_domain,
      burnTxHash: row.burn_tx_hash,
      expectation: JSON.parse(row.expectation_json),
      expectationDigest: row.expectation_digest,
      state: row.state,
      messageHex: row.message_hex,
      nonceHex: row.nonce_hex,
      messageDigest: row.message_digest,
      attestationHex: row.attestation_hex,
      attestationDigest: row.attestation_digest,
      evidenceVersion: row.evidence_version,
      mintTxHash: row.mint_tx_hash,
      reasonCode: row.reason_code,
      attempts: row.attempts,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const cctpSelect = () => db.prepare('SELECT * FROM cctp_relay_work WHERE exec_id = ?');
  const cctpGet = (execId) => cctpRowToRecord(cctpSelect().get(execId));

  const CCTP_UPDATE_COLUMNS = `
    UPDATE cctp_relay_work SET
      source_domain = ?, burn_tx_hash = ?, expectation_json = ?, expectation_digest = ?,
      state = ?, message_hex = ?, nonce_hex = ?, message_digest = ?, attestation_hex = ?,
      attestation_digest = ?, evidence_version = ?, mint_tx_hash = ?, reason_code = ?,
      attempts = ?, lease_token = ?, lease_expires_at = ?, created_at = ?, updated_at = ?
  `;

  function cctpBind(record) {
    return [
      record.sourceDomain, record.burnTxHash, JSON.stringify(record.expectation),
      record.expectationDigest, record.state, record.messageHex, record.nonceHex,
      record.messageDigest, record.attestationHex, record.attestationDigest,
      record.evidenceVersion, record.mintTxHash, record.reasonCode, record.attempts,
      record.leaseToken, record.leaseExpiresAt, record.createdAt, record.updatedAt,
    ];
  }

  // Conditional transition write: the row must still carry the exact (state, live lease) the
  // pure transition function compared against. Zero rows touched => a stale connection raced
  // this worker => typed CAS conflict, never a silent overwrite.
  function cctpWriteTransition(current, next, now) {
    const result = db.prepare(`
      ${CCTP_UPDATE_COLUMNS}
      WHERE exec_id = ? AND state = ? AND lease_token = ? AND lease_expires_at > ?
    `).run(...cctpBind(next), current.execId, current.state, current.leaseToken, now);
    if (result.changes !== 1) {
      throw relayError('RELAY_CAS_CONFLICT', 'relay transition conflicts with the durable record (zero-row conditional update)');
    }
    return next;
  }

  function cctpTransition(args, transition) {
    return relayTransaction(() => {
      const current = cctpGet(args.execId);
      const outcome = transition(current, args);
      if (outcome.unchanged) return current;
      return cctpWriteTransition(current, outcome.next, args.now);
    });
  }

  function requireSweepArgs(now, limit) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit <= 0) {
      throw relayError('RELAY_VALIDATION', 'relay sweep requires a safe-integer now and a positive safe-integer limit');
    }
  }

  const cctpRelays = {
    enqueue({ execId, sourceDomain, burnTxHash, expectation, now: enqueueNow }) {
      return relayTransaction(() => {
        const decision = relayEnqueueDecision({
          existing: cctpGet(execId),
          hasBurnOwner: (burn) => Boolean(db.prepare(
            'SELECT 1 FROM cctp_relay_work WHERE burn_tx_hash = ? AND exec_id <> ?',
          ).get(burn, execId)),
          execId,
          sourceDomain,
          burnTxHash,
          expectation,
          now: enqueueNow,
        });
        if (decision.changed) {
          db.prepare(`
            INSERT INTO cctp_relay_work (
              exec_id, source_domain, burn_tx_hash, expectation_json, expectation_digest,
              state, message_hex, nonce_hex, message_digest, attestation_hex,
              attestation_digest, evidence_version, mint_tx_hash, reason_code,
              attempts, lease_token, lease_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(decision.record.execId, ...cctpBind(decision.record));
        }
        return decision.record;
      });
    },

    get(execId) {
      return cctpGet(execId);
    },

    claim({ execId, now: claimNow, leaseMs }) {
      // One conditional UPDATE: exactly one competing connection installs its token on an
      // unleased safe-state row; everyone else gets null.
      if (!Number.isSafeInteger(claimNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw relayError('RELAY_VALIDATION', 'relay claim requires a safe-integer now and a positive safe-integer leaseMs');
      }
      const row = db.prepare(`
        UPDATE cctp_relay_work
        SET attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE exec_id = ? AND state IN ('attestation_pending','attested','mint_submitted')
          AND lease_token IS NULL
        RETURNING *
      `).get(randomUUID(), claimNow + leaseMs, claimNow, execId);
      return cctpRowToRecord(row);
    },

    renew({ execId, leaseToken, now: renewNow, leaseMs }) {
      return cctpTransition({ execId, leaseToken, now: renewNow, leaseMs }, relayRenew);
    },

    recordAttested({ execId, leaseToken, messageHex, nonceHex, attestationHex, now: attestNow }) {
      return cctpTransition({
        execId, leaseToken, messageHex, nonceHex, attestationHex, now: attestNow,
      }, relayRecordAttested);
    },

    markMintSubmitting({ execId, leaseToken, now: fenceNow }) {
      return cctpTransition({ execId, leaseToken, now: fenceNow }, relayMarkMintSubmitting);
    },

    markMintSubmitted({ execId, leaseToken, mintTxHash, now: submitNow }) {
      return cctpTransition({ execId, leaseToken, mintTxHash, now: submitNow }, relayMarkMintSubmitted);
    },

    finishMinted({ execId, leaseToken, mintTxHash, now: finishNow }) {
      return cctpTransition({ execId, leaseToken, mintTxHash, now: finishNow }, relayFinishMinted);
    },

    finishBlocked({ execId, leaseToken, reasonCode, now: blockNow }) {
      return cctpTransition({ execId, leaseToken, reasonCode, now: blockNow }, relayFinishBlocked);
    },

    finishUncertain({ execId, leaseToken, mintTxHash, reasonCode, now: uncertainNow }) {
      return cctpTransition(
        { execId, leaseToken, mintTxHash, reasonCode, now: uncertainNow },
        relayFinishUncertain,
      );
    },

    release({ execId, leaseToken, now: releaseNow }) {
      return cctpTransition({ execId, leaseToken, now: releaseNow }, relayRelease);
    },

    listForSweep({ now: sweepNow, limit, includeTerminal = false }) {
      requireSweepArgs(sweepNow, limit);
      const rows = db.prepare(includeTerminal
        ? "SELECT * FROM cctp_relay_work WHERE state <> 'minted' ORDER BY created_at, exec_id LIMIT ?"
        : "SELECT * FROM cctp_relay_work WHERE state NOT IN ('minted','blocked','uncertain') ORDER BY created_at, exec_id LIMIT ?")
        .all(limit);
      return rows.map(cctpRowToRecord);
    },

    reconcileExpired({ now: reconcileNow, limit }) {
      requireSweepArgs(reconcileNow, limit);
      return relayTransaction(() => {
        const rows = db.prepare(`
          SELECT * FROM cctp_relay_work
          WHERE lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
            AND state NOT IN ('minted','blocked','uncertain')
          ORDER BY created_at, exec_id LIMIT ?
        `).all(reconcileNow, limit);
        const reconciled = [];
        for (const row of rows) {
          const current = cctpRowToRecord(row);
          const next = relayReconcileExpired(current, reconcileNow);
          const result = db.prepare(`
            UPDATE cctp_relay_work
            SET state = ?, reason_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE exec_id = ? AND state = ? AND lease_token = ? AND lease_expires_at <= ?
          `).run(next.state, next.reasonCode, reconcileNow,
            current.execId, current.state, current.leaseToken, reconcileNow);
          if (result.changes !== 1) {
            throw relayError('RELAY_CAS_CONFLICT', 'relay reconciliation conflicts with the durable record (zero-row conditional update)');
          }
          reconciled.push(next);
        }
        return reconciled;
      });
    },

    statusOf(execId) {
      return relayStatusOf(cctpGet(execId));
    },
  };

  function probe() {
    return transaction(() => {
      const ensemble = classifyMandateSchemaEnsemble(db);
      if (ensemble.kind !== 'current') {
        throw new Error('mandate readiness schema ensemble is incompatible');
      }
      db.prepare('UPDATE jobs SET job = job WHERE 0').run();
      db.prepare('SELECT id FROM association_outbox WHERE 0').all();
      db.prepare('SELECT job_id FROM farm_execution_work WHERE 0').all();
      db.prepare('SELECT job_id FROM farm_intent_work_v2 WHERE 0').all();
      db.prepare('SELECT network_id FROM base_evidence_heads WHERE 0').all();
      db.prepare('SELECT event_id FROM base_evidence_outbox WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandates_v3 WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandate_activation_work WHERE 0').all();
      db.prepare('SELECT exec_id FROM cctp_relay_work WHERE 0').all();
      return {
        writable: true,
        baseEvidenceDurable: true,
        farmIntentDurable: true,
        legacyMandateTables: legacyMandateTables(),
        mandateMigrationCleanupPending: ensemble.cleanupPending,
      };
    });
  }

  const legacyFailClosed = Object.freeze({
    set() { throw new Error('legacy plaintext mandate store is disabled'); },
    get() { return undefined; },
    status() { return { status: 'missing', valid: false }; },
    delete() { return false; },
    sweep() { return 0; },
    size: 0,
  });

  return {
    db,
    store,
    jobs,
    mandates: legacyFailClosed,
    mandatesV2: legacyFailClosed,
    mandatesV3,
    mandateActivations,
    associationOutbox,
    baseEvidenceOutbox,
    farmExecutions,
    farmIntents,
    cctpRelays,
    probe,
  };
}

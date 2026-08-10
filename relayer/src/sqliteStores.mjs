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
import {
  classifyUnwindSchema,
  createUnwindStore,
  prepareUnwindSchema,
} from './unwindStore.mjs';
export { buildForwardFarmIntent } from './farmIntent.mjs';
import {
  RELAY_CLAIMABLE_STATES,
  relayEnqueueDecision,
  relayIdentityConflicts,
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
  assertCanonicalRelayRecord,
} from './store.mjs';
import { computeBaseRecoveryWorkId } from './baseRecovery.mjs';

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

function canonicalD1Bytes32(value) {
  if (value == null) return value;
  const bare = String(value).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error('CCTP evidence digest is not canonical');
  return `0x${bare}`;
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
const CCTP_RELAY_COLUMNS = Object.freeze([
  'exec_id', 'source_domain', 'burn_tx_hash', 'expectation_json', 'expectation_digest',
  'state', 'message_hex', 'nonce_hex', 'message_digest', 'attestation_hex',
  'attestation_digest', 'evidence_version', 'mint_tx_hash', 'reason_code', 'attempts',
  'lease_token', 'lease_expires_at', 'created_at', 'updated_at',
]);

// Literal deployed Task8/early-Task12 table definition. Keep this frozen: deriving it from the
// hardened target would make a later CHECK addition silently change which real databases are
// recognized for migration.
const CCTP_V1_RELAY_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cctp_relay_work (
    exec_id TEXT PRIMARY KEY,
    source_domain INTEGER NOT NULL,
    burn_tx_hash TEXT NOT NULL,
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
  );`;

const CCTP_RELAY_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cctp_relay_work (
    exec_id TEXT PRIMARY KEY CHECK (length(exec_id) > 0),
    source_domain INTEGER NOT NULL,
    burn_tx_hash TEXT NOT NULL,
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
    evidence_version INTEGER NOT NULL DEFAULT 0 CHECK (evidence_version >= 0),
    mint_tx_hash TEXT,
    reason_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (
      (reason_code IS 'legacy_record_unrecoverable'
        AND state='blocked' AND mint_tx_hash IS NULL
        AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (reason_code IS NOT 'legacy_record_unrecoverable'
        AND source_domain IN (6,27)
        AND json_valid(expectation_json)
        AND length(expectation_digest)=64
        AND expectation_digest NOT GLOB '*[^0-9a-f]*'
        AND ((source_domain=27 AND length(burn_tx_hash)=64
              AND burn_tx_hash NOT GLOB '*[^0-9a-f]*')
          OR (source_domain=6 AND length(burn_tx_hash)=66
              AND substr(burn_tx_hash,1,2)='0x'
              AND substr(burn_tx_hash,3) NOT GLOB '*[^0-9a-f]*')))
    ),
    CHECK ((lease_token IS NULL AND lease_expires_at IS NULL)
      OR (typeof(lease_token)='text' AND length(lease_token)>0
        AND typeof(lease_expires_at)='integer' AND lease_expires_at>=0)),
    CHECK (state NOT IN ('minted','blocked','uncertain')
      OR (lease_token IS NULL AND lease_expires_at IS NULL)),
    CHECK (reason_code IS 'legacy_record_unrecoverable' OR (
      (state='blocked' AND reason_code IN (
        'message_mismatch','message_ambiguous','attested_evidence_changed',
        'destination_reverted'
      ))
      OR (state='uncertain' AND reason_code IN (
        'submission_unknown','submitted_checkpoint_failed','submission_lease_expired'
      ))
      OR (state NOT IN ('blocked','uncertain') AND reason_code IS NULL)
    )),
    CHECK (reason_code IS 'legacy_record_unrecoverable' OR (
      (message_hex IS NULL AND nonce_hex IS NULL AND message_digest IS NULL
        AND attestation_hex IS NULL AND attestation_digest IS NULL AND evidence_version=0)
      OR (message_hex IS NOT NULL AND nonce_hex IS NOT NULL AND message_digest IS NOT NULL
        AND attestation_hex IS NOT NULL AND attestation_digest IS NOT NULL
        AND evidence_version>0)
    )),
    CHECK (reason_code IS 'legacy_record_unrecoverable' OR state='blocked' OR (
      (state='attestation_pending' AND message_hex IS NULL)
      OR (state IN ('attested','mint_submitting','mint_submitted','minted','uncertain')
        AND message_hex IS NOT NULL)
    )),
    CHECK (reason_code IS 'legacy_record_unrecoverable'
      OR state<>'mint_submitting' OR lease_token IS NOT NULL),
    CHECK (reason_code IS 'legacy_record_unrecoverable'
      OR state NOT IN ('mint_submitted','minted') OR mint_tx_hash IS NOT NULL)
  );`;

const CCTP_RELAY_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_recovery
    ON cctp_relay_work(updated_at, created_at, exec_id, state, lease_token);
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_actionable
    ON cctp_relay_work(updated_at, created_at, exec_id)
    WHERE state IN ('attestation_pending','attested','mint_submitted')
      AND lease_token IS NULL;
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_expiry
    ON cctp_relay_work(lease_expires_at, created_at, exec_id)
    WHERE state IN ('attestation_pending','attested','mint_submitting','mint_submitted')
      AND lease_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_summary
    ON cctp_relay_work(created_at, exec_id)
    WHERE state IN ('blocked','uncertain') OR lease_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_cctp_relay_burn
    ON cctp_relay_work(burn_tx_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cctp_relay_identity
    ON cctp_relay_work(source_domain, burn_tx_hash, expectation_digest);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cctp_relay_forward_burn
    ON cctp_relay_work(source_domain, burn_tx_hash) WHERE source_domain = 27;
`;

const CCTP_RELAY_WORK_SCHEMA = `${CCTP_RELAY_TABLE_SCHEMA}\n${CCTP_RELAY_INDEX_SCHEMA}`;

const CCTP_LEGACY_RELAY_TABLE_SCHEMA = `
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
  );`;

function cctpTableSqlFingerprint(sql) {
  return normalizedSchemaSql(sql)?.toLowerCase()
    .replace('create table if not exists ', 'create table ');
}

let cctpTableReferences;

function canonicalCctpTableReferences() {
  if (cctpTableReferences) return cctpTableReferences;
  const capture = (schema) => {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(schema);
      return cctpTableSqlFingerprint(reference.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cctp_relay_work'",
      ).get()?.sql);
    } finally {
      reference.close();
    }
  };
  cctpTableReferences = Object.freeze({
    legacy: capture(CCTP_LEGACY_RELAY_TABLE_SCHEMA),
    v1: capture(CCTP_V1_RELAY_TABLE_SCHEMA),
    current: capture(CCTP_RELAY_TABLE_SCHEMA),
  });
  return cctpTableReferences;
}

function cctpIndexes(db) {
  return db.prepare('PRAGMA index_list(cctp_relay_work)').all().map((row) => ({
    ...row,
    columns: db.prepare(`PRAGMA index_info(${quoteSchemaIdentifier(row.name)})`).all()
      .map(({ name }) => name),
    sql: normalizedSchemaSql(db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    ).get(row.name)?.sql)?.toLowerCase().replace(/\s*=\s*/g, '=') ?? null,
  }));
}

const EXPECTED_CCTP_INDEXES = Object.freeze({
  idx_cctp_relay_recovery: Object.freeze({
    unique: 0, partial: 0,
    columns: Object.freeze(['updated_at', 'created_at', 'exec_id', 'state', 'lease_token']),
  }),
  idx_cctp_relay_actionable: Object.freeze({
    unique: 0, partial: 1,
    columns: Object.freeze(['updated_at', 'created_at', 'exec_id']),
    where: "where state in('attestation_pending','attested','mint_submitted')and lease_token is null",
  }),
  idx_cctp_relay_expiry: Object.freeze({
    unique: 0, partial: 1,
    columns: Object.freeze(['lease_expires_at', 'created_at', 'exec_id']),
    where: "where state in('attestation_pending','attested','mint_submitting','mint_submitted')and lease_token is not null",
  }),
  idx_cctp_relay_summary: Object.freeze({
    unique: 0, partial: 1,
    columns: Object.freeze(['created_at', 'exec_id']),
    where: "where state in('blocked','uncertain')or lease_token is not null",
  }),
  idx_cctp_relay_burn: Object.freeze({
    unique: 0, partial: 0, columns: Object.freeze(['burn_tx_hash']),
  }),
  idx_cctp_relay_identity: Object.freeze({
    unique: 1, partial: 0,
    columns: Object.freeze(['source_domain', 'burn_tx_hash', 'expectation_digest']),
  }),
  idx_cctp_relay_forward_burn: Object.freeze({
    unique: 1, partial: 1,
    columns: Object.freeze(['source_domain', 'burn_tx_hash']),
    where: 'where source_domain=27',
  }),
});

const V1_EXPECTED_CCTP_INDEXES = Object.freeze({
  idx_cctp_relay_recovery: Object.freeze({
    unique: 0, partial: 0,
    columns: Object.freeze(['created_at', 'exec_id', 'state', 'lease_expires_at']),
  }),
  idx_cctp_relay_burn: EXPECTED_CCTP_INDEXES.idx_cctp_relay_burn,
  idx_cctp_relay_identity: EXPECTED_CCTP_INDEXES.idx_cctp_relay_identity,
  idx_cctp_relay_forward_burn: EXPECTED_CCTP_INDEXES.idx_cctp_relay_forward_burn,
});

export function classifyCctpRelaySchema(db) {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='cctp_relay_work'",
  ).get();
  const expectedNames = new Set(['cctp_relay_work', ...Object.keys(EXPECTED_CCTP_INDEXES)]);
  const targetReference = /(?:^|[^a-z0-9_])cctp_relay_work(?:$|[^a-z0-9_])/i;
  const related = db.prepare(`
    SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
  `).all().filter(({ name, tbl_name: tableName, sql }) => (
    name === 'cctp_relay_work' || tableName === 'cctp_relay_work'
      || targetReference.test(String(sql))
  ));
  if (!table) {
    if (related.length !== 0) throw new Error('CCTP relay-work schema has orphaned dependencies');
    return { kind: 'absent' };
  }
  const unexpectedRelated = related.find(({ name }) => !expectedNames.has(name));
  if (unexpectedRelated) throw new Error('CCTP relay-work schema has an unexpected dependency');
  const columns = db.prepare('PRAGMA table_xinfo(cctp_relay_work)').all()
    .map(({ name }) => name);
  if (JSON.stringify(columns) !== JSON.stringify(CCTP_RELAY_COLUMNS)) {
    throw new Error('CCTP relay-work schema is incompatible');
  }
  if (db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='cctp_relay_work' LIMIT 1",
  ).get()) {
    throw new Error('CCTP relay-work schema has an unexpected trigger');
  }
  const fingerprint = cctpTableSqlFingerprint(table.sql);
  const references = canonicalCctpTableReferences();
  const indexes = cctpIndexes(db);
  const expectedNamed = new Set(Object.keys(EXPECTED_CCTP_INDEXES));
  const unexpected = indexes.find(({ name }) => !name.startsWith('sqlite_autoindex_')
    && !expectedNamed.has(name));
  if (unexpected) throw new Error('CCTP relay-work schema has an unexpected index');
  if (fingerprint === references.legacy) {
    const burnUnique = indexes.some(({ unique, columns: indexColumns }) => unique === 1
      && indexColumns.length === 1 && indexColumns[0] === 'burn_tx_hash');
    if (!burnUnique) throw new Error('legacy CCTP relay-work uniqueness is incompatible');
    if (indexes.some(({ name }) => !name.startsWith('sqlite_autoindex_')
      && name !== 'idx_cctp_relay_recovery')) {
      throw new Error('legacy CCTP relay-work index ensemble is incompatible');
    }
    return { kind: 'legacy-unique-burn' };
  }
  if (fingerprint === references.v1) {
    const oneColumnBurnUnique = indexes.some(({ unique, columns: indexColumns }) => unique === 1
      && indexColumns.length === 1 && indexColumns[0] === 'burn_tx_hash');
    if (oneColumnBurnUnique) throw new Error('CCTP relay-work v1 retained legacy burn uniqueness');
    for (const [name, expected] of Object.entries(V1_EXPECTED_CCTP_INDEXES)) {
      const actual = indexes.find((index) => index.name === name);
      if (!actual || actual.unique !== expected.unique || actual.partial !== expected.partial
          || actual.origin !== 'c'
          || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)
          || (expected.where
            ? !actual.sql?.endsWith(expected.where)
            : actual.sql?.includes(' where '))) {
        throw new Error(`CCTP relay-work v1 index ${name} is incompatible`);
      }
    }
    return { kind: 'current-v1' };
  }
  if (fingerprint !== references.current) {
    throw new Error('CCTP relay-work table definition is incompatible');
  }
  const oneColumnBurnUnique = indexes.some(({ unique, columns: indexColumns }) => unique === 1
    && indexColumns.length === 1 && indexColumns[0] === 'burn_tx_hash');
  if (oneColumnBurnUnique) throw new Error('CCTP relay-work retained legacy burn uniqueness');
  const missing = [];
  for (const [name, expected] of Object.entries(EXPECTED_CCTP_INDEXES)) {
    const actual = indexes.find((index) => index.name === name);
    if (!actual) {
      missing.push(name);
      continue;
    }
    const wrongShape = actual.unique !== expected.unique
      || actual.partial !== expected.partial
      || actual.origin !== 'c'
      || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)
      || (expected.where
        ? !actual.sql?.endsWith(expected.where)
        : actual.sql?.includes(' where '));
    if (wrongShape) throw new Error(`CCTP relay-work schema index ${name} is incompatible`);
  }
  return missing.length === 0 ? { kind: 'current' } : { kind: 'current-incomplete', missing };
}

function cctpRecordFromRawRow(row) {
  let expectation = null;
  if (row.reason_code !== 'legacy_record_unrecoverable') {
    expectation = JSON.parse(row.expectation_json);
  } else {
    try { expectation = JSON.parse(row.expectation_json); } catch { expectation = null; }
  }
  return {
    execId: row.exec_id,
    sourceDomain: row.source_domain,
    burnTxHash: row.burn_tx_hash,
    expectation,
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

function canonicalCctpRawRow(row) {
  try {
    assertCanonicalRelayRecord(cctpRecordFromRawRow(row));
    return true;
  } catch {
    return false;
  }
}

function migratedCctpValues(row, { now, quarantine }) {
  if (!quarantine) return CCTP_RELAY_COLUMNS.map((column) => row[column]);
  const createdAt = Number.isSafeInteger(row.created_at) && row.created_at >= 0
    ? row.created_at : Math.max(0, now);
  const oldUpdatedAt = Number.isSafeInteger(row.updated_at) && row.updated_at >= createdAt
    ? row.updated_at : createdAt;
  const updatedAt = Math.max(createdAt, oldUpdatedAt, now);
  return [
    row.exec_id, row.source_domain, row.burn_tx_hash, row.expectation_json,
    row.expectation_digest, 'blocked', row.message_hex, row.nonce_hex,
    row.message_digest, row.attestation_hex, row.attestation_digest,
    Number.isSafeInteger(row.evidence_version) && row.evidence_version >= 0
      ? row.evidence_version : 0,
    null, 'legacy_record_unrecoverable',
    Number.isSafeInteger(row.attempts) && row.attempts >= 0 ? row.attempts : 0,
    null, null, createdAt, updatedAt,
  ];
}

function prepareCctpRelaySchema(db, { now, fault = () => {} }) {
  const initial = classifyCctpRelaySchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = classifyCctpRelaySchema(db);
    if (JSON.stringify(locked) !== JSON.stringify(initial)) {
      throw new Error('CCTP relay-work schema changed during initialization');
    }
    if (locked.kind === 'absent') {
      db.exec(CCTP_RELAY_WORK_SCHEMA);
    } else if (locked.kind === 'legacy-unique-burn' || locked.kind === 'current-v1') {
      const legacyCount = db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n;
      for (const name of Object.keys(EXPECTED_CCTP_INDEXES)) {
        db.exec(`DROP INDEX IF EXISTS ${quoteSchemaIdentifier(name)}`);
      }
      db.exec('ALTER TABLE cctp_relay_work RENAME TO cctp_relay_work_task8_legacy');
      fault('legacy_renamed');
      db.exec(CCTP_RELAY_WORK_SCHEMA);
      const insert = db.prepare(`
        INSERT INTO cctp_relay_work (${CCTP_RELAY_COLUMNS.join(',')})
        VALUES (${CCTP_RELAY_COLUMNS.map(() => '?').join(',')})
      `);
      for (const row of db.prepare(
        'SELECT * FROM cctp_relay_work_task8_legacy ORDER BY exec_id',
      ).all()) {
        const invalid = !canonicalCctpRawRow(row);
        // Both recognized source schemas predate Task12's cryptographic job commitment and
        // dedicated proof authority. A matching wrapper row cannot upgrade their provenance:
        // every still-actionable Base row is therefore an audit-only tombstone.
        const unauthorisedBase = row.source_domain === 6
          && !['minted', 'blocked', 'uncertain'].includes(row.state);
        insert.run(...migratedCctpValues(row, {
          now,
          quarantine: invalid || unauthorisedBase,
        }));
      }
      fault('rows_copied');
      const copiedCount = db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n;
      const activeBase = db.prepare(`
        SELECT 1 FROM cctp_relay_work
        WHERE source_domain=6 AND state NOT IN ('minted','blocked','uncertain') LIMIT 1
      `).get();
      if (copiedCount !== legacyCount || activeBase) {
        throw new Error('CCTP relay-work migration copy verification failed');
      }
      db.exec('DROP TABLE cctp_relay_work_task8_legacy');
    } else {
      db.exec(CCTP_RELAY_INDEX_SCHEMA);
    }
    if (classifyCctpRelaySchema(db).kind !== 'current') {
      throw new Error('CCTP relay-work schema initialization failed');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

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
  cctpMigrationFault = () => {},
  unwindFault = () => {},
} = {}) {
  if (typeof farmIntentFault !== 'function') throw new Error('farm intent fault seam is invalid');
  if (typeof cctpMigrationFault !== 'function') throw new Error('CCTP migration fault seam is invalid');
  if (typeof unwindFault !== 'function') throw new Error('unwind fault seam is invalid');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    prepareMandateSchema(db);
    const migrationNow = now();
    if (!Number.isSafeInteger(migrationNow)) throw new Error('CCTP migration time is invalid');
    prepareCctpRelaySchema(db, { now: migrationNow, fault: cctpMigrationFault });
    prepareUnwindSchema(db);
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
      submission_owner_token TEXT,
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
    CREATE TABLE IF NOT EXISTS base_recovery_work (
      work_id TEXT PRIMARY KEY CHECK (
        length(work_id) = 64 AND work_id NOT GLOB '*[^0-9a-f]*'
      ),
      network_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      evidence_version INTEGER NOT NULL CHECK (evidence_version >= 0),
      action TEXT NOT NULL CHECK (action IN (
        'poll-attestation','submit-mint','poll-mint','submit-base-deposit','poll-base-deposit'
      )),
      mandate_id TEXT NOT NULL,
      farm_job_id TEXT,
      farm_intent_digest TEXT,
      claim_token_digest TEXT CHECK (
        claim_token_digest IS NULL OR (
          length(claim_token_digest) = 64 AND claim_token_digest NOT GLOB '*[^0-9a-f]*'
        )
      ),
      state TEXT NOT NULL CHECK (state IN (
        'pending','running','held','done','uncertain','blocked','owner_action_required'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      checkpoint_ref TEXT,
      reason_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(network_id,binding_id,execution_id,allocation_id,child_id,evidence_version,action)
    );
    CREATE INDEX IF NOT EXISTS idx_association_outbox_delivery
      ON association_outbox (status, available_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_association_outbox_child
      ON association_outbox (child_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_base_evidence_delivery
      ON base_evidence_outbox (delivery_status,available_at,lease_expires_at,id);
    CREATE INDEX IF NOT EXISTS idx_farm_intent_recovery_v2
      ON farm_intent_work_v2 (state,created_at,job_id);
    CREATE INDEX IF NOT EXISTS idx_base_recovery_work_resume
      ON base_recovery_work (state,lease_expires_at,created_at,work_id);
    CREATE INDEX IF NOT EXISTS idx_base_recovery_work_identity
      ON base_recovery_work (network_id,binding_id,execution_id,allocation_id,child_id);
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
    CREATE TRIGGER IF NOT EXISTS base_recovery_work_immutable
      BEFORE UPDATE OF
        work_id,network_id,binding_id,execution_id,allocation_id,child_id,evidence_version,action,
        mandate_id,farm_job_id,farm_intent_digest,created_at
      ON base_recovery_work
      BEGIN
        SELECT RAISE(ABORT, 'immutable Base recovery work');
      END;
    ${MANDATE_V3_SCHEMA}
    `);
    const baseHeadColumns = new Set(db.prepare('PRAGMA table_info(base_evidence_heads)')
      .all().map(({ name }) => name));
    if (!baseHeadColumns.has('submission_owner_token')) {
      db.exec('ALTER TABLE base_evidence_heads ADD COLUMN submission_owner_token TEXT');
    }
  } catch (error) {
    db.close();
    throw error;
  }

  let enqueueAssociationInTransaction;
  let enqueueBaseEvidenceInTransaction;
  let claimBaseSubmissionInTransaction;
  const associationOutbox = createAssociationOutbox(db, {
    maxAttempts: outboxMaxAttempts,
    now,
    registerTransactionEnqueue: (enqueue) => { enqueueAssociationInTransaction = enqueue; },
  });
  const baseEvidenceOutbox = createBaseEvidenceOutbox(db, {
    maxAttempts: outboxMaxAttempts,
    now,
    leaseToken,
    registerTransactionEnqueue: (enqueue) => { enqueueBaseEvidenceInTransaction = enqueue; },
    registerTransactionClaim: (claim) => { claimBaseSubmissionInTransaction = claim; },
  });
  const unwindJobs = createUnwindStore(db, {
    newToken: leaseToken,
    attachFault: unwindFault,
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

  function exactPublicJobState(job, jobId, state) {
    return Boolean(job && typeof job === 'object' && !Array.isArray(job)
      && job.jobId === jobId && job.status === state);
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

  function farmIntentRecoveryRecord(row) {
    if (!row) return null;
    try {
      return farmIntentRecord(row);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {
        corrupt: true,
        jobId: row.job_id,
        mandateId: row.mandate_id,
        stellarOwner: row.stellar_owner,
        kernelAddress: row.kernel_address,
        bindingId: row.binding_id,
        bindingHash: row.binding_hash,
        intentDigest: row.intent_digest,
        state: row.state,
      };
    }
  }

  const AUTHORIZED_CLAIM_FIELDS = new Set([
    'mandateId', 'stellarOwner', 'kernelAddress', 'status', 'bindingId', 'bindingHash',
    'capabilityHash', 'relayerOrigin', 'validUntilSeconds', 'updatedAt',
  ]);

  function canonicalAuthorizedClaimSnapshot(value) {
    const fields = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || fields.length !== AUTHORIZED_CLAIM_FIELDS.size
        || fields.some((field) => typeof field !== 'string' || !AUTHORIZED_CLAIM_FIELDS.has(field))) {
      throw new Error('authorized Base claim snapshot is invalid');
    }
    const snapshot = Object.fromEntries(
      [...AUTHORIZED_CLAIM_FIELDS].map((field) => [field, value[field]]),
    );
    if (snapshot.status !== 'active'
        || typeof snapshot.mandateId !== 'string' || !snapshot.mandateId
        || typeof snapshot.stellarOwner !== 'string' || !snapshot.stellarOwner
        || typeof snapshot.kernelAddress !== 'string'
        || snapshot.kernelAddress !== snapshot.kernelAddress.toLowerCase()
        || typeof snapshot.bindingId !== 'string' || !snapshot.bindingId
        || !DIGEST_RE.test(snapshot.bindingHash || '')
        || !DIGEST_RE.test(snapshot.capabilityHash || '')
        || (snapshot.relayerOrigin !== null && typeof snapshot.relayerOrigin !== 'string')
        || !Number.isSafeInteger(snapshot.validUntilSeconds) || snapshot.validUntilSeconds <= 0
        || !Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0) {
      throw new Error('authorized Base claim snapshot is not canonical');
    }
    return Object.freeze(snapshot);
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
    claimAuthorizedSubmission({ checkpoint, authoritySnapshot, nowSeconds: atValue }) {
      const expected = canonicalAuthorizedClaimSnapshot(authoritySnapshot);
      if (checkpoint?.identity?.bindingId !== expected.bindingId) {
        throw new Error('authorized Base claim binding is invalid');
      }
      return transaction(() => {
        const at = safeNow(atValue);
        const row = mandateRow(expected.mandateId);
        const checkpointIdentity = checkpoint?.identity;
        const owner = checkpointIdentity && db.prepare(`
          SELECT farm.mandate_id,farm.stellar_owner,farm.kernel_address,
                 farm.binding_id,farm.binding_hash,farm.agent_index_batch_json,
                 farm.state AS farm_state
          FROM base_evidence_heads AS head
          JOIN farm_intent_work_v2 AS farm ON farm.job_id=head.job_id
          WHERE head.network_id=? AND head.binding_id=? AND head.execution_id=?
            AND head.allocation_id=? AND head.child_id=?
            AND head.job_id=? AND farm.job_id=?
        `).get(
          checkpointIdentity.networkId, checkpointIdentity.bindingId,
          checkpointIdentity.executionId, checkpointIdentity.allocationId,
          checkpointIdentity.childId, checkpointIdentity.childId, checkpointIdentity.childId,
        );
        let exactPersistedChild = false;
        try {
          const persistedBatch = owner ? JSON.parse(owner.agent_index_batch_json) : null;
          exactPersistedChild = Array.isArray(persistedBatch?.children)
            && persistedBatch.children.some((child) => (
              child?.networkId === checkpointIdentity?.networkId
              && child?.bindingId === checkpointIdentity?.bindingId
              && child?.executionId === checkpointIdentity?.executionId
              && child?.allocationId === checkpointIdentity?.allocationId
              && child?.childId === checkpointIdentity?.childId
            ));
        } catch {}
        const authorized = row
          && row.status === 'active'
          && row.session_key_envelope !== null
          && row.stellar_owner === expected.stellarOwner
          && row.kernel_address === expected.kernelAddress
          && row.binding_id === expected.bindingId
          && row.binding_hash === expected.bindingHash
          && row.capability_hash === expected.capabilityHash
          && (row.relayer_origin ?? null) === expected.relayerOrigin
          && row.valid_until_seconds === expected.validUntilSeconds
          && row.updated_at === expected.updatedAt
          && at < row.valid_until_seconds
          && owner?.mandate_id === expected.mandateId
          && owner?.stellar_owner === expected.stellarOwner
          && owner?.kernel_address === expected.kernelAddress
          && owner?.binding_id === expected.bindingId
          && owner?.binding_hash === expected.bindingHash
          && owner?.farm_state === 'deposit_confirming'
          && exactPersistedChild
          && checkpoint?.evidence?.caller === expected.kernelAddress;
        if (!authorized) {
          return {
            claimed: false, ownerToken: null, reasonCode: 'mandate_authority_changed',
          };
        }
        farmIntentFault('authorized_claim_after_authority');
        return claimBaseSubmissionInTransaction(checkpoint);
      });
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
          && acknowledgement.written >= 0
          && acknowledgement.duplicates >= 0
          && acknowledgement.written + acknowledgement.duplicates === expectedIdentities.length
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
          hasIdentityConflict: (candidate) => db.prepare(`
            SELECT * FROM cctp_relay_work
            WHERE source_domain=? AND burn_tx_hash=? AND exec_id<>?
          `).all(candidate.sourceDomain, candidate.burnTxHash, relayExecId)
            .map(cctpRowToRecord)
            .some((record) => relayIdentityConflicts(record, candidate)),
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
        const publicRow = db.prepare('SELECT job FROM jobs WHERE job_id=?').get(row.job_id);
        let publicJob;
        try {
          publicJob = publicRow ? JSON.parse(publicRow.job) : undefined;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          const reasonCode = 'malformed_public_projection';
          const blocked = db.prepare(`UPDATE farm_intent_work_v2
            SET state='blocked',reason_code=?,lease_kind=NULL,lease_token=NULL,
              lease_expires_at=NULL,updated_at=?
            WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=? AND state=?`)
            .run(
              reasonCode, atValue, row.job_id, row.mandate_id, row.binding_id,
              row.intent_digest, row.state,
            );
          if (blocked.changes !== 1) throw new Error('forward farm mint projection CAS conflict');
          writeJob(row.job_id, { jobId: row.job_id, status: 'blocked', reasonCode });
          return farmIntentRecoveryRecord(
            db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(row.job_id),
          );
        }
        if (!exactPublicJobState(publicJob, row.job_id, row.state)) {
          throw new Error('forward farm public projection conflict');
        }
        const expectation = JSON.parse(row.expectation_json);
        const batch = JSON.parse(row.agent_index_batch_json);
        const evidenceVersion = String(relay.evidenceVersion);
        const cctpImmutableEvidence = relay.nonceHex
          ? { messageDigest: canonicalD1Bytes32(relay.messageDigest), nonce: relay.nonceHex.toLowerCase() }
          : {};
        const burnEvidence = {
          burnTxHash: relay.burnTxHash,
          expectationDigest: relay.expectationDigest,
          burnUnits7: expectation.burnUnits7,
          ...cctpImmutableEvidence,
        };
        const attestationEvidence = {
          burnTxHash: relay.burnTxHash,
          expectationDigest: relay.expectationDigest,
          messageDigest: relay.nonceHex
            ? canonicalD1Bytes32(relay.messageDigest) : relay.messageDigest,
          attestationDigest: relay.nonceHex
            ? canonicalD1Bytes32(relay.attestationDigest) : relay.attestationDigest,
          evidenceVersion,
          ...cctpImmutableEvidence,
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
          writeJob(row.job_id, {
            ...(publicJob ?? { jobId: row.job_id }), status: 'deposit_pending',
          });
        }
        return farmIntentRecord(db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(row.job_id));
      });
    },
    quarantineLegacyActive({ now: atValue = now(), limit = 100 } = {}) {
      if (!Number.isSafeInteger(atValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('legacy farm quarantine limit is invalid');
      }
      return transaction(() => {
        const activeRows = db.prepare(`SELECT job_id,status FROM farm_execution_work
          WHERE status IN ('pending','running') ORDER BY created_at,job_id LIMIT ?`).all(limit);
        const doneRows = db.prepare(`SELECT job_id,status FROM farm_execution_work
          WHERE status='done' ORDER BY created_at,job_id LIMIT ?`).all(limit);
        const rows = [...activeRows, ...doneRows];
        const quarantined = [];
        for (const row of rows) {
          if (row.status === 'done') {
            writeJob(row.job_id, { jobId: row.job_id, status: 'done' });
            const removed = db.prepare(`DELETE FROM farm_execution_work
              WHERE job_id=? AND status='done'`).run(row.job_id);
            if (removed.changes !== 1) throw new Error('legacy done farm quarantine conflict');
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
    evidenceConflictAuthority({ identity }) {
      const head = db.prepare(`SELECT job_id FROM base_evidence_heads
        WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?`)
        .get(
          identity?.networkId, identity?.bindingId, identity?.executionId,
          identity?.allocationId, identity?.childId,
        );
      if (!head?.job_id) return null;
      if (db.prepare('SELECT 1 FROM farm_intent_work_v2 WHERE job_id=?').get(head.job_id)) {
        return 'v2';
      }
      if (db.prepare('SELECT 1 FROM farm_execution_work WHERE job_id=?').get(head.job_id)) {
        return 'legacy';
      }
      return null;
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
      `).all(atValue, limit).map(farmIntentRecoveryRecord);
    },
    advanceProjection({ identity, from, to, reasonCode = null, now: atValue = now() }) {
      const allowed = new Set([
        'intent_pending', 'awaiting_burn', 'relay_pending', 'deposit_pending',
        'deposit_confirming', 'done', 'blocked', 'uncertain',
      ]);
      if (!allowed.has(from) || !allowed.has(to)) throw new Error('farm projection state is invalid');
      return transaction(() => {
        const publicRow = db.prepare('SELECT job FROM jobs WHERE job_id=?').get(identity.jobId);
        let publicJob;
        try {
          publicJob = publicRow ? JSON.parse(publicRow.job) : undefined;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          const malformedReason = 'malformed_public_projection';
          const blocked = db.prepare(`
            UPDATE farm_intent_work_v2 SET state='blocked',reason_code=?,lease_kind=NULL,
              lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=? AND state=?
          `).run(
            malformedReason, atValue, identity.jobId, identity.mandateId,
            identity.bindingId, identity.intentDigest, from,
          );
          const row = db.prepare(`SELECT * FROM farm_intent_work_v2
            WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=?`)
            .get(identity.jobId, identity.mandateId, identity.bindingId, identity.intentDigest);
          if (blocked.changes !== 1
              && !(row?.state === 'blocked' && row.reason_code === malformedReason)) {
            throw new Error('farm projection CAS conflict');
          }
          writeJob(identity.jobId, {
            jobId: identity.jobId, status: 'blocked', reasonCode: malformedReason,
          });
          return farmIntentRecoveryRecord(row);
        }
        const changed = db.prepare(`
          UPDATE farm_intent_work_v2 SET state=?,reason_code=?,lease_kind=NULL,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
          WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=? AND state=?
        `).run(
          to, reasonCode, atValue, identity.jobId, identity.mandateId,
          identity.bindingId, identity.intentDigest, from,
        );
        if (changed.changes === 1
            && !exactPublicJobState(publicJob, identity.jobId, from)) {
          throw new Error('farm projection CAS conflict');
        }
        if (changed.changes !== 1) {
          const converged = db.prepare(`SELECT * FROM farm_intent_work_v2
            WHERE job_id=? AND mandate_id=? AND binding_id=? AND intent_digest=?`)
            .get(identity.jobId, identity.mandateId, identity.bindingId, identity.intentDigest);
          const exactTerminal = ['done', 'blocked', 'uncertain'].includes(to)
            && converged?.state === to
            && (converged.reason_code ?? null) === reasonCode
            && publicJob?.status === to
            && (publicJob.reasonCode ?? null) === reasonCode;
          if (!exactTerminal) throw new Error('farm projection CAS conflict');
          return farmIntentRecord(converged);
        }
        writeJob(identity.jobId, {
          ...(publicJob ?? { jobId: identity.jobId }), status: to,
          ...(reasonCode ? { reasonCode } : {}),
        });
        return farmIntentRecoveryRecord(
          db.prepare('SELECT * FROM farm_intent_work_v2 WHERE job_id=?').get(identity.jobId),
        );
      });
    },
  };

  const recoveryClaimTokens = new Map();
  const RECOVERY_TERMINAL_STATES = new Set([
    'done', 'uncertain', 'blocked', 'owner_action_required',
  ]);
  const RECOVERY_STATES = new Set([
    'pending', 'running', 'held', ...RECOVERY_TERMINAL_STATES,
  ]);
  const RECOVERY_ACTIONS = new Set([
    'poll-attestation', 'submit-mint', 'poll-mint',
    'submit-base-deposit', 'poll-base-deposit',
  ]);

  // `CREATE TABLE IF NOT EXISTS` is intentionally not treated as a migration or a
  // readiness check.  A partially-created table with the same name would otherwise make
  // recovery look durable while silently dropping a fencing column or immutable constraint.
  // Keep this local classifier closed over the actual database connection and fail the
  // readiness probe unless the exact Task 14 row shape is present.
  const BASE_RECOVERY_COLUMNS = Object.freeze([
    ['work_id', 'TEXT', 0, 1],
    ['network_id', 'TEXT', 1, 0],
    ['binding_id', 'TEXT', 1, 0],
    ['execution_id', 'TEXT', 1, 0],
    ['allocation_id', 'TEXT', 1, 0],
    ['child_id', 'TEXT', 1, 0],
    ['evidence_version', 'INTEGER', 1, 0],
    ['action', 'TEXT', 1, 0],
    ['mandate_id', 'TEXT', 1, 0],
    ['farm_job_id', 'TEXT', 0, 0],
    ['farm_intent_digest', 'TEXT', 0, 0],
    ['claim_token_digest', 'TEXT', 0, 0],
    ['state', 'TEXT', 1, 0],
    ['attempts', 'INTEGER', 1, 0],
    ['lease_owner', 'TEXT', 0, 0],
    ['lease_token', 'TEXT', 0, 0],
    ['lease_expires_at', 'INTEGER', 0, 0],
    ['checkpoint_ref', 'TEXT', 0, 0],
    ['reason_code', 'TEXT', 0, 0],
    ['created_at', 'INTEGER', 1, 0],
    ['updated_at', 'INTEGER', 1, 0],
  ]);

  function baseRecoverySchema() {
    const table = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='base_recovery_work'",
    ).get();
    const expectedNames = new Set([
      'base_recovery_work',
      'idx_base_recovery_work_resume',
      'idx_base_recovery_work_identity',
      'base_recovery_work_immutable',
    ]);
    const targetReference = /(?:^|[^a-z0-9_])base_recovery_work(?:$|[^a-z0-9_])/i;
    const related = db.prepare(`
      SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    `).all().filter(({ name, tbl_name: tableName, sql }) => (
      name === 'base_recovery_work' || tableName === 'base_recovery_work'
        || targetReference.test(String(sql))
    ));
    if (!table?.sql) {
      return related.length === 0 ? { kind: 'absent' } : { kind: 'incompatible' };
    }
    if (related.some(({ name }) => !expectedNames.has(name))) {
      return { kind: 'incompatible' };
    }
    // `table_info` omits generated/hidden columns; xinfo is required for an
    // exact readiness fingerprint rather than silently accepting extra schema.
    const columns = db.prepare('PRAGMA table_xinfo(base_recovery_work)').all();
    if (columns.length !== BASE_RECOVERY_COLUMNS.length) return { kind: 'incompatible' };
    for (const [name, type, notNull, primaryKey] of BASE_RECOVERY_COLUMNS) {
      const column = columns.find((entry) => entry.name === name);
      if (!column || column.type !== type || column.notnull !== notNull || column.pk !== primaryKey
          || column.hidden !== 0) {
        return { kind: 'incompatible' };
      }
    }
    const normalizedSql = String(table.sql).toLowerCase().replace(/\s+/g, ' ');
    const requiredSql = [
      'length(work_id) = 64',
      "claim_token_digest is null or",
      "state in ( 'pending','running','held','done','uncertain','blocked','owner_action_required' )",
      'unique(network_id,binding_id,execution_id,allocation_id,child_id,evidence_version,action)',
    ];
    if (requiredSql.some((fragment) => !normalizedSql.includes(fragment))) {
      return { kind: 'incompatible' };
    }
    const indexes = db.prepare('PRAGMA index_list(base_recovery_work)').all();
    const indexColumns = (name) => db.prepare(`PRAGMA index_info(${quoteSchemaIdentifier(name)})`)
      .all().sort((left, right) => left.seq - right.seq).map((entry) => entry.name);
    const expectedIndexes = new Map([
      ['idx_base_recovery_work_resume', {
        unique: 0, origin: 'c', partial: 0,
        columns: ['state', 'lease_expires_at', 'created_at', 'work_id'],
      }],
      ['idx_base_recovery_work_identity', {
        unique: 0, origin: 'c', partial: 0,
        columns: ['network_id', 'binding_id', 'execution_id', 'allocation_id', 'child_id'],
      }],
    ]);
    // The primary key and immutable tuple UNIQUE constraint are SQLite-owned
    // autoindexes.  Match their origin and ordered columns rather than relying
    // on version-specific autoindex names.
    const primary = indexes.find((index) => index.origin === 'pk');
    if (!primary || primary.unique !== 1 || primary.partial !== 0
        || JSON.stringify(indexColumns(primary.name)) !== JSON.stringify(['work_id'])) {
      return { kind: 'incompatible' };
    }
    const immutableUnique = indexes.find((index) => index.origin === 'u');
    if (!immutableUnique || immutableUnique.unique !== 1 || immutableUnique.partial !== 0
        || JSON.stringify(indexColumns(immutableUnique.name)) !== JSON.stringify([
          'network_id', 'binding_id', 'execution_id', 'allocation_id', 'child_id',
          'evidence_version', 'action',
        ])) {
      return { kind: 'incompatible' };
    }
    if (indexes.some((index) => index.origin !== 'pk' && index.origin !== 'u'
        && !expectedIndexes.has(index.name))) {
      return { kind: 'incompatible' };
    }
    const hasIndex = (name, expected) => indexes.some((index) => (
      index.name === name
      && index.unique === expected.unique
      && index.origin === expected.origin
      && index.partial === expected.partial
      && JSON.stringify(indexColumns(index.name)) === JSON.stringify(expected.columns)
    ));
    if (!hasIndex(
      'idx_base_recovery_work_resume', expectedIndexes.get('idx_base_recovery_work_resume'),
    ) || !hasIndex(
      'idx_base_recovery_work_identity', expectedIndexes.get('idx_base_recovery_work_identity'),
    )) {
      return { kind: 'incompatible' };
    }
    const triggers = db.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='base_recovery_work'",
    ).all();
    if (triggers.length !== 1 || triggers[0].name !== 'base_recovery_work_immutable'
        || !triggers[0].sql) {
      return { kind: 'incompatible' };
    }
    const triggerSql = normalizedSchemaSql(triggers[0].sql).toLowerCase();
    const triggerFragments = [
      'before update of work_id,network_id,binding_id,execution_id,allocation_id,child_id,',
      'evidence_version,action,mandate_id,farm_job_id,farm_intent_digest,created_at',
      'on base_recovery_work',
      "raise(abort,'immutable base recovery work')",
    ];
    if (triggerFragments.some((fragment) => !triggerSql.includes(fragment))) {
      return { kind: 'incompatible' };
    }
    return { kind: 'current' };
  }

  function recoveryNow(value) {
    const at = value ?? now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Base recovery time is invalid');
    return at;
  }

  function recoveryIdentityFromRow(row) {
    return {
      networkId: row.network_id,
      bindingId: row.binding_id,
      executionId: row.execution_id,
      allocationId: row.allocation_id,
      childId: row.child_id,
    };
  }

  function assertRecoveryRow(row) {
    if (typeof row.work_id !== 'string' || !/^[0-9a-f]{64}$/.test(row.work_id)
        || !RECOVERY_ACTIONS.has(row.action) || !RECOVERY_STATES.has(row.state)
        || !Number.isSafeInteger(row.evidence_version) || row.evidence_version < 0
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0
        || !Number.isSafeInteger(row.created_at) || row.created_at < 0
        || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0
        || !/^[0-9a-f]{32}$/.test(row.mandate_id)
        || [row.network_id, row.binding_id, row.execution_id, row.allocation_id, row.child_id]
          .some((value) => typeof value !== 'string' || !value)
        || (row.farm_intent_digest != null && !DIGEST_RE.test(row.farm_intent_digest))
        || (row.claim_token_digest != null && !DIGEST_RE.test(row.claim_token_digest))) {
      throw new Error('malformed Base recovery work row');
    }
  }

  function recoveryRecord(row, { includeLease = true, includeClaimToken = false } = {}) {
    if (!row) return null;
    assertRecoveryRow(row);
    const result = {
      workId: row.work_id,
      identity: recoveryIdentityFromRow(row),
      evidenceVersion: row.evidence_version,
      action: row.action,
      mandateId: row.mandate_id,
      farmJobId: row.farm_job_id ?? null,
      farmIntentDigest: row.farm_intent_digest ?? null,
      state: row.state,
      attempts: row.attempts,
      checkpointRef: row.checkpoint_ref ?? null,
      reasonCode: row.reason_code ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (includeLease) {
      result.leaseOwner = row.lease_owner ?? null;
      result.leaseToken = row.lease_token ?? null;
      result.leaseExpiresAt = row.lease_expires_at ?? null;
      if (includeClaimToken) result.claimToken = recoveryClaimTokens.get(row.work_id) ?? null;
    }
    return result;
  }

  function recoveryImmutableMatches(row, input) {
    return row.work_id === input.workId
      && row.network_id === input.identity.networkId
      && row.binding_id === input.identity.bindingId
      && row.execution_id === input.identity.executionId
      && row.allocation_id === input.identity.allocationId
      && row.child_id === input.identity.childId
      && row.evidence_version === input.evidenceVersion
      && row.action === input.action
      && row.mandate_id === input.mandateId
      && (row.farm_job_id ?? null) === (input.farmJobId ?? null)
      && (row.farm_intent_digest ?? null) === (input.farmIntentDigest ?? null);
  }

  function recoveryClaimDigest(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error('Base recovery claim token is invalid');
    }
    return createHash('sha256').update(value).digest('hex');
  }

  const baseRecoveryWorks = {
    workId(input) {
      return computeBaseRecoveryWorkId(input);
    },

    enqueue(input) {
      const identity = input?.identity;
      if (!identity || typeof identity !== 'object') throw new Error('Base recovery identity is required');
      const workId = input.workId ?? computeBaseRecoveryWorkId(input);
      if (typeof input.mandateId !== 'string' || !/^[0-9a-f]{32}$/.test(input.mandateId)) {
        throw new Error('mandateId is invalid');
      }
      const farmIntentDigest = input.farmIntentDigest ?? null;
      if (farmIntentDigest !== null && !DIGEST_RE.test(farmIntentDigest)) {
        throw new Error('farmIntentDigest is invalid');
      }
      const at = recoveryNow(input.now);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId);
        if (existing) {
          if (!recoveryImmutableMatches(existing, { ...input, workId, farmIntentDigest })) {
            const conflict = new Error('immutable Base recovery work conflict');
            conflict.code = 'BASE_RECOVERY_WORK_CONFLICT';
            throw conflict;
          }
          return recoveryRecord(existing);
        }
        // A caller retrying an existing work ID must be classified against the
        // persisted immutable tuple before re-deriving the ID.  Re-derivation
        // validates the tuple's cross-field mapping and would otherwise mask a
        // typed immutable-conflict response (for example, a changed execution
        // ID) with an input-shape error.
        const computedWorkId = computeBaseRecoveryWorkId(input);
        if (workId !== computedWorkId) throw new Error('Base recovery work ID mismatch');
        db.prepare(`
          INSERT INTO base_recovery_work (
            work_id,network_id,binding_id,execution_id,allocation_id,child_id,evidence_version,action,
            mandate_id,farm_job_id,farm_intent_digest,claim_token_digest,state,attempts,
            lease_owner,lease_token,lease_expires_at,checkpoint_ref,reason_code,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL,NULL,NULL,NULL,NULL,?,?)
        `).run(
          workId, identity.networkId, identity.bindingId, identity.executionId,
          identity.allocationId, identity.childId, input.evidenceVersion, input.action,
          input.mandateId, input.farmJobId ?? null, farmIntentDigest,
          recoveryClaimDigest(input.claimToken ?? input.leaseToken), at, at,
        );
        const claimToken = input.claimToken ?? input.leaseToken;
        if (claimToken) recoveryClaimTokens.set(workId, claimToken);
        return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
      });
    },

    get(workId) {
      return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
    },

    // The raw Agent Index token remains process-memory-only. It is exposed only through this
    // narrow executor seam; public work/status records never carry it.
    getClaimToken(workId) {
      return recoveryClaimTokens.get(workId) ?? null;
    },

    claim({ workId, holder, now: claimAt, leaseMs = 30_000 } = {}) {
      if (typeof holder !== 'string' || !holder) throw new Error('Base recovery lease holder is required');
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Base recovery lease is invalid');
      const at = recoveryNow(claimAt);
      const result = transaction(() => {
        const expiredWorkIds = db.prepare(`
          SELECT work_id FROM base_recovery_work
          WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
        `).all(at).map((row) => row.work_id);
        db.prepare(`
          UPDATE base_recovery_work
          SET state='held',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
        `).run(at, at);
        const token = String(leaseToken());
        const row = db.prepare(`
          UPDATE base_recovery_work
          SET state='running',lease_owner=?,lease_token=?,lease_expires_at=?,attempts=attempts+1,updated_at=?
          WHERE work_id=? AND state='pending' AND (lease_token IS NULL OR lease_expires_at<=?)
          RETURNING *
        `).get(holder, token, at + leaseMs, at, workId, at);
        return { row, expiredWorkIds };
      });
      // A local lease expiry invalidates the remote Agent Index proof as well. Keep
      // the durable row held, but require a fresh owner proof before it can resume.
      for (const expiredWorkId of result.expiredWorkIds) recoveryClaimTokens.delete(expiredWorkId);
      return recoveryRecord(result.row);
    },

    heartbeat({ workId, holder, leaseToken: token, now: heartbeatAt, leaseMs = 30_000 } = {}) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Base recovery lease is invalid');
      const at = recoveryNow(heartbeatAt);
      const changed = db.prepare(`
        UPDATE base_recovery_work SET lease_expires_at=?,updated_at=?
        WHERE work_id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_expires_at>?
      `).run(at + leaseMs, at, workId, holder, token, at);
      return changed.changes === 1
        ? recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId))
        : null;
    },

    checkpoint({ workId, holder, leaseToken: token, checkpointRef = null, reasonCode = null, now: checkpointAt } = {}) {
      const at = recoveryNow(checkpointAt);
      const changed = db.prepare(`
        UPDATE base_recovery_work SET checkpoint_ref=?,reason_code=?,updated_at=?
        WHERE work_id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_expires_at>?
      `).run(checkpointRef, reasonCode, at, workId, holder, token, at);
      return changed.changes === 1
        ? recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId))
        : null;
    },

    hold({ workId, holder, leaseToken: token, reasonCode = null, now: holdAt } = {}) {
      const at = recoveryNow(holdAt);
      const changed = db.prepare(`
        UPDATE base_recovery_work
        SET state='held',reason_code=?,lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
        WHERE work_id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_expires_at>?
      `).run(reasonCode, at, workId, holder, token, at);
      if (changed.changes !== 1) return null;
      recoveryClaimTokens.delete(workId);
      return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
    },

    finish({
      workId, holder, leaseToken: token, state, reasonCode = null,
      checkpointRef = null, now: finishAt,
    } = {}) {
      if (!RECOVERY_TERMINAL_STATES.has(state)) throw new Error('Base recovery terminal state is invalid');
      const at = recoveryNow(finishAt);
      const changed = db.prepare(`
        UPDATE base_recovery_work
        SET state=?,reason_code=?,checkpoint_ref=?,lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
        WHERE work_id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_expires_at>?
      `).run(state, reasonCode, checkpointRef, at, workId, holder, token, at);
      if (changed.changes === 1) {
        recoveryClaimTokens.delete(workId);
        return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
      }
      const row = db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId);
      return row && RECOVERY_TERMINAL_STATES.has(row.state) ? recoveryRecord(row) : null;
    },

    reopen({ workId, claimToken, proven = false, now: reopenAt } = {}) {
      const at = recoveryNow(reopenAt);
      const digest = recoveryClaimDigest(claimToken);
      const changed = db.prepare(`
        UPDATE base_recovery_work
        SET state='pending',claim_token_digest=?,updated_at=?
        WHERE work_id=? AND state='held' AND ?=1
      `).run(digest, at, workId, proven ? 1 : 0);
      if (changed.changes !== 1) return null;
      recoveryClaimTokens.set(workId, claimToken);
      return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
    },

    // A fresh owner-proven Agent Index claim may reattach a token after a process restart or
    // expired local lease. This CAS never replaces a live runner or terminal work, and only
    // updates the token digest plus the in-memory process handoff; immutable work facts,
    // attempts, and creation time remain untouched.
    reattachProven({ workId, claimToken, proven = false, now: reattachAt } = {}) {
      if (proven !== true) return null;
      const at = recoveryNow(reattachAt);
      const digest = recoveryClaimDigest(claimToken);
      const changed = transaction(() => db.prepare(`
        UPDATE base_recovery_work
        SET state='pending',claim_token_digest=?,lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
        WHERE work_id=? AND state IN ('pending','held')
          AND (
            (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
            OR (lease_expires_at IS NOT NULL AND lease_expires_at<=?)
          )
      `).run(digest, at, workId, at).changes);
      if (changed !== 1) return null;
      recoveryClaimTokens.set(workId, claimToken);
      return recoveryRecord(db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId));
    },

    reopenHeld(input = {}) {
      return this.reopen(input);
    },

    reconcileExpired({ now: reconcileAt = now(), limit = 100 } = {}) {
      const at = recoveryNow(reconcileAt);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Base recovery limit is invalid');
      const expiredWorkIds = transaction(() => {
        const rows = db.prepare(`
          SELECT work_id FROM base_recovery_work
          WHERE state='running' AND lease_expires_at<=?
          ORDER BY lease_expires_at,created_at,work_id LIMIT ?
        `).all(at, limit);
        db.prepare(`
          UPDATE base_recovery_work
          SET state='held',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE work_id IN (
            SELECT work_id FROM base_recovery_work
            WHERE state='running' AND lease_expires_at<=?
            ORDER BY lease_expires_at,created_at,work_id LIMIT ?
          )
        `).run(at, at, limit);
        return rows.map((row) => row.work_id);
      });
      for (const expiredWorkId of expiredWorkIds) recoveryClaimTokens.delete(expiredWorkId);
      return expiredWorkIds.length;
    },

    listRecoverable({ now: listAt = now(), limit = 100 } = {}) {
      this.reconcileExpired({ now: listAt, limit });
      // A single quarantined/corrupt row must not prevent later recoverable work from
      // resuming.  The readiness probe still fails for a malformed schema; this guard is
      // for row-level corruption discovered after a prior successful probe.
      const recoverable = [];
      let cursor = null;
      while (recoverable.length < limit) {
        const rows = cursor
          ? db.prepare(`
            SELECT * FROM base_recovery_work
            WHERE state IN ('pending','held')
              AND (created_at > ? OR (created_at=? AND work_id>?))
            ORDER BY created_at,work_id LIMIT ?
          `).all(cursor.created_at, cursor.created_at, cursor.work_id, limit)
          : db.prepare(`
            SELECT * FROM base_recovery_work
            WHERE state IN ('pending','held')
            ORDER BY created_at,work_id LIMIT ?
        `).all(limit);
        if (rows.length === 0) break;
        for (const row of rows) {
          // A restart-held row is durable metadata, not runnable work, until this
          // process receives a fresh proven Agent Index claim.  The raw token is
          // deliberately process-memory-only, so skip unbacked rows before they
          // consume the bounded result budget; keyset pagination advances past
          // them and gives later reattached work a fair chance.
          if (!recoveryClaimTokens.has(row.work_id)) continue;
          try {
            recoverable.push(recoveryRecord(row));
            if (recoverable.length >= limit) break;
          } catch {
            // Skip the corrupt row and continue the keyset page so it cannot
            // starve later valid work under a small result limit.
          }
        }
        const last = rows.at(-1);
        cursor = { created_at: last.created_at, work_id: last.work_id };
        if (rows.length < limit) break;
      }
      return recoverable;
    },

    status(workId) {
      const row = db.prepare('SELECT * FROM base_recovery_work WHERE work_id=?').get(workId);
      if (!row) return null;
      return {
        workId: row.work_id,
        state: row.state,
        attempts: row.attempts,
        evidenceVersion: row.evidence_version,
        action: row.action,
      };
    },
  };

  // A process restart cannot prove that a pre-dispatch Agent Index claim is still live. Pending
  // rows are therefore held on reopen; only a fresh owner-proven claim may call reopen(). Expired
  // running leases are held as well, and never become an implicit permission to resend.
  db.prepare(`
    UPDATE base_recovery_work
    SET state='held',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE state='pending' OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?) )
  `).run(now(), now());

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
    try {
      return assertCanonicalRelayRecord(cctpRecordFromRawRow(row));
    } catch (error) {
      if (error?.code === 'RELAY_VALIDATION') throw error;
      throw relayError('RELAY_VALIDATION', 'persisted relay expectation encoding is invalid');
    }
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
          hasIdentityConflict: (candidate) => db.prepare(`
            SELECT * FROM cctp_relay_work
            WHERE source_domain=? AND burn_tx_hash=? AND exec_id<>?
          `).all(candidate.sourceDomain, candidate.burnTxHash, execId)
            .map(cctpRowToRecord)
            .some((record) => relayIdentityConflicts(record, candidate)),
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
      return relayTransaction(() => {
        // Validate durable truth under the same write lock before SQLite evaluates the
        // hardened CHECKs on UPDATE. A bypass-injected corrupt row therefore yields the
        // stable relay validation contract and never acquires a lease or leaks raw SQL.
        const current = cctpGet(execId);
        if (!current || !RELAY_CLAIMABLE_STATES.includes(current.state)
            || current.leaseToken !== null) return null;
        const row = db.prepare(`
          UPDATE cctp_relay_work
          SET attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE exec_id = ? AND state IN ('attestation_pending','attested','mint_submitted')
            AND lease_token IS NULL
          RETURNING *
        `).get(randomUUID(), claimNow + leaseMs, claimNow, execId);
        return cctpRowToRecord(row);
      });
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
        : `SELECT * FROM cctp_relay_work
           WHERE state IN ('attestation_pending','attested','mint_submitted')
             AND lease_token IS NULL
           ORDER BY updated_at,created_at,exec_id LIMIT ?`)
        .all(...(includeTerminal ? [limit] : [limit]));
      return rows.map(cctpRowToRecord);
    },

    listSweepSummary({ now: summaryNow, limit }) {
      requireSweepArgs(summaryNow, limit);
      return db.prepare(`
        SELECT * FROM cctp_relay_work
        WHERE state IN ('blocked','uncertain') OR lease_token IS NOT NULL
        ORDER BY created_at,exec_id LIMIT ?
      `).all(limit).map(cctpRowToRecord);
    },

    reconcileExpired({ now: reconcileNow, limit }) {
      requireSweepArgs(reconcileNow, limit);
      return relayTransaction(() => {
        const rows = db.prepare(`
          SELECT * FROM cctp_relay_work
          WHERE state IN ('attestation_pending','attested','mint_submitting','mint_submitted')
            AND lease_token IS NOT NULL AND lease_expires_at <= ?
          ORDER BY lease_expires_at,created_at,exec_id LIMIT ?
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

    reconcileOne({ execId, now: reconcileNow }) {
      if (!Number.isSafeInteger(reconcileNow) || reconcileNow < 0) {
        throw relayError('RELAY_VALIDATION', 'relay reconciliation requires a non-negative safe-integer now');
      }
      return relayTransaction(() => {
        const row = db.prepare('SELECT * FROM cctp_relay_work WHERE exec_id=?').get(execId);
        if (!row) return null;
        const current = cctpRowToRecord(row);
        if (['minted', 'blocked', 'uncertain'].includes(current.state)
            || current.leaseToken === null || current.leaseExpiresAt > reconcileNow) {
          return current;
        }
        const next = relayReconcileExpired(current, reconcileNow);
        const result = db.prepare(`
          UPDATE cctp_relay_work
          SET state=?,reason_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE exec_id=? AND state=? AND lease_token=? AND lease_expires_at<=?
        `).run(
          next.state, next.reasonCode, reconcileNow, current.execId, current.state,
          current.leaseToken, reconcileNow,
        );
        if (result.changes !== 1) {
          throw relayError('RELAY_CAS_CONFLICT', 'relay reconciliation conflicts with the durable record (zero-row conditional update)');
        }
        return next;
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
      if (classifyCctpRelaySchema(db).kind !== 'current') {
        throw new Error('CCTP relay-work schema ensemble is incompatible');
      }
      if (classifyUnwindSchema(db).kind !== 'current') {
        throw new Error('unwind authority schema ensemble is incompatible');
      }
      if (baseRecoverySchema().kind !== 'current') {
        throw new Error('Base recovery-work schema ensemble is incompatible');
      }
      db.prepare('UPDATE jobs SET job = job WHERE 0').run();
      db.prepare('SELECT id FROM association_outbox WHERE 0').all();
      db.prepare('SELECT job_id FROM farm_execution_work WHERE 0').all();
      db.prepare('SELECT job_id FROM farm_intent_work_v2 WHERE 0').all();
      db.prepare('SELECT network_id FROM base_evidence_heads WHERE 0').all();
      db.prepare('SELECT event_id FROM base_evidence_outbox WHERE 0').all();
      db.prepare('SELECT work_id FROM base_recovery_work WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandates_v3 WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandate_activation_work WHERE 0').all();
      db.prepare('SELECT exec_id FROM cctp_relay_work WHERE 0').all();
      db.prepare('SELECT job_id FROM unwind_jobs WHERE 0').all();
      return {
        writable: true,
        baseEvidenceDurable: true,
        baseRecoveryWorkDurable: true,
        farmIntentDurable: true,
        unwindDurable: true,
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
    baseRecoveryWorks,
    // Singular alias keeps composition resilient while callers migrate to the plural name.
    baseRecoveryWork: baseRecoveryWorks,
    recoveryWorks: baseRecoveryWorks,
    farmExecutions,
    farmIntents,
    cctpRelays,
    unwindJobs,
    probe,
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StrKey } from '@stellar/stellar-sdk';
import { parseCanonicalMandate } from './base/canonicalMandate.mjs';
import {
  MANDATE_V3_SCHEMA,
  canonicalMandateMigrationDestinationDigest as canonicalDestinationDigest,
  classifyMandateSchemaEnsemble,
  mandateMigrationTargetDigest as migrationTargetDigest,
  mandateSessionAad,
  persistedMandateMigrationDestinationDigest as persistedDestinationDigest,
} from './sqliteStores.mjs';

const OFFLINE_FLAG = 'RELAYER_OFFLINE_KEY_MIGRATION';
const MANIFEST_VERSION = 1;
const MIGRATED_STATUS = 'activation_uncertain';
const QUARANTINED_STATUS = 'revoked';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireOffline(env) {
  if (env?.[OFFLINE_FLAG] !== '1') {
    throw new Error(`${OFFLINE_FLAG}=1 is required for offline mandate migration`);
  }
}

function useMemoryTempStore(db) {
  db.exec('PRAGMA temp_store=MEMORY');
}

const LEGACY_V1_COLUMNS = [
  ['approval', 'TEXT', 0, 1],
  ['session_key', 'TEXT', 1, 0],
  ['expires_at', 'INTEGER', 1, 0],
];
const LEGACY_V2_COLUMNS = [
  ['serialized_approval', 'TEXT', 1, 1],
  ['stellar_owner', 'TEXT', 1, 2],
  ['kernel_address', 'TEXT', 1, 3],
  ['session_private_key', 'TEXT', 1, 0],
  ['session_key_address', 'TEXT', 1, 0],
  ['relayer_origin', 'TEXT', 0, 0],
  ['expires_at', 'INTEGER', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['binding_id', 'TEXT', 0, 0],
  ['binding_hash', 'TEXT', 0, 0],
  ['created_at', 'INTEGER', 1, 0],
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function columnSignature(db, table) {
  const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all();
  if (columns.some(({ hidden }) => hidden !== 0)) {
    throw new Error('legacy mandate source schema is unexpected');
  }
  return columns.map(({ name, type, notnull, pk }) => [name, type, notnull, pk]);
}

function sameColumns(actual, expected) {
  return actual.length === expected.length
    && actual.every((column, index) => column.every((value, part) => value === expected[index][part]));
}

function legacyTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND lower(name) IN ('mandates', 'mandates_v2')
    ORDER BY lower(name), name
  `).all().map(({ name }) => ({ name, kind: name.toLowerCase() }));
}

const LEGACY_V1_SCHEMA = `
  CREATE TABLE mandates (
    approval TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`;
const LEGACY_V2_SCHEMA = `
  CREATE TABLE mandates_v2 (
    serialized_approval TEXT NOT NULL,
    stellar_owner TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    session_private_key TEXT NOT NULL,
    session_key_address TEXT NOT NULL,
    relayer_origin TEXT,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    binding_id TEXT,
    binding_hash TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (serialized_approval, stellar_owner, kernel_address)
  )
`;

function normalizedLegacyBody(sql) {
  const normalized = String(sql || '').trim().replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1');
  const bodyStart = normalized.indexOf('(');
  return bodyStart === -1 ? normalized : normalized.slice(bodyStart);
}

let legacySchemaBodies;

function canonicalLegacySchemaBodies() {
  if (legacySchemaBodies) return legacySchemaBodies;
  const reference = new DatabaseSync(':memory:');
  try {
    useMemoryTempStore(reference);
    reference.exec(LEGACY_V1_SCHEMA);
    reference.exec(LEGACY_V2_SCHEMA);
    const v1 = normalizedLegacyBody(reference.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mandates'
    `).get().sql);
    const v2 = normalizedLegacyBody(reference.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mandates_v2'
    `).get().sql);
    reference.exec('ALTER TABLE mandates_v2 ADD COLUMN permission_id TEXT');
    const v2WithPermission = normalizedLegacyBody(reference.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mandates_v2'
    `).get().sql);
    legacySchemaBodies = { v1, v2, v2WithPermission };
    return legacySchemaBodies;
  } finally {
    reference.close();
  }
}

function validateLegacyObjects(db, table) {
  const actualName = table.name;
  const tableRow = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(actualName);
  const indexes = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ? ORDER BY name
  `).all(actualName);
  if (indexes.length !== 1 || indexes[0].sql !== null) {
    throw new Error('legacy mandate source schema is unexpected');
  }
  const indexColumns = db.prepare(`PRAGMA index_info(${quoteIdentifier(indexes[0].name)})`).all()
    .map(({ name }) => name);
  const expectedIndexColumns = table.kind === 'mandates'
    ? ['approval'] : ['serialized_approval', 'stellar_owner', 'kernel_address'];
  if (JSON.stringify(indexColumns) !== JSON.stringify(expectedIndexColumns)
    || db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(actualName)})`).all().length !== 0) {
    throw new Error('legacy mandate source schema is unexpected');
  }
  const legacyReference = new RegExp(
    `(?:^|[^a-z0-9_])${table.kind}(?:$|[^a-z0-9_])`,
    'i',
  );
  const dependencies = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  `).all().filter(({ type, name, sql }) => (
    !(type === 'table' && name === actualName)
    && legacyReference.test(String(sql))
  ));
  if (dependencies.length !== 0) {
    throw new Error('legacy mandate source schema has unexpected dependencies');
  }
  return {
    sqlBody: normalizedLegacyBody(tableRow?.sql),
    indexColumns,
  };
}

function validateLegacySchema(db, table) {
  const actual = columnSignature(db, table.name);
  const objects = validateLegacyObjects(db, table);
  const references = canonicalLegacySchemaBodies();
  if (table.kind === 'mandates') {
    if (!sameColumns(actual, LEGACY_V1_COLUMNS) || objects.sqlBody !== references.v1) {
      throw new Error('legacy mandate source schema is unexpected');
    }
  } else {
    const withPermission = [...LEGACY_V2_COLUMNS, ['permission_id', 'TEXT', 0, 0]];
    const base = sameColumns(actual, LEGACY_V2_COLUMNS) && objects.sqlBody === references.v2;
    const extended = sameColumns(actual, withPermission)
      && objects.sqlBody === references.v2WithPermission;
    if (!base && !extended) {
      throw new Error('legacy mandate source schema is unexpected');
    }
  }
  return { columns: actual, schemaDigest: digest(JSON.stringify(objects)) };
}

function legacyRows(db) {
  const discovered = legacyTables(db);
  if (discovered.length === 0) {
    throw new Error('legacy mandate tables are missing or already migrated');
  }
  const schemas = discovered.map((table) => ({
    name: table.name,
    kind: table.kind,
    ...validateLegacySchema(db, table),
  }));
  const rows = [];
  for (const table of discovered) {
    const quoted = quoteIdentifier(table.name);
    if (table.kind === 'mandates') {
      rows.push(...db.prepare(`
        SELECT rowid AS source_rowid, approval, session_key,
               typeof(expires_at) AS expires_at_type,
               CAST(expires_at AS TEXT) AS expires_at_text
        FROM ${quoted} ORDER BY approval, rowid
      `).all().map((row) => ({ table: table.kind, row })));
    } else {
      const permission = schemas.find(({ name }) => name === table.name).columns
        .some(([name]) => name === 'permission_id') ? ', permission_id' : '';
      rows.push(...db.prepare(`
        SELECT rowid AS source_rowid, serialized_approval, stellar_owner, kernel_address,
               session_private_key, session_key_address, relayer_origin,
               typeof(expires_at) AS expires_at_type,
               CAST(expires_at AS TEXT) AS expires_at_text,
               status, binding_id, binding_hash, created_at${permission}
        FROM ${quoted}
        ORDER BY serialized_approval, stellar_owner, kernel_address, rowid
      `).all().map((row) => ({ table: table.kind, row })));
    }
  }
  return { tables: discovered.map(({ name }) => name), schemas, rows };
}

function rowDigest(source) {
  const values = Object.keys(source.row).sort().map((key) => [key, source.row[key]]);
  return digest(JSON.stringify([source.table, values]));
}

function sourceDigest(tables, schemas, entries) {
  return digest(JSON.stringify([
    'vf-legacy-mandate-source-v1',
    tables,
    schemas,
    entries.map(({ rowDigest: value, outcome, reason, destinationDigest }) => [
      value,
      outcome,
      reason ?? null,
      destinationDigest,
    ]),
  ]));
}

function exactExpirySeconds(row) {
  if (row.expires_at_type !== 'integer' || !/^-?\d+$/.test(row.expires_at_text || '')) {
    throw new Error('legacy expiry must be an exact SQLite integer');
  }
  const milliseconds = BigInt(row.expires_at_text);
  if (milliseconds <= 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('legacy expiry must be a positive safe integer');
  }
  if (milliseconds % 1000n !== 0n) {
    throw new Error('legacy expiry must convert losslessly to canonical seconds');
  }
  const seconds = Number(milliseconds / 1000n);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('legacy expiry seconds are invalid');
  }
  return seconds;
}

function sameAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function validateParsedFacts(parsed, row, validUntilSeconds) {
  if (!parsed || !sameAddress(parsed.accountAddress, row.kernel_address)
    || !sameAddress(parsed.sessionKeyAddress, row.session_key_address)
    || parsed.stellarOwner !== row.stellar_owner
    || parsed.validUntilSeconds !== validUntilSeconds) {
    throw new Error('canonical approval identity or expiry does not match the legacy row');
  }
  if (row.permission_id !== undefined && parsed.permissionId !== row.permission_id) {
    throw new Error('canonical approval permission does not match the legacy row');
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.policyDigest || '')) {
    throw new Error('canonical policy digest is required');
  }
}

function canonicalV2(source, { config, parseCanonicalApproval }) {
  const row = source.row;
  const validUntilSeconds = exactExpirySeconds(row);
  if (typeof row.binding_id !== 'string' || !row.binding_id) {
    throw new Error('legacy binding ID is required');
  }
  if (typeof row.binding_hash !== 'string' || !row.binding_hash) {
    throw new Error('legacy binding hash is required');
  }
  const expectedBinding = digest(
    `${row.stellar_owner}|${row.kernel_address}|${row.session_key_address}|${validUntilSeconds}`,
  );
  if (row.binding_hash !== expectedBinding) {
    throw new Error('legacy binding hash is not canonical for the seconds expiry');
  }
  if (row.status !== 'active') throw new Error('legacy mandate status is not migratable');

  const parserInput = {
    serializedApproval: row.serialized_approval,
    sessionPrivateKey: row.session_private_key,
    sessionKeyAddress: row.session_key_address,
    stellarOwner: row.stellar_owner,
    kernelAddress: row.kernel_address,
    validUntilSeconds,
    expiresAt: validUntilSeconds,
    relayerOrigin: row.relayer_origin ?? undefined,
    bindingId: row.binding_id,
    bindingHash: row.binding_hash,
    config,
  };
  if (row.permission_id !== undefined) parserInput.permissionId = row.permission_id;
  const parsed = parseCanonicalApproval(parserInput);
  validateParsedFacts(parsed, row, validUntilSeconds);
  const kernelAddress = row.kernel_address.toLowerCase();
  const sessionKeyAddress = row.session_key_address.toLowerCase();
  return {
    approvalDigest: digest(row.serialized_approval),
    policyDigest: parsed.policyDigest,
    serializedApproval: row.serialized_approval,
    stellarOwner: row.stellar_owner,
    kernelAddress,
    sessionPrivateKey: row.session_private_key,
    sessionKeyDigest: digest(row.session_private_key),
    sessionKeyAddress,
    relayerOrigin: row.relayer_origin ?? null,
    validUntilSeconds,
    bindingId: row.binding_id,
    bindingHash: digest(
      `${row.stellar_owner}|${kernelAddress}|${sessionKeyAddress}|${validUntilSeconds}`,
    ),
    permissionId: parsed.permissionId ?? row.permission_id ?? null,
    createdAt: Number.isSafeInteger(row.created_at)
      ? Math.floor(row.created_at / 1000) : validUntilSeconds,
  };
}

function tombstoneIdentity(row) {
  return {
    stellarOwner: typeof row.stellar_owner === 'string'
      && StrKey.isValidEd25519PublicKey(row.stellar_owner)
      ? row.stellar_owner : null,
    kernelAddress: typeof row.kernel_address === 'string'
      && EVM_ADDRESS_RE.test(row.kernel_address)
      ? row.kernel_address.toLowerCase() : null,
  };
}

function revokedRecord(source) {
  const row = source.row;
  return {
    approvalDigest: digest(String(row.serialized_approval || '')),
    ...tombstoneIdentity(row),
    quarantineReason: 'LEGACY_REVOKED',
  };
}

function quarantineRecord(source) {
  const row = source.row;
  const serializedApproval = source.table === 'mandates_v2'
    ? row.serialized_approval : row.approval;
  return {
    approvalDigest: digest(String(serializedApproval || '')),
    ...(source.table === 'mandates_v2'
      ? tombstoneIdentity(row)
      : { stellarOwner: null, kernelAddress: null }),
    quarantineReason: 'NONCANONICAL_LEGACY_ROW',
  };
}

function inspectDatabase(db, {
  config,
  parseCanonicalApproval = parseCanonicalMandate,
  quarantineInvalid = false,
}) {
  const source = legacyRows(db);
  const inspected = [];
  for (const item of source.rows) {
    const itemDigest = rowDigest(item);
    if (item.table === 'mandates_v2' && item.row.status === 'revoked') {
      inspected.push({
        rowDigest: itemDigest,
        outcome: QUARANTINED_STATUS,
        reason: 'LEGACY_REVOKED',
        record: revokedRecord(item),
      });
      continue;
    }
    try {
      if (item.table === 'mandates') {
        throw new Error('legacy v1 mandate has no identity or binding');
      }
      inspected.push({
        rowDigest: itemDigest,
        outcome: 'migrate',
        record: canonicalV2(item, { config, parseCanonicalApproval }),
      });
    } catch {
      if (!quarantineInvalid) {
        throw new Error('legacy mandate row is noncanonical or invalid');
      }
      inspected.push({
        rowDigest: itemDigest,
        outcome: QUARANTINED_STATUS,
        reason: 'NONCANONICAL_LEGACY_ROW',
        record: quarantineRecord(item),
      });
    }
  }
  const entries = inspected.map(({ rowDigest: value, outcome, reason, record }) => ({
    rowDigest: value,
    outcome,
    destinationDigest: canonicalDestinationDigest({ outcome, record }),
    ...(reason ? { reason } : {}),
  }));
  const boundInspected = inspected.map((entry, index) => ({
    ...entry,
    destinationDigest: entries[index].destinationDigest,
  }));
  return {
    manifest: {
      version: MANIFEST_VERSION,
      sourceDigest: sourceDigest(source.tables, source.schemas, entries),
      entries,
    },
    inspected: boundInspected,
    tables: source.tables,
    schemas: source.schemas,
  };
}

function inspect(path, options) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    useMemoryTempStore(db);
    return inspectDatabase(db, options);
  } finally {
    db.close();
  }
}

function sameManifest(actual, expected) {
  return actual && JSON.stringify(actual) === JSON.stringify(expected);
}

function requireCipher(sessionKeyCipher) {
  if (typeof sessionKeyCipher?.seal !== 'function' || typeof sessionKeyCipher?.open !== 'function') {
    throw new Error('session-key cipher is required for legacy mandate migration');
  }
  return sessionKeyCipher;
}

function verifySessionEnvelope(cipher, envelope, aad, expectedPlaintext, expectedDigest) {
  const opened = cipher.open(envelope, aad);
  if (typeof envelope !== 'string' || !envelope
    || typeof opened?.plaintext !== 'string'
    || opened.plaintext !== expectedPlaintext
    || digest(opened.plaintext) !== expectedDigest) {
    throw new Error('session envelope verification mismatch');
  }
}

function persistedSessionAad(row) {
  return mandateSessionAad({
    mandateId: row.mandate_id,
    approvalDigest: row.approval_digest,
    policyDigest: row.policy_digest,
    stellarOwner: row.stellar_owner,
    kernelAddress: row.kernel_address,
    sessionKeyAddress: row.session_key_address,
    validUntilSeconds: row.valid_until_seconds,
    bindingId: row.binding_id,
  });
}

function validateTarget(db) {
  const ensemble = classifyMandateSchemaEnsemble(db);
  if (ensemble.kind === 'absent') return;
  if (ensemble.kind !== 'current' || ensemble.migrationState.phase !== 'virgin') {
    throw new Error('mandate migration target ensemble is incompatible');
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n !== 0
    || db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n !== 0) {
    throw new Error('mandates were already migrated');
  }
}

function migrationDisposition(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    useMemoryTempStore(db);
    db.exec('PRAGMA foreign_keys=ON');
    const ensemble = classifyMandateSchemaEnsemble(db);
    const legacy = legacyTables(db);
    if (ensemble.kind === 'current') {
      const state = ensemble.migrationState;
      if (state.phase === 'cleanup_pending') {
        if (legacy.length !== 0) {
          throw new Error('pending mandate cleanup still has legacy tables');
        }
        return { action: 'resume', state };
      }
      if (state.phase === 'completed') {
        if (legacy.length !== 0) {
          throw new Error('completed mandate migration has legacy tables');
        }
        return { action: 'completed', state };
      }
      if (legacy.length === 0) return { action: 'not-needed', state };
      return { action: 'migrate', state };
    }
    if (ensemble.kind === 'absent' && legacy.length === 0) {
      return { action: 'not-needed', state: null };
    }
    return { action: 'migrate', state: null };
  } catch (error) {
    if (String(error?.message || '').includes('unable to open database file')) {
      return { action: 'not-needed', state: null };
    }
    throw error;
  } finally {
    db?.close();
  }
}

function checkpointTruncate(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (result?.busy) throw new Error('legacy mandate WAL checkpoint is busy');
}

function requireCleanupRowsRecoverable(
  db,
  cipher,
  { rotate = false, requireActive = false, phase = 'cleanup_pending' } = {},
) {
  const ensemble = classifyMandateSchemaEnsemble(db);
  if (ensemble.kind !== 'current' || ensemble.migrationState.phase !== phase
    || legacyTables(db).length !== 0
    || db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n !== 0) {
    throw new Error('mandate cleanup target integrity failed');
  }
  const rows = db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
  const marker = ensemble.migrationState;
  const expectedCount = marker.migrated_count + marker.quarantined_count;
  if (rows.length !== expectedCount) {
    throw new Error('mandate cleanup target count disagrees with its marker');
  }
  let migratedCount = 0;
  let quarantinedCount = 0;
  let needsRotation = 0;
  for (const row of rows) {
    if (row.status === QUARANTINED_STATUS) {
      quarantinedCount += 1;
      const retainedAuthority = [
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
      ].some((value) => value !== null);
      if (retainedAuthority || typeof row.quarantine_reason !== 'string'
        || !row.quarantine_reason) {
        throw new Error('revoked migration tombstone retained authority');
      }
      continue;
    }
    migratedCount += 1;
    if (row.status !== MIGRATED_STATUS
      || typeof row.session_key_envelope !== 'string' || !row.session_key_envelope
      || !/^[0-9a-f]{64}$/.test(row.session_key_digest || '')
      || !/^[0-9a-f]{64}$/.test(row.policy_digest || '')
      || digest(String(row.serialized_approval || '')) !== row.approval_digest
      || row.capability_hash !== null
      || row.activation_user_op_hash !== null
      || row.activation_tx_hash !== null
      || row.activated_at !== null
      || row.quarantine_reason !== null) {
      throw new Error('migrated mandate cleanup facts are invalid');
    }
    const aad = persistedSessionAad(row);
    const opened = cipher.open(row.session_key_envelope, aad);
    if (typeof opened?.plaintext !== 'string'
      || digest(opened.plaintext) !== row.session_key_digest) {
      throw new Error('migrated mandate envelope is unrecoverable');
    }
    if (opened.needsRotation) needsRotation += 1;
    if (opened.needsRotation && rotate) {
      const replacement = cipher.seal(opened.plaintext, aad);
      const replacementOpened = cipher.open(replacement, aad);
      if (typeof replacement !== 'string' || !replacement
        || typeof replacementOpened?.plaintext !== 'string'
        || replacementOpened.plaintext !== opened.plaintext
        || digest(replacementOpened.plaintext) !== row.session_key_digest
        || replacementOpened.needsRotation) {
        throw new Error('migrated mandate envelope rotation failed');
      }
      const updated = db.prepare(`
        UPDATE mandates_v3 SET session_key_envelope = ?
        WHERE mandate_id = ? AND session_key_envelope = ?
      `).run(replacement, row.mandate_id, row.session_key_envelope);
      if (updated.changes !== 1) {
        throw new Error('migrated mandate envelope rotation raced');
      }
    } else if (opened.needsRotation && requireActive) {
      throw new Error('migrated mandate envelope still requires rotation');
    }
  }
  if (migratedCount !== marker.migrated_count
    || quarantinedCount !== marker.quarantined_count
    || migrationTargetDigest(rows) !== marker.target_digest) {
    throw new Error('mandate cleanup target aggregate disagrees with its marker');
  }
  if (rotate) {
    requireCleanupRowsRecoverable(db, cipher, { requireActive: true, phase });
  }
  return { needsRotation };
}

function rotateCompletedMigration(path, cipher) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA temp_store=MEMORY;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
    `);
    const initial = requireCleanupRowsRecoverable(db, cipher, {
      requireActive: false,
      phase: 'completed',
    });
    if (initial.needsRotation === 0) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      requireCleanupRowsRecoverable(db, cipher, {
        rotate: true,
        requireActive: true,
        phase: 'completed',
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    checkpointTruncate(db);
    db.exec('VACUUM');
    checkpointTruncate(db);
    requireCleanupRowsRecoverable(db, cipher, { requireActive: true, phase: 'completed' });
    return true;
  } finally {
    db.close();
  }
}

function finishPhysicalCleanup(db, cipher, migrationHooks) {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      requireCleanupRowsRecoverable(db, cipher, { rotate: true, requireActive: true });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    checkpointTruncate(db);
    db.exec('VACUUM');
    checkpointTruncate(db);
    requireCleanupRowsRecoverable(db, cipher, { requireActive: true });
    const hookResult = migrationHooks?.beforeMarkerClear?.();
    if (hookResult && typeof hookResult.then === 'function') {
      throw new Error('asynchronous cleanup hooks are not supported');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      requireCleanupRowsRecoverable(db, cipher, { requireActive: true });
      const cleared = db.prepare(`
        UPDATE mandate_migration_state
        SET phase = 'completed', updated_at = ?
        WHERE id = 1 AND phase = 'cleanup_pending'
      `).run(Math.floor(Date.now() / 1000));
      if (cleared.changes !== 1) throw new Error('mandate cleanup marker clear failed');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch {
    throw new Error('offline mandate migration cleanup is pending');
  }
  try {
    checkpointTruncate(db);
  } catch {
    // Plaintext cleanup and the guarded marker clear are already durable. This checkpoint is tidy-up.
  }
}

export function createLegacyMandateMigrationManifest(path, options = {}) {
  requireOffline(options.env);
  return inspect(path, options).manifest;
}

export function migrateLegacyMandates(path, options = {}) {
  requireOffline(options.env);
  const disposition = migrationDisposition(path);
  if (disposition.action === 'completed') {
    if (options.rotate) {
      const rotated = rotateCompletedMigration(path, requireCipher(options.sessionKeyCipher));
      if (!rotated) {
        return {
          alreadyMigrated: true,
          migrated: disposition.state.migrated_count,
          quarantined: disposition.state.quarantined_count,
        };
      }
      return {
        rotated: true,
        migrated: disposition.state.migrated_count,
        quarantined: disposition.state.quarantined_count,
      };
    }
    return {
      alreadyMigrated: true,
      migrated: disposition.state.migrated_count,
      quarantined: disposition.state.quarantined_count,
    };
  }
  if (disposition.action === 'not-needed') {
    return { notNeeded: true };
  }
  if (disposition.action === 'resume') {
    const cleanupCipher = disposition.state.migrated_count > 0
      ? requireCipher(options.sessionKeyCipher)
      : options.sessionKeyCipher;
    const cleanupDb = new DatabaseSync(path);
    try {
      cleanupDb.exec(`
        PRAGMA temp_store=MEMORY;
        PRAGMA busy_timeout=5000;
        PRAGMA foreign_keys=ON;
        PRAGMA secure_delete=ON;
      `);
      finishPhysicalCleanup(cleanupDb, cleanupCipher, options.migrationHooks);
      return {
        resumedCleanup: true,
        migrated: disposition.state.migrated_count,
        quarantined: disposition.state.quarantined_count,
      };
    } finally {
      cleanupDb.close();
    }
  }

  const cipher = requireCipher(options.sessionKeyCipher);
  const plan = inspect(path, options);
  if (options.quarantineInvalid && !options.manifest) {
    throw new Error('a complete quarantine manifest is required');
  }
  if (options.manifest && !sameManifest(options.manifest, plan.manifest)) {
    throw new Error('legacy mandate manifest is incomplete, extra, stale, or changed');
  }

  const preflightDb = new DatabaseSync(path, { readOnly: true });
  try {
    preflightDb.exec('PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON');
    validateTarget(preflightDb);
  } finally {
    preflightDb.close();
  }
  try {
    options.migrationHooks?.afterPreflight?.();
  } catch {
    throw new Error('offline mandate migration preflight hook failed');
  }

  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA temp_store=MEMORY;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedPlan = inspectDatabase(db, options);
      if (!sameManifest(lockedPlan.manifest, plan.manifest)
        || (options.manifest && !sameManifest(lockedPlan.manifest, options.manifest))) {
        throw new Error('legacy mandate source changed after preflight agreement');
      }
      validateTarget(db);
      try {
        options.migrationHooks?.afterLockedRescan?.();
      } catch {
        throw new Error('offline mandate migration locked-rescan hook failed');
      }

      let prepared;
      try {
        prepared = lockedPlan.inspected.map((entry) => {
          const mandateId = randomUUID();
          if (entry.outcome !== 'migrate') return { ...entry, mandateId };
          const aadRecord = { mandateId, ...entry.record };
          const aad = mandateSessionAad(aadRecord);
          const envelope = cipher.seal(entry.record.sessionPrivateKey, aad);
          verifySessionEnvelope(
            cipher,
            envelope,
            aad,
            entry.record.sessionPrivateKey,
            entry.record.sessionKeyDigest,
          );
          return {
            ...entry,
            mandateId,
            envelope,
          };
        });
      } catch {
        throw new Error('legacy mandate encryption verification failed');
      }

      db.exec(MANDATE_V3_SCHEMA);
      validateTarget(db);
      const existing = db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n;
      if (existing !== 0) throw new Error('mandates were already migrated');
      const insert = db.prepare(`
        INSERT INTO mandates_v3 (
          mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner, kernel_address,
          session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
          binding_hash, permission_id, session_key_envelope, session_key_digest, capability_hash,
          activation_user_op_hash, activation_tx_hash, activated_at, quarantine_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      `);
      const migrationTime = Math.floor(Date.now() / 1000);
      for (const entry of prepared) {
        if (entry.outcome === 'migrate') {
          const record = entry.record;
          insert.run(
            entry.mandateId, record.approvalDigest, record.policyDigest,
            record.serializedApproval,
            record.stellarOwner, record.kernelAddress, record.sessionKeyAddress,
            record.relayerOrigin, record.validUntilSeconds, MIGRATED_STATUS,
            record.bindingId, record.bindingHash, record.permissionId, entry.envelope,
            record.sessionKeyDigest, null, record.createdAt, migrationTime,
          );
        } else {
          const record = entry.record;
          insert.run(
            entry.mandateId, record.approvalDigest, null, null, record.stellarOwner,
            record.kernelAddress, null, null, null, QUARANTINED_STATUS,
            null, null, null, null, null, record.quarantineReason,
            migrationTime, migrationTime,
          );
        }
      }
      try {
        const persistedById = db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?');
        for (const entry of prepared) {
          const persisted = persistedById.get(entry.mandateId);
          if (!persisted) throw new Error('persisted migration row is missing');
          if (persistedDestinationDigest(persisted) !== entry.destinationDigest) {
            throw new Error('persisted migration destination mismatch');
          }
          if (entry.outcome !== 'migrate') continue;
          if (digest(String(persisted.serialized_approval || ''))
            !== persisted.approval_digest) {
            throw new Error('persisted approval digest mismatch');
          }
          verifySessionEnvelope(
            cipher,
            persisted.session_key_envelope,
            persistedSessionAad(persisted),
            entry.record.sessionPrivateKey,
            entry.record.sessionKeyDigest,
          );
          if (persisted.session_key_digest !== entry.record.sessionKeyDigest) {
            throw new Error('persisted session digest mismatch');
          }
        }
      } catch {
        throw new Error('legacy mandate migration verification failed');
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n !== prepared.length) {
        throw new Error('legacy mandate migration verification failed');
      }
      const migratedCount = prepared.filter(({ outcome }) => outcome === 'migrate').length;
      const quarantinedCount = prepared.length - migratedCount;
      const targetDigest = migrationTargetDigest(
        db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all(),
      );
      const pendingMarker = db.prepare(`
        UPDATE mandate_migration_state
        SET phase = 'cleanup_pending', manifest_version = ?, source_digest = ?,
            target_digest = ?, migrated_count = ?, quarantined_count = ?, updated_at = ?
        WHERE id = 1 AND phase = 'virgin'
          AND manifest_version IS NULL AND source_digest IS NULL AND target_digest IS NULL
          AND migrated_count IS NULL AND quarantined_count IS NULL
      `).run(
        MANIFEST_VERSION,
        lockedPlan.manifest.sourceDigest,
        targetDigest,
        migratedCount,
        quarantinedCount,
        migrationTime,
      );
      if (pendingMarker.changes !== 1) {
        throw new Error('legacy mandate migration marker update failed');
      }
      for (const table of lockedPlan.tables) db.exec(`DROP TABLE ${quoteIdentifier(table)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    try {
      options.migrationHooks?.afterDestructiveCommit?.();
    } catch {
      throw new Error('offline mandate migration cleanup is pending');
    }
    finishPhysicalCleanup(db, cipher, options.migrationHooks);
    return {
      migrated: plan.inspected.filter(({ outcome }) => outcome === 'migrate').length,
      quarantined: plan.inspected.filter(({ outcome }) => outcome !== 'migrate').length,
    };
  } finally {
    db.close();
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseCanonicalMandate } from './base/canonicalMandate.mjs';
import { MANDATE_V3_SCHEMA, mandateSessionAad } from './sqliteStores.mjs';

const OFFLINE_FLAG = 'RELAYER_OFFLINE_KEY_MIGRATION';
const MANIFEST_VERSION = 1;
const MIGRATED_STATUS = 'activation_uncertain';
const QUARANTINED_STATUS = 'revoked';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireOffline(env) {
  if (env?.[OFFLINE_FLAG] !== '1') {
    throw new Error(`${OFFLINE_FLAG}=1 is required for offline mandate migration`);
  }
}

function tableNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('mandates', 'mandates_v2')
    ORDER BY name
  `).all().map(({ name }) => name);
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
}

function legacyRows(db) {
  const tables = tableNames(db);
  if (tables.length === 0) throw new Error('legacy mandate tables are missing or already migrated');
  const rows = [];
  if (tables.includes('mandates')) {
    rows.push(...db.prepare(`
      SELECT rowid AS source_rowid, approval, session_key,
             typeof(expires_at) AS expires_at_type,
             CAST(expires_at AS TEXT) AS expires_at_text
      FROM mandates ORDER BY approval, rowid
    `).all().map((row) => ({ table: 'mandates', row })));
  }
  if (tables.includes('mandates_v2')) {
    const permission = hasColumn(db, 'mandates_v2', 'permission_id')
      ? ', permission_id' : '';
    rows.push(...db.prepare(`
      SELECT rowid AS source_rowid, serialized_approval, stellar_owner, kernel_address,
             session_private_key, session_key_address, relayer_origin,
             typeof(expires_at) AS expires_at_type,
             CAST(expires_at AS TEXT) AS expires_at_text,
             status, binding_id, binding_hash, created_at${permission}
      FROM mandates_v2
      ORDER BY serialized_approval, stellar_owner, kernel_address, rowid
    `).all().map((row) => ({ table: 'mandates_v2', row })));
  }
  return { tables, rows };
}

function rowDigest(source) {
  const values = Object.keys(source.row).sort().map((key) => [key, source.row[key]]);
  return digest(JSON.stringify([source.table, values]));
}

function sourceDigest(tables, entries) {
  return digest(JSON.stringify([
    'vf-legacy-mandate-source-v1',
    tables,
    entries.map(({ rowDigest: value }) => value),
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
  return {
    approvalDigest: digest(row.serialized_approval),
    serializedApproval: row.serialized_approval,
    stellarOwner: row.stellar_owner,
    kernelAddress: row.kernel_address.toLowerCase(),
    sessionPrivateKey: row.session_private_key,
    sessionKeyAddress: row.session_key_address.toLowerCase(),
    relayerOrigin: row.relayer_origin ?? null,
    validUntilSeconds,
    bindingId: row.binding_id,
    bindingHash: row.binding_hash,
    permissionId: parsed.permissionId ?? row.permission_id ?? null,
    createdAt: Number.isSafeInteger(row.created_at)
      ? Math.floor(row.created_at / 1000) : validUntilSeconds,
  };
}

function quarantineRecord(source) {
  const row = source.row;
  const serializedApproval = source.table === 'mandates_v2'
    ? row.serialized_approval : row.approval;
  return {
    approvalDigest: digest(String(serializedApproval || '')),
    stellarOwner: source.table === 'mandates_v2' && row.stellar_owner
      ? row.stellar_owner : null,
    kernelAddress: source.table === 'mandates_v2' && row.kernel_address
      ? row.kernel_address.toLowerCase() : null,
    quarantineReason: 'NONCANONICAL_LEGACY_ROW',
  };
}

function inspect(path, {
  config,
  parseCanonicalApproval = parseCanonicalMandate,
  quarantineInvalid = false,
}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const source = legacyRows(db);
    const inspected = [];
    for (const item of source.rows) {
      const itemDigest = rowDigest(item);
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
    const entries = inspected.map(({ rowDigest: value, outcome, reason }) => ({
      rowDigest: value,
      outcome,
      ...(reason ? { reason } : {}),
    }));
    return {
      manifest: {
        version: MANIFEST_VERSION,
        sourceDigest: sourceDigest(source.tables, entries),
        entries,
      },
      inspected,
      tables: source.tables,
    };
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

function checkpointTruncate(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (result?.busy) throw new Error('legacy mandate WAL checkpoint is busy');
}

export function createLegacyMandateMigrationManifest(path, options = {}) {
  requireOffline(options.env);
  return inspect(path, options).manifest;
}

export function migrateLegacyMandates(path, options = {}) {
  requireOffline(options.env);
  const cipher = requireCipher(options.sessionKeyCipher);
  const plan = inspect(path, options);
  if (options.quarantineInvalid && !options.manifest) {
    throw new Error('a complete quarantine manifest is required');
  }
  if (options.manifest && !sameManifest(options.manifest, plan.manifest)) {
    throw new Error('legacy mandate manifest is incomplete, extra, stale, or changed');
  }

  // All rows and the complete manifest have been validated before generating IDs, encrypting
  // secrets, opening a writable connection, or changing the database.
  const prepared = plan.inspected.map((entry) => {
    const mandateId = randomUUID();
    if (entry.outcome !== 'migrate') return { ...entry, mandateId };
    const aadRecord = { mandateId, ...entry.record };
    return {
      ...entry,
      mandateId,
      envelope: cipher.seal(entry.record.sessionPrivateKey, mandateSessionAad(aadRecord)),
    };
  });

  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
    try {
      db.exec(MANDATE_V3_SCHEMA);
      const existing = db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n;
      if (existing !== 0) throw new Error('mandates were already migrated');
      const insert = db.prepare(`
        INSERT INTO mandates_v3 (
          mandate_id, approval_digest, serialized_approval, stellar_owner, kernel_address,
          session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
          binding_hash, permission_id, session_key_envelope, capability_hash,
          activation_user_op_hash, activation_tx_hash, activated_at, quarantine_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      `);
      const migrationTime = Math.floor(Date.now() / 1000);
      for (const entry of prepared) {
        if (entry.outcome === 'migrate') {
          const record = entry.record;
          insert.run(
            entry.mandateId, record.approvalDigest, record.serializedApproval,
            record.stellarOwner, record.kernelAddress, record.sessionKeyAddress,
            record.relayerOrigin, record.validUntilSeconds, MIGRATED_STATUS,
            record.bindingId, record.bindingHash, record.permissionId, entry.envelope,
            null, record.createdAt, migrationTime,
          );
        } else {
          const record = entry.record;
          insert.run(
            entry.mandateId, record.approvalDigest, null, record.stellarOwner,
            record.kernelAddress, null, null, null, QUARANTINED_STATUS,
            null, null, null, null, record.quarantineReason, migrationTime, migrationTime,
          );
        }
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n !== prepared.length) {
        throw new Error('legacy mandate migration verification failed');
      }
      for (const table of plan.tables) db.exec(`DROP TABLE ${table}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    checkpointTruncate(db);
    db.exec('VACUUM');
    checkpointTruncate(db);
    return { migrated: prepared.filter(({ outcome }) => outcome === 'migrate').length,
      quarantined: prepared.filter(({ outcome }) => outcome !== 'migrate').length };
  } finally {
    db.close();
  }
}

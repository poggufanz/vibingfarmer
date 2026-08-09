// relayer/test/sqliteStores.test.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Keypair } from '@stellar/stellar-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';
import {
  createSqliteStores,
  MANDATE_V3_SCHEMA,
  mandateSessionAad,
} from '../src/sqliteStores.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-sqlite-')), 'relayer.db');

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
const MANDATE_ID = '7d8f94a2c16b4e6488bf07b81234abcd';
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const KERNEL = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const WRONG_SESSION_PRIVATE_KEY = `0x${'66'.repeat(32)}`;
const SECOND_SESSION_PRIVATE_KEY = `0x${'77'.repeat(32)}`;
const SESSION_KEY_DIGEST = 'd796cb759ab4fbd29dbe7a352e38c76d1a8838dd926b2934e2c81b37fbd2a915';
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const APPROVAL = 'canonical-approval-fixture';
const APPROVAL_DIGEST = createHash('sha256').update(APPROVAL).digest('hex');
const POLICY_DIGEST = 'dd'.repeat(32);
const CAPABILITY_HASH = 'aa'.repeat(32);
const PERMISSION_ID = '0x1234abcd';
const BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`)
  .digest('hex');
const NORMALIZED_BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL.toLowerCase()}|${SESSION.toLowerCase()}|${VALID_UNTIL_SECONDS}`)
  .digest('hex');
const OFFLINE_ENV = Object.freeze({ RELAYER_OFFLINE_KEY_MIGRATION: '1' });
const TASK4_CONFIG = Object.freeze({
  publicOrigin: 'https://relayer.example',
  base: Object.freeze({
    chain: Object.freeze({ id: 84532 }),
    mandatePolicy: Object.freeze({ parserFixture: true }),
  }),
});
function cipher(entries = [['active', Buffer.alloc(32, 0x31)]]) {
  return createSecretEnvelope(parseSecretKeyring(
    entries.map(([id, key]) => `${id}:${key.toString('base64')}`).join(','),
  ));
}

function mandateRecord(overrides = {}) {
  return {
    mandateId: MANDATE_ID,
    approvalDigest: APPROVAL_DIGEST,
    policyDigest: POLICY_DIGEST,
    serializedApproval: APPROVAL,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    capabilityHash: CAPABILITY_HASH,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: VALID_UNTIL_SECONDS,
    status: 'pending_activation',
    bindingId: 'binding-1',
    bindingHash: BINDING_HASH,
    permissionId: PERMISSION_ID,
    ...overrides,
  };
}

const mandateIdentity = () => ({ mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL });

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => name);
}

function createLegacyV2(path, overrides = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mandates_v2 (
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
  `);
  const row = {
    serializedApproval: APPROVAL,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    relayerOrigin: 'https://relayer.example',
    expiresAt: VALID_UNTIL_SECONDS * 1000,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: BINDING_HASH,
    createdAt: NOW_SECONDS * 1000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO mandates_v2 (
      serialized_approval, stellar_owner, kernel_address, session_private_key,
      session_key_address, relayer_origin, expires_at, status, binding_id,
      binding_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.serializedApproval, row.stellarOwner, row.kernelAddress, row.sessionPrivateKey,
    row.sessionKeyAddress, row.relayerOrigin, row.expiresAt, row.status, row.bindingId,
    row.bindingHash, row.createdAt,
  );
  db.close();
  return row;
}

function createPrePolicyV3(path, { withRow = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
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
  `);
  if (withRow) {
    db.prepare(`
      INSERT INTO mandates_v3 (
        mandate_id, approval_digest, serialized_approval, stellar_owner, kernel_address,
        session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
        binding_hash, permission_id, session_key_envelope, capability_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_activation', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      MANDATE_ID, APPROVAL_DIGEST, APPROVAL, OWNER, KERNEL.toLowerCase(),
      SESSION.toLowerCase(), 'https://relayer.example', VALID_UNTIL_SECONDS,
      'binding-1', BINDING_HASH, PERMISSION_ID, 'legacy-envelope', CAPABILITY_HASH,
      NOW_SECONDS, NOW_SECONDS,
    );
  }
  db.close();
}

function canonicalLegacyParser(params) {
  if (params.serializedApproval !== APPROVAL) throw new Error('approval is noncanonical');
  const expectedBinding = createHash('sha256')
    .update(`${params.stellarOwner}|${params.kernelAddress}|${params.sessionKeyAddress}|${params.validUntilSeconds}`)
    .digest('hex');
  if (params.bindingId !== 'binding-1' || params.bindingHash !== expectedBinding) {
    throw new Error('binding is noncanonical');
  }
  return {
    accountAddress: params.kernelAddress,
    sessionKeyAddress: params.sessionKeyAddress,
    stellarOwner: params.stellarOwner,
    permissionId: PERMISSION_ID,
    validAfter: 0,
    validUntilSeconds: params.validUntilSeconds,
    cap: 10_000_000_000n,
    policies: [{ type: 'call' }, { type: 'timestamp' }],
    call: { type: 'call' },
    timestamp: { validAfter: 0, validUntil: VALID_UNTIL_SECONDS },
    policyDigest: POLICY_DIGEST,
    policyData: ['0x0000call', '0x0000timestamp'],
  };
}

async function migrationLibrary() {
  return import('../src/mandateMigration.mjs');
}

function migrationOptions(overrides = {}) {
  return {
    env: OFFLINE_ENV,
    config: TASK4_CONFIG,
    parseCanonicalApproval: canonicalLegacyParser,
    ...overrides,
  };
}

function createMigrationVerificationTarget(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(MANDATE_V3_SCHEMA);
  } finally {
    db.close();
  }
}

function observePersistedMandateEnvelopeReads({ transformRow = (row) => row } = {}) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const state = { reads: 0, envelope: null };
  DatabaseSync.prototype.prepare = function observePrepare(sql) {
    const statement = originalPrepare.call(this, sql);
    if (!/\bfrom\s+[`"']?mandates_v3\b/i.test(String(sql))) return statement;
    for (const method of ['get', 'all']) {
      const originalRead = statement[method].bind(statement);
      statement[method] = (...args) => {
        const result = originalRead(...args);
        const rows = Array.isArray(result) ? result : [result];
        const transformed = rows.map((row) => {
          if (typeof row?.session_key_envelope === 'string') {
            state.reads += 1;
            state.envelope = row.session_key_envelope;
            return transformRow({ ...row });
          }
          return row;
        });
        return Array.isArray(result) ? transformed : transformed[0];
      };
    }
    return statement;
  };
  return {
    state,
    restore() {
      DatabaseSync.prototype.prepare = originalPrepare;
    },
  };
}

function observeMigrationTempStore(path, stage = () => 'unknown') {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const observedConnections = new WeakSet();
  const state = { observations: [] };
  let inspecting = false;
  DatabaseSync.prototype.prepare = function observePrepare(sql) {
    const source = String(sql);
    if (!inspecting && !observedConnections.has(this)
      && /sqlite_master|mandates(?:_v[23])?|mandate_activation_work|mandate_migration_state/i.test(source)) {
      inspecting = true;
      try {
        const main = originalPrepare.call(this, 'PRAGMA database_list').all()
          .find(({ name }) => name === 'main');
        if (main?.file === path) {
          const mode = originalPrepare.call(this, 'PRAGMA temp_store').get()?.temp_store;
          state.observations.push({ mode, firstQuery: source, stage: stage() });
          observedConnections.add(this);
        }
      } finally {
        inspecting = false;
      }
    }
    return originalPrepare.call(this, sql);
  };
  return {
    state,
    restore() {
      DatabaseSync.prototype.prepare = originalPrepare;
    },
  };
}

function migrationVerificationCipher(mode, { persistedEnvelopeWasRead = () => false } = {}) {
  const envelopeCipher = cipher();
  const state = { sealCalls: 0, openCalls: 0, sealedEnvelope: null, openedEnvelopes: [] };
  return {
    state,
    seal(plaintext, aad) {
      state.sealCalls += 1;
      if (mode === 'empty-envelope') state.sealedEnvelope = '';
      else if (mode === 'malformed-envelope') {
        state.sealedEnvelope = 'malformed-envelope-must-not-leak';
      } else if (mode === 'unopenable-envelope') {
        state.sealedEnvelope = envelopeCipher.seal(plaintext, `${aad}:wrong-aad`);
      } else {
        state.sealedEnvelope = envelopeCipher.seal(plaintext, aad);
      }
      return state.sealedEnvelope;
    },
    open(envelope, aad) {
      state.openCalls += 1;
      state.openedEnvelopes.push(envelope);
      if (mode === 'wrong-immediate-plaintext' && state.openCalls === 1) {
        return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
      }
      if (state.openCalls === 2 && persistedEnvelopeWasRead()) {
        if (mode === 'post-insert-open-failure') {
          throw new Error(`injected post-insert open failure: ${SESSION_PRIVATE_KEY}`);
        }
        if (mode === 'post-insert-wrong-plaintext') {
          return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
        }
      }
      return envelopeCipher.open(envelope, aad);
    },
  };
}

function expectLosslessMigrationRollback(path, before) {
  expect(sqliteSnapshot(path)).toStrictEqual(before);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = tableNames(db).map((name) => name.toLowerCase());
    expect(tables).toContain('mandates_v2');
    expect(db.prepare(`
      SELECT serialized_approval, session_private_key FROM mandates_v2
    `).get()).toEqual({
      serialized_approval: APPROVAL,
      session_private_key: SESSION_PRIVATE_KEY,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
    expect(db.prepare(`
      SELECT phase, manifest_version, source_digest, target_digest,
             migrated_count, quarantined_count, updated_at
      FROM mandate_migration_state WHERE id = 1
    `).get()).toEqual({
      phase: 'virgin',
      manifest_version: null,
      source_digest: null,
      target_digest: null,
      migrated_count: null,
      quarantined_count: null,
      updated_at: 0,
    });
  } finally {
    db.close();
  }
}

function migrationTargetSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = new Set(tableNames(db).map((name) => name.toLowerCase()));
    return {
      objects: db.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE type IN ('table', 'trigger')
        ORDER BY type, name
      `).all(),
      mandates: names.has('mandates_v3')
        ? db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all() : null,
      work: names.has('mandate_activation_work')
        ? db.prepare('SELECT * FROM mandate_activation_work ORDER BY mandate_id').all() : null,
      state: names.has('mandate_migration_state')
        ? db.prepare('SELECT * FROM mandate_migration_state ORDER BY id').all() : null,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

function replaceActivationWorkSchema(db, {
  statusCheck = "CHECK (status IN ('pending','running','submitting','submitted','done','uncertain'))",
  attemptsDefault = 'DEFAULT 0',
  foreignKey = 'FOREIGN KEY (mandate_id) REFERENCES mandates_v3(mandate_id)',
} = {}) {
  db.exec('PRAGMA foreign_keys=OFF; DROP TABLE mandate_activation_work;');
  db.exec(`
    CREATE TABLE mandate_activation_work (
      mandate_id TEXT PRIMARY KEY,
      stellar_owner TEXT NOT NULL,
      kernel_address TEXT NOT NULL,
      status TEXT NOT NULL ${statusCheck},
      attempts INTEGER NOT NULL ${attemptsDefault},
      lease_token TEXT,
      lease_expires_at INTEGER,
      user_op_hash TEXT,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
      ${foreignKey ? `, ${foreignKey}` : ''}
    )
  `);
}

const CANONICAL_MIGRATION_MARKER_METADATA_CHECK = `CHECK (
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
)`;

const VIRGIN_MIGRATION_MARKER_ROW = [1, 'virgin', null, null, null, null, null, 0];

function boundMigrationMarkerRow({ id = 1, phase = 'cleanup_pending' } = {}) {
  return [id, phase, 1, '11'.repeat(32), '22'.repeat(32), 1, 0, NOW_SECONDS];
}

function replaceMigrationStateSchema(db, {
  idCheck = 'CHECK (id = 1)',
  phaseCheck = "CHECK (phase IN ('virgin','cleanup_pending','completed'))",
  metadataCheck = CANONICAL_MIGRATION_MARKER_METADATA_CHECK,
  rows = [VIRGIN_MIGRATION_MARKER_ROW],
} = {}) {
  db.exec('DROP TABLE mandate_migration_state;');
  db.exec(`
    CREATE TABLE mandate_migration_state (
      id INTEGER PRIMARY KEY ${idCheck},
      phase TEXT NOT NULL ${phaseCheck},
      manifest_version INTEGER,
      source_digest TEXT,
      target_digest TEXT,
      migrated_count INTEGER,
      quarantined_count INTEGER,
      updated_at INTEGER NOT NULL
      ${metadataCheck ? `, ${metadataCheck}` : ''}
    )
  `);
  const insert = db.prepare(`
    INSERT INTO mandate_migration_state (
      id, phase, manifest_version, source_digest, target_digest,
      migrated_count, quarantined_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) insert.run(...row);
}

function createMarkerOnlyLayout(path, {
  phase = 'virgin',
  idCheck = 'CHECK (id = 1)',
  phaseCheck = "CHECK (phase IN ('virgin','cleanup_pending','completed'))",
  metadataCheck = CANONICAL_MIGRATION_MARKER_METADATA_CHECK,
} = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE mandate_migration_state (
        id INTEGER PRIMARY KEY ${idCheck},
        phase TEXT NOT NULL ${phaseCheck},
        manifest_version INTEGER,
        source_digest TEXT,
        target_digest TEXT,
        migrated_count INTEGER,
        quarantined_count INTEGER,
        updated_at INTEGER NOT NULL
        ${metadataCheck ? `, ${metadataCheck}` : ''}
      )
    `);
    const row = phase === 'virgin'
      ? VIRGIN_MIGRATION_MARKER_ROW
      : boundMigrationMarkerRow({ phase });
    db.prepare(`
      INSERT INTO mandate_migration_state (
        id, phase, manifest_version, source_digest, target_digest,
        migrated_count, quarantined_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...row);
  } finally {
    db.close();
  }
}

function insertActivationWork(db, {
  mandateId,
  stellarOwner = OWNER,
  kernelAddress = KERNEL.toLowerCase(),
} = {}) {
  db.prepare(`
    INSERT INTO mandate_activation_work (
      mandate_id, stellar_owner, kernel_address, status, attempts,
      lease_token, lease_expires_at, user_op_hash, tx_hash, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)
  `).run(mandateId, stellarOwner, kernelAddress, NOW_SECONDS, NOW_SECONDS);
}

async function seedPendingMigrationCleanup(path, { sessionKeyCipher = cipher() } = {}) {
  createLegacyV2(path);
  const migration = await migrationLibrary();
  const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
  let seedError;
  try {
    migration.migrateLegacyMandates(path, migrationOptions({
      manifest,
      sessionKeyCipher,
      migrationHooks: {
        afterDestructiveCommit() {
          throw new Error(`seed cleanup interruption: ${SESSION_PRIVATE_KEY}`);
        },
      },
    }));
  } catch (error) {
    seedError = error;
  }
  expect(seedError).toBeInstanceOf(Error);
  expect(seedError.message).toBe('offline mandate migration cleanup is pending');
  return migration;
}

function canonicalMultiRowLegacyParser(params) {
  const expectedBinding = createHash('sha256')
    .update(`${params.stellarOwner}|${params.kernelAddress}|${params.sessionKeyAddress}|${params.validUntilSeconds}`)
    .digest('hex');
  if (!params.bindingId || params.bindingHash !== expectedBinding) {
    throw new Error('binding is noncanonical');
  }
  return {
    accountAddress: params.kernelAddress,
    sessionKeyAddress: params.sessionKeyAddress,
    stellarOwner: params.stellarOwner,
    permissionId: params.serializedApproval === APPROVAL ? PERMISSION_ID : '0x5678abcd',
    validUntilSeconds: params.validUntilSeconds,
    policyDigest: params.serializedApproval === APPROVAL ? POLICY_DIGEST : 'ee'.repeat(32),
  };
}

function expectedPersistedMigrationDestinationDigest(row) {
  if (!['activation_uncertain', 'revoked'].includes(row.status)) {
    throw new Error('test fixture has a non-migration destination status');
  }
  const facts = row.status === 'activation_uncertain'
    ? [
      row.approval_digest,
      row.policy_digest,
      row.stellar_owner,
      row.kernel_address,
      row.session_key_address,
      row.relayer_origin,
      row.valid_until_seconds,
      row.binding_id,
      row.binding_hash,
      row.permission_id,
      row.session_key_digest,
      row.created_at,
      'activation_uncertain',
      null,
      null,
      null,
      null,
      null,
    ]
    : [
      row.approval_digest,
      row.stellar_owner,
      row.kernel_address,
      row.quarantine_reason,
      'revoked',
      null,
      null,
      null,
      null,
      null,
    ];
  return createHash('sha256')
    .update(JSON.stringify([
      'vf-legacy-mandate-destination-v1',
      row.status === 'activation_uncertain' ? 'migrate' : 'revoked',
      facts,
    ]))
    .digest('hex');
}

function expectedMigrationTargetDigest(rows) {
  const identitiesAndDigests = rows
    .map((row) => [row.mandate_id, expectedPersistedMigrationDestinationDigest(row)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify(['vf-mandate-migration-target-v1', identitiesAndDigests]))
    .digest('hex');
}

async function seedBoundPendingMigrationCleanup(path, { sessionKeyCipher = cipher() } = {}) {
  createLegacyV2(path);
  const secondOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const secondKernel = `0x${'78'.repeat(20)}`;
  const secondSession = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address;
  createLegacyV2(path, {
    serializedApproval: 'canonical-approval-fixture-two',
    stellarOwner: secondOwner,
    kernelAddress: secondKernel,
    sessionPrivateKey: SECOND_SESSION_PRIVATE_KEY,
    sessionKeyAddress: secondSession,
    bindingId: 'binding-2',
    bindingHash: createHash('sha256')
      .update(`${secondOwner}|${secondKernel}|${secondSession}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
    createdAt: (NOW_SECONDS + 1) * 1000,
  });
  const migration = await migrationLibrary();
  const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
  const manifest = migration.createLegacyMandateMigrationManifest(path, options);
  let seedError;
  try {
    migration.migrateLegacyMandates(path, {
      ...options,
      manifest,
      sessionKeyCipher,
      migrationHooks: {
        afterDestructiveCommit() {
          throw new Error(`seed bound cleanup interruption: ${SECOND_SESSION_PRIVATE_KEY}`);
        },
      },
    });
  } catch (error) {
    seedError = error;
  }
  expect(seedError).toBeInstanceOf(Error);
  expect(seedError.message).toBe('offline mandate migration cleanup is pending');
  return { migration, manifest, options };
}

async function seedCompletedMigrationWithBothOutcomes(path) {
  createLegacyV2(path);
  const revokedOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const revokedKernel = `0x${'78'.repeat(20)}`;
  const revokedSession = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address;
  createLegacyV2(path, {
    serializedApproval: 'revoked-legacy-approval-fixture',
    stellarOwner: revokedOwner,
    kernelAddress: revokedKernel,
    sessionPrivateKey: SECOND_SESSION_PRIVATE_KEY,
    sessionKeyAddress: revokedSession,
    status: 'revoked',
    bindingId: 'revoked-binding',
    bindingHash: createHash('sha256')
      .update(`${revokedOwner}|${revokedKernel}|${revokedSession}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
  });
  const migration = await migrationLibrary();
  const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
  const manifest = migration.createLegacyMandateMigrationManifest(path, options);
  expect(migration.migrateLegacyMandates(path, {
    ...options,
    manifest,
    sessionKeyCipher: cipher(),
  })).toEqual({ migrated: 1, quarantined: 1 });
  return { migration, manifest, options };
}

function addSecondRecoverableMigratedMandate(path) {
  const mandateId = '9e8f94a2c16b4e6488bf07b81234abcd';
  const serializedApproval = 'canonical-approval-fixture-two';
  const stellarOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const kernelAddress = `0x${'78'.repeat(20)}`;
  const sessionKeyAddress = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address.toLowerCase();
  const policyDigest = 'ee'.repeat(32);
  const bindingId = 'binding-2';
  const record = {
    mandateId,
    approvalDigest: createHash('sha256').update(serializedApproval).digest('hex'),
    policyDigest,
    serializedApproval,
    stellarOwner,
    kernelAddress,
    sessionKeyAddress,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: VALID_UNTIL_SECONDS,
    bindingId,
    bindingHash: createHash('sha256')
      .update(`${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
    permissionId: '0x5678abcd',
  };
  const sessionKeyDigest = createHash('sha256').update(SECOND_SESSION_PRIVATE_KEY).digest('hex');
  const sessionKeyEnvelope = cipher().seal(SECOND_SESSION_PRIVATE_KEY, mandateSessionAad(record));
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      INSERT INTO mandates_v3 (
        mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
        kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
        binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
        capability_hash, activation_user_op_hash, activation_tx_hash, activated_at,
        quarantine_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activation_uncertain', ?, ?, ?, ?, ?,
                NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      record.mandateId, record.approvalDigest, record.policyDigest, record.serializedApproval,
      record.stellarOwner, record.kernelAddress, record.sessionKeyAddress, record.relayerOrigin,
      record.validUntilSeconds, record.bindingId, record.bindingHash, record.permissionId,
      sessionKeyEnvelope, sessionKeyDigest, NOW_SECONDS, NOW_SECONDS,
    );
  } finally {
    db.close();
  }
}

function startConcurrentEnqueueWorker({ path, record, barrier }) {
  const sqliteUrl = pathToFileURL(join(process.cwd(), 'src/sqliteStores.mjs')).href;
  const envelopeUrl = pathToFileURL(join(process.cwd(), 'src/secretEnvelope.mjs')).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteStores } = await import(workerData.sqliteUrl);
      const { createSecretEnvelope, parseSecretKeyring } = await import(workerData.envelopeUrl);
      const baseCipher = createSecretEnvelope(parseSecretKeyring(workerData.keyring));
      const barrier = new Int32Array(workerData.barrier);
      const barrierCipher = {
        open: (...args) => baseCipher.open(...args),
        seal(...args) {
          const arrivals = Atomics.add(barrier, 0, 1) + 1;
          Atomics.notify(barrier, 0);
          if (arrivals < 2 && Atomics.wait(barrier, 0, arrivals, 5000) === 'timed-out') {
            throw new Error('concurrent enqueue barrier timed out');
          }
          return baseCipher.seal(...args);
        },
      };
      let stores;
      try {
        stores = createSqliteStores(workerData.path, {
          sessionKeyCipher: barrierCipher,
          nowSeconds: () => workerData.nowSeconds,
        });
        const result = stores.mandateActivations.enqueue({ record: workerData.record });
        parentPort.postMessage({
          outcome: 'ok',
          duplicate: result.duplicate,
          mandateId: result.mandate.mandateId,
          workStatus: result.work?.status ?? null,
        });
      } catch (error) {
        parentPort.postMessage({ outcome: 'error', message: String(error?.message || 'unknown error') });
      } finally {
        stores?.db.close();
      }
    })().catch((error) => {
      parentPort.postMessage({ outcome: 'error', message: String(error?.message || 'worker error') });
    });
  `;
  return new Worker(source, {
    eval: true,
    workerData: {
      path,
      record,
      barrier,
      sqliteUrl,
      envelopeUrl,
      nowSeconds: NOW_SECONDS,
      keyring: `active:${Buffer.alloc(32, 0x31).toString('base64')}`,
    },
  });
}

function boundedWorkerResult(worker, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('concurrent enqueue worker timed out'));
    }, timeoutMs);
    worker.once('message', (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`concurrent enqueue worker exited with code ${code}`));
      }
    });
  });
}

async function runConcurrentEnqueues(path, leftRecord, rightRecord) {
  const initialized = createSqliteStores(path, {
    sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
  });
  initialized.db.close();
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = [leftRecord, rightRecord].map((workerRecord) => (
    startConcurrentEnqueueWorker({ path, record: workerRecord, barrier })
  ));
  try {
    return await Promise.all(workers.map((worker) => boundedWorkerResult(worker)));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function sqliteSnapshot(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      tables: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      v1: tableNames(db).includes('mandates')
        ? db.prepare(`
            SELECT approval, session_key, typeof(expires_at) AS expires_at_type,
                   CAST(expires_at AS TEXT) AS expires_at
            FROM mandates ORDER BY approval
          `).all() : null,
      v2: tableNames(db).includes('mandates_v2')
        ? db.prepare(`
            SELECT serialized_approval, stellar_owner, kernel_address, session_private_key,
                   session_key_address, relayer_origin, typeof(expires_at) AS expires_at_type,
                   CAST(expires_at AS TEXT) AS expires_at, status, binding_id, binding_hash, created_at
            FROM mandates_v2 ORDER BY serialized_approval, stellar_owner, kernel_address
          `).all()
        : null,
      v3: tableNames(db).includes('mandates_v3')
        ? db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all() : null,
    };
  } finally {
    db.close();
  }
}

function expectNoPlaintextInFile(path, plaintexts) {
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  for (const plaintext of plaintexts) {
    expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
  }
}

function expectNoAuthorityFields(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const forbidden = new Set([
    'sessionprivatekey', 'sessionkeydigest', 'session_key_digest',
    'capabilityhash', 'sessionkeyenvelope', 'session_key_envelope',
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') expect(forbidden.has(key.toLowerCase())).toBe(false);
    expectNoAuthorityFields(value[key], seen);
  }
}

function expectOpaqueMandateId(value, legacyAuthority) {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
  for (const authority of legacyAuthority) {
    expect(value).not.toBe(authority);
    expect(value).not.toContain(authority);
  }
}

const executionIdentity = {
  networkId: 'stellar-testnet',
  owner: `G${'A'.repeat(55)}`,
  bindingId: 'binding-1',
  executionId: 'run-1:exec:run-1:bridge:aave-v3',
  allocationId: 'run-1:bridge:aave-v3',
  childId: 'job-1',
};
const recoveryIdentity = {
  networkId: executionIdentity.networkId,
  bindingId: executionIdentity.bindingId,
  executionId: executionIdentity.executionId,
  allocationId: executionIdentity.allocationId,
  childId: executionIdentity.childId,
};
const depositCheckpoint = (status, evidence, observedAt = 2_000_000_000_100) => ({
  identity: recoveryIdentity,
  phase: 'base_deposit',
  status,
  evidence,
  observedAt,
});

function executionReport(sequence, executionStatus = 'accepted') {
  return {
    identity: executionIdentity,
    expectedSequence: sequence - 1,
    lifecycle: {
      sequence,
      status: executionStatus === 'failed' ? 'failed' : 'submitted',
      evidence: { executionStatus },
      observedAt: 2_000_000_000_000 + sequence,
    },
  };
}

describe('sqliteStores', () => {
  it('idempotency store: set/get/has/all round-trip', () => {
    const { store } = createSqliteStores(freshPath());
    expect(store.get('e1')).toBeNull();
    store.set('e1', { status: 'done' });
    expect(store.has('e1')).toBe(true);
    expect(store.get('e1').status).toBe('done');
    expect(Object.keys(store.all())).toEqual(['e1']);
  });

  it('jobs: Map-like get/set with JSON payloads', () => {
    const { jobs } = createSqliteStores(freshPath());
    expect(jobs.get('j1')).toBeUndefined();
    jobs.set('j1', { status: 'pending', steps: [] });
    expect(jobs.get('j1')).toEqual({ status: 'pending', steps: [] });
    jobs.set('j1', { status: 'done', steps: [{ step: 'mint' }] });
    expect(jobs.get('j1').status).toBe('done');
  });

  it('SURVIVES REOPEN: jobs persist across a new createSqliteStores on the same file', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    first.jobs.set('j1', { status: 'pending', steps: [] });
    first.db.close();
    const second = createSqliteStores(path);
    expect(second.jobs.get('j1').status).toBe('pending');
    second.db.close();
  });

  describe('durable farm execution work', () => {
    const queuedJob = {
      status: 'queued',
      steps: [],
      runId: 'run-1',
      _attach: { jobId: 'job-1', attachedBurnTxHash: null },
    };
    const attachedJob = {
      ...queuedJob,
      status: 'pending',
      _attach: {
        ...queuedJob._attach,
        attachedBurnTxHash: 'burn-1',
        associations: [{ allocationId: executionIdentity.allocationId, terminalSequence: null }],
      },
    };

    it('atomically commits a farm job checkpoint with its Base evidence head and outbox row', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.jobs.set('job-1', queuedJob);
      stores.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
        evidenceHeads: [{ identity: recoveryIdentity, recoveryVersion: 0 }],
      });
      const claimed = stores.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      const depositing = { ...attachedJob, status: 'depositing' };
      stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken, job: depositing,
        baseEvidenceReports: [depositCheckpoint('submitting', {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
          assets: '1000000', minShares: '900000',
        })],
      });
      expect(stores.jobs.get('job-1')).toEqual(depositing);
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity)).toMatchObject({
        recoveryVersion: 1,
        events: [{ state: 'submitting', expectedRecoveryVersion: 0 }],
      });
    });

    it('rolls back job and evidence together when a stale lease or evidence conflict wins', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.jobs.set('job-1', queuedJob);
      stores.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
        evidenceHeads: [{ identity: recoveryIdentity, recoveryVersion: 0 }],
      });
      const claimed = stores.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      const report = depositCheckpoint('submitting', {
        chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
        caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
        assets: '1000000', minShares: '900000',
      });
      expect(() => stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: 'stale', job: { ...attachedJob, status: 'bad' },
        baseEvidenceReports: [report],
      })).toThrow(/lease/i);
      expect(stores.jobs.get('job-1')).toEqual(attachedJob);
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity).events).toEqual([]);

      stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken,
        job: { ...attachedJob, status: 'depositing' }, baseEvidenceReports: [report],
      });
      expect(() => stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken,
        job: { ...attachedJob, status: 'corrupt' },
        baseEvidenceReports: [{ ...report, evidence: { ...report.evidence, assets: '1000001' } }],
      })).toThrow(/conflict|immutable/i);
      expect(stores.jobs.get('job-1').status).toBe('depositing');
    });

    it('rejects direct SQL mutation or deletion of immutable Base evidence', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.baseEvidenceOutbox.seed(recoveryIdentity, 0, { jobId: 'job-1' });
      stores.baseEvidenceOutbox.enqueue(depositCheckpoint('submitting', {
        chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
        caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
        assets: '1000000', minShares: '900000',
      }));

      for (const statement of [
        "UPDATE base_evidence_outbox SET report_json='{}'",
        "UPDATE base_evidence_outbox SET execution_id='other'",
        'UPDATE base_evidence_outbox SET expected_recovery_version=9',
        'DELETE FROM base_evidence_outbox',
      ]) {
        expect(() => stores.db.exec(statement)).toThrow(/immutable|evidence/i);
      }
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity).events).toHaveLength(1);
    });

    // Defect caught: accepted lifecycle insertion, burn attachment, and executable work were
    // three crash-separated writes instead of one SQLite transaction.
    it('atomically persists burn attachment, accepted reports, and pending work', () => {
      const path = freshPath();
      const first = createSqliteStores(path);
      first.jobs.set('job-1', queuedJob);
      expect(first.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      })).toMatchObject({ duplicate: false, work: { status: 'pending', attempts: 0 } });
      first.db.close();

      const second = createSqliteStores(path);
      expect(second.jobs.get('job-1')).toEqual(attachedJob);
      expect(second.farmExecutions.get('job-1')).toMatchObject({
        jobId: 'job-1', burnTxHash: 'burn-1', status: 'pending', attempts: 0,
      });
      expect(second.associationOutbox.status(executionIdentity)).toEqual([{
        allocationId: executionIdentity.allocationId,
        executionId: executionIdentity.executionId,
        sequence: 1,
        status: 'pending',
        attempts: 0,
      }]);
    });

    // Defect caught: an outbox failure could still consume the burn slot and strand a pending job.
    it('rolls back the job and work row when accepted lifecycle enqueue fails', () => {
      const stores = createSqliteStores(freshPath());
      stores.jobs.set('job-1', queuedJob);
      expect(() => stores.farmExecutions.attach({
        jobId: 'job-1',
        burnTxHash: 'burn-1',
        job: attachedJob,
        reports: [executionReport(2)],
      })).toThrow(/sequence|order/i);
      expect(stores.jobs.get('job-1')).toEqual(queuedJob);
      expect(stores.farmExecutions.get('job-1')).toBeNull();
      expect(stores.associationOutbox.status(executionIdentity)).toEqual([]);
    });

    // Defect caught: restart had no durable dispatcher-owned claim, while same-hash retries either
    // did nothing or could start a second external flow.
    it('resumes pending work after reopen and grants only one bounded execution lease', () => {
      const path = freshPath();
      const first = createSqliteStores(path);
      first.jobs.set('job-1', queuedJob);
      first.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      });
      first.db.close();

      const second = createSqliteStores(path);
      const third = createSqliteStores(path);
      expect(second.farmExecutions.listRecoverable({ now: 1000 })).toEqual([
        expect.objectContaining({ jobId: 'job-1', status: 'pending' }),
      ]);
      const claimed = second.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      expect(claimed).toMatchObject({ status: 'running', attempts: 1, leaseExpiresAt: 1100 });
      expect(() => third.farmExecutions.renew({
        jobId: 'job-1', leaseToken: 'stale-token', now: 1050, leaseMs: 100,
      })).toThrow(/stale|uncertain/i);
      expect(third.farmExecutions.renew({
        jobId: 'job-1', leaseToken: claimed.leaseToken, now: 1050, leaseMs: 100,
      })).toMatchObject({ status: 'running', attempts: 1, leaseExpiresAt: 1150 });
      expect(third.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 })).toBeNull();
      expect(third.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      })).toMatchObject({ duplicate: true, work: { status: 'running', attempts: 1 } });
      expect(third.associationOutbox.status(executionIdentity)).toHaveLength(1);
    });
  });

  describe('encrypted mandate v3 persistence', () => {
    it('safely upgrades the exact empty pre-policy v3 schema and creates migration state', () => {
      const path = freshPath();
      createPrePolicyV3(path);
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        const columns = stores.db.prepare('PRAGMA table_info(mandates_v3)').all()
          .map(({ name }) => name);
        expect(columns).toEqual(expect.arrayContaining(['policy_digest', 'session_key_digest']));
        expect(tableNames(stores.db)).toContain('mandate_migration_state');
        expect(stores.probe()).toMatchObject({ mandateMigrationCleanupPending: false });
        expect(stores.mandateActivations.enqueue({ record: mandateRecord() }))
          .toMatchObject({ duplicate: false, mandate: { policyDigest: POLICY_DIGEST } });
        expect(stores.db.prepare(`
          SELECT policy_digest, session_key_digest FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          policy_digest: POLICY_DIGEST, session_key_digest: SESSION_KEY_DIGEST,
        });
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['nonempty pre-policy', (path) => createPrePolicyV3(path, { withRow: true })],
      ['incompatible', (path) => {
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE mandates_v3 (mandate_id TEXT PRIMARY KEY)');
        db.close();
      }],
    ])('fails closed for a %s v3 target instead of guessing or backfilling', (_label, seed) => {
      const path = freshPath();
      seed(path);
      const before = sqliteSnapshot(path);
      let opened;
      try {
        expect(() => {
          opened = createSqliteStores(path, {
            sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
          });
        }).toThrow(/schema|upgrade|incompatible|nonempty|policy|digest/i);
      } finally {
        opened?.db.close();
      }
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('creates only the encrypted mandate schema on a fresh database and never writes the raw key', () => {
      const path = freshPath();
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(tableNames(stores.db)).toEqual(expect.arrayContaining([
          'mandates_v3', 'mandate_activation_work',
        ]));
        expect(tableNames(stores.db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));

        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const raw = stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash, policy_digest,
                 valid_until_seconds
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw.session_key_envelope).toMatch(/^v1\.active\./);
        expect(raw.session_key_envelope).not.toContain(SESSION_PRIVATE_KEY);
        expect(raw.session_key_digest).toBe(SESSION_KEY_DIGEST);
        expect(raw.capability_hash).toBe(CAPABILITY_HASH);
        expect(raw.policy_digest).toBe(POLICY_DIGEST);
        expect(raw.valid_until_seconds).toBe(VALID_UNTIL_SECONDS);
        const publicStatus = stores.mandatesV3.status(mandateIdentity());
        expect(publicStatus).toMatchObject({
          mandateId: MANDATE_ID,
          policyDigest: POLICY_DIGEST,
          kernelAddress: KERNEL.toLowerCase(),
          sessionKeyAddress: SESSION.toLowerCase(),
        });
        expectNoAuthorityFields(publicStatus);
        expect(readFileSync(path).includes(Buffer.from(SESSION_PRIVATE_KEY))).toBe(false);
      } finally {
        stores.db.close();
      }
    });

    it('rechecks mandate expiry after acquiring the enqueue write lock', () => {
      const path = freshPath();
      const clock = { value: NOW_SECONDS };
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => clock.value,
      });
      const originalExec = DatabaseSync.prototype.exec;
      let lockedBegins = 0;
      try {
        DatabaseSync.prototype.exec = function advanceClockAfterLock(sql) {
          const result = originalExec.call(this, sql);
          if (this === stores.db && String(sql).trim().toUpperCase() === 'BEGIN IMMEDIATE') {
            lockedBegins += 1;
            clock.value = VALID_UNTIL_SECONDS;
          }
          return result;
        };

        let enqueueError;
        try {
          stores.mandateActivations.enqueue({ record: mandateRecord() });
        } catch (error) {
          enqueueError = error;
        }
        expect(lockedBegins).toBe(1);
        expect(enqueueError).toBeInstanceOf(Error);
        expect(enqueueError.message).toMatch(/mandate|expired|expiry/i);
        expect(enqueueError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(enqueueError.message).not.toContain(SESSION_KEY_DIGEST);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        stores.db.close();
      }
    });

    it('survives reopen and grants exactly one activation lease across competing connections', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      first.db.close();

      const second = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      const third = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(second.mandateActivations.listRecoverable({ nowSeconds: NOW_SECONDS }))
          .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'pending' })]);
        const claimed = second.mandateActivations.claim({
          ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
        });
        expect(claimed).toMatchObject({ status: 'running', attempts: 1 });
        expect(third.mandateActivations.claim({
          ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
        })).toBeNull();
      } finally {
        second.db.close();
        third.db.close();
      }
    });

    it('normalizes omitted nullable identity metadata across reopen before duplicate comparison', () => {
      const path = freshPath();
      const omitted = mandateRecord();
      delete omitted.relayerOrigin;
      delete omitted.bindingId;
      delete omitted.permissionId;
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: omitted });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        for (const duplicateRecord of [
          { ...omitted },
          { ...omitted, relayerOrigin: undefined, bindingId: undefined, permissionId: undefined },
          { ...omitted, relayerOrigin: null, bindingId: null, permissionId: null },
        ]) {
          expect(reopened.mandateActivations.enqueue({ record: duplicateRecord }))
            .toMatchObject({
              duplicate: true,
              mandate: { relayerOrigin: null, bindingId: null, permissionId: null },
              work: { status: 'pending', attempts: 0 },
            });
        }
        expect(() => reopened.mandateActivations.enqueue({
          record: { ...omitted, relayerOrigin: 'https://changed-relayer.example' },
        })).toThrow(/immutable|conflict/i);
        expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(1);
      } finally {
        reopened.db.close();
      }
    });

    it('rotates an envelope encrypted by a previous key when the mandate is read', () => {
      const path = freshPath();
      const previous = Buffer.alloc(32, 0x42);
      const active = Buffer.alloc(32, 0x43);
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher([['previous', previous]]), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      expect(first.db.prepare('SELECT session_key_envelope FROM mandates_v3 WHERE mandate_id = ?')
        .get(MANDATE_ID).session_key_envelope).toMatch(/^v1\.previous\./);
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher([['active', active], ['previous', previous]]),
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(reopened.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(reopened.db.prepare('SELECT session_key_envelope FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID).session_key_envelope).toMatch(/^v1\.active\./);
      } finally {
        reopened.db.close();
      }
    });

    it.each([false, true])('never returns a session key when a concurrent revoke wins during decrypt (rotation=%s)', (needsRotation) => {
      const path = freshPath();
      const previous = Buffer.alloc(32, 0x42);
      const active = Buffer.alloc(32, 0x43);
      const writer = createSqliteStores(path, {
        sessionKeyCipher: cipher([['previous', previous]]), nowSeconds: () => NOW_SECONDS,
      });
      writer.mandateActivations.enqueue({ record: mandateRecord() });
      writer.db.close();

      const activeCipher = cipher([['active', active], ['previous', previous]]);
      const revoker = createSqliteStores(path, {
        sessionKeyCipher: activeCipher, nowSeconds: () => NOW_SECONDS,
      });
      const racingCipher = Object.freeze({
        seal: (...args) => activeCipher.seal(...args),
        open(...args) {
          const opened = activeCipher.open(...args);
          revoker.mandatesV3.revoke(mandateIdentity());
          return { ...opened, needsRotation };
        },
      });
      const reader = createSqliteStores(path, {
        sessionKeyCipher: racingCipher, nowSeconds: () => NOW_SECONDS,
      });
      try {
        const staleRead = reader.mandatesV3.get(mandateIdentity());
        expect(staleRead.sessionPrivateKey).toBeUndefined();
        expect(staleRead.capabilityHash).toBe(CAPABILITY_HASH);
        expect(reader.mandatesV3.status(mandateIdentity()).status).toBe('revoked');
        expect(reader.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'revoked', session_key_envelope: null, session_key_digest: SESSION_KEY_DIGEST,
        });
        expect(reader.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
      } finally {
        reader.db.close();
        revoker.db.close();
      }
    });

    it('renews an activation lease after reopening the durable store', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      const claimed = first.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 20,
      });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 5,
      });
      try {
        expect(reopened.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          nowSeconds: NOW_SECONDS + 5, leaseSeconds: 40,
        })).toMatchObject({
          status: 'running', leaseToken: claimed.leaseToken,
          leaseExpiresAt: NOW_SECONDS + 45, attempts: 1,
        });
      } finally {
        reopened.db.close();
      }
    });

    it('rejects an old lease token after reopen reconciliation and reclaim from a second connection', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      const original = first.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 10,
      });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 10,
      });
      reopened.mandateActivations.reconcileExpired({ nowSeconds: NOW_SECONDS + 10 });
      const reclaimed = reopened.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS + 10, leaseSeconds: 20,
      });
      const competitor = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 11,
      });
      try {
        expect(reclaimed.leaseToken).not.toBe(original.leaseToken);
        expect(() => competitor.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: original.leaseToken,
          nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
        })).toThrow(/stale|lease|token/i);
        expect(competitor.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: reclaimed.leaseToken,
          nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
        })).toMatchObject({
          status: 'running', attempts: 2, leaseToken: reclaimed.leaseToken,
          leaseExpiresAt: NOW_SECONDS + 31,
        });
      } finally {
        competitor.db.close();
        reopened.db.close();
      }
    });

    it.each([
      ['identical', mandateRecord(), mandateRecord(), false],
      ['conflicting', mandateRecord(), mandateRecord({ capabilityHash: 'cc'.repeat(32) }), true],
    ])('resolves true concurrent %s enqueues atomically without leaking raw SQLite errors', async (
      _label, leftRecord, rightRecord, shouldConflict,
    ) => {
      const path = freshPath();
      const results = await runConcurrentEnqueues(path, leftRecord, rightRecord);
      const errors = results.filter(({ outcome }) => outcome === 'error');
      const successes = results.filter(({ outcome }) => outcome === 'ok');
      for (const result of results) {
        expect(result.message || '').not.toMatch(/SQLITE_BUSY|database is locked|constraint failed/i);
        expect(JSON.stringify(result)).not.toContain(SESSION_PRIVATE_KEY);
        expect(JSON.stringify(result)).not.toContain(SESSION_KEY_DIGEST);
      }
      if (shouldConflict) {
        expect(successes).toHaveLength(1);
        expect(successes[0]).toMatchObject({ duplicate: false, workStatus: 'pending' });
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/immutable|conflict/i);
      } else {
        expect(errors).toEqual([]);
        expect(successes).toHaveLength(2);
        expect(successes.map(({ duplicate }) => duplicate).sort())
          .toEqual([false, true]);
      }

      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(1);
        expect(stores.mandateActivations.get(mandateIdentity()))
          .toMatchObject({ status: 'pending', attempts: 0 });
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['mandate ID', 'mandate_id', '8d8f94a2c16b4e6488bf07b81234abcd', { mandateId: '8d8f94a2c16b4e6488bf07b81234abcd' }],
      ['approval digest', 'approval_digest', 'cc'.repeat(32), {}],
      ['owner', 'stellar_owner', Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(), {
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(),
      }],
      ['kernel', 'kernel_address', '0x1234567890abcdef1234567890abcdef12345678', {
        kernelAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }],
      ['session', 'session_key_address', `0x${'34'.repeat(20)}`, {}],
      ['validUntilSeconds', 'valid_until_seconds', VALID_UNTIL_SECONDS + 1, {}],
      ['binding ID', 'binding_id', 'binding-tampered', {}],
    ])('rejects an envelope after authenticated AAD field %s is tampered', (_label, column, value, identityOverride) => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?').run(MANDATE_ID);
        stores.db.prepare(`UPDATE mandates_v3 SET ${column} = ? WHERE mandate_id = ?`)
          .run(value, MANDATE_ID);
        expect(() => stores.mandatesV3.get({ ...mandateIdentity(), ...identityOverride }))
          .toThrow(/encrypted session key envelope|auth|aad/i);
      } finally {
        stores.db.close();
      }
    });

    it('revocation retains only public status plus internal capability auth and wipes ciphertext and work', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const revoked = stores.mandatesV3.revoke(mandateIdentity());
        const raw = stores.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw).toEqual({
          status: 'revoked', session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST, capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
        const publicStatus = stores.mandatesV3.status(mandateIdentity());
        expectNoAuthorityFields(revoked);
        expectNoAuthorityFields(publicStatus);
        expect(JSON.stringify(publicStatus)).not.toContain(CAPABILITY_HASH);
      } finally {
        stores.db.close();
      }
    });

    it('expiry wipes the encrypted key but retains only a DB-internal session digest for idempotency', () => {
      const clock = { value: NOW_SECONDS };
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => clock.value,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        clock.value = VALID_UNTIL_SECONDS;
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('expired');
        expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
        expect(stores.mandateActivations.get(mandateIdentity())).toBeNull();
        expect(stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expectNoAuthorityFields(stores.mandatesV3.status(mandateIdentity()));
        expectNoAuthorityFields(stores.mandateActivations.get(mandateIdentity()));
      } finally {
        stores.db.close();
      }
    });

    it('rolls back the mandate insert when activation-work enqueue fails on the second write', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TRIGGER fail_activation_work_enqueue
          BEFORE INSERT ON mandate_activation_work
          BEGIN SELECT RAISE(ABORT, 'injected enqueue second-write failure'); END;
        `);
        expect(() => stores.mandateActivations.enqueue({ record: mandateRecord() }))
          .toThrow(/injected enqueue second-write failure/);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('missing');
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both terminal writes when finishActive fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const claimed = stores.mandateActivations.claim({
          ...mandateIdentity(), leaseSeconds: 30,
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken, status: 'submitting',
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: `0x${'33'.repeat(32)}`,
        });
        stores.db.exec(`
          CREATE TRIGGER fail_finish_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'active' AND (
            SELECT status FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          ) = 'done'
          BEGIN SELECT RAISE(ABORT, 'injected finish second-write failure'); END;
          CREATE TRIGGER fail_finish_if_work_is_second
          BEFORE UPDATE OF status ON mandate_activation_work
          WHEN NEW.status = 'done' AND (
            SELECT status FROM mandates_v3 WHERE mandate_id = NEW.mandate_id
          ) = 'active'
          BEGIN SELECT RAISE(ABORT, 'injected finish second-write failure'); END;
        `);

        expect(() => stores.mandateActivations.finishActive({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          userOpHash: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          activatedAt: NOW_SECONDS + 1,
        })).toThrow(/injected finish second-write failure/);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('pending_activation');
        expect(stores.mandateActivations.get(mandateIdentity()))
          .toMatchObject({ status: 'submitted', leaseToken: claimed.leaseToken });
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both receipt-revoke writes when finishRevoked fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const claimed = stores.mandateActivations.claim({
          ...mandateIdentity(), leaseSeconds: 30,
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken, status: 'submitting',
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: `0x${'33'.repeat(32)}`,
        });
        const beforeMandate = stores.db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID);
        const beforeWork = stores.db.prepare(
          'SELECT * FROM mandate_activation_work WHERE mandate_id = ?',
        ).get(MANDATE_ID);
        stores.db.exec(`
          CREATE TRIGGER fail_receipt_revoke_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'revoked' AND NOT EXISTS (
            SELECT 1 FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          )
          BEGIN SELECT RAISE(ABORT, 'injected receipt-revoke second-write failure'); END;
          CREATE TRIGGER fail_receipt_revoke_if_work_is_second
          BEFORE DELETE ON mandate_activation_work
          WHEN (SELECT status FROM mandates_v3 WHERE mandate_id = OLD.mandate_id) = 'revoked'
          BEGIN SELECT RAISE(ABORT, 'injected receipt-revoke second-write failure'); END;
        `);

        expect(() => stores.mandateActivations.finishRevoked({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          userOpHash: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          activatedAt: NOW_SECONDS + 1,
        })).toThrow(/injected receipt-revoke second-write failure/);
        expect(stores.db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID)).toEqual(beforeMandate);
        expect(stores.db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
          .get(MANDATE_ID)).toEqual(beforeWork);
        expect(stores.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(stores.mandatesV3.get(mandateIdentity()).capabilityHash)
          .toBe(CAPABILITY_HASH);
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both revoke writes when revoke fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.exec(`
          CREATE TRIGGER fail_revoke_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'revoked' AND NOT EXISTS (
            SELECT 1 FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          )
          BEGIN SELECT RAISE(ABORT, 'injected revoke second-write failure'); END;
          CREATE TRIGGER fail_revoke_if_work_is_second
          BEFORE DELETE ON mandate_activation_work
          WHEN (SELECT status FROM mandates_v3 WHERE mandate_id = OLD.mandate_id) = 'revoked'
          BEGIN SELECT RAISE(ABORT, 'injected revoke second-write failure'); END;
        `);

        expect(() => stores.mandatesV3.revoke(mandateIdentity()))
          .toThrow(/injected revoke second-write failure/);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('pending_activation');
        expect(stores.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(stores.mandateActivations.get(mandateIdentity()).status).toBe('pending');
      } finally {
        stores.db.close();
      }
    });

    it('preserves the Task4 policy digest across reopen in public and internal projections', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(reopened.mandatesV3.status(mandateIdentity()).policyDigest).toBe(POLICY_DIGEST);
        expect(reopened.mandatesV3.get(mandateIdentity()).policyDigest).toBe(POLICY_DIGEST);
      } finally {
        reopened.db.close();
      }
    });

    it('revalidates the target ensemble during probe and rejects a direct target trigger', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TRIGGER unexpected_probe_target_trigger AFTER UPDATE ON mandates_v3
          BEGIN SELECT 1; END
        `);
        expect(() => stores.probe()).toThrow(/schema|ensemble|trigger|readiness|integrity/i);
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['an auxiliary trigger that mutates mandates', (db) => db.exec(`
        CREATE TABLE auxiliary_events (id INTEGER PRIMARY KEY);
        CREATE TRIGGER auxiliary_events_mutate_mandates AFTER INSERT ON auxiliary_events
        BEGIN UPDATE mandates_v3 SET updated_at = updated_at; END
      `)],
      ['a view over mandates', (db) => db.exec(`
        CREATE VIEW auxiliary_mandate_view AS
        SELECT mandate_id, status FROM mandates_v3
      `)],
      ['an inbound foreign key to mandates', (db) => db.exec(`
        CREATE TABLE auxiliary_mandate_reference (
          id INTEGER PRIMARY KEY,
          mandate_id TEXT REFERENCES mandates_v3(mandate_id)
        )
      `)],
    ])('rejects %s during runtime probe', (_label, mutateSchema) => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        mutateSchema(stores.db);
        expect(() => stores.probe()).toThrow(
          /schema|ensemble|trigger|view|foreign|dependency|readiness|integrity/i,
        );
      } finally {
        stores.db.close();
      }
    });

    it('allows unrelated auxiliary schema during runtime probe', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TABLE auxiliary_events (id INTEGER PRIMARY KEY, note TEXT);
          CREATE TABLE auxiliary_audit (event_id INTEGER NOT NULL, note TEXT);
          CREATE VIEW auxiliary_event_view AS SELECT id, note FROM auxiliary_events;
          CREATE TRIGGER auxiliary_event_audit AFTER INSERT ON auxiliary_events
          BEGIN
            INSERT INTO auxiliary_audit (event_id, note) VALUES (NEW.id, NEW.note);
          END
        `);
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }
    });

    it('rejects activation work whose parent identity is NULL during runtime probe', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.prepare(`
          UPDATE mandates_v3 SET stellar_owner = NULL, kernel_address = NULL
          WHERE mandate_id = ?
        `).run(MANDATE_ID);
        expect(() => stores.probe()).toThrow(/identity|integrity|schema|readiness/i);
      } finally {
        stores.db.close();
      }
    });

    it('accepts activation work whose non-NULL identity matches its parent', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }
    });

    it('enables foreign keys so orphan activation work cannot be inserted', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
        expect(() => stores.db.prepare(`
          INSERT INTO mandate_activation_work (
            mandate_id, stellar_owner, kernel_address, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
        `).run('ffffffffffffffffffffffffffffffff', OWNER, KERNEL.toLowerCase(), NOW_SECONDS, NOW_SECONDS))
          .toThrow(/foreign key/i);
      } finally {
        stores.db.close();
      }
    });
  });

  describe('offline plaintext mandate migration', () => {
    it.each([
      ['absent', undefined],
      ['wrong', { RELAYER_OFFLINE_KEY_MIGRATION: '0' }],
    ])('rejects %s offline flag before manifest inspection or migration mutation', async (_label, env) => {
      const path = freshPath();
      expect(existsSync(path)).toBe(false);
      const migration = await migrationLibrary();
      let parserCalls = 0;
      const parseCanonicalApproval = () => { parserCalls += 1; };
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        env, parseCanonicalApproval,
      })))
        .toThrow(/RELAYER_OFFLINE_KEY_MIGRATION|offline/i);
      expect(existsSync(path)).toBe(false);
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        env, parseCanonicalApproval, sessionKeyCipher: cipher(),
        manifest: { version: 1, sourceDigest: '00', entries: [] },
      }))).toThrow(/RELAYER_OFFLINE_KEY_MIGRATION|offline/i);
      expect(existsSync(path)).toBe(false);
      expect(parserCalls).toBe(0);
    });

    it('uses memory-only SQLite temp storage before every migration connection reads schema or source data', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      let stage = 'manifest';
      const observer = observeMigrationTempStore(path, () => stage);
      let manifest;
      let interrupted;
      let resumed;
      try {
        manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        stage = 'migration';
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: cipher(),
            migrationHooks: {
              afterDestructiveCommit() {
                throw new Error(`interrupt cleanup after commit ${SESSION_PRIVATE_KEY}`);
              },
            },
          }));
        } catch (error) {
          interrupted = error;
        }
        stage = 'cleanup-resume';
        resumed = migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }));
      } finally {
        observer.restore();
      }

      expect(manifest.entries).toHaveLength(1);
      expect(interrupted).toBeInstanceOf(Error);
      expect(interrupted.message).toBe('offline mandate migration cleanup is pending');
      expect(interrupted.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(resumed).toMatchObject({ resumedCleanup: true });
      expect(new Set(observer.state.observations.map(({ stage: value }) => value)))
        .toEqual(new Set(['manifest', 'migration', 'cleanup-resume']));
      expect(observer.state.observations.length).toBeGreaterThanOrEqual(3);
      for (const observation of observer.state.observations) {
        expect(observation.mode, `${observation.stage}: ${observation.firstQuery}`).toBe(2);
      }
    });

    describe('migration envelope recoverability', () => {
      it.each([
        ['empty seal output', 'empty-envelope', false, 1],
        ['malformed seal output', 'malformed-envelope', false, 1],
        ['unopenable seal output', 'unopenable-envelope', false, 1],
        ['wrong plaintext on immediate open', 'wrong-immediate-plaintext', false, 1],
        ['open failure on post-insert reread', 'post-insert-open-failure', true, 2],
        ['wrong plaintext on post-insert reread', 'post-insert-wrong-plaintext', true, 2],
      ])('rolls back without deleting plaintext for %s', async (
        _label,
        mode,
        requirePersistedReread,
        expectedOpenCalls,
      ) => {
        const path = freshPath();
        createLegacyV2(path);
        createMigrationVerificationTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = sqliteSnapshot(path);
        const persistedReadObserver = observePersistedMandateEnvelopeReads();
        const sessionKeyCipher = migrationVerificationCipher(mode, {
          persistedEnvelopeWasRead: () => persistedReadObserver.state.reads > 0,
        });
        let migrationError;

        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher,
          }));
        } catch (error) {
          migrationError = error;
        } finally {
          persistedReadObserver.restore();
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(
          /^legacy mandate (?:encryption(?: verification)?|migration verification) failed$/,
        );
        expect(sessionKeyCipher.state.sealCalls).toBe(1);
        expect(sessionKeyCipher.state.openCalls).toBe(expectedOpenCalls);
        if (requirePersistedReread) {
          expect(persistedReadObserver.state.reads).toBeGreaterThanOrEqual(1);
          expect(persistedReadObserver.state.envelope).toBe(sessionKeyCipher.state.sealedEnvelope);
          expect(sessionKeyCipher.state.openedEnvelopes[1]).toBe(persistedReadObserver.state.envelope);
        }
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          WRONG_SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          CAPABILITY_HASH,
          sessionKeyCipher.state.sealedEnvelope,
        ]) {
          if (sensitiveValue) expect(migrationError.message).not.toContain(sensitiveValue);
        }
        expectLosslessMigrationRollback(path, before);
      });
    });

    describe('canonical destination manifest digest', () => {
      it('emits a stable lowercase digest without copying destination authority into the manifest', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const migration = await migrationLibrary();
        const policyDigest = 'ab'.repeat(32);
        const parseCanonicalApproval = (params) => ({
          ...canonicalLegacyParser(params),
          policyDigest,
        });

        const first = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval,
        }));
        const second = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval,
        }));
        const entry = first.entries[0];

        expect(entry).toMatchObject({
          rowDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          outcome: 'migrate',
          destinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(second.entries[0].destinationDigest).toBe(entry.destinationDigest);
        expect(first.sourceDigest).toBe(second.sourceDigest);
        expectNoAuthorityFields(first);
        const serializedManifest = JSON.stringify(first);
        for (const forbidden of [
          SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          APPROVAL_DIGEST,
          CAPABILITY_HASH,
          'serializedApproval',
          'approvalDigest',
          'sessionKeyEnvelope',
          'session_key_envelope',
        ]) {
          expect(serializedManifest).not.toContain(forbidden);
        }
      });

      it('rejects a canonical destination changed only during the locked rescan before sealing', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const migration = await migrationLibrary();
        const preflightPolicyDigest = 'ab'.repeat(32);
        const lockedPolicyDigest = 'cd'.repeat(32);
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval(params) {
            return { ...canonicalLegacyParser(params), policyDigest: preflightPolicyDigest };
          },
        }));
        const stableDestinationDigest = manifest.entries[0].destinationDigest;
        const before = sqliteSnapshot(path);
        let activePolicyDigest = preflightPolicyDigest;
        let parserCalls = 0;
        let afterPreflightCalls = 0;
        let sealCalls = 0;
        const envelopeCipher = cipher();
        let migrationError;

        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            parseCanonicalApproval(params) {
              parserCalls += 1;
              return {
                ...canonicalLegacyParser(params),
                policyDigest: activePolicyDigest,
              };
            },
            migrationHooks: {
              afterPreflight() {
                afterPreflightCalls += 1;
                activePolicyDigest = lockedPolicyDigest;
              },
            },
            sessionKeyCipher: {
              open: (...args) => envelopeCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/destination|manifest|agreement|stale|changed/i);
        expect(afterPreflightCalls).toBe(1);
        expect(parserCalls).toBeGreaterThanOrEqual(2);
        expect(sealCalls).toBe(0);
        expect(manifest.entries[0].destinationDigest).toBe(stableDestinationDigest);
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          CAPABILITY_HASH,
          preflightPolicyDigest,
          lockedPolicyDigest,
        ]) {
          expect(migrationError.message).not.toContain(sensitiveValue);
        }
        expect(sqliteSnapshot(path)).toStrictEqual(before);
      });
    });

    describe('migration target ensemble validation', () => {
      const topologyCases = [
        ['orphan work table without v3', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec('PRAGMA foreign_keys=OFF; DROP TABLE mandates_v3;');
          db.close();
        }],
        ['clean marker-only layout', (path) => createMarkerOnlyLayout(path, { phase: 'virgin' })],
        ['pending marker-only layout', (path) => createMarkerOnlyLayout(path, {
          phase: 'cleanup_pending',
        })],
        ['malformed pending marker-only layout', (path) => createMarkerOnlyLayout(path, {
          phase: 'cleanup_pending', idCheck: '', phaseCheck: '', metadataCheck: '',
        })],
        ['empty v3 with orphan activation work', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec('PRAGMA foreign_keys=OFF');
          insertActivationWork(db, { mandateId: 'missing-parent' });
          db.close();
        }],
        ['v3 with a hidden generated column', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec(`
            ALTER TABLE mandates_v3
            ADD COLUMN hidden_probe TEXT GENERATED ALWAYS AS (lower(status)) VIRTUAL
          `);
          db.close();
        }],
        ['v3 with an unexpected trigger', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec(`
            CREATE TRIGGER unexpected_mandate_trigger AFTER INSERT ON mandates_v3
            BEGIN SELECT 1; END
          `);
          db.close();
        }],
      ];

      const workMetadataCases = [
        ['missing work status CHECK', { statusCheck: '' }],
        ['altered work status CHECK', {
          statusCheck: "CHECK (status IN ('pending','running','submitting','submitted','done','uncertain','bypass'))",
        }],
        ['missing attempts DEFAULT', { attemptsDefault: '' }],
        ['missing work foreign key', { foreignKey: '' }],
      ];

      const stateInvariantCases = [
        ['missing state CHECK constraints', {
          idCheck: '', phaseCheck: '', metadataCheck: '', rows: [VIRGIN_MIGRATION_MARKER_ROW],
        }],
        ['altered singleton CHECK', {
          idCheck: 'CHECK (id IN (1, 2))', rows: [VIRGIN_MIGRATION_MARKER_ROW],
        }],
        ['missing singleton row', { rows: [] }],
        ['extra marker row', {
          idCheck: 'CHECK (id IN (1, 2))',
          rows: [VIRGIN_MIGRATION_MARKER_ROW, [2, ...VIRGIN_MIGRATION_MARKER_ROW.slice(1)]],
        }],
        ['invalid phase', {
          phaseCheck: "CHECK (phase IN ('virgin','cleanup_pending','completed','malformed'))",
          metadataCheck: `${CANONICAL_MIGRATION_MARKER_METADATA_CHECK.slice(0, -1)}
            OR phase = 'malformed')`,
          rows: [boundMigrationMarkerRow({ phase: 'malformed' })],
        }],
      ];

      async function expectFreshLayoutRejected(setupTarget) {
        const path = freshPath();
        createLegacyV2(path);
        setupTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = migrationTargetSnapshot(path);
        const envelopeCipher = cipher();
        let sealCalls = 0;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: {
              open: (...args) => envelopeCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/target|schema|ensemble|marker|integrity|migration/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationError.message).not.toContain(APPROVAL);
        expect(sealCalls).toBe(0);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
      }

      it.each(topologyCases)('rejects %s before sealing or mutation', async (_label, setupTarget) => {
        await expectFreshLayoutRejected(setupTarget);
      });

      it.each(workMetadataCases)('rejects %s with otherwise identical columns', async (_label, mutation) => {
        await expectFreshLayoutRejected((path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          replaceActivationWorkSchema(db, mutation);
          db.close();
        });
      });

      it.each(stateInvariantCases)('rejects %s before sealing or mutation', async (_label, mutation) => {
        await expectFreshLayoutRejected((path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          replaceMigrationStateSchema(db, mutation);
          db.close();
        });
      });

      it('accepts the exact empty canonical target ensemble', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const db = new DatabaseSync(path);
        db.exec(MANDATE_V3_SCHEMA);
        db.close();
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          manifest, sessionKeyCipher: cipher(),
        }))).toMatchObject({ migrated: 1, quarantined: 0 });
      });

      it.each([
        ['orphan work row', ({ db }) => {
          db.exec('PRAGMA foreign_keys=OFF');
          insertActivationWork(db, { mandateId: 'missing-parent' });
        }],
        ['parent identity mismatch', ({ db, mandateId }) => insertActivationWork(db, {
          mandateId,
          stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey(),
        })],
      ])('rejects cleanup resume with %s and keeps the pending marker', async (_label, corrupt) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        const db = new DatabaseSync(path);
        const mandateId = db.prepare('SELECT mandate_id FROM mandates_v3').get().mandate_id;
        corrupt({ db, mandateId });
        db.close();
        const before = migrationTargetSnapshot(path);
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({ sessionKeyCipher: cipher() }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/target|schema|ensemble|integrity|foreign|identity/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
        expect(before.state).toEqual([
          expect.objectContaining({ id: 1, phase: 'cleanup_pending' }),
        ]);
      });
    });

    describe('migration cleanup marker ordering', () => {
      it.each([
        ['throwing hook', () => { throw new Error(`hook detail ${SESSION_PRIVATE_KEY}`); }],
        ['thenable hook', () => Promise.resolve('must not be awaited')],
      ])('keeps cleanup pending when the synchronous beforeMarkerClear %s interrupts', async (
        _label,
        hookResult,
      ) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        let hookArgs;
        let markerAtHook;
        let plaintextPresentAtHook;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            sessionKeyCipher: cipher(),
            migrationHooks: {
              beforeMarkerClear(...args) {
                hookArgs = args;
                const inspection = new DatabaseSync(path, { readOnly: true });
                markerAtHook = inspection.prepare(`
                  SELECT phase FROM mandate_migration_state WHERE id = 1
                `).get()?.phase;
                inspection.close();
                plaintextPresentAtHook = [path, `${path}-wal`, `${path}-journal`].some((artifact) => (
                  existsSync(artifact)
                  && readFileSync(artifact).includes(Buffer.from(SESSION_PRIVATE_KEY))
                ));
                return hookResult();
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toBe('offline mandate migration cleanup is pending');
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(hookArgs).toEqual([]);
        expect(markerAtHook).toBe('cleanup_pending');
        expect(plaintextPresentAtHook).toBe(false);
        const pending = new DatabaseSync(path, { readOnly: true });
        expect(pending.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'cleanup_pending' });
        pending.close();
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }))).toMatchObject({ resumedCleanup: true });
      });

      it.each([
        ['missing singleton', (db) => db.prepare('DELETE FROM mandate_migration_state WHERE id = 1').run()],
        ['malformed singleton', (db) => {
          db.exec('PRAGMA ignore_check_constraints=ON');
          db.prepare("UPDATE mandate_migration_state SET phase = 'malformed' WHERE id = 1").run();
        }],
      ])('does not report cleanup success when the marker becomes a %s before clear', async (
        _label,
        corruptMarker,
      ) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            sessionKeyCipher: cipher(),
            migrationHooks: {
              beforeMarkerClear() {
                const db = new DatabaseSync(path);
                corruptMarker(db);
                db.close();
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toBe('offline mandate migration cleanup is pending');
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        const db = new DatabaseSync(path, { readOnly: true });
        const marker = db.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get();
        db.close();
        if (_label === 'missing singleton') expect(marker).toBeUndefined();
        else expect(marker).toEqual({ phase: 'malformed' });
      });
    });

    describe('cleanup resume envelope verification', () => {
      it('rotates every persisted envelope to the active key before completing cleanup', async () => {
        const path = freshPath();
        const previousKey = Buffer.alloc(32, 0x42);
        const activeKey = Buffer.alloc(32, 0x43);
        const previousOnly = cipher([['previous', previousKey]]);
        const { migration, options } = await seedBoundPendingMigrationCleanup(path, {
          sessionKeyCipher: previousOnly,
        });
        const rotatingCipher = cipher([['active', activeKey], ['previous', previousKey]]);

        expect(migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: rotatingCipher,
        })).toMatchObject({ resumedCleanup: true });

        const persisted = new DatabaseSync(path, { readOnly: true });
        let migratedRows;
        try {
          migratedRows = persisted.prepare(`
            SELECT mandate_id, serialized_approval, stellar_owner, kernel_address,
                   session_key_envelope
            FROM mandates_v3 ORDER BY mandate_id
          `).all();
          expect(migratedRows).toHaveLength(2);
          expect(migratedRows.every(({ session_key_envelope: envelope }) => (
            typeof envelope === 'string' && envelope.startsWith('v1.active.')
          ))).toBe(true);
          expect(persisted.prepare(`
            SELECT phase FROM mandate_migration_state WHERE id = 1
          `).get()).toEqual({ phase: 'completed' });
        } finally {
          persisted.close();
        }

        const activeOnly = createSqliteStores(path, {
          sessionKeyCipher: cipher([['active', activeKey]]),
          nowSeconds: () => NOW_SECONDS,
        });
        try {
          const expectedKeys = new Map([
            [APPROVAL, SESSION_PRIVATE_KEY],
            ['canonical-approval-fixture-two', SECOND_SESSION_PRIVATE_KEY],
          ]);
          for (const row of migratedRows) {
            const internal = activeOnly.mandatesV3.get({
              mandateId: row.mandate_id,
              stellarOwner: row.stellar_owner,
              kernelAddress: row.kernel_address,
            });
            expect(internal.sessionPrivateKey).toBe(expectedKeys.get(row.serialized_approval));
          }
        } finally {
          activeOnly.db.close();
        }
      });

      it('rolls back cleanup rotation and keeps the pending marker when a replacement cannot be sealed', async () => {
        const path = freshPath();
        const previousKey = Buffer.alloc(32, 0x42);
        const activeKey = Buffer.alloc(32, 0x43);
        const { migration, options } = await seedBoundPendingMigrationCleanup(path, {
          sessionKeyCipher: cipher([['previous', previousKey]]),
        });
        const before = migrationTargetSnapshot(path);
        const baseCipher = cipher([['active', activeKey], ['previous', previousKey]]);
        let sealCalls = 0;
        let cleanupError;
        try {
          migration.migrateLegacyMandates(path, {
            ...options,
            sessionKeyCipher: {
              open: (...args) => baseCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                if (sealCalls === 2) {
                  throw new Error(`replacement seal exposed ${SECOND_SESSION_PRIVATE_KEY}`);
                }
                return baseCipher.seal(...args);
              },
            },
          });
        } catch (error) {
          cleanupError = error;
        }

        expect(sealCalls).toBe(2);
        expect(cleanupError).toBeInstanceOf(Error);
        expect(cleanupError.message).toBe('offline mandate migration cleanup is pending');
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SECOND_SESSION_PRIVATE_KEY,
          ...before.mandates.map(({ session_key_envelope: envelope }) => envelope),
        ]) {
          expect(cleanupError.message).not.toContain(sensitiveValue);
        }
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
        expect(before.state).toEqual([
          expect.objectContaining({ phase: 'cleanup_pending' }),
        ]);
      });

      it.each([
        ['missing cipher', null],
        ['second envelope open failure', 'throw-second'],
        ['wrong plaintext from second envelope', 'wrong-second'],
      ])('rejects %s before cleanup and leaves the marker pending', async (_label, mode) => {
        const path = freshPath();
        const { migration, options } = await seedBoundPendingMigrationCleanup(path);
        const before = migrationTargetSnapshot(path);
        const targetTables = before.objects
          .filter(({ type }) => type === 'table')
          .map(({ name }) => name.toLowerCase())
          .sort();
        expect(targetTables).toEqual([
          'mandate_activation_work', 'mandate_migration_state', 'mandates_v3',
        ]);
        expect(before.mandates).toHaveLength(2);
        expect(before.mandates.every(({ status }) => status === 'activation_uncertain')).toBe(true);
        expect(before.work).toEqual([]);
        expect(before.state).toEqual([
          expect.objectContaining({ id: 1, phase: 'cleanup_pending' }),
        ]);

        const envelopeCipher = cipher();
        let openCalls = 0;
        const sessionKeyCipher = mode === null ? undefined : {
          seal: (...args) => envelopeCipher.seal(...args),
          open(...args) {
            openCalls += 1;
            if (openCalls === 2 && mode === 'throw-second') {
              throw new Error(`corrupt cleanup envelope ${SECOND_SESSION_PRIVATE_KEY}`);
            }
            if (openCalls === 2 && mode === 'wrong-second') {
              return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
            }
            return envelopeCipher.open(...args);
          },
        };
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, { ...options, sessionKeyCipher });
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/cipher|encryption|verification|cleanup|migration/i);
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SECOND_SESSION_PRIVATE_KEY,
          WRONG_SESSION_PRIVATE_KEY,
          ...before.mandates.map(({ session_key_envelope: envelope }) => envelope),
        ]) {
          expect(migrationError.message).not.toContain(sensitiveValue);
        }
        if (mode !== null) expect(openCalls).toBe(2);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
      });

      it('opens every persisted uncertain envelope before a valid cleanup resume succeeds', async () => {
        const path = freshPath();
        const { migration, options } = await seedBoundPendingMigrationCleanup(path);
        const envelopeCipher = cipher();
        let openCalls = 0;
        const openedEnvelopes = new Set();
        expect(migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: {
            seal: (...args) => envelopeCipher.seal(...args),
            open(...args) {
              openCalls += 1;
              openedEnvelopes.add(args[0]);
              return envelopeCipher.open(...args);
            },
          },
        })).toMatchObject({ resumedCleanup: true });
        expect(openCalls).toBeGreaterThanOrEqual(2);
        const expectedEnvelopes = new DatabaseSync(path, { readOnly: true });
        const persistedEnvelopes = expectedEnvelopes.prepare(`
          SELECT session_key_envelope FROM mandates_v3 ORDER BY mandate_id
        `).all().map(({ session_key_envelope: envelope }) => envelope);
        expectedEnvelopes.close();
        expect(openedEnvelopes).toEqual(new Set(persistedEnvelopes));
        const db = new DatabaseSync(path, { readOnly: true });
        expect(db.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'completed' });
        db.close();
      });
    });

    describe('persisted destination digest verification', () => {
      it.each([
        ['binding hash', (row) => ({ ...row, binding_hash: 'bb'.repeat(32) })],
        ['relayer origin', (row) => ({ ...row, relayer_origin: 'https://changed.example' })],
        ['policy and permission', (row) => ({
          ...row, policy_digest: 'ab'.repeat(32), permission_id: '0xdeadbeef',
        })],
        ['normalized addresses', (row) => ({
          ...row, kernel_address: `0x${'12'.repeat(20)}`, session_key_address: `0x${'34'.repeat(20)}`,
        })],
        ['expiry', (row) => ({ ...row, valid_until_seconds: VALID_UNTIL_SECONDS + 1 })],
        ['session digest', (row) => ({ ...row, session_key_digest: 'bc'.repeat(32) })],
        ['fixed status and null fields', (row) => ({
          ...row,
          status: 'active',
          capability_hash: CAPABILITY_HASH,
          activation_user_op_hash: '0xunexpected',
          activation_tx_hash: '0xunexpected',
          activated_at: NOW_SECONDS,
          quarantine_reason: 'UNEXPECTED',
        })],
      ])('rolls back when persisted %s diverges from the locked destination', async (
        _label,
        transformRow,
      ) => {
        const path = freshPath();
        createLegacyV2(path);
        createMigrationVerificationTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = sqliteSnapshot(path);
        const persistedReadObserver = observePersistedMandateEnvelopeReads({ transformRow });
        const envelopeCipher = cipher();
        let sealCalls = 0;
        let openCalls = 0;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: {
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
              open(...args) {
                openCalls += 1;
                return envelopeCipher.open(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        } finally {
          persistedReadObserver.restore();
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/destination|verification|migration/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationError.message).not.toContain(APPROVAL);
        expect(sealCalls).toBe(1);
        expect(persistedReadObserver.state.reads).toBeGreaterThanOrEqual(1);
        expect(openCalls).toBe(1);
        expectLosslessMigrationRollback(path, before);
      });
    });

    it('passes the full Task4 parser input and migrates a seconds-bound legacy row', async () => {
      const path = freshPath();
      const legacy = createLegacyV2(path);
      const seen = [];
      const migration = await migrationLibrary();
      const parseCanonicalApproval = (params) => {
        seen.push(params);
        return canonicalLegacyParser(params);
      };
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval,
      }));
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), parseCanonicalApproval, manifest,
      }));

      const { permissionId, ...requiredParserInput } = seen[0];
      expect(requiredParserInput).toStrictEqual({
        serializedApproval: APPROVAL,
        sessionPrivateKey: SESSION_PRIVATE_KEY,
        sessionKeyAddress: SESSION,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        validUntilSeconds: VALID_UNTIL_SECONDS,
        expiresAt: VALID_UNTIL_SECONDS,
        relayerOrigin: 'https://relayer.example',
        bindingId: 'binding-1',
        bindingHash: BINDING_HASH,
        config: TASK4_CONFIG,
      });
      expect(permissionId).toBeUndefined();
      expect(legacy.expiresAt).toBe(VALID_UNTIL_SECONDS * 1000);

      const db = new DatabaseSync(path);
      try {
        const migrated = db.prepare(`
          SELECT mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
                 relayer_origin, binding_id, valid_until_seconds, binding_hash, status,
                 capability_hash, session_key_envelope, session_key_digest,
                 kernel_address, session_key_address
          FROM mandates_v3
        `).get();
        expect(migrated).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          policy_digest: POLICY_DIGEST,
          valid_until_seconds: VALID_UNTIL_SECONDS,
          binding_hash: NORMALIZED_BINDING_HASH,
          status: 'activation_uncertain',
          capability_hash: null,
          session_key_digest: SESSION_KEY_DIGEST,
          kernel_address: KERNEL.toLowerCase(),
          session_key_address: SESSION.toLowerCase(),
        });
        expectOpaqueMandateId(migrated.mandate_id, [
          APPROVAL, APPROVAL_DIGEST, OWNER, KERNEL, SESSION, SESSION_PRIVATE_KEY,
          BINDING_HASH, 'binding-1',
        ]);
        expect(migrated.session_key_envelope).toMatch(/^v1\.active\./);
        expect(() => canonicalLegacyParser({
          serializedApproval: migrated.serialized_approval,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
          sessionKeyAddress: migrated.session_key_address,
          stellarOwner: migrated.stellar_owner,
          kernelAddress: migrated.kernel_address,
          validUntilSeconds: migrated.valid_until_seconds,
          expiresAt: migrated.valid_until_seconds,
          relayerOrigin: migrated.relayer_origin,
          bindingId: migrated.binding_id,
          bindingHash: migrated.binding_hash,
          config: TASK4_CONFIG,
        })).not.toThrow();
        expect(tableNames(db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it.each([
      ['REAL expiry', { expiresAt: (VALID_UNTIL_SECONDS * 1000) + 0.5 }],
      ['text expiry', { expiresAt: 'not-an-expiry' }],
      ['unsafe expiry', { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
      ['non-divisible expiry', { expiresAt: (VALID_UNTIL_SECONDS * 1000) + 1 }],
      ['missing binding ID', { bindingId: null }],
      ['missing binding hash', { bindingHash: null }],
      ['millisecond-derived binding hash', {
        bindingHash: createHash('sha256')
          .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS * 1000}`)
          .digest('hex'),
      }],
      ['mismatched binding hash', { bindingHash: 'cc'.repeat(32) }],
    ])('fails losslessly for a v2 row with %s', async (_label, override) => {
      const path = freshPath();
      createLegacyV2(path, override);
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/canonical|expiry|binding|safe|integer|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('fails losslessly for an approval-only v1 plaintext row', async () => {
      const path = freshPath();
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO mandates (approval, session_key, expires_at) VALUES (?, ?, ?)')
        .run(APPROVAL, SESSION_PRIVATE_KEY, VALID_UNTIL_SECONDS * 1000);
      db.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/v1|identity|binding|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('default migration preflights every row and leaves a valid-first invalid-second database byte-for-byte logical unchanged', async () => {
      const path = freshPath();
      const valid = createLegacyV2(path);
      const invalidKey = `0x${'55'.repeat(32)}`;
      const invalid = createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
        kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const envelope = cipher();
      let sealCalls = 0;
      const sessionKeyCipher = Object.freeze({
        seal(...args) {
          sealCalls += 1;
          return envelope.seal(...args);
        },
        open: (...args) => envelope.open(...args),
      });
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher,
      }))).toThrow(/canonical|invalid/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
      expect(sqliteSnapshot(path).v2.map((row) => row.session_private_key))
        .toEqual([invalid.sessionPrivateKey, valid.sessionPrivateKey].sort());
    });

    it('migrates a pre-capability active row once as uncertain with encrypted key and no runnable work', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), manifest,
      }));
      const raw = new DatabaseSync(path);
      const migratedId = raw.prepare('SELECT mandate_id FROM mandates_v3').get().mandate_id;
      raw.close();
      const migratedIdentity = { mandateId: migratedId, stellarOwner: OWNER, kernelAddress: KERNEL };
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.mandatesV3.status(migratedIdentity)).toMatchObject({
          status: 'activation_uncertain', policyDigest: POLICY_DIGEST,
        });
        expect(stores.mandateActivations.get(migratedIdentity)).toBeNull();
        const internal = stores.mandatesV3.get(migratedIdentity);
        expect(internal.sessionPrivateKey).toBe(SESSION_PRIVATE_KEY);
        expect(internal.capabilityHash).toBeUndefined();
        expect(internal.policyDigest).toBe(POLICY_DIGEST);
        expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
        expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(), manifest,
        }))).toEqual({ alreadyMigrated: true, migrated: 1, quarantined: 0 });
      } finally {
        stores.db.close();
      }
    });

    it('migrates a legitimate legacy revoked row as a non-runnable public tombstone without parsing or retaining authority', async () => {
      const path = freshPath();
      createLegacyV2(path, { status: 'revoked' });
      const migration = await migrationLibrary();
      let parserCalls = 0;
      const parseCanonicalApproval = () => {
        parserCalls += 1;
        throw new Error('revoked authority must never be parsed');
      };
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval,
      }));
      migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval, sessionKeyCipher: cipher(), manifest,
      }));
      expect(parserCalls).toBe(0);

      const db = new DatabaseSync(path);
      try {
        expect(db.prepare('SELECT * FROM mandates_v3').get()).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          stellar_owner: OWNER,
          kernel_address: KERNEL.toLowerCase(),
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
        const reason = db.prepare('SELECT quarantine_reason FROM mandates_v3').get().quarantine_reason;
        expect(reason).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect(reason).not.toContain(APPROVAL);
        expect(reason).not.toContain(SESSION_PRIVATE_KEY);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n).toBe(0);
      } finally {
        db.close();
      }
    });

    it.each([
      ['pre-revoked', false],
      ['explicitly quarantined invalid', true],
    ])('drops noncanonical tombstone identity that aliases plaintext authority for a %s row', async (
      _label,
      quarantineInvalid,
    ) => {
      const path = freshPath();
      createLegacyV2(path, {
        stellarOwner: SESSION_PRIVATE_KEY,
        kernelAddress: SESSION_PRIVATE_KEY,
        status: quarantineInvalid ? 'active' : 'revoked',
      });
      const migration = await migrationLibrary();
      const options = migrationOptions({ quarantineInvalid });
      const manifest = migration.createLegacyMandateMigrationManifest(path, options);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        manifest,
        sessionKeyCipher: cipher(),
      })).toEqual({ migrated: 0, quarantined: 1 });

      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(db.prepare(`
          SELECT stellar_owner, kernel_address, status, serialized_approval,
                 session_key_envelope, session_key_digest, session_key_address,
                 capability_hash, policy_digest, valid_until_seconds, binding_id,
                 binding_hash, permission_id, relayer_origin
          FROM mandates_v3
        `).get()).toEqual({
          stellar_owner: null,
          kernel_address: null,
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
      } finally {
        db.close();
      }
      for (const artifact of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        expectNoPlaintextInFile(artifact, [SESSION_PRIVATE_KEY]);
      }
    });

    it('rejects a canonical parser result without the immutable Task4 policy digest losslessly', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval(params) {
          const { policyDigest: _omitted, ...parsed } = canonicalLegacyParser(params);
          return parsed;
        },
      }))).toThrow(/policy.*digest|digest.*policy|canonical/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('recognizes and migrates a mixed-case legacy v2 table name', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const rename = new DatabaseSync(path);
      rename.exec('ALTER TABLE mandates_v2 RENAME TO legacy_case_temp; ALTER TABLE legacy_case_temp RENAME TO Mandates_V2;');
      rename.close();
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), manifest,
      }));
      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates_v2');
        expect(db.prepare('SELECT status, policy_digest FROM mandates_v3').get())
          .toEqual({ status: 'activation_uncertain', policy_digest: POLICY_DIGEST });
      } finally {
        db.close();
      }
    });

    it('recognizes and quarantines a mixed-case approval-only v1 table name', async () => {
      const path = freshPath();
      const legacy = new DatabaseSync(path);
      legacy.exec('CREATE TABLE Mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      legacy.prepare('INSERT INTO Mandates (approval, session_key, expires_at) VALUES (?, ?, ?)')
        .run(APPROVAL, SESSION_PRIVATE_KEY, VALID_UNTIL_SECONDS * 1000);
      legacy.close();
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(manifest.entries).toEqual([expect.objectContaining({ outcome: 'revoked' })]);
      migration.migrateLegacyMandates(path, migrationOptions({
        quarantineInvalid: true, sessionKeyCipher: cipher(), manifest,
      }));
      const db = new DatabaseSync(path);
      try {
        expect(db.prepare('SELECT status, stellar_owner, kernel_address FROM mandates_v3').get())
          .toEqual({ status: 'revoked', stellar_owner: null, kernel_address: null });
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates');
      } finally {
        db.close();
      }
    });

    it('binds the manifest to the exact supported legacy schema and rejects added columns before sealing or mutation', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const changed = new DatabaseSync(path);
      changed.exec('ALTER TABLE mandates_v2 ADD COLUMN unexpected_authority TEXT');
      changed.prepare('UPDATE mandates_v2 SET unexpected_authority = ?').run('must-not-be-ignored');
      changed.close();
      const before = sqliteSnapshot(path);
      const envelope = cipher();
      let sealCalls = 0;
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        manifest,
        sessionKeyCipher: {
          open: (...args) => envelope.open(...args),
          seal(...args) { sealCalls += 1; return envelope.seal(...args); },
        },
      }))).toThrow(/schema|manifest|stale|changed|legacy/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it.each([
      ['a virtual generated column', (db) => db.exec(`
        ALTER TABLE mandates_v2
        ADD COLUMN hidden_authority TEXT GENERATED ALWAYS AS (lower(status)) VIRTUAL
      `)],
      ['an unexpected authority index', (db) => db.exec(`
        CREATE INDEX unexpected_legacy_authority_index
        ON mandates_v2(session_private_key)
      `)],
    ])('rejects legacy v2 with %s before parsing, sealing, or destructive mutation', async (
      _label,
      mutateSchema,
    ) => {
      const path = freshPath();
      createLegacyV2(path);
      const changed = new DatabaseSync(path);
      mutateSchema(changed);
      changed.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const envelope = cipher();
      let parserCalls = 0;
      let sealCalls = 0;
      let migrationError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          parseCanonicalApproval(params) {
            parserCalls += 1;
            return canonicalLegacyParser(params);
          },
          sessionKeyCipher: {
            open: (...args) => envelope.open(...args),
            seal(...args) {
              sealCalls += 1;
              return envelope.seal(...args);
            },
          },
        }));
      } catch (error) {
        migrationError = error;
      }

      expect(migrationError).toBeInstanceOf(Error);
      expect(migrationError?.message).toMatch(/legacy|schema|manifest|unexpected/i);
      expect(parserCalls).toBe(0);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('refuses to create a migration manifest for an unexpected legacy source schema', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const changed = new DatabaseSync(path);
      changed.exec('ALTER TABLE mandates_v2 ADD COLUMN unexpected_authority TEXT');
      changed.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/schema|unexpected|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('rejects an incompatible preexisting v3 target schema before sealing or mutating legacy rows', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const target = new DatabaseSync(path);
      target.exec('CREATE TABLE mandates_v3 (mandate_id TEXT PRIMARY KEY)');
      target.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const envelope = cipher();
      let sealCalls = 0;
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        manifest,
        sessionKeyCipher: {
          open: (...args) => envelope.open(...args),
          seal(...args) { sealCalls += 1; return envelope.seal(...args); },
        },
      }))).toThrow(/target|schema|incompatible|v3/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('rejects a legacy source changed after preflight when the final locked rescan disagrees', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const envelope = cipher();
      const addedOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
      const addedKernel = '0x1234567890AbcdEF1234567890aBcdef12345678';
      const addedKey = `0x${'55'.repeat(32)}`;
      const addedSession = privateKeyToAccount(addedKey).address;
      const addedBindingHash = createHash('sha256')
        .update(`${addedOwner}|${addedKernel}|${addedSession}|${VALID_UNTIL_SECONDS}`)
        .digest('hex');
      let afterInjectedMutation;
      let injected = false;
      let sealCalls = 0;
      const measuredCipher = {
        open: (...args) => envelope.open(...args),
        seal(...args) { sealCalls += 1; return envelope.seal(...args); },
      };
      const migrationHooks = {
        afterPreflight() {
          if (!injected) {
            injected = true;
            createLegacyV2(path, {
              serializedApproval: 'added-after-preflight',
              stellarOwner: addedOwner,
              kernelAddress: addedKernel,
              sessionPrivateKey: addedKey,
              sessionKeyAddress: addedSession,
              bindingHash: addedBindingHash,
            });
            afterInjectedMutation = sqliteSnapshot(path);
          }
        },
      };
      let migrationError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          manifest, sessionKeyCipher: measuredCipher, migrationHooks,
        }));
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toBeInstanceOf(Error);
      expect(migrationError.message).toMatch(/source|manifest|stale|changed|agreement|legacy/i);
      expect(migrationError?.message).not.toContain(addedKey);
      expect(migrationError?.message).not.toContain('added-after-preflight');
      expect(injected).toBe(true);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(afterInjectedMutation);
      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).toContain('mandates_v2');
        if (tableNames(db).includes('mandates_v3')) {
          expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        }
      } finally {
        db.close();
      }
    });

    it('holds the write lock while afterLockedRescan runs so a competing legacy write cannot change the migrated snapshot', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      let hookCalls = 0;
      let competingError;
      const migrationHooks = {
        afterLockedRescan() {
          hookCalls += 1;
          const contender = new DatabaseSync(path);
          try {
            contender.exec('PRAGMA busy_timeout=0');
            contender.prepare(`
              INSERT INTO mandates_v2 (
                serialized_approval, stellar_owner, kernel_address, session_private_key,
                session_key_address, relayer_origin, expires_at, status, binding_id,
                binding_hash, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            `).run(
              'locked-rescan-contender', OWNER, KERNEL, SESSION_PRIVATE_KEY, SESSION,
              'https://relayer.example', VALID_UNTIL_SECONDS * 1000,
              'binding-contender', 'cc'.repeat(32), NOW_SECONDS * 1000,
            );
          } catch (error) {
            competingError = error;
          } finally {
            contender.close();
          }
        },
      };

      expect(migration.migrateLegacyMandates(path, migrationOptions({
        manifest, sessionKeyCipher: cipher(), migrationHooks,
      }))).toMatchObject({ migrated: 1, quarantined: 0 });
      expect(hookCalls).toBe(1);
      expect(competingError).toBeInstanceOf(Error);
      expect(competingError.message).toMatch(/locked|busy/i);
      expect(competingError.message).not.toContain(SESSION_PRIVATE_KEY);

      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates_v2');
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(db.prepare('SELECT approval_digest FROM mandates_v3').get().approval_digest)
          .toBe(APPROVAL_DIGEST);
      } finally {
        db.close();
      }
    });

    it('persists canonical source and target bindings while destructive cleanup is pending', async () => {
      const path = freshPath();
      const { manifest } = await seedBoundPendingMigrationCleanup(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const marker = db.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get();
        const migratedRows = db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(marker).toMatchObject({
          id: 1,
          phase: 'cleanup_pending',
          manifest_version: 1,
          source_digest: manifest.sourceDigest,
          target_digest: expectedMigrationTargetDigest(migratedRows),
          migrated_count: 2,
          quarantined_count: 0,
        });
        expect(marker.source_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(marker.target_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(2);
        expect(tableNames(db).map((name) => name.toLowerCase()))
          .not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it.each([
      ['a deleted migrated row', (db) => db.prepare(`
        DELETE FROM mandates_v3
        WHERE mandate_id = (SELECT mandate_id FROM mandates_v3 ORDER BY mandate_id LIMIT 1)
      `).run()],
      ['a mutated nonsecret destination field', (db) => db.prepare(`
        UPDATE mandates_v3 SET binding_hash = ?
        WHERE mandate_id = (SELECT mandate_id FROM mandates_v3 ORDER BY mandate_id LIMIT 1)
      `).run('bb'.repeat(32))],
    ])('recomputes the pending target aggregate and rejects %s without clearing the marker', async (
      _label,
      corruptTarget,
    ) => {
      const path = freshPath();
      const { migration, options } = await seedBoundPendingMigrationCleanup(path);
      const corrupt = new DatabaseSync(path);
      corruptTarget(corrupt);
      corrupt.close();

      let cleanupError;
      try {
        migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: cipher(),
        });
      } catch (error) {
        cleanupError = error;
      }
      expect(cleanupError).toBeInstanceOf(Error);
      expect(cleanupError?.message).toBe('offline mandate migration cleanup is pending');
      expect(cleanupError?.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(cleanupError?.message).not.toContain(SECOND_SESSION_PRIVATE_KEY);
      expect(cleanupError?.message).not.toContain(APPROVAL);

      const pending = new DatabaseSync(path, { readOnly: true });
      try {
        expect(pending.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'cleanup_pending' });
      } finally {
        pending.close();
      }
    });

    it('retains completed migration bindings and returns stored counts without parser or cipher', async () => {
      const path = freshPath();
      const { migration, manifest, options } = await seedBoundPendingMigrationCleanup(path);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        sessionKeyCipher: cipher(),
      })).toMatchObject({ resumedCleanup: true });

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const migratedRows = completed.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(completed.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get())
          .toMatchObject({
            phase: 'completed',
            manifest_version: 1,
            source_digest: manifest.sourceDigest,
            target_digest: expectedMigrationTargetDigest(migratedRows),
            migrated_count: 2,
            quarantined_count: 0,
          });
      } finally {
        completed.close();
      }

      let parserCalls = 0;
      expect(migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval() {
          parserCalls += 1;
          throw new Error(`completed migration must not parse ${SESSION_PRIVATE_KEY}`);
        },
      }))).toEqual({ alreadyMigrated: true, migrated: 2, quarantined: 0 });
      expect(parserCalls).toBe(0);
    });

    it.each([
      ['a deleted migrated row', (db) => db.prepare(`
        DELETE FROM mandates_v3
        WHERE mandate_id = (
          SELECT mandate_id FROM mandates_v3
          WHERE capability_hash IS NULL AND status = 'activation_uncertain'
          ORDER BY mandate_id LIMIT 1
        )
      `).run()],
      ['a mutated migrated destination fact', (db) => db.prepare(`
        UPDATE mandates_v3 SET binding_hash = ?
        WHERE mandate_id = (
          SELECT mandate_id FROM mandates_v3
          WHERE capability_hash IS NULL AND status = 'activation_uncertain'
          ORDER BY mandate_id LIMIT 1
        )
      `).run('bb'.repeat(32))],
      ['an injected capability-null migration-shaped row', (db) => db.prepare(`
        INSERT INTO mandates_v3 (
          mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
          kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
          binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
          capability_hash, activation_user_op_hash, activation_tx_hash, activated_at,
          quarantine_reason, created_at, updated_at
        )
        SELECT ?, approval_digest, policy_digest, serialized_approval, stellar_owner,
               kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
               binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
               NULL, activation_user_op_hash, activation_tx_hash, activated_at,
               quarantine_reason, created_at, updated_at
        FROM mandates_v3
        WHERE capability_hash IS NULL AND status = 'activation_uncertain'
        ORDER BY mandate_id LIMIT 1
      `).run('injected-completed-migration-row')],
    ])('rejects completed-state target tamper from %s without parser or cipher', async (
      _label,
      tamper,
    ) => {
      const path = freshPath();
      const { migration } = await seedCompletedMigrationWithBothOutcomes(path);
      const db = new DatabaseSync(path);
      tamper(db);
      db.close();

      let parserCalls = 0;
      let cipherCalls = 0;
      let replayError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          parseCanonicalApproval() {
            parserCalls += 1;
            throw new Error(`poison completed parser ${SESSION_PRIVATE_KEY}`);
          },
          sessionKeyCipher: {
            seal() {
              cipherCalls += 1;
              throw new Error(`poison completed seal ${SECOND_SESSION_PRIVATE_KEY}`);
            },
            open() {
              cipherCalls += 1;
              throw new Error(`poison completed open ${SECOND_SESSION_PRIVATE_KEY}`);
            },
          },
        }));
      } catch (error) {
        replayError = error;
      }
      expect.soft(replayError).toBeInstanceOf(Error);
      expect.soft(String(replayError?.message || ''))
        .toMatch(/completed|target|aggregate|integrity|migration|marker/i);
      expect(parserCalls).toBe(0);
      expect(cipherCalls).toBe(0);
      for (const sensitiveValue of [SESSION_PRIVATE_KEY, SECOND_SESSION_PRIVATE_KEY, APPROVAL]) {
        expect(String(replayError?.message || '')).not.toContain(sensitiveValue);
      }

      let stores;
      let probeError;
      try {
        stores = createSqliteStores(path, {
          sessionKeyCipher: cipher(),
          nowSeconds: () => NOW_SECONDS,
        });
        stores.probe();
      } catch (error) {
        probeError = error;
      } finally {
        stores?.db.close();
      }
      expect.soft(probeError).toBeInstanceOf(Error);
      expect.soft(String(probeError?.message || ''))
        .toMatch(/completed|target|aggregate|integrity|migration|marker/i);
      for (const sensitiveValue of [SESSION_PRIVATE_KEY, SECOND_SESSION_PRIVATE_KEY, APPROVAL]) {
        expect(String(probeError?.message || '')).not.toContain(sensitiveValue);
      }
    });

    it('keeps completed history valid when a later capability-bound runtime mandate is enqueued', async () => {
      const path = freshPath();
      const { migration } = await seedCompletedMigrationWithBothOutcomes(path);
      const runtimeApproval = 'runtime-approval-after-completed-migration';
      const runtimeMandateId = 'runtime-mandate-after-completed-migration';
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(),
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.mandateActivations.enqueue({
          record: mandateRecord({
            mandateId: runtimeMandateId,
            approvalDigest: createHash('sha256').update(runtimeApproval).digest('hex'),
            policyDigest: '12'.repeat(32),
            serializedApproval: runtimeApproval,
            capabilityHash: '34'.repeat(32),
            bindingId: 'runtime-binding-after-completed-migration',
            bindingHash: '56'.repeat(32),
          }),
        })).toMatchObject({ duplicate: false });
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const marker = completed.prepare(`
          SELECT target_digest, migrated_count, quarantined_count
          FROM mandate_migration_state WHERE id = 1 AND phase = 'completed'
        `).get();
        const migrationRows = completed.prepare(`
          SELECT * FROM mandates_v3 WHERE capability_hash IS NULL ORDER BY mandate_id
        `).all();
        const runtimeRows = completed.prepare(`
          SELECT * FROM mandates_v3 WHERE capability_hash IS NOT NULL ORDER BY mandate_id
        `).all();
        expect(migrationRows.map(({ status }) => status).sort())
          .toEqual(['activation_uncertain', 'revoked']);
        expect(migrationRows.filter(({ status }) => status === 'activation_uncertain'))
          .toHaveLength(marker.migrated_count);
        expect(migrationRows.filter(({ status }) => status === 'revoked'))
          .toHaveLength(marker.quarantined_count);
        expect(expectedMigrationTargetDigest(migrationRows)).toBe(marker.target_digest);
        expect(runtimeRows).toHaveLength(1);
        expect(runtimeRows[0]).toMatchObject({
          mandate_id: runtimeMandateId,
          capability_hash: '34'.repeat(32),
          status: 'pending_activation',
        });
      } finally {
        completed.close();
      }

      let parserCalls = 0;
      let cipherCalls = 0;
      expect(migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval() {
          parserCalls += 1;
          throw new Error(`runtime replay parser poison ${SESSION_PRIVATE_KEY}`);
        },
        sessionKeyCipher: {
          seal() {
            cipherCalls += 1;
            throw new Error(`runtime replay seal poison ${SECOND_SESSION_PRIVATE_KEY}`);
          },
          open() {
            cipherCalls += 1;
            throw new Error(`runtime replay open poison ${SECOND_SESSION_PRIVATE_KEY}`);
          },
        },
      }))).toEqual({ alreadyMigrated: true, migrated: 1, quarantined: 1 });
      expect(parserCalls).toBe(0);
      expect(cipherCalls).toBe(0);
    });

    it('completes and remembers an empty zero-count legacy migration', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const empty = new DatabaseSync(path);
      empty.exec('DELETE FROM mandates_v2');
      empty.close();
      const migration = await migrationLibrary();
      const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
      const manifest = migration.createLegacyMandateMigrationManifest(path, options);
      expect(manifest.entries).toEqual([]);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        manifest,
        sessionKeyCipher: cipher(),
      })).toEqual({ migrated: 0, quarantined: 0 });

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const migratedRows = completed.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(completed.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get())
          .toMatchObject({
            phase: 'completed',
            manifest_version: 1,
            source_digest: manifest.sourceDigest,
            target_digest: expectedMigrationTargetDigest(migratedRows),
            migrated_count: 0,
            quarantined_count: 0,
          });
      } finally {
        completed.close();
      }
      expect(migration.migrateLegacyMandates(path, migrationOptions()))
        .toEqual({ alreadyMigrated: true, migrated: 0, quarantined: 0 });
    });

    it('persists cleanup-pending after a destructive commit and resumes cleanup offline with no legacy tables', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const wal = new DatabaseSync(path);
      wal.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      wal.prepare('UPDATE mandates_v2 SET created_at = created_at + 1').run();
      const walPath = `${path}-wal`;
      expect(readFileSync(walPath).includes(Buffer.from(SESSION_PRIVATE_KEY))).toBe(true);
      try {
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        let cleanupError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: cipher(),
            migrationHooks: {
              afterDestructiveCommit() { throw new Error('raw injected hook detail'); },
            },
          }));
        } catch (error) {
          cleanupError = error;
        }
        expect(cleanupError).toBeInstanceOf(Error);
        expect(cleanupError.message).toBe('offline mandate migration cleanup is pending');
        expect(cleanupError.message).not.toContain('raw injected hook detail');
        expect([path, walPath].some((artifact) => (
          existsSync(artifact)
          && readFileSync(artifact).includes(Buffer.from(SESSION_PRIVATE_KEY))
        ))).toBe(true);

        const pending = createSqliteStores(path, {
          sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
        });
        try {
          expect(pending.probe()).toMatchObject({
            writable: true, mandateMigrationCleanupPending: true,
          });
          expect(tableNames(pending.db).map((name) => name.toLowerCase()))
            .not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
          expect(pending.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        } finally {
          pending.db.close();
        }

        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }))).toMatchObject({ resumedCleanup: true });
        const ready = createSqliteStores(path, {
          sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
        });
        try {
          expect(ready.probe()).toMatchObject({
            writable: true, mandateMigrationCleanupPending: false,
          });
          expect(ready.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
          for (const artifact of [path, walPath, `${path}-shm`, `${path}-journal`]) {
            expectNoPlaintextInFile(artifact, [SESSION_PRIVATE_KEY]);
          }
        } finally {
          ready.db.close();
        }
      } finally {
        wal.close();
      }
    });

    it.each(['incomplete', 'extra', 'deleted', 'changed', 'stale'])('rejects a %s mixed-row quarantine manifest without further mutation', async (kind) => {
      const path = freshPath();
      createLegacyV2(path);
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
        kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
      });
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(manifest.entries).toHaveLength(2);
      let supplied = manifest;
      if (kind === 'incomplete') supplied = { ...manifest, entries: manifest.entries.slice(0, 1) };
      if (kind === 'extra') supplied = {
        ...manifest, entries: [...manifest.entries, { rowDigest: 'ff'.repeat(32), outcome: 'revoked' }],
      };
      if (kind === 'stale') supplied = { ...manifest, sourceDigest: 'ee'.repeat(32) };
      if (kind === 'deleted' || kind === 'changed') {
        const db = new DatabaseSync(path);
        if (kind === 'deleted') {
          db.prepare('DELETE FROM mandates_v2 WHERE serialized_approval = ?').run('invalid-approval');
        } else {
          db.prepare('UPDATE mandates_v2 SET binding_hash = ? WHERE serialized_approval = ?')
            .run('cc'.repeat(32), 'invalid-approval');
        }
        db.close();
      }
      const beforeAttempt = sqliteSnapshot(path);
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), quarantineInvalid: true, manifest: supplied,
      }))).toThrow(/manifest|complete|extra|stale|changed|row/i);
      expect(sqliteSnapshot(path)).toStrictEqual(beforeAttempt);
    });

    it('uses a complete mixed manifest to encrypt valid work and quarantine invalid data as an allowlisted tombstone', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const invalidOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
      const invalidKernel = '0x1234567890AbcdEF1234567890aBcdef12345678';
      const invalidKey = `0x${'55'.repeat(32)}`;
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: invalidOwner,
        kernelAddress: invalidKernel,
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(JSON.stringify(manifest)).not.toContain(SESSION_PRIVATE_KEY);
      expect(JSON.stringify(manifest)).not.toContain(SESSION_KEY_DIGEST);
      expect(JSON.stringify(manifest)).not.toContain(invalidKey);
      expect(JSON.stringify(manifest)).not.toContain(APPROVAL);
      expect(JSON.stringify(manifest)).not.toContain('invalid-approval');
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), quarantineInvalid: true, manifest,
      }));

      const db = new DatabaseSync(path);
      try {
        const rows = db.prepare('SELECT * FROM mandates_v3 ORDER BY status').all();
        const valid = rows.find((row) => row.status === 'activation_uncertain');
        const revoked = rows.find((row) => row.status === 'revoked');
        expect(valid).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          capability_hash: null,
          policy_digest: POLICY_DIGEST,
          session_key_digest: SESSION_KEY_DIGEST,
          valid_until_seconds: VALID_UNTIL_SECONDS,
        });
        expectOpaqueMandateId(valid.mandate_id, [
          APPROVAL, APPROVAL_DIGEST, OWNER, KERNEL, SESSION, SESSION_PRIVATE_KEY,
        ]);
        expect(valid.session_key_envelope).toMatch(/^v1\.active\./);
        expectOpaqueMandateId(revoked.mandate_id, [
          'invalid-approval', invalidOwner, invalidKernel, invalidKey,
        ]);
        expect(revoked.mandate_id).not.toBe(valid.mandate_id);
        expect(revoked).toMatchObject({
          stellar_owner: invalidOwner,
          kernel_address: invalidKernel.toLowerCase(),
          approval_digest: createHash('sha256').update('invalid-approval').digest('hex'),
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
        expect(typeof revoked.quarantine_reason).toBe('string');
        expect(revoked.quarantine_reason.length).toBeGreaterThan(0);
        expect(revoked.quarantine_reason).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect(revoked.quarantine_reason).not.toContain('invalid-approval');
        expect(revoked.quarantine_reason).not.toContain(invalidKey);
        expect(revoked.quarantine_reason).not.toContain(SESSION_PRIVATE_KEY);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n).toBe(0);
        expect(tableNames(db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it('checkpoints and truncates WAL/journal artifacts and vacuums quarantined plaintext', async () => {
      const path = freshPath();
      const invalidKey = `0x${'55'.repeat(32)}`;
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const wal = new DatabaseSync(path);
      wal.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      wal.prepare('UPDATE mandates_v2 SET binding_id = ?').run('binding-wal-seed');
      const walPath = `${path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThan(0);
      const walBefore = readFileSync(walPath);
      expect(walBefore.includes(Buffer.from('invalid-approval'))).toBe(true);
      expect(walBefore.includes(Buffer.from(invalidKey))).toBe(true);
      try {
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          quarantineInvalid: true,
        }));
        migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(), quarantineInvalid: true, manifest,
        }));
        expectNoPlaintextInFile(path, ['invalid-approval', invalidKey]);
        for (const liveArtifact of [walPath, `${path}-shm`]) {
          expectNoPlaintextInFile(liveArtifact, ['invalid-approval', invalidKey]);
        }
      } finally {
        wal.close();
      }

      expectNoPlaintextInFile(path, ['invalid-approval', invalidKey]);
      for (const artifact of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        if (existsSync(artifact)) expect(statSync(artifact).size).toBe(0);
        expectNoPlaintextInFile(artifact, ['invalid-approval', invalidKey]);
      }
    });
  });

});

// ---------------------------------------------------------------------------
// Task 8 RED — cctp_relay_work: transactional SQLite implementation of the checkpointed
// CCTP relay-work contract. Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/
// task-8-test-design.md "SQLite RED matrix" (schema, concurrency, CAS, reconciliation).
//
// Pinned wiring: createSqliteStores(path) returns a `cctpRelays` property implementing the
// same store contract as store.test.mjs (enqueue/get/claim/renew/recordAttested/
// markMintSubmitting/markMintSubmitted/finishMinted/finishBlocked/finishUncertain/release/
// listForSweep/reconcileExpired/statusOf). The generic `relay_records` table is NEVER an
// authority fallback for relay work.
//
// All digest literals are hand-calculated (node:crypto over the exact fixture bytes /
// canonical JSON), never via production helpers. See store.test.mjs for derivations.
// ---------------------------------------------------------------------------

const CCTP_T0 = 1_700_000_000_000;
const CCTP_ZERO32 = '00'.repeat(32);

const CCTP_FORWARD_EXPECTATION = {
  version: 1,
  direction: 'stellar-to-base',
  sourceDomain: 27,
  destinationDomain: 6,
  sender: '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8',
  recipient: '0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  destinationCaller: `0x${CCTP_ZERO32}`,
  burnToken: '0x5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01',
  mintRecipient: '0x0000000000000000000000000123456789abcdef0123456789abcdef01234567',
  messageSender: '0xabababababababababababababababababababababababababababababababab',
  amount: '1000000',
  burnUnits7: '10000000',
  maxFee: '0',
  minFinalityThreshold: 2000,
  hookData: '0x',
};
// sha256('vf-cctp-expectation-v1\0' + canonical JSON) — hand-calculated, see store.test.mjs.
const CCTP_FORWARD_EXPECTATION_DIGEST =
  '11168b4892206a45bb692ff36133a2571db05d6192a257edeafb247cfa8a8a98';

const CCTP_BURN_FORWARD = 'aa'.repeat(32);
const CCTP_MINT_BASE = `0x${'bb'.repeat(32)}`;
const CCTP_MESSAGE_HEX = '0xdeadbeef';
const CCTP_MESSAGE_DIGEST = '5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953';
const CCTP_NONCE_HEX = `0x${'11'.repeat(32)}`;
const CCTP_ATTESTATION_HEX = '0xaabb';
const CCTP_ATTESTATION_DIGEST =
  'd798d1fac6bd4bb1c11f50312760351013379a0ab6f0a8c0af8a506b96b2525a';
const CCTP_NEW_ATTESTATION_HEX = '0xccdd';
const CCTP_NEW_ATTESTATION_DIGEST =
  '5a8814ae66ff07179d2c22381da6221f6fe754e6175c47d7d87846080f0a9715';

function cctpThrowsCode(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err?.code !== code) {
      throw new Error(`expected typed code ${code}, got ${err?.code ?? '(none)'}: ${err?.message}`);
    }
    return err;
  }
  throw new Error(`expected typed code ${code}, but no error was thrown`);
}

const cctpIntent = (execId, overrides = {}) => ({
  execId,
  sourceDomain: 27,
  burnTxHash: CCTP_BURN_FORWARD,
  expectation: CCTP_FORWARD_EXPECTATION,
  now: CCTP_T0,
  ...overrides,
});

function cctpSeedAttested(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  cctpRelays.enqueue(cctpIntent(execId, { now, burnTxHash }));
  const claimed = cctpRelays.claim({ execId, now, leaseMs });
  cctpRelays.recordAttested({
    execId, leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
    nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now,
  });
  return claimed.leaseToken;
}

function cctpSeedSubmitting(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  const token = cctpSeedAttested(cctpRelays, execId, { now, leaseMs, burnTxHash });
  cctpRelays.markMintSubmitting({ execId, leaseToken: token, now });
  return token;
}

function cctpSeedSubmitted(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  const token = cctpSeedSubmitting(cctpRelays, execId, { now, leaseMs, burnTxHash });
  cctpRelays.markMintSubmitted({ execId, leaseToken: token, mintTxHash: CCTP_MINT_BASE, now });
  return token;
}

describe('cctpRelays — cctp_relay_work SQLite relay-work store (Task 8 RED)', () => {
  // Regression caught: the store silently operated against a missing/wrong table; schema and
  // readiness must be provable on a fresh DB (SQLite RED matrix rows 1 + 11).
  it('creates the exact cctp_relay_work schema and recovery index on a fresh DB; probe() passes', () => {
    const stores = createSqliteStores(freshPath());
    const table = stores.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cctp_relay_work'",
    ).get();
    expect(table).toBeDefined();
    const columns = stores.db.prepare('PRAGMA table_xinfo(cctp_relay_work)').all()
      .map(({ name }) => name);
    expect(columns).toEqual([
      'exec_id', 'source_domain', 'burn_tx_hash', 'expectation_json', 'expectation_digest',
      'state', 'message_hex', 'nonce_hex', 'message_digest', 'attestation_hex',
      'attestation_digest', 'evidence_version', 'mint_tx_hash', 'reason_code',
      'attempts', 'lease_token', 'lease_expires_at', 'created_at', 'updated_at',
    ]);
    const index = stores.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cctp_relay_recovery'",
    ).get();
    expect(index).toBeDefined();
    expect(stores.probe().writable).toBe(true);
    stores.db.close();
  });

  it('probe() fails closed when the cctp_relay_work table is missing', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.db.exec('DROP TABLE cctp_relay_work');
    expect(() => stores.probe()).toThrow();
    stores.db.close();
  });

  // Regression caught (row 2): JSON/number round-trips that lose precision would split an
  // exact retry into a false conflict; ms timestamps and big decimal strings must survive.
  it('canonical intent and evidence survive close/reopen with no precision loss', () => {
    const path = freshPath();
    const bigExpectation = {
      ...CCTP_FORWARD_EXPECTATION,
      amount: '9007199254740993', // > Number.MAX_SAFE_INTEGER
      burnUnits7: '90071992547409930',
    };
    const first = createSqliteStores(path);
    first.cctpRelays.enqueue({
      ...cctpIntent('exec-big', { expectation: bigExpectation }), now: 1_700_000_000_123,
    });
    const claimed = first.cctpRelays.claim({ execId: 'exec-big', now: 1_700_000_000_124, leaseMs: 60_000 });
    first.cctpRelays.recordAttested({
      execId: 'exec-big', leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: 1_700_000_000_125,
    });
    first.db.close();

    const second = createSqliteStores(path);
    const record = second.cctpRelays.get('exec-big');
    expect(record.expectation).toEqual(bigExpectation);
    expect(record.expectation.amount).toBe('9007199254740993');
    expect(record).toMatchObject({
      state: 'attested',
      messageDigest: CCTP_MESSAGE_DIGEST,
      attestationDigest: CCTP_ATTESTATION_DIGEST,
      evidenceVersion: 1,
      createdAt: 1_700_000_000_123,
      updatedAt: 1_700_000_000_125,
      leaseExpiresAt: 1_700_000_060_124,
    });
    second.db.close();
  });

  // Regression caught (row 3): a naive INSERT threw a raw UNIQUE-constraint error on an exact
  // duplicate retry instead of resolving to the existing row.
  it('two connections enqueueing the same exact intent produce one row and no raw SQLite error', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    const a = first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const b = second.cctpRelays.enqueue(cctpIntent('exec-1', { now: CCTP_T0 + 999 }));
    expect(b).toEqual(a);
    const count = first.db.prepare(
      'SELECT COUNT(*) AS n FROM cctp_relay_work WHERE exec_id = ?',
    ).get('exec-1').n;
    expect(count).toBe(1);
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 4): raw SQLITE_BUSY/constraint errors leaked to callers instead of
  // a typed conflict, and the conflicting call mutated the valid row (plan mismatch #9).
  it('two-connection changed-intent and burn-reuse conflicts are typed and leak no SQLite detail', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const changed = {
      ...CCTP_FORWARD_EXPECTATION, amount: '2000000', burnUnits7: '20000000',
    };
    const conflict = cctpThrowsCode(
      () => second.cctpRelays.enqueue(cctpIntent('exec-1', { expectation: changed })),
      'RELAY_ENQUEUE_CONFLICT',
    );
    expect(conflict.message).not.toMatch(/SQLITE|constraint|UNIQUE/i);
    const reuse = cctpThrowsCode(
      () => second.cctpRelays.enqueue(cctpIntent('exec-2')),
      'RELAY_ENQUEUE_CONFLICT',
    );
    expect(reuse.message).not.toMatch(/SQLITE|constraint|UNIQUE/i);
    expect(second.cctpRelays.get('exec-2')).toBeNull();
    expect(second.cctpRelays.get('exec-1').expectation).toEqual(CCTP_FORWARD_EXPECTATION);
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 5): two connections both claimed the same row when claim was a
  // read-then-write instead of one conditional UPDATE.
  it('two connections claiming the same safe row: exactly one lease wins', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const second = createSqliteStores(path);
    const winner = first.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    expect(winner).toMatchObject({ attempts: 1, leaseExpiresAt: CCTP_T0 + 60_000 });
    expect(typeof winner.leaseToken).toBe('string');
    const loser = second.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    expect(loser).toBeNull();
    expect(second.cctpRelays.get('exec-1').leaseToken).toBe(winner.leaseToken);
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 6): a stale connection's transition overwrote the winner's
  // checkpoint because the UPDATE did not guard on (state, lease_token, lease_expires_at).
  it('a stale connection transition affects zero rows and throws a typed CAS error', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const claimed = first.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    // the winner advances; the stale connection still holds a made-up/old token
    first.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: CCTP_T0,
    });
    cctpThrowsCode(
      () => second.cctpRelays.markMintSubmitting({ execId: 'exec-1', leaseToken: 'stale-token', now: CCTP_T0 }),
      'RELAY_CAS_CONFLICT',
    );
    expect(second.cctpRelays.get('exec-1').state).toBe('attested');
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 7): field-by-field writes let a crash persist half an attested
  // checkpoint; after reopen every multi-field transition must be all-or-none.
  it('attested and submitted checkpoints are all-or-none after close/reopen', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const token = cctpSeedSubmitted(first.cctpRelays, 'exec-1');
    expect(token).toBeTruthy();
    first.db.close();

    const second = createSqliteStores(path);
    const record = second.cctpRelays.get('exec-1');
    expect(record).toMatchObject({
      state: 'mint_submitted',
      messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX,
      messageDigest: CCTP_MESSAGE_DIGEST,
      attestationHex: CCTP_ATTESTATION_HEX,
      attestationDigest: CCTP_ATTESTATION_DIGEST,
      evidenceVersion: 1,
      mintTxHash: CCTP_MINT_BASE,
    });
    // the schema itself refuses a mint_submitted row without a canonical mint hash
    expect(() => second.db.prepare(
      "UPDATE cctp_relay_work SET mint_tx_hash = NULL WHERE exec_id = 'exec-1'",
    ).run()).toThrow();
    expect(second.cctpRelays.get('exec-1').mintTxHash).toBe(CCTP_MINT_BASE);
    second.db.close();
  });

  // Regression caught (row 8): evidence replacement and the version bump were two writes;
  // and evidence stayed mutable after the submit fence.
  it('evidence replacement increments evidence_version in one transaction; frozen after the fence', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const token = cctpSeedAttested(first.cctpRelays, 'exec-1');
    first.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: token, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_NEW_ATTESTATION_HEX, now: CCTP_T0 + 1,
    });
    // release the live seed lease so the reopened connection can claim the row (claim only
    // succeeds for an UNLEASED safe state)
    first.cctpRelays.release({ execId: 'exec-1', leaseToken: token, now: CCTP_T0 + 1 });
    first.db.close();

    const second = createSqliteStores(path);
    expect(second.cctpRelays.get('exec-1')).toMatchObject({
      state: 'attested',
      attestationHex: CCTP_NEW_ATTESTATION_HEX,
      attestationDigest: CCTP_NEW_ATTESTATION_DIGEST,
      messageDigest: CCTP_MESSAGE_DIGEST,
      evidenceVersion: 2,
    });
    const live = second.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0 + 2, leaseMs: 60_000 });
    second.cctpRelays.markMintSubmitting({ execId: 'exec-1', leaseToken: live.leaseToken, now: CCTP_T0 + 2 });
    cctpThrowsCode(() => second.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: live.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: CCTP_T0 + 3,
    }), 'RELAY_CAS_CONFLICT');
    second.db.close();
  });

  // Regression caught (row 9): reconciliation ran row-by-row outside a transaction, so a
  // crash left some expired leases cleared and a mint_submitting row still claimable.
  it('reconcileExpired runs as one BEGIN IMMEDIATE transaction and follows the state table', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const c = stores.cctpRelays;
    c.enqueue(cctpIntent('r-pending', { now: CCTP_T0 }));
    c.claim({ execId: 'r-pending', now: CCTP_T0, leaseMs: 10 });
    cctpSeedAttested(c, 'r-attested', { now: CCTP_T0 + 1, leaseMs: 10, burnTxHash: 'ab'.repeat(32) });
    cctpSeedSubmitting(c, 'r-submitting', { now: CCTP_T0 + 2, leaseMs: 10, burnTxHash: 'ac'.repeat(32) });
    cctpSeedSubmitted(c, 'r-submitted', { now: CCTP_T0 + 3, leaseMs: 10, burnTxHash: 'ad'.repeat(32) });
    const mintedToken = cctpSeedSubmitted(c, 'r-minted', { now: CCTP_T0 + 4, burnTxHash: 'ae'.repeat(32) });
    c.finishMinted({ execId: 'r-minted', leaseToken: mintedToken, mintTxHash: CCTP_MINT_BASE, now: CCTP_T0 + 4 });

    const statements = [];
    const originalExec = stores.db.exec;
    stores.db.exec = (sql) => { statements.push(String(sql)); return originalExec.call(stores.db, sql); };
    let reconciled;
    try {
      reconciled = c.reconcileExpired({ now: CCTP_T0 + 1_000, limit: 100 });
    } finally {
      stores.db.exec = originalExec;
    }
    expect(statements.some((sql) => /BEGIN\s+IMMEDIATE/i.test(sql))).toBe(true);
    expect(reconciled.map((r) => r.execId)).toEqual([
      'r-pending', 'r-attested', 'r-submitting', 'r-submitted',
    ]);
    expect(c.get('r-pending')).toMatchObject({ state: 'attestation_pending', leaseToken: null });
    expect(c.get('r-attested')).toMatchObject({ state: 'attested', leaseToken: null });
    expect(c.get('r-submitting')).toMatchObject({
      state: 'uncertain', reasonCode: 'submission_lease_expired', leaseToken: null,
    });
    expect(c.get('r-submitted')).toMatchObject({ state: 'mint_submitted', leaseToken: null });
    expect(c.get('r-minted').state).toBe('minted');
    stores.db.close();
  });

  // Regression caught (row 10): recovery listing was unbounded/insertion-ordered and included
  // terminal rows, so startup recovery order was unstable (task-8 pins (createdAt, execId)).
  it('listForSweep is index-backed, deterministic, bounded, and excludes terminals', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const c = stores.cctpRelays;
    c.enqueue(cctpIntent('exec-c', { now: CCTP_T0 + 2, burnTxHash: 'c0'.repeat(32) }));
    c.enqueue(cctpIntent('exec-a', { now: CCTP_T0 }));
    c.enqueue(cctpIntent('exec-b', { now: CCTP_T0 + 1, burnTxHash: 'b0'.repeat(32) }));
    const mintedToken = cctpSeedSubmitted(c, 'exec-minted', { now: CCTP_T0 - 1, burnTxHash: 'ab'.repeat(32) });
    c.finishMinted({ execId: 'exec-minted', leaseToken: mintedToken, mintTxHash: CCTP_MINT_BASE, now: CCTP_T0 });

    const listed = c.listForSweep({ now: CCTP_T0 + 10_000, limit: 100 });
    expect(listed.map((r) => r.execId)).toEqual(['exec-a', 'exec-b', 'exec-c']);
    expect(c.listForSweep({ now: CCTP_T0 + 10_000, limit: 2 }).map((r) => r.execId))
      .toEqual(['exec-a', 'exec-b']);
    const plan = stores.db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM cctp_relay_work WHERE state NOT IN (\'minted\',\'blocked\',\'uncertain\') ORDER BY created_at, exec_id',
    ).all().map((row) => row.detail).join(' | ');
    expect(plan).toContain('idx_cctp_relay_recovery');
    stores.db.close();
  });

  // Regression caught (row 11): invalid states/digests were storable, so recovery later read
  // rows it could not classify.
  it('invalid state/digest/evidence combinations are rejected by schema and application guards', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    expect(() => stores.db.prepare(`
      INSERT INTO cctp_relay_work (
        exec_id, source_domain, burn_tx_hash, expectation_json, expectation_digest,
        state, created_at, updated_at
      ) VALUES ('raw-1', 27, ?, '{}', ?, 'pending', 1, 1)
    `).run(CCTP_BURN_FORWARD, CCTP_FORWARD_EXPECTATION_DIGEST)).toThrow(); // not a contract state
    expect(() => stores.db.prepare(`
      INSERT INTO cctp_relay_work (
        exec_id, source_domain, burn_tx_hash, expectation_json, expectation_digest,
        state, created_at, updated_at
      ) VALUES ('raw-2', 27, ?, 'not-json', 'zz', 'attested', 1, 1)
    `).run('e0'.repeat(32))).toThrow(); // attested with no evidence columns
    const token = cctpSeedSubmitting(stores.cctpRelays, 'exec-1');
    cctpThrowsCode(
      () => stores.cctpRelays.markMintSubmitted({
        execId: 'exec-1', leaseToken: token, mintTxHash: '0x123', now: CCTP_T0,
      }),
      'RELAY_VALIDATION',
    );
    stores.db.close();
  });

  // Regression caught (row 12): the watcher used to read generic relay_records rows as truth;
  // a legacy {status:'minted'} blob must never authorize skipping a mint (plan mismatch #10).
  it('the generic relay_records table is never an authority fallback for relay work', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.store.set('legacy-exec', { status: 'minted', mintTxHash: CCTP_MINT_BASE });
    stores.store.set('legacy-pending', { status: 'pending', sourceDomain: 27, burnTxHash: CCTP_BURN_FORWARD });

    expect(stores.cctpRelays.get('legacy-exec')).toBeNull();
    expect(stores.cctpRelays.get('legacy-pending')).toBeNull();
    expect(stores.cctpRelays.statusOf('legacy-exec')).toBeNull();
    expect(stores.cctpRelays.listForSweep({ now: CCTP_T0, limit: 100 })).toEqual([]);
    expect(stores.cctpRelays.claim({ execId: 'legacy-pending', now: CCTP_T0, leaseMs: 1000 })).toBeNull();
    stores.db.close();
  });
});

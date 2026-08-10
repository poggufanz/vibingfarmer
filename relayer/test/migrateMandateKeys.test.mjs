import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { runMigration } from '../src/migrateMandateKeys.mjs';
import {
  createLegacyMandateMigrationManifest,
  migrateLegacyMandates,
} from '../src/mandateMigration.mjs';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';
import { mandateSessionAad } from '../src/sqliteStores.mjs';

const KEYRING = `2026-08:${Buffer.alloc(32, 0x33).toString('base64')}`;
const SENTINEL = 'T16-MIGRATION-PLAINTEXT-SENTINEL';
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x21)).publicKey();
const KERNEL = `0x${'12'.repeat(20)}`;
const SESSION_ADDRESS = `0x${'34'.repeat(20)}`;
const SESSION_PRIVATE_KEY = 'T16-MIGRATION-SESSION-PRIVATE';
const VALID_UNTIL_SECONDS = 4_102_444_800;

function bindingHash(stellarOwner = OWNER, kernelAddress = KERNEL, sessionKeyAddress = SESSION_ADDRESS) {
  return createHash('sha256')
    .update(`${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${VALID_UNTIL_SECONDS}`)
    .digest('hex');
}

function canonicalParser(params) {
  return {
    accountAddress: params.kernelAddress,
    sessionKeyAddress: params.sessionKeyAddress,
    stellarOwner: params.stellarOwner,
    validUntilSeconds: params.validUntilSeconds,
    policyDigest: 'b'.repeat(64),
    permissionId: null,
  };
}

const canonicalMigration = {
  createLegacyMandateMigrationManifest,
  migrateLegacyMandates(path, options) {
    return migrateLegacyMandates(path, { ...options, parseCanonicalApproval: canonicalParser });
  },
};

function keyring(id, fill) {
  return `${id}:${Buffer.alloc(32, fill).toString('base64')}`;
}

function legacyDb() {
  const directory = mkdtempSync(join(tmpdir(), 'vf-task16-migration-'));
  const path = join(directory, 'mandates.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE mandates (
      approval TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT INTO mandates VALUES ('${SENTINEL}', '${SENTINEL}', 4102444800000);
  `);
  db.close();
  return { path, directory };
}

function rawDatabaseBytes(directory) {
  return Buffer.concat(readdirSync(directory)
    .filter((name) => name.startsWith('mandates.db'))
    .map((name) => readFileSync(join(directory, name))));
}

function legacyV2Db({ revoked = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vf-task16-migration-v2-'));
  const path = join(directory, 'mandates.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`
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
    );
  `);
  const insert = db.prepare(`
    INSERT INTO mandates_v2 (
      serialized_approval, stellar_owner, kernel_address, session_private_key,
      session_key_address, relayer_origin, expires_at, status, binding_id,
      binding_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'canonical-approval-fixture', OWNER, KERNEL, SESSION_PRIVATE_KEY, SESSION_ADDRESS,
    'https://relayer.example', VALID_UNTIL_SECONDS * 1000, 'active', 'binding-42', bindingHash(),
    VALID_UNTIL_SECONDS * 1000,
  );
  if (revoked) {
    insert.run(
      `${SENTINEL}-revoked`, OWNER, `0x${'56'.repeat(20)}`, SESSION_PRIVATE_KEY,
      `0x${'78'.repeat(20)}`, null, VALID_UNTIL_SECONDS * 1000, 'revoked',
      'revoked-binding', 'not-used-for-tombstone', VALID_UNTIL_SECONDS * 1000,
    );
  }
  db.close();
  return { path, directory };
}

function legacyBothTablesDb() {
  const directory = mkdtempSync(join(tmpdir(), 'vf-task16-migration-both-'));
  const path = join(directory, 'mandates.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`
    CREATE TABLE mandates (
      approval TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
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
    );
  `);
  db.prepare('INSERT INTO mandates VALUES (?, ?, ?)')
    .run(SENTINEL, SENTINEL, VALID_UNTIL_SECONDS * 1000);
  db.prepare(`
    INSERT INTO mandates_v2 (
      serialized_approval, stellar_owner, kernel_address, session_private_key,
      session_key_address, relayer_origin, expires_at, status, binding_id,
      binding_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    'canonical-approval-with-encrypted-sentinel', OWNER, KERNEL, SENTINEL, SESSION_ADDRESS,
    'https://relayer.example', VALID_UNTIL_SECONDS * 1000, 'binding-42', bindingHash(),
    VALID_UNTIL_SECONDS * 1000,
  );
  db.close();
  return { path, directory };
}

function migrationOptions(extra = {}) {
  return {
    env: { RELAYER_OFFLINE_KEY_MIGRATION: '1' },
    parseCanonicalApproval: canonicalParser,
    ...extra,
  };
}

function writeManifest(path, directory, options = migrationOptions({ quarantineInvalid: true })) {
  const manifestPath = join(directory, 'migration-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(createLegacyMandateMigrationManifest(path, options)));
  return manifestPath;
}

function seedPendingMigration(path, { keyringValue = keyring('old-key', 0x44) } = {}) {
  const manifest = createLegacyMandateMigrationManifest(path, migrationOptions());
  let failure;
  try {
    migrateLegacyMandates(path, {
      ...migrationOptions({ manifest }),
      sessionKeyCipher: createSecretEnvelope(parseSecretKeyring(keyringValue)),
      migrationHooks: {
        afterDestructiveCommit() { throw new Error('interrupt after destructive commit'); },
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure?.message).toBe('offline mandate migration cleanup is pending');
  return manifest;
}

describe('mandates:migrate-encryption wrapper', () => {
  it('delegates an explicit quarantine manifest to the offline migration library without leaking plaintext', async () => {
    const { path, directory } = legacyDb();
    expect(rawDatabaseBytes(directory).includes(Buffer.from(SENTINEL))).toBe(true);
    const manifestPath = join(directory, 'quarantine-manifest.json');
    const manifest = createLegacyMandateMigrationManifest(path, {
      env: { RELAYER_OFFLINE_KEY_MIGRATION: '1' },
      quarantineInvalid: true,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const output = await runMigration(
      ['--db', path, '--manifest', manifestPath, '--quarantine-invalid'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING },
      {},
    );

    expect(output.code).toBe('MANDATE_MIGRATION_COMPLETE');
    expect(output).toMatchObject({ migrated: 0, quarantined: 1 });
    expect(JSON.stringify(output)).not.toContain(SENTINEL);
    expect(rawDatabaseBytes(directory).includes(Buffer.from(SENTINEL))).toBe(false);
    for (const file of readdirSync(directory)) {
      expect(readFileSync(join(directory, file)).toString('utf8')).not.toContain(SENTINEL);
    }
    await expect(runMigration(
      ['--db', path, '--manifest', manifestPath, '--quarantine-invalid'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_ALREADY_COMPLETE' });
  });

  it('cleans plaintext sentinels from both legacy tables and all SQLite artifacts', async () => {
    const { path, directory } = legacyBothTablesDb();
    expect(rawDatabaseBytes(directory).includes(Buffer.from(SENTINEL))).toBe(true);
    const manifestPath = writeManifest(path, directory);
    const output = await runMigration(
      ['--db', path, '--manifest', manifestPath, '--quarantine-invalid'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING },
      { migration: canonicalMigration },
    );

    expect(output).toMatchObject({ code: 'MANDATE_MIGRATION_COMPLETE', migrated: 1, quarantined: 1 });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) IN ('mandates','mandates_v2')",
      ).all()).toEqual([]);
      const retained = db.prepare("SELECT * FROM mandates_v3 WHERE status = 'activation_uncertain'").get();
      expect(retained).toBeTruthy();
      const opened = createSecretEnvelope(parseSecretKeyring(KEYRING)).open(
        retained.session_key_envelope,
        mandateSessionAad({
          mandateId: retained.mandate_id,
          approvalDigest: retained.approval_digest,
          policyDigest: retained.policy_digest,
          stellarOwner: retained.stellar_owner,
          kernelAddress: retained.kernel_address,
          sessionKeyAddress: retained.session_key_address,
          validUntilSeconds: retained.valid_until_seconds,
          bindingId: retained.binding_id,
        }),
      );
      expect(opened.plaintext).toBe(SENTINEL);
    } finally {
      db.close();
    }
    expect(rawDatabaseBytes(directory).includes(Buffer.from(SENTINEL))).toBe(false);
    for (const file of readdirSync(directory)) {
      expect(readFileSync(join(directory, file)).toString('utf8')).not.toContain(SENTINEL);
    }
  });

  it('migrates retained canonical rows and converts revoked legacy rows into authority-free tombstones', async () => {
    const { path, directory } = legacyV2Db({ revoked: true });
    const manifestPath = writeManifest(path, directory);
    const output = await runMigration(
      ['--db', path, '--manifest', manifestPath, '--quarantine-invalid'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING },
      { migration: canonicalMigration },
    );

    expect(output).toMatchObject({ code: 'MANDATE_MIGRATION_COMPLETE', migrated: 1, quarantined: 1 });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT * FROM mandates_v3 ORDER BY status').all();
      const retained = rows.find((row) => row.status === 'activation_uncertain');
      const tombstone = rows.find((row) => row.status === 'revoked');
      expect(retained).toMatchObject({
        stellar_owner: OWNER,
        kernel_address: KERNEL,
        session_key_address: SESSION_ADDRESS,
        quarantine_reason: null,
      });
      expect(tombstone).toMatchObject({
        stellar_owner: OWNER,
        kernel_address: `0x${'56'.repeat(20)}`,
        quarantine_reason: 'LEGACY_REVOKED',
        serialized_approval: null,
        policy_digest: null,
        session_key_envelope: null,
        session_key_digest: null,
      });
      expect(JSON.stringify(rows)).not.toContain(SENTINEL);
      const opened = createSecretEnvelope(parseSecretKeyring(KEYRING)).open(
        retained.session_key_envelope,
        mandateSessionAad({
          mandateId: retained.mandate_id,
          approvalDigest: retained.approval_digest,
          policyDigest: retained.policy_digest,
          stellarOwner: retained.stellar_owner,
          kernelAddress: retained.kernel_address,
          sessionKeyAddress: retained.session_key_address,
          validUntilSeconds: retained.valid_until_seconds,
          bindingId: retained.binding_id,
        }),
      );
      expect(opened.plaintext).toBe(SESSION_PRIVATE_KEY);
    } finally {
      db.close();
    }
  });

  it('rejects a wrong rotation key before mutation, then rotates and removes the old-key dependency idempotently', async () => {
    const { path } = legacyV2Db();
    seedPendingMigration(path);
    const beforeDb = new DatabaseSync(path, { readOnly: true });
    const before = beforeDb.prepare('SELECT phase FROM mandate_migration_state WHERE id = 1').get();
    const beforeEnvelope = beforeDb.prepare('SELECT session_key_envelope FROM mandates_v3').get();
    beforeDb.close();
    const wrongKey = keyring('wrong-key', 0x55);
    await expect(runMigration(
      ['--db', path, '--rotate'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: wrongKey },
      { migration: canonicalMigration },
    )).rejects.toMatchObject({ code: 'MANDATE_MIGRATION_FAILED' });
    const checkAfterWrong = new DatabaseSync(path, { readOnly: true });
    try {
      expect(checkAfterWrong.prepare('SELECT phase FROM mandate_migration_state WHERE id = 1').get())
        .toEqual(before);
      expect(checkAfterWrong.prepare('SELECT session_key_envelope FROM mandates_v3').get())
        .toEqual(beforeEnvelope);
    } finally {
      checkAfterWrong.close();
    }

    const rotatingKeys = `${keyring('new-key', 0x66)},${keyring('old-key', 0x44)}`;
    await expect(runMigration(
      ['--db', path, '--rotate'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: rotatingKeys },
      { migration: canonicalMigration },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_CLEANUP_RESUMED', migrated: 1 });
    const rotated = new DatabaseSync(path, { readOnly: true });
    try {
      const marker = rotated.prepare('SELECT phase FROM mandate_migration_state WHERE id = 1').get();
      const row = rotated.prepare('SELECT session_key_envelope FROM mandates_v3').get();
      expect(marker.phase).toBe('completed');
      expect(row.session_key_envelope).toMatch(/^v1\.new-key\./);
    } finally {
      rotated.close();
    }
    await expect(runMigration(
      ['--db', path, '--rotate'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: keyring('new-key', 0x66) },
      { migration: canonicalMigration },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_ALREADY_COMPLETE', migrated: 1 });
  });

  it('rotates a completed migration transactionally and preserves marker aggregates', async () => {
    const { path, directory } = legacyV2Db();
    const manifestPath = writeManifest(path, directory);
    await expect(runMigration(
      ['--db', path, '--manifest', manifestPath, '--quarantine-invalid'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: keyring('old-key', 0x44) },
      { migration: canonicalMigration },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_COMPLETE', migrated: 1 });

    const beforeDb = new DatabaseSync(path, { readOnly: true });
    const beforeMarker = beforeDb.prepare(
      'SELECT phase, manifest_version, source_digest, target_digest, migrated_count, quarantined_count FROM mandate_migration_state WHERE id = 1',
    ).get();
    const beforeRow = beforeDb.prepare('SELECT * FROM mandates_v3 WHERE status = ?').get('activation_uncertain');
    beforeDb.close();
    expect(beforeMarker.phase).toBe('completed');
    expect(beforeRow.session_key_envelope).toMatch(/^v1\.old-key\./);

    const rotatingKeys = `${keyring('new-key', 0x66)},${keyring('old-key', 0x44)}`;
    await expect(runMigration(
      ['--db', path, '--rotate'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: rotatingKeys },
      { migration: canonicalMigration },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_ROTATED', migrated: 1 });

    const afterDb = new DatabaseSync(path, { readOnly: true });
    try {
      const afterMarker = afterDb.prepare(
        'SELECT phase, manifest_version, source_digest, target_digest, migrated_count, quarantined_count FROM mandate_migration_state WHERE id = 1',
      ).get();
      const afterRow = afterDb.prepare('SELECT * FROM mandates_v3 WHERE status = ?').get('activation_uncertain');
      expect(afterMarker).toEqual(beforeMarker);
      expect(afterRow.session_key_envelope).toMatch(/^v1\.new-key\./);
      const opened = createSecretEnvelope(parseSecretKeyring(keyring('new-key', 0x66))).open(
        afterRow.session_key_envelope,
        mandateSessionAad({
          mandateId: afterRow.mandate_id,
          approvalDigest: afterRow.approval_digest,
          policyDigest: afterRow.policy_digest,
          stellarOwner: afterRow.stellar_owner,
          kernelAddress: afterRow.kernel_address,
          sessionKeyAddress: afterRow.session_key_address,
          validUntilSeconds: afterRow.valid_until_seconds,
          bindingId: afterRow.binding_id,
        }),
      );
      expect(opened).toMatchObject({ plaintext: SESSION_PRIVATE_KEY, needsRotation: false });
    } finally {
      afterDb.close();
    }
    for (const name of readdirSync(directory).filter((entry) => entry === 'mandates.db-wal')) {
      expect(readFileSync(join(directory, name)).byteLength).toBe(0);
    }
    await expect(runMigration(
      ['--db', path, '--rotate'],
      { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: keyring('new-key', 0x66) },
      { migration: canonicalMigration },
    )).resolves.toMatchObject({ code: 'MANDATE_MIGRATION_ALREADY_COMPLETE', migrated: 1 });
  });

  it.each([
    ['missing', (directory) => join(directory, 'does-not-exist.db'), 'MANDATE_MIGRATION_DB_NOT_FOUND'],
    ['non-regular', (directory) => directory, 'MANDATE_MIGRATION_DB_NOT_REGULAR'],
    ['unreadable', (directory) => {
      const path = join(directory, 'unreadable.db');
      writeFileSync(path, 'not a database');
      chmodSync(path, 0o000);
      return path;
    }, 'MANDATE_MIGRATION_DB_UNREADABLE'],
  ])('rejects an explicit %s --db path before migration and file creation', (_label, pathFor, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'vf-task16-migration-cli-path-'));
    const path = pathFor(directory);
    const child = spawnSync(process.execPath, ['src/migrateMandateKeys.mjs', '--db', path], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING,
      },
      encoding: 'utf8',
    });
    if (_label === 'unreadable') chmodSync(path, 0o600);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(JSON.parse(child.stderr)).toEqual({ code });
    if (_label === 'missing') expect(existsSync(path)).toBe(false);
  });

  it('prints one sanitized JSON result on direct CLI success', async () => {
    const { path, directory } = legacyDb();
    const manifestPath = writeManifest(path, directory);
    const child = spawnSync(process.execPath, [
      'src/migrateMandateKeys.mjs', '--db', path, '--manifest', manifestPath, '--quarantine-invalid',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING,
      },
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({
      code: 'MANDATE_MIGRATION_COMPLETE', migrated: 0, quarantined: 1,
    });
    expect(child.stdout).not.toContain(SENTINEL);
  });

  it('prints only a stable error code on direct CLI failure', async () => {
    const { path } = legacyDb();
    const child = spawnSync(process.execPath, ['src/migrateMandateKeys.mjs', '--db', path], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        RELAYER_SESSION_KEY_ENCRYPTION_KEYS: 'not-a-keyring',
      },
      encoding: 'utf8',
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(JSON.parse(child.stderr)).toEqual({ code: 'MANDATE_MIGRATION_FAILED' });
    expect(child.stderr).not.toContain(SENTINEL);
  });

  it('requires an explicit DB path and never mutates the HTTP offline flag', async () => {
    const previous = process.env.RELAYER_OFFLINE_KEY_MIGRATION;
    delete process.env.RELAYER_OFFLINE_KEY_MIGRATION;
    await expect(runMigration([], { RELAYER_SESSION_KEY_ENCRYPTION_KEYS: KEYRING }))
      .rejects.toMatchObject({ code: 'MANDATE_MIGRATION_INVALID_ARGS' });
    expect(process.env.RELAYER_OFFLINE_KEY_MIGRATION).toBeUndefined();
    if (previous !== undefined) process.env.RELAYER_OFFLINE_KEY_MIGRATION = previous;
  });
});

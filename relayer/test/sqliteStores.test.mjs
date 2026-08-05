// relayer/test/sqliteStores.test.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-sqlite-')), 'relayer.db');

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
const MANDATE_ID = '7d8f94a2c16b4e6488bf07b81234abcd';
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const KERNEL = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const APPROVAL = 'canonical-approval-fixture';
const APPROVAL_DIGEST = createHash('sha256').update(APPROVAL).digest('hex');
const CAPABILITY_HASH = 'aa'.repeat(32);
const PERMISSION_ID = '0x1234abcd';
const BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`)
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

function canonicalLegacyParser(params) {
  if (params.serializedApproval !== APPROVAL) throw new Error('approval is noncanonical');
  return {
    accountAddress: KERNEL,
    sessionKeyAddress: SESSION,
    stellarOwner: OWNER,
    permissionId: PERMISSION_ID,
    validAfter: 0,
    validUntilSeconds: VALID_UNTIL_SECONDS,
    cap: 10_000_000_000n,
    policies: [{ type: 'call' }, { type: 'timestamp' }],
    call: { type: 'call' },
    timestamp: { validAfter: 0, validUntil: VALID_UNTIL_SECONDS },
    policyDigest: 'dd'.repeat(32),
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
    'sessionprivatekey', 'capabilityhash', 'sessionkeyenvelope', 'session_key_envelope',
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
  allocationId: 'run-1:bridge:aave-v3',
  childId: 'job-1',
};

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
      expect(second.associationOutbox.status('job-1')).toEqual([{
        allocationId: executionIdentity.allocationId,
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
      expect(stores.associationOutbox.status('job-1')).toEqual([]);
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
      expect(third.associationOutbox.status('job-1')).toHaveLength(1);
    });
  });

  describe('encrypted mandate v3 persistence', () => {
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
          SELECT session_key_envelope, capability_hash, valid_until_seconds
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw.session_key_envelope).toMatch(/^v1\.active\./);
        expect(raw.session_key_envelope).not.toContain(SESSION_PRIVATE_KEY);
        expect(raw.capability_hash).toBe(CAPABILITY_HASH);
        expect(raw.valid_until_seconds).toBe(VALID_UNTIL_SECONDS);
        expect(stores.mandatesV3.status(mandateIdentity())).toMatchObject({
          mandateId: MANDATE_ID,
          kernelAddress: KERNEL.toLowerCase(),
          sessionKeyAddress: SESSION.toLowerCase(),
        });
        expect(readFileSync(path).includes(Buffer.from(SESSION_PRIVATE_KEY))).toBe(false);
      } finally {
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
          SELECT status, session_key_envelope, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw).toEqual({
          status: 'revoked', session_key_envelope: null, capability_hash: CAPABILITY_HASH,
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
          SELECT mandate_id, approval_digest, valid_until_seconds, binding_hash, status,
                 capability_hash, session_key_envelope, kernel_address, session_key_address
          FROM mandates_v3
        `).get();
        expect(migrated).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          valid_until_seconds: VALID_UNTIL_SECONDS,
          binding_hash: BINDING_HASH,
          status: 'activation_uncertain',
          capability_hash: null,
          kernel_address: KERNEL.toLowerCase(),
          session_key_address: SESSION.toLowerCase(),
        });
        expectOpaqueMandateId(migrated.mandate_id, [
          APPROVAL, APPROVAL_DIGEST, OWNER, KERNEL, SESSION, SESSION_PRIVATE_KEY,
          BINDING_HASH, 'binding-1',
        ]);
        expect(migrated.session_key_envelope).toMatch(/^v1\.active\./);
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
        expect(stores.mandatesV3.status(migratedIdentity).status).toBe('activation_uncertain');
        expect(stores.mandateActivations.get(migratedIdentity)).toBeNull();
        expect(stores.mandatesV3.get(migratedIdentity).sessionPrivateKey).toBe(SESSION_PRIVATE_KEY);
        expect(stores.mandatesV3.get(migratedIdentity).capabilityHash).toBeUndefined();
        expect(() => migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(), manifest,
        }))).toThrow(/already migrated|legacy|stale/i);
      } finally {
        stores.db.close();
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
          session_key_address: null,
          capability_hash: null,
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

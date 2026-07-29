import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { createAgentIndexStore } from './store.js'
import {
  applyAuthenticatedReceiptMutation,
  issueReceiptChallenge,
  receiptProofMessage,
  receiptRequestDigest,
} from './executionReceipts.js'
import { ingestBaseChildIntent, advanceBaseChildLifecycle } from './associations.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^000[2-6]_.*\.sql$/.test(name))
    .sort()
  expect(migrations.map((name) => name.slice(0, 4))).toEqual([
    '0002',
    '0003',
    '0004',
    '0005',
    '0006',
  ])
  for (const migration of migrations) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, migration), 'utf8'))
  }

  function bound(sql, args) {
    return {
      run() {
        const info = sqlite.prepare(sql).run(...args)
        return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
      first(column) {
        const row = sqlite.prepare(sql).get(...args)
        if (!row) return null
        return column ? row[column] : row
      },
      all() {
        return { success: true, results: sqlite.prepare(sql).all(...args) }
      },
    }
  }

  return {
    prepare(sql) {
      return { bind: (...args) => bound(sql, args) }
    },
    batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement) => statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    _raw: sqlite,
  }
}

const NETWORK = 'stellar-testnet'
const OWNER_G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey()
const OWNER_C = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'
const OTHER_OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey()
const AGENT = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3))
const WRONG_SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4))
const NOW = 2_000_000_000_000

function authority(owner, overrides = {}) {
  return {
    routerOwner: owner,
    scope: { owner, revoked: false, expiry: BigInt(Math.floor(NOW / 1000) + 3600) },
    signer: SESSION.rawPublicKey(),
    scopeLedger: 7654321,
    ...overrides,
  }
}

function receipt(owner = OWNER_G, overrides = {}) {
  return {
    version: 2,
    networkId: NETWORK,
    owner,
    executionId: 'execution-1',
    runId: 'run-1',
    allocationId: 'run-1:deposit:0',
    parentAllocationId: null,
    childId: null,
    worker: 'worker-0',
    agent: AGENT,
    intent: {
      kind: 'stellar-deposit',
      token: 'USDC',
      units: '90071992547409931234567890',
      decimals: 7,
      target: 'vault-1',
    },
    phases: {
      pull: 'submitted',
      stellar_deposit: 'not_started',
      cctp_burn: 'not_started',
      cctp_mint: 'not_started',
      base_deposit: 'not_started',
    },
    custody: {
      location: 'stellar-agent',
      confirmed: true,
      amount: { token: 'USDC', units: '90071992547409931234567890', decimals: 7 },
      reason: null,
    },
    ...overrides,
  }
}

function mutation(owner = OWNER_G, overrides = {}) {
  return {
    expectedVersion: 0,
    receipt: receipt(owner),
    attempt: {
      attemptId: 'attempt-pull-1',
      kind: 'phase',
      phase: 'pull',
      status: 'submitted',
      evidence: { txHash: 'stellar-tx-1' },
      observedAt: NOW,
    },
    ...overrides,
  }
}

async function authenticatedApply({
  store,
  body,
  owner = body.receipt.owner,
  signer = SESSION,
  authorityFacts = authority(owner),
  issuedAt = NOW,
  appliedAt = NOW + 1,
  challengeId = `challenge-${body.attempt.attemptId}`,
}) {
  const requestDigest = receiptRequestDigest(body)
  const challenge = await issueReceiptChallenge({
    request: { networkId: NETWORK, owner, agent: AGENT, requestDigest },
    store,
    authorityReader: async () => authorityFacts,
    now: issuedAt,
    challengeId,
  })
  const signature = signer
    .sign(Buffer.from(receiptProofMessage(challenge), 'utf8'))
    .toString('base64url')
  return applyAuthenticatedReceiptMutation({
    body,
    proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
    store,
    authorityReader: async () => authorityFacts,
    now: appliedAt,
    consumeToken: `consume-${challengeId}-${appliedAt}`,
  })
}

let db
let store

beforeEach(() => {
  db = fakeD1()
  store = createAgentIndexStore(db)
})

describe('execution receipt migrations and projection repository', () => {
  it('loads migrations 0002 through 0006 numerically on a fresh database', () => {
    const tables = db._raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN
           ('execution_receipts','execution_phase_attempts','execution_receipt_challenges',
            'execution_recovery_leases','base_child_intents','base_child_lifecycle_events')
         ORDER BY name`
      )
      .all()
      .map(({ name }) => name)
    expect(tables).toEqual([
      'base_child_intents',
      'base_child_lifecycle_events',
      'execution_phase_attempts',
      'execution_receipt_challenges',
      'execution_receipts',
      'execution_recovery_leases',
    ])
  })

  it('atomically creates a v1 projection and first append-only attempt with exact TEXT units', async () => {
    await authenticatedApply({ store, body: mutation() })

    const [stored] = await store.readOwnerExecutionReceipts({
      networkId: NETWORK,
      owner: OWNER_G,
    })
    expect(stored).toMatchObject({
      version: 1,
      executionId: 'execution-1',
      allocationId: 'run-1:deposit:0',
      intent: { units: '90071992547409931234567890' },
      custody: {
        amount: { units: '90071992547409931234567890' },
      },
    })
    expect(typeof stored.intent.units).toBe('string')
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]).toMatchObject({ attemptId: 'attempt-pull-1', receiptVersion: 1 })
  })

  it('filters reads by the exact network and owner tenant', async () => {
    await authenticatedApply({ store, body: mutation() })
    expect(
      await store.readOwnerExecutionReceipts({ networkId: NETWORK, owner: OTHER_OWNER })
    ).toEqual([])
    expect(
      await store.readOwnerExecutionReceipts({ networkId: 'stellar-mainnet', owner: OWNER_G })
    ).toEqual([])
  })

  it('makes an exact signed body retry idempotent with a fresh one-use challenge', async () => {
    const body = mutation()
    await authenticatedApply({ store, body, challengeId: 'challenge-original' })
    await expect(
      authenticatedApply({ store, body, challengeId: 'challenge-exact-retry' })
    ).resolves.toMatchObject({ written: 0, duplicates: 1, version: 1 })
    expect(
      (await store.readReceiptChallenge({ challengeId: 'challenge-exact-retry' })).consumedAt
    ).toBe(NOW + 1)
    expect(
      db._raw
        .prepare('SELECT COUNT(*) AS count FROM execution_phase_attempts WHERE attempt_id = ?')
        .get('attempt-pull-1').count
    ).toBe(1)
  })

  it('uses monotonic expected-version CAS and rolls challenge consumption back with a losing write', async () => {
    await authenticatedApply({ store, body: mutation() })
    const stale = mutation(OWNER_G, {
      attempt: {
        ...mutation().attempt,
        attemptId: 'attempt-stale',
        evidence: { txHash: 'stale-tx' },
      },
    })
    await expect(authenticatedApply({ store, body: stale })).rejects.toThrow(/version|conflict/i)
    const challenge = await store.readReceiptChallenge({ challengeId: 'challenge-attempt-stale' })
    expect(challenge.consumedAt).toBeNull()
    expect(
      db._raw
        .prepare('SELECT COUNT(*) AS count FROM execution_phase_attempts WHERE attempt_id = ?')
        .get('attempt-stale').count
    ).toBe(0)
  })

  it('never downgrades a confirmed phase or permits its attempt evidence to be edited/deleted', async () => {
    await authenticatedApply({ store, body: mutation() })
    const confirmedReceipt = receipt(OWNER_G, {
      phases: { ...receipt().phases, pull: 'confirmed' },
      custody: {
        location: 'stellar-vault',
        confirmed: true,
        amount: { token: 'USDC', units: '90071992547409931234567890', decimals: 7 },
        reason: null,
      },
    })
    await authenticatedApply({
      store,
      body: mutation(OWNER_G, {
        expectedVersion: 1,
        receipt: confirmedReceipt,
        attempt: {
          attemptId: 'attempt-pull-confirmed',
          kind: 'phase',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'stellar-tx-confirmed', ledger: 7654322 },
          observedAt: NOW + 2,
        },
      }),
    })

    await expect(
      authenticatedApply({
        store,
        body: mutation(OWNER_G, {
          expectedVersion: 2,
          receipt: receipt(OWNER_G, {
            phases: { ...receipt().phases, pull: 'failed' },
          }),
          attempt: {
            attemptId: 'attempt-pull-regressed',
            kind: 'phase',
            phase: 'pull',
            status: 'failed',
            evidence: { reason: 'late callback' },
            observedAt: NOW + 3,
          },
        }),
      })
    ).rejects.toThrow(/confirmed|conflict/i)

    expect(() =>
      db._raw
        .prepare(
          `UPDATE execution_receipts SET pull_status = 'failed', version = 3
           WHERE network_id = ? AND execution_id = ? AND allocation_id = ?`
        )
        .run(NETWORK, 'execution-1', 'run-1:deposit:0')
    ).toThrow(/confirmed|monotonic/i)
    expect(() =>
      db._raw
        .prepare('UPDATE execution_phase_attempts SET evidence_json = ? WHERE attempt_id = ?')
        .run('{}', 'attempt-pull-confirmed')
    ).toThrow(/append.only/i)
    expect(() =>
      db._raw
        .prepare('DELETE FROM execution_phase_attempts WHERE attempt_id = ?')
        .run('attempt-pull-confirmed')
    ).toThrow(/append.only/i)
  })

  it('rejects secret, private-key, and session-key properties recursively before serialization', () => {
    for (const unsafe of [
      { secret: 'S...' },
      { private: 'S...' },
      { nested: { private_key: 'private' } },
      { nested: [{ sessionKey: 'S...' }] },
    ]) {
      const body = mutation(OWNER_G, {
        receipt: receipt(OWNER_G, { intent: { ...receipt().intent, metadata: unsafe } }),
      })
      expect(() => receiptRequestDigest(body)).toThrow(/secret|private|session/i)
    }
    expect(() =>
      receiptRequestDigest(
        mutation(OWNER_G, {
          receipt: receipt(OWNER_G, { intent: { ...receipt().intent, units: 1000000 } }),
        })
      )
    ).toThrow(/units.*string/i)
  })
})

describe('agent session-key challenge proof', () => {
  it.each([
    ['G-owned', OWNER_G],
    ['C-owned', OWNER_C],
  ])(
    'authorizes %s agents with the same on-chain owner/scope/signer proof',
    async (_label, owner) => {
      const body = mutation(owner)
      await expect(authenticatedApply({ store, body, owner })).resolves.toMatchObject({
        written: 1,
        version: 1,
      })
    }
  )

  it('rejects replay, altered bodies, expired challenges, and a wrong session signer', async () => {
    const body = mutation()
    const digest = receiptRequestDigest(body)
    const challenge = await issueReceiptChallenge({
      request: { networkId: NETWORK, owner: OWNER_G, agent: AGENT, requestDigest: digest },
      store,
      authorityReader: async () => authority(OWNER_G),
      now: NOW,
      challengeId: 'challenge-replay',
    })
    const validProof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    await applyAuthenticatedReceiptMutation({
      body,
      proof: validProof,
      store,
      authorityReader: async () => authority(OWNER_G),
      now: NOW + 1,
      consumeToken: 'consume-replay-first',
    })
    await expect(
      applyAuthenticatedReceiptMutation({
        body,
        proof: validProof,
        store,
        authorityReader: async () => authority(OWNER_G),
        now: NOW + 2,
        consumeToken: 'consume-replay-second',
      })
    ).rejects.toThrow(/consumed|replay/i)

    const cases = [
      {
        id: 'altered',
        signedBody: mutation(OWNER_G, {
          attempt: { ...mutation().attempt, attemptId: 'altered-attempt' },
        }),
        appliedBody: mutation(OWNER_G, {
          receipt: receipt(OWNER_G, {
            intent: { ...receipt().intent, units: '2' },
          }),
          attempt: { ...mutation().attempt, attemptId: 'altered-attempt' },
        }),
        signer: SESSION,
        issuedAt: NOW,
        appliedAt: NOW + 1,
      },
      {
        id: 'wrong-signer',
        signedBody: mutation(OWNER_G, {
          attempt: { ...mutation().attempt, attemptId: 'wrong-signer-attempt' },
        }),
        signer: WRONG_SESSION,
        issuedAt: NOW,
        appliedAt: NOW + 1,
      },
      {
        id: 'expired',
        signedBody: mutation(OWNER_G, {
          attempt: { ...mutation().attempt, attemptId: 'expired-attempt' },
        }),
        signer: SESSION,
        issuedAt: NOW,
        appliedAt: NOW + 301_000,
      },
    ]
    for (const testCase of cases) {
      const signedBody = testCase.signedBody
      const nextChallenge = await issueReceiptChallenge({
        request: {
          networkId: NETWORK,
          owner: OWNER_G,
          agent: AGENT,
          requestDigest: receiptRequestDigest(signedBody),
        },
        store,
        authorityReader: async () => authority(OWNER_G),
        now: testCase.issuedAt,
        challengeId: `challenge-${testCase.id}`,
      })
      const proof = {
        challengeId: nextChallenge.challengeId,
        expiresAt: nextChallenge.expiresAt,
        signature: testCase.signer
          .sign(Buffer.from(receiptProofMessage(nextChallenge)))
          .toString('base64url'),
      }
      await expect(
        applyAuthenticatedReceiptMutation({
          body: testCase.appliedBody ?? signedBody,
          proof,
          store,
          authorityReader: async () => authority(OWNER_G),
          now: testCase.appliedAt,
          consumeToken: `consume-${testCase.id}`,
        })
      ).rejects.toThrow(/digest|signature|expired/i)
    }
  })

  it('re-reads router owner, scope owner, and signer and rejects any mismatch', async () => {
    for (const changed of [
      { routerOwner: OTHER_OWNER },
      { scope: { ...authority(OWNER_G).scope, owner: OTHER_OWNER } },
      { signer: WRONG_SESSION.rawPublicKey() },
    ]) {
      await expect(
        authenticatedApply({
          store,
          body: mutation(OWNER_G, {
            attempt: {
              ...mutation().attempt,
              attemptId: `authority-${Object.keys(changed)[0]}`,
            },
          }),
          authorityFacts: authority(OWNER_G, changed),
        })
      ).rejects.toThrow(/owner|signer|authority/i)
    }
  })

  it('allows revoked-scope reconciliation only with persisted on-chain evidence', async () => {
    const revoked = authority(OWNER_G, {
      scope: { ...authority(OWNER_G).scope, revoked: true },
      scopeLedger: 7654999,
    })
    await expect(
      authenticatedApply({ store, body: mutation(), authorityFacts: revoked })
    ).rejects.toThrow(/revoked|reconciliation/i)

    const reconcile = mutation(OWNER_G, {
      attempt: {
        attemptId: 'attempt-revoked-reconcile',
        kind: 'revoked-scope-reconciliation',
        phase: 'pull',
        status: 'unknown',
        evidence: { custodyRead: { location: 'stellar-agent', confirmed: true } },
        observedAt: NOW,
      },
      receipt: receipt(OWNER_G, {
        phases: { ...receipt().phases, pull: 'unknown' },
        custody: {
          location: 'stellar-agent',
          confirmed: true,
          amount: { token: 'USDC', units: '90071992547409931234567890', decimals: 7 },
          reason: 'scope-revoked',
        },
      }),
    })
    await authenticatedApply({ store, body: reconcile, authorityFacts: revoked })
    const [stored] = await store.readOwnerExecutionReceipts({
      networkId: NETWORK,
      owner: OWNER_G,
    })
    expect(stored.attempts[0].evidence.authority).toMatchObject({
      routerOwner: OWNER_G,
      scopeOwner: OWNER_G,
      revoked: true,
      scopeLedger: 7654999,
    })
  })
})

describe('recovery leases', () => {
  it('is contention-safe for execution/allocation/child/phase and isolates sibling children', async () => {
    const key = {
      networkId: NETWORK,
      owner: OWNER_G,
      executionId: 'execution-1',
      allocationId: 'allocation-1',
      childId: 'child-a',
      phase: 'cctp_mint',
    }
    await expect(
      store.acquireRecoveryLease({ ...key, holder: 'worker-a', leaseToken: 'lease-a', now: NOW })
    ).resolves.toMatchObject({ acquired: true })
    await expect(
      store.acquireRecoveryLease({
        ...key,
        holder: 'worker-b',
        leaseToken: 'lease-b',
        now: NOW + 1,
      })
    ).resolves.toMatchObject({ acquired: false })
    await expect(
      store.acquireRecoveryLease({
        ...key,
        childId: 'child-b',
        holder: 'worker-b',
        leaseToken: 'lease-b',
        now: NOW + 1,
      })
    ).resolves.toMatchObject({ acquired: true })
    await expect(
      store.acquireRecoveryLease({
        ...key,
        holder: 'worker-b',
        leaseToken: 'lease-b',
        now: NOW + 61_000,
      })
    ).resolves.toMatchObject({ acquired: true })
  })
})

describe('immutable Base child intents', () => {
  function child(childId, units = '1000000') {
    return {
      version: 1,
      networkId: NETWORK,
      owner: OWNER_G,
      agent: AGENT,
      bindingId: 'binding-shared',
      allocationId: 'allocation-base',
      childId,
      intent: { token: 'USDC', units, decimals: 6, pool: `pool-${childId}` },
      lifecycle: {
        sequence: 0,
        status: 'planned',
        evidence: { reviewed: true },
        observedAt: NOW,
      },
    }
  }

  it('keeps sibling child identities and idempotency journals distinct under one binding', async () => {
    await expect(ingestBaseChildIntent({ child: child('child-a'), store })).resolves.toMatchObject({
      written: 1,
    })
    await expect(ingestBaseChildIntent({ child: child('child-b'), store })).resolves.toMatchObject({
      written: 1,
    })
    const rows = await store.readOwnerBaseChildIntents({ networkId: NETWORK, owner: OWNER_G })
    expect(rows.map((row) => row.childId).sort()).toEqual(['child-a', 'child-b'])
    expect(
      db._raw.prepare('SELECT COUNT(*) AS count FROM base_child_lifecycle_events').get().count
    ).toBe(2)
  })

  it('makes exact intent duplicates idempotent and immutable conflicts explicit', async () => {
    const original = child('child-a')
    await ingestBaseChildIntent({ child: original, store })
    await expect(ingestBaseChildIntent({ child: original, store })).resolves.toMatchObject({
      written: 0,
      duplicates: 1,
    })
    await expect(
      ingestBaseChildIntent({ child: child('child-a', '2000000'), store })
    ).rejects.toThrow(/immutable|conflict/i)
    await expect(
      ingestBaseChildIntent({
        child: {
          ...child('child-a'),
          agent: 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE',
        },
        store,
      })
    ).rejects.toThrow(/immutable|conflict/i)
  })

  it('advances lifecycle sequence by one and rejects stale or skipped sequence updates', async () => {
    const original = child('child-a')
    await ingestBaseChildIntent({ child: original, store })
    const identity = {
      networkId: NETWORK,
      owner: OWNER_G,
      bindingId: original.bindingId,
      allocationId: original.allocationId,
      childId: original.childId,
    }
    await expect(
      advanceBaseChildLifecycle({
        identity,
        expectedSequence: 0,
        lifecycle: {
          sequence: 1,
          status: 'submitted',
          evidence: { userOpHash: '0xuserop-a' },
          observedAt: NOW + 1,
        },
        store,
      })
    ).resolves.toMatchObject({ written: 1, sequence: 1 })
    await expect(
      advanceBaseChildLifecycle({
        identity,
        expectedSequence: 0,
        lifecycle: {
          sequence: 2,
          status: 'confirmed',
          evidence: { txHash: '0xtx-a' },
          observedAt: NOW + 2,
        },
        store,
      })
    ).rejects.toThrow(/sequence|conflict/i)
    expect(() =>
      db._raw
        .prepare(
          `UPDATE base_child_intents SET lifecycle_sequence = 3
           WHERE network_id = ? AND binding_id = ? AND allocation_id = ? AND child_id = ?`
        )
        .run(NETWORK, original.bindingId, original.allocationId, original.childId)
    ).toThrow(/sequence|monotonic/i)
  })
})

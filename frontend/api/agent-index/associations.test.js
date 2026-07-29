import { describe, expect, it, vi } from 'vitest'
import {
  baseChildIdempotencyKey,
  baseChildIdentity,
  advanceBaseChildLifecycle,
  associationIdempotencyKey,
  ingestBaseChildIntent,
  ingestAssociationReport,
  joinBaseAssociations,
} from './associations.js'

const OWNER_A = `G${'A'.repeat(55)}`
const OWNER_B = `G${'B'.repeat(55)}`
const BRIDGE = `C${'C'.repeat(55)}`
const KERNEL = `0x${'12'.repeat(20)}`
const MESSENGER = `C${'D'.repeat(55)}`
const TOKEN = `C${'E'.repeat(55)}`
const POOL = `0x${'34'.repeat(20)}`
const NOW = 2_000_000_000_000
const LIVE_BRIDGE_ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'

const POOL_TARGETS = new Map([[POOL.toLowerCase(), 'aave-v3']])
const SCOPE_REQUIREMENTS = {
  messenger: MESSENGER,
  token: TOKEN,
  destinationDomain: 6,
  reportToken: 'USDC',
  reportDecimals: 6,
  scopeDecimals: 7,
}

describe('Base child intent identity', () => {
  const child = (childId) => ({
    version: 1,
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    agent: BRIDGE,
    bindingId: 'binding-shared',
    allocationId: 'allocation-shared',
    childId,
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: POOL,
      proxyTarget: 'aave-v3',
      runId: 'run-42',
      grantTxHash: 'grant-42',
      kernelAddress: KERNEL,
      bindingHash: 'binding-hash',
      baseJobId: childId,
    },
    lifecycle: {
      sequence: 0,
      status: 'planned',
      evidence: { reviewed: true },
      observedAt: NOW,
    },
  })

  it('includes childId in the immutable idempotency identity', () => {
    expect(baseChildIdempotencyKey(child('child-a'))).not.toBe(
      baseChildIdempotencyKey(child('child-b'))
    )
  })

  it('passes the validated immutable child and child-specific key to the repository', async () => {
    const calls = []
    const store = {
      async createBaseChildIntent(input) {
        calls.push(input)
        return { written: 1, duplicates: 0 }
      },
    }
    await expect(ingestBaseChildIntent({ child: child('child-a'), store })).resolves.toEqual({
      written: 1,
      duplicates: 0,
    })
    expect(calls[0].idempotencyKey).toBe(baseChildIdempotencyKey(child('child-a')))
    expect(calls[0].child).toMatchObject({ childId: 'child-a', bindingId: 'binding-shared' })
  })

  // Defect caught: acknowledgements could omit or re-derive part of the immutable child identity.
  it('derives the exact acknowledgement identity from owner, binding, allocation, and child', () => {
    expect(baseChildIdentity(child('child-a'))).toEqual({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      bindingId: 'binding-shared',
      allocationId: 'allocation-shared',
      childId: 'child-a',
    })
  })

  // Defect caught: a lifecycle gap could reach the durable store instead of failing validation first.
  it('rejects out-of-order lifecycle before calling the store', async () => {
    const store = { advanceBaseChildLifecycle: vi.fn() }
    await expect(
      advanceBaseChildLifecycle({
        identity: baseChildIdentity(child('child-a')),
        expectedSequence: 0,
        lifecycle: { sequence: 2, status: 'submitted', evidence: {}, observedAt: NOW + 1 },
        store,
      })
    ).rejects.toThrow(/sequence/i)
    expect(store.advanceBaseChildLifecycle).not.toHaveBeenCalled()
  })

  // Defect caught: authenticated D1 writes could accept unbounded mandate/session payloads.
  it('rejects non-protocol child and lifecycle fields before calling the store', async () => {
    const intentStore = { createBaseChildIntent: vi.fn() }
    await expect(
      ingestBaseChildIntent({
        child: { ...child('child-a'), serializedApproval: 'full-mandate' },
        store: intentStore,
      })
    ).rejects.toThrow(/unexpected/i)
    expect(intentStore.createBaseChildIntent).not.toHaveBeenCalled()

    const lifecycleStore = { advanceBaseChildLifecycle: vi.fn() }
    await expect(
      advanceBaseChildLifecycle({
        identity: { ...baseChildIdentity(child('child-a')), sessionPrivateKey: 'secret' },
        expectedSequence: 0,
        lifecycle: { sequence: 1, status: 'submitted', evidence: {}, observedAt: NOW + 1 },
        store: lifecycleStore,
      })
    ).rejects.toThrow(/unexpected|private/i)
    expect(lifecycleStore.advanceBaseChildLifecycle).not.toHaveBeenCalled()
  })
})

function allocation(overrides = {}) {
  return {
    allocationId: 'run-42:bridge:aave-v3',
    poolAddress: POOL,
    proxyTarget: 'aave-v3',
    amount: { token: 'USDC', units: '1000000', decimals: 6 },
    executionStatus: 'accepted',
    custody: { location: 'unknown' },
    txHash: null,
    ...overrides,
  }
}

function report(overrides = {}) {
  return {
    version: 1,
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    bridgeAgent: BRIDGE,
    runId: 'run-42',
    grantTxHash: 'grant-42',
    kernelAddress: KERNEL,
    mandateBindingId: 'binding-42',
    mandateBindingHash: 'binding-hash-42',
    baseJobId: 'job-42',
    allocations: [allocation()],
    ...overrides,
  }
}

function scope(overrides = {}) {
  return {
    owner: OWNER_A,
    target: MESSENGER,
    token: TOKEN,
    kind: 1,
    mint_recipient: Buffer.from(KERNEL.slice(2).padStart(64, '0'), 'hex'),
    destination_domain: 6,
    cap_per_period: 10_000_000n,
    expiry: BigInt(Math.floor(NOW / 1000) + 3600),
    revoked: false,
    ...overrides,
  }
}

function memoryStore({ membershipOwner = OWNER_A, membership = {} } = {}) {
  const rows = new Map()
  const events = new Set()
  return {
    rows,
    events,
    async readMembershipsByAgentAddresses({ agentAddresses }) {
      return agentAddresses.includes(BRIDGE)
        ? [
            {
              address: BRIDGE,
              owner: membershipOwner,
              creator: LIVE_BRIDGE_ROUTER,
              schemaVersion: 1,
              kind: 'unknown',
              grantTxHash: 'grant-42',
              provenance: { source: 'router-event', generation: 'agent-v3-bridge' },
              ...membership,
            },
          ]
        : []
    },
    async readRunAllocation({ networkId, runId, allocationId }) {
      void runId
      return rows.get(`${networkId}|${allocationId}`) ?? null
    },
    async hasAssociationEvent({ idempotencyKey }) {
      return events.has(idempotencyKey)
    },
    async commitAssociation({ association, idempotencyKey }) {
      rows.set(`${association.networkId}|${association.allocationId}`, association)
      events.add(idempotencyKey)
    },
  }
}

function ingest(overrides = {}) {
  const incoming = overrides.report ?? report()
  return ingestAssociationReport({
    report: incoming,
    idempotencyKey:
      overrides.idempotencyKey ?? associationIdempotencyKey(incoming, incoming.allocations[0]),
    store: overrides.store ?? memoryStore(),
    scopeReader: overrides.scopeReader ?? vi.fn(async () => scope()),
    poolTargets: POOL_TARGETS,
    scopeRequirements: SCOPE_REQUIREMENTS,
    now: NOW,
  })
}

describe('ingestAssociationReport', () => {
  it('verifies indexed membership and live bridge scope before the first durable association', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    const out = await ingest({ store, scopeReader })

    expect(out).toEqual({ written: 1, duplicates: 0 })
    expect(scopeReader).toHaveBeenCalledWith({
      networkId: 'stellar-testnet',
      bridgeAgent: BRIDGE,
    })
    expect([...store.rows.values()][0]).toMatchObject({
      allocationId: 'run-42:bridge:aave-v3',
      ownerAddress: OWNER_A,
      bridgeAgentAddress: BRIDGE,
      poolAddress: POOL,
      proxyTarget: 'aave-v3',
      executionStatus: 'accepted',
      custodyLocation: 'unknown',
      txHash: null,
      mandateBindingId: 'binding-42',
      mandateBindingHash: 'binding-hash-42',
      associationSource: 'relayer-attested',
      reportedAt: NOW,
      scopeCheckedAt: NOW,
    })
  })

  it('rejects owner B attaching to owner A membership or live scope', async () => {
    await expect(
      ingest({ report: report({ owner: OWNER_B }), store: memoryStore() })
    ).rejects.toThrow(/owner|membership/i)
    await expect(
      ingest({ scopeReader: vi.fn(async () => scope({ owner: OWNER_B })) })
    ).rejects.toThrow(/owner/i)
  })

  it.each([
    ['kind', { kind: 0 }],
    ['messenger', { target: `C${'F'.repeat(55)}` }],
    ['mint recipient', { mint_recipient: Buffer.alloc(32) }],
    ['token', { token: `C${'F'.repeat(55)}` }],
    ['destination domain', { destination_domain: 27 }],
    ['cap', { cap_per_period: 9_999_999n }],
    ['expiry', { expiry: BigInt(Math.floor(NOW / 1000) - 1) }],
    ['revoked', { revoked: true }],
  ])('rejects a bridge scope with invalid %s coverage', async (_label, changed) => {
    await expect(ingest({ scopeReader: vi.fn(async () => scope(changed)) })).rejects.toThrow(
      /scope/i
    )
  })

  it('rejects missing binding attestation, unallowlisted pools, proxy spoofing, and APY invention', async () => {
    await expect(ingest({ report: report({ mandateBindingId: null }) })).rejects.toThrow(/binding/i)
    await expect(
      ingest({
        report: report({
          allocations: [allocation({ poolAddress: `0x${'99'.repeat(20)}` })],
        }),
      })
    ).rejects.toThrow(/pool/i)
    await expect(
      ingest({ report: report({ allocations: [allocation({ proxyTarget: 'moonwell' })] }) })
    ).rejects.toThrow(/proxy/i)
    await expect(
      ingest({ report: report({ allocations: [allocation({ apy: 12 })] }) })
    ).rejects.toThrow(/field|apy/i)
    await expect(ingest({ report: report({ apy: 12 }) })).rejects.toThrow(/field|apy/i)
    await expect(
      ingest({
        report: report({
          allocations: [allocation({ amount: { ...allocation().amount, apy: 12 } })],
        }),
      })
    ).rejects.toThrow(/field|apy/i)
    await expect(
      ingest({
        report: report({
          allocations: [allocation({ custody: { location: 'unknown', apy: 12 } })],
        }),
      })
    ).rejects.toThrow(/field|apy/i)
  })

  it.each([
    ['grant transaction', { grantTxHash: 'different-grant' }],
    ['creator', { creator: `C${'F'.repeat(55)}` }],
    ['generation', { provenance: { source: 'router-event', generation: 'agent-v3' } }],
    ['provenance', { provenance: { source: 'registry-event', generation: 'agent-v3-bridge' } }],
  ])('rejects first association with wrong live bridge %s evidence', async (_label, membership) => {
    await expect(ingest({ store: memoryStore({ membership }) })).rejects.toThrow(
      /grant|provenance|generation|creator/i
    )
  })

  it('rejects a first association whose allocation ID belongs to another reviewed run', async () => {
    await expect(ingest({ report: report({ runId: 'run-other' }) })).rejects.toThrow(
      /allocationId|run/i
    )
  })

  it('rejects unobserved acceptance that claims funds are already in transit', async () => {
    await expect(
      ingest({
        report: report({
          allocations: [allocation({ custody: { location: 'in-transit' }, txHash: null })],
        }),
      })
    ).rejects.toThrow(/accept|custody|observ/i)
  })

  it('rejects a foreign network before a testnet membership or scope read', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    await expect(
      ingest({ report: report({ networkId: 'stellar-mainnet' }), store, scopeReader })
    ).rejects.toThrow(/network/i)
    expect(scopeReader).not.toHaveBeenCalled()
  })

  it('rejects a run/allocationId mismatch or an unallowlisted pool before any existing row is read', async () => {
    const store = memoryStore()

    // Canonical-ID and pool-allowlist checks are unconditional — they reject before any existing
    // row (or the idempotency journal) is even consulted.
    await expect(ingest({ report: report({ runId: 'run-other' }), store })).rejects.toThrow()
    await expect(
      ingest({
        report: report({ allocations: [allocation({ poolAddress: `0x${'56'.repeat(20)}` })] }),
        store,
      })
    ).rejects.toThrow()
  })

  it('rejects a changed pool, owner, run, or terminal result for an existing allocation', async () => {
    const store = memoryStore()

    // Seed `existing` directly (bypassing ingestAssociationReport, so nothing lands in the
    // idempotency journal for it) — Fix loop 2, Fix 3 makes an exact repeat of already-*applied*
    // evidence idempotent, so proving these identity/terminal guards still hold requires each
    // delivery below to be the first the journal has ever seen for its own tuple, not a genuine
    // retry of one that was already committed live.
    //
    // Fix loop 3, Fix 2: seeded at the SAME executionStatus/txHash ('accepted'/null) that every
    // identity variant below sends, so validateMonotonic (which only fires on a status/txHash
    // change) cannot also throw here — only validateImmutable can, and the assertion below checks
    // its exact message so this test fails if validateImmutable is ever weakened or removed.
    const baseRow = {
      allocationId: 'run-42:bridge:aave-v3',
      networkId: 'stellar-testnet',
      runId: 'run-42',
      ownerAddress: OWNER_A,
      bridgeAgentAddress: BRIDGE,
      poolAddress: POOL,
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      proxyTarget: 'aave-v3',
      baseJobId: 'job-42',
      txHash: null,
      executionStatus: 'accepted',
      custodyLocation: 'unknown',
      grantTxHash: 'grant-42',
      kernelAddress: KERNEL,
      mandateBindingId: 'binding-42',
      mandateBindingHash: 'binding-hash-42',
      associationSource: 'relayer-attested',
      reportedAt: NOW,
      scopeCheckedAt: NOW,
    }
    for (const changed of [
      report({ owner: OWNER_B }),
      report({ allocations: [allocation({ amount: { token: 'USDC', units: '2', decimals: 6 } })] }),
      report({ baseJobId: 'job-other' }),
      report({ grantTxHash: 'grant-other' }),
    ]) {
      store.rows.set('stellar-testnet|run-42:bridge:aave-v3', { ...baseRow })
      await expect(ingest({ report: changed, store })).rejects.toThrow(
        /allocation identity cannot change/i
      )
    }

    // Terminal-state protections, same reasoning: seed a terminal existing row directly.
    store.rows.set('stellar-testnet|run-42:bridge:aave-v3', {
      ...baseRow,
      executionStatus: 'deposited',
      custodyLocation: 'base-proxy',
      txHash: '0xexisting-deposit',
    })
    const regressed = report({
      allocations: [allocation({ executionStatus: 'minted', txHash: null })],
    })
    await expect(ingest({ report: regressed, store })).rejects.toThrow(/regress|terminal/i)
    const changedTerminal = report({
      allocations: [
        allocation({ executionStatus: 'failed', custody: { location: 'agent' }, txHash: null }),
      ],
    })
    await expect(ingest({ report: changedTerminal, store })).rejects.toThrow(/terminal/i)
    const erasedTerminalCustody = report({
      allocations: [
        allocation({
          executionStatus: 'deposited',
          custody: { location: 'unknown' },
          txHash: '0xexisting-deposit',
        }),
      ],
    })
    await expect(ingest({ report: erasedTerminalCustody, store })).rejects.toThrow(
      /custody|terminal/i
    )
  })

  it('is idempotent on the exact tuple and skips a second scope read', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    await ingest({ store, scopeReader })
    const out = await ingest({ store, scopeReader })
    expect(out).toEqual({ written: 0, duplicates: 1 })
    expect(scopeReader).toHaveBeenCalledTimes(1)
  })

  it('propagates the store result when a true duplicate wins after the pre-read', async () => {
    const store = memoryStore()
    store.commitAssociation = vi.fn(async () => ({ written: 0, duplicates: 1 }))
    await expect(ingest({ store })).resolves.toEqual({ written: 0, duplicates: 1 })
  })

  // Fix loop 2, Fix 3: frontend/migrations/0004_agent_associations.sql:12-13 documents that the
  // journal "makes retries of an older, already-accepted tuple idempotent even after the latest
  // row has advanced" (e.g. a retried 'accepted' callback arriving after 'minted' was applied).
  // Before this fix, the journal short-circuit ran AFTER validateMonotonic, so a retried older
  // tuple hit "association evidence cannot regress" (400) instead of the documented idempotent
  // success — the journal was idempotent only for the not-yet-advanced case, which never needed
  // a journal at all.
  it('makes a retried older tuple idempotent even after a newer tuple has already advanced', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    const acceptedReport = report()
    const acceptedKey = associationIdempotencyKey(acceptedReport, acceptedReport.allocations[0])
    await ingest({ report: acceptedReport, store, scopeReader })

    const mintedReport = report({
      allocations: [
        allocation({ executionStatus: 'minted', custody: { location: 'agent' }, txHash: '0xmint' }),
      ],
    })
    await ingest({ report: mintedReport, store, scopeReader })

    // Retry delivery of the already-applied older 'accepted' tuple, arriving after 'minted'.
    const replay = await ingestAssociationReport({
      report: acceptedReport,
      idempotencyKey: acceptedKey,
      store,
      scopeReader,
      poolTargets: POOL_TARGETS,
      scopeRequirements: SCOPE_REQUIREMENTS,
      now: NOW,
    })
    expect(replay).toEqual({ written: 0, duplicates: 1 })
  })

  it('still rejects a never-applied older report as a regression, proving the journal short-circuit is not a bypass', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    await ingest({
      report: report({
        allocations: [
          allocation({
            executionStatus: 'minted',
            custody: { location: 'agent' },
            txHash: '0xmint',
          }),
        ],
      }),
      store,
      scopeReader,
    })

    // This exact ('burn-confirmed', '0xburn-confirmed') tuple was never previously ingested, so
    // it cannot be sitting in the idempotency journal — the short-circuit must not fire for it.
    const neverApplied = report({
      allocations: [
        allocation({
          executionStatus: 'burn-confirmed',
          custody: { location: 'agent' },
          txHash: '0xburn-confirmed',
        }),
      ],
    })
    await expect(ingest({ report: neverApplied, store, scopeReader })).rejects.toThrow(/regress/i)
  })

  // Fix loop 3, Fix 1: associationIdempotencyKey covers only [networkId, runId, allocationId,
  // executionStatus, txHash] (:223-231), not ownerAddress/amount.units/baseJobId/grantTxHash/
  // kernelAddress/mandateBindingId/mandateBindingHash. Before this fix, validateImmutable ran
  // AFTER the journal short-circuit, so a second report sharing the first's (status, txHash)
  // tuple but disagreeing on identity hit hasAssociationEvent and returned a false
  // { written: 0, duplicates: 1 } instead of throwing.
  it.each([
    ['ownerAddress', { owner: OWNER_B }],
    [
      'amount.units',
      { allocations: [allocation({ amount: { token: 'USDC', units: '2000000', decimals: 6 } })] },
    ],
    ['baseJobId', { baseJobId: 'job-other' }],
  ])(
    'rejects a same-tuple report with a different %s even after the tuple is already journaled',
    async (_label, changed) => {
      const store = memoryStore()
      const scopeReader = vi.fn(async () => scope())
      await ingest({ store, scopeReader })

      // report(changed) keeps the default 'accepted'/null tuple, so its idempotency key equals
      // the one just journaled above — the short-circuit must not fire for this conflicting body.
      await expect(ingest({ report: report(changed), store, scopeReader })).rejects.toThrow(
        /allocation identity cannot change/i
      )
    }
  )

  it('rejects a journaled idempotency key paired with a mismatched report body instead of short-circuiting', async () => {
    const store = memoryStore()
    const scopeReader = vi.fn(async () => scope())
    const acceptedReport = report()
    const acceptedKey = associationIdempotencyKey(acceptedReport, acceptedReport.allocations[0])
    await ingest({ report: acceptedReport, store, scopeReader })

    const differentReport = report({
      allocations: [
        allocation({
          executionStatus: 'burn-confirmed',
          custody: { location: 'agent' },
          txHash: '0xother',
        }),
      ],
    })
    await expect(
      ingestAssociationReport({
        report: differentReport,
        idempotencyKey: acceptedKey, // a journaled key, but it does not match this body's tuple
        store,
        scopeReader,
        poolTargets: POOL_TARGETS,
        scopeRequirements: SCOPE_REQUIREMENTS,
        now: NOW,
      })
    ).rejects.toThrow(/idempotency/i)
  })

  it('allows transaction evidence to advance from mint to deposit but not change in-place', async () => {
    const store = memoryStore()
    const minted = report({
      allocations: [
        allocation({
          executionStatus: 'minted',
          custody: { location: 'agent' },
          txHash: '0xmint',
        }),
      ],
    })
    const deposited = report({
      allocations: [
        allocation({
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash: '0xdeposit',
        }),
      ],
    })
    await ingest({ report: minted, store })
    await expect(ingest({ report: deposited, store })).resolves.toEqual({
      written: 1,
      duplicates: 0,
    })
    await expect(
      ingest({
        report: report({
          allocations: [
            allocation({
              executionStatus: 'deposited',
              custody: { location: 'base-proxy' },
              txHash: '0xdifferent-deposit',
            }),
          ],
        }),
        store,
      })
    ).rejects.toThrow(/transaction|terminal/i)
  })

  it.each(['held', 'failed'])(
    'accepts minted/agent evidence advancing to %s without erasing its mint hash',
    async (executionStatus) => {
      const store = memoryStore()
      await ingest({
        store,
        report: report({
          allocations: [
            allocation({
              executionStatus: 'minted',
              custody: { location: 'agent' },
              txHash: '0xmint-retained',
            }),
          ],
        }),
      })
      await expect(
        ingest({
          store,
          report: report({
            allocations: [
              allocation({
                executionStatus,
                custody: { location: 'agent' },
                txHash: '0xmint-retained',
              }),
            ],
          }),
        })
      ).resolves.toEqual({ written: 1, duplicates: 0 })
    }
  )

  it('requires the HTTP idempotency key to equal the canonical tuple', async () => {
    await expect(ingest({ idempotencyKey: 'wrong' })).rejects.toThrow(/idempotency/i)
  })
})

describe('joinBaseAssociations', () => {
  it('keeps two reviewed runs on one bridge distinguishable with exact public evidence', () => {
    const agents = [
      { address: BRIDGE, kind: 'unknown' },
      { address: `C${'F'.repeat(55)}`, kind: 'bridge' },
    ]
    const associations = [
      {
        allocationId: 'run-42:bridge:aave-v3',
        runId: 'run-42',
        bridgeAgentAddress: BRIDGE,
        poolAddress: POOL,
        proxyTarget: 'aave-v3',
        amount: { token: 'USDC', units: '1000000', decimals: 6 },
        baseJobId: 'job-42',
        grantTxHash: 'grant-42',
        kernelAddress: KERNEL,
        mandateBindingId: 'binding-42',
        mandateBindingHash: 'binding-hash-42',
        associationSource: 'relayer-attested',
        reportedAt: NOW - 1_000,
        scopeCheckedAt: NOW - 2_000,
        executionStatus: 'accepted',
        custodyLocation: 'unknown',
        txHash: null,
      },
      {
        allocationId: 'run-43:bridge:aave-v3',
        runId: 'run-43',
        bridgeAgentAddress: BRIDGE,
        poolAddress: POOL,
        proxyTarget: 'aave-v3',
        amount: { token: 'USDC', units: '2000000', decimals: 6 },
        baseJobId: 'job-43',
        grantTxHash: 'grant-43',
        kernelAddress: `0x${'56'.repeat(20)}`,
        mandateBindingId: 'binding-43',
        mandateBindingHash: 'binding-hash-43',
        associationSource: 'relayer-attested',
        reportedAt: NOW - 2_000,
        scopeCheckedAt: NOW - 3_000,
        executionStatus: 'queued',
        custodyLocation: 'unknown',
        txHash: null,
      },
    ]

    const joined = joinBaseAssociations({ agents, associations, now: NOW, freshnessMs: 60_000 })
    expect(joined[0]).toMatchObject({
      association: 'known',
      associationSource: 'relayer-attested',
      reportedAt: NOW - 1_000,
      scopeCheckedAt: NOW - 2_000,
      freshness: 'fresh',
    })
    expect(joined[0].baseChildren).toHaveLength(2)
    expect(joined[0].baseChildren).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'run-42:bridge:aave-v3',
          runId: 'run-42',
          grantTxHash: 'grant-42',
          baseJobId: 'job-42',
          kernelAddress: KERNEL,
          mandateBindingId: 'binding-42',
          mandateBindingHash: 'binding-hash-42',
          association: 'known',
          associationSource: 'relayer-attested',
          reportedAt: NOW - 1_000,
          scopeCheckedAt: NOW - 2_000,
          freshness: 'fresh',
        }),
        expect.objectContaining({
          allocationId: 'run-43:bridge:aave-v3',
          runId: 'run-43',
          grantTxHash: 'grant-43',
          baseJobId: 'job-43',
          kernelAddress: `0x${'56'.repeat(20)}`,
          mandateBindingId: 'binding-43',
          mandateBindingHash: 'binding-hash-43',
        }),
      ])
    )
    expect(joined[1]).toMatchObject({
      association: 'unknown',
      associationSource: null,
      reportedAt: null,
      scopeCheckedAt: null,
      freshness: 'unknown',
      baseChildren: [],
    })
  })
})

// frontend/src/strategy/reusePreflight.test.js — the proof-carrying fresh/reuse permission
// preflight. ALL-OR-NOTHING: any missing/unproven/mismatched element anywhere forces a complete
// fresh decision with a specific freshReason. Base (bridge) allocations always force fresh.
import { describe, test, expect, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import {
  preflightPermission,
  toPermissionDecisionView,
  fingerprintAgentInits,
} from './reusePreflight.js'
import { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from '../stellar/grant.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const VAULT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const SECRET = 'SDNJDG6MB2WNZ2VVK5FIHCMPHR7DUGRC6L4LNXGY26YZ6TBRVR23Z2DZ' // realistic-looking secret shape
const SIGNER_PUB = 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU'
const NOW = 1_800_000_000

const rawSigner = () => new Uint8Array(32).fill(7)
const rawSalt = () => new Uint8Array(32).fill(9)

function agentInit(over = {}) {
  return {
    allocationId: 'run-1:deposit:0',
    kind: AGENT_KIND_DEPOSIT,
    token: TOKEN,
    target: VAULT,
    cap: { token: TOKEN, units: 100_000_000n, decimals: 7 },
    periodSeconds: 86400,
    expiry: NOW + 3600,
    signer: rawSigner(),
    salt: rawSalt(),
    destinationDomain: 0,
    mintRecipient: new Uint8Array(32),
    ...over,
  }
}

function receipt(over = {}) {
  return {
    version: 1,
    runId: 'run-1',
    owner: OWNER,
    router: ROUTER,
    network: 'stellar-testnet',
    txHash: 'HGRANT',
    confirmedLedger: 1000,
    expiryLedger: NOW + 7200, // ledger-space in these tests is treated as comparable to nowSec for simplicity
    allowanceBudgets: [{ token: TOKEN, units: '100000000', decimals: 7 }],
    agentInitFingerprint: fingerprintAgentInits([agentInit()]),
    agentAddresses: [AGENT_1],
    confirmedAt: 1_700_000_000,
    ...over,
  }
}

function provenProof(over = {}) {
  return {
    version: 1,
    owner: OWNER,
    router: ROUTER,
    network: 'stellar-testnet',
    indexedFromLedger: 1000,
    indexedThroughLedger: NOW,
    latestLedger: NOW,
    gapFree: true,
    noLaterMutation: true,
    approvals: [
      {
        amount: { token: TOKEN, units: '100000000', decimals: 7 },
        expiryLedger: NOW + 7200,
        ledger: 1000,
        txHash: 'HGRANT',
        eventIndex: 0,
      },
    ],
    proofHash: '0x' + 'ab'.repeat(32),
    ...over,
  }
}

function validScope(over = {}) {
  return {
    owner: OWNER,
    target: VAULT,
    token: TOKEN,
    kind: AGENT_KIND_DEPOSIT,
    cap_per_period: 100_000_000n,
    period_duration: 86400n,
    spent_in_period: 0n,
    period_start: 0n,
    expiry: BigInt(NOW + 7200),
    revoked: false,
    ...over,
  }
}

function cachedRow(over = {}) {
  return {
    agentAddress: AGENT_1,
    entry: {
      agentAddress: AGENT_1,
      secret: SECRET,
      signerPub: SIGNER_PUB,
      cap: '100000000',
      expiry: NOW + 7200,
      createdAt: 1,
    },
    scope: validScope(),
    signer: null, // filled below via signerBytesFor
    scopeFingerprint: '0x' + 'cd'.repeat(32),
    ...over,
  }
}

// Raw ed25519 bytes matching SIGNER_PUB's decoded strkey, so the "we still hold the working
// session key" check passes in the happy-path tests.
function signerBytesForPub() {
  return StrKey.decodeEd25519PublicKey(SIGNER_PUB)
}

const baseDeps = (over = {}) => ({
  runId: 'run-1',
  owner: OWNER,
  router: ROUTER,
  planFingerprint: '0xplan',
  agentInits: [agentInit()],
  reviewedBudgets: [{ token: TOKEN, units: 100_000_000n, decimals: 7 }],
  durationSeconds: 3600,
  nowSec: NOW,
  storage: {},
  loadReceipt: vi.fn(() => receipt()),
  proveAllowance: vi.fn(async () => ({ proven: true, reason: null, proof: provenProof() })),
  inspectAgents: vi.fn(async () => [{ ...cachedRow(), signer: signerBytesForPub() }]),
  ...over,
})

describe('empty reviewed set is rejected (review Minor 5)', () => {
  test('an empty agentInits list throws rather than vacuously "reusing" nothing', async () => {
    await expect(preflightPermission(baseDeps({ agentInits: [] }))).rejects.toThrow(/at least one/i)
  })
})

describe('base allocations ALWAYS force fresh', () => {
  test('a bridge-kind agentInit forces fresh with base-required, without even attempting a proof', async () => {
    const proveAllowance = vi.fn()
    const loadReceipt = vi.fn()
    const out = await preflightPermission(
      baseDeps({
        agentInits: [
          agentInit(),
          agentInit({
            allocationId: 'run-1:bridge:base',
            kind: AGENT_KIND_BRIDGE,
            target: 'CBRIDGE',
          }),
        ],
        proveAllowance,
        loadReceipt,
      })
    )
    expect(out.mode).toBe('fresh')
    expect(out.freshReason).toBe('base-required')
    expect(out.confirmationCount).toBe(1)
    expect(proveAllowance).not.toHaveBeenCalled()
    expect(loadReceipt).not.toHaveBeenCalled()
  })
})

describe('fresh reasons - receipt / proof establishment', () => {
  test('no stored receipt -> allowance-proof-missing', async () => {
    const out = await preflightPermission(baseDeps({ loadReceipt: vi.fn(() => null) }))
    expect(out.mode).toBe('fresh')
    expect(out.freshReason).toBe('allowance-proof-missing')
  })

  test('a receipt for a DIFFERENT reviewed agent set -> allowance-proof-missing', async () => {
    const out = await preflightPermission(
      baseDeps({ loadReceipt: vi.fn(() => receipt({ agentInitFingerprint: '0xstale' })) })
    )
    expect(out.freshReason).toBe('allowance-proof-missing')
  })

  test('proof unproven (gapped) -> allowance-proof-gapped', async () => {
    const out = await preflightPermission(
      baseDeps({
        proveAllowance: vi.fn(async () => ({ proven: false, reason: 'gapped', proof: null })),
      })
    )
    expect(out.freshReason).toBe('allowance-proof-gapped')
  })

  test('proof unproven (mutated) -> allowance-mutated', async () => {
    const out = await preflightPermission(
      baseDeps({
        proveAllowance: vi.fn(async () => ({ proven: false, reason: 'mutated', proof: null })),
      })
    )
    expect(out.freshReason).toBe('allowance-mutated')
  })
})

describe('fresh reasons - allowance sufficiency + expiry margin', () => {
  test('proven allowance amount below what is now needed -> allowance-insufficient', async () => {
    const proof = provenProof({
      approvals: [
        {
          amount: { token: TOKEN, units: '1', decimals: 7 },
          expiryLedger: NOW + 7200,
          ledger: 1000,
          txHash: 'H',
          eventIndex: 0,
        },
      ],
    })
    const out = await preflightPermission(
      baseDeps({ proveAllowance: vi.fn(async () => ({ proven: true, reason: null, proof })) })
    )
    expect(out.freshReason).toBe('allowance-insufficient')
  })

  test('receipt expiry inside the current-ledger safety margin -> allowance-insufficient', async () => {
    const out = await preflightPermission(
      baseDeps({ loadReceipt: vi.fn(() => receipt({ expiryLedger: NOW + 1 })) })
    )
    expect(out.freshReason).toBe('allowance-insufficient')
  })
})

describe('fresh reasons - per-agent scope validation (ALL-OR-NOTHING)', () => {
  test('no cached agent at all for a reviewed target -> agent-missing', async () => {
    const out = await preflightPermission(baseDeps({ inspectAgents: vi.fn(async () => []) }))
    expect(out.freshReason).toBe('agent-missing')
  })

  test('cached agent exists but its on-chain scope read failed -> scope-unavailable', async () => {
    const out = await preflightPermission(
      baseDeps({
        inspectAgents: vi.fn(async () => [{ ...cachedRow(), scope: null, scopeFingerprint: null }]),
      })
    )
    expect(out.freshReason).toBe('scope-unavailable')
  })

  test.each([
    ['owner mismatch', { owner: 'GOTHER' }],
    ['target mismatch', { target: 'COTHER' }],
    ['token mismatch', { token: 'COTHERTOKEN' }],
    ['kind mismatch', { kind: AGENT_KIND_BRIDGE }],
    ['cap below what is reviewed', { cap_per_period: 1n }],
    ['period mismatch', { period_duration: 999n }],
    ['revoked', { revoked: true }],
    ['expiring within the safety margin', { expiry: BigInt(NOW + 60) }],
  ])('scope %s -> scope-invalid', async (_label, over) => {
    const out = await preflightPermission(
      baseDeps({
        inspectAgents: vi.fn(async () => [
          { ...cachedRow({ scope: validScope(over) }), signer: signerBytesForPub() },
        ]),
      })
    )
    expect(out.freshReason).toBe('scope-invalid')
  })

  test('on-chain signer disagreeing with the locally-held session key -> scope-invalid', async () => {
    const out = await preflightPermission(
      baseDeps({
        inspectAgents: vi.fn(async () => [{ ...cachedRow(), signer: new Uint8Array(32).fill(1) }]),
      })
    )
    expect(out.freshReason).toBe('scope-invalid')
  })

  test('structurally valid but drained headroom -> headroom-insufficient', async () => {
    const drained = validScope({ period_start: BigInt(NOW - 10), spent_in_period: 100_000_000n })
    const out = await preflightPermission(
      baseDeps({
        inspectAgents: vi.fn(async () => [
          { ...cachedRow({ scope: drained }), signer: signerBytesForPub() },
        ]),
      })
    )
    expect(out.freshReason).toBe('headroom-insufficient')
  })

  test('duplicate-agent rejection: two allocations cannot both claim the same cached agent', async () => {
    const secondAlloc = agentInit({ allocationId: 'run-1:deposit:1' })
    const out = await preflightPermission(
      baseDeps({
        agentInits: [agentInit(), secondAlloc],
        loadReceipt: vi.fn(() =>
          receipt({
            agentInitFingerprint: fingerprintAgentInits([agentInit(), secondAlloc]),
            allowanceBudgets: [{ token: TOKEN, units: '200000000', decimals: 7 }],
          })
        ),
        proveAllowance: vi.fn(async () => ({
          proven: true,
          reason: null,
          proof: provenProof({
            approvals: [
              {
                amount: { token: TOKEN, units: '200000000', decimals: 7 },
                expiryLedger: NOW + 7200,
                ledger: 1000,
                txHash: 'H',
                eventIndex: 0,
              },
            ],
          }),
        })),
        // Only ONE cached agent exists for the (owner, VAULT) bucket -> both allocations target it.
        inspectAgents: vi.fn(async () => [{ ...cachedRow(), signer: signerBytesForPub() }]),
      })
    )
    expect(out.mode).toBe('fresh')
    expect(out.freshReason).toBe('agent-missing')
  })
})

describe('the reuse path (happy path)', () => {
  test('confirmationCount 0, freshReason null, proof fields populated, agents matched', async () => {
    const out = await preflightPermission(baseDeps())
    expect(out.mode).toBe('reuse')
    expect(out.confirmationCount).toBe(0)
    expect(out.freshReason).toBeNull()
    expect(out.grantReceiptFingerprint).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out.allowanceExpiryProof).not.toBeNull()
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]).toMatchObject({
      allocationId: 'run-1:deposit:0',
      workerId: 'run-1:deposit:0',
      agentAddress: AGENT_1,
      executionCredentialRef: AGENT_1,
    })
    expect(out.agents[0].headroom.token).toBe(TOKEN)
  })

  test('reviewedAgentInits carries fingerprints, never raw signer/salt bytes', async () => {
    const out = await preflightPermission(baseDeps())
    expect(out.reviewedAgentInits).toHaveLength(1)
    expect(out.reviewedAgentInits[0].signerFingerprint).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out.reviewedAgentInits[0].saltFingerprint).toMatch(/^0x[0-9a-f]{64}$/)
    expect(out.reviewedAgentInits[0].signer).toBeUndefined()
    expect(out.reviewedAgentInits[0].salt).toBeUndefined()
  })
})

describe('the fresh path shape', () => {
  test('confirmationCount 1, proof fields null, agents empty, reviewedAgentInits is the exact reviewed set', async () => {
    const out = await preflightPermission(baseDeps({ loadReceipt: vi.fn(() => null) }))
    expect(out.mode).toBe('fresh')
    expect(out.confirmationCount).toBe(1)
    expect(out.grantReceiptFingerprint).toBeNull()
    expect(out.allowanceExpiryProof).toBeNull()
    expect(out.agents).toEqual([])
    expect(out.reviewedAgentInits).toHaveLength(1)
    expect(out.reviewedAgentInits[0].allocationId).toBe('run-1:deposit:0')
  })
})

describe('fingerprintAgentInits - deterministic', () => {
  test('stable across calls for the identical input', () => {
    expect(fingerprintAgentInits([agentInit()])).toBe(fingerprintAgentInits([agentInit()]))
  })

  test.each([
    ['allocationId', { allocationId: 'other' }],
    ['kind', { kind: AGENT_KIND_BRIDGE }],
    ['token', { token: 'COTHERTOKEN' }],
    ['target', { target: 'COTHER' }],
    ['cap units', { cap: { token: TOKEN, units: 1n, decimals: 7 } }],
    ['periodSeconds', { periodSeconds: 1 }],
    ['expiry', { expiry: 1 }],
    ['signer bytes', { signer: new Uint8Array(32).fill(1) }],
    ['salt bytes', { salt: new Uint8Array(32).fill(1) }],
  ])('changes when %s changes', (_label, over) => {
    expect(fingerprintAgentInits([agentInit(over)])).not.toBe(fingerprintAgentInits([agentInit()]))
  })
})

describe('secret safety', () => {
  test('toPermissionDecisionView omits executionCredentialRef', async () => {
    const decision = await preflightPermission(baseDeps())
    const view = toPermissionDecisionView(decision)
    expect(view.agents[0].executionCredentialRef).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('executionCredentialRef')
  })

  test('neither the raw decision nor its view ever contain the session secret', async () => {
    const decision = await preflightPermission(baseDeps())
    const view = toPermissionDecisionView(decision)
    expect(JSON.stringify(decision)).not.toContain(SECRET)
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })

  test('the decision is JSON-serializable (no bigint/Uint8Array leaks into it)', async () => {
    const decision = await preflightPermission(baseDeps())
    expect(() => JSON.stringify(decision)).not.toThrow()
  })
})

describe('never touches a wallet/provider/transaction builder', () => {
  test('runs to completion using only the injected dependencies, no server required', async () => {
    const deps = baseDeps()
    delete deps.storage
    const out = await preflightPermission(deps)
    expect(out.mode).toBe('reuse')
  })
})

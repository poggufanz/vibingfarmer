// frontend/src/stellar/allowanceProof.test.js — the bounded stability loop that turns a
// GrantReceiptV1 + fresh chain reads into a proven-or-unproven AllowanceExpiryProofV1. Never
// trusts a single snapshot: it re-verifies through a second, later ledger whenever the chain
// moved during the check, and any gap/mutation/mismatch forces "unproven" (never a false reuse).
import { describe, test, expect, vi } from 'vitest'
import { proveCurrentAllowance, computeProofHash } from './allowanceProof.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const TOKEN_2 = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'

function receipt(over = {}) {
  return {
    version: 1,
    runId: 'run-1',
    owner: OWNER,
    router: ROUTER,
    network: 'stellar-testnet',
    txHash: 'HGRANT',
    confirmedLedger: 1000,
    expiryLedger: 5000,
    allowanceBudgets: [{ token: TOKEN, units: '100000000', decimals: 7 }],
    agentInitFingerprint: '0xabc',
    agentAddresses: ['CAGENT1'],
    confirmedAt: 1_700_000_000,
    ...over,
  }
}

// The receipt's OWN approve event — what the original grant tx emitted.
function ownApproval(over = {}) {
  return {
    owner: OWNER,
    spender: ROUTER,
    amount: 100_000_000n,
    expiryLedger: 5000,
    ledger: 1000,
    txHash: 'HGRANT',
    eventIndex: 0,
    ...over,
  }
}

function makeSyncEvents(byLedger) {
  // byLedger: (targetLedger) => { approvals, indexedThroughLedger, gapFree }
  return vi.fn(async ({ token }) => ({ token, ...byLedger() }))
}

const baseDeps = (over = {}) => ({
  receipt: receipt(),
  server: {},
  getLatestLedger: vi.fn(async () => 1000),
  readAllowance: vi.fn(async () => ({ amount: 100_000_000n })),
  readConfirmedLedger: vi.fn(async () => ({ confirmedLedger: 1000, confirmedAt: 1_700_000_000 })),
  syncEvents: makeSyncEvents(() => ({
    approvals: [ownApproval()],
    indexedFromLedger: 1000,
    indexedThroughLedger: 1000,
    gapFree: true,
  })),
  ...over,
})

describe('proveCurrentAllowance - happy path (no chain movement)', () => {
  test('proves when the receipt is still the latest, unmutated approval, gap-free through L1==L2', async () => {
    const deps = baseDeps()
    const out = await proveCurrentAllowance(deps)
    expect(out.proven).toBe(true)
    expect(out.reason).toBeNull()
    expect(out.proof).toMatchObject({
      version: 1,
      owner: OWNER,
      router: ROUTER,
      network: 'stellar-testnet',
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      latestLedger: 1000,
      gapFree: true,
      noLaterMutation: true,
    })
    expect(out.proof.approvals).toEqual([
      {
        amount: { token: TOKEN, units: '100000000', decimals: 7 },
        expiryLedger: 5000,
        ledger: 1000,
        txHash: 'HGRANT',
        eventIndex: 0,
      },
    ])
    expect(out.proof.proofHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('L1 captured only once when the second capture shows no chain movement (no wasted rescan)', async () => {
    const syncEvents = makeSyncEvents(() => ({
      approvals: [ownApproval()],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const getLatestLedger = vi.fn(async () => 1000) // L1 == L2 every call
    await proveCurrentAllowance(baseDeps({ syncEvents, getLatestLedger }))
    expect(syncEvents).toHaveBeenCalledTimes(1)
  })

  test('proofHash is deterministic for identical proof content', async () => {
    const a = await proveCurrentAllowance(baseDeps())
    const b = await proveCurrentAllowance(baseDeps())
    expect(a.proof.proofHash).toBe(b.proof.proofHash)
  })
})

describe('proveCurrentAllowance - the bounded stability loop (L2 > L1)', () => {
  test('extends and rechecks through L2 when the chain moved during the check', async () => {
    let latestCall = 0
    const getLatestLedger = vi.fn(async () => (++latestCall === 1 ? 1000 : 1010))
    const syncEvents = vi.fn(async () => ({
      approvals: [ownApproval()],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1010, // this scan (called once L2 is known) already covers L2
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ getLatestLedger, syncEvents }))
    expect(syncEvents).toHaveBeenCalledTimes(2) // round through L1, then extended through L2
    expect(out.proven).toBe(true)
    expect(out.proof.latestLedger).toBe(1010)
  })

  test('proof ending one ledger early (indexedThroughLedger < L2) is UNPROVEN, never accepted', async () => {
    let latestCall = 0
    const getLatestLedger = vi.fn(async () => (++latestCall === 1 ? 1000 : 1010))
    const syncEvents = vi.fn(async () => ({
      approvals: [ownApproval()],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1009, // one ledger short of L2=1010, even though its own gapFree says true
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ getLatestLedger, syncEvents }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
    expect(out.proof).toBeNull()
  })
})

describe('proveCurrentAllowance - the confirmed grant tx is re-read from chain (review Important 1)', () => {
  test('reads receipt.txHash via readConfirmedLedger before accepting anything', async () => {
    const readConfirmedLedger = vi.fn(async () => ({
      confirmedLedger: 1000,
      confirmedAt: 1_700_000_000,
    }))
    await proveCurrentAllowance(baseDeps({ readConfirmedLedger }))
    expect(readConfirmedLedger).toHaveBeenCalledWith(expect.objectContaining({ hash: 'HGRANT' }))
  })

  test('a missing/failed confirmed-tx read forces unproven (adversarial: the grant tx does not exist on chain)', async () => {
    const readConfirmedLedger = vi.fn(async () => {
      throw new Error('Transaction HGRANT is not confirmed: NOT_FOUND.')
    })
    const out = await proveCurrentAllowance(baseDeps({ readConfirmedLedger }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
    expect(out.proof).toBeNull()
  })

  test('a confirmed ledger disagreeing with the receipt forces unproven (forged/edited receipt)', async () => {
    const readConfirmedLedger = vi.fn(async () => ({
      confirmedLedger: 1001, // receipt claims 1000
      confirmedAt: 1_700_000_000,
    }))
    const out = await proveCurrentAllowance(baseDeps({ readConfirmedLedger }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })

  test('a confirmedAt disagreeing with the receipt forces unproven', async () => {
    const readConfirmedLedger = vi.fn(async () => ({
      confirmedLedger: 1000,
      confirmedAt: 1_700_000_001, // receipt claims 1_700_000_000
    }))
    const out = await proveCurrentAllowance(baseDeps({ readConfirmedLedger }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })
})

describe('proveCurrentAllowance - getLatestLedger outage never rejects the promise (review Important 4)', () => {
  test('an RPC outage on the L1 capture resolves to unproven, never throws', async () => {
    const getLatestLedger = vi.fn(async () => {
      throw new Error('rpc down')
    })
    await expect(proveCurrentAllowance(baseDeps({ getLatestLedger }))).resolves.toEqual({
      proven: false,
      reason: 'gapped',
      proof: null,
    })
  })

  test('an RPC outage on the L2 capture resolves to unproven, never throws', async () => {
    let n = 0
    const getLatestLedger = vi.fn(async () => {
      n++
      if (n === 1) return 1000
      throw new Error('rpc down')
    })
    await expect(proveCurrentAllowance(baseDeps({ getLatestLedger }))).resolves.toEqual({
      proven: false,
      reason: 'gapped',
      proof: null,
    })
  })
})

describe('proveCurrentAllowance - decoded event owner/spender defense-in-depth (review Minor 6)', () => {
  test('a foreign owner/spender event mixed in alongside the legitimate one is ignored - proof still succeeds', async () => {
    // Simulates a widened/wildcard topic filter picking up unrelated noise: the RPC filter
    // already scopes to owner+router, but this is the client-side backstop in case it ever
    // doesn't (a future decode change, a malicious RPC).
    const foreign = ownApproval({ owner: 'GFOREIGN', spender: ROUTER, ledger: 1001, eventIndex: 9 })
    const syncEvents = makeSyncEvents(() => ({
      approvals: [ownApproval(), foreign],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1001,
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents }))
    expect(out.proven).toBe(true)
  })

  test('only a foreign owner/spender event present - cannot prove anything (never fabricate a match)', async () => {
    const foreign = ownApproval({ owner: OWNER, spender: 'CFOREIGNROUTER' })
    const syncEvents = makeSyncEvents(() => ({
      approvals: [foreign],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })
})

describe('proveCurrentAllowance - unproven (gapped) cases', () => {
  test('a cursor gap (store itself reports gapFree:false) is unproven', async () => {
    const syncEvents = makeSyncEvents(() => ({
      approvals: [],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: false,
    }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })

  test('no approval found at all for a budgeted token is unproven (never assume zero == proven)', async () => {
    const syncEvents = makeSyncEvents(() => ({
      approvals: [],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })

  test('a strict-read failure (RPC down) is unproven, never treated as zero', async () => {
    const readAllowance = vi.fn(async () => {
      throw new Error('AllowanceReadError: rpc down')
    })
    const out = await proveCurrentAllowance(baseDeps({ readAllowance }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })

  test('a missing receipt is unproven', async () => {
    const out = await proveCurrentAllowance(baseDeps({ receipt: null }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('gapped')
  })
})

describe('proveCurrentAllowance - mutation detection', () => {
  test('same-amount, later-expiry mutation forces unproven/mutated', async () => {
    const mutated = ownApproval({ expiryLedger: 5001, ledger: 1000, eventIndex: 1 })
    const syncEvents = makeSyncEvents(() => ({
      approvals: [ownApproval(), mutated],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('mutated')
  })

  test('a later zero approval (revoke) forces unproven/mutated', async () => {
    const revoke = ownApproval({ amount: 0n, expiryLedger: 1001, ledger: 1000, eventIndex: 1 })
    const syncEvents = makeSyncEvents(() => ({
      approvals: [ownApproval(), revoke],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const readAllowance = vi.fn(async () => ({ amount: 0n }))
    const out = await proveCurrentAllowance(baseDeps({ syncEvents, readAllowance }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('mutated')
  })

  test('current SAC allowance mismatching the latest event amount forces unproven/mutated', async () => {
    const readAllowance = vi.fn(async () => ({ amount: 999n })) // disagrees with the event log
    const out = await proveCurrentAllowance(baseDeps({ readAllowance }))
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('mutated')
  })
})

describe('proveCurrentAllowance - multi-token budgets', () => {
  test('proves every budgeted token, one approval entry each', async () => {
    const twoTokenReceipt = receipt({
      allowanceBudgets: [
        { token: TOKEN, units: '100000000', decimals: 7 },
        { token: TOKEN_2, units: '50000000', decimals: 7 },
      ],
    })
    const syncEvents = vi.fn(async ({ token }) => ({
      approvals: [
        token === TOKEN
          ? ownApproval()
          : ownApproval({ amount: 50_000_000n, ledger: 1000, eventIndex: 0 }),
      ],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const readAllowance = vi.fn(async ({ token }) =>
      token === TOKEN ? { amount: 100_000_000n } : { amount: 50_000_000n }
    )
    const out = await proveCurrentAllowance(
      baseDeps({ receipt: twoTokenReceipt, syncEvents, readAllowance })
    )
    expect(out.proven).toBe(true)
    expect(out.proof.approvals).toHaveLength(2)
    expect(out.proof.approvals.map((a) => a.amount.token).sort()).toEqual([TOKEN, TOKEN_2].sort())
  })

  test('one mutated token among several is enough to force the WHOLE proof unproven', async () => {
    const twoTokenReceipt = receipt({
      allowanceBudgets: [
        { token: TOKEN, units: '100000000', decimals: 7 },
        { token: TOKEN_2, units: '50000000', decimals: 7 },
      ],
    })
    const syncEvents = vi.fn(async ({ token }) => ({
      approvals: [
        token === TOKEN
          ? ownApproval()
          : ownApproval({ amount: 999n, ledger: 1000, eventIndex: 0 }), // mismatched vs budget
      ],
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      gapFree: true,
    }))
    const readAllowance = vi.fn(async ({ token }) =>
      token === TOKEN ? { amount: 100_000_000n } : { amount: 999n }
    )
    const out = await proveCurrentAllowance(
      baseDeps({ receipt: twoTokenReceipt, syncEvents, readAllowance })
    )
    expect(out.proven).toBe(false)
    expect(out.reason).toBe('mutated')
  })
})

describe('computeProofHash', () => {
  test('is deterministic and excludes its own proofHash field (self-referential)', () => {
    const proof = {
      version: 1,
      owner: OWNER,
      router: ROUTER,
      network: 'stellar-testnet',
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      latestLedger: 1000,
      gapFree: true,
      noLaterMutation: true,
      approvals: [
        {
          amount: { token: TOKEN, units: '1', decimals: 7 },
          expiryLedger: 1,
          ledger: 1,
          txHash: 'H',
          eventIndex: 0,
        },
      ],
      proofHash: 'whatever-was-here-before',
    }
    const h1 = computeProofHash(proof)
    const h2 = computeProofHash({ ...proof, proofHash: 'something-completely-different' })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('changes when proof content changes', () => {
    const proof = {
      version: 1,
      owner: OWNER,
      router: ROUTER,
      network: 'stellar-testnet',
      indexedFromLedger: 1000,
      indexedThroughLedger: 1000,
      latestLedger: 1000,
      gapFree: true,
      noLaterMutation: true,
      approvals: [],
      proofHash: null,
    }
    expect(computeProofHash(proof)).not.toBe(computeProofHash({ ...proof, latestLedger: 1001 }))
  })
})

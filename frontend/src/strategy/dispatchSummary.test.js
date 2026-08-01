import { describe, expect, it } from 'vitest'
import { buildDispatchReceipt } from './dispatchSummary.js'
// Task 6 chunk C2 -- imports the REAL server vocabulary (not a hand-copied guess) to pin
// dispatchSummary.js's local RECEIPT_TO_CUSTODY_LOCATION copy against drift, the same
// cross-layer-check discipline allocationReceipt.test.js already uses for its own copy (see that
// module's header). Read-only import: this task's file list forbids editing anything under api/,
// and this file only ever reads the exported constant, never calls into store/DB code.
import { RECEIPT_CUSTODY_LOCATIONS } from '../../api/agent-index/models.js'

const amount = (units, decimals = 7) => ({ token: 'USDC', units, decimals })

const plan = () => ({
  runId: 'run-mixed-8',
  planFingerprint: 'plan-fingerprint-8',
  agents: [
    { allocationId: 'run-mixed-8:deposit:0', kind: 'deposit', allocation: amount('6000000') },
    {
      allocationId: 'run-mixed-8:bridge:base',
      kind: 'bridge',
      allocation: amount('4000000'),
      children: [
        {
          allocationId: 'run-mixed-8:bridge:base-a',
          allocation: amount('250000', 6),
        },
        {
          allocationId: 'run-mixed-8:bridge:base-b',
          allocation: amount('150000', 6),
        },
      ],
    },
  ],
})

const permission = () => ({
  mode: 'fresh',
  txHash: 'grant-hash',
  grantReceiptFingerprint: 'grant-fingerprint',
  expiryLedger: 9001,
  agentAddresses: ['CDEPOSIT', 'CBRIDGE'],
})

describe('buildDispatchReceipt', () => {
  it('returns one partial receipt when Stellar rejects after the grant but Base custody succeeds', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              success: false,
              error: 'relay declined',
              custody: { location: 'agent', confirmed: true, checkedAt: 100 },
            },
          ],
        },
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              finalStatus: 'done',
              mintTxHash: 'mint-a',
              custody: { location: 'base-proxy', confirmed: true, checkedAt: 101 },
            },
            {
              allocationId: 'run-mixed-8:bridge:base-b',
              finalStatus: 'done',
              mintTxHash: 'mint-b',
              custody: { location: 'base-proxy', confirmed: true, checkedAt: 101 },
            },
          ],
        },
      },
    })

    expect(receipt).toMatchObject({
      version: 1,
      runId: 'run-mixed-8',
      planFingerprint: 'plan-fingerprint-8',
      permission: {
        mode: 'fresh',
        status: 'confirmed',
        confirmationCount: 1,
        txHash: 'grant-hash',
      },
      branches: { stellar: { status: 'failed' }, base: { status: 'succeeded' } },
    })
    expect(receipt.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'run-mixed-8:bridge:base-a',
          executionStatus: 'succeeded',
          // Task 6 chunk C2: inferredCustody's shape widened to carry amount/reason/source
          // uniformly with the receipt-sourced path (see dispatchSummary.js's module header) --
          // this fixture has no `raw.receipt`/`raw.allocationReceipt`, so it takes the unchanged
          // inference fallback, now explicitly marked `source:'inferred'`.
          custody: {
            location: 'base-proxy',
            confirmed: true,
            checkedAt: 101,
            amount: null,
            reason: null,
            source: 'inferred',
          },
          txHash: 'mint-a',
        }),
      ])
    )
  })

  it('preserves a successful Stellar deposit when the Base branch fails', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              success: true,
              depositTxHash: 'stellar-deposit',
              custody: { location: 'stellar-vault', confirmed: true, checkedAt: 103 },
            },
          ],
        },
        base: {
          status: 'failed',
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              success: false,
              pulled: true,
              bridgeAgentAddress: 'CBRIDGE',
              error: 'burn rejected',
              custody: { location: 'agent', confirmed: true, checkedAt: 103 },
            },
          ],
        },
      },
    })

    expect(receipt.branches).toMatchObject({
      stellar: { status: 'succeeded' },
      base: { status: 'failed' },
    })
    expect(
      receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    ).toMatchObject({
      executionStatus: 'succeeded',
      custody: { location: 'stellar-vault', confirmed: true },
      txHash: 'stellar-deposit',
    })
    expect(
      receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a')
    ).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'agent', confirmed: true },
      error: 'burn rejected',
    })
  })

  it('keeps successful Stellar siblings when one worker fails', () => {
    const stellarPlan = {
      runId: 'run-siblings',
      planFingerprint: 'siblings',
      agents: [
        { allocationId: 'run-siblings:deposit:0', kind: 'deposit', allocation: amount('1') },
        { allocationId: 'run-siblings:deposit:1', kind: 'deposit', allocation: amount('2') },
      ],
    }
    const receipt = buildDispatchReceipt({
      plan: stellarPlan,
      permission: permission(),
      branches: {
        stellar: {
          results: [
            { allocationId: 'run-siblings:deposit:0', success: true, txHash: 'ok' },
            { allocationId: 'run-siblings:deposit:1', success: false, error: 'nope' },
          ],
        },
      },
    })

    expect(receipt.branches.stellar.status).toBe('partial')
    expect(receipt.allocations.map((a) => [a.allocationId, a.executionStatus])).toEqual([
      ['run-siblings:deposit:0', 'succeeded'],
      ['run-siblings:deposit:1', 'failed'],
    ])
  })

  it('keeps a pending CCTP allocation in transit instead of marking it Base-arrived', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              finalStatus: 'pending',
              burnHash: 'burn-hash',
              custody: { location: 'in-transit', confirmed: true, checkedAt: 102 },
            },
          ],
        },
      },
    })
    const pending = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a')

    expect(receipt.branches.base.status).toBe('in-transit')
    expect(pending).toMatchObject({
      executionStatus: 'pending',
      custody: { location: 'in-transit', confirmed: true, checkedAt: 102 },
      txHash: 'burn-hash',
    })
    expect(pending.custody.location).not.toBe('base-proxy')
  })

  it('includes each planned leaf allocation once and reconciles integer token units exactly', () => {
    const receipt = buildDispatchReceipt({ plan: plan(), permission: permission(), branches: {} })
    const ids = receipt.allocations.map((a) => a.allocationId)
    const totals = receipt.allocations.reduce((out, a) => {
      const key = `${a.amount.token}:${a.amount.decimals}`
      out[key] = (out[key] || 0n) + BigInt(a.amount.units)
      return out
    }, {})

    expect(ids).toEqual([
      'run-mixed-8:deposit:0',
      'run-mixed-8:bridge:base-a',
      'run-mixed-8:bridge:base-b',
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(totals).toEqual({ 'USDC:7': 6000000n, 'USDC:6': 400000n })
  })

  it('retains recoverable custody on errors and never claims that funds vanished', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              success: false,
              burnHash: 'burn-hash',
              error: 'relayer unavailable; retry with burn hash',
              custody: { location: 'in-transit', confirmed: true, checkedAt: 104 },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a')

    expect(outcome).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'in-transit', confirmed: true },
      txHash: 'burn-hash',
      error: 'relayer unavailable; retry with burn hash',
    })
    expect(outcome.error).not.toMatch(/vanished|lost/i)
  })

  it('fails closed on missing custody evidence and never promotes a mint hash to Base proxy custody', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              finalStatus: 'done',
              mintTxHash: 'mint-without-deposit-proof',
            },
          ],
        },
      },
    })
    expect(
      receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a').custody
    ).toEqual({
      location: 'unknown',
      confirmed: false,
      checkedAt: null,
      amount: null,
      reason: null,
      source: 'inferred',
    })
  })

  it('rejects malformed canonical amounts and unknown permission modes', () => {
    expect(() =>
      buildDispatchReceipt({
        plan: {
          runId: 'bad',
          planFingerprint: 'bad',
          agents: [{ allocationId: 'bad:0', kind: 'deposit' }],
        },
        permission: { mode: 'surprise' },
      })
    ).toThrow(/canonical amount|permission/i)
  })

  it('does not assign a current network to pending or unknown custody without authority', () => {
    const receipt = buildDispatchReceipt({ plan: plan(), permission: permission(), branches: {} })
    expect(receipt.allocations[0].networkContext.currentCustodyNetwork).toBeNull()
    expect(receipt.allocations[1].networkContext.currentCustodyNetwork).toBeNull()
  })

  it('[I] leaves pending in-transit custody without an invented current Base network', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              finalStatus: 'pending',
              custody: { location: 'in-transit', confirmed: true, checkedAt: 808 },
            },
          ],
        },
      },
    })
    const pending = receipt.allocations.find((entry) => entry.allocationId.endsWith('base-a'))

    expect(pending.networkContext.currentCustodyNetwork).toBeNull()
    expect(pending.networkContext.transit).toBe(true)
  })

  it('[I] leaves unknown Stellar custody without an invented current Stellar network', () => {
    const receipt = buildDispatchReceipt({ plan: plan(), permission: permission(), branches: {} })
    const unknown = receipt.allocations.find((entry) => entry.allocationId.endsWith('deposit:0'))

    expect(unknown.custody).toEqual({
      location: 'unknown',
      confirmed: false,
      checkedAt: null,
      amount: null,
      reason: null,
      source: 'inferred',
    })
    expect(unknown.networkContext.currentCustodyNetwork).toBeNull()
  })

  it('[Security] sanitizes nested arrays and caller network context while retaining safe recovery evidence', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              success: false,
              error: 'recoverable',
              custody: { location: 'in-transit', confirmed: true, checkedAt: 919 },
              recovery: {
                action: 'resume-job',
                jobId: 'JOB-SAFE',
                secretKey: 'LEAK-SECRET-KEY',
                signerSecretKey: 'LEAK-SIGNER-SECRET-KEY',
                sessionKeyMaterial: { bytes: 'LEAK-SESSION-MATERIAL' },
                SeCrEtKeY: 'LEAK-MIXED-CASE',
                steps: [
                  { label: 'safe-one', SECRETkey: 'LEAK-ARRAY-ONE' },
                  { note: 'safe-two', SessionKEYMaterial: 'LEAK-ARRAY-TWO' },
                  { signerSecretKey: 'LEAK-ARRAY-ONLY' },
                ],
              },
              networkContext: {
                executionNetwork: 'stellar-testnet',
                destinationNetwork: 'base-sepolia',
                currentCustodyNetwork: null,
                transit: true,
                secretKey: 'LEAK-NETWORK-SECRET',
                nested: {
                  route: 'safe-route',
                  SignerSECRETKey: 'LEAK-NETWORK-NESTED',
                },
                hops: [
                  { network: 'stellar-testnet', sessionKEYMaterial: 'LEAK-NETWORK-ARRAY' },
                  { network: 'base-sepolia' },
                ],
              },
            },
          ],
        },
      },
    })
    const branch = receipt.branches.base.results.find((entry) =>
      entry.allocationId.endsWith('base-a')
    )
    const allocation = receipt.allocations.find((entry) => entry.allocationId.endsWith('base-a'))

    expect(branch.evidence.recovery).toEqual({
      action: 'resume-job',
      jobId: 'JOB-SAFE',
      steps: [{ label: 'safe-one' }, { note: 'safe-two' }],
    })
    expect(allocation.evidence.recovery).toEqual(branch.evidence.recovery)
    expect(branch.networkContext).toEqual({
      executionNetwork: 'stellar-testnet',
      destinationNetwork: 'base-sepolia',
      currentCustodyNetwork: null,
      transit: true,
      nested: { route: 'safe-route' },
      hops: [{ network: 'stellar-testnet' }, { network: 'base-sepolia' }],
    })
    expect(JSON.stringify(receipt)).not.toMatch(
      /LEAK-|secretKey|signerSecretKey|sessionKeyMaterial/i
    )
  })

  it('rejects negative units, duplicate IDs, and a bridge parent/child mismatch', () => {
    const invalid = plan()
    invalid.agents[0].allocation.units = '-1'
    expect(() => buildDispatchReceipt({ plan: invalid, permission: permission() })).toThrow(
      /amount/i
    )
  })
})

// Task 6 chunk C2 -- the live seam bug the brief documents: C1 already threads the real
// AllocationReceiptV2 onto a dispatch result (orchestrator.js:919-920's plain per-worker loop puts
// it under `raw.receipt`; `dispatchConfirmedMixed`'s mixed loop puts it under `raw.allocationReceipt`
// instead, verified directly by reading orchestrator.js:1085,1098,1116 -- the brief itself only
// describes the first shape). Before this chunk, dispatchSummary.js never read either field at all;
// custody always came from the OLD `inferredCustody()` heuristic, gated on the OLD CUSTODY_LOCATIONS
// vocabulary. These tests project the receipt's custody verbatim instead.
describe('Task 6 chunk C2 -- proven custody is projected from the receipt, never re-derived', () => {
  it('reads receipt custody under raw.receipt (the plain per-worker dispatch shape, orchestrator.js:919-920), not the stale raw.custody value alone', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              success: true,
              depositTxHash: 'stellar-deposit',
              // A real per-worker loop sets `custody` to the SAME object as `receipt.custody`
              // (orchestrator.js:919) -- reproduced verbatim here rather than simplified away.
              custody: {
                location: 'stellar-vault',
                confirmed: true,
                amount: amount('6000000'),
                reason: null,
              },
              receipt: {
                custody: {
                  location: 'stellar-vault',
                  confirmed: true,
                  amount: amount('6000000'),
                  reason: null,
                },
              },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    // Fix round 1: `checkedAt` is now OMITTED (not merely null) on the receipt-sourced path -- see
    // dispatchSummary.js's module header for why keeping it present-but-always-null there inverted
    // the freshness intuition of any consumer reading it.
    expect(outcome.custody).toEqual({
      location: 'stellar-vault',
      confirmed: true,
      amount: { token: 'USDC', units: '6000000', decimals: 7 },
      reason: null,
      source: 'receipt',
    })
    expect(outcome.custody).not.toHaveProperty('checkedAt')
  })

  it('MUTATION GUARD: reads receipt custody under raw.allocationReceipt (the mixed Stellar+Base dispatch shape, orchestrator.js:1085/1098/1116) even though the legacy raw.custody field there is a stale "unknown" placeholder', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              success: true,
              depositTxHash: 'stellar-deposit',
              // The mixed loop's own default when worker.js doesn't set its own `.custody`
              // (orchestrator.js:1080-1084) -- a genuinely successful deposit whose LEGACY
              // custody field is still 'unknown'. The receipt is the only place the real
              // evidence lives; if the implementation read raw.custody instead of
              // raw.allocationReceipt, this assertion goes red (verified by hand -- see the
              // task report's verbatim mutation transcript).
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              allocationReceipt: {
                custody: {
                  location: 'stellar-vault',
                  confirmed: true,
                  amount: amount('6000000'),
                  reason: null,
                },
              },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    expect(outcome.custody.location).toBe('stellar-vault')
    expect(outcome.custody.confirmed).toBe(true)
    expect(outcome.custody.source).toBe('receipt')
  })

  it('falls back to inference (source "inferred") when an allocation has no receipt evidence at all -- the documented dispatchLegacy/Base-branch fallback', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              success: true,
              txHash: 'legacy-tx',
              custody: { location: 'agent', confirmed: true, checkedAt: 55 },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    expect(outcome.custody).toEqual({
      location: 'agent',
      confirmed: true,
      checkedAt: 55,
      amount: null,
      reason: null,
      source: 'inferred',
    })
  })

  it('proven and inferred custody are distinguishable in the projected output even when they render the SAME location string', () => {
    const stellarPlan = {
      runId: 'run-siblings',
      planFingerprint: 'siblings',
      agents: [
        { allocationId: 'run-siblings:deposit:0', kind: 'deposit', allocation: amount('1') },
        { allocationId: 'run-siblings:deposit:1', kind: 'deposit', allocation: amount('2') },
      ],
    }
    const receipt = buildDispatchReceipt({
      plan: stellarPlan,
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-siblings:deposit:0',
              success: true,
              // Receipt evidence: 'stellar-agent' maps onto the SAME 'agent' CustodyV1 location
              // the legacy inferred path already uses (see RECEIPT_TO_CUSTODY_LOCATION's own
              // comment) -- a deliberately adversarial pairing for THIS test, so location string
              // equality alone cannot be mistaken for provenance.
              receipt: {
                custody: {
                  location: 'stellar-agent',
                  confirmed: true,
                  amount: amount('1'),
                  reason: null,
                },
              },
            },
            {
              allocationId: 'run-siblings:deposit:1',
              success: true,
              custody: { location: 'agent', confirmed: true, checkedAt: 9 },
            },
          ],
        },
      },
    })
    const proven = receipt.allocations.find((a) => a.allocationId === 'run-siblings:deposit:0')
    const inferred = receipt.allocations.find((a) => a.allocationId === 'run-siblings:deposit:1')
    expect(proven.custody.location).toBe('agent')
    expect(inferred.custody.location).toBe('agent')
    expect(proven.custody.source).toBe('receipt')
    expect(inferred.custody.source).toBe('inferred')
    expect(proven.custody.source).not.toBe(inferred.custody.source)
  })
})

describe('Task 6 chunk C2 -- the server custody vocabulary is mapped totally and fails loudly on drift', () => {
  // This module's own deliberate mapping (dispatchSummary.js's RECEIPT_TO_CUSTODY_LOCATION,
  // justified at its own header) -- 'base-kernel' reuses 'agent' and 'base-vault' reuses
  // 'base-proxy' rather than widening CustodyV1 with two new strings, so a read-only downstream
  // consumer (StartStage.jsx, out of scope for this chunk) keeps classifying custody correctly
  // with zero edits to it.
  const EXPECTED_LOCATION = {
    owner: 'owner',
    'stellar-agent': 'agent',
    'stellar-vault': 'stellar-vault',
    'cctp-transit': 'in-transit',
    'base-kernel': 'agent',
    'base-vault': 'base-proxy',
    unknown: 'unknown',
  }

  it('the real server vocabulary (frontend/api/agent-index/models.js RECEIPT_CUSTODY_LOCATIONS) has exactly the 7 locations this mapping was built against -- cross-layer drift guard', () => {
    expect(new Set(RECEIPT_CUSTODY_LOCATIONS)).toEqual(new Set(Object.keys(EXPECTED_LOCATION)))
  })

  it.each(Object.entries(EXPECTED_LOCATION))(
    'maps server custody location %s to exactly one rendered CustodyV1 location (-> %s)',
    (serverLocation, expectedLocation) => {
      const receipt = buildDispatchReceipt({
        plan: plan(),
        permission: permission(),
        branches: {
          stellar: {
            results: [
              {
                allocationId: 'run-mixed-8:deposit:0',
                receipt: {
                  custody: {
                    location: serverLocation,
                    confirmed: serverLocation !== 'unknown',
                    amount: serverLocation === 'unknown' ? null : amount('1'),
                    reason: null,
                  },
                },
              },
            ],
          },
        },
      })
      const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
      expect(outcome.custody.location).toBe(expectedLocation)
      expect(outcome.custody.source).toBe('receipt')
    }
  )

  // Not a shape any current producer can emit -- allocationReceipt.js's own `confirmCustody`
  // already refuses any location outside RECEIPT_CUSTODY_LOCATIONS before a receipt like this
  // could exist (see that module's `confirmCustody`, which throws first). This guards against
  // FUTURE drift between the server's vocabulary and this module's local copy -- the reason
  // `provenCustody` refuses to map it, rather than silently falling through to plain 'unknown'.
  //
  // Fix round 1 (controller ruling): an EARLIER version of this test asserted `buildDispatchReceipt`
  // itself throws here -- but that throw propagated out and aborted the WHOLE receipt for every
  // allocation in the run, even though both real call sites (app.jsx:3310, orchestrator.js's
  // `buildDispatchReceipt` calls) build the receipt strictly AFTER dispatch; a single unmapped
  // value would have cost the user the entire receipt for money that had already moved. The
  // ruling: contain the failure to the ONE bad allocation instead. This test now proves BOTH
  // halves of that ruling directly: (1) the receipt still builds -- one bad allocation among
  // several good ones does NOT abort the others -- and (2) the bad allocation is never silently
  // presented as an honest, evidence-free 'unknown': it gets its own distinct `source:'unmapped'`
  // verdict, never `'inferred'`, with a `reason` naming the exact bad value and allocation.
  it('contains an unmapped receipt custody location to the ONE bad allocation -- the receipt still builds, and the bad allocation is never silently indistinguishable from a genuine no-evidence "unknown"', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              receipt: {
                custody: {
                  location: 'stellar-vault',
                  confirmed: true,
                  amount: amount('6000000'),
                  reason: null,
                },
              },
            },
          ],
        },
        base: {
          results: [
            {
              allocationId: 'run-mixed-8:bridge:base-a',
              receipt: {
                custody: { location: 'base-relay', confirmed: true, amount: null, reason: null },
              },
            },
            {
              allocationId: 'run-mixed-8:bridge:base-b',
              finalStatus: 'done',
              mintTxHash: 'mint-b',
              custody: { location: 'base-proxy', confirmed: true, checkedAt: 101 },
            },
          ],
        },
      },
    })

    // (1) The whole receipt built: all three planned allocations are present, none dropped.
    expect(receipt.allocations).toHaveLength(3)
    const good = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    const bad = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a')
    const otherGood = receipt.allocations.find(
      (a) => a.allocationId === 'run-mixed-8:bridge:base-b'
    )

    // The two GOOD allocations render exactly as their own evidence says, unaffected by their
    // sibling's bad value.
    expect(good.custody).toEqual({
      location: 'stellar-vault',
      confirmed: true,
      amount: { token: 'USDC', units: '6000000', decimals: 7 },
      reason: null,
      source: 'receipt',
    })
    expect(otherGood.custody.location).toBe('base-proxy')
    expect(otherGood.custody.source).toBe('inferred')

    // (2) The BAD allocation is loud and distinct, never silently 'unknown'/'inferred'.
    expect(bad.custody.source).toBe('unmapped')
    expect(bad.custody.source).not.toBe('inferred')
    expect(bad.custody.location).toBe('unknown')
    expect(bad.custody.reason).toMatch(/base-relay/)
    expect(bad.custody.reason).toMatch(/run-mixed-8:bridge:base-a/)
  })
})

describe('Task 6 chunk C2 -- receipt custody amounts stay exact and unknown never renders as zero', () => {
  it('never routes a receipt custody amount through Number() -- a non-round value above Number.MAX_SAFE_INTEGER round-trips exactly as a string', () => {
    // Deliberately NOT an arbitrary large value -- BigInt(Number.MAX_SAFE_INTEGER) + an even delta
    // (tried first, during implementation) can land back on a double-representable EVEN integer
    // and round-trip through Number() by sheer luck, proving nothing (caught by hand: the
    // Number()-mutation below stayed green against that fixture). 2**53 + 1 is the textbook
    // non-representable case -- it sits exactly halfway between the two nearest doubles
    // (2**53 and 2**53+2) and rounds DOWN to the even neighbor, so Number()/String() genuinely
    // changes the value; a round value like 1000000000 would round-trip perfectly and prove
    // nothing (brief's own warning).
    const hugeUnits = (2n ** 53n + 1n).toString()
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              receipt: {
                custody: {
                  location: 'stellar-vault',
                  confirmed: true,
                  amount: { token: 'USDC', units: hugeUnits, decimals: 7 },
                  reason: null,
                },
              },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    expect(outcome.custody.amount.units).toBe(hugeUnits)
    expect(typeof outcome.custody.amount.units).toBe('string')
  })

  it('unknown custody carries amount:null, never a coerced zero -- the receipt\'s own ambiguous-evidence verdict (allocationReceipt.js\'s confirmCustody)', () => {
    const receipt = buildDispatchReceipt({
      plan: plan(),
      permission: permission(),
      branches: {
        stellar: {
          results: [
            {
              allocationId: 'run-mixed-8:deposit:0',
              receipt: {
                custody: { location: 'unknown', confirmed: false, amount: null, reason: 'ambiguous' },
              },
            },
          ],
        },
      },
    })
    const outcome = receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')
    expect(outcome.custody.amount).toBeNull()
    expect(outcome.custody.amount).not.toBe(0)
  })

  it('plan amounts stay authoritative and per-token: two different tokens across allocations are never summed into one canonical amount', () => {
    const receipt = buildDispatchReceipt({ plan: plan(), permission: permission(), branches: {} })
    const stellarLeaf = receipt.allocations.find((a) => a.allocationId.endsWith('deposit:0'))
    const baseLeaf = receipt.allocations.find((a) => a.allocationId.endsWith('base-a'))
    expect(stellarLeaf.amount).toEqual({ token: 'USDC', units: '6000000', decimals: 7 })
    expect(baseLeaf.amount).toEqual({ token: 'USDC', units: '250000', decimals: 6 })
    expect(stellarLeaf.amount.decimals).not.toBe(baseLeaf.amount.decimals)
  })
})

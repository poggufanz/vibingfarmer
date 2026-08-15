// frontend/src/components/strategy/StrategyReceipt.test.jsx
// Strategy Task 12 (Pocket Crew redesign, Wave 5). The custody receipt renders ONLY from an
// already-built DispatchReceiptV1 (frontend/src/strategy/dispatchSummary.js's buildDispatchReceipt)
// -- every fixture below matches that producer's REAL output shape exactly (verified by reading
// dispatchSummary.js directly, including its own test file's fixtures), never a shape the real
// producer cannot emit.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StrategyReceipt, reconcileAllocations } from './StrategyReceipt.jsx'
import { buildDispatchReceipt } from '../../strategy/dispatchSummary.js'
import {
  appendPhase,
  confirmCustody,
  createAllocationReceipt,
} from '../../strategy/allocationReceipt.js'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

expect.extend(axeMatchers)

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const NOW = 1_800_000_000
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
// Real-LENGTH identifiers (a Stellar account is 56 chars, a tx hash is 64 hex chars) -- a short
// placeholder like '0xdep1'/'CDEPOSIT1' would fit at 320px regardless of whether overflow-wrap is
// present, making a 320px guard built on it unable to see its own regression (verified directly:
// the guard below stayed green even after temporarily deleting the overflow-wrap rule, until these
// fixtures were lengthened to real size).
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const REAL_TX_HASH = 'a1b2c3d4'.repeat(8)
const REAL_GRANT_HASH = 'e5f6a7b8'.repeat(8) // distinct from REAL_TX_HASH so link queries stay unambiguous

function alloc(over) {
  return {
    allocationId: 'a',
    amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
    networkContext: {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: 'stellar-testnet',
      transit: false,
    },
    executionStatus: 'succeeded',
    custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW, source: 'receipt' },
    txHash: REAL_TX_HASH,
    error: null,
    evidence: {},
    ...over,
  }
}

function receiptProvenAlloc(over) {
  return alloc({
    custody: {
      location: 'stellar-vault',
      confirmed: true,
      source: 'receipt',
      amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
    },
    ...over,
  })
}

function receipt(allocations, over = {}) {
  return {
    version: 1,
    runId: 'run-1',
    planFingerprint: '0xplan1',
    permission: {
      mode: 'fresh',
      status: 'confirmed',
      confirmationCount: 1,
      txHash: REAL_GRANT_HASH,
      grantReceiptFingerprint: '0xreceiptfp',
      expiryLedger: 9001,
      agentAddresses: [AGENT_1],
    },
    branches: {
      stellar: { status: 'succeeded', results: allocations },
      base: { status: 'not-planned', results: [] },
    },
    allocations,
    ...over,
  }
}

describe('reconcileAllocations (bigint, per-token, mutation-provable)', () => {
  it('deposited + inTransit + held + unmoved === total for a single-token group', () => {
    const groups = reconcileAllocations([
      alloc({
        allocationId: 'a',
        executionStatus: 'succeeded',
        amount: { token: TOKEN_ADDR, units: '500000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'b',
        executionStatus: 'failed',
        custody: { location: 'agent' },
        amount: { token: TOKEN_ADDR, units: '200000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'c',
        executionStatus: 'failed',
        custody: { location: 'unknown' },
        amount: { token: TOKEN_ADDR, units: '100000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'd',
        executionStatus: 'pending',
        custody: { location: 'in-transit' },
        amount: { token: TOKEN_ADDR, units: '50000000', decimals: 7 },
      }),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    expect(g.deposited).toBe(500000000n)
    expect(g.held).toBe(200000000n)
    expect(g.unmoved).toBe(100000000n)
    expect(g.inTransit).toBe(50000000n)
    expect(g.total).toBe(850000000n)
    expect(g.deposited + g.inTransit + g.held + g.unmoved).toBe(g.total)
  })

  it("never mixes two different tokens' units into one sum -- a 7dp Stellar unit and a 6dp Base unit stay in separate groups", () => {
    const groups = reconcileAllocations([
      alloc({ allocationId: 'a', amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 } }), // 100
      alloc({
        allocationId: 'b',
        amount: { token: BRIDGE_TOKEN_ADDR, units: '600000', decimals: 6 },
      }), // 0.6, different token
    ])
    expect(groups).toHaveLength(2)
    const stellar = groups.find((g) => g.token === TOKEN_ADDR)
    const base = groups.find((g) => g.token === BRIDGE_TOKEN_ADDR)
    expect(stellar.total).toBe(1000000000n)
    expect(base.total).toBe(600000n)
  })

  it('a not-started/unknown allocation with no other evidence lands in the conservative "unmoved" bucket', () => {
    const groups = reconcileAllocations([
      alloc({ executionStatus: 'unknown', custody: { location: 'unknown' } }),
    ])
    expect(groups[0].unmoved).toBe(1000000000n)
    expect(groups[0].deposited).toBe(0n)
  })

  // Mutation-proof guard (per the run's own standard): this exact assertion is what breaks if the
  // `held` term is dropped from the reconciliation sum. Verified red-then-green by hand during
  // implementation (see the task report for the actual command transcript); kept here as the
  // permanent regression guard.
  it('MUTATION GUARD: deposited+inTransit+held+unmoved reconciles to total for a mixed-outcome run', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        executionStatus: 'succeeded',
        amount: { token: TOKEN_ADDR, units: '300000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'b',
        executionStatus: 'pending',
        custody: { location: 'in-transit' },
        amount: { token: TOKEN_ADDR, units: '150000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'c',
        executionStatus: 'failed',
        custody: { location: 'agent' },
        amount: { token: TOKEN_ADDR, units: '90000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'd',
        executionStatus: 'failed',
        custody: { location: 'owner' },
        amount: { token: TOKEN_ADDR, units: '60000000', decimals: 7 },
      }),
    ]
    const expectedTotal = allocations.reduce((sum, a) => sum + BigInt(a.amount.units), 0n)
    const [g] = reconcileAllocations(allocations)
    expect(g.deposited + g.inTransit + g.held + g.unmoved).toBe(expectedTotal)
  })
})

describe('Task 4 -- source-backed receipt states', () => {
  it('shows Confirmed only for a receipt-proven allocation and keeps its allocation/run identity', () => {
    const allocation = alloc({
      allocationId: 'run-1:deposit:confirmed',
      custody: {
        location: 'stellar-vault',
        confirmed: true,
        source: 'receipt',
        amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
      },
    })
    render(
      <StrategyReceipt
        receipt={receipt([allocation])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Confirmed')).toBeTruthy()
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText('run-1:deposit:confirmed')).toBeTruthy()
    expect(screen.getByText('run-1')).toBeTruthy()
  })

  it('keeps partial success explicit and offers a safe next action', () => {
    const allocations = [
      alloc({ allocationId: 'run-1:deposit:ok' }),
      alloc({
        allocationId: 'run-1:deposit:held',
        executionStatus: 'failed',
        custody: { location: 'agent', confirmed: true, source: 'receipt' },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Some agents did not complete')).toBeTruthy()
    expect(screen.getByText(/Next safe action:/)).toBeTruthy()
    expect(screen.getByText(/Held:/)).toBeTruthy()
  })

  it('keeps in-transit money moving and does not report it as deposited', () => {
    const allocation = alloc({
      allocationId: 'run-1:bridge:transit',
      executionStatus: 'pending',
      custody: { location: 'in-transit', confirmed: false, source: 'receipt' },
    })
    render(
      <StrategyReceipt
        receipt={receipt([allocation])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Still in transit')).toBeTruthy()
    expect(screen.getByText(/In transit:/)).toBeTruthy()
    expect(screen.getByText(/Next safe action:/)).toBeTruthy()
    expect(screen.queryByText('Confirmed')).toBeNull()
  })

  it('distinguishes held funds from money that did not move', () => {
    const allocations = [
      alloc({
        allocationId: 'run-1:deposit:held',
        executionStatus: 'failed',
        custody: { location: 'agent', confirmed: true, source: 'receipt' },
      }),
      alloc({
        allocationId: 'run-1:deposit:owner',
        executionStatus: 'failed',
        custody: { location: 'owner', confirmed: true, source: 'receipt' },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText(/Held:/)).toBeTruthy()
    expect(screen.getByText(/Money did not move:/)).toBeTruthy()
  })

  it('keeps unknown reconciliation unavailable instead of turning it into zero or success', () => {
    const allocation = alloc({
      allocationId: 'run-1:deposit:unknown',
      executionStatus: 'unknown',
      custody: { location: 'unknown', confirmed: false, source: 'receipt' },
      txHash: null,
    })
    render(
      <StrategyReceipt
        receipt={receipt([allocation])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Receipt unavailable')).toBeTruthy()
    expect(screen.getByText(/Next safe action:/)).toBeTruthy()
    expect(screen.queryByText('Every agent completed')).toBeNull()
    expect(screen.queryByText(/0 USDC/)).toBeNull()
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('does not claim confirmed state when the caller run identity conflicts with the receipt', () => {
    const allocation = alloc({
      allocationId: 'run-1:deposit:0',
      custody: { location: 'stellar-vault', confirmed: true, source: 'receipt' },
    })
    render(
      <StrategyReceipt
        receipt={receipt([allocation])}
        runId="run-2"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.queryByText('Confirmed')).toBeNull()
    expect(screen.getByText('Receipt unavailable')).toBeTruthy()
  })

  it('fails closed when the caller omits the run identity', () => {
    render(
      <StrategyReceipt
        receipt={receipt([receiptProvenAlloc({ allocationId: 'run-1:deposit:missing-run' })])}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Receipt unavailable')).toBeTruthy()
    expect(screen.queryByText('Every agent completed')).toBeNull()
    expect(screen.queryByText('Confirmed')).toBeNull()
  })

  it('fails closed when the receipt omits its run identity', () => {
    render(
      <StrategyReceipt
        receipt={receipt([receiptProvenAlloc()], { runId: '' })}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Receipt unavailable')).toBeTruthy()
    expect(screen.queryByText('Every agent completed')).toBeNull()
    expect(screen.queryByText('Confirmed')).toBeNull()
  })

  it('does not claim every agent completed when succeeded outcomes lack receipt custody proof', () => {
    const unproven = alloc({
      allocationId: 'run-1:deposit:unproven',
      custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW },
    })
    render(
      <StrategyReceipt
        receipt={receipt([unproven])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Receipt unavailable')).toBeTruthy()
    expect(screen.queryByText('Every agent completed')).toBeNull()
    expect(screen.queryByText('Deposited')).toBeNull()
  })

  it.each([
    ['intermediary agent', { location: 'agent' }],
    ['unknown', { location: 'unknown' }],
    ['missing', {}],
  ])(
    'fails closed when a succeeded Stellar allocation has %s instead of terminal vault custody',
    (_label, locationFields) => {
      const allocation = alloc({
        allocationId: 'run-1:deposit:wrong-location',
        custody: { ...locationFields, confirmed: true, source: 'receipt' },
      })
      render(
        <StrategyReceipt
          receipt={receipt([allocation])}
          runId="run-1"
          onViewMoney={() => {}}
          onMakeAnotherDeposit={() => {}}
        />
      )
      expect(screen.getByText('Receipt unavailable')).toBeTruthy()
      expect(screen.queryByText('Every agent completed')).toBeNull()
      expect(screen.queryByText('Deposited')).toBeNull()
      expect(screen.queryByText('Confirmed')).toBeNull()
      cleanup()
    }
  )

  it('keeps a nominal total unavailable when one token group contains unknown reconciliation', () => {
    const allocations = [
      receiptProvenAlloc({
        allocationId: 'run-1:deposit:known',
        amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
      }),
      alloc({
        allocationId: 'run-1:bridge:unknown',
        amount: { token: BRIDGE_TOKEN_ADDR, units: '500000', decimals: 6 },
        executionStatus: 'unknown',
        custody: { location: 'unknown', confirmed: false, source: 'receipt' },
        txHash: null,
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(
      screen.getByText(/Nominal total \(assumes each token above is worth 1 USDC\): Unavailable/)
    ).toBeTruthy()
    expect(screen.queryByText(/Nominal total.*0\.5/)).toBeNull()
  })

  it('rejects the positional permission agent vector as an unbound identity', () => {
    render(
      <StrategyReceipt
        receipt={receipt([receiptProvenAlloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.queryByText(AGENT_1)).toBeNull()
  })

  it('renders a real buildDispatchReceipt fixture as confirmed only when its durable receipt proves custody', () => {
    const allocationId = 'run-real-receipt:deposit:0'
    const exactAmount = { token: TOKEN_ADDR, units: '1000000000', decimals: 7 }
    let durable = createAllocationReceipt({
      networkId: 'stellar-testnet',
      executionId: `run-real-receipt:exec:${allocationId}`,
      allocationId,
      owner: 'GOWNER',
      runId: 'run-real-receipt',
      worker: 'GWORKER',
      agent: AGENT_1,
      intent: { allocation: exactAmount },
      amount: exactAmount,
    })
    durable = appendPhase(durable, {
      attemptId: 'pull-confirmed',
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'pull-hash' },
      observedAt: NOW,
    })
    durable = confirmCustody(durable, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: exactAmount,
    })
    durable = appendPhase(durable, {
      attemptId: 'deposit-confirmed',
      phase: 'stellar_deposit',
      status: 'confirmed',
      evidence: { txHash: REAL_TX_HASH },
      observedAt: NOW + 1,
    })

    const projected = buildDispatchReceipt({
      plan: {
        runId: 'run-real-receipt',
        planFingerprint: 'real-receipt-fingerprint',
        agents: [{ allocationId, kind: 'deposit', allocation: exactAmount }],
      },
      permission: {
        mode: 'fresh',
        txHash: REAL_GRANT_HASH,
        grantReceiptFingerprint: 'real-receipt-grant',
        expiryLedger: 9001,
        agentAddresses: [AGENT_1],
      },
      branches: {
        stellar: {
          results: [{ allocationId, success: true, receipt: durable, depositTxHash: REAL_TX_HASH }],
        },
      },
    })

    render(
      <StrategyReceipt
        receipt={projected}
        runId="run-real-receipt"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Every agent completed')).toBeTruthy()
    expect(screen.getByText('Confirmed')).toBeTruthy()
  })
})

describe('StrategyReceipt -- exact amounts and nominal total (Step 3)', () => {
  it('displays the exact per-token deposited amount, never rounding into a blended figure when only one token exists', () => {
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('100 USDC')).toBeTruthy()
    expect(screen.queryByText(/Nominal total/)).toBeNull() // only one token group -- nothing to blend
  })

  it('shows a nominal blended total ONLY when explicitly labeled, and only when more than one token is present', () => {
    const allocations = [
      alloc({ allocationId: 'a', amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 } }),
      alloc({
        allocationId: 'b',
        amount: { token: BRIDGE_TOKEN_ADDR, units: '500000', decimals: 6 },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('100 USDC')).toBeTruthy()
    expect(screen.getByText('0.5 Circle USDC')).toBeTruthy()
    expect(
      screen.getByText(/Nominal total \(assumes each token above is worth 1 USDC\)/)
    ).toBeTruthy()
  })

  it('sums mixed-decimal nominal groups with exact bigint scaling and renders the canonical total', () => {
    const hugeUnits = '9007199254740993'
    const allocations = [
      alloc({
        allocationId: 'stellar-huge',
        amount: { token: TOKEN_ADDR, units: hugeUnits, decimals: 7 },
      }),
      alloc({
        allocationId: 'circle-huge',
        amount: { token: BRIDGE_TOKEN_ADDR, units: hugeUnits, decimals: 6 },
      }),
    ]

    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )

    expect(
      screen.getByText(
        'Nominal total (assumes each token above is worth 1 USDC): 9907919180.2150923 USDC'
      )
    ).toBeTruthy()
  })
})

describe('Task 13 -- real receipt producer to rendered custody', () => {
  it('renders agent-held custody from createAllocationReceipt through buildDispatchReceipt without a hand-built outcome', () => {
    const allocationId = 'run-producer-render:deposit:0'
    const exactAmount = { token: TOKEN_ADDR, units: '1000000000', decimals: 7 }
    let durable = createAllocationReceipt({
      networkId: 'stellar-testnet',
      executionId: `run-producer-render:exec:${allocationId}`,
      allocationId,
      owner: 'GOWNER',
      runId: 'run-producer-render',
      worker: 'GWORKER',
      agent: AGENT_1,
      intent: { allocation: exactAmount },
      amount: exactAmount,
    })
    durable = appendPhase(durable, {
      attemptId: 'pull-confirmed',
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'pull-hash' },
      observedAt: NOW,
    })
    durable = confirmCustody(durable, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: exactAmount,
    })
    durable = appendPhase(durable, {
      attemptId: 'deposit-failed',
      phase: 'stellar_deposit',
      status: 'failed',
      evidence: { reason: 'vault relay refused before submission' },
      observedAt: NOW + 1,
    })

    const projected = buildDispatchReceipt({
      plan: {
        runId: 'run-producer-render',
        planFingerprint: 'producer-render-fingerprint',
        agents: [{ allocationId, kind: 'deposit', allocation: exactAmount }],
      },
      permission: {
        mode: 'fresh',
        txHash: REAL_GRANT_HASH,
        grantReceiptFingerprint: 'producer-render-grant',
        expiryLedger: 9001,
        agentAddresses: [AGENT_1],
      },
      branches: {
        stellar: {
          results: [
            {
              allocationId,
              success: false,
              error: 'vault relay refused before submission',
              receipt: durable,
            },
          ],
        },
      },
    })

    render(
      <StrategyReceipt
        receipt={projected}
        runId="run-producer-render"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )

    expect(screen.getByText('Held: 100 USDC')).toBeTruthy()
    expect(screen.getByText(/custody: agent, 100 USDC \(receipt-confirmed\)/)).toBeTruthy()
    expect(screen.queryByText(/custody: owner/)).toBeNull()
  })
})

describe('StrategyReceipt -- token symbols never leak a raw 56-char contract address', () => {
  it('resolves the real Stellar contract addresses to human symbols', () => {
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(document.body.textContent).not.toContain(TOKEN_ADDR)
    expect(document.body.textContent).toContain('USDC')
  })
})

describe('StrategyReceipt -- reconciliation summary reflects real state', () => {
  it('shows "Every agent completed" only when nothing failed and nothing is pending', async () => {
    render(
      <StrategyReceipt
        receipt={receipt([receiptProvenAlloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Every agent completed')).toBeTruthy()
  })

  it('shows the partial-failure notice and NEVER "Every agent completed" when one allocation failed', () => {
    const allocations = [
      receiptProvenAlloc({ allocationId: 'a' }),
      alloc({ allocationId: 'b', executionStatus: 'failed', custody: { location: 'unknown' } }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Some agents did not complete')).toBeTruthy()
    expect(screen.queryByText('Every agent completed')).toBeNull()
  })

  it('shows a "still in transit" notice, never a failure notice, for a purely pending outcome', () => {
    const allocations = [alloc({ executionStatus: 'pending', custody: { location: 'in-transit' } })]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Still in transit')).toBeTruthy()
    expect(screen.queryByText('Some agents did not complete')).toBeNull()
  })
})

describe('StrategyReceipt -- optional attestation is separate and counts its own confirmation', () => {
  it('shows no attestation section at all when no allocation carries attestation evidence', () => {
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.queryByText('Attestation')).toBeNull()
  })

  it('shows its own distinct confirmation, never folded into the deposit summary, when attestation evidence exists', () => {
    const allocations = [
      receiptProvenAlloc({ allocationId: 'a', evidence: { attestation: { status: 'complete' } } }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(screen.getByText('Attestation')).toBeTruthy()
    expect(screen.getByText(/Confirmed for allocation a/)).toBeTruthy()
    expect(screen.getByText('Every agent completed')).toBeTruthy() // the two confirmations coexist, distinctly
  })
})

describe('Task 6 chunk C2 -- custody evidence is projected as evidence, never re-derived or silently zeroed', () => {
  // Fix round 1, Important finding 2: the PRIOR version of this test used a fixture no real
  // producer can emit -- `{location:'agent', confirmed:false, ...}`, commented as
  // allocationReceipt.js's own "ambiguous evidence" path. That is verifiably false:
  // `custodyAfterAmbiguousEvidence` (allocationReceipt.js:342-355) either keeps a PRIOR
  // `confirmed:true` custody intact (only `reason` changes) or resets fully to
  // `{location:'unknown', confirmed:false}` -- and `initialCustodyState` (:168-174) THROWS on any
  // non-'unknown' unconfirmed initial custody. `confirmed:false` at a non-'unknown' location is
  // therefore structurally unreachable; that prior test's own assertion
  // (`custody unknown (receipt-confirmed)`) locked in Important finding 1's bug rather than
  // guarding against it, and its second assertion (`queryByText(/stellar-vault/)` is null) passed
  // under any implementation and constrained nothing. Replaced with the producible combination the
  // review specified: `executionStatus` and `custody` are INDEPENDENTLY populated fields on
  // AllocationOutcomeV1 (dispatchSummary.js's `executionStatus()` derives from
  // raw.success/finalStatus/status; `custodyFor()`'s receipt path derives from a completely
  // separate `raw.receipt`/`raw.allocationReceipt` object) -- nothing in either function ties them
  // together, so a receipt confirming custody only at 'stellar-agent' (this module's 'agent') next
  // to an independently-reported 'succeeded' executionStatus is a real, structurally valid
  // combination this component must render exactly as given.
  it('renders custody exactly as supplied by the receipt -- never re-deriving location/confirmation from executionStatus, txHash, or any other field', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        executionStatus: 'succeeded',
        custody: {
          location: 'agent',
          confirmed: true,
          amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
          reason: null,
          source: 'receipt',
        },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    // A component that re-derived custody from `executionStatus:'succeeded'` (as the reconciliation
    // summary above does for its OWN, unrelated bucketing) would show 'stellar-vault' here, since
    // that is the location a genuinely completed Stellar deposit reaches. The supplied evidence
    // says 'agent' -- proving the render used exactly what was given, this assertion is real and
    // constraining, not merely non-null.
    expect(screen.getByText(/custody: agent, 100 USDC \(receipt-confirmed\)/)).toBeTruthy()
    expect(screen.queryByText(/custody: stellar-vault/)).toBeNull()
  })

  // Fix round 1, Important finding 1: `location` and `amount` are INDEPENDENT facts on CustodyV1 --
  // a confirmed, proven custody at a KNOWN, non-'unknown' location with NO amount evidence is real
  // and producible: allocationReceipt.js's `confirmCustody` omits `amount` whenever a caller does
  // (assertAmount(:120-121) returns null for a bare `{location, txSuccess, matchingEvent}` call
  // with no `amount` key at all, and `confirmCustody`'s own destructure (:391-397) defaults
  // `amount` to `null` when omitted). The PRIOR version of `custodyEvidenceText` branched on
  // `custody.amount == null` to decide whether to render "unknown," which silently erased this
  // proven LOCATION whenever its amount merely happened to be absent -- the exact silent-discard
  // defect this chunk exists to close (dispatchSummary.js:55, relocated into the view).
  it('renders the custody LOCATION even when amount is null -- amount and location are independent facts, and a proven location must never be presented as "unknown" for lack of an amount', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        executionStatus: 'succeeded',
        custody: {
          location: 'stellar-vault',
          confirmed: true,
          amount: null,
          reason: null,
          source: 'receipt',
        },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    expect(screen.getByText(/custody: stellar-vault \(receipt-confirmed\)/)).toBeTruthy()
    expect(screen.queryByText(/custody unknown/)).toBeNull()
  })

  it('renders an unmapped receipt custody location (dispatchSummary.js\'s source:"unmapped", the controller-ruled per-allocation fail-loud verdict) distinctly -- never indistinguishable from a genuine no-evidence "unknown"', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        executionStatus: 'failed',
        custody: {
          location: 'unknown',
          confirmed: false,
          amount: null,
          reason:
            'receipt custody location "base-relay" for allocation "a" is outside the server ' +
            'RECEIPT_CUSTODY_LOCATIONS vocabulary this module knows (client/server vocabulary ' +
            'drift) -- this allocation\'s custody could not be read; it is NOT a genuine "no ' +
            'evidence" verdict.',
          source: 'unmapped',
        },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    expect(
      screen.getByText(/custody evidence unreadable \(receipt custody location "base-relay"/)
    ).toBeTruthy()
    expect(screen.queryByText(/custody unknown \(/)).toBeNull()
  })

  it('distinguishes a proven (receipt-sourced) allocation from an inferred one in the rendered Technical details, even though both report the same custody location', () => {
    const allocations = [
      alloc({
        allocationId: 'proven-a',
        custody: {
          location: 'agent',
          confirmed: true,
          checkedAt: null,
          amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
          reason: null,
          source: 'receipt',
        },
      }),
      alloc({
        allocationId: 'inferred-b',
        custody: {
          location: 'agent',
          confirmed: true,
          checkedAt: NOW,
          amount: null,
          reason: null,
          source: 'inferred',
        },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    expect(screen.getByText(/custody: agent, 100 USDC \(receipt-confirmed\)/)).toBeTruthy()
    // Fix round 1: the inferred fixture here has a KNOWN location ('agent') with no amount --
    // Important finding 1's fix means this now correctly shows the location (amount clause simply
    // omitted), not "unknown." The distinguishing signal between the two allocations is the
    // provenance suffix, not whether a location renders at all.
    expect(screen.getByText(/custody: agent \(not receipt-confirmed\)/)).toBeTruthy()
  })

  it('renders unknown custody with amount:null as the literal word "unknown", never a coerced/defaulted zero', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        executionStatus: 'failed',
        custody: {
          location: 'unknown',
          confirmed: false,
          checkedAt: null,
          amount: null,
          reason: null,
          source: 'receipt',
        },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    // Scoped to the custody span itself -- the page legitimately shows "0 USDC" elsewhere (the
    // Deposited MoneyFigure for a failed, nothing-deposited allocation is correctly zero; that is
    // NOT the bug this test guards). The custody line must never coerce a null amount into that
    // same zero, so its OWN text is checked directly rather than searching the whole document.
    const custodyNote = screen.getByText(/custody unknown \(receipt-confirmed\)/)
    expect(custodyNote.textContent).not.toMatch(/0 USDC/)
  })
})

describe('StrategyReceipt -- actions are exactly "View my money" (primary) and "Make another deposit" (secondary)', () => {
  it('renders both, with the correct roles, and calls the right callback', () => {
    const onViewMoney = vi.fn()
    const onMakeAnotherDeposit = vi.fn()
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        runId="run-1"
        onViewMoney={onViewMoney}
        onMakeAnotherDeposit={onMakeAnotherDeposit}
      />
    )
    const primary = screen.getByRole('button', { name: 'View my money' })
    const secondary = screen.getByRole('button', { name: 'Make another deposit' })
    expect(primary.className).toContain('pc-button--primary')
    expect(secondary.className).toContain('pc-button--secondary')
    fireEvent.click(primary)
    expect(onViewMoney).toHaveBeenCalledTimes(1)
    fireEvent.click(secondary)
    expect(onMakeAnotherDeposit).toHaveBeenCalledTimes(1)
  })

  it('exposes the exact matching runId to the receipt (for My Money navigation)', () => {
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    const details = document.querySelector('.pc-technical-details summary')
    fireEvent.click(details)
    // Owner decision #19: the run id is now its own `.pc-technical` span (mono value, distinct from
    // the "Run: " label), so the whole line's text is split across two nodes -- getByText's default
    // node-text extraction only looks at an element's OWN direct text children, not a descendant
    // element's, so a regex spanning both sides of the split no longer matches any single node.
    // Matching the .pc-technical value directly, then checking its <p> ancestor's full text, proves
    // both halves render without depending on which element getByText happens to walk.
    const runValue = screen.getAllByText('run-1')[0]
    expect(runValue.classList.contains('pc-technical')).toBe(true)
    expect(runValue.closest('p').textContent).toBe('Run: run-1')
  })
})

describe('StrategyReceipt -- grant and branch explorer links stay inside Technical details', () => {
  it('the grant transaction link stays collapsed inside Technical details, without an unbound agent vector', () => {
    render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    // jsdom applies no layout/UA stylesheet, so a closed <details> body is still queryable -- the
    // real, testable claim is structural placement: every link lives INSIDE the technical-details
    // element, which itself starts closed (no `open` attribute).
    const disclosure = document.querySelector('.pc-technical-details')
    expect(disclosure.hasAttribute('open')).toBe(false)
    expect(disclosure.querySelectorAll('a').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('a')).toHaveLength(disclosure.querySelectorAll('a').length)
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    const grantLink = screen.getByRole('link', { name: REAL_GRANT_HASH })
    expect(grantLink.getAttribute('href')).toContain('stellar.expert')
    expect(screen.queryByRole('link', { name: AGENT_1 })).toBeNull()
  })

  it('a Base-side mint transaction links to Basescan, not stellar.expert', () => {
    const allocations = [
      alloc({
        allocationId: 'a',
        txHash: '0xmint-a',
        networkContext: {
          executionNetwork: 'stellar-testnet',
          destinationNetwork: 'base-sepolia',
          currentCustodyNetwork: 'base-sepolia',
          transit: false,
        },
        custody: { location: 'base-proxy', confirmed: true, checkedAt: NOW },
      }),
    ]
    render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    const link = screen.getByRole('link', { name: '0xmint-a' })
    expect(link.getAttribute('href')).toContain('sepolia.basescan.org')
  })
})

describe('StrategyReceipt -- no inline style/animation (rejection checklist item 6)', () => {
  it('the JSX source has zero inline style/animation', () => {
    const source = fs.readFileSync(path.resolve(here, './StrategyReceipt.jsx'), 'utf8')
    expect(source).not.toMatch(/style=/)
  })
})

describe('StrategyReceipt -- axe', () => {
  it('has zero violations on a fully-succeeded receipt', async () => {
    const { container } = render(
      <StrategyReceipt
        receipt={receipt([alloc()])}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on a partial-failure receipt with Technical details expanded', async () => {
    const allocations = [
      alloc({ allocationId: 'a' }),
      alloc({ allocationId: 'b', executionStatus: 'failed', custody: { location: 'agent' } }),
    ]
    const { container } = render(
      <StrategyReceipt
        receipt={receipt(allocations)}
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    expect(await axe(container)).toHaveNoViolations()
  })
})

// Real-layout 320px guard -- same mechanism as ProtectStage.test.jsx's guard (jsdom never runs
// layout: no scrollWidth, no grid-track sizing, no min-content). Launches a real Chromium binary
// against the REAL shipped style.css + pocket-crew.css + strategy.css.
const REAL_STYLESHEET = [
  fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8'),
  fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8'),
].join('\n')
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
<style>${REAL_STYLESHEET}</style>
</head><body>${bodyHtml}</body></html>`
}

const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

async function launchRealChromium() {
  const { chromium } = await import('playwright-core')
  let lastErr
  for (const executablePath of CHROMIUM_CANDIDATES) {
    if (executablePath && !fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`320px layout guard: no usable Chromium binary found (${lastErr?.message})`)
}

async function measureScrollWidthAt320(bodyHtml) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 320, height: 1400 })
    await page.setContent(buildLayoutHarnessHtml(bodyHtml))
    return await page.evaluate(() => document.documentElement.scrollWidth)
  } finally {
    await browser.close()
  }
}

describe('StrategyReceipt -- 320px real layout guard', () => {
  it('G: a fully-succeeded receipt with Technical details expanded (full agent address + tx hash visible) creates no horizontal overflow at 320px', async () => {
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <StrategyReceipt
            receipt={receipt([alloc()])}
            onViewMoney={() => {}}
            onMakeAnotherDeposit={() => {}}
          />
        </div>
      </div>
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)

  it('G: a mixed two-token partial-failure receipt (richest content: nominal total + held/unmoved rows + expanded technical details) creates no horizontal overflow at 320px', async () => {
    const allocations = [
      alloc({ allocationId: 'a', amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 } }),
      alloc({
        allocationId: 'b',
        amount: { token: BRIDGE_TOKEN_ADDR, units: '500000', decimals: 6 },
        executionStatus: 'failed',
        custody: { location: 'agent', confirmed: true, checkedAt: NOW },
        txHash: null,
        error: 'Base leg failed.',
      }),
    ]
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <StrategyReceipt
            receipt={receipt(allocations)}
            onViewMoney={() => {}}
            onMakeAnotherDeposit={() => {}}
          />
        </div>
      </div>
    )
    fireEvent.click(document.querySelector('.pc-technical-details summary'))
    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)
})

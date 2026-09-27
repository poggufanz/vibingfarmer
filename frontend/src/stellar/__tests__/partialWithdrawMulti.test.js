// P1 G7: proportional multi-agent partial withdraw — pure split math plus the relay-down
// contract: a down relay queues every leg as `unknown` (never a raw throw, never a false
// success) without submitting anything.
import { describe, test, expect, vi } from 'vitest'
import {
  planProportionalWithdraw,
  partialWithdrawMulti,
  relayUnreachableUnknown,
} from '../partialWithdraw.js'

const ownerBoundary = (owner = 'GOWNER', epoch = 1) => {
  const activeAccount = Object.freeze({ kind: 'G', address: owner, version: 1, epoch })
  return { activeAccount, getCurrentActiveAccount: () => activeAccount }
}

describe('planProportionalWithdraw', () => {
  const rows = [
    { address: 'CAGENT1', maxUnits: 100_000_000n }, // 10 USDC
    { address: 'CAGENT2', maxUnits: 50_000_000n }, // 5 USDC
  ]

  test('splits 25% proportionally with an exact total', () => {
    const plan = planProportionalWithdraw(rows, 2500)
    expect(plan.legs).toEqual([
      { agentAddress: 'CAGENT1', amountUnits: 25_000_000n },
      { agentAddress: 'CAGENT2', amountUnits: 12_500_000n },
    ])
    expect(plan.totalUnits).toBe(37_500_000n)
    expect(plan.skipped).toBe(0)
  })

  test('100% withdraws each agent max exactly (never above)', () => {
    const plan = planProportionalWithdraw(rows, 10000)
    for (const leg of plan.legs) {
      const max = rows.find((r) => r.address === leg.agentAddress).maxUnits
      expect(leg.amountUnits <= max).toBe(true)
    }
    expect(plan.totalUnits).toBe(150_000_000n)
  })

  test('floors dust shares to zero and counts them skipped, not submitted', () => {
    const plan = planProportionalWithdraw(
      [
        { address: 'CBIG', maxUnits: 100_000_000n },
        { address: 'CDUST', maxUnits: 0n },
        { address: 'CTINY', maxUnits: 3n },
      ],
      100 // 1%: 3n * 100 / 10000 = 0
    )
    expect(plan.legs).toEqual([{ agentAddress: 'CBIG', amountUnits: 1_000_000n }])
    expect(plan.skipped).toBe(2)
  })

  test('rejects an out-of-range percentage and an empty agent list', () => {
    expect(() => planProportionalWithdraw(rows, 0)).toThrow(/basis points/)
    expect(() => planProportionalWithdraw(rows, 10001)).toThrow(/basis points/)
    expect(() => planProportionalWithdraw(rows, 12.5)).toThrow(/basis points/)
    expect(() => planProportionalWithdraw([], 2500)).toThrow(/at least one agent/i)
  })
})

describe('relayUnreachableUnknown', () => {
  test('carries the unknown-submission shape with an honest nothing-submitted message', () => {
    const err = relayUnreachableUnknown()
    expect(err).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    expect(err.message).toMatch(/nothing was submitted/i)
    expect(err.message).toMatch(/unknown, never as success/i)
  })
})

describe('partialWithdrawMulti', () => {
  const legs = [
    { agentAddress: 'CAGENT1', amountUnits: 25_000_000n },
    { agentAddress: 'CAGENT2', amountUnits: 12_500_000n },
  ]

  test('relay down: every leg reports unknown, nothing submitted, no throw', async () => {
    const submitViaRelay = vi.fn()
    const ensureExitSignerFn = vi.fn()
    const partialWithdrawFn = vi.fn()
    const out = await partialWithdrawMulti({
      owner: 'GOWNER',
      legs,
      ...ownerBoundary(),
      deps: {
        getRelayerAddress: async () => null,
        ensureExitSignerFn,
        partialWithdrawFn,
        submitViaRelay,
      },
    })
    expect(out.results).toHaveLength(2)
    for (const r of out.results) {
      expect(r.ok).toBe(false)
      expect(r.error).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
      expect(r.error.message).toMatch(/nothing was submitted/i)
    }
    expect(out.queued).toHaveLength(2)
    expect(ensureExitSignerFn).not.toHaveBeenCalled()
    expect(partialWithdrawFn).not.toHaveBeenCalled()
    expect(submitViaRelay).not.toHaveBeenCalled()
  })

  test('happy path: exit signer ensured per leg, then each leg withdrawn in order', async () => {
    const order = []
    const out = await partialWithdrawMulti({
      owner: 'GOWNER',
      legs,
      ...ownerBoundary(),
      deps: {
        getRelayerAddress: async () => 'GRELAYER',
        ensureExitSignerFn: async ({ agentAddress }) => (order.push(`exit:${agentAddress}`), {}),
        partialWithdrawFn: async ({ agentAddress, amountUnits }) => (
          order.push(`wd:${agentAddress}`),
          {
            redeemed: amountUnits,
            redeemHash: `HR:${agentAddress}`,
            transferHash: `HT:${agentAddress}`,
            channel: 'relay',
          }
        ),
      },
    })
    expect(order).toEqual(['exit:CAGENT1', 'wd:CAGENT1', 'exit:CAGENT2', 'wd:CAGENT2'])
    expect(out.queued).toEqual([])
    expect(out.results.every((r) => r.ok)).toBe(true)
    expect(out.results[0]).toMatchObject({
      agentAddress: 'CAGENT1',
      transferHash: 'HT:CAGENT1',
      channel: 'relay',
    })
  })

  test('a mid-flow unknown on one leg is captured; the other legs still run', async () => {
    const unknown = Object.assign(new Error('Lost contact with the relay after submission.'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
    })
    const out = await partialWithdrawMulti({
      owner: 'GOWNER',
      legs,
      ...ownerBoundary(),
      deps: {
        getRelayerAddress: async () => 'GRELAYER',
        ensureExitSignerFn: async () => ({}),
        partialWithdrawFn: async ({ agentAddress, amountUnits }) => {
          if (agentAddress === 'CAGENT1') throw unknown
          return {
            redeemed: amountUnits,
            redeemHash: 'HR2',
            transferHash: 'HT2',
            channel: 'relay',
          }
        },
      },
    })
    expect(out.results[0]).toMatchObject({
      ok: false,
      agentAddress: 'CAGENT1',
      error: expect.objectContaining({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' }),
    })
    expect(out.results[1].ok).toBe(true)
    expect(out.queued).toHaveLength(1)
    expect(out.queued[0].agentAddress).toBe('CAGENT1')
  })

  test('an account switch aborts the whole run instead of becoming a leg result', async () => {
    const switched = Object.assign(new Error('account changed'), {
      code: 'ACTIVE_ACCOUNT_CHANGED',
    })
    await expect(
      partialWithdrawMulti({
        owner: 'GOWNER',
        legs,
        ...ownerBoundary(),
        deps: {
          getRelayerAddress: async () => 'GRELAYER',
          ensureExitSignerFn: async () => ({}),
          partialWithdrawFn: async () => {
            throw switched
          },
        },
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  test('an empty leg list throws before any relay read', async () => {
    const getRelayerAddress = vi.fn(async () => 'GRELAYER')
    await expect(
      partialWithdrawMulti({
        owner: 'GOWNER',
        legs: [],
        ...ownerBoundary(),
        deps: { getRelayerAddress },
      })
    ).rejects.toThrow(/at least one withdraw leg/i)
    expect(getRelayerAddress).not.toHaveBeenCalled()
  })
})

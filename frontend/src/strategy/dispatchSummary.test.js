import { describe, expect, it } from 'vitest'
import { buildDispatchReceipt } from './dispatchSummary.js'

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
      permission: { mode: 'fresh', status: 'confirmed', confirmationCount: 1, txHash: 'grant-hash' },
      branches: { stellar: { status: 'failed' }, base: { status: 'succeeded' } },
    })
    expect(receipt.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'run-mixed-8:bridge:base-a',
          executionStatus: 'succeeded',
          custody: { location: 'base-proxy', confirmed: true, checkedAt: 101 },
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

    expect(receipt.branches).toMatchObject({ stellar: { status: 'succeeded' }, base: { status: 'failed' } })
    expect(receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:deposit:0')).toMatchObject({
      executionStatus: 'succeeded',
      custody: { location: 'stellar-vault', confirmed: true },
      txHash: 'stellar-deposit',
    })
    expect(receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a')).toMatchObject({
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
    expect(receipt.allocations.find((a) => a.allocationId === 'run-mixed-8:bridge:base-a').custody).toEqual({
      location: 'unknown',
      confirmed: false,
      checkedAt: null,
    })
  })

  it('rejects malformed canonical amounts and unknown permission modes', () => {
    expect(() =>
      buildDispatchReceipt({
        plan: { runId: 'bad', planFingerprint: 'bad', agents: [{ allocationId: 'bad:0', kind: 'deposit' }] },
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

    expect(unknown.custody).toEqual({ location: 'unknown', confirmed: false, checkedAt: null })
    expect(unknown.networkContext.currentCustodyNetwork).toBeNull()
  })

  it('rejects negative units, duplicate IDs, and a bridge parent/child mismatch', () => {
    const invalid = plan()
    invalid.agents[0].allocation.units = '-1'
    expect(() => buildDispatchReceipt({ plan: invalid, permission: permission() })).toThrow(/amount/i)
  })
})

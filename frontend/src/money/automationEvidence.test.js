// frontend/src/money/automationEvidence.test.js
import { describe, it, expect } from 'vitest'
import {
  classifyKeeperAutomation,
  classifyStrategyConfiguration,
  classifyLifeboatAutomation,
  describeRiskWatchProvenance,
  KEEPER_HEALTHY_WITHIN_MS,
} from './automationEvidence.js'

describe('classifyKeeperAutomation', () => {
  it('is unavailable with no events at all — absence of alerts is not evidence of health', () => {
    expect(classifyKeeperAutomation({ events: [], now: 1000 })).toEqual({
      label: 'unavailable',
      lastHeartbeatAt: null,
      evidence: null,
    })
  })

  it('is unavailable when events exist but none carry a real closedAt', () => {
    const out = classifyKeeperAutomation({ events: [{ type: 'compound', ledger: 5 }], now: 1000 })
    expect(out.label).toBe('unavailable')
  })

  it('is healthy from a recent real compound heartbeat', () => {
    const now = 10_000_000
    const out = classifyKeeperAutomation({
      events: [{ type: 'compound', ledger: 5, closedAt: now - 1000 }],
      now,
    })
    expect(out.label).toBe('healthy')
    expect(out.lastHeartbeatAt).toBe(now - 1000)
  })

  it('is healthy from a recent rebalance heartbeat too', () => {
    const now = 10_000_000
    const out = classifyKeeperAutomation({
      events: [{ type: 'rebalance', ledger: 5, closedAt: now - 1000 }],
      now,
    })
    expect(out.label).toBe('healthy')
  })

  it('is stale when the freshest heartbeat is outside the healthy window', () => {
    const now = 10_000_000
    const out = classifyKeeperAutomation({
      events: [{ type: 'compound', ledger: 5, closedAt: now - KEEPER_HEALTHY_WITHIN_MS - 1 }],
      now,
    })
    expect(out.label).toBe('stale')
  })

  it('never treats a derisk/mandate/upgrade event as a heartbeat', () => {
    const now = 10_000_000
    const out = classifyKeeperAutomation({
      events: [{ type: 'derisk', ledger: 5, closedAt: now - 10 }],
      now,
    })
    expect(out.label).toBe('unavailable')
  })

  it('picks the freshest of several heartbeats regardless of array order', () => {
    const now = 10_000_000
    const out = classifyKeeperAutomation({
      events: [
        { type: 'compound', ledger: 1, closedAt: now - 500_000 },
        { type: 'rebalance', ledger: 2, closedAt: now - 1000 },
        { type: 'compound', ledger: 3, closedAt: now - 200_000 },
      ],
      now,
    })
    expect(out.lastHeartbeatAt).toBe(now - 1000)
    expect(out.label).toBe('healthy')
  })
})

describe('classifyStrategyConfiguration', () => {
  it('is configured (not running) from a readable price-per-share', () => {
    expect(classifyStrategyConfiguration({ pricePerShare: 10_000_000n })).toEqual({ label: 'configured' })
  })

  it('is configured from an explicit registered flag', () => {
    expect(classifyStrategyConfiguration({ registered: true })).toEqual({ label: 'configured' })
  })

  it('is unavailable with neither signal', () => {
    expect(classifyStrategyConfiguration({})).toEqual({ label: 'unavailable' })
    expect(classifyStrategyConfiguration()).toEqual({ label: 'unavailable' })
  })

  it('never claims running/healthy — only configured, a strictly weaker claim', () => {
    const out = classifyStrategyConfiguration({ pricePerShare: 10_000_000n })
    expect(out.label).not.toBe('healthy')
    expect(out.label).not.toBe('running')
  })

  // Fix 6 (minor, review loop 1): a pricePerShare of exactly 0 is not a plausible confirmed
  // reading for a real vault share price — it reads as an unset/failed default, never 'configured'.
  it('is unavailable from a pricePerShare of exactly 0 — not a plausible confirmed reading', () => {
    expect(classifyStrategyConfiguration({ pricePerShare: 0 })).toEqual({ label: 'unavailable' })
    expect(classifyStrategyConfiguration({ pricePerShare: 0n })).toEqual({ label: 'unavailable' })
  })
})

describe('classifyLifeboatAutomation', () => {
  it('is unavailable with no evidence at all', () => {
    const out = classifyLifeboatAutomation({})
    expect(out.state).toBe('unavailable')
    expect(out.scope).toBe('vault-wide')
  })

  it('is engaged when derisked, and reports authority separately from state', () => {
    const out = classifyLifeboatAutomation({ derisked: true, mandateExpiry: 0, authority: 'GAUTH', now: 1000 })
    expect(out.state).toBe('engaged')
    expect(out.authority).toBe('GAUTH')
    expect(out.scope).toBe('vault-wide')
  })

  it('is armed when not derisked and the mandate has not expired', () => {
    const out = classifyLifeboatAutomation({
      derisked: false,
      mandateExpiry: 2000,
      authority: 'GAUTH',
      now: 1000 * 1000, // 1000 seconds
    })
    expect(out.state).toBe('armed')
  })

  it('is disarmed when not derisked and the mandate has expired', () => {
    const out = classifyLifeboatAutomation({
      derisked: false,
      mandateExpiry: 500,
      authority: 'GAUTH',
      now: 1000 * 1000, // 1000 seconds
    })
    expect(out.state).toBe('disarmed')
  })

  it('always labels the state vault-wide, never scoped to one owner', () => {
    const out = classifyLifeboatAutomation({ derisked: false, mandateExpiry: 2000, authority: 'GAUTH', now: 1000 })
    expect(out.scope).toBe('vault-wide')
  })

  // Fix 3 (review loop 1): reproduces the reviewer's exact scenario — the shape a failed
  // OwnerDiscoveryV1-derived protection read carries (`derisked: false`, `mandateExpiry: null`).
  // An unread mandate expiry must never be reported as a confident 'disarmed' — "no evidence" is
  // not "protection off".
  it('is unavailable, never disarmed, when derisked is false but mandateExpiry was never read', () => {
    const out = classifyLifeboatAutomation({ derisked: false, mandateExpiry: null, authority: 'GAUTH', now: 1000 })
    expect(out.state).toBe('unavailable')
    expect(out.state).not.toBe('disarmed')
  })

  it('is still engaged when derisked is confirmed true even without a readable mandateExpiry', () => {
    const out = classifyLifeboatAutomation({ derisked: true, mandateExpiry: null, authority: 'GAUTH', now: 1000 })
    expect(out.state).toBe('engaged')
  })
})

describe('describeRiskWatchProvenance', () => {
  it('labels a local, owner+network-scoped history as "This device"', () => {
    const out = describeRiskWatchProvenance({ owner: 'GABC', networkId: 'stellar-testnet' })
    expect(out).toEqual({ label: 'This device', scope: 'local', owner: 'GABC', networkId: 'stellar-testnet' })
  })

  it('is unavailable without both owner and networkId — never a guessed shared bucket', () => {
    expect(describeRiskWatchProvenance({ owner: 'GABC' }).label).toBe('unavailable')
    expect(describeRiskWatchProvenance({ networkId: 'stellar-testnet' }).label).toBe('unavailable')
    expect(describeRiskWatchProvenance({}).label).toBe('unavailable')
  })
})

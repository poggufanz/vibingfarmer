// frontend/src/strategy/autoExit/autoExit.test.js
import { describe, it, expect } from 'vitest'
import { checkUtilization, checkApy, checkProtocolRisk, checkDrawdown } from './triggers.js'
import { validateRules, DEFAULT_EXIT_RULES } from './rules.js'
import { evaluateExit } from './engine.js'

describe('AutoExit Triggers', () => {
  describe('checkUtilization', () => {
    it('trips when utilization exceeds threshold', () => {
      const res = checkUtilization({ utilization: { value: 0.96 } }, 0.95)
      expect(res.tripped).toBe(true)
      expect(res.reason).toContain('Pool utilization is 96.0%')
    })

    it('passes when utilization is below threshold', () => {
      const res = checkUtilization({ utilization: { value: 0.85 } }, 0.95)
      expect(res.tripped).toBe(false)
    })
  })

  describe('checkApy', () => {
    it('trips when APY collapses below threshold', () => {
      const res = checkApy({ apy: { value: 0.005 } }, 0.01)
      expect(res.tripped).toBe(true)
      expect(res.reason).toContain('APY fell to 0.50%')
    })

    it('passes when APY is above threshold', () => {
      const res = checkApy({ apy: { value: 0.04 } }, 0.01)
      expect(res.tripped).toBe(false)
    })
  })

  describe('checkProtocolRisk', () => {
    it('trips when TVL drops more than threshold', () => {
      const res = checkProtocolRisk({ tvl: { value: 12_000_000 } }, 0.4, null)
      expect(res.tripped).toBe(true)
      expect(res.reason).toContain('Protocol TVL fell by 52.0%')
    })

    it('trips when audit is none', () => {
      const res = checkProtocolRisk(
        { tvl: { value: 25_000_000 }, audit: { value: 'none' } },
        0.4,
        null
      )
      expect(res.tripped).toBe(true)
      expect(res.reason).toContain('No current protocol audit was found.')
    })

    it('trips when exploit is mentioned in market context', () => {
      const res = checkProtocolRisk(
        { tvl: { value: 25_000_000 } },
        0.4,
        'Aave is undergoing an exploit'
      )
      expect(res.tripped).toBe(true)
      expect(res.reason).toContain('possible exploit indicator: exploit.')
    })
  })
})

describe('AutoExit Rules Validation', () => {
  it('sanitizes and provides defaults', () => {
    const rules = validateRules({ utilization: { enabled: true, threshold: 99.0 } })
    expect(rules.utilization.enabled).toBe(true)
    expect(rules.utilization.threshold).toBe(0.95) // fallback to default since 99.0 is invalid
  })
})

describe('AutoExit Engine', () => {
  const makeMockState = (positions) => ({
    portfolio: { holdings: positions },
    universe: [{ address: 'CVAULT', protocol: 'blend', apy: 6.5, tvl: 25_000_000, drawdown: 0.0 }],
    market: { utilization: 0.96, signals: [] },
  })

  it('evaluates rules and returns trip when rules are active and triggered', () => {
    const rules = {
      authorized: true,
      utilization: { enabled: true, threshold: 0.95 },
      apyCollapse: { enabled: false },
      protocolRisk: { enabled: false },
      drawdown: { enabled: false },
    }
    const state = makeMockState({ CVAULT: { balance: '1000' } })
    const res = evaluateExit(rules, state, { nowMs: 1000 })
    expect(res.tripped).toBe(true)
    expect(res.trigger).toBe('utilization')
  })

  it('obeys expiry checks', () => {
    const rules = {
      authorized: true,
      expiryAt: 1000,
      utilization: { enabled: true, threshold: 0.95 },
      apyCollapse: { enabled: false },
      protocolRisk: { enabled: false },
      drawdown: { enabled: false },
    }
    const state = makeMockState({ CVAULT: { balance: '1000' } })
    const res = evaluateExit(rules, state, { nowMs: 2000 }) // expired
    expect(res.tripped).toBe(false)
    expect(res.reason).toContain('expired')
  })

  it('respects cooldown window', () => {
    const rules = {
      authorized: true,
      utilization: { enabled: true, threshold: 0.95 },
      apyCollapse: { enabled: false },
      protocolRisk: { enabled: false },
      drawdown: { enabled: false },
    }
    const state = makeMockState({ CVAULT: { balance: '1000' } })
    const res = evaluateExit(rules, state, { nowMs: 10000, lastExitTripAt: 8000 }) // within 5m
    expect(res.tripped).toBe(false)
    expect(res.cooldown).toBe(true)
  })
})

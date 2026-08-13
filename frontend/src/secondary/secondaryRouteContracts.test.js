import { describe, expect, it } from 'vitest'
import {
  FACT_STATES,
  SOURCE_KINDS,
  formatTokenUnits,
  normalizeAmount,
  normalizeFact,
  statusNoticeModel,
  statusToneForState,
  toFreshnessView,
} from './secondaryRouteContracts.js'

const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })
const CHECKED_AT = '2026-08-11T00:00:00.000Z'

describe('secondary route contracts', () => {
  it('re-exports Foundation fact, amount, freshness, and notice contracts', () => {
    expect(FACT_STATES).toContain('loading')
    expect(FACT_STATES).toContain('unavailable')
    expect(SOURCE_KINDS).toEqual([
      'stellar-rpc',
      'defillama',
      'base-indexer',
      'local-device',
      'replay-fixture',
      'portal-api',
      'catalog',
      'unavailable',
    ])
    expect(normalizeAmount(AMOUNT)).toEqual(AMOUNT)
    expect(formatTokenUnits(AMOUNT.units, AMOUNT.decimals)).toBe('1.2345')
    expect(statusToneForState('stale')).toBe('warning')

    const fact = normalizeFact({
      state: 'current',
      value: AMOUNT,
      source: 'fixture',
      checkedAt: CHECKED_AT,
      staleAfterMs: 120000,
    })
    expect(toFreshnessView(fact)).toEqual({
      phase: fact.phase,
      state: fact.state,
      label: 'Current',
      source: 'fixture',
      checkedAt: CHECKED_AT,
      staleAfterMs: 120000,
      confirmedLedger: null,
      confirmedBlock: null,
    })
    expect(statusNoticeModel(fact)).toMatchObject({ label: 'Current', source: 'fixture' })
  })
})

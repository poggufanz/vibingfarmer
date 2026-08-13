import { describe, expect, it, vi } from 'vitest'
import { normalizeAmount, toFreshnessView } from './secondaryRouteContracts.js'
import {
  adaptSecondaryFact,
  toDevelopersPresentation,
  toEcosystemPresentation,
  toExplorerPresentation,
  toHistoryPresentation,
  toOnboardingPresentation,
  toReplayPresentation,
  toTxPresentation,
  toVaultPresentation,
} from './secondaryRouteAdapters.js'

const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })
const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const STATES = ['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable']

const factFor = (state) => ({
  state,
  value: state === 'unavailable' || state === 'error' ? null : AMOUNT,
  source: state === 'unavailable' ? null : 'fixture-source',
  checkedAt: state === 'unavailable' ? null : CHECKED_AT,
  staleAfterMs: 120000,
})

describe('secondary route presentation adapters', () => {
  it.each(STATES)('projects %s with canonical value, freshness, and notice fields', (state) => {
    const adapted = adaptSecondaryFact({
      fact: factFor(state),
      read: 'vault read',
      safeAction: 'Return to vault setup.',
    })

    expect(adapted.fact).toMatchObject({ state })
    expect(adapted.value).toEqual(adapted.fact.value)
    expect(adapted.freshness).toEqual(toFreshnessView(adapted.fact))
    expect(adapted.notice).toMatchObject({
      label: expect.any(String),
      consequence: expect.any(String),
      nextAction: expect.any(String),
      source: adapted.fact.source,
      checkedAt: adapted.fact.checkedAt,
      freshness: adapted.freshness,
    })
    if (state === 'unavailable' || state === 'error') expect(adapted.value).toBeNull()
    else expect(adapted.value).toEqual(normalizeAmount(AMOUNT))
  })

  it('uses prior source evidence for a failed refresh without changing its freshness', () => {
    const previous = factFor('current')
    const adapted = adaptSecondaryFact({
      fact: factFor('error'),
      previousFact: previous,
      read: 'history read',
    })

    expect(adapted.fact.state).toBe('stale')
    expect(adapted.value).toEqual(AMOUNT)
    expect(adapted.freshness.source).toBe('fixture-source')
    expect(adapted.freshness.checkedAt).toBe(CHECKED_AT)
  })

  it('keeps every named route projection pure and injectable', () => {
    const readResult = Object.freeze({
      fact: Object.freeze({
        state: 'current',
        value: AMOUNT,
        source: 'fixture-source',
        checkedAt: CHECKED_AT,
        staleAfterMs: 120000,
      }),
    })
    const readers = vi.spyOn(globalThis, 'fetch')
    const clock = vi.spyOn(Date, 'now')
    const storage = globalThis.localStorage ? vi.spyOn(globalThis.localStorage, 'getItem') : null
    const projections = [
      toOnboardingPresentation,
      toExplorerPresentation,
      toEcosystemPresentation,
      toReplayPresentation,
      toHistoryPresentation,
      toVaultPresentation,
      toTxPresentation,
      toDevelopersPresentation,
    ]

    try {
      for (const project of projections) {
        const presentation = project(readResult)
        expect(presentation.fact.state).toBe('current')
        expect(presentation.value).toEqual(AMOUNT)
        expect(presentation.freshness.source).toBe('fixture-source')
      }
    } finally {
      readers.mockRestore()
      clock.mockRestore()
      storage?.mockRestore()
    }

    expect(readers).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
    if (storage) expect(storage).not.toHaveBeenCalled()
  })
})

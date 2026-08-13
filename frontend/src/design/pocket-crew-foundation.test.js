import { describe, expect, it, vi } from 'vitest'
import { CONTRAST_REQUIREMENTS } from './contrast.js'
import { FOUNDATION_CREW_TOKENS, FOUNDATION_THEMES } from './pocket-crew-contract.js'
import {
  AUTOMATION_STATES,
  COLLECTION_STATES,
  CUSTODY_STATES,
  DISCOVERY_STATES,
  EXECUTION_STATES,
  FACT_STATES,
  PLAN_SOURCES,
  PROTECTION_STATES,
  normalizeAmount,
  normalizeFact,
  formatTokenUnits,
  resolveAgentIdentity,
  statusNoticeModel,
  statusToneForState,
  toFreshnessView,
} from './pocket-crew-foundation.js'

const EXPECTED_STATES = {
  COLLECTION_STATES: ['loading', 'current', 'stale', 'empty', 'error'],
  DISCOVERY_STATES: ['checking', 'complete', 'partial', 'unavailable'],
  PROTECTION_STATES: ['loading', 'armed', 'engaged', 'expired', 'stale', 'unavailable', 'disarmed'],
  AUTOMATION_STATES: ['loading', 'running', 'configured', 'stale', 'unavailable'],
  PLAN_SOURCES: ['live-ai', 'deterministic', 'cached'],
  EXECUTION_STATES: [
    'planned',
    'creating',
    'queued',
    'ready',
    'moving',
    'depositing',
    'bridging',
    'in-transit',
    'working',
    'failed',
    'revoked-funded',
    'revoked-empty',
    'expired',
    'unknown',
  ],
  CUSTODY_STATES: ['owner', 'agent', 'stellar-vault', 'in-transit', 'base-proxy', 'unknown'],
  FACT_STATES: [
    'loading',
    'current',
    'confirmed',
    'stale',
    'partial',
    'blocked',
    'empty',
    'error',
    'rejected',
    'cancelled',
    'unknown',
    'unavailable',
  ],
}

const FACT_KEYS = [
  'phase',
  'state',
  'value',
  'source',
  'checkedAt',
  'staleAfterMs',
  'confirmedLedger',
  'confirmedBlock',
  'consequence',
  'safeNextAction',
]

const FRESHNESS_KEYS = [
  'phase',
  'state',
  'label',
  'source',
  'checkedAt',
  'staleAfterMs',
  'confirmedLedger',
  'confirmedBlock',
]

const IDENTITY_KEYS = [
  'phase',
  'key',
  'allocationId',
  'runId',
  'address',
  'source',
  'verified',
  'status',
  'label',
  'state',
]

const EXPECTED_TONES = {
  loading: 'neutral',
  empty: 'neutral',
  current: 'active',
  confirmed: 'active',
  stale: 'warning',
  partial: 'warning',
  blocked: 'warning',
  error: 'danger',
  rejected: 'neutral',
  cancelled: 'neutral',
  unknown: 'neutral',
  unavailable: 'neutral',
}

const amount = Object.freeze({ token: 'USDC', units: '9007199254740993', decimals: 7 })

describe('Pocket Crew foundation state interfaces', () => {
  it('publishes every reviewed state array in order and freezes each array', () => {
    const exportedStates = {
      COLLECTION_STATES,
      DISCOVERY_STATES,
      PROTECTION_STATES,
      AUTOMATION_STATES,
      PLAN_SOURCES,
      EXECUTION_STATES,
      CUSTODY_STATES,
      FACT_STATES,
    }

    Object.entries(exportedStates).forEach(([name, states]) => {
      expect(states, name).toEqual(EXPECTED_STATES[name])
      expect(Object.isFrozen(states), `${name} is frozen`).toBe(true)
    })
  })

  it('maps every fact state to its reviewed semantic tone and fails unknown states neutral', () => {
    Object.entries(EXPECTED_TONES).forEach(([state, tone]) => {
      expect(statusToneForState(state), state).toBe(tone)
    })
    expect(statusToneForState('not-a-state')).toBe('neutral')
    expect(statusToneForState()).toBe('neutral')
  })
})

describe('Pocket Crew canonical string-unit amounts', () => {
  it('preserves an exact decimal unit string in the frozen TokenAmount DTO', () => {
    const normalized = normalizeAmount(amount)

    expect(normalized).toEqual(amount)
    expect(Object.keys(normalized)).toEqual(['token', 'units', 'decimals'])
    expect(typeof normalized.units).toBe('string')
    expect(Object.isFrozen(normalized)).toBe(true)
    expect('value' in normalized).toBe(false)
    expect('currency' in normalized).toBe(false)
  })

  it.each([
    { token: 'USDC', units: Number.MAX_SAFE_INTEGER + 2, decimals: 7 },
    { token: 'USDC', units: 9007199254740993n, decimals: 7 },
    { token: 'USDC', units: '', decimals: 7 },
    { token: 'USDC', units: '-1', decimals: 7 },
    { token: 'USDC', units: '1.5', decimals: 7 },
    { token: '', units: '1', decimals: 7 },
    { token: '   ', units: '1', decimals: 7 },
    { token: 'USDC', units: '1', decimals: -1 },
    { token: 'USDC', units: '1', decimals: 39 },
    { token: 'USDC', units: '1', decimals: 1.5 },
  ])('rejects a non-canonical amount %#', (invalidAmount) => {
    expect(() => normalizeAmount(invalidAmount)).toThrow(TypeError)
  })

  it('keeps BigInt arithmetic inside the formatter boundary only', () => {
    expect(formatTokenUnits('9007199254740993', 0)).toBe('9007199254740993')
    expect(formatTokenUnits(9007199254740993n, 7)).toBe('900719925.4740993')
    expect(formatTokenUnits('700000000', 7)).toBe('70')
    expect(() => formatTokenUnits(null, 7)).toThrow(TypeError)
    expect(() => formatTokenUnits(1, 7)).toThrow(TypeError)
    expect(() => formatTokenUnits('1', 39)).toThrow(TypeError)
  })
})

describe('Pocket Crew presentation Fact adapter', () => {
  it('returns exactly the frozen ten-key Fact view', () => {
    const fact = normalizeFact({
      phase: 'submitted',
      state: 'current',
      value: amount,
      source: 'Stellar RPC',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 900000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })

    expect(Object.keys(fact)).toEqual(FACT_KEYS)
    expect(Object.isFrozen(fact)).toBe(true)
    expect(fact).toMatchObject({
      phase: 'submitted',
      state: 'current',
      value: amount,
      source: 'Stellar RPC',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 900000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    expect(typeof fact.consequence).toBe('string')
    expect(typeof fact.safeNextAction).toBe('string')
  })

  it.each([
    'loading',
    'current',
    'confirmed',
    'stale',
    'partial',
    'blocked',
    'empty',
    'error',
    'rejected',
    'cancelled',
  ])('gives every actionable state explicit consequence and safe next action: %s', (state) => {
    const fact = normalizeFact({
      phase: state === 'confirmed' ? 'submitted' : 'planned',
      state,
      value: amount,
      source: 'fixture source',
      checkedAt: '2026-08-11T00:00:00.000Z',
    })

    expect(fact.state).toBe(state)
    expect(typeof fact.consequence).toBe('string')
    expect(typeof fact.safeNextAction).toBe('string')
  })

  it.each(['current', 'confirmed', 'stale'])(
    'fails closed to unavailable when %s lacks source freshness',
    (state) => {
      const fact = normalizeFact({ phase: 'submitted', state, value: amount })

      expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
      expect(fact.consequence).toBeNull()
      expect(fact.safeNextAction).toBeNull()
    }
  )

  it('requires a valid checkedAt source timestamp and never invents staleAfterMs', () => {
    expect(
      normalizeFact({ state: 'current', source: 'rpc', checkedAt: '', staleAfterMs: 900000 })
    ).toMatchObject({ state: 'unavailable', phase: 'unknown', staleAfterMs: 900000 })
    expect(
      normalizeFact({ state: 'current', source: 'rpc', checkedAt: Infinity, staleAfterMs: 900000 })
    ).toMatchObject({ state: 'unavailable', phase: 'unknown', staleAfterMs: 900000 })
    expect(
      normalizeFact({ state: 'current', source: 'rpc', checkedAt: 'fresh', staleAfterMs: 1.5 })
    ).toMatchObject({ state: 'current', phase: 'unknown', staleAfterMs: null })
    expect(
      normalizeFact({ state: 'current', source: 'rpc', checkedAt: 'fresh' }).staleAfterMs
    ).toBeNull()
  })

  it('forces stale and confirmed phase/state pairs instead of retaining contradictory phases', () => {
    const stale = normalizeFact({
      phase: 'confirmed',
      state: 'stale',
      value: amount,
      source: 'rpc',
      checkedAt: 'freshness',
    })
    const confirmed = normalizeFact({
      phase: 'stale',
      state: 'confirmed',
      value: amount,
      source: 'rpc',
      checkedAt: 'freshness',
    })

    expect(stale).toMatchObject({ phase: 'stale', state: 'stale' })
    expect(confirmed).toMatchObject({ phase: 'confirmed', state: 'confirmed' })
  })

  it('preserves the previous verified evidence as stale after a failed refresh', () => {
    const previous = normalizeFact({
      phase: 'confirmed',
      state: 'confirmed',
      value: amount,
      source: 'Stellar RPC',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 900000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })

    const failed = normalizeFact(
      {
        phase: 'submitted',
        state: 'error',
        source: 'failed refresh',
        checkedAt: '2026-08-11T00:05:00.000Z',
      },
      previous
    )

    expect(failed).toMatchObject({
      phase: 'stale',
      state: 'stale',
      value: amount,
      source: 'Stellar RPC',
      checkedAt: '2026-08-11T00:00:00.000Z',
      staleAfterMs: 900000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    expect(failed.phase).not.toBe('confirmed')
  })

  it('accepts only decimal-string confirmation anchors', () => {
    const fact = normalizeFact({
      state: 'current',
      phase: 'submitted',
      value: amount,
      source: 'rpc',
      checkedAt: 'freshness',
      confirmedLedger: 12345,
      confirmedBlock: 67890n,
    })

    expect(fact.confirmedLedger).toBeNull()
    expect(fact.confirmedBlock).toBeNull()
    expect(
      normalizeFact({
        state: 'current',
        phase: 'submitted',
        source: 'rpc',
        checkedAt: 'freshness',
        confirmedLedger: ' 12345 ',
        confirmedBlock: '67890',
      })
    ).toMatchObject({ confirmedLedger: '12345', confirmedBlock: '67890' })
  })

  it('keeps unknown and unavailable neutral without invented consequence or action', () => {
    ;['unknown', 'unavailable'].forEach((state) => {
      const fact = normalizeFact({
        state,
        value: amount,
        consequence: 'invented',
        safeNextAction: 'invented',
      })
      expect(fact).toMatchObject({
        state,
        phase: 'unknown',
        value: state === 'unavailable' ? null : amount,
      })
      expect(fact.consequence).toBeNull()
      expect(fact.safeNextAction).toBeNull()
    })
  })

  it.each([
    ['direct BigInt', 1n],
    ['nested BigInt units', { token: 'USDC', units: 1n, decimals: 7 }],
  ])('fails closed for %s in current Fact evidence', (_label, value) => {
    const source = {
      phase: 'submitted',
      state: 'current',
      value,
      source: 'rpc',
      checkedAt: 'freshness',
    }
    const fact = normalizeFact(source)

    expect(Object.keys(fact)).toEqual(FACT_KEYS)
    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(fact.consequence).toBeNull()
    expect(fact.safeNextAction).toBeNull()
    expect(source.value).toBe(value)
  })

  it.each([
    ['direct BigInt', 1n],
    ['nested BigInt units', { token: 'USDC', units: 1n, decimals: 7 }],
  ])('fails closed for %s in failed-refresh prior evidence', (_label, value) => {
    const prior = {
      phase: 'confirmed',
      state: 'confirmed',
      value,
      source: 'rpc',
      checkedAt: 'freshness',
      staleAfterMs: 900000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    }
    const fact = normalizeFact({ state: 'error' }, prior)

    expect(Object.keys(fact)).toEqual(FACT_KEYS)
    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(fact.consequence).toBeNull()
    expect(fact.safeNextAction).toBeNull()
    expect(prior.value).toBe(value)
  })

  it('fails closed for cyclic evidence without rejecting ordinary source-owned values', () => {
    const cyclicValue = { token: 'USDC', units: '1', decimals: 7 }
    cyclicValue.self = cyclicValue

    expect(() =>
      normalizeFact({ state: 'current', value: cyclicValue, source: 'rpc', checkedAt: 'fresh' })
    ).not.toThrow()
    expect(
      normalizeFact({ state: 'current', value: cyclicValue, source: 'rpc', checkedAt: 'fresh' })
    ).toMatchObject({
      phase: 'unknown',
      state: 'unavailable',
      value: null,
    })

    const ordinaryValue = {
      kind: 'source-record',
      metadata: { label: 'ordinary' },
    }
    const fact = normalizeFact({
      state: 'current',
      value: ordinaryValue,
      source: 'rpc',
      checkedAt: 'fresh',
    })
    expect(fact).toMatchObject({ phase: 'unknown', state: 'current', value: ordinaryValue })
    expect(fact.value).not.toBe(ordinaryValue)
    expect(fact.value.metadata).not.toBe(ordinaryValue.metadata)
    expect(Object.isFrozen(fact.value)).toBe(true)
    expect(Object.isFrozen(fact.value.metadata)).toBe(true)
    expect(ordinaryValue).toEqual({ kind: 'source-record', metadata: { label: 'ordinary' } })
  })

  it.each(['error', 'unavailable'])(
    'preserves safe prior evidence when %s receives hostile incoming value data',
    (state) => {
      const prior = normalizeFact({
        phase: 'confirmed',
        state: 'confirmed',
        value: { token: 'USDC', units: '1', decimals: 7 },
        source: 'rpc',
        checkedAt: 'prior-freshness',
        staleAfterMs: 900000,
        confirmedLedger: '12345',
        confirmedBlock: '67890',
      })
      const cyclicValue = {}
      cyclicValue.self = cyclicValue
      const throwingProxy = new Proxy(
        { visible: 'safe' },
        {
          ownKeys() {
            throw new Error('hostile ownKeys')
          },
        }
      )

      ;[1n, cyclicValue, throwingProxy].forEach((value, index) => {
        const fact = normalizeFact(
          {
            state,
            value,
            source: 'incoming-source',
            checkedAt: 'incoming-freshness',
            staleAfterMs: 1,
            confirmedLedger: '99999',
            confirmedBlock: '88888',
          },
          prior
        )

        expect(fact, `${state} hostile value ${index}`).toMatchObject({
          phase: 'stale',
          state: 'stale',
          value: prior.value,
          source: 'rpc',
          checkedAt: 'prior-freshness',
          staleAfterMs: 900000,
          confirmedLedger: '12345',
          confirmedBlock: '67890',
        })
        expect(Object.is(fact.value, value)).toBe(false)
        expect(Object.isFrozen(fact.value)).toBe(true)
      })
    }
  )

  it.each(['error', 'unavailable'])(
    'does not read an incoming value accessor during a failed %s refresh',
    (state) => {
      const prior = normalizeFact({
        phase: 'confirmed',
        state: 'confirmed',
        value: { token: 'USDC', units: '1', decimals: 7 },
        source: 'rpc',
        checkedAt: 'prior-freshness',
      })
      let readCount = 0
      const input = { state, source: 'incoming-source', checkedAt: 'incoming-freshness' }
      Object.defineProperty(input, 'value', {
        enumerable: true,
        configurable: true,
        get() {
          readCount += 1
          throw new Error('incoming value must be ignored')
        },
      })

      expect(() => normalizeFact(input, prior)).not.toThrow()
      const fact = normalizeFact(input, prior)

      expect(readCount).toBe(0)
      expect(fact).toMatchObject({ phase: 'stale', state: 'stale', value: prior.value })
      expect(Object.isFrozen(fact.value)).toBe(true)
    }
  )

  it.each([
    [
      'non-enumerable BigInt',
      () => {
        const value = { visible: 'safe' }
        Object.defineProperty(value, 'hidden', { value: 1n, enumerable: false })
        return value
      },
    ],
    [
      'non-enumerable accessor',
      () => {
        const value = { visible: 'safe' }
        Object.defineProperty(value, 'hidden', {
          enumerable: false,
          get() {
            throw new Error('hidden accessor must not run')
          },
        })
        return value
      },
    ],
  ])('fails closed without reading %s presentation data', (_label, makeValue) => {
    const value = makeValue()

    expect(() =>
      normalizeFact({ state: 'current', value, source: 'rpc', checkedAt: 'fresh' })
    ).not.toThrow()
    const fact = normalizeFact({ state: 'current', value, source: 'rpc', checkedAt: 'fresh' })

    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(Object.keys(fact)).toEqual(FACT_KEYS)
  })

  it.each([
    ['bare function', function presentationValue() {}],
    ['arrow function', () => {}],
    ['symbol', Symbol('presentation-value')],
  ])('fails closed for a non-data %s value', (_label, value) => {
    const fact = normalizeFact({ state: 'current', value, source: 'rpc', checkedAt: 'fresh' })

    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(Object.isFrozen(fact)).toBe(true)
  })

  it('fails closed without throwing for a proxy that rejects own-key inspection', () => {
    const target = { visible: 'safe' }
    const throwingProxy = new Proxy(target, {
      ownKeys() {
        throw new Error('hostile ownKeys')
      },
    })

    expect(() =>
      normalizeFact({ state: 'current', value: throwingProxy, source: 'rpc', checkedAt: 'fresh' })
    ).not.toThrow()
    const fact = normalizeFact({
      state: 'current',
      value: throwingProxy,
      source: 'rpc',
      checkedAt: 'fresh',
    })

    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(target).toEqual({ visible: 'safe' })
  })

  it('snapshots visible proxy data and never returns a proxy-hidden BigInt or the proxy itself', () => {
    const target = { visible: 'safe', hidden: 1n }
    const proxy = new Proxy(target, {
      ownKeys() {
        return ['visible']
      },
      getOwnPropertyDescriptor(source, key) {
        if (key === 'visible') return Object.getOwnPropertyDescriptor(source, key)
        return undefined
      },
    })

    const fact = normalizeFact({
      state: 'current',
      value: proxy,
      source: 'rpc',
      checkedAt: 'fresh',
    })

    expect(fact).toMatchObject({ phase: 'unknown', state: 'current', value: { visible: 'safe' } })
    expect(fact.value).not.toBe(proxy)
    expect(Object.keys(fact.value)).toEqual(['visible'])
    expect('hidden' in fact.value).toBe(false)
    expect(Object.isFrozen(fact.value)).toBe(true)
    expect(target.hidden).toBe(1n)
    expect(target).toEqual({ visible: 'safe', hidden: 1n })
  })

  it.each([Infinity, NaN, {}, 1n, '   '])(
    'normalizes invalid checkedAt evidence to null across every Fact state: %#',
    (checkedAt) => {
      FACT_STATES.forEach((state) => {
        const fact = normalizeFact({
          phase: 'submitted',
          state,
          value: null,
          source: 'rpc',
          checkedAt,
        })

        expect(fact.checkedAt, state).toBeNull()
        expect(Object.keys(fact), state).toEqual(FACT_KEYS)
      })
    }
  )

  it.each([42, '2026-08-11T00:00:00.000Z'])(
    'preserves valid source-owned checkedAt values: %#',
    (checkedAt) => {
      FACT_STATES.forEach((state) => {
        const fact = normalizeFact({ state, value: null, source: 'rpc', checkedAt })
        expect(fact.checkedAt, state).toBe(checkedAt)
      })
    }
  )

  it.each([Infinity, NaN, {}, 1n, '   '])(
    'normalizes invalid checkedAt in failed-refresh prior evidence to null: %#',
    (checkedAt) => {
      const prior = {
        phase: 'confirmed',
        state: 'confirmed',
        value: amount,
        source: 'rpc',
        checkedAt,
        staleAfterMs: 900000,
      }
      const fact = normalizeFact({ state: 'error' }, prior)

      expect(fact).toMatchObject({
        phase: 'unknown',
        state: 'unavailable',
        value: null,
        checkedAt: null,
      })
      expect(prior.checkedAt).toBe(checkedAt)
    }
  )

  it.each([
    ['numeric units', { token: 'USDC', units: 1, decimals: 7 }],
    ['BigInt units', { token: 'USDC', units: 1n, decimals: 7 }],
    ['invalid decimals', { token: 'USDC', units: '1', decimals: 39 }],
    ['empty token', { token: '', units: '1', decimals: 7 }],
    ['extra amount key', { token: 'USDC', units: '1', decimals: 7, extra: 'nope' }],
  ])('fails closed for an invalid canonical amount boundary: %s', (_label, value) => {
    const source = { state: 'current', value, source: 'rpc', checkedAt: 'fresh' }
    const fact = normalizeFact(source)

    expect(Object.keys(fact)).toEqual(FACT_KEYS)
    expect(fact).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(fact.consequence).toBeNull()
    expect(fact.safeNextAction).toBeNull()
    expect(source.value).toBe(value)
  })

  it('accepts an exact canonical amount through a frozen source snapshot', () => {
    const value = { token: 'USDC', units: '1', decimals: 7 }
    const fact = normalizeFact({ state: 'current', value, source: 'rpc', checkedAt: 'fresh' })

    expect(fact).toMatchObject({ phase: 'unknown', state: 'current', value })
    expect(fact.value).not.toBe(value)
    expect(Object.isFrozen(fact.value)).toBe(true)
    expect(value).toEqual({ token: 'USDC', units: '1', decimals: 7 })
  })

  it('projects exactly the eight source-owned freshness fields without a clock or default TTL', () => {
    const fact = normalizeFact({
      phase: 'submitted',
      state: 'current',
      value: amount,
      source: 'rpc',
      checkedAt: 'freshness',
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    const now = vi.spyOn(Date, 'now')
    const freshness = toFreshnessView(fact)

    expect(Object.keys(freshness)).toEqual(FRESHNESS_KEYS)
    expect(Object.isFrozen(freshness)).toBe(true)
    expect(freshness).toMatchObject({
      phase: 'submitted',
      state: 'current',
      label: 'Current',
      source: 'rpc',
      checkedAt: 'freshness',
      staleAfterMs: null,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    expect(now).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('uses the Fact-owned copy in the status notice and keeps unknown neutral', () => {
    const fact = normalizeFact({
      phase: 'submitted',
      state: 'blocked',
      value: amount,
      source: 'council',
      checkedAt: 'freshness',
      consequence: 'Do not sign this request.',
      safeNextAction: 'Resolve the blocked eligibility check.',
    })
    const notice = statusNoticeModel(fact)

    expect(Object.isFrozen(notice)).toBe(true)
    expect(notice).toEqual({
      tone: 'warning',
      label: 'Blocked',
      consequence: 'Do not sign this request.',
      nextAction: 'Resolve the blocked eligibility check.',
      phase: 'unknown',
      source: 'council',
      checkedAt: 'freshness',
      staleAfterMs: null,
      confirmedLedger: null,
      confirmedBlock: null,
    })

    expect(statusNoticeModel(normalizeFact({ state: 'unknown' }))).toMatchObject({
      tone: 'neutral',
      label: 'Unavailable',
      consequence: null,
      nextAction: null,
    })
  })
})

describe('Pocket Crew status tone prototype safety', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'fails closed for inherited state key %s',
    (state) => {
      expect(statusToneForState(state)).toBe('neutral')
    }
  )
})

describe('Pocket Crew phase-aware agent identity', () => {
  it.each([
    [{ phase: 'planned', allocationId: 'allocation-1', source: 'reviewed-plan' }, 'allocation-1'],
    [{ phase: 'planned', runId: 'run-1', source: 'reviewed-plan' }, 'run-1'],
  ])('keeps reviewed planned identity markable without an address: %#', (input, key) => {
    const identity = resolveAgentIdentity(input)

    expect(Object.keys(identity)).toEqual(IDENTITY_KEYS)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(identity).toMatchObject({
      phase: 'planned',
      key,
      address: null,
      source: 'reviewed-plan',
      verified: false,
      status: 'available',
      label: 'Planned',
      state: 'planned',
    })
  })

  it.each(['creation-event', 'owner-discovery', 'receipt'])(
    'requires verified address evidence for %s identity',
    (source) => {
      const identity = resolveAgentIdentity({
        phase: 'deployed',
        allocationId: 'allocation-1',
        runId: 'run-1',
        verifiedAddress: 'GABC123',
        verified: true,
        source,
        state: 'ready',
      })

      expect(Object.keys(identity)).toEqual(IDENTITY_KEYS)
      expect(Object.isFrozen(identity)).toBe(true)
      expect(identity).toMatchObject({
        phase: 'deployed',
        key: 'GABC123',
        allocationId: 'allocation-1',
        runId: 'run-1',
        address: 'GABC123',
        source,
        verified: true,
        status: 'available',
        label: 'Existing',
        state: 'ready',
      })
    }
  )

  it('accepts the same proven address boundary for reused identities', () => {
    expect(
      resolveAgentIdentity({
        phase: 'reused',
        runId: 'run-1',
        verifiedAddress: 'GABC123',
        verified: true,
        source: 'owner-discovery',
      })
    ).toMatchObject({ phase: 'reused', key: 'GABC123', address: 'GABC123', label: 'Existing' })
    expect(
      Object.isFrozen(
        resolveAgentIdentity({
          phase: 'reused',
          runId: 'run-1',
          verifiedAddress: 'GABC123',
          verified: true,
          source: 'owner-discovery',
        })
      )
    ).toBe(true)
  })

  it.each([
    { phase: 'planned', source: 'reviewed-plan' },
    { phase: 'planned', allocationId: 'allocation-1', source: 'unknown' },
    {
      phase: 'planned',
      allocationId: 'allocation-1',
      source: 'reviewed-plan',
      verifiedAddress: 'GABC123',
    },
    { phase: 'deployed', source: 'creation-event', verifiedAddress: 'GABC123' },
    { phase: 'deployed', source: 'creation-event', verified: true },
    { phase: 'deployed', source: 'reviewed-plan', verified: true, verifiedAddress: 'GABC123' },
    { phase: 'reused', source: 'receipt', verified: true, verifiedAddress: '   ' },
    { phase: 'unknown', source: 'unknown' },
  ])('fails closed to the exact unavailable identity shape: %#', (input) => {
    const identity = resolveAgentIdentity(input)

    expect(Object.keys(identity)).toEqual(IDENTITY_KEYS)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(identity.status).toBe('unavailable')
    expect(identity.label).toBe('Agent identity unavailable')
    expect(identity.address).toBeNull()
    expect(identity.verified).toBe(false)
    expect('reason' in identity).toBe(false)
    expect('accountId' in identity).toBe(false)
    expect('persona' in identity).toBe(false)
  })
})

describe('Pocket Crew contrast requirements remain reviewed while deriving colors from Task 1', () => {
  it('keeps the reviewed requirement ids and derives representative values from the token contract', () => {
    const byId = Object.fromEntries(
      CONTRAST_REQUIREMENTS.map(([id, foreground, background, minimum]) => [
        id,
        [foreground, background, minimum],
      ])
    )
    const forest = FOUNDATION_THEMES.forest
    const day = FOUNDATION_THEMES['day-field']
    const crew = FOUNDATION_CREW_TOKENS

    expect(Object.keys(byId)).toEqual(CONTRAST_REQUIREMENTS.map(([id]) => id))
    expect(byId['forest.text/canvas']).toEqual([forest['--pc-ink'], forest['--pc-canvas'], 4.5])
    expect(byId['forest.disabledOnLight/owned']).toEqual([
      FOUNDATION_THEMES['day-field']['--pc-faint'],
      forest['--pc-owned'],
      4.5,
    ])
    expect(byId['day.text/workspace']).toEqual([day['--pc-ink'], day['--pc-workspace'], 4.5])
    expect(byId['forest.crewInk/crew1']).toEqual([
      forest['--pc-owned-ink'],
      crew.forest['--pc-crew-1'],
      4.5,
    ])
    expect(byId['day.crewInk/crew6']).toEqual([
      day['--pc-owned'],
      crew['day-field']['--pc-crew-6'],
      4.5,
    ])
    expect(byId['forest.stateInk/failed']).toEqual([
      forest['--pc-owned-ink'],
      forest['--pc-danger'],
      4.5,
    ])
    expect(byId['day.stateInk/confirmed']).toEqual([day['--pc-owned'], day['--pc-ink'], 4.5])
  })
})

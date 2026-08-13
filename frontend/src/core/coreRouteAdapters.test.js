import { describe, expect, it } from 'vitest'
import {
  formatTokenUnits,
  normalizeAmount,
  normalizeFact,
  resolveAgentIdentity,
  statusNoticeModel,
  toFreshnessView,
} from '../design/pocket-crew-foundation.js'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  statusNoticeModel as coreStatusNoticeModel,
  toAgentIdentityView,
  toBaseCustodyTruth,
  toBaseMandateManagerState,
  toFactView,
  toFreshnessView as coreFreshnessView,
  toLiveVenueView,
  toPermissionCopy,
  toStartProgress,
} from './coreRouteAdapters.js'

const AMOUNT = { token: 'USDC', units: '9007199254740993', decimals: 7 }
const CHECKED_AT = '2026-08-10T23:59:00.000Z'

describe('core route adapters use the Foundation contracts', () => {
  it('normalizes exact string amounts and formats without widening units to a number', () => {
    const amount = normalizeCoreAmount(AMOUNT)

    expect(amount).toEqual(AMOUNT)
    expect(Object.isFrozen(amount)).toBe(true)
    // Foundation's exact decimal arithmetic: 9007199254740993 / 10^7.
    expect(formatCoreAmount(amount)).toBe('900719925.4740993 USDC')
    expect(formatTokenUnits(amount.units, amount.decimals)).toBe('900719925.4740993')
    expect(formatCoreAmount({ token: 'USDC', units: '0', decimals: 0 })).toBe('0 USDC')

    const businessFixture = { ...AMOUNT, units: 9007199254740993n }
    expect(
      normalizeCoreAmount({ ...businessFixture, units: businessFixture.units.toString() })
    ).toEqual(AMOUNT)

    for (const invalid of [
      { ...AMOUNT, units: 1 },
      { ...AMOUNT, units: 1n },
      { ...AMOUNT, units: '1.5' },
      { ...AMOUNT, units: '-1' },
      { ...AMOUNT, token: '' },
      { ...AMOUNT, decimals: 1.5 },
      { ...AMOUNT, decimals: -1 },
      { ...AMOUNT, decimals: 39 },
    ]) {
      expect(() => normalizeCoreAmount(invalid)).toThrow()
    }
  })

  it('delegates fact normalization and preserves prior evidence as stale after a failed refresh', () => {
    const current = {
      phase: 'confirmed',
      state: 'confirmed',
      value: normalizeAmount(AMOUNT),
      source: 'stellar-rpc',
      checkedAt: CHECKED_AT,
      staleAfterMs: 120000,
      confirmedLedger: '12345',
      confirmedBlock: null,
      consequence: 'Money is confirmed.',
      safeNextAction: 'Keep watching it.',
    }
    const expected = normalizeFact(current)
    const actual = toFactView(current)

    expect(actual).toEqual(expected)
    expect(Object.keys(actual)).toEqual([
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
    ])

    const unavailable = toFactView({ state: 'current', value: normalizeAmount(AMOUNT) })
    expect(unavailable).toMatchObject({ phase: 'unknown', state: 'unavailable', value: null })
    expect(unavailable.consequence).toBeNull()
    expect(unavailable.safeNextAction).toBeNull()

    const stale = toFactView({ state: 'error' }, expected)
    expect(stale).toMatchObject({
      phase: 'stale',
      state: 'stale',
      value: expected.value,
      source: expected.source,
      checkedAt: expected.checkedAt,
      staleAfterMs: expected.staleAfterMs,
      confirmedLedger: expected.confirmedLedger,
      consequence: 'The last verified fact may be out of date.',
      safeNextAction: 'Refresh the source before moving money.',
    })
  })

  it('returns direct Foundation freshness and status projections', () => {
    const fact = {
      phase: 'submitted',
      state: 'current',
      value: normalizeAmount(AMOUNT),
      source: 'relay',
      checkedAt: CHECKED_AT,
      staleAfterMs: 120000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    }

    expect(coreFreshnessView(fact)).toEqual(toFreshnessView(fact))
    expect(coreStatusNoticeModel(fact)).toEqual(statusNoticeModel(fact))
    expect(coreFreshnessView({ state: 'unknown' })).toEqual(toFreshnessView({ state: 'unknown' }))
    expect(coreStatusNoticeModel({ state: 'unavailable' })).toMatchObject({
      label: 'Unavailable',
      consequence: null,
      nextAction: null,
    })
  })

  it('keeps identity phase and proof requirements fail-closed', () => {
    const planned = toAgentIdentityView({
      phase: 'planned',
      allocationId: 'allocation-1',
      runId: 'run-1',
      source: 'reviewed-plan',
    })
    expect(planned).toMatchObject({
      phase: 'planned',
      key: 'allocation-1',
      label: 'Planned',
      identityAvailable: true,
      showMark: true,
      showMoney: true,
      showCap: true,
      showAction: true,
    })

    const deployed = toAgentIdentityView({
      phase: 'deployed',
      allocationId: 'allocation-1',
      runId: 'run-1',
      address: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
      verified: true,
      source: 'creation-event',
    })
    expect(deployed).toMatchObject({
      phase: 'deployed',
      address: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
      label: 'Existing',
      identityAvailable: true,
    })

    const missing = toAgentIdentityView({
      phase: 'reused',
      allocationId: 'allocation-1',
      runId: 'run-1',
      address: '',
      verified: false,
      source: 'receipt',
    })
    expect(missing).toEqual({
      ...resolveAgentIdentity({
        phase: 'reused',
        allocationId: 'allocation-1',
        runId: 'run-1',
        verifiedAddress: '',
        verified: false,
        source: 'receipt',
      }),
      identityAvailable: false,
      showMark: false,
      showMoney: false,
      showCap: false,
      showAction: false,
    })

    const unknown = toAgentIdentityView({ phase: 'unknown', persona: 'Sprout', index: 0 })
    expect(unknown.identityAvailable).toBe(false)
    expect(unknown.key).toBeNull()
    expect(unknown).not.toHaveProperty('persona')
  })

  it('trusts only nested source-owned live venue yield and keeps Base custody yield empty', () => {
    const live = {
      venueKind: 'stellar-live',
      name: 'Autofarm Vault',
      apy: 99,
      yield: {
        state: 'live',
        apy: 4.8,
        asOf: CHECKED_AT,
        source: 'defillama',
        checkedAt: CHECKED_AT,
      },
    }
    expect(toLiveVenueView(live)).toEqual(live.yield)
    expect(toLiveVenueView({ ...live, yield: { ...live.yield, source: null } })).toEqual({
      state: 'unavailable',
      apy: null,
    })
    expect(toLiveVenueView({ venueKind: 'stellar-live', apy: 4.8 })).toEqual({
      state: 'unavailable',
      apy: null,
    })
    expect(toLiveVenueView({ venueKind: 'base-custody-proxy', apy: 4.8 })).toEqual({
      state: 'none',
      apy: null,
    })
    expect(
      toLiveVenueView({
        venueKind: 'stellar-live',
        chain: 'base',
        yield: live.yield,
      })
    ).toEqual({
      state: 'unavailable',
      apy: null,
    })
  })

  it('rejects non-parseable source yield timestamps', () => {
    const live = {
      venueKind: 'stellar-live',
      yield: {
        state: 'live',
        apy: 4.8,
        asOf: CHECKED_AT,
        source: 'defillama',
        checkedAt: CHECKED_AT,
      },
    }

    expect(toLiveVenueView({ ...live, yield: { ...live.yield, asOf: 'garbage' } })).toEqual({
      state: 'unavailable',
      apy: null,
    })
    expect(toLiveVenueView({ ...live, yield: { ...live.yield, checkedAt: 'garbage' } })).toEqual({
      state: 'unavailable',
      apy: null,
    })
  })

  it('maps only event-backed start phases and exposes exact Base custody truth', () => {
    expect(toStartProgress('queued')).toBe(0)
    expect(toStartProgress('pulling')).toBe(22)
    expect(toStartProgress('depositing')).toBe(66)
    expect(toStartProgress('done')).toBe(100)
    for (const phase of ['failed', 'cancelled', 'unknown', null, undefined]) {
      expect(toStartProgress(phase)).toBeNull()
    }

    expect(toBaseCustodyTruth()).toEqual({
      disclosure: 'Base Sepolia proxy. Custody only. No protocol yield.',
      destination: 'custody',
      custody: 'custody',
      yield: { state: 'none', apy: null },
    })
  })

  it('keeps permission copy source-backed and fail-closed for unverifiable reuse', () => {
    const fresh = toPermissionCopy('fresh-grant', { mode: 'fresh', confirmationCount: 1 })
    expect(fresh).toMatchObject({ mode: 'fresh-grant', status: 'Available', confirmationCount: 1 })
    expect(fresh.copy).not.toMatch(/forever|everything|1 signature/i)

    const reuseUnavailable = toPermissionCopy('stellar-reuse-verified', {
      mode: 'reuse',
      confirmationCount: 0,
    })
    expect(reuseUnavailable).toMatchObject({ status: 'Unavailable', confirmationCount: null })
    expect(reuseUnavailable.copy).not.toMatch(/0 wallet confirmations/i)

    const reuseDecision = {
      mode: 'reuse',
      confirmationCount: 0,
      grantReceiptFingerprint: `0x${'11'.repeat(32)}`,
      allowanceExpiryProof: {
        gapFree: true,
        noLaterMutation: true,
        latestLedger: 12345,
        approvals: [{ amount: AMOUNT, expiryLedger: 13000 }],
      },
      agents: [
        {
          allocationId: 'run-1:deposit:0',
          agentAddress: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
          scopeExpiry: 13000,
          headroom: AMOUNT,
        },
      ],
    }
    const reuse = toPermissionCopy('stellar-reuse-verified', reuseDecision)
    expect(reuse).toMatchObject({
      mode: 'stellar-reuse-verified',
      status: 'Available',
      confirmationCount: 0,
    })

    expect(toPermissionCopy('reuse', reuseDecision)).toMatchObject({
      mode: 'stellar-reuse-verified',
      status: 'Available',
      confirmationCount: 0,
    })

    expect(
      toPermissionCopy('stellar-reuse-verified', {
        ...reuseDecision,
        grantReceiptFingerprint: null,
      })
    ).toMatchObject({ status: 'Unavailable', confirmationCount: null })
    expect(
      toPermissionCopy('stellar-reuse-verified', {
        ...reuseDecision,
        allowanceExpiryProof: null,
      })
    ).toMatchObject({ status: 'Unavailable', confirmationCount: null })
    expect(
      toPermissionCopy('stellar-reuse-verified', {
        ...reuseDecision,
        agents: [{ ...reuseDecision.agents[0], agentAddress: '' }],
      })
    ).toMatchObject({ status: 'Unavailable', confirmationCount: null })
    expect(
      toPermissionCopy('stellar-reuse-verified', {
        ...reuseDecision,
        confirmationCount: null,
      })
    ).toMatchObject({ status: 'Unavailable', confirmationCount: null })

    for (const mode of ['base-fresh-ceremony', 'stop-future-access', 'withdrawal-separate']) {
      const view = toPermissionCopy(mode, { mode })
      expect(view.mode).toBe(mode)
      expect(view.copy).not.toMatch(/forever|everything|1 signature/i)
    }
  })

  it('requires explicit gap-free and no-later-mutation allowance proof for reuse copy', () => {
    const decision = {
      mode: 'reuse',
      confirmationCount: 0,
      grantReceiptFingerprint: `0x${'11'.repeat(32)}`,
      allowanceExpiryProof: {
        gapFree: true,
        noLaterMutation: true,
        latestLedger: 12345,
        approvals: [{ amount: AMOUNT, expiryLedger: 13000 }],
      },
      agents: [
        {
          allocationId: 'run-1:deposit:0',
          agentAddress: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
          scopeExpiry: 13000,
          headroom: AMOUNT,
        },
      ],
    }

    for (const proof of [
      { ...decision.allowanceExpiryProof, gapFree: false },
      { ...decision.allowanceExpiryProof, noLaterMutation: false },
    ]) {
      const view = toPermissionCopy('stellar-reuse-verified', {
        ...decision,
        allowanceExpiryProof: proof,
      })
      expect(view).toMatchObject({ status: 'Unavailable', confirmationCount: null })
      expect(view.copy).not.toMatch(/0 wallet confirmations/i)
    }
  })

  it('projects Base mandate manager state with disconnected, switched, busy, then source precedence', () => {
    expect(
      toBaseMandateManagerState({ connected: false, accountEpoch: 1, capturedEpoch: 1 })
    ).toMatchObject({ state: 'disconnected' })
    expect(
      toBaseMandateManagerState({ connected: true, accountEpoch: 2, capturedEpoch: 1 })
    ).toMatchObject({ state: 'switched' })
    for (const epochs of [
      { accountEpoch: 1, capturedEpoch: null },
      { accountEpoch: null, capturedEpoch: 1 },
      { accountEpoch: null, capturedEpoch: null },
      { accountEpoch: '', capturedEpoch: '' },
    ]) {
      expect(
        toBaseMandateManagerState({
          connected: true,
          ...epochs,
          mandateView: { status: 'ready' },
        })
      ).toMatchObject({ state: 'switched' })
    }
    expect(
      toBaseMandateManagerState({ connected: true, accountEpoch: 1, capturedEpoch: 1, busy: true })
    ).toMatchObject({ state: 'busy' })
    expect(
      toBaseMandateManagerState({
        connected: true,
        accountEpoch: 1,
        capturedEpoch: 1,
        busy: false,
        mandateView: { status: 'ready' },
      })
    ).toMatchObject({ state: 'ready', mandateView: { status: 'ready' } })
  })
})

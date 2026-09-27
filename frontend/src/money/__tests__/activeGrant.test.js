// frontend/src/money/__tests__/activeGrant.test.js
// P1 G5: the persistent grant widget's data layer — live allowance in, honest view-model out.
// Deps are always injected mocks here; the real RPC/receipt defaults are wired once in app.jsx
// (covered by that file's own structural test), never exercised here.
import { describe, it, expect, vi } from 'vitest'
import {
  describeCountdown,
  estimateExpiryMs,
  grantCountdown,
  loadActiveGrant,
  toActiveGrantView,
} from '../activeGrant.js'

const OWNER = 'GOWNER'
const ROUTER = 'CROUTER'
const TOKEN = 'CTOKEN'
const NOW_MS = 1_700_000_000_000

const RECEIPT = {
  expiryLedger: 5000,
  confirmedLedger: 1000,
  confirmedAt: 1_700_000_000,
  allowanceBudgets: [{ token: TOKEN, units: '5000000000', decimals: 7 }],
}

function deps(overrides = {}) {
  return {
    readAllowance: vi.fn(async () => ({ amount: 5_000_000_000n })),
    getLatestLedger: vi.fn(async () => 2000),
    loadReceipt: vi.fn(() => RECEIPT),
    ...overrides,
  }
}

function load(overrides = {}, depOverrides = {}) {
  return loadActiveGrant({
    owner: OWNER,
    router: ROUTER,
    token: TOKEN,
    nowMs: NOW_MS,
    deps: deps(depOverrides),
    ...overrides,
  })
}

describe('loadActiveGrant — remaining + countdown from mocked allowance', () => {
  it('returns the live remainder with a ledger countdown and a receipt-anchored estimate', async () => {
    const d = deps()
    const view = await loadActiveGrant({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      nowMs: NOW_MS,
      deps: d,
    })
    // Forwards the exact owner/router/token the widget is responsible for — a swapped spender
    // would display (and revoke) somebody else's grant.
    expect(d.readAllowance).toHaveBeenCalledWith({ owner: OWNER, router: ROUTER, token: TOKEN })
    expect(view.state).toBe('known')
    expect(view.remainingUnits).toBe('5000000000')
    expect(view.decimals).toBe(7)
    expect(view.expiryLedger).toBe(5000)
    expect(view.currentLedger).toBe(2000)
    expect(view.ledgersLeft).toBe(3000)
    // Chain-agreed anchor: confirmedAt + (expiry - confirmed) * 5s, never the browser clock.
    expect(view.estimatedExpiryMs).toBe(1_700_000_000_000 + 4000 * 5 * 1000)
  })

  it('reads decimals off the receipt budget for our token, not a hardcoded 7', async () => {
    const view = await load(
      {},
      {
        loadReceipt: () => ({
          ...RECEIPT,
          allowanceBudgets: [{ token: TOKEN, units: '5000000', decimals: 6 }],
        }),
        readAllowance: async () => ({ amount: 5_000_000n }),
      }
    )
    expect(view.state).toBe('known')
    expect(view.decimals).toBe(6)
  })

  it('stays known with an Unknown expiry when no receipt exists (e.g. granted elsewhere)', async () => {
    const view = await load({}, { loadReceipt: () => null })
    expect(view.state).toBe('known')
    expect(view.remainingUnits).toBe('5000000000')
    expect(view.expiryLedger).toBeNull()
    expect(view.ledgersLeft).toBeNull()
    expect(view.estimatedExpiryMs).toBeNull()
  })
})

describe('loadActiveGrant — fail-soft, never a fake number', () => {
  it('an allowance RPC failure resolves to unavailable, never a coerced zero', async () => {
    const d = deps({ readAllowance: async () => {
      throw new Error('rpc down')
    } })
    const view = await loadActiveGrant({ owner: OWNER, router: ROUTER, token: TOKEN, deps: d })
    expect(view).toEqual({ state: 'unavailable' })
  })

  it('a latest-ledger RPC failure resolves to unavailable even with a good allowance', async () => {
    const view = await load(
      {},
      {
        getLatestLedger: async () => {
          throw new Error('rpc down')
        },
      }
    )
    expect(view).toEqual({ state: 'unavailable' })
  })

  it('a non-bigint allowance resolves to unavailable, never renders as-is', async () => {
    const view = await load({}, { readAllowance: async () => ({ amount: 'lots' }) })
    expect(view).toEqual({ state: 'unavailable' })
  })

  it('a garbage ledger sequence resolves to unavailable, never feeds the countdown', async () => {
    const view = await load({}, { getLatestLedger: async () => 'soon' })
    expect(view).toEqual({ state: 'unavailable' })
  })
})

describe('loadActiveGrant — no active grant hides the card', () => {
  it('a confirmed zero allowance is none (hide), and skips the receipt read', async () => {
    const d = deps({ readAllowance: async () => ({ amount: 0n }) })
    const view = await loadActiveGrant({ owner: OWNER, router: ROUTER, token: TOKEN, deps: d })
    expect(view).toEqual({ state: 'none' })
    expect(d.loadReceipt).not.toHaveBeenCalled()
  })

  it('a ledger-proven-expired grant is none, not a negative countdown', async () => {
    const view = await load({}, { getLatestLedger: async () => 6000 })
    expect(view).toEqual({ state: 'none' })
  })

  it('no owner never touches the chain at all', async () => {
    const d = deps()
    expect(await loadActiveGrant({ owner: null, deps: d })).toEqual({ state: 'none' })
    expect(d.readAllowance).not.toHaveBeenCalled()
    expect(d.getLatestLedger).not.toHaveBeenCalled()
  })
})

describe('toActiveGrantView — pure edge cases', () => {
  it('accepts string units and stays exact past Number.MAX_SAFE_INTEGER', () => {
    const view = toActiveGrantView({
      amount: '9007199254740993',
      currentLedger: 1,
      expiryLedger: 100,
      nowMs: NOW_MS,
    })
    expect(view.state).toBe('known')
    expect(view.remainingUnits).toBe('9007199254740993')
  })

  it('falls back to a wall-clock estimate when the receipt anchor is absent', () => {
    const view = toActiveGrantView({
      amount: 100n,
      currentLedger: 2000,
      expiryLedger: 5000,
      nowMs: NOW_MS,
    })
    expect(view.estimatedExpiryMs).toBe(NOW_MS + 3000 * 5 * 1000)
  })

  it('an unparseable amount is unavailable, never a throw', () => {
    expect(toActiveGrantView({ amount: 'not-units' }).state).toBe('unavailable')
  })
})

describe('grantCountdown / describeCountdown / estimateExpiryMs', () => {
  it('counts ledgers exactly, null on non-ledger input', () => {
    expect(grantCountdown({ expiryLedger: 5000, currentLedger: 2000 })).toBe(3000)
    expect(grantCountdown({ expiryLedger: null, currentLedger: 2000 })).toBeNull()
  })

  it('phrases days/hr/min/sec off the same 5s rate the grant builder converts with', () => {
    expect(describeCountdown(17280)).toBe('17280 ledgers (≈ 1 day)')
    expect(describeCountdown(34560)).toBe('34560 ledgers (≈ 2 days)')
    expect(describeCountdown(1440)).toBe('1440 ledgers (≈ 2 hr)')
    expect(describeCountdown(24)).toBe('24 ledgers (≈ 2 min)')
    expect(describeCountdown(5)).toBe('5 ledgers (≈ 25 sec)')
    expect(describeCountdown(1)).toBe('1 ledger (≈ 5 sec)')
  })

  it('refuses to phrase non-positive countdowns', () => {
    expect(describeCountdown(0)).toBeNull()
    expect(describeCountdown(-3)).toBeNull()
  })

  it('estimateExpiryMs returns null with no usable anchor', () => {
    expect(estimateExpiryMs({ expiryLedger: null, currentLedger: 1, nowMs: NOW_MS })).toBeNull()
    // An expiry ledger with no current ledger (and no receipt anchor) cannot be dated at
    // all — wall-clock math needs the remaining distance, not just the endpoint.
    expect(estimateExpiryMs({ expiryLedger: 9, currentLedger: null, nowMs: NOW_MS })).toBeNull()
  })
})

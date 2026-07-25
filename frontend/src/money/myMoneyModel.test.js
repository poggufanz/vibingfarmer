// frontend/src/money/myMoneyModel.test.js
import { describe, it, expect } from 'vitest'
import { buildMyMoneyModel, choosePrimaryMoneyAction } from './myMoneyModel.js'

const NOW = 10_000_000_000

function amt(units) {
  return { token: 'USDC', units: String(units), decimals: 7 }
}

function knownMoney({ units = 0n, checkedAt = NOW, unattributed = {}, agents = [] } = {}) {
  return {
    status: 'complete',
    confirmedTotal: { state: 'known', amount: amt(units) },
    yield: { state: 'live', apy: 8.2 },
    earned: { state: 'unavailable', amount: null },
    custodyBreakdown: units > 0n ? { 'stellar-vault': String(units) } : {},
    unattributed,
    executionBreakdown: {},
    agentCount: agents.length,
    problemAgentCount: 0,
    agents,
    checkedAt,
  }
}

function discoveryOf(status) {
  return { status, agents: [] }
}

describe('buildMyMoneyModel — connection + loading', () => {
  it('is disconnected with no owner, regardless of other data', () => {
    const m = buildMyMoneyModel({ owner: null, discovery: null, money: null, now: NOW })
    expect(m.state).toBe('disconnected')
    expect(m.owner).toBeNull()
  })

  it('is loading when owner is connected but nothing has been read or cached yet', () => {
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: null, money: null, now: NOW })
    expect(m.state).toBe('loading')
  })

  it('is unavailable when a read was attempted and failed, with nothing cached', () => {
    const money = { status: 'unavailable', confirmedTotal: { state: 'unavailable', amount: null }, agents: [] }
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('unavailable'), money, now: NOW })
    expect(m.state).toBe('unavailable')
    expect(m.confirmedTotal).toBeNull()
  })
})

describe('buildMyMoneyModel — cache-backed staleness', () => {
  it('falls back to cached money and reports stale when the fresh read failed', () => {
    const cachedMoney = knownMoney({ units: 500_0000000n, checkedAt: NOW - 10_000 })
    const failedMoney = { status: 'unavailable', confirmedTotal: { state: 'unavailable', amount: null }, agents: [] }
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: failedMoney,
      cache: { money: cachedMoney },
      now: NOW,
    })
    expect(m.state).toBe('stale')
    expect(m.confirmedTotal.amount.units).toBe('5000000000')
    expect(m.freshness).toBe('stale')
  })

  it('is stale (not current) purely from an old checkedAt, even without any refresh failure', () => {
    const money = knownMoney({ units: 100n, checkedAt: 0 }) // ancient relative to NOW
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('stale')
  })
})

describe('buildMyMoneyModel — partial discovery', () => {
  it('is partial-discovery when the discovery envelope itself is partial', () => {
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('partial'), money, now: NOW })
    expect(m.state).toBe('partial-discovery')
  })

  it('is partial-discovery when the aggregate total itself is only partially known', () => {
    const money = { ...knownMoney({ units: 100n }), confirmedTotal: { state: 'partial', amount: amt(100n) } }
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('partial-discovery')
  })
})

describe('buildMyMoneyModel — authoritative emptiness', () => {
  it('is empty only with complete discovery + known zero total + no unattributed doubt', () => {
    const money = knownMoney({ units: 0n })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('empty')
  })

  it('never claims empty when an unattributed bucket is unavailable — unknown cannot manufacture empty', () => {
    const money = knownMoney({ units: 0n, unattributed: { kernel1: { state: 'unavailable', amount: null } } })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).not.toBe('empty')
    expect(m.state).toBe('current')
  })

  it('never claims empty when unattributed money is known-positive — real idle money exists', () => {
    const money = knownMoney({
      units: 0n,
      unattributed: { kernel1: { state: 'known', amount: amt(50n), checkedAt: NOW } },
    })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).not.toBe('empty')
  })

  it('never claims empty without proven-complete discovery, even with a known zero total', () => {
    const money = knownMoney({ units: 0n })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('partial'), money, now: NOW })
    expect(m.state).not.toBe('empty')
  })

  // Fix 1 (review loop 1): reproduces the reviewer's exact scenario — a cached zero total from an
  // hour ago plus a failed fresh read must never manufacture 'empty'. An owner who deposited and
  // then lost connectivity must not be told they have nothing.
  it('never claims empty from a stale cached zero total when the fresh read failed', () => {
    const cachedZero = knownMoney({ units: 0n, checkedAt: NOW - 60 * 60 * 1000 }) // checked an hour ago
    const failedMoney = { status: 'unavailable', confirmedTotal: { state: 'unavailable', amount: null }, agents: [] }
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: failedMoney,
      cache: { money: cachedZero, discovery: discoveryOf('complete') },
      now: NOW,
    })
    expect(m.state).not.toBe('empty')
    expect(m.freshness).toBe('stale')
  })

  it('still claims empty when a zero total is confirmed by a FRESH read', () => {
    const money = knownMoney({ units: 0n, checkedAt: NOW })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('empty')
  })

  // Fix 1, review loop 2: this used to assert only `not.toBe('empty')`, which let a warm cache
  // manufacture the MOST confident state ('current') instead — the model refuses this exact same
  // cached-completeness evidence for the weaker 'empty' claim (see :245 below), so it must refuse
  // it here too. Pin the exact expected state.
  it('never claims empty (or current) from a cached-only discovery.status — the FRESH discovery must itself be complete', () => {
    const money = knownMoney({ units: 0n, checkedAt: NOW }) // fresh, known zero
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: null, // never attempted this time
      money,
      cache: { discovery: discoveryOf('complete') }, // only the CACHE says complete
      now: NOW,
    })
    expect(m.state).toBe('partial-discovery')
  })
})

describe('buildMyMoneyModel — discovery completeness (Fix 2, review loop 1)', () => {
  // A total enumeration failure must be at least as cautious as a partial one — never upgraded to
  // a confident 'current'.
  it('is partial-discovery, not current, when discovery is explicitly unavailable', () => {
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'unavailable', agents: [] },
      money,
      now: NOW,
    })
    expect(m.state).toBe('partial-discovery')
  })

  it('is partial-discovery, not current, when discovery is entirely absent (null)', () => {
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: null, money, now: NOW })
    expect(m.state).toBe('partial-discovery')
  })
})

describe('buildMyMoneyModel — freshness triple survives finishModel (Fix 5, review loop 1)', () => {
  it('carries checkedAt, confirmedLedger, and source through to the finished model', () => {
    const money = { ...knownMoney({ units: 100n }), confirmedLedger: 123456, source: 'soroban-rpc' }
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.checkedAt).toBe(NOW)
    expect(m.confirmedLedger).toBe(123456)
    expect(m.source).toBe('soroban-rpc')
    expect(m.confirmedBlock).toBeNull() // never read for this Stellar source — stays unknown
  })

  it('never substitutes 0 for a genuinely unknown confirmation height — unread carries null', () => {
    const money = knownMoney({ units: 100n }) // no confirmedLedger/confirmedBlock/source supplied
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.confirmedLedger).toBeNull()
    expect(m.confirmedBlock).toBeNull()
    expect(m.source).toBeNull()
  })
})

describe('buildMyMoneyModel — latent freshness-triple gaps (Fix 2, review loop 2)', () => {
  // readOwnerMoney.js always stamps a finite checkedAt today, so this path is latent, not live —
  // fixed anyway per the brief: the model must not depend on an upstream invariant it cannot
  // enforce itself. A money read with a known total but a non-finite checkedAt classifies as
  // freshness 'unavailable' (freshness.js), which must never be rounded up to state 'current'.
  it('never reports state current from freshness unavailable — a non-finite checkedAt is not proof of "now"', () => {
    const money = knownMoney({ units: 100n, checkedAt: null })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.freshness).toBe('unavailable')
    expect(m.state).toBe('unavailable')
  })
})

describe('buildMyMoneyModel — current with a real position', () => {
  it('is current when discovery is complete, total is known and positive, and the read is fresh', () => {
    const money = knownMoney({ units: 1000_0000000n })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('current')
    expect(m.confirmedTotal.amount.units).toBe('10000000000')
    expect(m.yield).toEqual({ state: 'live', apy: 8.2 })
    expect(m.custodyBreakdown).toEqual({ 'stellar-vault': '10000000000' })
  })
})

describe('buildMyMoneyModel — confirmed custody problem', () => {
  function agentWith(problems, units) {
    return { address: 'CAGENT1', problems, amount: units != null ? amt(units) : null }
  }

  it('is problem when a funded agent is confirmed revoked', () => {
    const money = knownMoney({ units: 100n, agents: [agentWith(['scope-revoked'], 100n)] })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('problem')
    expect(m.problemAgents).toEqual(['CAGENT1'])
  })

  it('is problem when a funded agent had a confirmed failed Base execution', () => {
    const money = knownMoney({ units: 100n, agents: [agentWith(['base-execution-failed'], 100n)] })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('problem')
  })

  it('a revoked agent with NO known funds is not a confirmed problem — nothing to review', () => {
    const money = knownMoney({ units: 0n, agents: [agentWith(['scope-revoked'], 0n)] })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).not.toBe('problem')
  })

  it('a merely incomplete read (not a confirmed fact) is not a confirmed problem', () => {
    const money = knownMoney({ units: 0n, agents: [agentWith(['vault-shares-unavailable'], null)] })
    const m = buildMyMoneyModel({ owner: 'GOWNER', discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).not.toBe('problem')
  })

  it('problem takes precedence even while disconnected, per the literal precedence order', () => {
    const money = knownMoney({ units: 100n, agents: [agentWith(['scope-expired'], 100n)] })
    const m = buildMyMoneyModel({ owner: null, discovery: discoveryOf('complete'), money, now: NOW })
    expect(m.state).toBe('problem')
  })
})

describe('buildMyMoneyModel — protection / lifeboat', () => {
  it('never manufactures urgent renewal from unavailable protection evidence', () => {
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money,
      protection: { state: 'unavailable', authority: null, mandateExpiry: null },
      now: NOW,
    })
    expect(m.protection.urgentRenewal).toBe(false)
  })

  it('flags urgentRenewal when armed and close to expiry', () => {
    const nowS = Math.floor(NOW / 1000)
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money,
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: nowS + 60 },
      now: NOW,
    })
    expect(m.protection.urgentRenewal).toBe(true)
    expect(m.protection.ownerIsAuthority).toBe(true)
  })

  it('does not flag urgentRenewal when the mandate has plenty of time left', () => {
    const nowS = Math.floor(NOW / 1000)
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money,
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: nowS + 100_000 },
      now: NOW,
    })
    expect(m.protection.urgentRenewal).toBe(false)
  })

  it('ownerIsAuthority is false when the connected owner is not the mandate authority', () => {
    const money = knownMoney({ units: 100n })
    const m = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money,
      protection: { state: 'armed', authority: 'GSOMEONEELSE', mandateExpiry: Math.floor(NOW / 1000) + 60 },
      now: NOW,
    })
    expect(m.protection.ownerIsAuthority).toBe(false)
  })
})

describe('choosePrimaryMoneyAction — precedence', () => {
  it('returns null for a null model', () => {
    expect(choosePrimaryMoneyAction(null)).toBeNull()
  })

  it('1. Review problem beats everything else', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 100n, agents: [{ address: 'C1', problems: ['scope-revoked'], amount: amt(100n) }] }),
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: Math.floor(NOW / 1000) + 60 },
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'review-problem', label: 'Review problem' })
  })

  it('2. Connect wallet when disconnected', () => {
    const model = buildMyMoneyModel({ owner: null, discovery: null, money: null, now: NOW })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'connect-wallet', label: 'Connect wallet' })
  })

  it('3. Make a deposit when authoritatively empty', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 0n }),
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'deposit', label: 'Make a deposit' })
  })

  it('4. Renew vault protection when connected authority + urgent renewal + known vault money', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 100_0000000n }),
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: Math.floor(NOW / 1000) + 60 },
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'renew-protection', label: 'Renew vault protection' })
  })

  it('falls back to Add money when urgent but the connected owner is not the mandate authority', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 100_0000000n }),
      protection: { state: 'armed', authority: 'GSOMEONEELSE', mandateExpiry: Math.floor(NOW / 1000) + 60 },
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'add-money', label: 'Add money' })
  })

  it('falls back to Add money when there is no known vault money to protect', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 0n, unattributed: { k1: { state: 'known', amount: amt(5n), checkedAt: NOW } } }),
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: Math.floor(NOW / 1000) + 60 },
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'add-money', label: 'Add money' })
  })

  it('5. Add money for an active, healthy position', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: discoveryOf('complete'),
      money: knownMoney({ units: 100_0000000n }),
      now: NOW,
    })
    expect(choosePrimaryMoneyAction(model)).toEqual({ action: 'add-money', label: 'Add money' })
  })
})

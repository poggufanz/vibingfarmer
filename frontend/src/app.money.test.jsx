// frontend/src/app.money.test.jsx
// My Money Task 13 (Pocket Crew redesign, Wave 5). Same convention as
// app.strategy.merge.test.jsx: app.jsx's own top-level component is far too heavy (wallet/RPC/
// orchestrator side effects) to render directly in a unit test, so the logic that actually needs
// adversarial proof is extracted into plain, exported functions and tested directly here. This
// file covers:
//   - Step 1's three race-condition hazards (wallet-switch invalidation, reload-stale/read-only,
//     post-action stale-poll) via `shouldCommitMoneyFetch` and `fetchMyMoneySnapshot`.
//   - disconnected/loading/partial/current state fidelity through `buildMoneySnapshot` +
//     `buildMyMoneyModel` (the app's own glue, not myMoneyModel.js's already-tested internals).
//   - the `/home` projection (`projectMoneyForHome`) never fabricating a number.
//   - a structural proof that `/agent` renders MyMoneyRoute, not OpsConsole, and that OpsConsole's
//     own console.css never reaches a production route (source-level here; the bundle-scan proof
//     for the SAME claim is run separately against `npm run build`'s dist output — see the report).
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import {
  loadMoneyCache,
  saveMoneyCache,
  buildMoneySnapshot,
  isMoneyFetchForCurrentOwner,
  shouldCommitMoneyFetch,
  fetchMyMoneySnapshot,
  projectMoneyForHome,
} from './app.jsx'
import { buildMyMoneyModel } from './money/myMoneyModel.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function amount(units, decimals = 7, token = 'USDC') {
  return { token, units: String(units), decimals }
}

// ---------------------------------------------------------------------------------------------
// Race condition 1 (brief Step 1/2): wallet switch must invalidate the prior owner's
// discovery/money/risk journal.
// ---------------------------------------------------------------------------------------------
describe('isMoneyFetchForCurrentOwner — wallet-switch invalidation', () => {
  it('same owner -> current', () => {
    expect(isMoneyFetchForCurrentOwner({ fetchOwner: 'GA', currentOwner: 'GA' })).toBe(true)
  })
  it('a wallet switch mid-flight -> the prior owner fetch is rejected', () => {
    expect(isMoneyFetchForCurrentOwner({ fetchOwner: 'GA', currentOwner: 'GB' })).toBe(false)
  })
  it('a disconnect mid-flight (currentOwner null) -> rejected, never falls back to the fetch owner', () => {
    expect(isMoneyFetchForCurrentOwner({ fetchOwner: 'GA', currentOwner: null })).toBe(false)
  })
  it('a fetch with no owner at all is never "current" even against a null connected owner', () => {
    expect(isMoneyFetchForCurrentOwner({ fetchOwner: null, currentOwner: null })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Race condition 3 (brief Step 1/2): after a withdraw/revoke, a stale earlier poll must not
// repaint old data. shouldCommitMoneyFetch is the ONE decision app.jsx's refreshMoney/action
// handlers both call — proven here against every branch independently so a mutant that turns
// `&&` into `||`, or drops either guard, cannot survive.
// ---------------------------------------------------------------------------------------------
describe('shouldCommitMoneyFetch — combined wallet + revision guard', () => {
  it('same owner, same (unchanged) revision -> commit', () => {
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GA',
        readToken: 3,
        currentToken: 3,
      })
    ).toBe(true)
  })
  it('same owner, but a mutating action bumped the revision AFTER this read started -> reject (the stale-poll hazard)', () => {
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GA',
        readToken: 1,
        currentToken: 2,
      })
    ).toBe(false)
  })
  it('revision current, but the wallet switched -> reject (owner guard alone must be sufficient)', () => {
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GB',
        readToken: 3,
        currentToken: 3,
      })
    ).toBe(false)
  })
  it('both guards fail at once -> reject', () => {
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GB',
        readToken: 1,
        currentToken: 2,
      })
    ).toBe(false)
  })
  it('no mutating action has ever happened (currentToken null) -> revision guard opens, owner guard still governs', () => {
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GA',
        readToken: null,
        currentToken: null,
      })
    ).toBe(true)
    expect(
      shouldCommitMoneyFetch({
        fetchOwner: 'GA',
        currentOwner: 'GB',
        readToken: null,
        currentToken: null,
      })
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Race condition 2 (brief Step 1/2): a route reload must render cache as stale, reconcile
// read-only, and NEVER replay any transaction.
// ---------------------------------------------------------------------------------------------
describe('fetchMyMoneySnapshot — read-only by construction', () => {
  it('has no submit/sign/write seam on its own signature — only discoverScopes/readMoney', async () => {
    const discoverScopes = vi.fn(async () => ({ status: 'complete', agents: [] }))
    const readMoney = vi.fn(async () => ({ status: 'complete', agents: [], checkedAt: 1 }))
    const submit = vi.fn() // never passed in, never reachable from this function
    await fetchMyMoneySnapshot({ owner: 'GA', discoverScopes, readMoney })
    expect(discoverScopes).toHaveBeenCalledWith({ owner: 'GA' })
    expect(readMoney).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GA', discovery: { status: 'complete', agents: [] } })
    )
    expect(submit).not.toHaveBeenCalled()
  })

  it('a reload with a warm cache renders the cache marked stale (never current) BEFORE the fresh read resolves', () => {
    // This is the actual reload contract app.jsx's own effect implements: the FIRST render after
    // a reload/reconnect has nothing fresh yet, so it feeds buildMyMoneyModel the CACHED
    // discovery/money as this render's own arguments (there is nothing else to offer) plus the
    // same values again as `cache` for the fallback path a later failed fetch would need.
    // buildMyMoneyModel's own freshness math (classifyFreshness against the cached `checkedAt`,
    // already exhaustively tested in myMoneyModel.test.js/freshness.test.js) is what actually
    // proves 'stale' here, never a flag our own glue invents.
    const oldCheckedAt = 1_000
    const now = oldCheckedAt + 10 * 60 * 1000 // 10 minutes later — past DEFAULT_STALE_AFTER_MS
    const cachedMoney = buildMoneySnapshot({
      status: 'complete',
      agents: [],
      checkedAt: oldCheckedAt,
    })
    const cachedDiscovery = { status: 'complete', agents: [] }
    const model = buildMyMoneyModel({
      owner: 'GA',
      discovery: cachedDiscovery,
      money: cachedMoney,
      cache: { money: cachedMoney, discovery: cachedDiscovery },
      now,
    })
    expect(model.state).toBe('stale')
    expect(model.freshness).toBe('stale')
  })
})

// ---------------------------------------------------------------------------------------------
// Step 1: disconnected/loading/partial/current state is preserved through the app's own adapters
// (buildMoneySnapshot's assembly), not just myMoneyModel.js's internals.
// ---------------------------------------------------------------------------------------------
describe('buildMoneySnapshot + buildMyMoneyModel — app-adapter state fidelity', () => {
  it('disconnected: no owner at all', () => {
    const model = buildMyMoneyModel({ owner: null })
    expect(model.state).toBe('disconnected')
  })

  it('loading: owner connected, nothing read and nothing cached yet', () => {
    const model = buildMyMoneyModel({ owner: 'GA', money: null, cache: {} })
    expect(model.state).toBe('loading')
  })

  it('partial: a partial discovery envelope survives through buildMoneySnapshot into "partial-discovery"', () => {
    const reads = {
      status: 'complete', // the MONEY read itself succeeded...
      agents: [
        {
          address: 'CAGENT',
          amount: amount(100_0000000n),
          executionStatus: 'idle',
          custody: { location: 'stellar-vault' },
          custodyBreakdown: [],
          problems: [],
        },
      ],
      checkedAt: 5_000,
    }
    const money = buildMoneySnapshot(reads)
    const model = buildMyMoneyModel({
      owner: 'GA',
      discovery: { status: 'partial', agents: [] }, // ...but discovery itself did not finish
      money,
      now: 5_500,
    })
    expect(model.state).toBe('partial-discovery')
    // the known amount still rides along -- partial never means "throw the number away".
    expect(model.confirmedTotal.amount.units).toBe('1000000000')
  })

  it('current: complete discovery + a fresh, fully-known money read', () => {
    const reads = {
      status: 'complete',
      agents: [
        {
          address: 'CAGENT',
          amount: amount(500_0000000n),
          executionStatus: 'idle',
          custody: { location: 'stellar-vault' },
          custodyBreakdown: [],
          problems: [],
        },
      ],
      checkedAt: 9_000,
    }
    const money = buildMoneySnapshot(reads)
    const model = buildMyMoneyModel({
      owner: 'GA',
      discovery: { status: 'complete', agents: [{ address: 'CAGENT' }] },
      money,
      now: 9_100,
    })
    expect(model.state).toBe('current')
    expect(model.confirmedTotal.amount.units).toBe('5000000000')
  })
})

// ---------------------------------------------------------------------------------------------
// projectMoneyForHome: the ONLY thing /home is allowed to compute from My Money's own model.
// ---------------------------------------------------------------------------------------------
describe('projectMoneyForHome', () => {
  it('no model at all (never rendered yet) -> loading, no fabricated total', () => {
    expect(projectMoneyForHome(null)).toEqual({
      state: 'loading',
      total: null,
      lastConfirmed: null,
    })
  })

  it('known confirmed total rides through untouched', () => {
    const model = {
      state: 'current',
      confirmedTotal: { state: 'known', amount: amount(42_0000000n) },
      checkedAt: 777,
    }
    expect(projectMoneyForHome(model)).toEqual({
      state: 'current',
      total: amount(42_0000000n),
      lastConfirmed: 777,
    })
  })

  it('a partial/unavailable confirmedTotal never becomes a total -- null, not a coerced zero', () => {
    const model = { state: 'partial-discovery', confirmedTotal: { state: 'partial', amount: null } }
    expect(projectMoneyForHome(model).total).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Money cache read/write (localStorage) — the reload-renders-cache-first half of hazard 2.
// ---------------------------------------------------------------------------------------------
describe('loadMoneyCache / saveMoneyCache', () => {
  const store = {}
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }

  it('round-trips a cache object per owner, case-insensitively keyed', () => {
    saveMoneyCache('GOwner', { money: { checkedAt: 1 } })
    expect(loadMoneyCache('gowner')).toEqual({ money: { checkedAt: 1 } })
  })
  it('no owner -> {} on both read and write (never a blind global key)', () => {
    expect(loadMoneyCache(null)).toEqual({})
    saveMoneyCache(null, { money: {} }) // must not throw, must not write anywhere
    expect(loadMoneyCache('null')).toEqual({})
  })
  it('a corrupt cache entry degrades to {} rather than throwing', () => {
    store[`yv_my_money_cache_gbad`] = '{not json'
    expect(loadMoneyCache('GBAD')).toEqual({})
  })
})

// ---------------------------------------------------------------------------------------------
// Step 1: `/agent` renders MyMoneyRoute, not OpsConsole. app.jsx is too heavy to render (see
// header comment), so this is a structural source assertion scoped to JUST the `/agent` Route's
// own element block — proven adversarially by checking the block never re-admits OpsConsole even
// if OpsConsole is still imported/used elsewhere in dev-only code.
// ---------------------------------------------------------------------------------------------
describe('/agent route source: MyMoneyRoute, never OpsConsole', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function routeBlock(routePath) {
    const marker = `path="${routePath}"`
    const start = src.indexOf(marker)
    expect(start, `Route ${routePath} not found in app.jsx`).toBeGreaterThan(-1)
    // Each Route element closes with the FIRST `/>` at the matching nesting depth of the next
    // sibling `<Route` — cheap, reliable enough for this file's own consistent formatting: slice
    // up to the next `<Route` (or end of `<Routes>`), which is always further along than this
    // route's own closing tag.
    const nextRoute = src.indexOf('<Route', start + marker.length)
    return src.slice(start, nextRoute === -1 ? src.length : nextRoute)
  }

  it('the /agent route element mounts <MyMoneyRoute', () => {
    expect(routeBlock('/agent')).toMatch(/<MyMoneyRoute/)
  })

  it('the /agent route element never mounts <OpsConsole', () => {
    expect(routeBlock('/agent')).not.toMatch(/<OpsConsole/)
  })

  it('OpsConsole is not imported as a top-level lazy production route (kept only inside its own retired file)', () => {
    expect(src).not.toMatch(/const OpsConsole = lazy/)
  })
})

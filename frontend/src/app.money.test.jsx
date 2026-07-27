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
  guardedMoneyFetch,
  moneyFetchArgs,
  projectMoneyForHome,
  hasLiveScopeForVault,
} from './app.jsx'
import { buildMyMoneyModel } from './money/myMoneyModel.js'
import { nextReconciliationToken } from './money/freshness.js'

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
// Fix loop 1, I1: controller-level proof that refreshMoney's OWN call site (guardedMoneyFetch,
// the function it delegates to with zero guard logic of its own left to duplicate) keeps wiring
// LIVE owner/revision ref values into shouldCommitMoneyFetch. The describe block above proves
// shouldCommitMoneyFetch is correct in isolation, in both directions; the review proved by
// mutation that replacing the CALL SITE's `currentOwner: currentOwnerRef.current` / `currentToken:
// revisionRef.current` with the tautological `currentOwner: owner` / `currentToken: readToken`
// left the entire 181-test suite green anyway -- nothing was testing that the caller passed live
// values. These tests drive guardedMoneyFetch itself (not a parallel reimplementation) with an
// injected slow fetchSnapshot that mutates the refs mid-flight, exactly as a concurrent wallet
// switch / mutating action would in production. Mutation proof (both the reviewer's exact edit and
// a differently-written "stale captured value" variant) is recorded in the report.
// ---------------------------------------------------------------------------------------------
describe('guardedMoneyFetch — controller call site keeps live owner/revision refs wired to the guard', () => {
  it('hazard 1: a wallet switch mid-flight rejects the in-flight fetch for the PRIOR owner', async () => {
    const currentOwnerRef = { current: 'GA' }
    const revisionRef = { current: 0 }
    const onCommit = vi.fn()
    const fetchSnapshot = vi.fn(async () => {
      // The wallet switches to GB WHILE this fetch (for GA) is still in flight.
      currentOwnerRef.current = 'GB'
      return { money: {}, discovery: {} }
    })
    const committed = await guardedMoneyFetch({
      owner: 'GA',
      now: 1,
      fetchSnapshot,
      currentOwnerRef,
      revisionRef,
      onCommit,
    })
    expect(committed).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('hazard 3: a mutating action bumping the revision mid-flight rejects the earlier, now-stale poll', async () => {
    const currentOwnerRef = { current: 'GA' }
    const revisionRef = { current: 5 }
    const onCommit = vi.fn()
    const fetchSnapshot = vi.fn(async () => {
      // Simulates a withdraw/revoke's own reconcileOwnerAction bumping the SAME revision ref while
      // this poll's read is still in flight -- exactly the tie case the review's hand trace found
      // app.jsx:2133's late `beforeRevision` capture closes (a full end-to-end action-handler
      // simulation isn't needed to prove the guard side of this: this is the one decision every
      // action handler's post-mutation revision bump and every poll's own read both go through).
      revisionRef.current = nextReconciliationToken(revisionRef.current)
      return { money: {}, discovery: {} }
    })
    const committed = await guardedMoneyFetch({
      owner: 'GA',
      now: 1,
      fetchSnapshot,
      currentOwnerRef,
      revisionRef,
      onCommit,
    })
    expect(committed).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('the ordinary case still commits: same owner, no concurrent mutation', async () => {
    const currentOwnerRef = { current: 'GA' }
    const revisionRef = { current: 0 }
    const onCommit = vi.fn()
    const snapshot = { money: {}, discovery: {} }
    const committed = await guardedMoneyFetch({
      owner: 'GA',
      now: 1,
      fetchSnapshot: async () => snapshot,
      currentOwnerRef,
      revisionRef,
      onCommit,
    })
    expect(committed).toBe(true)
    expect(onCommit).toHaveBeenCalledWith(snapshot)
  })

  it('a failed fetch never commits and never throws out of guardedMoneyFetch', async () => {
    const onCommit = vi.fn()
    const committed = await guardedMoneyFetch({
      owner: 'GA',
      now: 1,
      fetchSnapshot: async () => {
        throw new Error('RPC down')
      },
      currentOwnerRef: { current: 'GA' },
      revisionRef: { current: 0 },
      onCommit,
    })
    expect(committed).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
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
// Fix loop 1, I1, hazard 2 (controller level): the [realAddress] reload/switch effect itself --
// not just fetchMyMoneySnapshot's already-proven write-seam-free signature above -- must prime
// state via buildMyMoneyModel and kick off only the guarded read path, and must never reach a
// write-capable function. Source-scoped to the exact block app.jsx marks with
// MONEY-RELOAD-EFFECT:START/END so a future edit inside that effect stays covered even if the
// surrounding code moves; a write call added inside it (e.g. an accidental replay on reload) fails
// this test immediately -- see the report for the insert/remove mutation proof.
// ---------------------------------------------------------------------------------------------
describe('[realAddress] reload effect (controller level) — never replays a transaction', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function reloadEffectBlock() {
    const start = src.indexOf('MONEY-RELOAD-EFFECT:START')
    const end = src.indexOf('MONEY-RELOAD-EFFECT:END')
    expect(start, 'MONEY-RELOAD-EFFECT:START marker not found').toBeGreaterThan(-1)
    expect(end, 'MONEY-RELOAD-EFFECT:END marker not found').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('primes state via buildMyMoneyModel, then kicks off refreshMoney (the guarded read path)', () => {
    const block = reloadEffectBlock()
    expect(block).toMatch(/buildMyMoneyModel\(/)
    expect(block).toMatch(/refreshMoney\(realAddress\)/)
  })

  it('never calls a write-capable function -- a reload/reconnect cannot replay a transaction', () => {
    const block = reloadEffectBlock()
    expect(block).not.toMatch(
      /sweepAgents\(|partialWithdraw\(|revokeAgentOnChain\(|ensureExitSigner\(|reconcileOwnerAction\(/
    )
  })
})

// ---------------------------------------------------------------------------------------------
// MM13 M5, fix round 1 (reviewer I1): guardedMoneyFetch (tested exhaustively above) is only as
// good as its ONE real call site's wiring. Fix loop 1 (I1) pinned the guard FUNCTION in both
// directions; a first fix-loop source-scan test then tried to pin refreshMoney's call site, but
// the reviewer proved it BLIND to a two-line RESTATEMENT: replacing the real wiring with dead
// literals while leaving a comment that merely MENTIONS the old code
// (`// was: currentOwnerRef: realAddressRef,`) satisfied the old regex via the comment text alone
// -- 37/37 green with both hazards wide open.
//
// Two changes close this:
//   1. The argument object is hoisted into `moneyFetchArgs` (app.jsx, exported, right after
//      guardedMoneyFetch) -- a test can call it directly and prove, by identity (not just deep
//      equality), that it never substitutes or clones whatever refs it is handed. This is real
//      coverage, not a guess from reading text.
//   2. `moneyFetchArgs` still needs refs it does not own (realAddressRef/moneyRevisionRef are
//      per-render React refs with ~10 other read/write sites throughout app.jsx's App component --
//      forcing them to module scope purely to make the ONE remaining call site provable without
//      ever reading source would be a much larger, riskier refactor of this file's state ownership
//      than a test-robustness fix warrants). That one line is still covered by a source-scan, but
//      comments are stripped before matching (so a comment merely NAMING the old code can no
//      longer satisfy the positive pattern), and a negative half added: an inline `{ current: ...}`
//      literal ANYWHERE in the line fails it outright, regardless of exact wording -- the shape of
//      the defect, not one specific spelling of it.
// ---------------------------------------------------------------------------------------------
describe('moneyFetchArgs — identity-preserving, never substitutes or clones the refs it is given', () => {
  it('returns the SAME ref objects it was handed (Object.is, not deep equality)', () => {
    const currentOwnerRef = { current: 'GA' }
    const revisionRef = { current: 3 }
    const fetchSnapshot = vi.fn()
    const args = moneyFetchArgs('GA', { currentOwnerRef, revisionRef, fetchSnapshot })
    expect(args.currentOwnerRef).toBe(currentOwnerRef)
    expect(args.revisionRef).toBe(revisionRef)
    expect(args.fetchSnapshot).toBe(fetchSnapshot)
    expect(args.owner).toBe('GA')
    expect(typeof args.now).toBe('number')
  })

  it('defaults fetchSnapshot to the real fetchMyMoneySnapshot when the caller omits it', () => {
    const args = moneyFetchArgs('GA', {
      currentOwnerRef: { current: null },
      revisionRef: { current: null },
    })
    expect(args.fetchSnapshot).toBe(fetchMyMoneySnapshot)
  })
})

describe('refreshMoney (controller level, MM13 M5) — wires the LIVE refs into moneyFetchArgs, not dead literals', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function refreshMoneyWiringBlock() {
    const start = src.indexOf('REFRESH-MONEY-WIRING:START')
    const end = src.indexOf('REFRESH-MONEY-WIRING:END')
    expect(start, 'REFRESH-MONEY-WIRING:START marker not found').toBeGreaterThan(-1)
    expect(end, 'REFRESH-MONEY-WIRING:END marker not found').toBeGreaterThan(start)
    const raw = src.slice(start, end)
    // Fix round 1 (reviewer I1): strip line comments before matching -- this is exactly what the
    // reviewer's mutation exploited (a comment mentioning the old code satisfying the positive
    // regex even though the real code no longer did).
    return raw.replace(/\/\/.*$/gm, '')
  }

  it('passes currentOwnerRef: realAddressRef and revisionRef: moneyRevisionRef verbatim, in real code, not merely in a comment', () => {
    const block = refreshMoneyWiringBlock()
    expect(block).toMatch(/currentOwnerRef:\s*realAddressRef\s*,/)
    expect(block).toMatch(/revisionRef:\s*moneyRevisionRef\b/)
    // The negative half: an inline object literal shaped like a dead ref (`{ current: ... }`)
    // anywhere in this block fails it, regardless of exact spelling -- catches the CLASS of
    // mutation, not one specific string.
    expect(block).not.toMatch(/\{\s*current\s*:/)
  })

  it("mutation guard: a dead-literal formulation (the reviewer's exact swap, restated differently) is rejected", () => {
    // Differently-written from the real bug -- a hand-written string standing in for a mutated
    // app.jsx, including a comment that MENTIONS the real code (the exact trick that defeated the
    // pre-fix-round guard) -- proves comment-stripping and the negative half both actually fire.
    const mutated = `
      // was: currentOwnerRef: realAddressRef,
      // was: revisionRef: moneyRevisionRef,
      await guardedMoneyFetch({
        ...moneyFetchArgs(owner, { currentOwnerRef: { current: owner }, revisionRef: { current: null } }),
        onCommit: (snapshot) => {},
      })
    `
    const stripped = mutated.replace(/\/\/.*$/gm, '')
    expect(stripped).not.toMatch(/currentOwnerRef:\s*realAddressRef\s*,/)
    expect(stripped).not.toMatch(/revisionRef:\s*moneyRevisionRef\b/)
    expect(stripped).toMatch(/\{\s*current\s*:/)
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

// ---------------------------------------------------------------------------------------------
// My Money Task 13 Part B item 5: hasLiveScopeForVault -- the withdraw-success scope-catch-up poll
// termination condition, extracted from app.jsx's handleWithdrawSuccess so it is unit-testable
// without a live rehydrateScopes() call. This is the ONE `pickVaultAgents` call site (of three)
// that could NOT migrate to the discovery-based `pickRecoverableVaultAgents` -- it operates on
// rehydrateScopes()'s own plain-scope shape ({agent, vault, revoked}), a different shape entirely
// from an OwnerDiscoveryV1 envelope ({address, vault, revoked, kind}).
// ---------------------------------------------------------------------------------------------
describe('hasLiveScopeForVault', () => {
  const V = 'CVAULT1'

  it('true when a non-revoked row is pinned to this vault', () => {
    const rows = [
      { agent: 'CA_ONE', vault: V, revoked: false },
      { agent: 'CA_TWO', vault: 'COTHER', revoked: false },
    ]
    expect(hasLiveScopeForVault(rows, V)).toBe(true)
  })

  // Mutation guard: dropping the `!s.revoked` check would make a just-swept (now revoked) agent
  // look "still live", so the poll would never terminate on its own real success condition.
  it('false when the only row for this vault is revoked (the poll may stop)', () => {
    const rows = [{ agent: 'CA_ONE', vault: V, revoked: true }]
    expect(hasLiveScopeForVault(rows, V)).toBe(false)
  })

  it('false for an empty/null rows array', () => {
    expect(hasLiveScopeForVault([], V)).toBe(false)
    expect(hasLiveScopeForVault(null, V)).toBe(false)
  })

  it('matches vault addresses case-insensitively, same as the deleted pickVaultAgents did', () => {
    expect(hasLiveScopeForVault([{ agent: 'CA_ONE', vault: 'cvault1', revoked: false }], V)).toBe(
      true
    )
  })

  it('a blank vaultAddress never matches anything (fail closed, not a wildcard)', () => {
    expect(hasLiveScopeForVault([{ agent: 'CA_ONE', vault: V, revoked: false }], '')).toBe(false)
  })
})

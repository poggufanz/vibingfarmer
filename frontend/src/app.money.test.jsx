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
//   - Task 10 (IA remap) C1: `toKeeperHeartbeatEvents` adapts `keeperActivity` into the
//     {type, closedAt} shape classifyKeeperAutomation actually requires, proven against the real
//     function (not a mock) so the fix stays honest about automationEvidence.js's real contract.
//   - a structural proof that `/home` renders MyMoneyRoute and `/agent` renders CrewRoute (Task 10
//     IA remap), never OpsConsole, and that OpsConsole's own console.css never reaches a production
//     route (source-level here; the bundle-scan proof for the SAME claim is run separately against
//     `npm run build`'s dist output — see the report).
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseFragment } from 'parse5'
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
  startPresentationClock,
  replaceMoneyFetchAbortController,
  toKeeperHeartbeatEvents,
  hasLiveScopeForVault,
} from './app.jsx'
import { buildMyMoneyModel } from './money/myMoneyModel.js'
import { nextReconciliationToken } from './money/freshness.js'
import { classifyKeeperAutomation } from './money/automationEvidence.js'
import { readOwnerMoney } from './money/readOwnerMoney.js'
import { MyMoneyRoute } from './components/money/MyMoneyRoute.jsx'
import { WithdrawDialog } from './components/money/WithdrawDialog.jsx'
import { StopAccessDialog } from './components/money/StopAccessDialog.jsx'
import { RecoveryPanel } from './components/money/RecoveryPanel.jsx'

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

  it('threads one abort signal through discovery and money hydration', async () => {
    const controller = new AbortController()
    const discovery = { status: 'complete', agents: [] }
    const discoverScopes = vi.fn(async () => discovery)
    const readMoney = vi.fn(async () => ({ status: 'complete', agents: [], checkedAt: 1 }))

    await fetchMyMoneySnapshot({
      owner: 'GA',
      signal: controller.signal,
      discoverScopes,
      readMoney,
    })

    expect(discoverScopes).toHaveBeenCalledWith({ owner: 'GA', signal: controller.signal })
    expect(readMoney).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GA', discovery, signal: controller.signal })
    )
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

describe('owner-switch money cancellation — aborts work, not only stale commits', () => {
  async function waitUntil(predicate) {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('condition was not reached')
  }

  it('aborts the prior owner controller and prevents its queued money RPCs from starting', async () => {
    const controllerRef = { current: null }
    const oldController = replaceMoneyFetchAbortController(controllerRef)
    const gates = Array.from({ length: 8 }, () => {
      let resolve
      const promise = new Promise((res) => {
        resolve = res
      })
      return { promise, resolve }
    })
    const started = []
    const rpc = async () => {
      const call = started.length
      started.push(call)
      if (call < gates.length) await gates[call].promise
      return 0n
    }
    const agents = Array.from({ length: 501 }, (_, index) => ({
      address: `COLD${String(index).padStart(3, '0')}`,
      scopeReadStatus: 'ok',
      vault: 'CVAULT',
      revoked: false,
      expiry: 9_999_999_999,
      authorized: true,
      association: 'unknown',
      baseChildren: [],
    }))
    const operation = readOwnerMoney({
      owner: 'GA',
      discovery: { status: 'complete', agents },
      signal: oldController.signal,
      stellar: {
        readVaultShares: rpc,
        readTokenBalance: rpc,
        readPricePerShare: async () => 10_000_000n,
        readSupplyAprBps: async () => null,
      },
      base: { loadIndexedBasePositions: async () => ({ status: 'empty', accounts: [] }) },
      now: 1,
    })

    await waitUntil(() => started.length >= 8)
    const newController = replaceMoneyFetchAbortController(controllerRef)
    for (const gate of gates) gate.resolve()

    expect(oldController.signal.aborted).toBe(true)
    expect(newController.signal.aborted).toBe(false)
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toHaveLength(8)
  })

  it('replaces an automatic-refresh child without aborting the owner-lifetime signal', () => {
    const ownerController = new AbortController()
    const controllerRef = { current: null }
    const firstRefresh = replaceMoneyFetchAbortController(controllerRef, {
      parentSignal: ownerController.signal,
    })
    const secondRefresh = replaceMoneyFetchAbortController(controllerRef, {
      parentSignal: ownerController.signal,
    })

    expect(firstRefresh.signal.aborted).toBe(true)
    expect(secondRefresh.signal.aborted).toBe(false)
    expect(ownerController.signal.aborted).toBe(false)

    const reason = new Error('owner epoch ended')
    ownerController.abort(reason)
    expect(secondRefresh.signal.aborted).toBe(true)
    expect(secondRefresh.signal.reason).toBe(reason)
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
// Task 10 (IA remap) C1: toKeeperHeartbeatEvents -- the adapter from this file's own
// {kind, timestamp}-shaped keeperActivity items into the {type, closedAt}-shaped events
// classifyKeeperAutomation (money/automationEvidence.js) actually filters on. Proven against the
// REAL classifyKeeperAutomation, not a re-implementation of its filter, so this fails honestly if
// either side's contract ever drifts again.
// ---------------------------------------------------------------------------------------------
describe('toKeeperHeartbeatEvents (Task 10 C1 fix)', () => {
  // Fix round 1 (reviewer C1-FIX): `timestamp` (read time) and `closedAt` (real ledger-close
  // time) are DELIBERATELY set to different ages below -- a fresh `timestamp` paired with a
  // stale `closedAt` is exactly the "cold-start replays an 11h-old lookback window" scenario the
  // reviewer described. If the adapter ever regresses to reading `e.timestamp` again, these two
  // tests fail (they'd wrongly see 'healthy'/the timestamp-derived heartbeat time instead).
  it('maps a real keeperActivity compound item using closedAt (real ledger-close time), never timestamp (read time)', () => {
    const now = 1_000_000_000
    const keeperActivity = [
      {
        id: 'compound:42',
        kind: 'compound_executed',
        vaultName: 'Autofarm vault',
        totalGainUsdc: '1.23',
        timestamp: now, // read just now (e.g. cold-start replaying an old ledger event)
        closedAt: now - 60_000, // but the ledger actually closed 1 minute ago -- still healthy
      },
    ]
    const result = classifyKeeperAutomation({
      events: toKeeperHeartbeatEvents(keeperActivity),
      now,
    })
    expect(result.label).toBe('healthy')
    expect(result.lastHeartbeatAt).toBe(now - 60_000)
  })

  it('a stale closedAt reads as stale even when timestamp (read time) is fresh', () => {
    const now = 1_000_000_000
    const keeperActivity = [
      {
        id: 'rebalance:7',
        kind: 'rebalance_executed',
        timestamp: now, // this poll just read it...
        closedAt: now - 60 * 60_000, // ...but the ledger closed 1h ago -- the cron may be dead
      },
    ]
    const result = classifyKeeperAutomation({
      events: toKeeperHeartbeatEvents(keeperActivity),
      now,
    })
    expect(result.label).toBe('stale')
    expect(result.lastHeartbeatAt).toBe(now - 60 * 60_000)
  })

  it('an event with no closedAt at all (record had no ledgerClosedAt) reads unavailable, never a manufactured heartbeat from timestamp', () => {
    const now = 1_000_000_000
    const keeperActivity = [
      { id: 'compound:1', kind: 'compound_executed', timestamp: now, closedAt: undefined },
    ]
    expect(
      classifyKeeperAutomation({ events: toKeeperHeartbeatEvents(keeperActivity), now }).label
    ).toBe('unavailable')
  })

  it('drops non-heartbeat kinds (vault_derisk etc.) -- they carry no compound/rebalance evidence', () => {
    const now = 1_000_000_000
    const keeperActivity = [{ id: 'vault_derisk:1', kind: 'vault_derisk', closedAt: now }]
    expect(toKeeperHeartbeatEvents(keeperActivity)).toEqual([])
    expect(
      classifyKeeperAutomation({ events: toKeeperHeartbeatEvents(keeperActivity), now }).label
    ).toBe('unavailable')
  })

  // Mutation guard: this is the literal bug being fixed -- feeding classifyKeeperAutomation the
  // RAW keeperActivity shape (no adapter) reproduces the production defect, label pinned to
  // 'unavailable' no matter how fresh the event.
  it('regression proof: the raw keeperActivity shape (no adapter) always reads unavailable', () => {
    const now = 1_000_000_000
    const keeperActivity = [
      { id: 'compound:42', kind: 'compound_executed', closedAt: now - 60_000 },
    ]
    expect(classifyKeeperAutomation({ events: keeperActivity, now }).label).toBe('unavailable')
  })

  it('empty/null keeperActivity maps to an empty array, never throws', () => {
    expect(toKeeperHeartbeatEvents([])).toEqual([])
    expect(toKeeperHeartbeatEvents(null)).toEqual([])
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
    expect(loadMoneyCache('gowner')).toEqual({ money: { checkedAt: 1 }, __schemaVersion: 2 })
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
  // Final review, Fix 2: a cache written before the schema was versioned (no `__schemaVersion` at
  // all -- exactly the pre-Task-10 shape whose `discovery` rows have no `baseChildren` key) must
  // be treated as a cache miss, never trusted at its old shape. Same for a version stamped by some
  // future/other schema this reader doesn't recognize.
  it('a cache with no schema version (pre-versioning shape) is a cache miss, not trusted data', () => {
    store[`yv_my_money_cache_gold`] = JSON.stringify({ money: { checkedAt: 1 }, discovery: {} })
    expect(loadMoneyCache('GOld')).toEqual({})
  })
  it('a cache stamped with a mismatched schema version is a cache miss', () => {
    store[`yv_my_money_cache_gmismatch`] = JSON.stringify({
      money: { checkedAt: 1 },
      __schemaVersion: 1,
    })
    expect(loadMoneyCache('GMismatch')).toEqual({})
  })
})

// ---------------------------------------------------------------------------------------------
// Task 10 (IA remap): `/home` renders MyMoneyRoute, `/agent` renders CrewRoute -- neither ever
// OpsConsole. app.jsx is too heavy to render (see header comment), so this is a structural source
// assertion scoped to JUST each Route's own element block — proven adversarially by checking each
// block never re-admits OpsConsole (or the other route's component) even if still
// imported/used elsewhere in dev-only code.
// ---------------------------------------------------------------------------------------------
describe('/home & /agent route source: MyMoneyRoute moved to /home, /agent is now CrewRoute', () => {
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

  it('the /home route element mounts <MyMoneyRoute', () => {
    const homeRoute = routeBlock('/home')
    expect(homeRoute).toMatch(/<MyMoneyRoute/)
    expect(homeRoute).toMatch(/agents=\{moneyRead\?\.agents \?\? \[\]\}/)
    expect(homeRoute).not.toMatch(/agents=\{crewAgents\}/)
  })

  it('the /agent route element mounts <CrewRoute, never <MyMoneyRoute', () => {
    const agentRoute = routeBlock('/agent')
    expect(agentRoute).toMatch(/<CrewRoute/)
    expect(agentRoute).toMatch(/crew=\{crew\}/)
    expect(agentRoute).not.toMatch(/<MyMoneyRoute/)
  })

  it('neither /home nor /agent ever mounts <OpsConsole', () => {
    expect(routeBlock('/home')).not.toMatch(/<OpsConsole/)
    expect(routeBlock('/agent')).not.toMatch(/<OpsConsole/)
  })

  it('OpsConsole is not imported as a top-level lazy production route (kept only inside its own retired file)', () => {
    expect(src).not.toMatch(/const OpsConsole = lazy/)
  })

  it('HomePage is retired -- no longer imported or rendered by app.jsx', () => {
    expect(src).not.toMatch(/import HomePage/)
    expect(src).not.toMatch(/<HomePage/)
  })
})

// Task 5 fix round 2: expiry labels are presentation-only time, never the stale source read clock.
// The heavy App component is not rendered here; its source seam and the small clock helper are
// tested directly so this cannot silently drop explicit nowMs wiring or leak a live interval.
describe('My Money presentation clock wiring', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  it('passes the explicit UI presentation clock into the real /home MyMoneyRoute', () => {
    const start = src.indexOf('path="/home"')
    const end = src.indexOf('<Route', start + 1)
    const homeRoute = src.slice(start, end)
    expect(homeRoute).toMatch(/<MyMoneyRoute[\s\S]*nowMs=\{presentationNowMs\}/)
    expect(src).toMatch(
      /useE\(\(\) => startPresentationClock\(\{ setNow: setPresentationNowMs \}\), \[\]\)/
    )
  })

  it('advances only from finite injected time and stops scheduling after cleanup', () => {
    let tick
    const schedule = vi.fn((callback, intervalMs) => {
      tick = callback
      expect(intervalMs).toBe(1000)
      return 'presentation-clock'
    })
    const cancel = vi.fn()
    const setNow = vi.fn()
    const readNow = vi.fn(() => 1_725_000_000_000)
    const stop = startPresentationClock({ setNow, readNow, schedule, cancel })

    tick()
    expect(setNow).toHaveBeenCalledWith(1_725_000_000_000)
    stop()
    tick()
    expect(setNow).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('presentation-clock')
  })

  it('rejects an invalid presentation clock reading instead of exposing a non-finite prop', () => {
    let tick
    const schedule = vi.fn((callback) => {
      tick = callback
      return 'invalid-clock'
    })
    const setNow = vi.fn()
    const stop = startPresentationClock({
      setNow,
      readNow: () => Number.NaN,
      schedule,
      cancel: vi.fn(),
    })
    tick()
    stop()
    expect(setNow).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// Task 10, carried finding C2: onViewMoney ("Back to my money") and onViewCrew ("Watch the crew")
// used to both navigate('/agent') -- the same screen -- once /agent became the crew route. Proven
// at the source level (app.jsx too heavy to render, see header comment): each handler's own
// function body must navigate to its OWN distinct destination.
// ---------------------------------------------------------------------------------------------
describe('onViewMoney / onViewCrew (Task 10 C2 fix): distinct destinations, never a duplicate', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function fnBody(name) {
    const marker = `function ${name}(`
    const start = src.indexOf(marker)
    expect(start, `${name} not found in app.jsx`).toBeGreaterThan(-1)
    const end = src.indexOf('\n  }', start)
    return src.slice(start, end)
  }

  it('onViewMoney navigates to /home, not /agent', () => {
    expect(fnBody('onViewMoney')).toMatch(/navigate\(['"]\/home['"]\)/)
    expect(fnBody('onViewMoney')).not.toMatch(/navigate\(['"]\/agent['"]\)/)
  })

  it('onViewCrew (StartStage prop, inline arrow) still targets /agent', () => {
    const marker = 'onViewCrew: () => navigate('
    const idx = src.indexOf(marker)
    expect(idx, 'onViewCrew wiring not found in app.jsx').toBeGreaterThan(-1)
    expect(src.slice(idx, idx + marker.length + 12)).toMatch(/navigate\(['"]\/agent['"]\)/)
  })
})

// ---------------------------------------------------------------------------------------------
// Fix round 1, F3: the session-resumed banner's Dismiss button must carry a real control class --
// a classless <button> inherits style.css's `button { border: none; background: none }` reset
// with no zero-specificity :where(...) 44px floor to catch it, so it rendered as bare text with no
// touch target. app.jsx is too heavy to render (see file header), so this is a source-level proof
// scoped to the banner's own JSX block.
// ---------------------------------------------------------------------------------------------
describe('session-resumed banner Dismiss button (Task 10 F3 fix)', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function bannerBlock() {
    const start = src.indexOf('pc-resumed-banner')
    expect(start, 'pc-resumed-banner not found in app.jsx').toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('</div>', start))
  }

  it('the Dismiss button carries the pc-button/pc-button--secondary control classes', () => {
    expect(bannerBlock()).toMatch(/className="pc-button pc-button--secondary"/)
  })
})

// ---------------------------------------------------------------------------------------------
// Task 18: Sidebar and CrewRoute must consume the same projected Crew read model. The
// productive-membership predicate belongs to buildCrewPersonas.js and is covered by executable
// projection/App/Crew tests; this source check only freezes the single route-composition seam.
// ---------------------------------------------------------------------------------------------
describe('Crew route composition (Task 18): Sidebar and /agent share one Crew projection', () => {
  const src = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')

  function routeBlock(routePath) {
    const marker = `path="${routePath}"`
    const start = src.indexOf(marker)
    expect(start, `Route ${routePath} not found in app.jsx`).toBeGreaterThan(-1)
    const nextRoute = src.indexOf('<Route', start + marker.length)
    return src.slice(start, nextRoute === -1 ? src.length : nextRoute)
  }

  it('passes the projected activeCount to Sidebar', () => {
    expect(src).toMatch(/<Sidebar[\s\S]*agentCount=\{crew\.activeCount\}/)
  })

  it('passes the same projected crew object to /agent CrewRoute', () => {
    expect(routeBlock('/agent')).toMatch(/<CrewRoute[\s\S]*crew=\{crew\}/)
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

// ---------------------------------------------------------------------------------------------
// Task 5 route/dialog reachability: the real My Money route and the three real action/recovery
// surfaces are composed as siblings in app.jsx.  app.jsx itself is intentionally too heavy for a
// browser render in this node suite, so this mounts the actual production components as a React
// fragment (not a fabricated wrapper), then parses the resulting DOM tree and checks the exact
// sibling relationship.  The source assertion pins the same composition seam that the fragment
// exercises, while the stylesheet assertions pin the route-owned geometry required at 320px.
// ---------------------------------------------------------------------------------------------
describe('hoisted money-dialog siblings and direct geometry', () => {
  const appSource = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')
  const moneyCss = fs.readFileSync(path.resolve(here, './components/money/my-money.css'), 'utf8')

  function hasClass(node, className) {
    return (
      node.nodeName !== '#text' &&
      node.attrs?.some(
        (attribute) =>
          attribute.name === 'class' && attribute.value.split(/\s+/).includes(className)
      )
    )
  }

  function descendants(node, predicate, found = []) {
    if (predicate(node)) found.push(node)
    for (const child of node.childNodes ?? []) descendants(child, predicate, found)
    return found
  }

  function renderActualMoneyFragment() {
    const model = buildMyMoneyModel({ owner: null })
    const fragment = React.createElement(
      React.Fragment,
      null,
      React.createElement(MyMoneyRoute, { model, agents: [], discovery: null, account: null }),
      React.createElement(WithdrawDialog, { open: true, onClose: () => {}, agents: [] }),
      React.createElement(StopAccessDialog, { open: true, onClose: () => {}, agent: null }),
      React.createElement(RecoveryPanel, { open: true, onClose: () => {}, location: 'unknown' })
    )
    return parseFragment(renderToStaticMarkup(fragment))
  }

  it('renders the actual route plus all three actual dialogs as direct fragment siblings', () => {
    const root = renderActualMoneyFragment()
    const elementChildren = (root.childNodes ?? []).filter((node) => node.nodeName !== '#text')
    const route = elementChildren.find((node) => hasClass(node, 'pc-my-money-route'))
    const dialogs = elementChildren.filter((node) => hasClass(node, 'pc-money-dialog'))

    expect(route).toBeDefined()
    expect(dialogs).toHaveLength(3)
    expect(dialogs.every((dialog) => !route.childNodes?.includes(dialog))).toBe(true)
    expect(
      dialogs.every(
        (dialog) => descendants(dialog, (node) => hasClass(node, 'pc-dialog-panel')).length === 1
      )
    ).toBe(true)
    expect(
      dialogs.every(
        (dialog) => descendants(dialog, (node) => hasClass(node, 'pc-dialog-actions')).length === 1
      )
    ).toBe(true)
  })

  it('keeps the app composition hoisted after Routes and the direct money-dialog geometry', () => {
    const routesEnd = appSource.indexOf('</Routes>')
    const hoisted = appSource.slice(routesEnd)
    expect(routesEnd).toBeGreaterThan(-1)
    expect(hoisted).toMatch(/<WithdrawDialog[\s\S]*<StopAccessDialog[\s\S]*<RecoveryPanel/)
    expect(hoisted).not.toMatch(/pc-my-money-route[\s\S]*<WithdrawDialog/)
    expect(moneyCss).toMatch(
      /\.pc-dialog\.pc-money-dialog\s*\{[\s\S]*?z-index:\s*var\(--pc-z-dialog\)/
    )
    expect(moneyCss).toMatch(
      /\.pc-money-dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?width:\s*min\(100%,\s*480px\)/
    )
    expect(moneyCss).toMatch(
      /\.pc-money-dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\(760px,/
    )
    expect(moneyCss).toMatch(/max-height:\s*88dvh/)
    expect(moneyCss).toMatch(/env\(safe-area-inset-bottom\)/)
  })
})

// Core Task 6 integration handoff: the app keeps the three money surfaces hoisted, but each
// caller-owned open flag must still produce one semantic overlay at a time. The Foundation Dialog
// owns focus, Escape, backdrop, inertness, and body scroll locking; this SSR handoff test freezes
// the route-owned seam without reimplementing any of those mechanics in app.jsx.
describe('Task 6 money overlay handoff — one semantic overlay per open state', () => {
  const appSource = fs.readFileSync(path.resolve(here, './app.jsx'), 'utf8')
  const componentSources = [
    fs.readFileSync(path.resolve(here, './components/money/WithdrawDialog.jsx'), 'utf8'),
    fs.readFileSync(path.resolve(here, './components/money/StopAccessDialog.jsx'), 'utf8'),
    fs.readFileSync(path.resolve(here, './components/money/RecoveryPanel.jsx'), 'utf8'),
  ]

  function hasClass(node, className) {
    return (
      node.nodeName !== '#text' &&
      node.attrs?.some(
        (attribute) =>
          attribute.name === 'class' && attribute.value.split(/\s+/).includes(className)
      )
    )
  }

  function descendants(node, predicate, found = []) {
    if (predicate(node)) found.push(node)
    for (const child of node.childNodes ?? []) descendants(child, predicate, found)
    return found
  }

  function attr(node, name) {
    return node.attrs?.find((attribute) => attribute.name === name)?.value
  }

  function renderOverlay(kind) {
    const active = {
      withdraw: React.createElement(WithdrawDialog, {
        open: true,
        onClose: () => {},
        agents: [
          {
            address: 'CAGENT1',
            amount: amount('100000000'),
            custody: { location: 'stellar-vault' },
            custodyBreakdown: [{ location: 'stellar-vault', amount: amount('100000000') }],
          },
        ],
        discovery: { status: 'complete', agents: [{ address: 'CAGENT1', scopeReadStatus: 'ok' }] },
        account: { kind: 'G', address: 'GOWNER' },
        onConfirmFull: () => {},
      }),
      stop: React.createElement(StopAccessDialog, {
        open: true,
        onClose: () => {},
        agent: { address: 'CAGENT1', custody: { location: 'stellar-vault' }, custodyBreakdown: [] },
        shareRead: { state: 'known', amount: amount('0') },
        idleBalanceRead: { state: 'known', amount: amount('0') },
        account: { kind: 'G', address: 'GOWNER' },
        onConfirmRevoke: () => {},
      }),
      recovery: React.createElement(RecoveryPanel, {
        open: true,
        onClose: () => {},
        location: 'unknown',
        submission: { outcome: 'unknown', hash: '11'.repeat(32) },
        onCheckStatus: () => {},
      }),
    }
    const fragment = React.createElement(
      React.Fragment,
      null,
      React.createElement(MyMoneyRoute, {
        model: buildMyMoneyModel({ owner: null }),
        agents: [],
        discovery: null,
        account: null,
      }),
      active[kind]
    )
    const root = parseFragment(renderToStaticMarkup(fragment))
    return (root.childNodes ?? []).filter(
      (node) => node.nodeName !== '#text' && hasClass(node, 'pc-money-dialog')
    )[0]
  }

  it.each(['withdraw', 'stop', 'recovery'])(
    'keeps %s as one semantic dialog with ordered actions',
    (kind) => {
      const dialog = renderOverlay(kind)
      expect(dialog).toBeDefined()
      expect(attr(dialog, 'role')).toBe('dialog')
      expect(attr(dialog, 'aria-modal')).toBe('true')
      expect(attr(dialog, 'aria-labelledby')).toBeTruthy()
      expect(attr(dialog, 'aria-describedby')).toBeTruthy()
      const panels = descendants(dialog, (node) => hasClass(node, 'pc-dialog-panel'))
      expect(panels).toHaveLength(1)
      const actions = descendants(dialog, (node) => hasClass(node, 'pc-dialog-actions'))
      expect(actions).toHaveLength(1)
      const buttons = descendants(actions[0], (node) => node.nodeName === 'button')
      expect(buttons.length).toBeGreaterThan(0)
      expect(buttons[0].childNodes?.map((node) => node.value || '').join('')).toMatch(
        /cancel|close/i
      )
    }
  )

  it('does not add a second money overlay or local backdrop/lock implementation', () => {
    // MemoryModal is an unrelated, pre-existing agent-memory surface. Task 6 does not add a
    // second money path beside the three hoisted components below.
    expect(appSource).toMatch(/<WithdrawDialog[\s\S]*<StopAccessDialog[\s\S]*<RecoveryPanel/)
    expect(componentSources.every((source) => !source.includes('modal-backdrop'))).toBe(true)
    expect(
      componentSources.every((source) => !source.match(/document\.body\.style\.overflow/))
    ).toBe(true)
  })
})

# Strategy Wizard DAG Parallel Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/strategy` wizard's ad-hoc 3-way `Promise.all` with an explicit EvoAgentX-style DAG fetch layer where independent fetch nodes (pools, gas, positions, market) run in one concurrent layer and derived nodes (on-chain signals) run after their deps resolve — adding the two missing real fetch nodes (gas price, positions) and a real combined on-chain signals node.

**Architecture:** A new pure DAG runner (`runFetchDag`) executes nodes in dependency layers via `Promise.allSettled`, isolating each node so one failure yields `null` and never aborts siblings. A thin `runStrategyFetchDag` wires the concrete strategy nodes and injects `loadVaultSkill` / `fetchMarketContext` from `venice.js` to avoid a circular import. `generateStrategy` (the axis — stays the consumer) calls the DAG instead of its inline `Promise.all`, and `app.jsx` passes the connected wallet address plus logs the real wall-time-vs-sequential win. Gas and signals become real chain-derived inputs to the existing MDP state.

**Tech Stack:** Vanilla ES modules, ethers v6 (`getReadProvider().getFeeData()`), Vitest. No new dependencies.

---

## Background: current state (read before starting)

- `frontend/src/venice.js:80` `generateStrategy(...)` already parallelizes 3 nodes at line 87: `loadVaultSkill()`, `fetchMarketContext(riskLevel)`, `fetchDeFiLlamaVaults()`. This is the live result of the prior `2026-06-04-step3-parallel-fetch.md` plan.
- Missing from the concurrent set (per the EvoAgentX narrative): **gas price** (never fetched in the wizard), **positions** (`reconcilePositionsFromChain` lives in `positionsStore.js`, called only in the agent lifecycle in `app.jsx`), and **on-chain signals** (today `deriveTurbulence(marketContext)` in `mdp.js` only text-scans the market string — no chain read).
- `frontend/src/app.jsx:579` calls `generateStrategy(...)` from the "thinking" effect. Wallet is usually not connected yet at this step, so the positions node will frequently resolve `null` — that is expected and handled gracefully.
- `frontend/src/readProvider.js` exposes `getReadProvider()` — the dedicated read-only Base Sepolia provider that must be used for all concurrent reads (never `BrowserProvider`).
- `frontend/src/strategy/mdp.js:29` `deriveTurbulence(marketContext)` returns `{ turbulence, signals }` and is covered by `mdp.test.js`. Keep it; add a new `deriveSignals` beside it.
- Tests use Vitest (`import { describe, it, expect } from 'vitest'`). Run from `frontend/`.

### File structure (created / modified)

- **Create** `frontend/src/strategy/fetchDag.js` — pure DAG runner (`runFetchDag`) + strategy node graph (`runStrategyFetchDag`).
- **Create** `frontend/src/strategy/fetchDag.test.js` — runner unit tests (concurrency, isolation, dependency order).
- **Create** `frontend/src/strategy/gasSnapshot.js` — `fetchGasSnapshot()` via `getFeeData`.
- **Create** `frontend/src/strategy/gasSnapshot.test.js` — gwei mapping + level thresholds.
- **Modify** `frontend/src/strategy/mdp.js` — add `deriveSignals(marketContext, gas)`.
- **Modify** `frontend/src/strategy/mdp.test.js` — add `deriveSignals` cases.
- **Modify** `frontend/src/venice.js:80-95,149-171` — replace inline `Promise.all` with `runStrategyFetchDag`, thread `address`, merge gas + signals into `mdpState`.
- **Modify** `frontend/src/app.jsx:579-586` — pass `address: realAddress`, log DAG wall-time.

---

## Task 1: Gas snapshot fetch node

**Files:**
- Create: `frontend/src/strategy/gasSnapshot.js`
- Test: `frontend/src/strategy/gasSnapshot.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/strategy/gasSnapshot.test.js
import { describe, it, expect, vi } from 'vitest'

// Mock the read provider so no real RPC call is made.
const getFeeData = vi.fn()
vi.mock('../readProvider.js', () => ({
  getReadProvider: () => ({ getFeeData }),
}))

import { fetchGasSnapshot } from './gasSnapshot.js'

describe('fetchGasSnapshot', () => {
  it('maps wei gasPrice to gwei and "normal" level', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 12_000_000_000n, maxFeePerGas: null })
    const snap = await fetchGasSnapshot()
    expect(snap.gwei).toBe(12)
    expect(snap.level).toBe('normal')
  })

  it('flags "elevated" at >=30 gwei', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 45_000_000_000n })
    expect((await fetchGasSnapshot()).level).toBe('elevated')
  })

  it('flags "high" at >=80 gwei', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 120_000_000_000n })
    expect((await fetchGasSnapshot()).level).toBe('high')
  })

  it('falls back to maxFeePerGas when gasPrice is null', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: null, maxFeePerGas: 5_000_000_000n })
    expect((await fetchGasSnapshot()).gwei).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/gasSnapshot.test.js`
Expected: FAIL — `Failed to resolve import "./gasSnapshot.js"` / `fetchGasSnapshot is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/strategy/gasSnapshot.js
// Live gas-price snapshot for the /strategy DAG. An independent fetch node:
// reads Base Sepolia fee data through the dedicated read-only provider (never the
// wallet's BrowserProvider) and classifies congestion. Never throws — the DAG
// runner isolates failures, but we keep the contract simple for direct callers.

import { getReadProvider } from '../readProvider.js'

const ELEVATED_GWEI = 30
const HIGH_GWEI = 80

/**
 * @returns {Promise<{ gwei:number, level:'normal'|'elevated'|'high' }>}
 */
export async function fetchGasSnapshot() {
  const provider = getReadProvider()
  const fee = await provider.getFeeData()
  const wei = fee.gasPrice ?? fee.maxFeePerGas ?? 0n
  const gwei = Number(wei) / 1e9
  const level = gwei >= HIGH_GWEI ? 'high' : gwei >= ELEVATED_GWEI ? 'elevated' : 'normal'
  return { gwei: Number(gwei.toFixed(2)), level }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/gasSnapshot.test.js`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/gasSnapshot.js frontend/src/strategy/gasSnapshot.test.js
git commit -m "feat: add live gas snapshot fetch node for strategy DAG"
```

---

## Task 2: Combined on-chain signals (`deriveSignals`)

**Files:**
- Modify: `frontend/src/strategy/mdp.js` (add `deriveSignals` after `deriveTurbulence`, ~line 38)
- Test: `frontend/src/strategy/mdp.test.js` (add a new `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/mdp.test.js`. Add `deriveSignals` to the existing import on line 2 so it reads:

```javascript
import { normalizeRisk, deriveTurbulence, deriveSignals, buildStrategyState, RISK_RANK } from './mdp.js'
```

Then append this block at the end of the file:

```javascript
describe('deriveSignals (market context + on-chain gas)', () => {
  it('returns calm with no signals when market is benign and gas normal', () => {
    const r = deriveSignals('yields stable', { level: 'normal', gwei: 10 })
    expect(r.turbulence).toBe('calm')
    expect(r.signals).toEqual([])
  })

  it('adds a gas-spike signal and bumps calm -> elevated on high gas', () => {
    const r = deriveSignals('yields stable', { level: 'high', gwei: 95 })
    expect(r.turbulence).toBe('elevated')
    expect(r.signals).toContain('gas-spike')
  })

  it('keeps turbulent from market context even when gas is high', () => {
    const r = deriveSignals('exploit drained the pool', { level: 'high', gwei: 95 })
    expect(r.turbulence).toBe('turbulent')
    expect(r.signals).toContain('exploit')
    expect(r.signals).toContain('gas-spike')
  })

  it('tolerates a null gas snapshot (chain read failed)', () => {
    const r = deriveSignals('markets volatile', null)
    expect(r.turbulence).toBe('elevated')
    expect(r.signals).not.toContain('gas-spike')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: FAIL — `deriveSignals is not a function` (import is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/strategy/mdp.js`, immediately after the closing `}` of `deriveTurbulence` (line 38), add:

```javascript
/**
 * Combined on-chain signal: market-context turbulence augmented by live gas.
 * A high gas snapshot adds a 'gas-spike' signal and lifts an otherwise-calm
 * regime to 'elevated' (network congestion ~ execution risk). Market-context
 * turbulence always dominates. Pure — no network, no storage.
 * @param {string|null} marketContext
 * @param {{ level:'normal'|'elevated'|'high', gwei:number }|null} gas
 * @returns {{ turbulence:'calm'|'elevated'|'turbulent', signals:string[] }}
 */
export function deriveSignals(marketContext, gas) {
  const base = deriveTurbulence(marketContext)
  const signals = [...base.signals]
  let turbulence = base.turbulence
  if (gas && gas.level === 'high') {
    if (!signals.includes('gas-spike')) signals.push('gas-spike')
    if (turbulence === 'calm') turbulence = 'elevated'
  }
  return { turbulence, signals }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: PASS (existing `deriveTurbulence` cases + 4 new `deriveSignals` cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/mdp.js frontend/src/strategy/mdp.test.js
git commit -m "feat: derive combined on-chain signals from market context and gas"
```

---

## Task 3: DAG runner (`runFetchDag`)

**Files:**
- Create: `frontend/src/strategy/fetchDag.js`
- Test: `frontend/src/strategy/fetchDag.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/strategy/fetchDag.test.js
import { describe, it, expect } from 'vitest'
import { runFetchDag } from './fetchDag.js'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

describe('runFetchDag', () => {
  it('runs independent nodes in one concurrent layer (all start before any ends)', async () => {
    const events = []
    const mk = (id) => ({
      id, deps: [],
      run: async () => { events.push(`start:${id}`); await tick(10); events.push(`end:${id}`); return id },
    })
    const { results } = await runFetchDag([mk('a'), mk('b'), mk('c')])
    expect(results).toEqual({ a: 'a', b: 'b', c: 'c' })
    // Concurrency proof: the three starts all precede the first end.
    const firstEnd = events.findIndex((e) => e.startsWith('end:'))
    const startsBeforeFirstEnd = events.slice(0, firstEnd).filter((e) => e.startsWith('start:'))
    expect(startsBeforeFirstEnd).toHaveLength(3)
  })

  it('isolates a failing node as null without aborting siblings', async () => {
    const nodes = [
      { id: 'ok', deps: [], run: async () => 'value' },
      { id: 'bad', deps: [], run: async () => { throw new Error('boom') } },
    ]
    const { results } = await runFetchDag(nodes)
    expect(results.ok).toBe('value')
    expect(results.bad).toBeNull()
  })

  it('runs a dependent node only after its dep resolves, passing the dep value', async () => {
    const order = []
    const nodes = [
      { id: 'market', deps: [], run: async () => { order.push('market'); return 'ctx' } },
      { id: 'signals', deps: ['market'], run: async (ctx) => { order.push('signals'); return `sig:${ctx.market}` } },
    ]
    const { results } = await runFetchDag(nodes)
    expect(order).toEqual(['market', 'signals'])
    expect(results.signals).toBe('sig:ctx')
  })

  it('reports timings and a wall time no larger than the slowest layer plus slack', async () => {
    const nodes = [
      { id: 'fast', deps: [], run: async () => { await tick(10); return 1 } },
      { id: 'slow', deps: [], run: async () => { await tick(40); return 2 } },
    ]
    const { timings, wallMs } = await runFetchDag(nodes)
    expect(timings.slow).toBeGreaterThanOrEqual(timings.fast)
    // Parallel: wall ~= slowest (40ms), far below the 50ms sequential sum.
    expect(wallMs).toBeLessThan(timings.fast + timings.slow)
  })

  it('fails unsatisfiable nodes as null instead of hanging', async () => {
    const nodes = [{ id: 'orphan', deps: ['missing'], run: async () => 'never' }]
    const { results } = await runFetchDag(nodes)
    expect(results.orphan).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/fetchDag.test.js`
Expected: FAIL — `Failed to resolve import "./fetchDag.js"`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/strategy/fetchDag.js
// EvoAgentX-inspired DAG fetch layer for the /strategy wizard.
// Independent fetch nodes run together in one Promise.allSettled layer; derived
// nodes run once their deps resolve. Each node is isolated — a thrown/rejected
// node yields null and never aborts siblings. Pure orchestration: nodes inject
// their own side-effectful fetchers, so this file has no network/storage imports.
//
// Why a DAG and not a flat Promise.all: pools, gas, positions and market are
// genuinely independent (one concurrent layer), but on-chain signals depend on
// BOTH market context and gas, so it must run in a second layer. A flat Promise.all
// can't express that ordering; the layered runner can, and stays parallel where it
// can (4 fetches at ~max(latency) instead of sum).

/**
 * @typedef {Object} FetchNode
 * @property {string} id
 * @property {string[]} deps                     // node ids this one waits for
 * @property {(ctx: Object) => Promise<any>} run // ctx = base inputs + resolved dep values
 */

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
}

/**
 * Execute a DAG of fetch nodes layer by layer. Each layer = every not-yet-run
 * node whose deps are all resolved; they run concurrently via Promise.allSettled.
 * A node's result is its resolved value, or null on failure / unsatisfiable deps.
 *
 * @param {FetchNode[]} nodes
 * @param {Object} [base]                  // inputs every node.run receives in ctx
 * @param {(ev:{id:string,phase:'start'|'end',ms?:number,ok?:boolean})=>void} [onEvent]
 * @returns {Promise<{ results:Object, timings:Object, wallMs:number }>}
 */
export async function runFetchDag(nodes, base = {}, onEvent) {
  const results = {}
  const timings = {}
  const done = new Set()
  const wallStart = now()

  let remaining = nodes.slice()
  while (remaining.length) {
    const ready = remaining.filter((n) => n.deps.every((d) => done.has(d)))

    if (ready.length === 0) {
      // No node can advance (missing/cyclic dep) — resolve the rest as null
      // rather than hang the wizard.
      for (const n of remaining) { results[n.id] = null; done.add(n.id) }
      break
    }

    await Promise.allSettled(ready.map(async (n) => {
      const start = now()
      onEvent?.({ id: n.id, phase: 'start' })
      try {
        const ctx = { ...base }
        for (const d of n.deps) ctx[d] = results[d]
        results[n.id] = await n.run(ctx)
        timings[n.id] = now() - start
        onEvent?.({ id: n.id, phase: 'end', ms: timings[n.id], ok: true })
      } catch {
        results[n.id] = null
        timings[n.id] = now() - start
        onEvent?.({ id: n.id, phase: 'end', ms: timings[n.id], ok: false })
      }
    }))

    for (const n of ready) done.add(n.id)
    remaining = remaining.filter((n) => !done.has(n.id))
  }

  return { results, timings, wallMs: now() - wallStart }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/fetchDag.test.js`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/fetchDag.js frontend/src/strategy/fetchDag.test.js
git commit -m "feat: add layered DAG runner for concurrent strategy fetches"
```

---

## Task 4: Strategy node graph (`runStrategyFetchDag`)

**Files:**
- Modify: `frontend/src/strategy/fetchDag.js` (append `runStrategyFetchDag`)
- Test: `frontend/src/strategy/fetchDag.test.js` (append a `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/fetchDag.test.js`. Mock the three standalone fetch modules, then import the new function:

```javascript
import { vi } from 'vitest'

vi.mock('../defiLlama.js', () => ({
  fetchDeFiLlamaVaults: vi.fn(async () => [{ address: '0xV', apy: 5 }]),
}))
vi.mock('../positionsStore.js', () => ({
  reconcilePositionsFromChain: vi.fn(async () => ({ '0xV': { balance: '1000000' } })),
}))
vi.mock('./gasSnapshot.js', () => ({
  fetchGasSnapshot: vi.fn(async () => ({ gwei: 95, level: 'high' })),
}))

import { runStrategyFetchDag } from './fetchDag.js'

describe('runStrategyFetchDag', () => {
  const deps = {
    loadVaultSkill: async () => ({ content: 'SKILL', source: 'default' }),
    fetchMarketContext: async () => 'yields stable',
  }

  it('gathers all nodes and derives signals from market + gas', async () => {
    const out = await runStrategyFetchDag({
      riskLevel: 'medium', address: '0xUser',
      useStaticVaults: false, marketContextEnabled: true,
      ...deps,
    })
    expect(out.pools).toEqual([{ address: '0xV', apy: 5 }])
    expect(out.gas.level).toBe('high')
    expect(out.positions).toEqual({ '0xV': { balance: '1000000' } })
    expect(out.marketContext).toBe('yields stable')
    // signals = deriveSignals('yields stable', { level:'high' }) -> elevated + gas-spike
    expect(out.signals.turbulence).toBe('elevated')
    expect(out.signals.signals).toContain('gas-spike')
    expect(typeof out.wallMs).toBe('number')
  })

  it('skips pools when static vaults are selected and skips positions with no address', async () => {
    const out = await runStrategyFetchDag({
      riskLevel: 'low', address: null,
      useStaticVaults: true, marketContextEnabled: false,
      ...deps,
    })
    expect(out.pools).toBeNull()
    expect(out.positions).toBeNull()
    expect(out.marketContext).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/fetchDag.test.js`
Expected: FAIL — `runStrategyFetchDag is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/fetchDag.js`:

```javascript
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { reconcilePositionsFromChain } from '../positionsStore.js'
import { fetchGasSnapshot } from './gasSnapshot.js'
import { deriveSignals } from './mdp.js'

/**
 * Build and run the concrete /strategy fetch DAG.
 *
 * Layer 0 (independent, concurrent): skill, pools, gas, positions, market.
 * Layer 1 (derived): signals = deriveSignals(market, gas).
 *
 * loadVaultSkill and fetchMarketContext are injected (they live in venice.js) to
 * keep this module free of a circular import back into the strategy axis.
 *
 * @param {Object} p
 * @param {string} p.riskLevel
 * @param {string|null} p.address                // connected wallet, or null pre-connect
 * @param {boolean} p.useStaticVaults
 * @param {boolean} p.marketContextEnabled
 * @param {() => Promise<{content:string,source:string}>} p.loadVaultSkill
 * @param {(riskLevel:string) => Promise<string|null>} p.fetchMarketContext
 * @param {(ev:Object)=>void} [p.onEvent]
 * @returns {Promise<{ skill:any, pools:any, gas:any, positions:any, marketContext:any, signals:any, timings:Object, wallMs:number }>}
 */
export async function runStrategyFetchDag({
  riskLevel, address, useStaticVaults, marketContextEnabled,
  loadVaultSkill, fetchMarketContext, onEvent,
}) {
  const nodes = [
    { id: 'skill', deps: [], run: () => loadVaultSkill() },
    { id: 'pools', deps: [], run: () => (useStaticVaults ? null : fetchDeFiLlamaVaults()) },
    { id: 'gas', deps: [], run: () => fetchGasSnapshot() },
    { id: 'positions', deps: [], run: () => (address ? reconcilePositionsFromChain(address) : null) },
    { id: 'market', deps: [], run: () => (marketContextEnabled ? fetchMarketContext(riskLevel) : null) },
    { id: 'signals', deps: ['market', 'gas'], run: (ctx) => deriveSignals(ctx.market, ctx.gas) },
  ]

  const { results, timings, wallMs } = await runFetchDag(nodes, {}, onEvent)
  return {
    skill: results.skill,
    pools: results.pools,
    gas: results.gas,
    positions: results.positions,
    marketContext: results.market,
    signals: results.signals,
    timings,
    wallMs,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/fetchDag.test.js`
Expected: PASS (runner block + 2 new `runStrategyFetchDag` cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/fetchDag.js frontend/src/strategy/fetchDag.test.js
git commit -m "feat: wire concrete strategy fetch nodes into the DAG"
```

---

## Task 5: Consume the DAG in `generateStrategy`

**Files:**
- Modify: `frontend/src/venice.js:80-95` (replace inline `Promise.all`), `:149-171` (merge gas + signals into mdpState)

- [ ] **Step 1: Add the import**

At the top of `frontend/src/venice.js`, next to the existing `import { fetchDeFiLlamaVaults } from './defiLlama.js'` (line 4), add:

```javascript
import { runStrategyFetchDag } from './strategy/fetchDag.js'
```

- [ ] **Step 2: Extend the signature with `address`**

Change line 80 from:

```javascript
export async function generateStrategy({ amount, riskLevel, numVaults, veniceAuth, devApiKey, signal }) {
```

to:

```javascript
export async function generateStrategy({ amount, riskLevel, numVaults, veniceAuth, devApiKey, signal, address = null }) {
```

- [ ] **Step 3: Replace the inline `Promise.all` block**

Replace lines 85-95 (the comment + `const [skill, marketContext, liveVaults] = await Promise.all([...])`) with:

```javascript
  // EvoAgentX-style DAG: skill + market + pools + gas + positions fetch concurrently
  // (one layer), then on-chain signals derive from market+gas. Replaces the old
  // 3-way Promise.all — same parallelism for skill/market/pools, plus two new real
  // nodes (gas, positions) and a real combined-signals node, with zero added latency.
  const dag = await runStrategyFetchDag({
    riskLevel,
    address,
    useStaticVaults,
    marketContextEnabled,
    loadVaultSkill,
    fetchMarketContext,
  })
  const skill = dag.skill
  const marketContext = dag.marketContext
  const liveVaults = dag.pools
  console.log(`[Venice] strategy DAG · wall ${Math.round(dag.wallMs)}ms · nodes ${JSON.stringify(dag.timings)}`)
```

Note: `loadVaultSkill` and `fetchMarketContext` are already defined in `venice.js` (referenced by the old `Promise.all`). If `loadVaultSkill` is declared with `function` below its use it hoists fine; if it is a `const`/arrow defined later in the file, move its declaration above `generateStrategy`. Verify with `grep -n "loadVaultSkill\|fetchMarketContext" frontend/src/venice.js` before running.

- [ ] **Step 4: Merge gas + DAG signals into the compact `mdpState`**

In the `mdpState` object (currently lines 163-171), replace the `signals` line and add gas. Change:

```javascript
    const mdpState = {
      turbulence: mdpFullState.market.turbulence,
      signals: mdpFullState.market.signals,
      universeSize: mdpFullState.universe.length,
      riskCeiling: riskCeiling(mdpFullState),
      profileRisk: mdpFullState.profile.riskLevel,
      capitalUsdc: mdpFullState.capital.amountUsdc,
      actionViolations: violations,
    }
```

to:

```javascript
    // Prefer the DAG's combined on-chain signals (market context + live gas) over the
    // market-text-only turbulence baked into mdpFullState. Falls back to the baseline
    // when the signals node failed (null).
    const combined = dag.signals || { turbulence: mdpFullState.market.turbulence, signals: mdpFullState.market.signals }
    const mdpState = {
      turbulence: combined.turbulence,
      signals: combined.signals,
      gasGwei: dag.gas ? dag.gas.gwei : null,
      gasLevel: dag.gas ? dag.gas.level : null,
      universeSize: mdpFullState.universe.length,
      riskCeiling: riskCeiling(mdpFullState),
      profileRisk: mdpFullState.profile.riskLevel,
      capitalUsdc: mdpFullState.capital.amountUsdc,
      actionViolations: violations,
    }
```

- [ ] **Step 5: Run the full venice + strategy test suite**

Run: `cd frontend && npx vitest run src/venice src/strategy`
Expected: PASS — no regressions. (If `venice` has no dedicated test file, this runs the strategy suite; that is fine.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/venice.js
git commit -m "feat: gather strategy inputs via DAG and surface gas signals in MDP state"
```

---

## Task 6: Pass wallet address + log the parallel win from the wizard

**Files:**
- Modify: `frontend/src/app.jsx:579-592`

- [ ] **Step 1: Thread `address` into the `generateStrategy` call**

In the "thinking" effect (around line 579), change the `generateStrategy({ ... })` argument object to include `address`:

```javascript
        const veniceResult = await generateStrategy({
          amount: Number(amount),
          riskLevel,
          numVaults,
          veniceAuth: null, // wallet not connected yet at step 1
          devApiKey: devApiKey || null,
          signal: ctrl.signal,
          address: realAddress || null, // positions node runs only when connected
        });
```

- [ ] **Step 2: Log the DAG timing as an orchestrator event (visible in the UI log)**

Immediately after `setVaultLive(veniceResult.vaultDataSource === "defiLlama");` (line 589), add:

```javascript
        if (veniceResult.mdpState?.gasLevel) {
          addLog({ event: "OrchestratorPlanned", meta: `parallel fetch · gas ${veniceResult.mdpState.gasGwei} gwei (${veniceResult.mdpState.gasLevel})` });
        }
```

- [ ] **Step 3: Verify the app boots and the strategy step runs**

Run the dev server and exercise step 01 → "Generate strategy". Confirm the log shows the new "parallel fetch · gas N gwei" line and no console errors.

Run: `cd frontend && npm run dev`
Then in the browser: connect (optional), enter an amount, pick a risk, run the strategy step. Expected: strategy resolves as before; a `parallel fetch · gas …` entry appears in the activity log; DevTools console shows `[Venice] strategy DAG · wall …ms · nodes {…}`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: pass wallet to strategy DAG and log live gas in the wizard"
```

---

## Task 7: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — all suites green, including the new `fetchDag`, `gasSnapshot`, and extended `mdp` tests.

- [ ] **Step 2: Lint the touched files (if a lint script exists)**

Run: `cd frontend && npm run lint` (skip if no `lint` script in `package.json`)
Expected: no new violations in `fetchDag.js`, `gasSnapshot.js`, `mdp.js`, `venice.js`, `app.jsx`.

- [ ] **Step 3: Final commit (only if lint auto-fixed anything)**

```bash
git add -A
git commit -m "chore: lint fixes for strategy DAG fetch layer"
```

---

## Self-Review checklist (run after implementation)

- **Spec coverage:** EvoAgentX DAG primitive → `runFetchDag` (Task 3). Independent nodes concurrent → layer-0 set in `runStrategyFetchDag` (Task 4). The four narrative fetches: pools (existing, Task 4), gas (Task 1+4), positions (Task 4), on-chain signals (Task 2+4). Axis stays `/strategy` → `generateStrategy` is the sole consumer (Task 5); `app.jsx` only threads address + logging (Task 6). ✓
- **Parallelism proven:** `fetchDag.test.js` "all start before any end" + `wallMs < sum(timings)` assert the concurrency claim (2s→~500ms narrative). ✓
- **Type consistency:** `fetchGasSnapshot` returns `{ gwei, level }` — consumed identically in `deriveSignals` (`gas.level`), `runStrategyFetchDag`, and `mdpState` (`dag.gas.gwei`). `runStrategyFetchDag` returns `{ skill, pools, gas, positions, marketContext, signals, timings, wallMs }` — every key read in Task 5 exists. `deriveSignals(marketContext, gas)` arg order matches all call sites. ✓
- **No placeholders:** every code step is complete and runnable. ✓
- **Graceful degradation:** each node is null-isolated by the runner; `generateStrategy` falls back to `mdpFullState.market.*` when `dag.signals` is null; positions/pools/market already null-tolerant downstream. ✓

---

## Post-implementation

- Run `graphify update .` to refresh the knowledge graph with the new `strategy/fetchDag.js` and `strategy/gasSnapshot.js` modules.
- This plan lives under `docs/superpowers/plans/` which is gitignored — it is not committed.

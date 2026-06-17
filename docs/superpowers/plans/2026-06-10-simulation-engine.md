# Simulation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight Monte Carlo "alternate futures" simulation engine to the `/strategy` wizard review screen — run the proposed allocation across bull/base/bear scenarios, show the outcome distribution and the probability-weighted expected value.

**Architecture:** Two new pure ESM modules in `frontend/src/strategy/` (seeded RNG + simulation engine) following the existing pure-function + dependency-injection + Vitest convention used by `mdp.js`, `council.js`, `gates.js`. The engine adapts the cadCAD/curvesim Monte Carlo parameter-sweep pattern (see `planning/inspiration/cadCAD.md` §9): `N` runs = alternate futures, scenario sweep = different assumptions, aggregate = distribution, probability-weighted mean = expected value. The differentiator is **context richness** — each scenario's drift/volatility/gas cost is enriched from live signals already on screen (turbulence regime + live gas). A new `SimulationPanel` renders below the existing State/Action/Reward `mdp-panel` inside `StrategyCard`. App computes the simulation with a `useMemo` and passes it as a prop. No network, no React, no storage inside the engine — everything injected.

**Tech Stack:** Vanilla ES modules, React 18 (Babel/Vite), Vitest 2, plain CSS tokens. No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/strategy/rng.js` (create) | Deterministic seeded PRNG (mulberry32) + Box-Muller gaussian. Makes every Monte Carlo run replayable from a seed → reproducible tests. |
| `frontend/src/strategy/rng.test.js` (create) | Unit tests for determinism + range + gaussian distribution. |
| `frontend/src/strategy/simulation.js` (create) | The engine: `simulatePath` (one future), `runScenario` (distribution stats), `deriveScenarioParams` (context enrichment), `runSimulation` (sweep + expected value), `allocationsFromStrategy` (adapter). |
| `frontend/src/strategy/simulation.test.js` (create) | Unit tests for each engine function. |
| `frontend/src/agents.jsx` (modify) | Add `SimulationPanel` component; render it inside `StrategyCard` and accept a `simulation` prop. |
| `frontend/src/app.jsx` (modify) | Add `useMemo` import alias; compute `simulation` from `strategy`; pass it into `<StrategyCard>`. |
| `frontend/style.css` (modify) | Styles for `.sim-panel`, `.sim-grid`, `.sim-scenario`, `.sim-band`. |

All tests run with: `cd frontend && npx vitest run` (or a single file path as shown per task). Per project CLAUDE.md, Vitest runs natively in PowerShell — no WSL needed (WSL is only for Foundry).

---

## Task 1: Seeded RNG module

**Files:**
- Create: `frontend/src/strategy/rng.js`
- Test: `frontend/src/strategy/rng.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/rng.test.js`:

```js
// frontend/src/strategy/rng.test.js
import { describe, it, expect } from 'vitest'
import { makeRng, gaussian } from './rng.js'

describe('makeRng', () => {
  it('is deterministic — same seed yields the same sequence', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('different seeds yield different sequences', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)())
  })

  it('returns values in [0, 1)', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const x = rng()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

describe('gaussian', () => {
  it('large-sample mean approximates the requested mean', () => {
    const rng = makeRng(99)
    let sum = 0
    const N = 20000
    for (let i = 0; i < N; i++) sum += gaussian(rng, 5, 2)
    expect(Math.abs(sum / N - 5)).toBeLessThan(0.1)
  })

  it('is deterministic for a given seed', () => {
    expect(gaussian(makeRng(3))).toBe(gaussian(makeRng(3)))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/rng.test.js`
Expected: FAIL — `Failed to resolve import "./rng.js"` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/strategy/rng.js`:

```js
// frontend/src/strategy/rng.js
// Deterministic seeded PRNG for reproducible Monte Carlo runs. mulberry32 gives a
// uniform [0,1) stream; Box-Muller turns two uniforms into a standard normal sample.
// Pure — never touches global Math.random, so every simulated future is replayable
// from its seed and unit tests can assert exact values. No dependencies.

/**
 * mulberry32 — tiny fast 32-bit PRNG.
 * @param {number} seed integer seed
 * @returns {() => number} function yielding the next uniform in [0, 1)
 */
export function makeRng(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * One standard-normal sample via Box-Muller, scaled to (mean, stdDev).
 * @param {() => number} rng a uniform [0,1) generator from makeRng
 * @param {number} [mean]
 * @param {number} [stdDev]
 * @returns {number}
 */
export function gaussian(rng, mean = 0, stdDev = 1) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return mean + z * stdDev
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/rng.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/rng.js frontend/src/strategy/rng.test.js
git commit -m "feat: add seeded PRNG for reproducible monte carlo runs"
```

---

## Task 2: `simulatePath` — one alternate future

**Files:**
- Create: `frontend/src/strategy/simulation.js`
- Test: `frontend/src/strategy/simulation.test.js`

`simulatePath` walks one future day-by-day: APY drifts and jitters under the scenario assumptions, daily yield accrues on deployed capital, and a one-time entry-gas cost is subtracted. Returns the net USDC yield for that single future.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/simulation.test.js`:

```js
// frontend/src/strategy/simulation.test.js
import { describe, it, expect } from 'vitest'
import { simulatePath } from './simulation.js'
import { makeRng } from './rng.js'

// Minimal hand-built StrategyState — the engine must not depend on buildStrategyState.
function makeState(over = {}) {
  return {
    capital: { amountUsdc: 1000, heldUsdc: 0 },
    universe: [
      { address: '0xA', apy: 5 },
      { address: '0xB', apy: 10 },
    ],
    market: { turbulence: 'calm', signals: [] },
    ...over,
  }
}

const flat = { name: 'base', apyDriftPct: 0, apyVolPct: 0, gasMultiplier: 1 }

describe('simulatePath', () => {
  it('blends APY from allocation weights against the universe', () => {
    const allocations = [
      { address: '0xA', allocation: 0.5 },
      { address: '0xB', allocation: 0.5 },
    ]
    const r = simulatePath(allocations, makeState(), flat, makeRng(1), { horizonDays: 365, entryGasUsdc: 0 })
    expect(r.blendedApy).toBe(7.5)
    // 1000 * 7.5% over 365 days, no drift/noise/gas ≈ 75 USDC
    expect(r.netYieldUsdc).toBeCloseTo(75, 0)
  })

  it('prefers the allocation-carried apy over the universe apy', () => {
    const allocations = [{ address: '0xA', allocation: 1, apy: 20 }]
    const r = simulatePath(allocations, makeState(), flat, makeRng(1), { horizonDays: 365, entryGasUsdc: 0 })
    expect(r.blendedApy).toBe(20)
  })

  it('subtracts a one-time entry gas cost scaled by gasMultiplier', () => {
    const allocations = [{ address: '0xA', allocation: 1 }]
    const noGas = simulatePath(allocations, makeState(), flat, makeRng(5), { horizonDays: 30, entryGasUsdc: 0 })
    const withGas = simulatePath(allocations, makeState(), { ...flat, gasMultiplier: 2 }, makeRng(5), { horizonDays: 30, entryGasUsdc: 3 })
    expect(+(noGas.netYieldUsdc - withGas.netYieldUsdc).toFixed(2)).toBe(6) // 3 * 2
  })

  it('never lets APY go negative under heavy downward drift', () => {
    const allocations = [{ address: '0xA', allocation: 1 }]
    const r = simulatePath(allocations, makeState(), { name: 'bear', apyDriftPct: -10000, apyVolPct: 0, gasMultiplier: 1 }, makeRng(2), { horizonDays: 30, entryGasUsdc: 0 })
    expect(r.finalApy).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic for a given seed', () => {
    const allocations = [{ address: '0xA', allocation: 1 }]
    const opts = { horizonDays: 30, entryGasUsdc: 0.5 }
    const params = { name: 'base', apyDriftPct: 0, apyVolPct: 2, gasMultiplier: 1 }
    expect(simulatePath(allocations, makeState(), params, makeRng(8), opts).netYieldUsdc)
      .toBe(simulatePath(allocations, makeState(), params, makeRng(8), opts).netYieldUsdc)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: FAIL — `Failed to resolve import "./simulation.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/strategy/simulation.js`:

```js
// frontend/src/strategy/simulation.js
// Lightweight Monte Carlo "alternate futures" engine for the /strategy wizard.
// Adapts the cadCAD/curvesim parameter-sweep pattern (planning/inspiration/cadCAD.md §9)
// to DeFi yield: N runs = alternate futures, the scenario sweep = different assumptions
// (bull/base/bear), aggregate per scenario = the outcome distribution, and the
// probability-weighted mean = expected value. The differentiator is context richness —
// scenario drift/volatility/gas are enriched from live turbulence + gas signals.
// Pure functions only — RNG and state are injected; no React, no network, no storage.

import { makeRng, gaussian } from './rng.js'

export const DEFAULT_HORIZON_DAYS = 30
export const DEFAULT_RUNS = 100

/** Static scenario sweep (the cadCAD `M` parameter set). weight = scenario probability. */
export const SCENARIOS = [
  { name: 'bull', apyDriftPct: 2.0, apyVolPct: 1.5, gasMultiplier: 0.8, weight: 0.25 },
  { name: 'base', apyDriftPct: 0.0, apyVolPct: 1.0, gasMultiplier: 1.0, weight: 0.5 },
  { name: 'bear', apyDriftPct: -3.0, apyVolPct: 2.5, gasMultiplier: 1.5, weight: 0.25 },
]

/** Weighted APY of an allocation: allocation-carried apy wins, else the universe observation. */
function blendApy(allocations, state) {
  const byAddr = new Map((state.universe || []).map((v) => [String(v.address).toLowerCase(), v]))
  return (allocations || []).reduce((s, a) => {
    const obs = byAddr.get(String(a.address).toLowerCase()) || {}
    const apy = Number(a.apy != null ? a.apy : obs.apy) || 0
    return s + (Number(a.allocation) || 0) * apy
  }, 0)
}

/**
 * Simulate ONE alternate future for the proposed allocation.
 * @param {Array<{address:string, allocation:number, apy?:number}>} allocations weights sum to ~1
 * @param {Object} state StrategyState (uses state.capital.amountUsdc + state.universe)
 * @param {{apyDriftPct:number, apyVolPct:number, gasMultiplier:number}} params scenario assumptions
 * @param {() => number} rng injected uniform generator
 * @param {{horizonDays?:number, entryGasUsdc?:number}} [opts]
 * @returns {{netYieldUsdc:number, finalApy:number, blendedApy:number}}
 */
export function simulatePath(allocations, state, params, rng, opts = {}) {
  const horizonDays = opts.horizonDays || DEFAULT_HORIZON_DAYS
  const entryGasUsdc = opts.entryGasUsdc != null ? opts.entryGasUsdc : 0.5
  const capital = Number(state.capital?.amountUsdc) || 0
  const blendedApy = blendApy(allocations, state)

  let apy = blendedApy
  let cumulative = 0
  const drift = (Number(params.apyDriftPct) || 0) / 365
  const vol = (Number(params.apyVolPct) || 0) / 365
  for (let d = 0; d < horizonDays; d++) {
    apy = Math.max(0, apy + drift + gaussian(rng, 0, vol))
    cumulative += (capital * (apy / 100)) / 365
  }
  const gasCost = entryGasUsdc * (Number(params.gasMultiplier) || 1)
  return {
    netYieldUsdc: +(cumulative - gasCost).toFixed(2),
    finalApy: +apy.toFixed(2),
    blendedApy: +blendedApy.toFixed(2),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/simulation.js frontend/src/strategy/simulation.test.js
git commit -m "feat: add monte carlo simulatePath for one alternate future"
```

---

## Task 3: `runScenario` — outcome distribution over N futures

**Files:**
- Modify: `frontend/src/strategy/simulation.js`
- Test: `frontend/src/strategy/simulation.test.js`

Run `N` futures for one scenario (each future gets its own derived seed) and aggregate into distribution stats: mean, std, min, max, p5/p50/p95, probability of profit.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/simulation.test.js`:

```js
import { runScenario } from './simulation.js'

describe('runScenario', () => {
  const allocations = [{ address: '0xB', allocation: 1, apy: 10 }]

  it('returns distribution stats over the requested number of runs', () => {
    const r = runScenario(allocations, makeState(), SCENARIOS[1], { runs: 200, horizonDays: 30, entryGasUsdc: 0, seed: 1 })
    expect(r.name).toBe('base')
    expect(r.runs).toBe(200)
    expect(r.mean).toBeGreaterThan(0)
    expect(r.p5).toBeLessThanOrEqual(r.p50)
    expect(r.p50).toBeLessThanOrEqual(r.p95)
    expect(r.min).toBeLessThanOrEqual(r.max)
    expect(r.probProfit).toBeGreaterThanOrEqual(0)
    expect(r.probProfit).toBeLessThanOrEqual(1)
  })

  it('is deterministic for a given seed', () => {
    const opts = { runs: 50, horizonDays: 30, entryGasUsdc: 0.5, seed: 7 }
    const a = runScenario(allocations, makeState(), SCENARIOS[0], opts)
    const b = runScenario(allocations, makeState(), SCENARIOS[0], opts)
    expect(a).toEqual(b)
  })

  it('a bear scenario has a lower mean than a bull scenario', () => {
    const opts = { runs: 300, horizonDays: 60, entryGasUsdc: 0.5, seed: 4 }
    const bull = runScenario(allocations, makeState(), SCENARIOS[0], opts)
    const bear = runScenario(allocations, makeState(), SCENARIOS[2], opts)
    expect(bull.mean).toBeGreaterThan(bear.mean)
  })
})

// SCENARIOS import needed at top — add to the existing import line.
import { SCENARIOS } from './simulation.js'
```

> Note: place the two `import` statements at the top of the file next to the existing imports rather than mid-file (shown here next to the block for readability). Vitest hoists imports, so it works either way, but keep imports grouped at the top when editing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: FAIL — `runScenario is not a function` (export missing).

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/simulation.js`:

```js
/** Aggregate raw net-yield outcomes into distribution stats. */
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length || 1
  const mean = sorted.reduce((s, x) => s + x, 0) / n
  const variance = sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
  const profit = sorted.filter((x) => x > 0).length
  return {
    mean: +mean.toFixed(2),
    std: +Math.sqrt(variance).toFixed(2),
    min: +(sorted[0] || 0).toFixed(2),
    max: +(sorted[sorted.length - 1] || 0).toFixed(2),
    p5: +(pct(0.05) || 0).toFixed(2),
    p50: +(pct(0.5) || 0).toFixed(2),
    p95: +(pct(0.95) || 0).toFixed(2),
    probProfit: +(profit / n).toFixed(3),
  }
}

/**
 * Run N alternate futures for one scenario and aggregate the distribution.
 * Each future derives its own seed so runs are independent yet fully reproducible.
 * @param {Array} allocations
 * @param {Object} state StrategyState
 * @param {{name:string, apyDriftPct:number, apyVolPct:number, gasMultiplier:number}} params
 * @param {{runs?:number, horizonDays?:number, entryGasUsdc?:number, seed?:number}} [opts]
 * @returns {{name:string, runs:number, mean:number, std:number, min:number, max:number, p5:number, p50:number, p95:number, probProfit:number}}
 */
export function runScenario(allocations, state, params, opts = {}) {
  const runs = opts.runs || DEFAULT_RUNS
  const seed = opts.seed != null ? opts.seed : 1
  const outcomes = []
  for (let i = 0; i < runs; i++) {
    const rng = makeRng((seed + i * 2654435761) >>> 0)
    outcomes.push(simulatePath(allocations, state, params, rng, opts).netYieldUsdc)
  }
  return { name: params.name, runs, ...distribution(outcomes) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: PASS — all simulation tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/simulation.js frontend/src/strategy/simulation.test.js
git commit -m "feat: aggregate monte carlo futures into outcome distribution"
```

---

## Task 4: `deriveScenarioParams` — context enrichment

**Files:**
- Modify: `frontend/src/strategy/simulation.js`
- Test: `frontend/src/strategy/simulation.test.js`

The differentiator. Live context — turbulence regime + historical APY trend — reshapes the static scenario sweep before running: turbulence widens volatility and drags drift down; a positive 7d APY trend lifts drift across all scenarios. Returns NEW params (immutable).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/simulation.test.js`:

```js
import { deriveScenarioParams } from './simulation.js'

describe('deriveScenarioParams', () => {
  it('returns the static sweep unchanged under calm, flat context', () => {
    const r = deriveScenarioParams({ turbulence: 'calm', apyTrendPct: 0 })
    expect(r.map((s) => s.name)).toEqual(['bull', 'base', 'bear'])
    expect(r[1].apyDriftPct).toBe(0)
    expect(r[1].apyVolPct).toBe(1)
  })

  it('turbulent regime drags drift down and widens volatility', () => {
    const calm = deriveScenarioParams({ turbulence: 'calm', apyTrendPct: 0 })
    const turbulent = deriveScenarioParams({ turbulence: 'turbulent', apyTrendPct: 0 })
    expect(turbulent[1].apyDriftPct).toBeLessThan(calm[1].apyDriftPct)
    expect(turbulent[1].apyVolPct).toBeGreaterThan(calm[1].apyVolPct)
  })

  it('a positive APY trend lifts drift across every scenario', () => {
    const flat = deriveScenarioParams({ turbulence: 'calm', apyTrendPct: 0 })
    const rising = deriveScenarioParams({ turbulence: 'calm', apyTrendPct: 1.5 })
    rising.forEach((s, i) => expect(s.apyDriftPct).toBeCloseTo(flat[i].apyDriftPct + 1.5, 2))
  })

  it('does not mutate the SCENARIOS constant', () => {
    deriveScenarioParams({ turbulence: 'turbulent', apyTrendPct: 5 })
    expect(SCENARIOS[1].apyDriftPct).toBe(0)
    expect(SCENARIOS[1].apyVolPct).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: FAIL — `deriveScenarioParams is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/simulation.js`:

```js
/** Turbulence regime → extra volatility (pct points) added to every scenario. */
const TURB_VOL_BOOST = { calm: 0, elevated: 1.0, turbulent: 2.5 }
/** Turbulence regime → drift drag (pct points) subtracted from every scenario. */
const TURB_DRIFT_DRAG = { calm: 0, elevated: -1.0, turbulent: -3.0 }

/**
 * Enrich the static scenario sweep with live context. THIS is the differentiator —
 * outcomes reflect the real regime and APY trend, not a fixed sweep. Returns NEW
 * scenario params; never mutates SCENARIOS.
 * @param {{turbulence?:'calm'|'elevated'|'turbulent', apyTrendPct?:number}} [context]
 * @returns {Array<{name:string, apyDriftPct:number, apyVolPct:number, gasMultiplier:number, weight:number}>}
 */
export function deriveScenarioParams(context = {}) {
  const turb = context.turbulence || 'calm'
  const apyTrendPct = Number(context.apyTrendPct) || 0
  const volBoost = TURB_VOL_BOOST[turb] || 0
  const driftDrag = TURB_DRIFT_DRAG[turb] || 0
  return SCENARIOS.map((s) => ({
    ...s,
    apyDriftPct: +(s.apyDriftPct + apyTrendPct + driftDrag).toFixed(2),
    apyVolPct: +(s.apyVolPct + volBoost).toFixed(2),
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/simulation.js frontend/src/strategy/simulation.test.js
git commit -m "feat: enrich scenario sweep with live turbulence and apy-trend context"
```

---

## Task 5: `runSimulation` + `allocationsFromStrategy`

**Files:**
- Modify: `frontend/src/strategy/simulation.js`
- Test: `frontend/src/strategy/simulation.test.js`

`runSimulation` is the public entry point: enrich scenarios from context, run the full sweep, and compute the probability-weighted expected value + expected probability-of-profit. `allocationsFromStrategy` adapts the wizard's `strategy.agents` (USDC amounts) into normalized allocation weights the engine consumes.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/simulation.test.js`:

```js
import { runSimulation, allocationsFromStrategy } from './simulation.js'

describe('allocationsFromStrategy', () => {
  it('converts agent USDC amounts into normalized weights carrying apy', () => {
    const strategy = {
      total: 100,
      agents: [
        { vault: { addr: '0xA', apy: '5' }, allocation: 25 },
        { vault: { addr: '0xB', apy: '10' }, allocation: 75 },
      ],
    }
    const allocs = allocationsFromStrategy(strategy)
    expect(allocs).toEqual([
      { address: '0xA', allocation: 0.25, apy: 5 },
      { address: '0xB', allocation: 0.75, apy: 10 },
    ])
  })

  it('returns an empty array for a null strategy', () => {
    expect(allocationsFromStrategy(null)).toEqual([])
  })
})

describe('runSimulation', () => {
  function makeState(over = {}) {
    return {
      capital: { amountUsdc: 1000, heldUsdc: 0 },
      universe: [{ address: '0xB', apy: 10 }],
      market: { turbulence: 'calm', signals: [] },
      ...over,
    }
  }
  const allocations = [{ address: '0xB', allocation: 1, apy: 10 }]

  it('runs every scenario and reports a probability-weighted expected value', () => {
    const sim = runSimulation(allocations, makeState(), { runs: 200, horizonDays: 30, seed: 1, context: { turbulence: 'calm', apyTrendPct: 0, gasGwei: 30 } })
    expect(sim.scenarios.map((s) => s.name)).toEqual(['bull', 'base', 'bear'])
    expect(sim.horizonDays).toBe(30)
    expect(sim.runs).toBe(200)
    expect(sim.capitalUsdc).toBe(1000)
    // EV sits between the bear mean and the bull mean.
    const means = sim.scenarios.map((s) => s.mean)
    expect(sim.expectedValue).toBeLessThanOrEqual(Math.max(...means))
    expect(sim.expectedValue).toBeGreaterThanOrEqual(Math.min(...means))
    expect(sim.probProfit).toBeGreaterThanOrEqual(0)
    expect(sim.probProfit).toBeLessThanOrEqual(1)
    expect(sim.context.turbulence).toBe('calm')
  })

  it('is deterministic for a given seed + context', () => {
    const opts = { runs: 100, horizonDays: 30, seed: 5, context: { turbulence: 'elevated', apyTrendPct: 0.5, gasGwei: 40 } }
    expect(runSimulation(allocations, makeState(), opts)).toEqual(runSimulation(allocations, makeState(), opts))
  })

  it('a turbulent context lowers the expected value vs calm', () => {
    const base = { runs: 300, horizonDays: 60, seed: 2 }
    const calm = runSimulation(allocations, makeState(), { ...base, context: { turbulence: 'calm', apyTrendPct: 0, gasGwei: 30 } })
    const turb = runSimulation(allocations, makeState(), { ...base, context: { turbulence: 'turbulent', apyTrendPct: 0, gasGwei: 30 } })
    expect(calm.expectedValue).toBeGreaterThan(turb.expectedValue)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: FAIL — `runSimulation is not a function` / `allocationsFromStrategy is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/simulation.js`:

```js
/** Rough one-time entry gas in USDC from a gwei snapshot (deposit ≈ 150k gas, ETH ≈ $3000). */
function gasToUsdc(gwei) {
  const g = Number(gwei)
  if (!g) return 0.5
  const GAS_UNITS = 150000
  const ETH_USD = 3000
  return +(g * 1e-9 * GAS_UNITS * ETH_USD).toFixed(2)
}

/**
 * Public entry point: run the full scenario sweep and compute the
 * probability-weighted expected value + expected probability of profit.
 * @param {Array<{address:string, allocation:number, apy?:number}>} allocations
 * @param {Object} state StrategyState
 * @param {{runs?:number, horizonDays?:number, seed?:number, entryGasUsdc?:number, context?:{turbulence?:string, apyTrendPct?:number, gasGwei?:number}}} [opts]
 * @returns {{scenarios:Array, expectedValue:number, probProfit:number, horizonDays:number, runs:number, capitalUsdc:number, context:Object}}
 */
export function runSimulation(allocations, state, opts = {}) {
  const context = opts.context || {}
  const entryGasUsdc = opts.entryGasUsdc != null ? opts.entryGasUsdc : gasToUsdc(context.gasGwei)
  const params = deriveScenarioParams(context)
  const seed = opts.seed != null ? opts.seed : 1
  const scenarios = params.map((p, i) =>
    runScenario(allocations, state, p, {
      runs: opts.runs || DEFAULT_RUNS,
      horizonDays: opts.horizonDays || DEFAULT_HORIZON_DAYS,
      entryGasUsdc,
      seed: (seed + i * 7919) >>> 0,
    })
  )
  const totalWeight = params.reduce((s, p) => s + (Number(p.weight) || 0), 0) || 1
  const expectedValue = +(
    scenarios.reduce((s, sc, i) => s + sc.mean * (Number(params[i].weight) || 0), 0) / totalWeight
  ).toFixed(2)
  const probProfit = +(
    scenarios.reduce((s, sc, i) => s + sc.probProfit * (Number(params[i].weight) || 0), 0) / totalWeight
  ).toFixed(3)
  return {
    scenarios,
    expectedValue,
    probProfit,
    horizonDays: opts.horizonDays || DEFAULT_HORIZON_DAYS,
    runs: opts.runs || DEFAULT_RUNS,
    capitalUsdc: Number(state.capital?.amountUsdc) || 0,
    context: {
      turbulence: context.turbulence || 'calm',
      apyTrendPct: Number(context.apyTrendPct) || 0,
      gasGwei: Number(context.gasGwei) || null,
    },
  }
}

/**
 * Adapt the wizard's strategy.agents (USDC amounts) into normalized allocation
 * weights carrying each vault's APY. Mirrors how app.jsx builds the strategy.
 * @param {{total?:number, agents?:Array<{vault?:{addr?:string, apy?:string|number}, allocation?:number}>}} strategy
 * @returns {Array<{address:string, allocation:number, apy:number}>}
 */
export function allocationsFromStrategy(strategy) {
  const total = Number(strategy?.total) || 0
  return (strategy?.agents || []).map((a) => ({
    address: a.vault?.addr,
    allocation: total ? +(((Number(a.allocation) || 0) / total)).toFixed(4) : 0,
    apy: Number(a.vault?.apy) || 0,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/simulation.test.js`
Expected: PASS — all simulation tests pass.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `cd frontend && npx vitest run`
Expected: PASS — existing strategy/wallet/worker tests still green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/strategy/simulation.js frontend/src/strategy/simulation.test.js
git commit -m "feat: add runSimulation sweep with probability-weighted expected value"
```

---

## Task 6: `SimulationPanel` UI component

**Files:**
- Modify: `frontend/src/agents.jsx:381-474` (add the component above `StrategyCard`, render inside it)
- Modify: `frontend/style.css` (append styles)

Render the alternate-futures distribution below the existing State/Action/Reward `mdp-panel`. The panel shows an expected-value headline, the probability of profit, and one column per scenario with its mean net yield and a p5–p95 band.

- [ ] **Step 1: Add the `SimulationPanel` component**

In `frontend/src/agents.jsx`, immediately BEFORE the line `const StrategyCard = ({ strategy, skillSource, ... }) => {` (currently line 381), insert:

```jsx
// Alternate-futures Monte Carlo distribution for the proposed allocation.
// Pure presentational — all numbers come pre-computed from runSimulation (simulation.js).
const SCENARIO_META = {
  bull: { label: 'Bull', tone: 'var(--ok)' },
  base: { label: 'Base', tone: 'var(--text)' },
  bear: { label: 'Bear', tone: 'var(--warn, #c87)' },
};

const SimulationPanel = ({ simulation }) => {
  if (!simulation || !simulation.scenarios?.length) return null;
  const { scenarios, expectedValue, probProfit, horizonDays, runs, context } = simulation;
  const evTone = expectedValue >= 0 ? 'var(--ok)' : 'var(--warn, #c87)';
  const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  return (
    <div className="sim-panel">
      <div className="sim-head mono">
        <span className="sim-title">Simulation engine · alternate futures</span>
        <span className="sim-meta">{runs} runs × {scenarios.length} scenarios · {horizonDays}d horizon · {context.turbulence} regime</span>
      </div>
      <div className="sim-ev">
        <div className="sim-ev-fig">
          <span className="figure figure-md tnum" style={{ color: evTone }}>{fmt(expectedValue)}<span className="unit"> USDC</span></span>
          <span className="label mono">expected value · probability-weighted net yield</span>
        </div>
        <div className="sim-ev-prob mono">
          <span className="tnum" style={{ color: 'var(--text)' }}>{Math.round(probProfit * 100)}%</span>
          <span className="label">chance of profit</span>
        </div>
      </div>
      <div className="sim-grid">
        {scenarios.map((s) => {
          const meta = SCENARIO_META[s.name] || { label: s.name, tone: 'var(--text)' };
          return (
            <div key={s.name} className="sim-scenario">
              <div className="sim-scenario-head mono">
                <span style={{ color: meta.tone }}>● {meta.label}</span>
                <span className="tnum" style={{ color: s.mean >= 0 ? 'var(--ok)' : 'var(--warn, #c87)' }}>{fmt(s.mean)}</span>
              </div>
              <div className="sim-band mono">
                <span className="tnum">{fmt(s.p5)}</span>
                <span className="sim-band-rule" />
                <span className="tnum">{fmt(s.p95)}</span>
              </div>
              <div className="sim-scenario-foot mono">p5–p95 · {Math.round(s.probProfit * 100)}% profit</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Accept the prop and render the panel inside `StrategyCard`**

In `frontend/src/agents.jsx`, change the `StrategyCard` signature (currently line 381):

```jsx
const StrategyCard = ({ strategy, skillSource, onProceed, onRegenerate, strategyHash, attestation, attesting }) => {
```

to:

```jsx
const StrategyCard = ({ strategy, skillSource, onProceed, onRegenerate, strategyHash, attestation, attesting, simulation }) => {
```

Then, immediately AFTER the closing `)}` of the existing `{strategy.reward && strategy.mdpState && ( ... )}` block (currently line 474) and BEFORE the `{(attestation || attesting || strategyHash) && (` block (currently line 476), insert:

```jsx
      <SimulationPanel simulation={simulation} />

```

- [ ] **Step 3: Append styles**

Append to `frontend/style.css`:

```css
/* ── Simulation engine panel (/strategy review · alternate futures) ── */
.sim-panel {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.sim-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.sim-title { color: var(--text); letter-spacing: 0.02em; }
.sim-meta { color: var(--text-faint); }
.sim-ev {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  padding: 14px;
  border-bottom: 1px solid var(--border);
}
.sim-ev-fig { display: flex; flex-direction: column; gap: 2px; }
.sim-ev-fig .label { color: var(--text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.sim-ev-prob { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 11px; }
.sim-ev-prob .tnum { font-size: 18px; }
.sim-ev-prob .label { color: var(--text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.sim-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; }
.sim-scenario { padding: 12px 14px; border-right: 1px solid var(--border); }
.sim-scenario:last-child { border-right: none; }
.sim-scenario-head { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 8px; }
.sim-band { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-muted); }
.sim-band-rule { flex: 1; height: 1px; background: var(--border); }
.sim-scenario-foot { margin-top: 6px; font-size: 9px; color: var(--text-faint); }
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agents.jsx frontend/style.css
git commit -m "feat: render alternate-futures simulation panel in strategy review"
```

---

## Task 7: Wire the simulation into the wizard

**Files:**
- Modify: `frontend/src/app.jsx:5` (import alias), `frontend/src/app.jsx:54` (import simulation fns), compute memo near other strategy state, `frontend/src/app.jsx:1184` (pass prop)

Compute the simulation once when the strategy is ready, using the real on-screen signals (turbulence from `strategy.mdpState`, live gas from `latestGasRef`), and pass it to `StrategyCard`.

- [ ] **Step 1: Add `useMemo` to the React import**

In `frontend/src/app.jsx`, change line 5:

```jsx
import React, { useState as useS, useEffect as useE, useRef as useR } from 'react';
```

to:

```jsx
import React, { useState as useS, useEffect as useE, useRef as useR, useMemo as useM } from 'react';
```

- [ ] **Step 2: Import the simulation helpers**

In `frontend/src/app.jsx`, immediately AFTER line 54 (`import { buildStrategyState, enforceActionSpace, scoreReward } from './strategy/mdp.js';`), add:

```jsx
import { runSimulation, allocationsFromStrategy } from './strategy/simulation.js';
```

- [ ] **Step 3: Compute the `simulation` memo**

In `frontend/src/app.jsx`, immediately AFTER the `dismissAlert` definition (currently line 507: `const dismissAlert = (id) => ...`), add:

```jsx
  // Monte Carlo "alternate futures" for the proposed allocation. Recomputes only when
  // the strategy / inputs change. Uses the SAME live signals shown in the review panel —
  // turbulence regime (mdpState) + live gas — so the distribution reflects real context.
  const simulation = useM(() => {
    if (!strategy?.agents?.length) return null;
    const state = buildStrategyState({
      amountUsdc: Number(amount) || 0,
      riskLevel: risk,
      numVaults: strategy.agents.length,
      vaultData: VAULT_CATALOG,
      marketContext: marketLive,
      positions: agentData.positions,
      gas: latestGasRef.current,
    });
    return runSimulation(allocationsFromStrategy(strategy), state, {
      runs: 200,
      horizonDays: 30,
      seed: 1,
      context: {
        turbulence: strategy.mdpState?.turbulence || state.market.turbulence,
        apyTrendPct: 0,
        gasGwei: latestGasRef.current?.gwei || null,
      },
    });
  }, [strategy, amount, risk]);
```

> `agentData.positions` and `latestGasRef` are read inside the memo but intentionally omitted from deps — they are stable snapshots at strategy-ready time, matching how the monitor loop reads `latestGasRef.current` (app.jsx:471). Recomputing on every position tick is unnecessary and would re-roll the (seeded, deterministic) simulation needlessly.

- [ ] **Step 4: Pass the prop to `StrategyCard`**

In `frontend/src/app.jsx`, change line 1184:

```jsx
        return <StrategyCard strategy={strategy} skillSource={skillSource} onProceed={handleAcceptStrategy} onRegenerate={handleRegenerate} strategyHash={rawStrategy?.strategyHash} attestation={strategyAttestation} attesting={attesting} />;
```

to:

```jsx
        return <StrategyCard strategy={strategy} skillSource={skillSource} onProceed={handleAcceptStrategy} onRegenerate={handleRegenerate} strategyHash={rawStrategy?.strategyHash} attestation={strategyAttestation} attesting={attesting} simulation={simulation} />;
```

- [ ] **Step 5: Run the full test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — no regressions (UI wiring is not unit-tested, but imports must resolve).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: compute and surface alternate-futures simulation in /strategy"
```

---

## Task 8: Manual verification in the browser

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Use the preview tooling (`preview_start`) against the `frontend/` app, or `npx serve frontend/` if running manually.

- [ ] **Step 2: Drive the /strategy wizard**

1. On step 01, enter an amount (e.g. `100`), pick a risk level, submit.
2. Wait for the strategy to generate (the "ready" phase renders `StrategyCard`).

- [ ] **Step 3: Confirm the Simulation Engine panel**

Verify, below the existing State / Action / Reward panel:
- A "Simulation engine · alternate futures" header with `200 runs × 3 scenarios · 30d horizon · <regime>`.
- An expected-value figure in USDC (green if positive) + a "chance of profit" percentage.
- Three scenario columns (Bull / Base / Bear), each with a mean net yield and a p5–p95 band.
- Bull mean ≥ Base mean ≥ Bear mean (sanity of the sweep direction).

Capture a screenshot (`preview_screenshot`) as proof and confirm no console errors (`preview_console_logs`).

- [ ] **Step 4: Update graphify**

Run: `graphify update .`
(Per project CLAUDE.md — keep the knowledge graph current after code changes.)

---

## Self-Review

**1. Spec coverage:**
- "Run several alternate futures with different assumptions (bull/base/bear, TVL up/down, gas spike)" → `SCENARIOS` sweep + `simulatePath` (Tasks 2, 4). Gas spike is modeled via `gasMultiplier` per scenario + live `gasGwei` context.
- "See the distribution of outcomes, take the expected value" → `runScenario` distribution + `runSimulation` probability-weighted `expectedValue` (Tasks 3, 5).
- "What makes the output powerful is the richness of context sent to each scenario — TVL trend, news sentiment, on-chain signals, historical APY" → `deriveScenarioParams` consumes `turbulence` (on-chain/news sentiment, already derived in `mdp.js`) + `gasGwei` (on-chain signal) + `apyTrendPct` (historical APY input, wired with a documented zero default — see note below). Turbulence reshapes drift + volatility; gas reshapes cost (Task 4, 7).
- "Pivot stays at /strategy" → all UI lands in `StrategyCard` (step 01 review); other files touched are the shared `strategy/` engine + `app.jsx` wiring + `style.css`, all in service of the /strategy panel.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows complete code. The one acknowledged limitation (`apyTrendPct: 0`) is a real wired input with a documented reason, not a placeholder: historical-APY fetch (`apyHistory.js`) is async and per-pool; feeding a live 7d slope would expand scope beyond the /strategy review render and is left as a follow-up. The engine fully supports a non-zero value today (tested in Task 4).

**3. Type consistency:** `runSimulation` returns `{ scenarios, expectedValue, probProfit, horizonDays, runs, capitalUsdc, context }` — consumed exactly by `SimulationPanel` (Task 6). Each scenario object is `{ name, runs, mean, std, min, max, p5, p50, p95, probProfit }` from `runScenario` (Task 3) — `SimulationPanel` reads `name, mean, p5, p95, probProfit`. `allocationsFromStrategy` emits `{ address, allocation, apy }` — consumed by `simulatePath`/`blendApy` (Task 2). `makeRng`/`gaussian` signatures match across rng.js (Task 1) and simulation.js usage. Function names are stable across all tasks.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-10-simulation-engine.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

# Cognitive Risk → Council → Permission Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three remaining Phase-1 modules (`riskParams`, `councilLoop`, `permissionLayer`) plus a pure orchestrator that chains the proven risk modules into an honest VaR/CVaR → bounded council debate → hard-stop human gate, with a Vitest regression test replacing the throwaway proof script.

**Architecture:** Pure, dependency-injected JavaScript in `frontend/src/strategy/`. `riskParams` fuses live market context + the proven `behavioral.js` deltas into Monte Carlo params and runs the seeded correlated simulation through `riskMetrics`. `councilLoop` debates the resulting distribution with deterministic short-circuits (cited compliance + numeric validator) and escalates to at most `maxIter` bounded AI tie-break calls. `permissionLayer` turns the converged result into one plain sentence and a Yes/No gate that **never auto-executes**. A thin `riskCouncil` orchestrator chains all three and is the single seam the future UI panel consumes.

**Tech Stack:** ES modules (`.js`), Vitest, the proven `riskMetrics.js` / `behavioral.js` / `complianceCorpus.js` / `rng.js`, and the existing AI seam in `venice.js` (`resolveCouncilConflict`, `askVeniceJson`). No new dependencies.

## Global Constraints

- **Domain:** DeFi yield farming only. No RWA / OJK / SEC framing anywhere.
- **The deep emergent engine is never named.** Refer to it only as "deep emergent stand-in" / the toggle behind `routeBehavior`. Never on the critical path.
- **WAJIB BERHENTI (must stop):** no module in this pipeline may move funds or call an executor on its own. Execution happens only after an explicit human `true` answer, in a separate function.
- **All modules pure + dependency-injected.** No React, no network, no storage, no `Math.random` (seed via `makeRng`). RNG and AI calls are injected — mirror the existing `council.js` / `reflector.js` DI style.
- **No over-claiming in comments or strings.** VaR/CVaR is only as honest as the simulation distribution. Never write "debate is provably better" or any accuracy percentage. Cite-or-abstain: a verdict is always tied to a rule id, never invented.
- **File header comment** on every new module, matching the existing house style (what it does + why, signed-convention note where returns are signed %).
- **Test bar:** Vitest, AAA structure, ≥ 80% on new modules. Run from `frontend/`.
- **No regression to `councilReview.js` / `council.js`** — they are the per-deposit gate (250+ passing tests). This pipeline is the separate strategy-level decision.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/strategy/riskParams.js` (create) | Fuse `context` + `behavioral.js` deltas → MC params; run the seeded correlated simulation → `riskMetrics` result + provenance. |
| `frontend/src/strategy/riskParams.test.js` (create) | Determinism, calm-vs-panic tail divergence, deep-toggle param merge. |
| `frontend/src/strategy/riskProof.test.js` (create) | Regression test converted from `__riskproof.mjs` (the calm-PASS / panic-VETO table). |
| `frontend/src/strategy/__riskproof.mjs` (delete) | Throwaway demo — removed after conversion. |
| `frontend/src/strategy/councilLoop.js` (create) | Bounded debate loop: validator + cited compliance deterministic short-circuit, one optional AI tie-break per round, 3 exits, iteration cap. |
| `frontend/src/strategy/councilLoop.test.js` (create) | Each exit reachable; short-circuit avoids AI; cost cap; no fabricated veto. |
| `frontend/src/strategy/permissionLayer.js` (create) | Converged result → one sentence (LLM + template fallback); Yes/No gate that requires explicit `true` and blocks on `fatal`. |
| `frontend/src/strategy/permissionLayer.test.js` (create) | Template fallback, explicit-Yes-only, fatal never executes, No logs to injected reject sink. |
| `frontend/src/strategy/riskCouncil.js` (create) | Pure orchestrator `runRiskCouncil` chaining the three; returns `awaitingHuman:true, executed:false`. |
| `frontend/src/strategy/riskCouncil.test.js` (create) | Full chain on calm + panic; hard-stop invariant (no executor ever called). |

---

## Task 1: `riskParams` — param fusion + seeded simulation runner

**Files:**
- Create: `frontend/src/strategy/riskParams.js`
- Test: `frontend/src/strategy/riskParams.test.js`

**Interfaces:**
- Consumes (all proven, do not modify): `aggregateStress({turbulence, drawdownPct}) → {correlation, volMultiplier, driftDrag, rules}`, `emergentStress({rumorIntensity}) → {correlationBump, tailFatten, rules}`, `routeBehavior({deepRequested, scenarioNeedsEmergent}) → 'deep'|'aggregate'`, `simulateCorrelatedPath(assets, params, rng, opts) → number` from `behavioral.js`; `riskMetrics(outcomes, alpha) → {alpha, var95, cvar95, worst, best, mean, n, tailCount}` from `riskMetrics.js`; `makeRng(seed) → () => number` from `rng.js`.
- Produces (later tasks rely on these exact signatures):
  - `fuseRiskParams({context, deepRequested}) → {params, route, rules}` where `params` = `{correlation, volMultiplier, driftDrag, driftPct, tailFatten?}` ready for `simulateCorrelatedPath`.
  - `runRiskSimulation(basket, fused, opts) → {metrics, route, rules, runs, horizonDays}` where `basket` = `[{weight, dailyVolPct}, {weight, dailyVolPct}]`, `fused` is the object from `fuseRiskParams`, and `metrics` is a `riskMetrics` result.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/riskParams.test.js`:

```js
// frontend/src/strategy/riskParams.test.js
import { describe, test, expect, vi } from 'vitest'
import { fuseRiskParams, runRiskSimulation } from './riskParams.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const SIM_OPTS = { runs: 2000, horizonDays: 30, seed: 1 }

describe('fuseRiskParams', () => {
  test('calm context produces the base aggregate params, no deep rules', () => {
    // Arrange / Act
    const { params, route, rules } = fuseRiskParams({
      context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 },
    })
    // Assert
    expect(route).toBe('aggregate')
    expect(params.correlation).toBe(0.2)
    expect(params.volMultiplier).toBe(1)
    expect(params.driftPct).toBe(8)
    expect(params.tailFatten).toBeUndefined()
    expect(rules).toEqual([])
  })

  test('deep toggle merges emergent correlation bump + tailFatten and cites its rule', () => {
    // Arrange / Act
    const { params, route, rules } = fuseRiskParams({
      context: { turbulence: 'turbulent', drawdownPct: -12, rumorIntensity: 1 },
      deepRequested: true,
    })
    // Assert
    expect(route).toBe('deep')
    expect(params.correlation).toBeGreaterThan(0.85) // 0.85 aggregate + 0.10 bump
    expect(params.tailFatten).toBeCloseTo(1.6, 5)
    expect(rules).toContain('herd-turbulent')
    expect(rules).toContain('emergent-rumor-contagion')
  })
})

describe('runRiskSimulation', () => {
  test('is deterministic for a fixed seed', () => {
    // Arrange
    const fused = fuseRiskParams({ context: { turbulence: 'calm' } })
    // Act
    const a = runRiskSimulation(BASKET, fused, SIM_OPTS)
    const b = runRiskSimulation(BASKET, fused, SIM_OPTS)
    // Assert
    expect(a.metrics).toEqual(b.metrics)
  })

  test('panic tail is materially worse than calm (honest spread)', () => {
    // Arrange
    const calm = fuseRiskParams({ context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } })
    const panic = fuseRiskParams({ context: { turbulence: 'turbulent', drawdownPct: -12, apyTrendPct: 8 } })
    // Act
    const calmSim = runRiskSimulation(BASKET, calm, SIM_OPTS)
    const panicSim = runRiskSimulation(BASKET, panic, SIM_OPTS)
    // Assert: CVaR is a signed % return — more negative = worse tail.
    expect(panicSim.metrics.cvar95).toBeLessThan(calmSim.metrics.cvar95)
    expect(panicSim.metrics.cvar95).toBeLessThan(-4) // panic tail breaches the moderate floor region
    expect(calmSim.metrics.cvar95).toBeGreaterThan(-3) // calm tail stays shallow
  })

  test('does not call Math.random (seeded only)', () => {
    // Arrange
    const spy = vi.spyOn(Math, 'random')
    const fused = fuseRiskParams({ context: { turbulence: 'calm' } })
    // Act
    runRiskSimulation(BASKET, fused, SIM_OPTS)
    // Assert
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/riskParams.test.js`
Expected: FAIL — `Failed to resolve import "./riskParams.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/strategy/riskParams.js`:

```js
// frontend/src/strategy/riskParams.js
// Phase-1 param fusion + simulation runner for the risk pipeline. Turns live
// market context (turbulence / drawdown / apy trend) plus the proven behavioral
// deltas into one Monte Carlo param object, then runs N seeded correlated paths
// through riskMetrics to get an honest VaR/CVaR distribution. The aggregate path
// is always on (cheap math); the deep emergent stand-in is an optional toggle
// behind routeBehavior and only fattens the tail further — it never replaces the
// aggregate path and is never on the critical path. Pure + deterministic: RNG is
// seeded, no network, no storage. (Full 4-signal fan-out is Phase 2.)

import { aggregateStress, emergentStress, routeBehavior, simulateCorrelatedPath } from './behavioral.js'
import { riskMetrics } from './riskMetrics.js'
import { makeRng } from './rng.js'

const DEFAULT_RUNS = 10000
const DEFAULT_HORIZON_DAYS = 30
// Golden-ratio-ish odd multiplier — same per-run seed derivation as the proof run,
// so every simulated future is independent yet fully replayable from one seed.
const SEED_STRIDE = 2654435761

/**
 * Fuse live context + behavioral deltas into one MC param object.
 * @param {{context?:{turbulence?:'calm'|'elevated'|'turbulent', drawdownPct?:number, apyTrendPct?:number, rumorIntensity?:number}, deepRequested?:boolean}} [input]
 * @returns {{params:{correlation:number, volMultiplier:number, driftDrag:number, driftPct:number, tailFatten?:number}, route:'aggregate'|'deep', rules:string[]}}
 */
export function fuseRiskParams({ context = {}, deepRequested = false } = {}) {
  const agg = aggregateStress({ turbulence: context.turbulence, drawdownPct: context.drawdownPct })
  const scenarioNeedsEmergent =
    context.turbulence === 'turbulent' || (Number(context.drawdownPct) || 0) <= -10
  const route = routeBehavior({ deepRequested, scenarioNeedsEmergent })

  let params = {
    correlation: agg.correlation,
    volMultiplier: agg.volMultiplier,
    driftDrag: agg.driftDrag,
    driftPct: Number(context.apyTrendPct) || 0,
  }
  let rules = [...agg.rules]

  if (route === 'deep') {
    const deep = emergentStress({ rumorIntensity: context.rumorIntensity })
    params = {
      ...params,
      correlation: +Math.min(0.99, params.correlation + deep.correlationBump).toFixed(2),
      tailFatten: deep.tailFatten,
    }
    rules = [...rules, ...deep.rules]
  }
  return { params, route, rules }
}

/**
 * Run N seeded correlated paths for a 2-asset basket and reduce to VaR/CVaR.
 * @param {Array<{weight:number, dailyVolPct:number}>} basket two assets, weights ~sum 1
 * @param {{params:object, route:string, rules:string[]}} fused output of fuseRiskParams
 * @param {{runs?:number, horizonDays?:number, seed?:number, alpha?:number}} [opts]
 * @returns {{metrics:object, route:string, rules:string[], runs:number, horizonDays:number}}
 */
export function runRiskSimulation(basket, fused, opts = {}) {
  const runs = opts.runs || DEFAULT_RUNS
  const horizonDays = opts.horizonDays || DEFAULT_HORIZON_DAYS
  const seed = opts.seed != null ? opts.seed : 1
  const alpha = opts.alpha != null ? opts.alpha : 0.95

  const outcomes = []
  for (let i = 0; i < runs; i++) {
    const rng = makeRng((seed + i * SEED_STRIDE) >>> 0)
    outcomes.push(simulateCorrelatedPath(basket, fused.params, rng, { horizonDays }))
  }
  return {
    metrics: riskMetrics(outcomes, alpha),
    route: fused.route,
    rules: fused.rules,
    runs,
    horizonDays,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/riskParams.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/riskParams.js frontend/src/strategy/riskParams.test.js
git commit -m "feat: riskParams fusion + seeded VaR/CVaR simulation runner"
```

---

## Task 2: Convert the proof script into a regression test

**Files:**
- Create: `frontend/src/strategy/riskProof.test.js`
- Delete: `frontend/src/strategy/__riskproof.mjs`

**Interfaces:**
- Consumes: `fuseRiskParams`, `runRiskSimulation` (Task 1); `checkTailCompliance(metrics, {riskTier}) → {verdict, citedRule, citation, reason, floor}` from `complianceCorpus.js`.
- Produces: nothing for later tasks — this locks the headline "honest spread" claim (calm PASS / panic VETO) as a regression.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/riskProof.test.js`. This reproduces the `__riskproof.mjs` run as assertions — same basket, horizon, drift, and the calm-PASS / panic-VETO verdicts from the spec table:

```js
// frontend/src/strategy/riskProof.test.js
// Regression of the Phase-1 "honest spread" proof: one rule corpus, fed two
// distributions (calm vs panic), returns two cited verdicts. The mean is nearly
// identical both ways; only the CVaR tail diverges. Replaces __riskproof.mjs.
import { describe, test, expect } from 'vitest'
import { fuseRiskParams, runRiskSimulation } from './riskParams.js'
import { checkTailCompliance } from './complianceCorpus.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const OPTS = { runs: 10000, horizonDays: 30, seed: 1 }
const DRIFT = 8

function runMarket(context) {
  const fused = fuseRiskParams({ context: { ...context, apyTrendPct: DRIFT } })
  return runRiskSimulation(BASKET, fused, OPTS).metrics
}

describe('Phase-1 honest-spread proof (regression)', () => {
  test('calm market: shallow tail, CVaR passes the moderate floor', () => {
    // Arrange / Act
    const m = runMarket({ turbulence: 'calm', drawdownPct: 0 })
    const verdict = checkTailCompliance(m, { riskTier: 'moderate' })
    // Assert
    expect(m.mean).toBeGreaterThan(0)
    expect(m.cvar95).toBeGreaterThan(-3)
    expect(verdict.verdict).toBe('pass')
    expect(verdict.citedRule).toBe('CVAR_TAIL_FLOOR')
  })

  test('panic market: ~identical mean, fat tail, CVaR vetoes the moderate floor', () => {
    // Arrange / Act
    const m = runMarket({ turbulence: 'turbulent', drawdownPct: -12 })
    const verdict = checkTailCompliance(m, { riskTier: 'moderate' })
    // Assert
    expect(m.mean).toBeGreaterThan(0) // mean stays green — it hides the tail
    expect(m.cvar95).toBeLessThan(-5) // tail breaches the -5% moderate floor
    expect(verdict.verdict).toBe('veto')
    expect(verdict.citedRule).toBe('CVAR_TAIL_FLOOR')
  })

  test('same rule, two distributions, two verdicts', () => {
    // Arrange
    const calm = checkTailCompliance(runMarket({ turbulence: 'calm', drawdownPct: 0 }), { riskTier: 'moderate' })
    const panic = checkTailCompliance(runMarket({ turbulence: 'turbulent', drawdownPct: -12 }), { riskTier: 'moderate' })
    // Assert
    expect(calm.citedRule).toBe(panic.citedRule)
    expect(calm.verdict).not.toBe(panic.verdict)
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/riskProof.test.js`
Expected: PASS (3 tests). It should pass immediately — it exercises only proven + Task-1 code. If a numeric bound fails, the simulation drifted; investigate before adjusting the bound (the spec table is the ground truth).

- [ ] **Step 3: Delete the throwaway proof script**

```bash
git rm frontend/src/strategy/__riskproof.mjs
```

- [ ] **Step 4: Confirm nothing imported the deleted file**

Run: `cd frontend && npx vitest run src/strategy/`
Expected: PASS — no "Failed to resolve import './__riskproof'" anywhere.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/riskProof.test.js
git commit -m "test: convert risk proof script to regression test; drop demo file"
```

---

## Task 3: `councilLoop` — bounded debate with deterministic short-circuit

**Files:**
- Create: `frontend/src/strategy/councilLoop.js`
- Test: `frontend/src/strategy/councilLoop.test.js`

**Interfaces:**
- Consumes: `checkTailCompliance(metrics, {riskTier}) → {verdict:'pass'|'veto'|'abstain', citedRule, citation, reason, floor}` from `complianceCorpus.js`. AI tie-break is injected (mirrors `council.js`'s `resolveConflict`): `decide({metrics, risk, proposal}) → Promise<'proceed'|'hold'>`.
- Produces: `councilLoop(input, deps) → Promise<{outcome:'converge'|'no-consensus'|'fatal', proposal, citedRules:string[], iterations:number, trace:Array}>` where the returned `proposal` carries a `recommend:'proceed'|'hold'`. `input` = `{metrics, proposal:{allocation, citedNumbers:{cvar95:number}, payload?}, riskTier}`. `deps` = `{decide?, maxIter?}`.

**Loop semantics (deterministic first, AI only on genuine ambiguity):**
1. **Validator (deterministic):** the proposer's cited `cvar95` must match the sim's `metrics.cvar95` within `EPSILON`. Mismatch → `fatal` immediately (numbers lied).
2. **Risk/Compliance (deterministic, cited):** `checkTailCompliance`. A `veto` means the proposer yields → agreement to hold → `converge` (recommend `hold`), no AI call. A `pass` with clear headroom above the floor → `converge` (recommend `proceed`), no AI call.
3. **Ambiguous middle** (`abstain`, or `pass` without headroom): one injected `decide` AI call per round. `proceed` → `converge`. `hold` → loop again until `maxIter`, then `no-consensus`. `decide` is called at most `maxIter` times (cost bound). Loop is autonomous only in reasoning.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/councilLoop.test.js`:

```js
// frontend/src/strategy/councilLoop.test.js
import { describe, test, expect, vi } from 'vitest'
import { councilLoop } from './councilLoop.js'

// A clean pass distribution: CVaR -2 sits well above the moderate -5 floor.
const PASS_METRICS = { cvar95: -2, worst: -4, mean: 0.6 }
// A breach: CVaR -8 is below the moderate -5 floor → Risk hard-vetoes.
const VETO_METRICS = { cvar95: -8, worst: -14, mean: 0.5 }
// Near the floor: CVaR -4.6 passes -5 but with < 1pp headroom → ambiguous.
const NEAR_METRICS = { cvar95: -4.6, worst: -9, mean: 0.4 }

const proposalFor = (m) => ({ allocation: [{ vault: 'A', weight: 1 }], citedNumbers: { cvar95: m.cvar95 } })

describe('councilLoop exits', () => {
  test('clear pass converges to proceed WITHOUT an AI call', async () => {
    // Arrange
    const decide = vi.fn()
    // Act
    const r = await councilLoop(
      { metrics: PASS_METRICS, proposal: proposalFor(PASS_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('proceed')
    expect(r.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(decide).not.toHaveBeenCalled()
  })

  test('cited veto converges to hold WITHOUT an AI call', async () => {
    // Arrange
    const decide = vi.fn()
    // Act
    const r = await councilLoop(
      { metrics: VETO_METRICS, proposal: proposalFor(VETO_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('hold')
    expect(r.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(decide).not.toHaveBeenCalled()
  })

  test('fatal when cited numbers do not match the sim output', async () => {
    // Arrange — proposer claims a friendlier CVaR than the sim produced
    const decide = vi.fn()
    const lyingProposal = { allocation: [], citedNumbers: { cvar95: -1 } }
    // Act
    const r = await councilLoop(
      { metrics: VETO_METRICS, proposal: lyingProposal, riskTier: 'moderate' },
      { decide, maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('fatal')
    expect(decide).not.toHaveBeenCalled()
  })

  test('ambiguous + AI says proceed → converge, decide called once', async () => {
    // Arrange
    const decide = vi.fn().mockResolvedValue('proceed')
    // Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('proceed')
    expect(decide).toHaveBeenCalledTimes(1)
  })

  test('ambiguous + AI keeps saying hold → no-consensus, decide capped at maxIter', async () => {
    // Arrange
    const decide = vi.fn().mockResolvedValue('hold')
    // Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('no-consensus')
    expect(r.proposal.recommend).toBe('hold')
    expect(decide).toHaveBeenCalledTimes(2) // hard iteration cap = cost bound
  })

  test('ambiguous with no AI dep falls back to hold, never fabricates proceed', async () => {
    // Arrange / Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { maxIter: 2 },
    )
    // Assert
    expect(r.outcome).toBe('no-consensus')
    expect(r.proposal.recommend).toBe('hold')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/councilLoop.test.js`
Expected: FAIL — `Failed to resolve import "./councilLoop.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/strategy/councilLoop.js`:

```js
// frontend/src/strategy/councilLoop.js
// Strategy-level council debate over a simulated VaR/CVaR distribution. Distinct
// from councilReview.js (the per-deposit gate): different input, different job.
// Deterministic specialists short-circuit first so the cheap path never spends an
// AI call: a numeric Validator (proposer's cited numbers must match the sim) and a
// cited Risk/Compliance check (cite-or-abstain over complianceCorpus). Only the
// genuinely ambiguous middle escalates to one bounded AI tie-break per round, hard-
// capped at maxIter. The loop is autonomous ONLY in reasoning — it produces a
// recommendation and STOPS; it never executes. Three exits: converge / no-consensus
// (a valid result, surfaced to the human) / fatal (numbers do not reconcile).

import { checkTailCompliance } from './complianceCorpus.js'

// Cited CVaR is the sim's own rounded output; allow only float-rounding slack.
const EPSILON = 0.011
// Headroom (percentage points) above the tier floor that counts as a clear pass.
const HEADROOM_PP = 1

const trace = (entries, e) => (entries.push(e), entries)

/**
 * @param {{metrics:{cvar95:number, worst?:number, mean?:number}, proposal:{allocation?:any, citedNumbers:{cvar95:number}, payload?:any}, riskTier?:string}} input
 * @param {{decide?:(ctx:{metrics:object, risk:object, proposal:object})=>Promise<'proceed'|'hold'>, maxIter?:number}} [deps]
 * @returns {Promise<{outcome:'converge'|'no-consensus'|'fatal', proposal:object, citedRules:string[], iterations:number, trace:Array}>}
 */
export async function councilLoop(input, deps = {}) {
  const { metrics, proposal, riskTier = 'moderate' } = input
  const { decide, maxIter = 2 } = deps
  const entries = []

  const settle = (outcome, recommend, citedRules, iterations) => ({
    outcome,
    proposal: { ...proposal, recommend },
    citedRules,
    iterations,
    trace: entries,
  })

  for (let iter = 1; iter <= maxIter; iter++) {
    // 1. Validator (deterministic, cheapest, catches a lying proposer first).
    const cited = Number(proposal?.citedNumbers?.cvar95)
    if (!Number.isFinite(cited) || Math.abs(cited - metrics.cvar95) > EPSILON) {
      trace(entries, { role: 'validator', ok: false, cited, sim: metrics.cvar95 })
      return settle('fatal', 'hold', [], iter)
    }
    trace(entries, { role: 'validator', ok: true })

    // 2. Risk/Compliance (deterministic, cite-or-abstain).
    const risk = checkTailCompliance(metrics, { riskTier })
    trace(entries, { role: 'risk', ...risk })

    if (risk.verdict === 'veto') {
      // Proposer yields to a cited breach → agreement to hold.
      return settle('converge', 'hold', risk.citedRule ? [risk.citedRule] : [], iter)
    }
    if (risk.verdict === 'pass' && metrics.cvar95 - (risk.floor ?? 0) > HEADROOM_PP) {
      // Clear headroom above the floor → agreement to proceed.
      return settle('converge', 'proceed', risk.citedRule ? [risk.citedRule] : [], iter)
    }

    // 3. Ambiguous (abstain, or a pass hugging the floor) → one bounded AI call.
    let stance = 'hold'
    if (typeof decide === 'function') {
      try {
        stance = await decide({ metrics, risk, proposal })
      } catch {
        stance = 'hold'
      }
    }
    trace(entries, { role: 'ai-tiebreak', stance })
    if (stance === 'proceed') {
      return settle('converge', 'proceed', risk.citedRule ? [risk.citedRule] : [], iter)
    }
    // else: proposer re-tries next round until the cap.
  }

  // Cap reached without agreement — a valid "no clear edge" result, not a failure.
  return settle('no-consensus', 'hold', [], maxIter)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/councilLoop.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/councilLoop.js frontend/src/strategy/councilLoop.test.js
git commit -m "feat: bounded strategy council loop (validator + cited risk + AI tie-break)"
```

---

## Task 4: `permissionLayer` — one sentence + explicit Yes/No gate

**Files:**
- Create: `frontend/src/strategy/permissionLayer.js`
- Test: `frontend/src/strategy/permissionLayer.test.js`

**Interfaces:**
- Consumes: `asLoss(x) → number` from `riskMetrics.js` (loss-magnitude framing for the human sentence). LLM summary is injected: `summarize({result, metrics, riskTier}) → Promise<string>`. Execution + reject-logging are injected: `execute(payload) → Promise<any>`, `onReject(permission) → any`.
- Produces:
  - `buildPermission(result, ctx) → Promise<{sentence:string, recommend:'proceed'|'hold', payload:any, outcome:string}>` where `result` is a `councilLoop` result and `ctx` = `{metrics, riskTier, summarize?}`.
  - `confirmPermission(permission, answer, deps) → Promise<{executed:boolean, reason:string}>` — executes only on `answer === true` and never when `permission.outcome === 'fatal'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/permissionLayer.test.js`:

```js
// frontend/src/strategy/permissionLayer.test.js
import { describe, test, expect, vi } from 'vitest'
import { buildPermission, confirmPermission } from './permissionLayer.js'

const converged = (recommend, outcome = 'converge') => ({
  outcome,
  proposal: { recommend, payload: { kind: 'rebalance', to: 'B' } },
  citedRules: ['CVAR_TAIL_FLOOR'],
})
const METRICS = { cvar95: -2.4, worst: -4.3, mean: 0.6 }

describe('buildPermission', () => {
  test('falls back to a deterministic template when no LLM is provided', async () => {
    // Arrange / Act
    const p = await buildPermission(converged('proceed'), { metrics: METRICS, riskTier: 'moderate' })
    // Assert
    expect(p.recommend).toBe('proceed')
    expect(p.sentence).toContain('2.4%') // loss-framed CVaR surfaced honestly
    expect(p.payload).toEqual({ kind: 'rebalance', to: 'B' })
  })

  test('uses the LLM sentence when present, but template if it throws', async () => {
    // Arrange
    const good = vi.fn().mockResolvedValue('Risk is up, but mostly from gas — proceed?')
    const bad = vi.fn().mockRejectedValue(new Error('LLM down'))
    // Act
    const a = await buildPermission(converged('proceed'), { metrics: METRICS, riskTier: 'moderate', summarize: good })
    const b = await buildPermission(converged('proceed'), { metrics: METRICS, riskTier: 'moderate', summarize: bad })
    // Assert
    expect(a.sentence).toBe('Risk is up, but mostly from gas — proceed?')
    expect(b.sentence).toContain('2.4%') // template fallback, never throws
  })

  test('no-consensus recommends hold', async () => {
    // Arrange / Act
    const p = await buildPermission({ outcome: 'no-consensus', proposal: { recommend: 'hold' }, citedRules: [] },
      { metrics: METRICS, riskTier: 'moderate' })
    // Assert
    expect(p.recommend).toBe('hold')
  })
})

describe('confirmPermission (WAJIB BERHENTI)', () => {
  test('executes only on an explicit true', async () => {
    // Arrange
    const execute = vi.fn().mockResolvedValue('tx')
    const permission = { outcome: 'converge', recommend: 'proceed', payload: { kind: 'rebalance' } }
    // Act
    const yes = await confirmPermission(permission, true, { execute })
    // Assert
    expect(yes.executed).toBe(true)
    expect(execute).toHaveBeenCalledWith({ kind: 'rebalance' })
  })

  test('never auto-proceeds without a true (No, undefined, truthy non-true)', async () => {
    // Arrange
    const execute = vi.fn()
    const onReject = vi.fn()
    const permission = { outcome: 'converge', recommend: 'proceed', payload: {} }
    // Act
    const no = await confirmPermission(permission, false, { execute, onReject })
    const blank = await confirmPermission(permission, undefined, { execute, onReject })
    const sneaky = await confirmPermission(permission, 'yes', { execute, onReject })
    // Assert
    expect(no.executed).toBe(false)
    expect(blank.executed).toBe(false)
    expect(sneaky.executed).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(3)
  })

  test('a fatal result never executes even on an explicit Yes', async () => {
    // Arrange
    const execute = vi.fn()
    const permission = { outcome: 'fatal', recommend: 'hold', payload: {} }
    // Act
    const r = await confirmPermission(permission, true, { execute })
    // Assert
    expect(r.executed).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/permissionLayer.test.js`
Expected: FAIL — `Failed to resolve import "./permissionLayer.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/strategy/permissionLayer.js`:

```js
// frontend/src/strategy/permissionLayer.js
// The human gate. Converts a converged council result into ONE plain sentence
// (injected LLM, with a deterministic template fallback that never throws) and a
// Yes/No decision. WAJIB BERHENTI: nothing here moves funds — confirmPermission
// executes ONLY on an explicit `true`, and never when the council exit was fatal,
// regardless of the answer. Reuses the established "AI proposes → human reviews →
// then runs" pattern; only the payload changes from deposit to rebalance. Pure +
// dependency-injected: summarize / execute / onReject are all passed in.

import { asLoss } from './riskMetrics.js'

/** Deterministic, honest, never-throwing sentence. CVaR is surfaced loss-framed. */
function templateSentence(result, metrics, riskTier) {
  const loss = asLoss(Number(metrics?.cvar95) || 0) // positive = expected worst-5% loss
  if (result.outcome === 'fatal') {
    return 'The numbers did not reconcile against the simulation — stopping for safety. Nothing will run.'
  }
  if (result.outcome === 'no-consensus') {
    return `The council could not agree within ${result.iterations ?? 'the'} rounds — no clear edge. Hold for now?`
  }
  if (result.proposal?.recommend === 'proceed') {
    return `Projected worst-case (5%) loss is about ${loss}% — within your ${riskTier} limit. Proceed with the rebalance?`
  }
  return `Projected worst-case (5%) loss of about ${loss}% reaches your ${riskTier} risk floor — recommend holding. Proceed anyway?`
}

/**
 * @param {{outcome:string, proposal?:{recommend?:string, payload?:any}, citedRules?:string[], iterations?:number}} result councilLoop output
 * @param {{metrics:object, riskTier?:string, summarize?:(ctx:object)=>Promise<string>}} ctx
 * @returns {Promise<{sentence:string, recommend:'proceed'|'hold', payload:any, outcome:string}>}
 */
export async function buildPermission(result, ctx = {}) {
  const { metrics, riskTier = 'moderate', summarize } = ctx
  const recommend =
    result.outcome === 'converge' && result.proposal?.recommend === 'proceed' ? 'proceed' : 'hold'

  let sentence = templateSentence(result, metrics, riskTier)
  if (typeof summarize === 'function') {
    try {
      const s = await summarize({ result, metrics, riskTier })
      if (s && typeof s === 'string') sentence = s.trim()
    } catch {
      /* keep the template fallback — the gate must never break on a flaky LLM */
    }
  }
  return { sentence, recommend, payload: result.proposal?.payload ?? null, outcome: result.outcome }
}

/**
 * The Yes/No gate. Executes ONLY on an explicit boolean true and never on a fatal
 * council exit. Any other answer (No, undefined, a truthy non-true) is a rejection
 * routed to the injected onReject sink for ACE learning.
 * @param {{outcome:string, recommend:string, payload:any}} permission
 * @param {boolean} answer must be strictly `true` to proceed
 * @param {{execute?:(payload:any)=>Promise<any>, onReject?:(permission:object)=>any}} deps
 * @returns {Promise<{executed:boolean, reason:string, txResult?:any}>}
 */
export async function confirmPermission(permission, answer, deps = {}) {
  const { execute, onReject } = deps
  if (permission?.outcome === 'fatal') {
    try { onReject?.(permission) } catch { /* logging must never block the stop */ }
    return { executed: false, reason: 'fatal: numbers did not reconcile' }
  }
  if (answer !== true) {
    try { onReject?.(permission) } catch { /* ignore */ }
    return { executed: false, reason: 'declined by human' }
  }
  if (typeof execute !== 'function') {
    return { executed: false, reason: 'no executor wired' }
  }
  const txResult = await execute(permission.payload)
  return { executed: true, reason: 'approved by human', txResult }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/permissionLayer.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/permissionLayer.js frontend/src/strategy/permissionLayer.test.js
git commit -m "feat: permission layer — one-sentence gate, explicit-yes-only, fatal-safe"
```

---

## Task 5: `riskCouncil` — pure orchestrator chaining the pipeline (hard stop)

**Files:**
- Create: `frontend/src/strategy/riskCouncil.js`
- Test: `frontend/src/strategy/riskCouncil.test.js`

**Interfaces:**
- Consumes: `fuseRiskParams`, `runRiskSimulation` (Task 1); `councilLoop` (Task 3); `buildPermission` (Task 4).
- Produces: `runRiskCouncil(input, deps) → Promise<{sim, council, permission, awaitingHuman:true, executed:false}>`.
  - `input` = `{basket, riskTier, context, deepRequested?, proposal:{allocation, payload?}}`.
  - `deps` = `{decide?, summarize?, maxIter?, runs?, horizonDays?, seed?}`.
  - This is the single seam the future "Risk & Council" UI panel consumes. It runs the simulation, builds the proposer's cited numbers from the sim output, debates, and produces the human sentence — then **stops**. It is given no executor and never moves funds. Execution is a separate, later `confirmPermission` call.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/riskCouncil.test.js`:

```js
// frontend/src/strategy/riskCouncil.test.js
import { describe, test, expect, vi } from 'vitest'
import { runRiskCouncil } from './riskCouncil.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const BASE = {
  basket: BASKET,
  riskTier: 'moderate',
  proposal: { allocation: [{ vault: 'A', weight: 1 }], payload: { kind: 'rebalance', to: 'B' } },
}
const OPTS = { runs: 4000, horizonDays: 30, seed: 1, maxIter: 2 }

describe('runRiskCouncil end to end', () => {
  test('calm market converges to proceed and stops for the human', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      OPTS,
    )
    // Assert
    expect(out.sim.metrics.cvar95).toBeGreaterThan(-3)
    expect(out.council.outcome).toBe('converge')
    expect(out.permission.recommend).toBe('proceed')
    expect(out.awaitingHuman).toBe(true)
    expect(out.executed).toBe(false)
  })

  test('panic market converges to hold on a cited veto', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'turbulent', drawdownPct: -12, apyTrendPct: 8 } },
      OPTS,
    )
    // Assert
    expect(out.sim.metrics.cvar95).toBeLessThan(-5)
    expect(out.council.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(out.permission.recommend).toBe('hold')
    expect(out.executed).toBe(false)
  })

  test('WAJIB BERHENTI: the orchestrator never receives or calls an executor', async () => {
    // Arrange — even if a stray execute leaks into deps, the orchestrator must ignore it
    const execute = vi.fn()
    // Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      { ...OPTS, execute },
    )
    // Assert
    expect(execute).not.toHaveBeenCalled()
    expect(out.executed).toBe(false)
    expect(out.awaitingHuman).toBe(true)
  })

  test('proposer cited numbers are taken from the sim, so the validator never goes fatal', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      OPTS,
    )
    // Assert
    expect(out.council.outcome).not.toBe('fatal')
    expect(out.proposalCited.cvar95).toBe(out.sim.metrics.cvar95)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/riskCouncil.test.js`
Expected: FAIL — `Failed to resolve import "./riskCouncil.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/strategy/riskCouncil.js`:

```js
// frontend/src/strategy/riskCouncil.js
// Pure orchestrator for the Phase-1 risk pipeline: live context → honest VaR/CVaR
// distribution → bounded council debate → one-sentence human gate. The proposer's
// cited numbers are taken straight from the sim output, so an honest run never trips
// the Validator. WAJIB BERHENTI: this function is given NO executor and never moves
// funds — it returns awaitingHuman:true / executed:false and hands a permission
// object to the UI. Execution is a separate, explicit confirmPermission(...) call.
// This is the single seam the "Risk & Council" panel consumes.

import { fuseRiskParams, runRiskSimulation } from './riskParams.js'
import { councilLoop } from './councilLoop.js'
import { buildPermission } from './permissionLayer.js'

/**
 * @param {{basket:Array, riskTier?:string, context?:object, deepRequested?:boolean, proposal:{allocation?:any, payload?:any}}} input
 * @param {{decide?:Function, summarize?:Function, maxIter?:number, runs?:number, horizonDays?:number, seed?:number}} [deps]
 * @returns {Promise<{sim:object, council:object, permission:object, proposalCited:{cvar95:number}, awaitingHuman:true, executed:false}>}
 */
export async function runRiskCouncil(input, deps = {}) {
  const { basket, riskTier = 'moderate', context = {}, deepRequested = false, proposal = {} } = input
  const { decide, summarize, maxIter, runs, horizonDays, seed } = deps

  // 1. Fuse params + run the honest-spread simulation.
  const fused = fuseRiskParams({ context, deepRequested })
  const sim = runRiskSimulation(basket, fused, { runs, horizonDays, seed })

  // 2. The proposer cites the sim's own numbers (validator stays consistent on honest runs).
  const proposalCited = { cvar95: sim.metrics.cvar95 }
  const fullProposal = { ...proposal, citedNumbers: proposalCited }

  // 3. Debate (deterministic short-circuit; bounded AI tie-break only on ambiguity).
  const council = await councilLoop({ metrics: sim.metrics, proposal: fullProposal, riskTier }, { decide, maxIter })

  // 4. One-sentence human gate. We STOP here — no execution on this path.
  const permission = await buildPermission(council, { metrics: sim.metrics, riskTier, summarize })

  return { sim, council, permission, proposalCited, awaitingHuman: true, executed: false }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/riskCouncil.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full strategy suite to confirm no regression**

Run: `cd frontend && npx vitest run src/strategy/`
Expected: PASS — the new files plus every existing strategy test (including `council.test.js` and `councilReview.test.js`) stay green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/strategy/riskCouncil.js frontend/src/strategy/riskCouncil.test.js
git commit -m "feat: riskCouncil orchestrator — honest-spread pipeline with hard human stop"
```

---

## Out of scope for this plan (follow-ups)

- **"Risk & Council" UI panel (spec §10).** A presentational `/strategy` panel — histogram with the worst-5% tail marked, deep-mode toggle, collapsible debate trace, the one-sentence Yes/No gate — consuming `runRiskCouncil` output and reusing `AgentActionPreview` / `RightRail`. This is a visual subsystem: run it as a separate plan with the frontend-design / ui-ux-pro-max skills (per the project's design-skills preference), wiring `summarize` → `askVeniceJson`, `decide` → `resolveCouncilConflict`, `execute` → the existing relay/worker path, and `onReject` → a `reflector`/`playbook` log call. `runRiskCouncil` already returns a fully-shaped, tested object, so the panel is pure glue.
- **Phase 2 (spec §14):** full 4-signal fan-out; the deep emergent external engine adapter behind `routeBehavior`; vector-RAG backend behind the `complianceCorpus` retriever.

## Self-Review

**Spec coverage:**
- §5.2 `riskParams.js` → Task 1. §5.2 `councilLoop.js` → Task 3. §5.2 `permissionLayer.js` → Task 4.
- §8 VaR/CVaR sim wiring → Task 1 (`runRiskSimulation` feeds `riskMetrics`).
- §6 council mechanics (3 roles, 3 exits, max-iter, deterministic short-circuit, cost guard, WAJIB BERHENTI) → Task 3.
- §9 permission (one sentence, LLM + template fallback, explicit Yes/No, No → log) → Task 4 + the `onReject` seam.
- §11 data contracts → matched: `councilLoop` returns `{outcome, proposal, citedRules, iterations, trace}`; `permissionLayer` returns `{sentence, recommend, payload}` (plus `outcome` for the fatal guard).
- §12 testing plan → `councilLoop` exits + short-circuit + cap (Task 3), `permissionLayer` fallback + explicit-Yes (Task 4), `__riskproof.mjs` → regression test then delete (Task 2). `riskMetrics` / `behavioral` / `complianceCorpus` unit tests already exist (proven modules).
- §10 UX panel → explicitly deferred to a follow-up plan (documented above).
- §13 honest limits → encoded as comment/string discipline in the Global Constraints (no "debate provably better", no accuracy %, cite-or-abstain, asLoss-framed sentence).

**Placeholder scan:** no TBD / "add error handling" / "write tests for the above" — every code and test step carries full content.

**Type consistency:** `fuseRiskParams` → `{params, route, rules}` consumed unchanged by `runRiskSimulation` (Task 1) and `runRiskCouncil` (Task 5). `councilLoop` result shape `{outcome, proposal:{recommend}, citedRules, iterations, trace}` is consumed by `buildPermission` (Task 4) and asserted in Task 5. `proposal.citedNumbers.cvar95` set by `runRiskCouncil` matches the Validator's read in `councilLoop`. `buildPermission` / `confirmPermission` names are stable across Tasks 4–5.

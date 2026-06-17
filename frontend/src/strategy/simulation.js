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

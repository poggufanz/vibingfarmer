// frontend/src/strategy/riskParams.js
// Phase-1 param fusion + simulation runner for the risk pipeline. Turns live
// market context (turbulence / drawdown / apy trend) plus the proven behavioral
// deltas into one Monte Carlo param object, then runs N seeded correlated paths
// through riskMetrics to get an honest VaR/CVaR distribution. The aggregate path
// is always on (cheap math); the deep emergent stand-in is an optional toggle
// behind routeBehavior and only fattens the tail further — it never replaces the
// aggregate path and is never on the critical path. Pure + deterministic: RNG is
// seeded, no network, no storage. (Full 4-signal fan-out is Phase 2.)

import {
  aggregateStress,
  emergentStress,
  routeBehavior,
  simulateCorrelatedPath,
} from './behavioral.js'
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

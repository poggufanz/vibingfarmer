// frontend/src/strategy/behavioral.js
// Behavioral layer for the risk simulation — mock-agent Tingkat 1 (always, pure
// math) + a router toward an optional deep emergent stand-in. No LLM on the hot
// path. The aggregate mock mimics the EFFECT of crowd behavior: when the market
// panics (or a drawdown breach trips), the herd sells together → cross-asset
// correlation spikes and volatility surges, which fattens the loss tail. That
// tail-fattening is exactly what plain Monte Carlo (independent assets) misses.
// Pure functions only; RNG injected.

import { gaussian } from './rng.js'

const BASE_CORRELATION = 0.2
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/**
 * Tingkat-1 aggregate stress rules. Turbulence regime and a drawdown breach map
 * to correlation / volatility / drift deltas. Deterministic effect-mimicry — the
 * cheap 99% path. Returns NEW params; cites which rule fired.
 * @param {{turbulence?:'calm'|'elevated'|'turbulent', drawdownPct?:number}} [ctx]
 */
export function aggregateStress({ turbulence = 'calm', drawdownPct = 0 } = {}) {
  let correlation = BASE_CORRELATION
  let volMultiplier = 1
  let driftDrag = 0
  const rules = []
  if (turbulence === 'elevated') {
    correlation = 0.5
    volMultiplier = 1.5
    driftDrag = -0.5
    rules.push('herd-elevated')
  }
  if (turbulence === 'turbulent') {
    correlation = 0.85
    volMultiplier = 2.5
    driftDrag = -1.5
    rules.push('herd-turbulent')
  }
  // A drawdown breach deepens the herd regardless of the regime label.
  if (drawdownPct <= -10) {
    correlation = Math.max(correlation, 0.8)
    volMultiplier = Math.max(volMultiplier, 2.0)
    rules.push('drawdown-correlation-spike')
  }
  return { correlation: +correlation.toFixed(2), volMultiplier, driftDrag, rules }
}

/**
 * Optional deep emergent stand-in (the toggle). A LOCAL approximation of
 * narrative-driven dynamics — rumor contagion / opinion clustering — expressed as
 * extra tail fatness fed to Monte Carlo as additional params. Never replaces the
 * aggregate path; the real external engine is a future adapter behind this seam.
 * @param {{rumorIntensity?:number}} [ctx] 0..1
 */
export function emergentStress({ rumorIntensity = 0.5 } = {}) {
  const k = clamp(rumorIntensity, 0, 1)
  return {
    correlationBump: +(0.1 * k).toFixed(2), // opinion clusters move together
    tailFatten: +(1 + 0.6 * k).toFixed(2), // heavier extreme draws
    rules: ['emergent-rumor-contagion'],
  }
}

/** Router: aggregate (always, cheap) vs deep (only if requested AND scenario warrants). */
export function routeBehavior({ deepRequested = false, scenarioNeedsEmergent = false } = {}) {
  return deepRequested && scenarioNeedsEmergent ? 'deep' : 'aggregate'
}

/**
 * One correlated portfolio path over `horizonDays`. Two-asset Cholesky: a shared
 * factor z1 drives both assets by `correlation`, so as correlation → 1 the assets
 * crash together (the fat tail). Returns the compounded horizon return in %.
 * @param {Array<{weight:number, dailyVolPct:number}>} assets two assets, weights ~sum 1
 * @param {{correlation:number, volMultiplier?:number, driftPct?:number, driftDrag?:number, tailFatten?:number}} params
 * @param {() => number} rng injected uniform generator
 * @param {{horizonDays?:number}} [opts]
 * @returns {number} horizon return in %
 */
export function simulateCorrelatedPath(assets, params, rng, opts = {}) {
  const horizon = opts.horizonDays || 30
  const rho = clamp(params.correlation ?? BASE_CORRELATION, 0, 0.99)
  const volMult = (params.volMultiplier || 1) * (params.tailFatten || 1)
  const driftDaily = ((params.driftPct || 0) + (params.driftDrag || 0)) / 365 / 100
  const [a, b] = assets
  let cumulative = 0
  for (let d = 0; d < horizon; d++) {
    const z1 = gaussian(rng)
    const z2 = gaussian(rng)
    const e1 = z1 // correlated standard normals (2-asset Cholesky)
    const e2 = rho * z1 + Math.sqrt(1 - rho * rho) * z2
    const r1 = ((a.dailyVolPct * volMult) / 100) * e1
    const r2 = ((b.dailyVolPct * volMult) / 100) * e2
    cumulative += a.weight * r1 + b.weight * r2 + driftDaily
  }
  return +(cumulative * 100).toFixed(4)
}

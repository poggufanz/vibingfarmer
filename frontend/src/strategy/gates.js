// frontend/src/strategy/gates.js
// Fast-fail gates — the FIRST line of defense for the /strategy monitor loop.
// Inspired by FinRL (AI4Finance): the Turbulence Index restricts the agent to
// defensive actions when the market is chaotic, and the trading environment hard-
// codes constraints that disable illegal actions outright. Here every gate is a
// PURE function (state, idea) -> { id, passed, reason } — no AI call, no network,
// no storage. When a gate blocks, the loop sleeps without spending Venice credit.
//
// Offensive ideas (deposit / rebalance) deploy capital and are what we guard.
// Defensive ideas (harvest / withdraw) reduce exposure and always pass — this is
// the DeFi analog of FinRL's "turbulent market => only sell allowed".

import { RISK_RANK, normalizeRisk, riskCeiling } from './mdp.js'

/** Action kinds that deploy capital — the only kinds gates can block. */
export const OFFENSIVE_KINDS = ['deposit', 'rebalance']

/** Below this much free USDC a deposit/rebalance is not worth a cycle. */
const MIN_DEPLOY_USDC = 1

const isOffensive = (idea) => OFFENSIVE_KINDS.includes(idea && idea.kind)

/** FinRL Turbulence Index: a turbulent regime blocks every offensive action. */
export function turbulenceGate(state, idea) {
  const turbulent = state && state.market && state.market.turbulence === 'turbulent'
  if (turbulent && isOffensive(idea)) {
    return { id: 'turbulence', passed: false, reason: `turbulent market — ${idea.kind} blocked, defensive actions only` }
  }
  return { id: 'turbulence', passed: true }
}

/** Network congestion = execution risk: a gas spike defers offensive actions. */
export function gasGate(state, idea) {
  const signals = (state && state.market && state.market.signals) || []
  if (signals.includes('gas-spike') && isOffensive(idea)) {
    return { id: 'gas', passed: false, reason: `gas spike — ${idea.kind} deferred until network calms` }
  }
  return { id: 'gas', passed: true }
}

/** Nothing to deploy → no point asking the council. */
export function capitalGate(state, idea) {
  const amount = Number((state && state.capital && state.capital.amountUsdc) || 0)
  if (isOffensive(idea) && amount < MIN_DEPLOY_USDC) {
    return { id: 'capital', passed: false, reason: 'no deployable capital' }
  }
  return { id: 'capital', passed: true }
}

/** Hard environment constraint: if no vault sits within the effective risk
 *  ceiling there is no legal allocation, so the council would only churn. */
export function universeGate(state, idea) {
  if (!isOffensive(idea)) return { id: 'universe', passed: true }
  const ceiling = RISK_RANK[riskCeiling(state)]
  const universe = (state && state.universe) || []
  const hasLegal = universe.some((v) => RISK_RANK[normalizeRisk(v.riskTier)] <= ceiling)
  if (!hasLegal) {
    return { id: 'universe', passed: false, reason: `no vault within ${riskCeiling(state)} ceiling` }
  }
  return { id: 'universe', passed: true }
}

// Ordering is the fail-fast priority: cheapest / most decisive first.
const GATES = [turbulenceGate, gasGate, capitalGate, universeGate]

/**
 * Run every gate and report the first blocker (if any). Pure.
 * @param {Object} state StrategyState (see mdp.buildStrategyState)
 * @param {Object} idea  { kind, ... }
 * @returns {{ passed:boolean, blockedBy:string|null, reason:string|null, results:Array }}
 */
export function evaluateGates(state, idea) {
  const results = GATES.map((g) => g(state, idea))
  const blocked = results.find((r) => !r.passed)
  if (blocked) return { passed: false, blockedBy: blocked.id, reason: blocked.reason, results }
  return { passed: true, blockedBy: null, reason: null, results }
}

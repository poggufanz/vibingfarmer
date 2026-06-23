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

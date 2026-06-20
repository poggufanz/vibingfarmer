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
  // Fail-closed gate: only a converged 'proceed' is executable, so only the proceed
  // sentence poses a Yes/No. Every hold path ends "Nothing will run." — no
  // "Proceed anyway?" affordance the gate would refuse anyway.
  if (result.outcome === 'no-consensus') {
    return `The council could not agree within ${result.iterations ?? 'the'} rounds — no clear edge, recommend holding. Nothing will run.`
  }
  if (result.proposal?.recommend === 'proceed') {
    return `Projected worst-case (5%) loss is about ${loss}% — within your ${riskTier} limit. Proceed with the rebalance?`
  }
  return `Projected worst-case (5%) loss of about ${loss}% reaches your ${riskTier} risk floor — recommend holding. Nothing will run.`
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
 * The Yes/No gate. Fail-closed allow-list: executes ONLY when the council's own
 * deterministic decision was an affirmative converge+proceed AND the human answered
 * an explicit boolean true. Every other state — fatal, no-consensus, a converged
 * hold, or any unknown future outcome string — is refused even on a Yes, so the gate
 * can never drift open (WAJIB BERHENTI). Any refusal/decline is routed to the
 * injected onReject sink for ACE learning.
 * @param {{outcome:string, recommend:string, payload:any}} permission
 * @param {boolean} answer must be strictly `true` to proceed
 * @param {{execute?:(payload:any)=>Promise<any>, onReject?:(permission:object)=>any}} deps
 * @returns {Promise<{executed:boolean, reason:string, txResult?:any}>}
 */
export async function confirmPermission(permission, answer, deps = {}) {
  const { execute, onReject } = deps
  if (permission?.outcome !== 'converge' || permission?.recommend !== 'proceed') {
    try { onReject?.(permission) } catch { /* logging must never block the stop */ }
    return { executed: false, reason: `not approved by council: ${permission?.outcome}/${permission?.recommend}` }
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

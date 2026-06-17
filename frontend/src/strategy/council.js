// frontend/src/strategy/council.js
// TradingAgents-style AI Council (TauricResearch arXiv 2412.20138), adapted to
// DeFi yield farming. Three specialists (Yield / Risk / Market) run in parallel
// and each emit {signal, confidence, citedRules, concerns}. A synthesis step
// resolves them: hard-veto (Risk WITHDRAW>0.85) → unanimity → weighted majority,
// and ONLY on a genuine split escalates to one injected AI call (ACE-cited rules
// flow through to the playbook). Deterministic specialists = cheap, never-stop-safe.
//
// Dependencies are injected: { weight(ruleId)->number, resolveConflict(verdicts,market)->Promise<signal> }.

const VETO_CONF = 0.85

const clampConf = (c) => Math.max(0, Math.min(1, +Number(c).toFixed(3)))

/** Yield Analyst — risk-adjusted uplift. Harvest = free reward claim → DEPOSIT. */
function yieldSpecialist({ action, currentReward, projectedReward }, weight) {
  const isHarvest = action.kind === 'harvest'
  const uplift = projectedReward.riskAdjustedScore - currentReward.riskAdjustedScore
  if (isHarvest) {
    return { role: 'yield', signal: 'DEPOSIT', confidence: clampConf(0.8 * weight('yield-harvest-free')), citedRules: ['yield-harvest-free'], concerns: [] }
  }
  if (uplift > 0) {
    const base = Math.min(0.95, 0.6 + Math.abs(uplift) * 0.2)
    return { role: 'yield', signal: 'DEPOSIT', confidence: clampConf(base * weight('yield-uplift')), citedRules: ['yield-uplift'], concerns: [] }
  }
  return { role: 'yield', signal: 'HOLD', confidence: clampConf(0.6 * weight('yield-no-uplift')), citedRules: ['yield-no-uplift'], concerns: ['no risk-adjusted uplift'] }
}

/** Risk Analyst — turbulent regime or gate violation ⇒ WITHDRAW (hard veto). */
function riskSpecialist({ action, state }, weight) {
  const violations = action.violations || []
  if (state.market.turbulence === 'turbulent') {
    return { role: 'risk', signal: 'WITHDRAW', confidence: clampConf(0.9 * weight('risk-turbulent-veto')), citedRules: ['risk-turbulent-veto'], concerns: ['turbulent market'] }
  }
  if (violations.length > 0) {
    return { role: 'risk', signal: 'WITHDRAW', confidence: clampConf(0.88 * weight('risk-gate-violation')), citedRules: ['risk-gate-violation'], concerns: violations.slice(0, 2) }
  }
  return { role: 'risk', signal: 'DEPOSIT', confidence: clampConf(0.6 * weight('risk-calm-clear')), citedRules: ['risk-calm-clear'], concerns: [] }
}

/** Market Analyst — gas/timing. Harvest timing is always fine (free claim). */
function marketSpecialist({ action, currentReward, projectedReward, estGasUsdc = 0.5 }, weight) {
  const isHarvest = action.kind === 'harvest'
  if (isHarvest) {
    return { role: 'market', signal: 'DEPOSIT', confidence: clampConf(0.75 * weight('market-harvest-timing')), citedRules: ['market-harvest-timing'], concerns: [] }
  }
  const netUsdc = (projectedReward.projectedAnnualUsdc - currentReward.projectedAnnualUsdc) - estGasUsdc
  if (netUsdc > 0) {
    return { role: 'market', signal: 'DEPOSIT', confidence: clampConf(0.8 * weight('market-gas-positive')), citedRules: ['market-gas-positive'], concerns: [] }
  }
  return { role: 'market', signal: 'HOLD', confidence: clampConf(0.7 * weight('market-gas-negative')), citedRules: ['market-gas-negative'], concerns: ['gas exceeds expected gain'] }
}

const ROLE_LABEL = { yield: 'Yield Optimizer', risk: 'Risk Analyst', market: 'Gas Strategist' }

/**
 * Run the council and synthesize a keep/discard verdict.
 * @param {Object} input { action, currentReward, projectedReward, state, estGasUsdc }
 * @param {{weight:(id:string)=>number, resolveConflict:(verdicts,market)=>Promise<string>}} deps
 */
export async function councilVerdict(input, { weight = () => 1.0, resolveConflict }) {
  const w = weight
  const specialists = [
    yieldSpecialist(input, w),
    riskSpecialist(input, w),
    marketSpecialist(input, w),
  ]
  const risk = specialists.find((s) => s.role === 'risk')
  const cited = (signal) => specialists.filter((s) => s.signal === signal).flatMap((s) => s.citedRules)

  // 1. Hard veto — TradingAgents safety mechanism.
  if (risk.signal === 'WITHDRAW' && risk.confidence > VETO_CONF) {
    return result('discard', 'Risk Analyst', risk.confidence, risk.citedRules, specialists, 'veto')
  }

  // 2. Tally signals (weighted by confidence).
  const tally = {}
  for (const s of specialists) tally[s.signal] = (tally[s.signal] || 0) + s.confidence
  const counts = specialists.reduce((m, s) => ((m[s.signal] = (m[s.signal] || 0) + 1), m), {})

  // 2a. Unanimous.
  if (counts.DEPOSIT === 3) {
    return result('keep', null, avgConf(specialists), cited('DEPOSIT'), specialists, 'unanimous')
  }
  if ((counts.HOLD || 0) + (counts.WITHDRAW || 0) === 3) {
    return result('discard', firstNonDeposit(specialists), avgConf(specialists), [], specialists, 'unanimous')
  }

  // 2b. Weighted majority — a side leads by a clear confidence margin.
  const proceed = (tally.DEPOSIT || 0) / 3
  const against = ((tally.HOLD || 0) + (tally.WITHDRAW || 0)) / 3
  const MARGIN = 0.25
  if (proceed - against > MARGIN) {
    return result('keep', null, proceed, cited('DEPOSIT'), specialists, 'weighted')
  }
  if (against - proceed > MARGIN) {
    return result('discard', firstNonDeposit(specialists), against, [], specialists, 'weighted')
  }

  // 3. Genuine split → escalate to ONE AI call (only awaiting path).
  let signal = 'HOLD'
  if (typeof resolveConflict === 'function') {
    try { signal = await resolveConflict(specialists, input.state.market) } catch { signal = 'HOLD' }
  }
  const keep = signal === 'DEPOSIT'
  return result(keep ? 'keep' : 'discard', keep ? null : 'AI synthesis', avgConf(specialists), keep ? cited('DEPOSIT') : [], specialists, 'ai-conflict')
}

function result(verdict, reason, confidence, citedRules, specialists, resolvedBy) {
  return { verdict, reason, confidence: +Number(confidence).toFixed(3), citedRules: [...new Set(citedRules)], specialists, resolvedBy }
}
function avgConf(s) { return s.reduce((a, x) => a + x.confidence, 0) / s.length }
function firstNonDeposit(s) {
  const x = s.find((v) => v.signal !== 'DEPOSIT')
  return x ? ROLE_LABEL[x.role] : null
}
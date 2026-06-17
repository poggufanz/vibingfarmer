// frontend/src/strategy/councilReview.js
// TradingAgents-style AI Council for the /strategy wizard (TauricResearch
// arXiv 2412.20138). Three specialists — Yield / Risk / Market — deliberate in
// PARALLEL on the proposed deposit. Each is a real AI call (DeepSeek server proxy)
// with its own system prompt, a role-filtered playbook subset, and a different
// data slice. AI-ONLY: a specialist that cannot produce a real verdict (after one
// retry) yields null and the council reports 'unavailable' — it never fabricates a
// signal. Synthesis: hard-veto (Risk WITHDRAW>0.85) → unanimity → weighted
// majority → ONE injected AI conflict call. Cited rules flow to reflector.js
// after deposit.
//
// Distinct from council.js (the always-on monitor-loop council, deterministic by
// design): this module is AI-first and runs once, at strategy review time.

const VETO_CONF = 0.85
const MARGIN = 0.25

export const ROLE_LABEL = { yield: 'Yield Analyst', risk: 'Risk Analyst', market: 'Market Analyst' }

const ROLE_SYSTEM = {
  yield: 'You are the Yield Analyst on a DeFi AI Council. You judge ONLY yield quality: blended APY vs the risk profile, the risk-adjusted projected annual return, and whether TVL makes the quoted APY credible. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  risk: 'You are the Risk Analyst on a DeFi AI Council. You judge ONLY downside risk: market regime (turbulent ⇒ WITHDRAW), action-space gate violations, basket drawdown vs the profile tolerance. Safety outranks yield. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  market: 'You are the Market Analyst on a DeFi AI Council. You judge ONLY timing and execution cost: gas level vs expected yield, regime, and any adverse live market signals. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
}

/** Build the per-role user prompt with that role's data slice + citable rule ids. */
export function buildSpecialistPrompt(role, input, rules) {
  const ruleList = rules.map((r) => `  - ${r.id}: ${r.description}`).join('\n')
  const vaults = input.vaults.map((v) => `${v.name} (${v.protocol}) ${v.apy}% APY · ${v.allocationPct}% alloc · ${v.drawdown}% dd · ${v.riskTier}`).join('; ')
  let slice = ''
  if (role === 'yield') {
    slice = `Blended APY: ${input.blendedApy}%\nProjected annual (risk-adjusted): ${input.projectedAnnualUsdc} USDC\nRisk-adjusted score: ${input.riskAdjustedScore} (penalty ${input.riskPenalty})\nProfile risk: ${input.riskTier}`
  } else if (role === 'risk') {
    slice = `Market regime: ${input.turbulence}\nGate violations: ${input.violations.length ? input.violations.join('; ') : 'none'}\nBasket max drawdown (30d): ${input.maxDrawdown}%\nProfile risk tolerance: ${input.riskTier}`
  } else {
    slice = `Gas: ${input.gasGwei ?? 'n/a'} gwei (${input.gasLevel ?? 'n/a'})\nMarket regime: ${input.turbulence}\nLive market signals: ${input.marketSignals.length ? input.marketSignals.join('; ') : 'none'}`
  }
  return `Proposed deposit: ${input.amountUsdc} USDC across ${input.numVaults} vault(s): ${vaults}\n\nYour data:\n${slice}\n\nRules you may cite (use the id):\n${ruleList}\n\nShould we proceed with this deposit? Respond in JSON only.`
}

/** Adapt strategy + StrategyState into the council input. Pure. */
export function buildCouncilInput(strategy, state = {}) {
  const reward = strategy?.reward || {}
  const mdp = strategy?.mdpState || {}
  const vaults = (strategy?.agents || []).map((a) => ({
    name: a.vault?.name || '',
    protocol: a.vault?.protocol || '',
    apy: Number(a.vault?.apy) || 0,
    drawdown: Number(a.vault?.drawdown) || 0,
    allocationPct: strategy?.total ? +(((Number(a.allocation) || 0) / strategy.total) * 100).toFixed(1) : 0,
    riskTier: a.vault?.risk || a.vault?.risk_tier || 'medium',
  }))
  return {
    amountUsdc: Number(strategy?.total) || 0,
    numVaults: vaults.length,
    blendedApy: Number(strategy?.blendedApy) || 0,
    projectedAnnualUsdc: Number(reward.projectedAnnualUsdc) || 0,
    riskAdjustedScore: Number(reward.riskAdjustedScore) || 0,
    riskPenalty: Number(reward.riskPenalty) || 0,
    turbulence: mdp.turbulence || state?.market?.turbulence || 'calm',
    violations: mdp.actionViolations || [],
    maxDrawdown: vaults.reduce((m, v) => Math.max(m, v.drawdown), 0),
    riskTier: strategy?.risk || mdp.profileRisk || 'medium',
    gasGwei: mdp.gasGwei ?? state?.gas?.gwei ?? null,
    gasLevel: mdp.gasLevel ?? state?.gas?.level ?? null,
    marketSignals: mdp.signals || state?.market?.signals || [],
    vaults,
  }
}

/** Synthesize 3 verdicts into a keep/discard result. Mirrors council.js synthesis. */
export async function synthesize(verdicts, { resolveConflict, market }) {
  const risk = verdicts.find((v) => v.role === 'risk') || { signal: 'HOLD', confidence: 0 }
  const cited = (signal) => [...new Set(verdicts.filter((v) => v.signal === signal).flatMap((v) => v.citedRules))]
  const avg = verdicts.reduce((a, v) => a + v.confidence, 0) / (verdicts.length || 1)
  const labelFirstNonDeposit = () => {
    const x = verdicts.find((v) => v.signal !== 'DEPOSIT')
    return x ? ROLE_LABEL[x.role] : null
  }
  const res = (verdict, reason, confidence, citedRules, resolvedBy) =>
    ({ verdict, reason, confidence: +Number(confidence).toFixed(3), citedRules, specialists: verdicts, resolvedBy })

  // 1. Hard veto
  if (risk.signal === 'WITHDRAW' && risk.confidence > VETO_CONF) {
    return res('discard', 'Risk Analyst', risk.confidence, risk.citedRules, 'veto')
  }
  // 2. Tally
  const counts = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + 1), m), {})
  const tally = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + v.confidence), m), {})
  if (counts.DEPOSIT === 3) return res('keep', null, avg, cited('DEPOSIT'), 'unanimous')
  if ((counts.HOLD || 0) + (counts.WITHDRAW || 0) === 3) return res('discard', labelFirstNonDeposit(), avg, [], 'unanimous')
  const proceed = (tally.DEPOSIT || 0) / 3
  const against = ((tally.HOLD || 0) + (tally.WITHDRAW || 0)) / 3
  if (proceed - against > MARGIN) return res('keep', null, proceed, cited('DEPOSIT'), 'weighted')
  if (against - proceed > MARGIN) return res('discard', labelFirstNonDeposit(), against, [], 'weighted')
  // 3. Genuine split → one AI conflict call
  let signal = 'HOLD'
  if (typeof resolveConflict === 'function') {
    try { signal = await resolveConflict(verdicts, market) } catch { signal = 'HOLD' }
  }
  const keep = signal === 'DEPOSIT'
  return res(keep ? 'keep' : 'discard', keep ? null : 'AI synthesis', avg, keep ? cited('DEPOSIT') : [], 'ai-conflict')
}

/** Run one specialist with up to `attempts` tries. Returns a real verdict or null. */
async function runSpecialist(role, input, deps, attempts) {
  const { specialist, ROLE_RULES, devApiKey, signal } = deps
  if (typeof specialist !== 'function') return null
  const rules = ROLE_RULES[role] || []
  const userPrompt = buildSpecialistPrompt(role, input, rules)
  const allowedRuleIds = rules.map((r) => r.id)
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await specialist({ role, systemPrompt: ROLE_SYSTEM[role], userPrompt, allowedRuleIds, devApiKey, signal })
      if (v) return v
    } catch { /* retry */ }
  }
  return null
}

/**
 * Run the full wizard council. AI-only: if any specialist cannot produce a real
 * verdict after `attempts` tries, returns an 'unavailable' result (no fabricated
 * signal) so the UI can offer a retry.
 * @param {import('./councilReview.js').CouncilInput} input
 * @param {{ specialist?:Function, resolveConflict?:Function, weight?:Function, devApiKey?:string|null, signal?:AbortSignal, attempts?:number }} deps
 *   specialist({role, systemPrompt, userPrompt, allowedRuleIds, devApiKey, signal}) → Promise<SpecialistVerdict|null>
 * @returns {Promise<import('./councilReview.js').CouncilResult>}
 */
export async function councilReview(input, deps = {}) {
  const { specialist, resolveConflict, devApiKey = null, signal, attempts = 2 } = deps
  const { ROLE_RULES } = await import('./playbookRules.js')
  const roles = ['yield', 'risk', 'market']
  const sharedDeps = { specialist, ROLE_RULES, devApiKey, signal }
  const settled = await Promise.all(roles.map((role) => runSpecialist(role, input, sharedDeps, attempts)))
  const verdicts = settled.filter(Boolean)
  if (verdicts.length < roles.length) {
    return { verdict: 'unavailable', reason: 'council unavailable', confidence: 0, citedRules: [], specialists: verdicts, resolvedBy: 'unavailable' }
  }
  return synthesize(verdicts, { resolveConflict, market: { turbulence: input.turbulence } })
}

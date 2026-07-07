// frontend/src/strategy/councilReview.js
// Two council modes:
//   (A) Legacy — TradingAgents-style AI Council (arXiv 2412.20138).
//       Three specialists (Yield/Risk/Market) in parallel, one-shot.
//       Used by the monitor loop and retained for backward compat.
//   (B) Debate — Iterative adversarial council for the /strategy wizard.
//       Proposer (temp high) ↔ Risk/Compliance (temp 0.0) loop until
//       convergence, then Validator cross-checks vs simulation (VaR/CVaR).
//       Hard stop gate → 1-sentence permission summary.

const VETO_CONF = 0.85
const MARGIN = 0.25

export const ROLE_LABEL = { yield: 'Yield Analyst', risk: 'Risk Analyst', market: 'Market Analyst' }

const ROLE_SYSTEM = {
  yield: 'You are the Yield Analyst on a DeFi AI Council. You judge ONLY yield quality: blended APY vs the risk profile, the risk-adjusted projected annual return, and whether TVL makes the quoted APY credible. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  risk: 'You are the Risk Analyst on a DeFi AI Council. You judge ONLY downside risk: market regime (turbulent ⇒ WITHDRAW), action-space gate violations, basket drawdown vs the profile tolerance. Safety outranks yield. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  market: 'You are the Market Analyst on a DeFi AI Council. You judge ONLY timing and execution cost: gas level vs expected yield, regime, and any adverse live market signals. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
}

// ── Legacy: buildSpecialistPrompt, buildCouncilInput, synthesize, councilReview ──

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

  if (risk.signal === 'WITHDRAW' && risk.confidence > VETO_CONF) {
    return res('discard', 'Risk Analyst', risk.confidence, risk.citedRules, 'veto')
  }
  const counts = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + 1), m), {})
  const tally = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + v.confidence), m), {})
  if (counts.DEPOSIT === 3) return res('keep', null, avg, cited('DEPOSIT'), 'unanimous')
  if ((counts.HOLD || 0) + (counts.WITHDRAW || 0) === 3) return res('discard', labelFirstNonDeposit(), avg, [], 'unanimous')
  const proceed = (tally.DEPOSIT || 0) / 3
  const against = ((tally.HOLD || 0) + (tally.WITHDRAW || 0)) / 3
  if (proceed - against > MARGIN) return res('keep', null, proceed, cited('DEPOSIT'), 'weighted')
  if (against - proceed > MARGIN) return res('discard', labelFirstNonDeposit(), against, [], 'weighted')
  let signal = 'HOLD'
  if (typeof resolveConflict === 'function') {
    try { signal = await resolveConflict(verdicts, market) } catch { signal = 'HOLD' }
  }
  const keep = signal === 'DEPOSIT'
  return res(keep ? 'keep' : 'discard', keep ? null : 'AI synthesis', avg, keep ? cited('DEPOSIT') : [], 'ai-conflict')
}

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

// ── New: Debate Council (Proposer ↔ Risk/Compliance loop + Validator) ──

const CONVERGE_DEFAULT = 0.15
const MAX_ITER_DEFAULT = 5

export const DEBATE_ROLE_LABEL = {
  proposer: 'Yield Proposer',
  'risk-compliance': 'Risk & Compliance',
  validator: 'Simulation Validator',
}

export const DEBATE_SYSTEM = {
  proposer: `You are the Yield Proposer — an opportunistic strategist seeking profitable deposit opportunities.
You propose vault allocations and argue WHY they should proceed.
You respond to compliance concerns by adjusting your proposal.
Output JSON only: {"proposal":{"action":"DEPOSIT|HOLD|WITHDRAW","reasoning":"...","confidence":0..1},"arguments":["..."],"citedRules":["..."]}`,
  'risk-compliance': `You are the Risk & Compliance Officer — a strict regulator enforcing investment rules.
You evaluate the Proposer's argument against compliance rules.
You NEVER compromise on risk limits. Safety outranks yield.
Output JSON only: {"assessment":{"action":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1},"violationsFound":["..."],"regulationsCited":["..."],"concerns":["..."],"compliancePass":true|false}`,
  validator: `You are the Simulation Validator — a numerical consistency checker.
Your ONLY job: verify the debate outcome is consistent with Monte Carlo simulation results.
You receive VaR (Value at Risk) and CVaR (Conditional VaR) from the simulation.
Output JSON only: {"consistent":true|false,"VaRAcceptable":true|false,"CVaRAcceptable":true|false,"simMatches":true|false,"concerns":["..."],"confidence":0..1}`,
}

export function buildDebateInput(strategy, simulation, state = {}) {
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
    VaR: simulation?.VaR ?? null,
    CVaR: simulation?.CVaR ?? null,
    expectedValue: simulation?.expectedValue ?? null,
    probProfit: simulation?.probProfit ?? null,
  }
}

function buildProposerPrompt(input, riskFeedback) {
  const vaults = input.vaults.map((v) => `${v.name} (${v.protocol}) ${v.apy}% APY · ${v.allocationPct}% alloc · ${v.riskTier}`).join('; ')
  let prompt = `Proposed deposit: ${input.amountUsdc} USDC across ${input.numVaults} vault(s): ${vaults}
Market regime: ${input.turbulence}
Profile risk: ${input.riskTier}
Blended APY: ${input.blendedApy}%
Risk-adjusted projected annual: ${input.projectedAnnualUsdc} USDC`
  if (riskFeedback && riskFeedback.length) {
    prompt += `\n\nRisk & Compliance concerns to address:\n${riskFeedback.map((c) => `  - ${c}`).join('\n')}`
  }
  return prompt
}

function buildRiskCompliancePrompt(input, proposer) {
  const vaults = input.vaults.map((v) => `${v.name} (${v.protocol}) ${v.apy}% APY · ${v.allocationPct}% alloc · ${v.riskTier}`).join('; ')
  let prompt = `Proposed deposit: ${input.amountUsdc} USDC across ${input.numVaults} vault(s): ${vaults}
Market regime: ${input.turbulence}
Max drawdown: ${input.maxDrawdown}%
Profile risk: ${input.riskTier}

Proposer argument:
  Action: ${proposer?.proposal?.action || 'unknown'}
  Reasoning: ${proposer?.proposal?.reasoning || 'none'}
  Arguments: ${(proposer?.arguments || []).join('; ') || 'none'}
  Confidence: ${proposer?.proposal?.confidence ?? 'n/a'}`
  return prompt
}

function buildValidatorPrompt(input, proposer, riskComp) {
  return `Proposed deposit: ${input.amountUsdc} USDC across ${input.numVaults} vault(s)
Blended APY: ${input.blendedApy}%
Expected value (30d): ${input.expectedValue ?? 'n/a'} USDC
VaR (${input.VaR != null ? '95%' : 'n/a'}): ${input.VaR ?? 'n/a'} USDC
CVaR: ${input.CVaR ?? 'n/a'} USDC
Probability of profit: ${input.probProfit != null ? (input.probProfit * 100).toFixed(1) : 'n/a'}%

Proposer: ${proposer?.proposal?.action || 'unknown'} (conf ${proposer?.proposal?.confidence ?? 'n/a'})
Risk/Compliance: ${riskComp?.assessment?.action || 'unknown'} (conf ${riskComp?.assessment?.confidence ?? 'n/a'}, pass: ${riskComp?.compliancePass ?? 'n/a'})

Are these numbers consistent? Does the VaR/CVaR stay within acceptable range for a ${input.riskTier} risk profile?`
}

async function runProposer(input, riskFeedback, deps) {
  const { proposer, ROLE_RULES, devApiKey, signal } = deps
  if (typeof proposer !== 'function') return null
  const rules = ROLE_RULES.proposer || []
  const userPrompt = buildProposerPrompt(input, riskFeedback)
  const allowedRuleIds = rules.map((r) => r.id)
  try {
    return await proposer({ systemPrompt: DEBATE_SYSTEM.proposer, userPrompt, allowedRuleIds, devApiKey, signal })
  } catch {
    return null
  }
}

async function runRiskCompliance(input, proposer, deps) {
  const { riskCompliance, ROLE_RULES, devApiKey, signal } = deps
  if (typeof riskCompliance !== 'function' || !proposer) return null
  const rules = ROLE_RULES['risk-compliance'] || []
  const userPrompt = buildRiskCompliancePrompt(input, proposer)
  const allowedRuleIds = rules.map((r) => r.id)
  try {
    return await riskCompliance({ systemPrompt: DEBATE_SYSTEM['risk-compliance'], userPrompt, allowedRuleIds, devApiKey, signal })
  } catch {
    return null
  }
}

async function runValidator(input, proposer, riskComp, deps) {
  const { validator, devApiKey, signal } = deps
  if (typeof validator !== 'function' || !proposer || !riskComp) return null
  const userPrompt = buildValidatorPrompt(input, proposer, riskComp)
  try {
    return await validator({ systemPrompt: DEBATE_SYSTEM.validator, userPrompt, devApiKey, signal })
  } catch {
    return null
  }
}

export function isConverged(proposer, riskComp, threshold = CONVERGE_DEFAULT) {
  if (!proposer || !riskComp) return false
  const pAction = proposer.proposal?.action
  const rAction = riskComp.assessment?.action
  if (!pAction || !rAction) return false
  const sameSignal = pAction === rAction
  const confGap = Math.abs((proposer.proposal?.confidence ?? 0) - (riskComp.assessment?.confidence ?? 0))
  return sameSignal && confGap < threshold
}

export function hardStopGate(validator, proposer, riskComp) {
  if (!validator || !validator.consistent) {
    return { passed: false, reason: 'SIMULATION MISMATCH — proposal inconsistent with VaR/CVaR model', detail: validator?.concerns?.join('; ') || '' }
  }
  if (riskComp && riskComp.compliancePass === false) {
    return { passed: false, reason: 'COMPLIANCE VIOLATION', detail: (riskComp.violationsFound || []).join('; ') }
  }
  if (proposer?.proposal?.action === 'WITHDRAW' || riskComp?.assessment?.action === 'WITHDRAW') {
    return { passed: false, reason: 'COUNCIL RECOMMENDS WITHDRAW', detail: 'Both proposer and risk agree to defer' }
  }
  return { passed: true, reason: null, detail: null }
}

export function summarizeToSentence(proposer, riskComp, validator, input) {
  const action = proposer?.proposal?.action || 'unknown'
  const pConf = ((proposer?.proposal?.confidence ?? 0) * 100).toFixed(0)
  const compPass = riskComp?.compliancePass === true ? 'PASS' : 'FAIL'
  const vaRatio = input.VaR != null && input.amountUsdc ? `VaR ${(Math.abs(input.VaR) / input.amountUsdc * 100).toFixed(1)}%` : 'VaR n/a'
  const profitOdds = input.probProfit != null ? `${(input.probProfit * 100).toFixed(0)}% profit odds` : ''
  return `Deposit $${input.amountUsdc} across ${input.numVaults} vault(s): ${action} (${pConf}% confidence), compliance ${compPass}, ${vaRatio}${profitOdds ? ', ' + profitOdds : ''}.`
}

export async function councilDebate(input, deps = {}) {
  const {
    proposer,
    riskCompliance,
    validator,
    devApiKey = null,
    signal,
    maxIterations = MAX_ITER_DEFAULT,
    convergenceThreshold = CONVERGE_DEFAULT,
  } = deps
  const { ROLE_RULES } = await import('./playbookRules.js')
  const sharedDeps = { proposer, riskCompliance, ROLE_RULES, devApiKey, signal }

  let proposerResult = null
  let riskCompResult = null
  const debateLog = []

  for (let i = 0; i < maxIterations; i++) {
    const riskFeedback = riskCompResult?.concerns || null
    proposerResult = await runProposer(input, riskFeedback, sharedDeps)
    if (!proposerResult) {
      return { verdict: 'unavailable', reason: 'Proposer unavailable — AI call failed', debateLog, iterations: i + 1, converged: false }
    }
    riskCompResult = await runRiskCompliance(input, proposerResult, sharedDeps)
    if (!riskCompResult) {
      return { verdict: 'unavailable', reason: 'Risk/Compliance unavailable — AI call failed', debateLog, iterations: i + 1, converged: false }
    }
    debateLog.push({
      iteration: i + 1,
      proposer: { action: proposerResult.proposal?.action, confidence: proposerResult.proposal?.confidence, arguments: proposerResult.arguments },
      riskCompliance: { action: riskCompResult.assessment?.action, confidence: riskCompResult.assessment?.confidence, violations: riskCompResult.violationsFound, compliancePass: riskCompResult.compliancePass },
    })
    if (isConverged(proposerResult, riskCompResult, convergenceThreshold)) {
      break
    }
  }

  const validatorResult = await runValidator(input, proposerResult, riskCompResult, { validator, devApiKey, signal })

  const gate = hardStopGate(validatorResult, proposerResult, riskCompResult)
  const converged = isConverged(proposerResult, riskCompResult, convergenceThreshold)

  if (!gate.passed || validatorResult?.consistent === false) {
    return {
      verdict: 'discard',
      reason: gate.reason || 'Validator rejected',
      detail: gate.detail || (validatorResult?.concerns || []).join('; '),
      debateLog,
      iterations: debateLog.length,
      converged,
      proposer: proposerResult,
      riskCompliance: riskCompResult,
      validator: validatorResult,
      gate,
      permissionSentence: null,
      confidence: Math.min(
        proposerResult?.proposal?.confidence ?? 0,
        riskCompResult?.assessment?.confidence ?? 0
      ),
    }
  }

  const sentence = summarizeToSentence(proposerResult, riskCompResult, validatorResult, input)

  return {
    verdict: 'keep',
    reason: null,
    detail: null,
    debateLog,
    iterations: debateLog.length,
    converged,
    proposer: proposerResult,
    riskCompliance: riskCompResult,
    validator: validatorResult,
    gate,
    permissionSentence: sentence,
    confidence: (
      (proposerResult?.proposal?.confidence ?? 0) +
      (riskCompResult?.assessment?.confidence ?? 0) +
      (validatorResult?.confidence ?? 0)
    ) / 3,
  }
}

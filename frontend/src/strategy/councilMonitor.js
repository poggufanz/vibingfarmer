import { riskComplianceVerdict, validatorVerdict } from '../strategist.js'
import {
  buildDebateInput,
  DEBATE_SYSTEM,
  summarizeToSentence,
  hardStopGate,
} from './councilReview.js'

const STORAGE_KEY = 'yv_council_snapshot'
const MAX_HISTORY = 20

export function saveSnapshot(result, marketData) {
  const entry = {
    timestamp: Date.now(),
    result,
    marketData: {
      apyByVault: marketData.apyByVault || {},
      turbulence: marketData.turbulence || 'calm',
      gasGwei: marketData.gasGwei ?? null,
      VaR: result?.VaR ?? null,
      CVaR: result?.CVaR ?? null,
      blendedApy: marketData.blendedApy ?? null,
    },
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const history = raw ? JSON.parse(raw) : []
    history.unshift(entry)
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    /* localStorage full or unavailable */
  }
}

export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function loadLatestSnapshot() {
  const history = loadSnapshot()
  return history?.[0] ?? null
}

export function loadSnapshotHistory() {
  return loadSnapshot() || []
}

export function clearSnapshot() {
  localStorage.removeItem(STORAGE_KEY)
}

export function diffMarket(currentData, snapshot, thresholds = {}) {
  if (!snapshot) return { score: 100, level: 'full', reasons: ['No previous snapshot'] }

  const lastMarket = snapshot.marketData || {}
  const reasons = []
  let score = 0

  const apyDrift = thresholds.apyDriftThreshold ?? 5
  const varBreach = thresholds.varBreachThreshold ?? 10

  if (currentData.apyByVault && lastMarket.apyByVault) {
    for (const [vault, currentApy] of Object.entries(currentData.apyByVault)) {
      const lastApy = lastMarket.apyByVault[vault]
      if (lastApy && lastApy > 0) {
        const drift = Math.abs((currentApy - lastApy) / lastApy) * 100
        if (drift > apyDrift) {
          score += Math.min((drift / apyDrift) * 20, 40)
          reasons.push(`APY for ${vault} changed by ${drift.toFixed(1)}%. Threshold: ${apyDrift}%.`)
        }
      }
    }
  }

  const lastVaR = lastMarket.VaR
  const currentVaR = currentData.VaR ?? currentData.estimatedVaR
  if (lastVaR != null && currentVaR != null && lastVaR !== 0) {
    const varChange = Math.abs((currentVaR - lastVaR) / lastVaR) * 100
    if (varChange > varBreach) {
      score += Math.min((varChange / varBreach) * 30, 50)
      reasons.push(`VaR changed by ${varChange.toFixed(1)}%. Threshold: ${varBreach}%.`)
    }
  }

  if (
    currentData.turbulence &&
    lastMarket.turbulence &&
    currentData.turbulence !== lastMarket.turbulence
  ) {
    score += 20
    reasons.push(
      `Market regime changed from ${lastMarket.turbulence} to ${currentData.turbulence}.`
    )
  }

  if (currentData.gasGwei != null && lastMarket.gasGwei != null) {
    const gasRatio = currentData.gasGwei / lastMarket.gasGwei
    if (gasRatio > 2 || gasRatio < 0.5) {
      score += 15
      reasons.push(`Gas changed from ${lastMarket.gasGwei} to ${currentData.gasGwei} gwei.`)
    }
  }

  if (currentData.riskNews) {
    score += 30
    reasons.push(`Risk news: ${currentData.riskNews}`)
  }

  let level = 'skip'
  if (score >= 50) level = 'full'
  else if (score >= 20) level = 'fast'

  return { score: Math.min(score, 100), level, reasons }
}

export async function fastReeval(strategy, input, currentData, deps = {}) {
  const { ROLE_RULES } = await import('./playbookRules.js')

  const debateInput = buildDebateInput(strategy, {
    VaR: currentData.estimatedVaR,
    CVaR: currentData.estimatedCVaR,
    expectedValue: currentData.expectedValue,
    probProfit: currentData.probProfit,
  })

  const riskCompRules = ROLE_RULES['risk-compliance'] || []
  const riskCompAllowedIds = riskCompRules.map((r) => r.id)

  const riskCompResult = await riskComplianceVerdict({
    systemPrompt: DEBATE_SYSTEM['risk-compliance'],
    userPrompt: `Proposed deposit: ${debateInput.amountUsdc} USDC across ${debateInput.numVaults} vault(s)
Market regime: ${currentData.turbulence || 'calm'}
Max drawdown: ${currentData.maxDrawdown ?? 0}%
Profile risk: ${debateInput.riskTier}

Previous council verdict: ${input?.verdict || 'keep'}
Permission: ${input?.permissionSentence || 'none'}

Current market data: APY per vault = ${JSON.stringify(currentData.apyByVault)}
VaR: ${currentData.estimatedVaR ?? 'n/a'}
CVaR: ${currentData.estimatedCVaR ?? 'n/a'}

Has anything changed materially? Is the previous permission still safe?`,
    allowedRuleIds: riskCompAllowedIds,
    devApiKey: deps.devApiKey || null,
    signal: deps.signal || null,
  })

  if (!riskCompResult) {
    return { passed: false, error: 'Risk/Compliance unavailable', level: 'skip' }
  }

  if (riskCompResult.compliancePass === false) {
    return {
      passed: false,
      error: 'Compliance violation detected',
      violations: riskCompResult.violationsFound,
      level: 'full',
    }
  }

  const validatorResult = await validatorVerdict({
    systemPrompt: DEBATE_SYSTEM.validator,
    userPrompt: `Proposed deposit: ${debateInput.amountUsdc} USDC across ${debateInput.numVaults} vault(s)
Expected value (30d): ${currentData.expectedValue ?? 'n/a'} USDC
VaR: ${currentData.estimatedVaR ?? 'n/a'} USDC
CVaR: ${currentData.estimatedCVaR ?? 'n/a'} USDC
Probability of profit: ${currentData.probProfit != null ? (currentData.probProfit * 100).toFixed(1) : 'n/a'}%

Previous permission: ${input?.permissionSentence || 'none'}

Are these numbers still consistent? Does the VaR/CVaR stay within acceptable range for a ${debateInput.riskTier} risk profile?`,
    devApiKey: deps.devApiKey || null,
    signal: deps.signal || null,
  })

  if (!validatorResult || validatorResult.consistent === false) {
    return {
      passed: false,
      error: 'The validator rejected the update because VaR and CVaR do not match.',
      level: 'full',
    }
  }

  return {
    passed: true,
    level: 'fast',
    riskCompliance: riskCompResult,
    validator: validatorResult,
    permissionSentence: summarizeToSentence(
      { proposal: { action: 'DEPOSIT', confidence: riskCompResult.assessment?.confidence || 0.5 } },
      riskCompResult,
      validatorResult,
      debateInput
    ),
    confidence:
      ((riskCompResult.assessment?.confidence || 0) + (validatorResult.confidence || 0)) / 2,
  }
}

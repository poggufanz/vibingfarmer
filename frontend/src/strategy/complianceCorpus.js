// frontend/src/strategy/complianceCorpus.js
// Curated DeFi risk-policy corpus + retriever. The Council's Risk/Compliance
// agent runs at temperature 0 against THIS corpus: it must cite a rule id or
// abstain — it cannot invent a limit. DeFi yield farming only (no RWA, no OJK,
// no SEC). Some rules map to the cryptographically enforced on-chain scope.
// Pure, deterministic; keyword/tag retrieval (vector backend = future seam).

/** Per-risk-tier CVaR(95) tail floor, in % horizon return. Tail may not fall below. */
export const TIER_CVAR_FLOOR = { conservative: -2, moderate: -5, aggressive: -10 }

export const RULES = [
  {
    id: 'CVAR_TAIL_FLOOR',
    citation: 'DeFi-RP §1',
    metric: 'cvar',
    tags: ['tail', 'drawdown', 'risk'],
    text: 'Basket Expected Shortfall (CVaR 95%) must not fall below the risk-tier tail floor.',
  },
  {
    id: 'MAX_DRAWDOWN',
    citation: 'DeFi-RP §2',
    metric: 'worst',
    tags: ['drawdown', 'tail', 'risk'],
    text: 'Worst-case simulated horizon loss must not exceed the tier drawdown tolerance.',
  },
  {
    id: 'TVL_FLOOR',
    citation: 'DeFi-RP §3',
    metric: 'tvl',
    tags: ['liquidity', 'protocol'],
    text: 'Each vault TVL must be at or above the minimum liquidity floor.',
  },
  {
    id: 'AUDIT_REQUIRED',
    citation: 'DeFi-RP §4',
    metric: 'audit',
    tags: ['protocol', 'security'],
    text: 'Each underlying protocol must have a current security audit.',
  },
  {
    id: 'CONCENTRATION_CAP',
    citation: 'DeFi-RP §5',
    metric: 'concentration',
    tags: ['allocation', 'risk'],
    text: 'No single vault may exceed the per-vault concentration cap.',
  },
  {
    id: 'SCOPE_CAP',
    citation: 'On-chain scope',
    metric: 'scope',
    tags: ['scope', 'onchain', 'hard'],
    text: 'Deposit must stay within the per-agent cap and expiry enforced on-chain.',
  },
]

/** Keyword/tag retrieval. No tags → whole corpus. */
export function retrieveRules({ tags = [] } = {}) {
  if (!tags.length) return RULES
  const set = new Set(tags)
  return RULES.filter((r) => r.tags.some((t) => set.has(t)))
}

/**
 * Tail compliance check. Compares simulated CVaR(95) against the risk-tier floor
 * and returns a CITED verdict — or 'abstain' when no rule applies. This is the
 * Risk/Compliance binding: a verdict is always tied to a rule id, never invented.
 * @param {{cvar95:number, worst?:number}} metrics from riskMetrics()
 * @param {{riskTier?:'conservative'|'moderate'|'aggressive'}} [opts]
 * @returns {{verdict:'pass'|'veto'|'abstain', citedRule:string|null, citation?:string, reason:string, floor?:number}}
 */
export function checkTailCompliance(metrics, { riskTier = 'moderate' } = {}) {
  const floor = TIER_CVAR_FLOOR[riskTier] ?? TIER_CVAR_FLOOR.moderate
  const candidates = retrieveRules({ tags: ['tail'] })
  const rule = candidates.find((r) => r.id === 'CVAR_TAIL_FLOOR')
  if (!rule)
    return { verdict: 'abstain', citedRule: null, reason: 'no applicable tail rule in corpus' }
  if (metrics.cvar95 < floor) {
    return {
      verdict: 'veto',
      citedRule: rule.id,
      citation: rule.citation,
      floor,
      reason: `CVaR ${metrics.cvar95}% breaches ${riskTier} tail floor ${floor}%`,
    }
  }
  return {
    verdict: 'pass',
    citedRule: rule.id,
    citation: rule.citation,
    floor,
    reason: `CVaR ${metrics.cvar95}% within ${riskTier} tail floor ${floor}%`,
  }
}

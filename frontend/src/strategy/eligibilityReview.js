// frontend/src/strategy/eligibilityReview.js
// Presentation adapter for the eligibility gate's outcome (basketFilter.computeBasket).
// Pure and display-shaped: ProtectStage renders these rows verbatim. It never re-evaluates
// eligibility -- the gate already ran fail-closed inside generateStrategyPlan.

export function buildEligibilityReview({ survivors = [], dropped = [] } = {}) {
  const row = (entry, eligible) => ({
    protocol: entry?.vault?.protocol || 'Unknown venue',
    chain: entry?.vault?.chain === 'base' ? 'base' : 'stellar',
    eligible,
    reasons: eligible ? [] : (entry?.verdict?.reasons ?? []).filter((r) => typeof r === 'string'),
  })
  return [...survivors.map((s) => row(s, true)), ...dropped.map((d) => row(d, false))]
}

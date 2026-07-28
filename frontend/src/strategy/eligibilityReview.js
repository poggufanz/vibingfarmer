// frontend/src/strategy/eligibilityReview.js
// Presentation adapter for the eligibility gate's outcome (basketFilter.computeBasket).
// Pure and display-shaped: ProtectStage renders these rows verbatim. It never re-evaluates
// eligibility -- the gate already ran fail-closed inside generateStrategyPlan.

// basketFilter.filterBasket (the function that actually produces `survivors`/`dropped`) shapes
// the two arrays differently -- survivors spread the original agent record directly (`{...agent,
// allocationFraction}`), but a dropped entry is wrapped as `{agent, verdict}`. So the vault lives
// at `entry.vault` for a survivor but at `entry.agent.vault` for a dropped entry; `verdict` is
// top-level on both. Verified against basketFilter.js and basketFilter.test.js (`dropped[0].agent.id`).
export function buildEligibilityReview({ survivors = [], dropped = [] } = {}) {
  const vaultOf = (v) => ({
    protocol: v?.protocol || 'Unknown venue',
    chain: v?.chain === 'base' ? 'base' : 'stellar',
  })
  const eligibleRow = (entry) => ({ ...vaultOf(entry?.vault), eligible: true, reasons: [] })
  const rejectedRow = (entry) => ({
    ...vaultOf(entry?.agent?.vault),
    eligible: false,
    reasons: (entry?.verdict?.reasons ?? []).filter((r) => typeof r === 'string'),
  })
  return [...survivors.map(eligibleRow), ...dropped.map(rejectedRow)]
}

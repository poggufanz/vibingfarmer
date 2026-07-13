// ACE living-playbook seed catalog. Union of the two historical id namespaces:
// the playbookRules.js per-role catalog (yld-/rsk-/mkt-) AND the council.js
// inline cited ids (yield-/risk-/market-). Seeding BOTH means every id the
// deterministic council can cite resolves to a real record in the store, so
// weight()/increment() always hit a record. Seeds are origin:'seed' — protected
// from hard-delete (retire-only), because the deterministic council still cites them.

const CAT = {
  yield: 'strategy',
  risk: 'risk',
  market: 'gas',
  proposer: 'opportunity',
  'risk-compliance': 'compliance',
  validator: 'simulation',
}

export function roleToCategory(role) {
  return CAT[role] || 'strategy'
}

function seed(id, role, text) {
  return { id, role, category: roleToCategory(role), text, origin: 'seed' }
}

export const SEED_RULES = [
  // ── playbookRules.js catalog (shown to the AI wizard council) ──
  seed('yld-apy-attractive', 'yield', 'Blended APY meets the profile target.'),
  seed(
    'yld-projection-positive',
    'yield',
    'Risk-adjusted projected annual yield (USDC) is positive after the risk penalty.'
  ),
  seed(
    'yld-tvl-adequate',
    'yield',
    'Selected vaults meet the TVL and operating-history requirements.'
  ),
  seed('rsk-turbulent-veto', 'risk', 'The market is turbulent. Wait before depositing.'),
  seed(
    'rsk-gates-clear',
    'risk',
    'No action-space gate violations: allocations respect the risk ceiling and sum to 1.0.'
  ),
  seed(
    'rsk-drawdown-bounded',
    'risk',
    '30-day max drawdown of the basket stays within the profile risk tolerance.'
  ),
  seed('rsk-regime-calm', 'risk', "Market conditions meet the profile's risk limits."),
  seed('mkt-gas-affordable', 'market', 'Expected returns exceed entry costs.'),
  seed('mkt-timing-favorable', 'market', 'Market conditions support entry.'),
  seed('mkt-signals-clear', 'market', 'No exploit, depeg, or governance warning was found.'),
  // ── council.js inline cited ids (deterministic monitor-loop council) ──
  seed(
    'yield-uplift',
    'yield',
    'Projected risk-adjusted return is higher than the current position.'
  ),
  seed(
    'yield-harvest-free',
    'yield',
    'Harvesting claims available rewards without adding exposure.'
  ),
  seed(
    'yield-no-uplift',
    'yield',
    'Projected risk-adjusted return does not improve the current position.'
  ),
  seed('risk-turbulent-veto', 'risk', 'The market is turbulent. Reduce exposure or wait.'),
  seed(
    'risk-gate-violation',
    'risk',
    'Allocation violates an action limit. Wait until it is valid.'
  ),
  seed('risk-calm-clear', 'risk', 'Market conditions pass the risk checks.'),
  seed(
    'market-harvest-timing',
    'market',
    'Harvesting has no additional market-timing requirement.'
  ),
  seed('market-gas-positive', 'market', 'Expected returns exceed fees.'),
  seed('market-gas-negative', 'market', 'Fees exceed expected returns. Wait for lower costs.'),
  // ── council-review debate council (proposer / risk-compliance / validator) ──
  seed('prop-yield-opportunity', 'proposer', 'Current yield and market conditions support entry.'),
  seed(
    'prop-risk-adjusted-pos',
    'proposer',
    'Risk-adjusted return projection is positive after accounting for volatility.'
  ),
  seed('prop-timing-favorable', 'proposer', 'Market conditions support deployment.'),
  seed('prop-valuation-attractive', 'proposer', 'Current vault metrics meet the entry thresholds.'),
  seed(
    'comp-risk-limit-check',
    'risk-compliance',
    'Proposed allocation stays within the effective risk ceiling for the profile.'
  ),
  seed(
    'comp-drawdown-bounded',
    'risk-compliance',
    'Portfolio drawdown at VaR remains within the maximum loss tolerance.'
  ),
  seed('comp-investor-protection', 'risk-compliance', 'No vault exceeds the concentration limit.'),
  seed(
    'comp-disclosure-clear',
    'risk-compliance',
    'Fee structure, lock-up terms, and exit conditions are transparent.'
  ),
  seed(
    'comp-capital-preserve',
    'risk-compliance',
    'Capital preservation rule: if VaR exceeds profile max loss, proposal must be rejected.'
  ),
  seed(
    'val-var-threshold',
    'validator',
    'VaR at the specified confidence level is within the risk profile tolerance.'
  ),
  seed(
    'val-cvar-tail-safe',
    'validator',
    'CVaR tail risk does not exceed the profile maximum acceptable loss.'
  ),
  seed(
    'val-sim-consistent',
    'validator',
    'Proposal blended APY is consistent with the Monte Carlo simulation expected value.'
  ),
  seed(
    'val-outcome-reliable',
    'validator',
    'Probability of profit is above the minimum threshold for the risk profile.'
  ),
]

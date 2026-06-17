// ACE living-playbook seed catalog. Union of the two historical id namespaces:
// the playbookRules.js per-role catalog (yld-/rsk-/mkt-) AND the council.js
// inline cited ids (yield-/risk-/market-). Seeding BOTH means every id the
// deterministic council can cite resolves to a real record in the store, so
// weight()/increment() always hit a record. Seeds are origin:'seed' — protected
// from hard-delete (retire-only), because the deterministic council still cites them.

const CAT = { yield: 'strategy', risk: 'risk', market: 'gas' }

export function roleToCategory(role) {
  return CAT[role] || 'strategy'
}

function seed(id, role, text) {
  return { id, role, category: roleToCategory(role), text, origin: 'seed' }
}

export const SEED_RULES = [
  // ── playbookRules.js catalog (shown to the AI wizard council) ──
  seed('yld-apy-attractive', 'yield', 'Blended APY clears the profile target; the headline yield justifies entry.'),
  seed('yld-projection-positive', 'yield', 'Risk-adjusted projected annual yield (USDC) is positive after the risk penalty.'),
  seed('yld-tvl-adequate', 'yield', 'Selected vaults have adequate TVL/track record so the quoted APY is credible.'),
  seed('rsk-turbulent-veto', 'risk', 'Market regime is turbulent — defer entry; capital preservation outranks yield.'),
  seed('rsk-gates-clear', 'risk', 'No action-space gate violations: allocations respect the risk ceiling and sum to 1.0.'),
  seed('rsk-drawdown-bounded', 'risk', '30-day max drawdown of the basket stays within the profile risk tolerance.'),
  seed('rsk-regime-calm', 'risk', 'Regime is calm/elevated with no violations — risk posture supports deploying.'),
  seed('mkt-gas-affordable', 'market', 'Entry gas cost is small relative to expected yield; timing is economically sound.'),
  seed('mkt-timing-favorable', 'market', 'Calm regime and clear signals make now a favorable entry window.'),
  seed('mkt-signals-clear', 'market', 'No adverse live market signals (exploits, depegs, governance alarms) flagged.'),
  // ── council.js inline cited ids (deterministic monitor-loop council) ──
  seed('yield-uplift', 'yield', 'Projected risk-adjusted reward exceeds the current position — deposit on uplift.'),
  seed('yield-harvest-free', 'yield', 'Harvest is a free reward claim — always worth depositing.'),
  seed('yield-no-uplift', 'yield', 'No risk-adjusted uplift over the current position — hold.'),
  seed('risk-turbulent-veto', 'risk', 'Turbulent market regime — withdraw/hold; capital preservation first.'),
  seed('risk-gate-violation', 'risk', 'Action-space gate violation present — withdraw/hold until allocations are valid.'),
  seed('risk-calm-clear', 'risk', 'Calm regime with no violations — risk posture supports depositing.'),
  seed('market-harvest-timing', 'market', 'Harvest timing is always fine — a free claim has no gas-timing risk.'),
  seed('market-gas-positive', 'market', 'Net expected gain after gas is positive — timing is economically sound.'),
  seed('market-gas-negative', 'market', 'Gas exceeds the expected gain — hold until execution is cheaper.'),
]

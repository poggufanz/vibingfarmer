// frontend/src/strategy/autoExit/engine.js
// Decision engine for F11 Auto-Exit. Evaluates rules against live facts.

import { checkUtilization, checkApy, checkProtocolRisk, checkDrawdown } from './triggers.js';
import { validateRules } from './rules.js';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minute execution safety window

/**
 * Evaluate auto-exit rules against live vault facts and state.
 * @param {Object} rules user exit rules
 * @param {Object} state current StrategyState (with market context and universe vault observations)
 * @param {Object} options execution context options
 * @param {number} options.nowMs current timestamp in ms
 * @param {number} [options.lastExitTripAt] optional timestamp of last execution to check cooldown
 * @returns {{ tripped:boolean, reason:string|null, trigger:string|null, facts:Object, cooldown:boolean }}
 */
export function evaluateExit(rules, state, { nowMs = Date.now(), lastExitTripAt = 0 } = {}) {
  const cleanRules = validateRules(rules);

  // 1. Authorization & Expiry Check
  if (!cleanRules.authorized) {
    return { tripped: false, reason: 'Auto-exit not authorized by user', trigger: null, facts: {}, cooldown: false };
  }
  if (cleanRules.expiryAt && nowMs >= cleanRules.expiryAt) {
    return { tripped: false, reason: 'Scoped exit key expired', trigger: 'expiry', facts: { expiryAt: cleanRules.expiryAt }, cooldown: false };
  }

  // 2. Cooldown Guard
  if (lastExitTripAt && nowMs - lastExitTripAt < COOLDOWN_MS) {
    return { tripped: false, reason: 'Exit engine in cooldown', trigger: null, facts: {}, cooldown: true };
  }

  // 3. Evaluate each active position in the portfolio
  const universe = state?.universe || [];
  const holdings = state?.portfolio?.holdings || {};

  // For the demo / Blend single-vault, let's examine the facts for the primary vault.
  // Find the normalized facts in the universe or catalog.
  for (const vaultAddress of Object.keys(holdings)) {
    const vault = universe.find(v => v.address === vaultAddress);
    if (!vault) continue;

    // Wrap vault observation fields into the "facts" shape expected by triggers.
    // In our buildStrategyState, `toObservation` maps fields: tvl, drawdown, apy, protocol.
    // Let's add a utilization property. If not present in observation, try to read from state.market.utilization or use fallback.
    const vaultFacts = {
      apy: { value: vault.apy / 100 }, // triggers expect decimal fraction
      tvl: { value: vault.tvl },
      drawdown: { value: vault.drawdown / 100 },
      utilization: { value: state?.market?.utilization ?? 0.80 }, // populated in getState()
      audit: { value: vault.protocol === 'hyperfarm' ? 'none' : 'timelock_multisig' }
    };

    // T1: Utilization Trigger
    if (cleanRules.utilization.enabled) {
      const res = checkUtilization(vaultFacts, cleanRules.utilization.threshold);
      if (res.tripped) {
        return { tripped: true, reason: res.reason, trigger: 'utilization', facts: res.facts, cooldown: false };
      }
    }

    // T2: APY Collapse Trigger
    if (cleanRules.apyCollapse.enabled) {
      const res = checkApy(vaultFacts, cleanRules.apyCollapse.threshold);
      if (res.tripped) {
        return { tripped: true, reason: res.reason, trigger: 'apyCollapse', facts: res.facts, cooldown: false };
      }
    }

    // T3: Protocol Risk / TVL Drop Trigger
    if (cleanRules.protocolRisk.enabled) {
      const res = checkProtocolRisk(vaultFacts, cleanRules.protocolRisk.tvlDropThreshold, state?.market?.signals?.join(' ') || '');
      if (res.tripped) {
        return { tripped: true, reason: res.reason, trigger: 'protocolRisk', facts: res.facts, cooldown: false };
      }
    }

    // T4: Max Drawdown (Dormant on stablecoins)
    if (cleanRules.drawdown.enabled && !cleanRules.drawdown.dormant) {
      const res = checkDrawdown(vaultFacts, cleanRules.drawdown.threshold);
      if (res.tripped) {
        return { tripped: true, reason: res.reason, trigger: 'drawdown', facts: res.facts, cooldown: false };
      }
    }
  }

  return { tripped: false, reason: null, trigger: null, facts: {}, cooldown: false };
}

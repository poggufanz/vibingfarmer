// frontend/src/strategy/autoExit/triggers.js
// Pure evaluators for F11 Auto-Exit rules: T1 (utilization), T2 (APY collapse), T3 (protocol risk), T4 (drawdown).

/**
 * Check if the pool utilization exceeds the threshold.
 * @param {Object} vaultFacts normalized vault facts
 * @param {number} threshold e.g. 0.95 for 95%
 */
export function checkUtilization(vaultFacts, threshold) {
  const util = vaultFacts.utilization?.value ?? 0.80; // default to 80% if not set
  if (util >= threshold) {
    return {
      tripped: true,
      reason: `Pool utilization is ${(util * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`,
      facts: { utilization: util }
    };
  }
  return { tripped: false, facts: { utilization: util } };
}

/**
 * Check if the APY drops below the threshold.
 * @param {Object} vaultFacts normalized vault facts
 * @param {number} threshold e.g. 0.01 for 1%
 */
export function checkApy(vaultFacts, threshold) {
  const apy = vaultFacts.apy?.value ?? 0.05; // default to 5% if not set
  if (apy < threshold) {
    return {
      tripped: true,
      reason: `APY collapsed to ${(apy * 100).toFixed(2)}% (threshold: ${(threshold * 100).toFixed(2)}%)`,
      facts: { apy }
    };
  }
  return { tripped: false, facts: { apy } };
}

/**
 * Check if TVL drops too much or exploit indicators exist.
 * @param {Object} vaultFacts normalized vault facts
 * @param {number} tvlDropThreshold e.g. 0.40 for 40%
 * @param {string|null} marketContext live market context
 */
export function checkProtocolRisk(vaultFacts, tvlDropThreshold, marketContext) {
  const tvl = vaultFacts.tvl?.value ?? 25_000_000;
  const baselineTvl = 25_000_000; // standard baseline for the demo
  const tvlDrop = (baselineTvl - tvl) / baselineTvl;

  if (tvlDrop >= tvlDropThreshold) {
    return {
      tripped: true,
      reason: `Protocol TVL dropped by ${(tvlDrop * 100).toFixed(1)}% (threshold: ${(tvlDropThreshold * 100).toFixed(1)}%)`,
      facts: { tvl, tvlDrop }
    };
  }

  const audit = vaultFacts.audit?.value || 'timelock_multisig';
  if (audit === 'none') {
    return {
      tripped: true,
      reason: `Protocol audit status is 'none' (exploit indicator)`,
      facts: { audit }
    };
  }

  const text = String(marketContext || '').toLowerCase();
  const exploitKeywords = ['exploit', 'hack', 'compromise', 'drain'];
  const foundKeyword = exploitKeywords.find(kw => text.includes(kw));
  if (foundKeyword) {
    return {
      tripped: true,
      reason: `Exploit keyword '${foundKeyword}' found in market context`,
      facts: { foundKeyword, marketContext }
    };
  }

  return { tripped: false, facts: { tvl, audit } };
}

/**
 * Check if the drawdown exceeds the threshold (T4 - dormant).
 * @param {Object} vaultFacts normalized vault facts
 * @param {number} threshold e.g. 0.05 for 5%
 */
export function checkDrawdown(vaultFacts, threshold) {
  const drawdown = vaultFacts.drawdown?.value ?? 0.0;
  if (drawdown >= threshold) {
    return {
      tripped: true,
      reason: `Drawdown is ${(drawdown * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`,
      facts: { drawdown }
    };
  }
  return { tripped: false, facts: { drawdown } };
}

// frontend/src/strategy/autoExit/rules.js
// User rule schema and validation for F11 Auto-Exit.

export const DEFAULT_EXIT_RULES = {
  utilization: { enabled: false, threshold: 0.95 },
  apyCollapse: { enabled: false, threshold: 0.01 },
  protocolRisk: { enabled: false, tvlDropThreshold: 0.40 },
  drawdown: { enabled: false, threshold: 0.05, dormant: true }, // T4 dormant for stablecoins
  expiryDays: 30, // Default TTL of 30 days
  authorized: false,
  authorizedAt: null,
  expiryAt: null
};

/**
 * Validate a set of exit rules and return clean, typed rules or throw an error.
 * @param {Object} rules exit rules object
 * @returns {Object} sanitized rules
 */
export function validateRules(rules) {
  const clean = { ...DEFAULT_EXIT_RULES, ...rules };

  // Utilization bounds: 0 to 1.0 (0% to 100%)
  if (typeof clean.utilization.threshold !== 'number' || clean.utilization.threshold < 0 || clean.utilization.threshold > 1.0) {
    clean.utilization.threshold = 0.95;
  }

  // APY collapse bounds: 0 to 1.0
  if (typeof clean.apyCollapse.threshold !== 'number' || clean.apyCollapse.threshold < 0 || clean.apyCollapse.threshold > 1.0) {
    clean.apyCollapse.threshold = 0.01;
  }

  // TVL drop bounds: 0 to 1.0
  if (typeof clean.protocolRisk.tvlDropThreshold !== 'number' || clean.protocolRisk.tvlDropThreshold < 0 || clean.protocolRisk.tvlDropThreshold > 1.0) {
    clean.protocolRisk.tvlDropThreshold = 0.40;
  }

  // Drawdown bounds: 0 to 1.0
  if (typeof clean.drawdown.threshold !== 'number' || clean.drawdown.threshold < 0 || clean.drawdown.threshold > 1.0) {
    clean.drawdown.threshold = 0.05;
  }

  return clean;
}

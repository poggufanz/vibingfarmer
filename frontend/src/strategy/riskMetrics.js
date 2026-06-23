// frontend/src/strategy/riskMetrics.js
// Value-at-Risk + Conditional VaR (Expected Shortfall) from a Monte Carlo sample.
// Historical/MC method: sort outcomes, read the (1-alpha) quantile (VaR), average
// everything at or beyond it (CVaR). Signed convention — outcomes are signed
// returns, so a positive var95/cvar95 means even the tail is a gain, negative
// means the tail is a real loss. Loss-magnitude framing = negate (asLoss).
// Definition: VaR_alpha = (1-alpha) quantile of returns; CVaR_alpha =
// E[return | return <= VaR_alpha]. Textbook ES — no invented formula.
// Pure, dependency-free, deterministic for a given sample.

const round = (x) => +Number(x).toFixed(4)

/**
 * @param {number[]} outcomes sample of signed outcome returns (e.g. % over horizon)
 * @param {number} [alpha] confidence (0.95 → 95% VaR/CVaR, 5% tail)
 * @returns {{alpha:number, var95:number, cvar95:number, worst:number, best:number, mean:number, n:number, tailCount:number}}
 */
export function riskMetrics(outcomes, alpha = 0.95) {
  const n = outcomes?.length || 0
  if (!n) return { alpha, var95: 0, cvar95: 0, worst: 0, best: 0, mean: 0, n: 0, tailCount: 0 }
  const sorted = [...outcomes].sort((a, b) => a - b)
  const tailProb = 1 - alpha
  // nearest-rank index of the VaR quantile — the tail boundary
  const idx = Math.max(0, Math.min(n - 1, Math.floor(tailProb * (n - 1))))
  const varQ = sorted[idx]
  // CVaR = mean of every outcome at or below the VaR boundary (the worst tail)
  const tailCount = Math.max(1, idx + 1)
  let tailSum = 0
  for (let i = 0; i < tailCount; i++) tailSum += sorted[i]
  const cvar = tailSum / tailCount
  const mean = sorted.reduce((s, x) => s + x, 0) / n
  return {
    alpha,
    var95: round(varQ),
    cvar95: round(cvar),
    worst: round(sorted[0]),
    best: round(sorted[n - 1]),
    mean: round(mean),
    n,
    tailCount,
  }
}

/** Loss-magnitude framing: positive number = expected loss. */
export const asLoss = (x) => +(-x).toFixed(4)

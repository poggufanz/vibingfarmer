// Honesty-compliant display strings for the eligibility verdict (Slice 1 = display only).
// Rules (spec §6/§12): never bare "yield is real"; mainnet yield label always co-emits the testnet
// caveat; score carries "our weighting"; always "target", never "guaranteed".

function ratioPhrase(verdict) {
  const r = verdict.yieldReality?.ratio
  return r == null
    ? 'Mainnet revenue coverage is unavailable'
    : `Mainnet reward distributions are covered by protocol revenue (ratio: ${r.toFixed(1)})`
}

/** The fused one-sentence approval line — the headline artifact. */
export function buildEligibilitySentence(verdict, ctx) {
  const yield_ = ratioPhrase(verdict)
  const sec = `Security score: ${verdict.security?.score}/100 using our weighting`
  const loss = `Target maximum loss: ${ctx.targetMaxLossPct}%`
  return `${yield_}, according to DeFiLlama. This deposit runs on testnet, so the APR is illustrative. ${sec}. ${loss}. Proceed?`
}

/** Per-row label in the eligibility panel. */
export function vaultEligibilityLabel(verdict) {
  if (!verdict.eligible) return `Rejected: ${verdict.reasons.join('; ')}`
  return `${ratioPhrase(verdict)}`
}

// Honesty-compliant display strings for the eligibility verdict (Slice 1 = display only).
// Rules (spec §6/§12): never bare "yield is real"; mainnet yield label always co-emits the testnet
// caveat; score carries "our weighting"; always "target", never "guaranteed".

function ratioPhrase(verdict) {
  const r = verdict.yieldReality?.ratio
  return `Mainnet distributions revenue-covered (ratio ${r != null ? r.toFixed(1) : '—'})`
}

/** The fused one-sentence approval line — the headline artifact. */
export function buildEligibilitySentence(verdict, ctx) {
  const yield_ = ratioPhrase(verdict)
  const sec = `Security ${verdict.security?.score}/100 (our weighting)`
  const loss = `Target max loss −${ctx.targetMaxLossPct}%`
  return `${yield_}, source DeFiLlama. This deposit is on testnet — APR illustrative. ${sec}. ${loss}. Proceed?`
}

/** Per-row label in the eligibility panel. */
export function vaultEligibilityLabel(verdict) {
  if (!verdict.eligible) return `Rejected: ${verdict.reasons.join('; ')}`
  return `${ratioPhrase(verdict)}`
}

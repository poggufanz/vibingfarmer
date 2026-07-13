// Enforcement A core (pure). Drops ineligible protocols, re-normalizes survivor allocations to
// sum 1, and reports all-fail so the caller can hard-stop before dispatch.
import { resolve } from './vaultFacts.js'
import { evaluate } from './eligibilityGate.js'

export function filterBasket(agents, verdictBySlug) {
  const survivorsRaw = []
  const dropped = []
  for (const a of agents) {
    const verdict = verdictBySlug[a.vault.protocol]
    if (verdict && verdict.eligible) survivorsRaw.push(a)
    else
      dropped.push({
        agent: a,
        verdict: verdict || { eligible: false, reasons: ['No eligibility decision is available.'] },
      })
  }
  const total = survivorsRaw.reduce((acc, a) => acc + a.allocation, 0)
  const survivors = survivorsRaw.map((a) => ({
    ...a,
    allocationFraction: total > 0 ? a.allocation / total : 0,
  }))
  return { survivors, dropped, allFailed: survivors.length === 0 }
}

/** Resolve facts + evaluate each agent's protocol (throw => reject), then filter. The Enforcement A entry. */
export function computeBasket(agents, nowMs = Date.now()) {
  const verdictBySlug = {}
  for (const a of agents) {
    const slug = a.vault.protocol
    try {
      verdictBySlug[slug] = evaluate(resolve(slug), nowMs)
    } catch (err) {
      verdictBySlug[slug] = {
        protocol: slug,
        eligible: false,
        reasons: [`Eligibility data is unavailable: ${err.message}`],
        isFixture: false,
      }
    }
  }
  const { survivors, dropped, allFailed } = filterBasket(agents, verdictBySlug)
  return { verdictBySlug, survivors, dropped, allFailed }
}

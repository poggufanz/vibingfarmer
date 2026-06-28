// Enforcement A core (pure). Drops ineligible protocols, re-normalizes survivor allocations to
// sum 1, and reports all-fail so the caller can hard-stop before dispatch.
export function filterBasket(agents, verdictBySlug) {
  const survivorsRaw = []
  const dropped = []
  for (const a of agents) {
    const verdict = verdictBySlug[a.vault.protocol]
    if (verdict && verdict.eligible) survivorsRaw.push(a)
    else dropped.push({ agent: a, verdict: verdict || { eligible: false, reasons: ['no verdict'] } })
  }
  const total = survivorsRaw.reduce((acc, a) => acc + a.allocation, 0)
  const survivors = survivorsRaw.map((a) => ({
    ...a,
    allocationFraction: total > 0 ? a.allocation / total : 0,
  }))
  return { survivors, dropped, allFailed: survivors.length === 0 }
}

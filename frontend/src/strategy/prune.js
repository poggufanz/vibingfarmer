// frontend/src/strategy/prune.js
// ACE grow-and-refine — the prune half. Pure: takes rules, returns a new array.
// A rule underperforms when, past a minimum number of evaluations, harmful counts
// dominate helpful ones. Grown rules are hard-deleted (only the AI path cites
// them). Seed rules are RETIRED instead of deleted — the deterministic council
// still cites them, so we floor their weight rather than break a citation. A
// retired rule that recovers (helpful >= harmful) is reactivated.

export const PRUNE_CFG = { MIN_EVALS: 5, HARM_RATIO: 2 }

function underperforms(r, cfg) {
  return r.evals >= cfg.MIN_EVALS && r.harmful >= r.helpful * cfg.HARM_RATIO
}

export function prunePass(rules, cfg = PRUNE_CFG) {
  const out = []
  for (const r of rules) {
    if (underperforms(r, cfg)) {
      if (r.origin === 'grown') continue            // hard delete
      out.push({ ...r, status: 'retired' })         // seed → retire
    } else if (r.status === 'retired' && r.helpful >= r.harmful) {
      out.push({ ...r, status: 'active' })           // recovered → reactivate
    } else {
      out.push(r)
    }
  }
  return out
}

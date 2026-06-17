// frontend/src/strategy/merge.js
// ACE bulletpoint analyzer — lexical variant. Pure: takes rules, returns a new
// array with near-duplicate rules merged. Similarity is char-trigram cosine on
// the text, computed WITHIN A ROLE ONLY (cross-role merge would corrupt the
// council partition). A cluster collapses to the OLDEST id (lowest createdAt,
// usually a seed), with distinct text concatenated and helpful/harmful/evals
// SUMMED. A seed+grown collision keeps the seed origin so the council's cited id
// survives. No embeddings, no network — demo-safe and deterministic.

export const MERGE_CFG = { THRESHOLD: 0.8 }

function trigrams(text) {
  const s = `  ${String(text).toLowerCase().replace(/\s+/g, ' ').trim()}  `
  const m = new Map()
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

export function trigramCosine(a, b) {
  const ta = trigrams(a)
  const tb = trigrams(b)
  let dot = 0
  for (const [g, x] of ta) if (tb.has(g)) dot += x * tb.get(g)
  const mag = (m) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const denom = mag(ta) * mag(tb)
  return denom === 0 ? 0 : dot / denom
}

function combine(cluster) {
  const ordered = [...cluster].sort((x, y) => x.createdAt - y.createdAt)
  const base = ordered[0]
  const seed = ordered.find((r) => r.origin === 'seed')
  const texts = [...new Set(ordered.map((r) => r.text))]
  const sum = (k) => ordered.reduce((s, r) => s + (r[k] || 0), 0)
  return {
    ...base,
    id: (seed || base).id,
    origin: seed ? 'seed' : base.origin,
    text: texts.join(' '),
    helpful: sum('helpful'),
    harmful: sum('harmful'),
    evals: sum('helpful') + sum('harmful'),
  }
}

export function mergePass(rules, cfg = MERGE_CFG) {
  const byRole = {}
  for (const r of rules) (byRole[r.role] ||= []).push(r)

  const out = []
  for (const role of Object.keys(byRole)) {
    const items = byRole[role]
    const used = new Array(items.length).fill(false)
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue
      const cluster = [items[i]]
      used[i] = true
      for (let j = i + 1; j < items.length; j++) {
        if (used[j]) continue
        if (trigramCosine(items[i].text, items[j].text) >= cfg.THRESHOLD) {
          cluster.push(items[j])
          used[j] = true
        }
      }
      out.push(cluster.length === 1 ? cluster[0] : combine(cluster))
    }
  }
  return out
}

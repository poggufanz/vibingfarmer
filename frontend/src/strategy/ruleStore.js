// ACE living playbook — single source of truth. Each rule is one record holding
// its text AND its helpful/harmful evidence. Seeds (origin:'seed') are protected:
// the deterministic council still cites them, so they can only be RETIRED
// (weight-floored), never deleted. Grown rules (origin:'grown') are AI-added and
// fully deletable. Pure localStorage I/O; never throws across a public boundary.
import { SEED_RULES, roleToCategory } from './seeds.js'

const KEY = 'yv_playbook_v2'
const LEGACY_KEY = 'yv_playbook'
const W_MIN = 0.5
const W_MAX = 1.5

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (v && typeof v === 'object' && Array.isArray(v.rules)) return v
  } catch { /* fall through */ }
  return { rules: [], legacyFolded: false }
}

function write(doc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc))
  } catch (err) {
    console.warn('[RuleStore] write failed:', err.message)
  }
}

function newRecord(partial) {
  const role = partial.role || 'yield'
  return {
    id: partial.id,
    role,
    category: partial.category || roleToCategory(role),
    text: partial.text || '',
    helpful: partial.helpful || 0,
    harmful: partial.harmful || 0,
    evals: (partial.helpful || 0) + (partial.harmful || 0),
    status: partial.status || 'active',
    origin: partial.origin || 'grown',
    createdAt: partial.createdAt || Date.now(),
  }
}

/** Read rules, optionally filtered. */
export function getRules({ role, status } = {}) {
  let rules = read().rules
  if (role) rules = rules.filter((r) => r.role === role)
  if (status) rules = rules.filter((r) => r.status === status)
  return rules
}

/** Append a rule. Ignores a duplicate id. Never throws. */
export function addRule(partial) {
  try {
    if (!partial || !partial.id) return
    const doc = read()
    if (doc.rules.some((r) => r.id === partial.id)) return
    doc.rules = [...doc.rules, newRecord(partial)]
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] addRule failed:', err.message)
  }
}

/** Idempotent seed install. Adds any missing SEED_RULES; folds legacy counters once. */
export function upsertSeeds(seeds = SEED_RULES) {
  try {
    const doc = read()
    const have = new Set(doc.rules.map((r) => r.id))
    for (const s of seeds) {
      if (!have.has(s.id)) doc.rules.push(newRecord({ ...s, status: 'active', helpful: 0, harmful: 0 }))
    }
    if (!doc.legacyFolded) foldLegacy(doc)
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] upsertSeeds failed:', err.message)
  }
}

/** One-time fold of the old {id:{helpful,harmful}} counter map into matching records. */
function foldLegacy(doc) {
  doc.legacyFolded = true
  let legacy
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}') } catch { return }
  if (!legacy || typeof legacy !== 'object') return
  for (const r of doc.rules) {
    const c = legacy[r.id]
    if (c) {
      r.helpful += c.helpful || 0
      r.harmful += c.harmful || 0
      r.evals = r.helpful + r.harmful
    }
  }
}

export function retireRule(id) {
  const doc = read()
  const r = doc.rules.find((x) => x.id === id)
  if (r) { r.status = 'retired'; write(doc) }
}

export function deleteRule(id) {
  const doc = read()
  const next = doc.rules.filter((r) => r.id !== id)
  if (next.length !== doc.rules.length) { doc.rules = next; write(doc) }
}

export function replaceAll(rules) {
  const doc = read()
  doc.rules = Array.isArray(rules) ? rules : []
  write(doc)
}

export function clearPlaybook() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

/** Bump a rule's counter. kind = 'helpful' | 'harmful'. Bumps evals. Never throws. */
export function increment(id, kind) {
  if (!id || (kind !== 'helpful' && kind !== 'harmful')) return
  try {
    const doc = read()
    const r = doc.rules.find((x) => x.id === id)
    if (!r) return
    r[kind] = (r[kind] || 0) + 1
    r.evals = (r.helpful || 0) + (r.harmful || 0)
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] increment failed:', err.message)
  }
}

/**
 * Confidence multiplier in [0.5, 1.5] from the helpful/harmful ratio (Laplace-smoothed).
 * Unknown id → 1.0 (neutral, council always safe). Retired → 0.5 (de-emphasized).
 */
export function weight(id) {
  const r = read().rules.find((x) => x.id === id)
  if (!r) return 1.0
  if (r.status === 'retired') return W_MIN
  const h = r.helpful || 0
  const x = r.harmful || 0
  if (h + x === 0) return 1.0
  const ratio = (h + 1) / (h + x + 2)
  return +(W_MIN + (W_MAX - W_MIN) * ratio).toFixed(3)
}

/** Back-compat counter shape: { id: { helpful, harmful } }. */
export function getCounters() {
  const out = {}
  for (const r of read().rules) out[r.id] = { helpful: r.helpful || 0, harmful: r.harmful || 0 }
  return out
}

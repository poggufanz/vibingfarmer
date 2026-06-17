// frontend/src/strategy/decisionLog.js
// Decision log for the autonomous monitor loop — adapts EvoDS Step 7 ACC at the
// sub-agent level. Each council specialist's verdict is compressed to a single
// deterministic summary line (no per-cycle AI), and the full per-specialist set
// plus the council's authoritative decision is persisted for post-mortem and
// future calibration. Mirrors cycleJournal.js: pure localStorage, append-only,
// capped, never throws. Distinct from cycleJournal (operational trail) — this
// store only records cycles where the council actually deliberated.

const POSITIVE = { DEPOSIT: 'clear to proceed', HOLD: 'hold', WITHDRAW: 'exit' }

/** Compress one specialist verdict to a single human-readable line. Pure. */
export function accSummary({ signal, citedRules = [], concerns = [] } = {}) {
  const reason = concerns[0] ?? POSITIVE[signal] ?? ''
  const rules = citedRules.length ? ` (${citedRules.join(', ')})` : ''
  return `${signal} — ${reason}${rules}`
}

/** Most frequent signal among the specialists + how many voted it. */
function majority(specialists) {
  const counts = {}
  for (const s of specialists) counts[s.signal] = (counts[s.signal] || 0) + 1
  let signal = null, count = 0
  for (const [sig, n] of Object.entries(counts)) if (n > count) { signal = sig; count = n }
  return { signal, count }
}

/** Map a council result + cycle context into an EvoDS-schema decision record. Pure. */
export function buildDecisionRecord({ cycle, idea, state, verdict }) {
  const specialists = verdict?.specialists || []
  const { signal: majoritySignal, count: majorityCount } = majority(specialists)
  const majBucket = specialists.filter((s) => s.signal === majoritySignal)
  const avgConfidence = majBucket.length
    ? +(majBucket.reduce((a, s) => a + s.confidence, 0) / majBucket.length).toFixed(3)
    : 0
  const ts = Date.now()
  return {
    id: `c${cycle}-${ts}`,
    ts,
    cycle,
    action: {
      kind: idea?.kind || 'unknown',
      vault: idea?.vaultName ?? idea?.fromVault ?? null,
      apyGain: idea?.apyGain ?? null,
    },
    turbulence: state?.market?.turbulence || 'unknown',
    verdicts: specialists.map((s) => ({
      role: s.role,
      signal: s.signal,
      confidence: s.confidence,
      summary: accSummary(s),
    })),
    majoritySignal,
    majorityCount,
    avgConfidence,
    finalDecision: verdict?.verdict ?? null,
    resolvedBy: verdict?.resolvedBy ?? null,
    reason: verdict?.reason ?? null,
    citedRules: verdict?.citedRules || [],
  }
}

const KEY = 'yv_decision_log'
const MAX_ROWS = 100
const ROLES = ['yield', 'risk', 'market']

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(rows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
  } catch (err) {
    console.warn('[DecisionLog] write failed:', err.message)
  }
}

/** Build + persist a decision record. Never throws. */
export function recordDecision(ctx) {
  try {
    const rows = read()
    rows.push(buildDecisionRecord(ctx))
    write(rows)
  } catch (err) {
    console.warn('[DecisionLog] recordDecision failed:', err.message)
  }
}

/** @returns newest-first array of decision records. */
export function getDecisions() {
  return read().reverse()
}

export function clearDecisions() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

/** Per-agent signal tallies + total — seed for future calibration. */
export function getDecisionSummary() {
  const rows = read()
  const byAgent = {}
  for (const role of ROLES) byAgent[role] = { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 }
  for (const row of rows) {
    for (const v of row.verdicts || []) {
      if (byAgent[v.role] && v.signal in byAgent[v.role]) byAgent[v.role][v.signal] += 1
    }
  }
  return { total: rows.length, byAgent }
}

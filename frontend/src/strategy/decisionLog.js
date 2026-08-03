// frontend/src/strategy/decisionLog.js
// Decision log for the autonomous monitor loop — adapts EvoDS Step 7 ACC at the
// sub-agent level. Each council specialist's verdict is compressed to a single
// deterministic summary line (no per-cycle AI), and the full per-specialist set
// plus the council's authoritative decision is persisted for post-mortem and
// future calibration. Mirrors cycleJournal.js: pure localStorage, append-only,
// capped, never throws. Distinct from cycleJournal (operational trail) — this
// store only records cycles where the council actually deliberated.

const POSITIVE = { DEPOSIT: 'Clear to proceed', HOLD: 'Hold', WITHDRAW: 'Exit' }

/** Compress one specialist verdict to a single human-readable line. Pure. */
export function accSummary({ signal, citedRules = [], concerns = [] } = {}) {
  const reason = String(concerns[0] ?? POSITIVE[signal] ?? '').replace(/[A-Za-z]/, (c) =>
    c.toUpperCase()
  )
  const rules = citedRules.length ? ` (${citedRules.join(', ')})` : ''
  return `${signal}: ${reason}${rules}`
}

/** Most frequent signal among the specialists + how many voted it. */
function majority(specialists) {
  const counts = {}
  for (const s of specialists) counts[s.signal] = (counts[s.signal] || 0) + 1
  let signal = null,
    count = 0
  for (const [sig, n] of Object.entries(counts))
    if (n > count) {
      signal = sig
      count = n
    }
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

// Pocket Crew "My money" Task 8: versioned around network + owner, mirroring cycleJournal.js's
// own scoped forms exactly (see that file's header for the full rationale: the legacy
// single-argument API is preserved byte-for-byte as a hidden, unowned bucket; a new owner+network
// bucket is created only on the explicit scoped call, and a write with no owner is dropped rather
// than guessed).
const LEGACY_KEY = 'yv_decision_log'
const MAX_ROWS = 100
const ROLES = ['yield', 'risk', 'market']

// Fix 6 (minor, review loop 1): a missing network drops the write (null key), matching
// riskWatchStore.js's own policy — never invent a shared 'unknown' bucket that merges every
// network-less write for one owner (Stellar G-addresses are identical across testnet and mainnet).
function scopedKey(network, owner) {
  if (!network || !owner) return null
  return `yv_decision_log:${network}:${owner}`
}

function read(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(key, rows) {
  try {
    localStorage.setItem(key, JSON.stringify(rows.slice(-MAX_ROWS)))
  } catch (err) {
    console.warn('[DecisionLog] write failed:', err.message)
  }
}

/**
 * Build + persist a decision record. Never throws.
 * - Legacy form `recordDecision(ctx)`: no owner/network context — writes the hidden, unowned
 *   bucket (unchanged behavior for existing callers).
 * - Scoped form `recordDecision(owner, ctx, { network })`: dropped silently when `owner` is
 *   falsy — never guesses whose decision log a write belongs to.
 */
export function recordDecision(ownerOrCtx, ctx, { network } = {}) {
  // Fix 4 (minor, review loop 2): arguments.length, not `ctx === undefined` — the old check could
  // not tell a true legacy call (`recordDecision(ctx)`, 1 argument) from a scoped call whose ctx
  // just hasn't loaded yet (`recordDecision(owner, undefined, { network })`, 3 arguments); the
  // latter used to fall through into this branch and write a bogus record — built from
  // destructuring the OWNER STRING — into the unowned legacy bucket. Mirrors cycleJournal.js's
  // own arity fix.
  if (arguments.length <= 1) {
    try {
      const rows = read(LEGACY_KEY)
      rows.push(buildDecisionRecord(ownerOrCtx))
      write(LEGACY_KEY, rows)
    } catch (err) {
      console.warn('[DecisionLog] recordDecision failed:', err.message)
    }
    return
  }
  if (!ownerOrCtx) return
  const key = scopedKey(network, ownerOrCtx)
  if (!key) return // no network — dropped, never guessed (see scopedKey)
  // Fix 3 (minor, review loop 2): restored. Review loop 1 removed this guard on the premise that
  // read()/write() already swallow everything themselves — a premise that held for
  // cycleJournal.js's and riskWatchStore.js's plain `{...row}` spreads (`{...undefined}` cannot
  // throw) but not here: buildDecisionRecord(ctx) destructures its parameter (see :36 above) and
  // throws on a null/undefined ctx.
  try {
    const rows = read(key)
    rows.push(buildDecisionRecord(ctx))
    write(key, rows)
  } catch (err) {
    console.warn('[DecisionLog] recordDecision failed:', err.message)
  }
}

/**
 * @returns newest-first array of decision records.
 * - Legacy form `getDecisions()`: reads the hidden legacy bucket (true zero-arg call only — an
 *   explicit `getDecisions(undefined, {network})` from a not-yet-loaded owner is NOT the legacy
 *   call and must not read the unowned bucket; Fix 6, review loop 1).
 * - Scoped form `getDecisions(owner, { network })`: reads only that owner+network's bucket; `[]`
 *   when `owner` or `network` is falsy.
 */
export function getDecisions(owner, { network } = {}) {
  if (arguments.length === 0) return read(LEGACY_KEY).reverse()
  if (!owner) return []
  const key = scopedKey(network, owner)
  if (!key) return []
  return read(key).reverse()
}

/**
 * - Legacy form `clearDecisions()`: clears the hidden legacy bucket (true zero-arg call only; see
 *   getDecisions' own note — Fix 6, review loop 1).
 * - Scoped form `clearDecisions(owner, { network })`: clears only that owner+network's bucket.
 */
export function clearDecisions(owner, { network } = {}) {
  try {
    if (arguments.length === 0) {
      localStorage.removeItem(LEGACY_KEY)
      return
    }
    if (!owner) return
    const key = scopedKey(network, owner)
    if (!key) return
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Per-agent signal tallies + total — seed for future calibration. Legacy/global summary only
 *  (dev console panel) — reads the hidden legacy bucket, same as before Task 8. */
export function getDecisionSummary() {
  const rows = read(LEGACY_KEY)
  const byAgent = {}
  for (const role of ROLES) byAgent[role] = { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 }
  for (const row of rows) {
    for (const v of row.verdicts || []) {
      if (byAgent[v.role] && v.signal in byAgent[v.role]) byAgent[v.role][v.signal] += 1
    }
  }
  return { total: rows.length, byAgent }
}

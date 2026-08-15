// frontend/src/strategy/cycleJournal.js
// Autonomous monitor-loop journal — the results.tsv analog from autoresearch.
// Every cycle (keep / discard / crash / idle) is appended so the NEVER-STOP loop
// keeps a complete, auditable trail without flooding UI or context.
// Pure localStorage I/O — no React, no network. Append-only, capped.
//
// Pocket Crew "My money" Task 8: versioned around network + owner so one wallet's cycle history
// is never shown to (or muddied by) another's. The ORIGINAL unversioned key/single-argument API
// is preserved byte-for-byte as a hidden legacy bucket — existing callers (app.jsx's
// `saveCycle(row)` / `getCycles()` dev-panel usage) keep working exactly as before, but that
// bucket is never auto-assigned to whichever wallet happens to connect first (ambiguity
// resolution: unowned data stays unowned — see the brief's "never assign a legacy global journal
// to the first wallet that connects"). New callers pass `owner` (+ `{ network }`) to get a bucket
// scoped to that wallet+network, readable only by that same pair again.

const LEGACY_KEY = 'yv_cycle_journal'
const MAX_ROWS = 100

// Fix 6 (minor, review loop 1): a missing network drops the write (null key), matching
// riskWatchStore.js's own policy — never invent a shared 'unknown' bucket that merges every
// network-less write for one owner (Stellar G-addresses are identical across testnet and mainnet).
function scopedKey(network, owner) {
  if (!network || !owner) return null
  return `yv_cycle_journal:${network}:${owner}`
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
    console.warn('[CycleJournal] write failed:', err.message)
  }
}

/**
 * Append one cycle record. Never throws.
 * - Legacy form `saveCycle(row)`: no owner/network context — writes the hidden, unowned bucket
 *   (unchanged behavior for existing callers).
 * - Scoped form `saveCycle(owner, row, { network })`: dropped silently when `owner` is falsy —
 *   never guesses whose journal a write belongs to.
 */
export function saveCycle(ownerOrRow, row, { network } = {}) {
  // Fix 4 (minor, review loop 2): arguments.length, not `row === undefined` — the old check could
  // not tell a true legacy call (`saveCycle(row)`, 1 argument) from a scoped call whose row just
  // hasn't loaded yet (`saveCycle(owner, undefined, { network })`, 3 arguments); the latter used
  // to fall through into this branch and write a string-spread record (`{...'GOWNER'}` ->
  // `{0:'G',1:'O',...}`) into the unowned legacy bucket. Mirrors getCycles' own arity fix.
  if (arguments.length <= 1) {
    try {
      const rows = read(LEGACY_KEY)
      rows.push({ ...ownerOrRow, ts: Date.now() })
      write(LEGACY_KEY, rows)
    } catch (err) {
      console.warn('[CycleJournal] saveCycle failed:', err.message)
    }
    return
  }
  if (!ownerOrRow) return
  // Dead catch removed (Fix 6, review loop 1): read()/write() already swallow everything
  // themselves — this wrapper could never actually catch anything.
  const key = scopedKey(network, ownerOrRow)
  if (!key) return // no network — dropped, never guessed (see scopedKey)
  const rows = read(key)
  rows.push({ ...row, ts: Date.now() })
  write(key, rows)
}

/**
 * @returns newest-first array of cycle records.
 * - Legacy form `getCycles()`: reads the hidden legacy bucket (true zero-arg call only — an
 *   explicit `getCycles(undefined, {network})` from a not-yet-loaded owner is NOT the legacy call
 *   and must not read the unowned bucket; Fix 6, review loop 1).
 * - Scoped form `getCycles(owner, { network })`: reads only that owner+network's bucket; `[]`
 *   when `owner` or `network` is falsy — never another wallet's data or the shared legacy bucket.
 */
export function getCycles(owner, { network } = {}) {
  if (arguments.length === 0) return read(LEGACY_KEY).reverse()
  if (!owner) return []
  const key = scopedKey(network, owner)
  if (!key) return []
  return read(key).reverse()
}

/**
 * - Legacy form `clearCycles()`: clears the hidden legacy bucket (true zero-arg call only; see
 *   getCycles' own note — Fix 6, review loop 1).
 * - Scoped form `clearCycles(owner, { network })`: clears only that owner+network's bucket.
 */
export function clearCycles(owner, { network } = {}) {
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

/** Aggregate verdict counts + last cycle number. Legacy/global summary only (dev console panel) —
 *  reads the hidden legacy bucket, same as before Task 8. */
export function getJournalSummary() {
  const rows = read(LEGACY_KEY)
  const count = (v) => rows.filter((r) => r.verdict === v).length
  return {
    total: rows.length,
    keep: count('keep'),
    discard: count('discard'),
    gated: count('gated'),
    crash: count('crash'),
    idle: count('idle'),
    lastCycle: rows.length ? rows[rows.length - 1].cycle : 0,
  }
}

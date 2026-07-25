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

function scopedKey(network, owner) {
  return `yv_cycle_journal:${network || 'unknown'}:${owner}`
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
  if (row === undefined) {
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
  try {
    const key = scopedKey(network, ownerOrRow)
    const rows = read(key)
    rows.push({ ...row, ts: Date.now() })
    write(key, rows)
  } catch (err) {
    console.warn('[CycleJournal] saveCycle failed:', err.message)
  }
}

/**
 * @returns newest-first array of cycle records.
 * - Legacy form `getCycles()`: reads the hidden legacy bucket.
 * - Scoped form `getCycles(owner, { network })`: reads only that owner+network's bucket; `[]`
 *   when `owner` is falsy — never another wallet's data or the shared legacy bucket.
 */
export function getCycles(owner, { network } = {}) {
  if (owner === undefined) return read(LEGACY_KEY).reverse()
  if (!owner) return []
  return read(scopedKey(network, owner)).reverse()
}

/**
 * - Legacy form `clearCycles()`: clears the hidden legacy bucket.
 * - Scoped form `clearCycles(owner, { network })`: clears only that owner+network's bucket.
 */
export function clearCycles(owner, { network } = {}) {
  try {
    if (owner === undefined) {
      localStorage.removeItem(LEGACY_KEY)
      return
    }
    if (!owner) return
    localStorage.removeItem(scopedKey(network, owner))
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

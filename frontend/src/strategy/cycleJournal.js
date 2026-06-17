// frontend/src/strategy/cycleJournal.js
// Autonomous monitor-loop journal — the results.tsv analog from autoresearch.
// Every cycle (keep / discard / crash / idle) is appended so the NEVER-STOP loop
// keeps a complete, auditable trail without flooding UI or context.
// Pure localStorage I/O — no React, no network. Append-only, capped.

const KEY = 'yv_cycle_journal'
const MAX_ROWS = 100

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
    console.warn('[CycleJournal] write failed:', err.message)
  }
}

/** Append one cycle record. Never throws. */
export function saveCycle(row) {
  try {
    const rows = read()
    rows.push({ ...row, ts: Date.now() })
    write(rows)
  } catch (err) {
    console.warn('[CycleJournal] saveCycle failed:', err.message)
  }
}

/** @returns newest-first array of cycle records. */
export function getCycles() {
  return read().reverse()
}

export function clearCycles() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

/** Aggregate verdict counts + last cycle number. */
export function getJournalSummary() {
  const rows = read()
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
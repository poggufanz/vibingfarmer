// Data layer for the eligibility gate. Snapshot-first for qualitative facts; NUMERIC facts (tvl)
// are overlaid at runtime from DeFiLlama via vaultFactsLive.js when an overlay is present (it
// primes on app mount and caches 6h). No overlay -> pure snapshot, so tests + the offline path
// are unchanged. getLiveOverlay reads a module-local map filled by primeVaultFacts (lazy call
// time), so there is no import cycle even though vaultFactsLive imports the snapshot.
import { SNAPSHOT } from './vaultFactsSnapshot.js'
import { getLiveOverlay } from './vaultFactsLive.js'

/** @returns {{ protocol:string, isFixture:boolean, facts:object }} */
export function resolve(protocol) {
  const entry = SNAPSHOT[protocol]
  if (!entry) throw new Error(`no eligibility facts for protocol: ${protocol}`)
  const live = getLiveOverlay(protocol)
  const merged = live ? applyRefresh(entry, live.refreshed, live.asOf) : entry
  return { protocol, isFixture: !!entry.meta?.isFixture, facts: merged.facts }
}

export { SNAPSHOT }

/** Provenance-safe merge: only fully-refreshed fields become source:'live' with a new asOf. */
export function applyRefresh(entry, refreshed, nowMs) {
  const facts = { ...entry.facts }
  for (const [k, value] of Object.entries(refreshed)) {
    if (value === undefined || value === null) continue // failure/partial → keep snapshot
    facts[k] = { value, source: 'live', asOf: nowMs }
  }
  return { ...entry, facts }
}

// Data layer for the eligibility gate. Snapshot-first: NO live third-party call on the demo path.
// (Slice 2 adds an off-stage refresh script that updates the snapshot module, never a live call here.)
import { SNAPSHOT } from './vaultFactsSnapshot.js'

/** @returns {{ protocol:string, isFixture:boolean, facts:object }} */
export function resolve(protocol) {
  const entry = SNAPSHOT[protocol]
  if (!entry) throw new Error(`no eligibility facts for protocol: ${protocol}`)
  return { protocol, isFixture: !!entry.meta?.isFixture, facts: entry.facts }
}

export { SNAPSHOT }

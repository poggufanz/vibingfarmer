// frontend/src/strategy/submitGate.js
// One responsibility: decide whether a single deposit may be submitted RIGHT NOW.
// Soft circuit breaker; the hard stop is AgentVaultDepositor.pause() on-chain.
// Three guards, cheapest first:
//   1. stale_gas    — snapshot older than maxGasAgeMs (or missing)
//   2. uneconomic   — gas cost >= expected benefit (the Hermes fast-fail idea)
//   3. rate_anomaly — more than maxPerMin submits for one owner inside a minute
// The decision log is a bounded ring buffer (maxDecisions) so a long-running
// worker cannot leak memory through it.
const ONE_MIN = 60_000;

export function createSubmitGate({
  now = () => Date.now(),
  maxGasAgeMs = 15_000,
  maxPerMin = 5,
  maxDecisions = 1000,
  maxOwners = 1000,
} = {}) {
  const hits = new Map(); // owner -> number[] timestamps
  const decisions = [];

  function record(decision) {
    decisions.push(decision);
    if (decisions.length > maxDecisions) decisions.shift(); // ring buffer
    return decision;
  }

  // Drop owners whose timestamps are all older than the window so a long-running,
  // many-owner process cannot leak memory through `hits` (single-user = no-op).
  function sweepStaleOwners(t) {
    for (const [k, arr] of hits) {
      if (!arr.some((ts) => t - ts < ONE_MIN)) hits.delete(k);
    }
  }

  function check({ owner, gasSnapshotAt, estGasCostWei, expectedBenefitWei }) {
    const t = now();
    let ok = true, reason = 'ok';

    if (gasSnapshotAt == null || t - gasSnapshotAt > maxGasAgeMs) {
      ok = false; reason = 'stale_gas';
    } else if (
      estGasCostWei != null && expectedBenefitWei != null &&
      estGasCostWei >= expectedBenefitWei
    ) {
      ok = false; reason = 'uneconomic';
    } else {
      const arr = (hits.get(owner) || []).filter((ts) => t - ts < ONE_MIN);
      if (arr.length >= maxPerMin) { ok = false; reason = 'rate_anomaly'; }
      else { arr.push(t); }
      // Prune this owner's empty bucket; sweep all stale owners when the map grows.
      if (arr.length) hits.set(owner, arr); else hits.delete(owner);
      if (hits.size > maxOwners) sweepStaleOwners(t);
    }

    return record({ at: t, owner, ok, reason });
  }

  return { check, log: () => decisions };
}

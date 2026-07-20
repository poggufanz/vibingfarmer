// Shared Soroban transaction-confirmation poll. Extracted from the two verbatim copies that
// used to live in reverse.mjs (mintAndForwardStellar) and forward.mjs (invokeStellar).
//
// Why this exists: both copies called `server.getTransaction()` bare. A single transient RPC
// error AFTER a successful broadcast propagated out of the mint, so watcher.relayMint never
// reached its `store.set(execId, {status:'minted'})` and httpRouter marked the job 'error' —
// while the mint had already landed on-chain. Observed live on unwind burn 0x69e0856a...
// (Stellar mint 2a93e14f... succeeded; store stayed 'pending', user was told it failed).
// iris.mjs/pollAttestation already had the correct swallow-and-keep-polling shape; these two
// did not. One guard here fixes both callers.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls getTransaction until the tx is SUCCESS, definitively failed, or the window expires.
 * Transient RPC/network errors are swallowed and retried — they say nothing about whether the
 * already-broadcast transaction landed.
 *
 * @param {Object} params
 * @param {{getTransaction: Function}} params.server
 * @param {string} params.hash - hash returned by sendTransaction
 * @param {string} params.label - prefix for thrown error messages
 * @param {number} [params.attempts=30]
 * @param {number} [params.intervalMs=2000]
 * @returns {Promise<string>} the confirmed hash
 */
export async function confirmStellarTx({ server, hash, label, attempts = 30, intervalMs = 2000 }) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    await sleep(intervalMs);
    let got;
    try {
      got = await server.getTransaction(hash);
    } catch (err) {
      // Transient RPC error — the tx may still be landing, keep polling. Logged (and kept as
      // the final throw's `cause`) so a permanently-broken RPC doesn't masquerade as a clean
      // "not confirmed" timeout with zero trace of the real failure.
      lastErr = err;
      console.warn(`[stellarTx] ${label} getTransaction ${i + 1}/${attempts} errored, retrying: ${err?.message || err}`);
      continue;
    }
    if (got.status === 'NOT_FOUND') continue;
    if (got.status === 'SUCCESS') return hash;
    throw new Error(`${label} FAILED: ${got.status} ${JSON.stringify(got.resultXdr ?? '')}`);
  }
  // ponytail: the hash is in the message so an operator can reconcile by hand. Still leaves the
  // store at 'pending' if the window genuinely expires — persist the broadcast hash into the
  // store before confirming if that ever happens for real.
  throw new Error(`${label} not confirmed: ${hash}`, { cause: lastErr });
}

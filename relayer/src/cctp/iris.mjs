// Polls Circle's Iris attestation API (V2) until a burn's message+attestation are ready.
// Ported from spikes/cctp-corridor/roundtrip.mjs `pollIris` (also used for the reverse leg —
// Iris V2's endpoint shape is identical for both source domains, only sourceDomain changes).

const DEFAULT_MAX_ATTEMPTS = 50;
const DEFAULT_INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls GET {irisUrl}/v2/messages/{sourceDomain}?transactionHash={txHash} until
 * messages[0].status === 'complete' and attestation !== 'PENDING'. Resilient to non-JSON
 * bodies and transient fetch errors (keeps polling instead of throwing).
 */
export async function pollAttestation({
  irisUrl, sourceDomain, txHash, maxAttempts = DEFAULT_MAX_ATTEMPTS, intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const url = `${irisUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body, keep polling */ }
      const message = body?.messages?.[0];
      if (message && message.status === 'complete' && message.attestation && message.attestation !== 'PENDING') {
        return { message: message.message, attestation: message.attestation };
      }
    } catch {
      // transient network error — keep polling until maxAttempts
    }
    await sleep(intervalMs);
  }
  throw new Error(`pollAttestation: attestation not complete in time for ${txHash} (domain ${sourceDomain})`);
}

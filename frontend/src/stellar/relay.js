// Client helper for the gasless fee-bump relay. Pure fetch — no SDK, no secrets.
// The worker (sub-project 3) builds + signs the inner deposit tx and calls submitViaRelay
// with its base64 XDR. The server wraps it in a fee-bump and pays the XLM.

import { RELAY_PROXY_URL } from './config.js'

/** The relay was reachable and REFUSED this transaction. Distinct from "no relay here". */
export class RelayRejectedError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'RelayRejectedError'
    this.status = status
  }
}

/**
 * Submit an agent-signed inner Soroban transaction (base64 XDR) to the gasless relay.
 *
 * Two outcomes callers MUST NOT confuse:
 *   • null  — no relay to talk to (unreachable, or it answers "unconfigured"). Falling back to a
 *             user-paid submit is legitimate.
 *   • throw — the relay answered and REFUSED (403 origin, 429, guard rejection, failed fee-bump).
 *             A refusal is NOT permission to bill the user, who by product design holds no XLM.
 *
 * These used to both return null, so a policy refusal silently became a user-paid submit that the
 * user could never afford — surfacing as a bogus balance error while destroying the real reason.
 * @param {{ xdr: string }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 * @throws {RelayRejectedError} when the relay refused the transaction
 */
export async function submitViaRelay({ xdr }) {
  let res
  try {
    res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', xdr }),
    })
  } catch {
    return null // no relay reachable — fallback is legitimate
  }
  // 503 is the relay's own "I am not configured" — the one non-2xx that means "no relay here".
  if (res.status === 503) return null
  let d = null
  try {
    d = await res.json()
  } catch {
    d = null // a non-JSON body must not mask the status code below
  }
  if (!res.ok) {
    throw new RelayRejectedError(
      `The Stellar relay refused this transaction (HTTP ${res.status}): ${d?.error || 'no reason given'}`,
      res.status
    )
  }
  if (d?.configured === false) return null
  if (d?.error)
    throw new RelayRejectedError(
      `The Stellar relay refused this transaction: ${d.error}`,
      res.status
    )
  return { hash: d.hash, status: d.status, relayer: d.relayer }
}

/**
 * Relayer (fee source) public key — fund it with testnet XLM. null if unconfigured.
 * @returns {Promise<string | null>}
 */
export async function getRelayerAddress() {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'wallet' }),
    })
    if (!res.ok) return null
    const d = await res.json()
    return d.address || null
  } catch {
    return null
  }
}

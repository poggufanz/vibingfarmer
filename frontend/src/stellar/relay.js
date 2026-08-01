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

/** The submit POST may have reached the relay, but its chain outcome is not proven yet. */
export class RelaySubmissionUnknownError extends Error {
  constructor(message, result = null, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RelaySubmissionUnknownError'
    this.code = 'VF_SUBMISSION_UNKNOWN'
    this.submission = 'unknown'
    this.result = result
  }
}

/**
 * Submit an agent-signed inner Soroban transaction (base64 XDR) to the gasless relay.
 *
 * Three outcomes callers MUST NOT confuse:
 *   • null  — the relay definitively answered "unconfigured"; no submit was accepted.
 *   • RelayRejectedError — the relay explicitly refused the transaction.
 *   • RelaySubmissionUnknownError — the submit response was lost or did not prove a final result.
 *
 * These used to both return null, so a policy refusal silently became a user-paid submit that the
 * user could never afford — surfacing as a bogus balance error while destroying the real reason.
 * @param {{ xdr: string, signal?: AbortSignal }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 * @throws {RelayRejectedError|RelaySubmissionUnknownError}
 */
export async function submitViaRelay({ xdr, signal }) {
  let res
  try {
    res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', xdr }),
      ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    throw new RelaySubmissionUnknownError(
      'Lost contact with the Stellar relay after submission. Check the chain before retrying.',
      null,
      cause
    )
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
  const result = Object.fromEntries(
    ['hash', 'status', 'relayer']
      .filter((field) => Object.prototype.hasOwnProperty.call(d || {}, field))
      .map((field) => [field, d[field]])
  )
  const hashProven = typeof result.hash === 'string' && result.hash.length > 0
  if (!hashProven || !['SUCCESS', 'FAILED', 'duplicate'].includes(result.status)) {
    throw new RelaySubmissionUnknownError(
      `The Stellar relay returned an unproved submission outcome${
        result.status ? ` (${result.status})` : ''
      }. Check the chain before retrying.`,
      result
    )
  }
  return result
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

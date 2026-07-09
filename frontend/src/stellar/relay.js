// Client helper for the gasless fee-bump relay. Pure fetch — no SDK, no secrets.
// The worker (sub-project 3) builds + signs the inner deposit tx and calls submitViaRelay
// with its base64 XDR. The server wraps it in a fee-bump and pays the XLM.

import { RELAY_PROXY_URL } from './config.js'

/**
 * Submit an agent-signed inner Soroban transaction (base64 XDR) to the gasless relay.
 * @param {{ xdr: string }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 *   null when the relay is unconfigured or the request fails — caller decides the fallback.
 */
export async function submitViaRelay({ xdr }) {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', xdr }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.configured === false || d.error) return null
    return { hash: d.hash, status: d.status, relayer: d.relayer }
  } catch {
    return null
  }
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

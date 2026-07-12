// frontend/src/vfapi/client.js
// Thin client over VF's existing modules.
// Non-custodial HARD RULE: returns analysis + UNSIGNED XDR only.
// Never signs, never takes / returns a secret / seed / privateKey.

import { evaluate } from '../strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../strategy/vaultFacts.js'
import { submitViaRelay } from '../stellar/relay.js'

/**
 * App-layer, fail-closed F8 gate.
 * HONESTY: app-layer check only — not on-chain-verifiable.
 * When `facts` is omitted, facts are resolved from the protocol slug (`protocol`, falling back
 * to `vault` for callers that pass the slug there). Unknown slug/address = no facts = reject —
 * fail-closed, never a silent default.
 *
 * @param {{ vault: string, protocol?: string, amount: bigint, facts?: object, nowMs?: number }} params
 * @returns {Promise<{ allow: boolean, verdict: object|null, reasons: string[] }>}
 */
export async function eligibility({ vault, protocol, amount, facts, nowMs }) {
  const slug = protocol || vault
  let resolved
  if (facts) {
    resolved = { protocol: slug, isFixture: false, facts }
  } else {
    try {
      resolved = resolveVaultFacts(slug)
    } catch (err) {
      return { allow: false, verdict: null, reasons: [`facts unavailable: ${err.message}`] }
    }
  }
  const verdict = evaluate({ ...resolved, vault, amount }, nowMs)
  return {
    allow: verdict.eligible ?? false,
    verdict,
    reasons: verdict.reasons ?? [],
  }
}

/**
 * Resolve vault eligibility facts for a named protocol.
 *
 * @param {string} protocol
 * @returns {{ protocol: string, isFixture: boolean, facts: object }}
 */
export function vaultFacts(protocol) {
  return resolveVaultFacts(protocol)
}

/**
 * Build an UNSIGNED transaction XDR via the injected assemble function.
 * `assemble` is always injected — the real wiring is added in later tasks.
 *
 * @param {{ kind: string, params: object, assemble: Function }} p
 * @returns {Promise<{ xdr: string }>}
 */
export async function buildUnsignedTx({ kind, params, assemble }) {
  if (!assemble) throw new Error('assemble fn required (wired in Task 10/12/13)')
  const { xdr } = await assemble({ kind, params })
  return { xdr }
}

/**
 * Submit an already-signed XDR via the gasless relay.
 *
 * @param {string} xdr
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 */
export async function submit(xdr) {
  return submitViaRelay({ xdr })
}

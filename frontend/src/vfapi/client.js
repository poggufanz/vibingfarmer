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
 *
 * @param {{ vault: string, amount: bigint, facts?: object, nowMs?: number }} params
 * @returns {Promise<{ allow: boolean, verdict: object, reasons: string[] }>}
 */
export async function eligibility({ vault, amount, facts, nowMs }) {
  const verdict = evaluate({ vault, amount, facts }, nowMs)
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

// attestation.js
// Hashes a strategy/plan into a deterministic, verifiable record. Anyone can re-derive the
// strategyHash off-chain from the plan JSON alone (canonicalStrategy.js) -- no wallet, network,
// or wall clock involved; attestStrategyOnChain() below is a SEPARATE, explicit action that
// additionally records that hash on-chain via the Soroban attestation contract
// (SOROBAN_ATTESTATION_ADDRESS). Automatic plan generation must call hashStrategy only --
// never attestStrategyOnChain -- so it never touches a wallet or provider.

import { hash } from '@stellar/stellar-sdk' // sync sha256 (already a dep — no ethers)
import { attestOnChain } from './stellar/attestation.js'
import { canonicalizeStrategy } from './strategy/canonicalStrategy.js'

/**
 * Hash a strategy plan into a deterministic 0x-prefixed 32-byte hex string. Synchronous,
 * off-chain, no I/O -- same semantic plan hashes identically across calls and regardless of
 * source object key order (canonicalizeStrategy). Anyone can reproduce this hash from the
 * plan JSON.
 * @param {object} plan - a StrategyPlan (planModel.js) or plan-shaped strategy object
 * @returns {string} 0x-prefixed sha256 hash (bytes32-shaped)
 */
export function hashStrategy(plan) {
  const payload = JSON.stringify(canonicalizeStrategy(plan))
  const digest = hash(Buffer.from(payload, 'utf8')) // 32-byte sha256
  return '0x' + Buffer.from(digest).toString('hex')
}

/**
 * Explicit, opt-in on-chain attestation. Never called by automatic plan generation -- only an
 * explicit user action (e.g. a receipt-screen button) may call this. Always computes the
 * deterministic strategyHash (verifiable off-chain by reproducing it from the plan JSON). When
 * an `attester` (connected wallet) is given, additionally anchors the hash on-chain via the
 * Soroban attestation contract (user-signed inner tx, relayer fee-bumped → 0 XLM for the user,
 * one additional wallet confirmation) and captures the tx hash. NEVER blocking: a missing
 * wallet or a relay failure falls back to the off-chain hash; strategy execution always
 * continues.
 * @param {object} plan - a StrategyPlan (planModel.js) or plan-shaped strategy object
 * @param {{ attester?: string }} [opts]
 * @returns {Promise<{strategyHash, txHash, explorerUrl}|null>}
 */
export async function attestStrategyOnChain(plan, { attester } = {}) {
  try {
    const strategyHash = plan.strategyHash || hashStrategy(plan)
    if (!attester) return { strategyHash, txHash: null, explorerUrl: null }
    const r = await attestOnChain({
      attester,
      strategyHash,
      label: plan.generatedBy || plan.source,
    })
    return { strategyHash, txHash: r?.hash || null, explorerUrl: null }
  } catch (err) {
    console.warn('[Attestation] Skipped (non-blocking):', err.message)
    return null
  }
}

/**
 * Format an attestation result for display in the UI.
 * @param {{txHash, strategyHash}|null} attestation
 */
export function formatAttestation(attestation) {
  if (!attestation) return null
  const txHash = attestation.txHash || null
  return {
    hash: attestation.strategyHash.slice(0, 10) + '...',
    fullHash: attestation.strategyHash,
    txHash,
    explorerUrl: txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null,
    label: txHash ? 'Strategy attested on-chain' : 'Strategy hash (off-chain verifiable)',
  }
}

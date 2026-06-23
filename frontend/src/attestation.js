// attestation.js
// Hashes Venice AI strategy output into a deterministic, off-chain-verifiable record.
// (Single-chain Stellar: there is no on-chain attestation tx today — the depositor is
// deposit-only. We compute a reproducible strategyHash; anyone can re-derive it from the
// strategy JSON. An on-chain Soroban attestation can be added later as an additive feature.)

import { hash } from '@stellar/stellar-sdk' // sync sha256 (already a dep — no ethers)

/**
 * Hash strategy + reasoning into a deterministic 0x-prefixed 32-byte hex string.
 * Anyone can reproduce this hash from the original strategy JSON.
 * @param {object} strategy - raw Venice AI strategy (selected_vaults schema)
 * @returns {string} 0x-prefixed sha256 hash (bytes32-shaped)
 */
export function hashStrategy(strategy) {
  const payload = JSON.stringify({
    vaults: strategy.selected_vaults?.map((v) => ({
      address: v.address,
      protocol: v.protocol,
      allocation: v.allocation,
      expectedApy: v.expected_apy,
    })),
    reasoning: strategy.selected_vaults?.map((v) => v.reasoning),
    strategySource: strategy.generatedBy,
    timestamp: Math.floor(Date.now() / 1000),
  })
  const digest = hash(Buffer.from(payload, 'utf8')) // 32-byte sha256
  return '0x' + Buffer.from(digest).toString('hex')
}

/**
 * Strategy attestation. No on-chain tx (the Stellar vault is deposit-only and carries no
 * attest method). We compute the deterministic strategyHash (verifiable off-chain by
 * reproducing it from the strategy JSON) and return it without a txHash. NEVER blocking —
 * strategy execution always continues.
 * @param {object} strategy - raw Venice AI strategy output
 * @returns {Promise<{strategyHash}|null>}
 */
export async function attestStrategyOnChain(strategy) {
  try {
    const strategyHash = strategy.strategyHash || hashStrategy(strategy)
    return { strategyHash, txHash: null, blockNumber: null }
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
  return {
    hash: attestation.strategyHash.slice(0, 10) + '...',
    fullHash: attestation.strategyHash,
    txHash: attestation.txHash || null,
    explorerUrl: null, // off-chain hash — no tx to link
    label: 'Strategy hash (off-chain verifiable)',
  }
}

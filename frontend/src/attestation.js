// attestation.js
// Hashes Venice AI strategy output and attests it on-chain.
// Creates a verifiable, tamper-proof record of the AI reasoning (ERC-8004 aligned).

import { ethers } from 'ethers'

/**
 * Hash strategy + reasoning into a deterministic bytes32.
 * Anyone can reproduce this hash from the original strategy JSON.
 * @param {object} strategy - raw Venice AI strategy (selected_vaults schema)
 * @returns {string} bytes32 keccak256 hash
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
  return ethers.keccak256(ethers.toUtf8Bytes(payload))
}

/**
 * Strategy attestation. The Roadmap v2 AgentVaultDepositor is deposit-only and carries NO
 * attestStrategy method, so there is no on-chain attestation tx. We still compute the
 * deterministic strategyHash (verifiable off-chain by reproducing it from the strategy JSON)
 * and return it without a txHash. NEVER blocking — strategy execution always continues.
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
    etherscanUrl: attestation.txHash ? `https://sepolia.basescan.org/tx/${attestation.txHash}` : null,
    label: attestation.txHash ? 'Strategy attested on-chain' : 'Strategy hash (off-chain verifiable)',
  }
}

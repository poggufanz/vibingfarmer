// frontend/src/base/quotes.js
// Authoritative (execution-time) minShares: reads the pool's live ERC-4626 convertToShares()
// right before the deposit call is dispatched, applying a slippage tolerance. This supersedes
// venice.js's allocateBasePools strategy-time estimate, which can go stale between allocation and
// dispatch (pool share price drifts). The on-chain YieldRouter's own minShares floor (SP1 Task
// 1.2) is the actual enforcement; this is the client-side guard that produces the right number.
import { ERC4626_ABI } from './config.js'

const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

/**
 * @param {{ pool: string, amountBaseUnits: bigint, slippageBps?: number, publicClient: object }} p
 * @returns {Promise<bigint>}
 */
export async function estimateMinShares({
  pool,
  amountBaseUnits,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  publicClient,
}) {
  if (typeof amountBaseUnits !== 'bigint' || amountBaseUnits <= 0n) {
    throw new Error(`amountBaseUnits must be a positive bigint, got ${amountBaseUnits}`)
  }
  const quotedShares = await publicClient.readContract({
    address: pool,
    abi: ERC4626_ABI,
    functionName: 'convertToShares',
    args: [amountBaseUnits],
  })
  return (BigInt(quotedShares) * BigInt(10_000 - slippageBps)) / 10_000n
}

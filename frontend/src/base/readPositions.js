// frontend/src/base/readPositions.js
// Post-farm on-chain read: how many shares does `account` hold in each pool right now, and what
// are they worth? Feeds Withdraw's `withdrawals` prop (spec §6 step 8) — depositResults from the
// farm dispatch can undercount partial fills, so this reads the live ERC-20 share balance per
// pool rather than trusting a client-side running total. Mirrors quotes.js's estimateMinShares
// readContract + slippage-tolerance idiom, applied to the withdraw side.
import { ERC20_ABI, ERC4626_ABI } from './config.js'

const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

/**
 * @param {{ pools: string[], account: string, publicClient: object, slippageBps?: number }} p
 * @returns {Promise<Array<{ pool: string, shares: bigint, minAssets: bigint }>>}
 */
export async function readPositions({
  pools,
  account,
  publicClient,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
}) {
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error('readPositions requires at least one pool')
  }

  const positions = await Promise.all(
    pools.map(async (pool) => {
      const rawShares = await publicClient.readContract({
        address: pool,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account],
      })
      const shares = BigInt(rawShares)
      if (shares === 0n) return null // nothing to withdraw from this pool — no assets call needed

      const rawAssets = await publicClient.readContract({
        address: pool,
        abi: ERC4626_ABI,
        functionName: 'convertToAssets',
        args: [shares],
      })
      const assets = BigInt(rawAssets)
      const minAssets = (assets * BigInt(10_000 - slippageBps)) / 10_000n
      // `assets` = the pool's own valuation of these shares (what the position is WORTH);
      // `minAssets` is that minus slippage tolerance and is a withdraw floor, not a balance.
      // The dashboard totals must use `assets` or every Base position reads 0.5% light.
      return { pool, shares, assets, minAssets }
    })
  )

  return positions.filter((p) => p !== null)
}

// Base Sepolia Circle USDC, same constant withdrawBatch.js burns.
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

/**
 * Idle USDC sitting in the kernel account. BaseExitSweeper takes this alongside
 * the pool positions, so the modal must show it BEFORE the signature, and the
 * CCTP maxFee basis must include it. Fails soft to 0n: a balance read must never
 * be the reason a withdraw cannot start.
 * @param {{ account: string, publicClient: object }} p
 * @returns {Promise<bigint>}
 */
export async function readIdleUsdc({ account, publicClient }) {
  try {
    const raw = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    })
    return BigInt(raw)
  } catch {
    return 0n
  }
}

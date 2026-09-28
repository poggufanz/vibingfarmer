// Live, read-only vault numbers for the public landing. The Stellar SDK is imported lazily so it
// stays out of the landing's first paint. A failed read renders "--", never a guessed value.
import { useEffect, useState } from 'react'

const USDC_UNIT = 10_000_000n // Stellar USDC has 7 decimals

// A Soroban RPC that accepts the request and never answers would leave the stamp on "reading"
// forever; past this the read counts as failed.
export const READ_TIMEOUT_MS = 10_000

export const STAMP = {
  loading: 'reading Stellar testnet',
  live: 'live · Stellar testnet',
  partial: 'partly live · one on-chain read failed',
  unavailable: 'unavailable · on-chain read failed',
}

export const formatApr = (bps) => (bps == null ? '--' : `${(bps / 100).toFixed(2)}%`)

export const wholeUsdc = (units) => (units + USDC_UNIT / 2n) / USDC_UNIT

export function formatTvl(units) {
  if (units == null) return '--'
  return `${wholeUsdc(units).toLocaleString('en-US')} USDC`
}

// ponytail: the losing timer is left to fire into a settled race; it holds nothing but a closure.
const withTimeout = (read) =>
  Promise.race([
    read,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('read timed out')), READ_TIMEOUT_MS)
    ),
  ])

function statusOf(aprBps, totalAssets) {
  if (aprBps == null && totalAssets == null) return 'unavailable'
  if (aprBps == null || totalAssets == null) return 'partial'
  return 'live'
}

export function useLandingStats() {
  const [stats, setStats] = useState({ aprBps: null, totalAssets: null, status: 'loading' })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [{ readSupplyAprBps, readTotalAssets }, { SOROBAN_BLEND_POOL_ADDRESS }] =
          await Promise.all([import('../stellar/vaultReads.js'), import('../stellar/config.js')])
        const [apr, tvl] = await Promise.allSettled([
          SOROBAN_BLEND_POOL_ADDRESS
            ? withTimeout(readSupplyAprBps(SOROBAN_BLEND_POOL_ADDRESS))
            : null,
          withTimeout(readTotalAssets()),
        ])
        const aprBps = apr.status === 'fulfilled' ? apr.value : null
        const totalAssets = tvl.status === 'fulfilled' ? tvl.value : null
        if (alive) setStats({ aprBps, totalAssets, status: statusOf(aprBps, totalAssets) })
      } catch {
        if (alive) setStats({ aprBps: null, totalAssets: null, status: 'unavailable' })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return stats
}

// Live, read-only vault numbers for the public landing. The Stellar SDK is imported lazily so it
// stays out of the landing's first paint. A failed read renders "--", never a guessed value.
import { useEffect, useState } from 'react'

const USDC_UNIT = 10_000_000n // Stellar USDC has 7 decimals

export const formatApr = (bps) => (bps == null ? '--' : `${(bps / 100).toFixed(2)}%`)

export function formatTvl(units) {
  if (units == null) return '--'
  const whole = (units + USDC_UNIT / 2n) / USDC_UNIT
  return `${whole.toLocaleString('en-US')} USDC`
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
          SOROBAN_BLEND_POOL_ADDRESS ? readSupplyAprBps(SOROBAN_BLEND_POOL_ADDRESS) : null,
          readTotalAssets(),
        ])
        const aprBps = apr.status === 'fulfilled' ? apr.value : null
        const totalAssets = tvl.status === 'fulfilled' ? tvl.value : null
        const status = aprBps == null && totalAssets == null ? 'unavailable' : 'live'
        if (alive) setStats({ aprBps, totalAssets, status })
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

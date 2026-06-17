// defiLlama.js
// Fetches real vault data from DeFiLlama Yields API.
// Maps real protocol names to MockVault addresses for Base Sepolia execution.
// Never throws — returns fallback catalog on any failure.

import { MOCK_VAULT_A_ADDRESS, MOCK_VAULT_B_ADDRESS } from './config.js'

const DEFILLAMA_ENDPOINT = 'https://yields.llama.fi/pools'
const DEFILLAMA_TIMEOUT_MS = 10000

// Protocols we support + their MockVault mapping on Base Sepolia
// Real protocol → MockVault address for execution
const PROTOCOL_VAULT_MAP = {
  'aave-v3':    MOCK_VAULT_A_ADDRESS,
  'morpho-blue': MOCK_VAULT_B_ADDRESS,
  'pendle':     MOCK_VAULT_B_ADDRESS,
  'fluid':      MOCK_VAULT_A_ADDRESS,
  'compound-v3': MOCK_VAULT_A_ADDRESS,
  'spark':      MOCK_VAULT_A_ADDRESS,
}

// Risk tier mapping per protocol
const PROTOCOL_RISK_MAP = {
  'aave-v3':     'low',
  'compound-v3': 'low',
  'spark':       'low',
  'morpho-blue': 'medium',
  'fluid':       'high',
  'pendle':      'high',
}

/**
 * Fetches USDC vaults on Ethereum from DeFiLlama.
 * Filters to protocols we support + have MockVault mapping for.
 * Returns enriched vault list ready to inject into Venice AI prompt.
 *
 * @returns {Promise<Array>} array of vault objects or fallback catalog
 */
export async function fetchDeFiLlamaVaults() {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFILLAMA_TIMEOUT_MS)

  try {
    const res = await fetch(DEFILLAMA_ENDPOINT, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      console.warn('[DeFiLlama] API error:', res.status)
      return getFallbackCatalog()
    }

    const { data } = await res.json()

    // Filter: Ethereum chain + USDC symbol + supported protocols + has TVL
    const supportedProtocols = Object.keys(PROTOCOL_VAULT_MAP)

    const filtered = data
      .filter(pool =>
        pool.chain === 'Ethereum' &&
        pool.symbol?.toUpperCase().includes('USDC') &&
        supportedProtocols.includes(pool.project) &&
        pool.tvlUsd > 1_000_000 && // min $1M TVL — filter dust pools
        pool.apy > 0 &&
        pool.ilRisk !== 'yes' // exclude IL-risk pools; API returns "no"/"yes" (not bool)
      )
      .sort((a, b) => b.tvlUsd - a.tvlUsd) // sort by TVL descending
      .slice(0, 6) // take top 6 by TVL

    if (filtered.length === 0) {
      console.warn('[DeFiLlama] No matching pools found — using fallback')
      return getFallbackCatalog()
    }

    // Map to vault catalog format
    const vaults = filtered.map(pool => ({
      // Display info (real from DeFiLlama)
      name: formatVaultName(pool.project, pool.symbol),
      protocol: pool.project,
      apy: parseFloat(pool.apy.toFixed(2)),
      tvlUsd: pool.tvlUsd,
      tvlFormatted: formatTVL(pool.tvlUsd),
      chain: pool.chain,
      symbol: pool.symbol,
      defillamaPool: pool.pool, // real mainnet pool address (display only)
      poolId: pool.pool, // DeFiLlama pool UUID — used for APY history fetch

      // Execution info (MockVault on Base Sepolia)
      address: PROTOCOL_VAULT_MAP[pool.project],

      // Risk metadata
      risk: PROTOCOL_RISK_MAP[pool.project] || 'medium',
      yield_source: getYieldSource(pool.project),
      drawdown: getDrawdown(pool.project),

      // Source flag
      source: 'defiLlama',
      dataFetchedAt: new Date().toISOString(),
    }))

    console.log(`[DeFiLlama] Fetched ${vaults.length} real vaults`)
    return vaults

  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      console.warn('[DeFiLlama] Timeout after 10s — using fallback catalog')
    } else {
      console.warn('[DeFiLlama] Fetch failed:', err.message)
    }
    return getFallbackCatalog()
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatVaultName(project, symbol) {
  const names = {
    'aave-v3':     'Aave v3',
    'morpho-blue': 'Morpho Blue',
    'pendle':      'Pendle Finance',
    'fluid':       'Fluid Protocol',
    'compound-v3': 'Compound v3',
    'spark':       'Spark Protocol',
  }
  return `${names[project] || project} ${symbol}`
}

function formatTVL(tvlUsd) {
  if (tvlUsd >= 1_000_000_000) return `$${(tvlUsd / 1_000_000_000).toFixed(1)}B`
  if (tvlUsd >= 1_000_000) return `$${(tvlUsd / 1_000_000).toFixed(0)}M`
  return `$${tvlUsd.toLocaleString()}`
}

function getYieldSource(project) {
  const map = {
    'aave-v3':     'lending',
    'morpho-blue': 'curated',
    'pendle':      'structured',
    'fluid':       'hybrid',
    'compound-v3': 'lending',
    'spark':       'lending',
  }
  return map[project] || 'lending'
}

function getDrawdown(project) {
  const map = {
    'aave-v3':     '-1.2',
    'morpho-blue': '-2.8',
    'pendle':      '-6.5',
    'fluid':       '-4.1',
    'compound-v3': '-1.5',
    'spark':       '-1.3',
  }
  return map[project] || '-2.0'
}

/**
 * Fallback catalog — used when DeFiLlama is unreachable.
 * Same structure as live data so downstream code never breaks.
 */
function getFallbackCatalog() {
  return [
    {
      name: 'Aave v3 USDC',
      protocol: 'aave-v3',
      apy: 4.8,
      tvlUsd: 2_100_000_000,
      tvlFormatted: '$2.1B',
      chain: 'Ethereum',
      symbol: 'USDC',
      address: MOCK_VAULT_A_ADDRESS,
      risk: 'low',
      yield_source: 'lending',
      drawdown: '-1.2',
      poolId: null,
      source: 'fallback',
    },
    {
      name: 'Morpho Blue USDC',
      protocol: 'morpho-blue',
      apy: 6.1,
      tvlUsd: 800_000_000,
      tvlFormatted: '$800M',
      chain: 'Ethereum',
      symbol: 'USDC',
      address: MOCK_VAULT_B_ADDRESS,
      risk: 'medium',
      yield_source: 'curated',
      drawdown: '-2.8',
      poolId: null,
      source: 'fallback',
    },
    {
      name: 'Pendle PT-USDC',
      protocol: 'pendle',
      apy: 9.4,
      tvlUsd: 400_000_000,
      tvlFormatted: '$400M',
      chain: 'Ethereum',
      symbol: 'USDC',
      address: MOCK_VAULT_B_ADDRESS,
      risk: 'high',
      yield_source: 'structured',
      drawdown: '-6.5',
      poolId: null,
      source: 'fallback',
    },
    {
      name: 'Fluid USDC',
      protocol: 'fluid',
      apy: 5.2,
      tvlUsd: 300_000_000,
      tvlFormatted: '$300M',
      chain: 'Ethereum',
      symbol: 'USDC',
      address: MOCK_VAULT_A_ADDRESS,
      risk: 'high',
      yield_source: 'hybrid',
      drawdown: '-4.1',
      poolId: null,
      source: 'fallback',
    },
  ]
}

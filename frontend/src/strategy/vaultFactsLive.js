// Live NUMERIC facts for the eligibility gate (spec §5). DeFiLlama is the only source and only
// numbers are refreshed — qualitative facts (audit, adminKey, oracleType, poolClass) stay curated
// in vaultFactsSnapshot.js because no public API states them reliably. Fail-open to snapshot:
// any fetch/parse problem leaves provenance 'snapshot' and never blocks the flow.
// Imports SNAPSHOT from vaultFactsSnapshot.js directly (not vaultFacts.js) so there is no import
// cycle with vaultFacts.js, which imports getLiveOverlay from here.
import { SNAPSHOT } from './vaultFactsSnapshot.js'

const TTL_MS = 6 * 60 * 60 * 1000
const CACHE_KEY = 'vf_vault_facts_live_v1'

// protocol slug in SNAPSHOT -> DeFiLlama protocol slug (api.llama.fi/tvl/<slug> -> number).
// 'blend-usdc' is the product's own Stellar vault — DeFiLlama tracks Blend as a protocol.
const LLAMA_SLUG = {
  'blend-usdc': 'blend',
  'aave-v3': 'aave-v3',
  'morpho-blue': 'morpho-blue',
  'pendle-v2': 'pendle',
  fluid: 'fluid',
}

let overlays = null // { [protocol]: { refreshed: { tvl }, asOf } }

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function getLiveOverlay(protocol) {
  return overlays?.[protocol] ?? null
}

export async function primeVaultFacts({
  fetchImpl = fetch,
  storage = defaultStorage(),
  now = () => Date.now(),
} = {}) {
  try {
    const cached = storage?.getItem(CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (now() - parsed.fetchedAt < TTL_MS) {
        overlays = parsed.overlays
        return
      }
    }
  } catch {
    /* corrupted cache -> refetch */
  }

  const next = {}
  const slugs = Object.entries(SNAPSHOT).filter(([, e]) => !e.meta?.isFixture)
  await Promise.all(
    slugs.map(async ([protocol]) => {
      const slug = LLAMA_SLUG[protocol]
      if (!slug) return // unknown mapping -> keep snapshot
      try {
        const res = await fetchImpl(`https://api.llama.fi/tvl/${slug}`)
        if (!res.ok) return
        const tvl = Number(await res.json())
        if (Number.isFinite(tvl) && tvl > 0) next[protocol] = { refreshed: { tvl }, asOf: now() }
      } catch {
        /* one slug failing must not poison the rest */
      }
    })
  )

  if (Object.keys(next).length > 0) {
    overlays = next
    try {
      storage?.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: now(), overlays: next }))
    } catch {
      /* quota */
    }
  }
}

export const _test = {
  reset: () => {
    overlays = null
  },
}

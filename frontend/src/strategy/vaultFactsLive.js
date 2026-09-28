// Live NUMERIC facts for the eligibility gate (spec §5). DeFiLlama is the only source and only
// numbers are refreshed — qualitative facts (audit, adminKey, oracleType, poolClass) stay curated
// in vaultFactsSnapshot.js because no public API states them reliably. Fail-open to snapshot:
// any fetch/parse problem leaves provenance 'snapshot' and never blocks the flow.
// Imports SNAPSHOT from vaultFactsSnapshot.js directly (not vaultFacts.js) so there is no import
// cycle with vaultFacts.js, which imports getLiveOverlay from here.
//
// Cache gate: envelope tervalidasi bentuknya (bukan cuma fetchedAt), clock-skew masa depan
// ditolak sebagai miss (searah freshness.js MAX_CLOCK_SKEW_MS), overlay basi TIDAK PERNAH
// disajikan sebagai live (diabaikan → snapshot), dan prime konkuren digabung singleflight.
import { SNAPSHOT } from './vaultFactsSnapshot.js'

const TTL_MS = 6 * 60 * 60 * 1000
const CACHE_KEY = 'vf_vault_facts_live_v1'
const ENVELOPE_VERSION = 1
const MAX_CLOCK_SKEW_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 8000

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
let primeInflight = null // singleflight: prime konkuren = satu fetch

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Umur cache ms, atau null bila tidak dapat dipercaya (bentuk salah / skew masa depan). */
function cacheAge(parsed, nowMs) {
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.version !== ENVELOPE_VERSION) return null
  if (!Number.isFinite(parsed.fetchedAt)) return null
  const age = nowMs - parsed.fetchedAt
  if (!Number.isFinite(age) || age < -MAX_CLOCK_SKEW_MS) return null
  return age
}

function validOverlayEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (!Number.isFinite(entry.asOf)) return false
  const tvl = entry.refreshed?.tvl
  return typeof tvl === 'number' && Number.isFinite(tvl) && tvl > 0
}

function validOverlays(value) {
  if (!value || typeof value !== 'object') return false
  return Object.values(value).every(validOverlayEntry)
}

export function getLiveOverlay(protocol) {
  return overlays?.[protocol] ?? null
}

export async function primeVaultFacts({
  fetchImpl = fetch,
  storage = defaultStorage(),
  now = () => Date.now(),
} = {}) {
  if (primeInflight) return primeInflight
  primeInflight = doPrime({ fetchImpl, storage, now }).finally(() => {
    primeInflight = null
  })
  return primeInflight
}

async function doPrime({ fetchImpl, storage, now }) {
  try {
    const cached = storage?.getItem(CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      const age = cacheAge(parsed, now())
      if (age !== null && age < TTL_MS && validOverlays(parsed.overlays)) {
        overlays = parsed.overlays
        return
      }
      // Bentuk salah / versi asing / skew masa depan / kedaluwarsa → refetch, tidak dipercaya.
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
        const res = await fetchImpl(`https://api.llama.fi/tvl/${slug}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
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
      storage?.setItem(
        CACHE_KEY,
        JSON.stringify({ version: ENVELOPE_VERSION, fetchedAt: now(), overlays: next })
      )
    } catch {
      /* quota */
    }
  }
  // Gagal total: overlays lama (di memori) TIDAK dipertahankan diam-diam sebagai live.
  // Abaikan → konsumen jatuh ke snapshot. Overlay basi tidak pernah berlabel live.
  else {
    overlays = null
  }
}

export const _test = {
  reset: () => {
    overlays = null
    primeInflight = null
  },
}

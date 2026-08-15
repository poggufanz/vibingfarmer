// frontend/src/strategy/mergedCatalog.js
// Fail-closed merged catalog: Base pools are only offered to the strategist when the relayer
// answers. Health probe = public `GET /api/vf-cross/config` on the same-origin proxy — healthy
// only on an explicit `readiness.ready === true`; an unconfigured proxy (503), an unknown route
// (404), a dead tunnel (502), or a network error all fail closed. A cross-origin
// VITE_CROSS_RELAYER_BASE override is deliberately ignored: readiness must come from the same
// proxy boundary every capability flow uses.
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'
import { normalizeVenue, VENUE_KINDS } from './venueTruth.js'

const DEFAULT_BASE_URL = '/api/vf-cross'

export async function checkRelayerHealth({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 3000,
  signal,
} = {}) {
  // Capability/readiness flows only ever go through the same-origin proxy — a direct
  // cross-origin relayer base URL is refused without opening a request.
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('/') || baseUrl.startsWith('//')) {
    return false
  }
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const res = await fetchImpl(`${baseUrl}/config`, {
      method: 'GET',
      credentials: 'same-origin',
      signal: composedSignal,
    })
    if (!res.ok) return false
    const config = await res.json()
    return config?.readiness?.ready === true
  } catch {
    // Network error or abort/timeout: fail closed (Base offered only on a confirmed-live relayer).
    return false
  }
}

// Truth is stamped AFTER the raw fields are spread, so it always wins — a fetched record's own
// `protocol`/`venueKind`/`apy` claim can never overwrite where funds actually execute or what
// yield is actually live (see venueTruth.js). `liveVaults` (e.g. a DeFiLlama fetch) is explicitly
// stamped venueKind:'stellar-live' here regardless of what protocol string it carries — every
// Stellar-side record in this catalog executes on the one Autofarm vault, full stop.
const stampVenue = (raw, venueKind) => ({ ...raw, ...normalizeVenue({ ...raw, venueKind }) })

export function buildMergedCatalog({ baseAvailable, liveVaults = null }) {
  const stellarSource = liveVaults && liveVaults.length > 0 ? liveVaults : VAULT_CATALOG
  const stellar = stellarSource.map((v) => stampVenue(v, VENUE_KINDS.STELLAR_LIVE))
  if (!baseAvailable) return stellar
  const base = BASE_POOL_CATALOG.map((p) => stampVenue(p, VENUE_KINDS.BASE_CUSTODY_PROXY))
  return [...stellar, ...base]
}

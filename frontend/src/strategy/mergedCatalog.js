// frontend/src/strategy/mergedCatalog.js
// Fail-closed merged catalog: Base pools are only offered to the strategist when the relayer
// answers. Health probe = GET /status/health-probe on the vf-cross proxy — a LIVE relayer
// returns 404 {"error":"unknown jobId"}; an unconfigured proxy returns 503; a dead tunnel 502.
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'
import { normalizeVenue, VENUE_KINDS } from './venueTruth.js'

const DEFAULT_BASE_URL = import.meta.env?.VITE_CROSS_RELAYER_BASE || '/api/vf-cross'

export async function checkRelayerHealth({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 3000,
  signal,
} = {}) {
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const res = await fetchImpl(`${baseUrl}/status/health-probe`, { signal: composedSignal })
    return res.status === 404
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

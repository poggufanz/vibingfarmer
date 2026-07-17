// frontend/src/strategy/mergedCatalog.js
// Fail-closed merged catalog: Base pools are only offered to the strategist when the relayer
// answers. Health probe = GET /status/health-probe on the vf-cross proxy — a LIVE relayer
// returns 404 {"error":"unknown jobId"}; an unconfigured proxy returns 503; a dead tunnel 502.
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'

const DEFAULT_BASE_URL = import.meta.env?.VITE_CROSS_RELAYER_BASE || '/api/vf-cross'

export async function checkRelayerHealth({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl}/status/health-probe`)
    return res.status === 404
  } catch {
    return false
  }
}

export function buildMergedCatalog({ baseAvailable, liveVaults = null }) {
  const stellar = (liveVaults && liveVaults.length > 0 ? liveVaults : VAULT_CATALOG).map((v) => ({
    ...v,
    chain: 'stellar',
  }))
  if (!baseAvailable) return stellar
  return [...stellar, ...BASE_POOL_CATALOG.map((p) => ({ ...p, chain: 'base' }))]
}

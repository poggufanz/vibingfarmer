// frontend/src/base/dashboardPositions.js
// Read-only Base positions for the unified dashboard. No signature, no ceremony: uses the
// PERSISTED owner address (vf_base_owner_address, written by wallet/passkeyBridge.js) — the
// passkey is only touched when the user actually withdraws (see app.jsx's Withdraw wiring).
// Fail-soft end to end: no owner yet, or any RPC error, -> [] and the dashboard renders without
// the panel. Never throws — this runs on every 15s poll tick alongside the Stellar reads.
import { readPositions as defaultReadPositions } from './readPositions.js'
import { defaultMakePublicClient } from '../wallet/passkeyBase.js'
import { BASE_POOL_CATALOG } from '../config.js'

export async function loadBasePositions({ deps = {} } = {}) {
  const { readPositions = defaultReadPositions, makePublicClient = defaultMakePublicClient } = deps

  // No Base owner ever created (or address not yet persisted) -> nothing to read. Bail BEFORE
  // touching the network so a Stellar-only user's poll never fires a Base RPC call.
  const owner = localStorage.getItem('vf_base_owner')
  const account = localStorage.getItem('vf_base_owner_address')
  if (!owner || !account) return []

  try {
    const publicClient = makePublicClient()
    const positions = await readPositions({
      pools: BASE_POOL_CATALOG.map((p) => p.address),
      account,
      publicClient,
    })
    return positions.map((pos) => ({
      ...pos,
      poolName:
        BASE_POOL_CATALOG.find((p) => p.address.toLowerCase() === pos.pool.toLowerCase())?.name ||
        pos.pool,
    }))
  } catch {
    return []
  }
}

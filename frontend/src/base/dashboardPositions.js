// frontend/src/base/dashboardPositions.js
// Read-only Base positions for the unified dashboard. No signature, no ceremony: uses the
// PERSISTED owner address (vf_base_owner_address, written by wallet/passkeyBridge.js) — the
// passkey is only touched when the user actually withdraws (see app.jsx's Withdraw wiring).
// Fail-soft end to end: no owner yet, or any RPC error, -> [] and the dashboard renders without
// the panel. Never throws — this runs on every 15s poll tick alongside the Stellar reads.
import { readPositions as defaultReadPositions } from './readPositions.js'
import { BASE_POOL_CATALOG } from '../config.js'

export async function loadBasePositions({ deps = {} } = {}) {
  const { readPositions = defaultReadPositions, makePublicClient } = deps

  // No Base owner ever created (or address not yet persisted) -> nothing to read. Bail BEFORE
  // touching the network (and BEFORE the dynamic import below) so a Stellar-only user's poll
  // never fires a Base RPC call OR loads the ZeroDev/viem chain.
  const owner = localStorage.getItem('vf_base_owner')
  const account = localStorage.getItem('vf_base_owner_address')
  if (!owner || !account) return []

  try {
    // Dynamic: no top-level import of passkeyBase.js here (that pulled the whole ZeroDev/viem
    // chain into the eager main bundle for every user — proven via dist chunk grep). Reached
    // only once we already know a Base owner exists.
    const { defaultMakePublicClient } = await import('../wallet/passkeyBase.js')
    const publicClient = (makePublicClient || defaultMakePublicClient)()
    const positions = await readPositions({
      pools: BASE_POOL_CATALOG.map((p) => p.address),
      account,
      publicClient,
    })
    return positions.map((pos) => {
      const cat = BASE_POOL_CATALOG.find((p) => p.address.toLowerCase() === pos.pool.toLowerCase())
      // apy rides along so the dashboard's daily-earnings estimate can include Base pools
      // instead of silently treating cross-chain capital as idle.
      return { ...pos, poolName: cat?.name || pos.pool, apy: cat?.apy || 0 }
    })
  } catch {
    return []
  }
}

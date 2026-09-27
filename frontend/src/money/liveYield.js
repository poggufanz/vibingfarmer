// frontend/src/money/liveYield.js
// G2 follow-up: lift the P0 live-APY + PPS sparkline off the retired console onto the
// production My Money route. Reuses every P0 material, builds none: readSupplyAprBps
// (stellar/vaultReads.js, null on failure), the local PPS series (history/ppsHistory.js,
// recorded every poll by app.jsx's recordPpsSample), and the pure derivations
// (selectPpsWindow/trailingApyPct/ppsDisplayValues). Same controller/presenter split as
// money/activeGrant.js: this module loads raw facts with injected deps (never throws —
// every failure mode resolves to an unavailable view), components/money/LiveYieldCard.jsx
// derives windows and renders. No contract changes; KeeperZone/console untouched.
import { readSupplyAprBps } from '../stellar/vaultReads.js'
import { loadPpsSeries } from '../history/ppsHistory.js'
import {
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_BLEND_POOL_ADDRESS,
} from '../stellar/config.js'

/**
 * Load the production yield view-model. Fail-soft by contract: an APR RPC failure (or a
 * throwing mock) resolves to `{ state: 'unavailable' }`, never a throw and never a guessed
 * percent. The PPS series loader never throws by its own contract; a defensive catch keeps
 * a hostile storage returning [] instead of breaking the card. Deps injectable for tests.
 * `asOf` is when WE read the APR (the RPC carries no timestamp) — the card labels it
 * "updated …", never a chain fact.
 */
export async function loadLiveYield({
  poolAddress = SOROBAN_BLEND_POOL_ADDRESS,
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  nowMs = Date.now(),
  deps = {},
} = {}) {
  const { readApr = readSupplyAprBps, loadSeries = loadPpsSeries } = deps
  let aprBps = null
  try {
    aprBps = await readApr(poolAddress)
  } catch {
    aprBps = null
  }
  let series = []
  try {
    series = loadSeries(vaultAddress) ?? []
  } catch {
    series = []
  }
  if (!Array.isArray(series)) series = []
  const live =
    typeof aprBps === 'number' && Number.isFinite(aprBps) && aprBps >= 0
      ? { state: 'live', aprPct: aprBps / 100, asOf: nowMs }
      : { state: 'unavailable', aprPct: null, asOf: null }
  return { liveApr: live, series }
}

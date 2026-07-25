// backgroundAgent.worker.js
// Runs in a separate thread. Polls on intervals, posts findings to the main thread.
// Does NOT execute transactions — it detects + notifies; main thread handles execution. No
// transaction executor is ever imported here, by design (Pocket Crew "My money" Task 8: risk
// watch is observe-only, never auto-executing — see product truth: no legacy rule may
// autonomously move production funds). Pure fetch (DeFiLlama + the /api/search proxy) — no chain
// SDK in the worker. On-chain position reconciliation lives on the main thread (Stellar
// reconcilePositionsFromChain).

const INTERVALS = {
  facts: 10 * 60 * 1000, // 10 min — canonical protocol facts for the owner's real positions
  risk: 15 * 60 * 1000, // 15 min — security news scan
}

let config = null // { userAddress, activeVaults, supportedProtocols, thresholds }
let timers = []

self.onmessage = (e) => {
  const { type, payload } = e.data
  switch (type) {
    case 'INIT':
      config = payload
      startMonitoring()
      break
    case 'STOP':
      stopMonitoring()
      break
    case 'UPDATE_CONFIG':
      config = { ...config, ...payload }
      break
  }
}

function startMonitoring() {
  stopMonitoring()
  // Run each monitor immediately, then on interval. Each is independent — one crash never stops others.
  runFactsCheck()
  timers.push(setInterval(runFactsCheck, INTERVALS.facts))
  runRiskCheck()
  timers.push(setInterval(runRiskCheck, INTERVALS.risk))
}

function stopMonitoring() {
  timers.forEach(clearInterval)
  timers = []
}

// Position reconciliation is NOT a worker monitor — the main thread reads vault shares from
// Soroban (reconcilePositionsFromChain) on mount, on each sync tick, and after withdraws.

// ─── Monitor: canonical protocol facts (DeFiLlama) ─────────────────────────────
// Pocket Crew "My money" Task 8: this used to match `vault.protocol` against Ethereum-mainnet
// DeFiLlama pools (`chain === 'Ethereum'`) and, on a miss — which is EVERY real position, since
// this product has no live Ethereum venue (Stellar Autofarm -> Blend is the only real yield
// venue; Base pools are honest 1:1 custody proxies, never a yield source — see custody.js's
// header) — fell back to a HARDCODED per-protocol drawdown map (`{'aave-v3': -1.2, ...}`) to
// manufacture a DRAWDOWN_ALERT out of thin air, and proposed rebalancing into unaudited strangers'
// pools from that same unfiltered map. A missing fact reads 'unavailable', never a synthetic
// number — this monitor now looks up the REAL protocol slug for each active position (no chain
// filter — DeFiLlama's own `project` field is the match, not an assumption about which chain it
// lives on) and reports whatever it verifiably finds, or honestly nothing.
async function runFactsCheck() {
  if (!config) return
  try {
    const res = await fetch('https://yields.llama.fi/pools')
    const { data } = await res.json()
    for (const vault of config.activeVaults ?? []) {
      const pool = (data || []).find(
        (p) => String(p.project).toLowerCase() === String(vault.protocol).toLowerCase()
      )
      self.postMessage({
        type: 'RISK_FACT',
        payload: {
          vaultName: vault.name,
          vaultAddress: vault.address,
          protocol: vault.protocol,
          state: pool ? 'known' : 'unavailable',
          apy: pool ? pool.apy : null,
          tvlUsd: pool ? pool.tvlUsd : null,
          source: 'defillama',
          checkedAt: Date.now(),
        },
      })
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'facts', error: err.message } })
  }
}

// Monitor 3 (Reward Harvest) removed in v2 — the plain ERC-4626 MockVault has no on-chain
// rewards to harvest. Yield accrues as share-price appreciation, realized on withdraw.

// ─── Monitor 4: Risk Watcher (Tavily security news) ───────────────────────────
async function runRiskCheck() {
  if (config?.thresholds?.riskMonitoring === false) return
  try {
    for (const vault of config.activeVaults ?? []) {
      const query = `${vault.protocol} exploit hack vulnerability depeg 2026`
      // Server-side proxy — Tavily key stays on the server (see api/search.js).
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          max_results: 3,
          include_answer: true,
        }),
      })
      const data = await res.json()
      // Post raw findings — main thread asks Venice AI to classify severity. This is the ONLY
      // "recommendation" this worker ever produces — a search result for a human/AI reviewer to
      // weigh, never an instruction any code path executes automatically (riskWatchStore.js
      // records it, it never acts on it).
      self.postMessage({
        type: 'RISK_SCAN_RESULT',
        payload: {
          vaultName: vault.name,
          vaultAddress: vault.address,
          protocol: vault.protocol,
          searchAnswer: data.answer || '',
          sources: (data.results || []).map((r) => ({ title: r.title, url: r.url })),
          source: 'tavily',
          checkedAt: Date.now(),
          timestamp: Date.now(),
        },
      })
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'risk', error: err.message } })
  }
}

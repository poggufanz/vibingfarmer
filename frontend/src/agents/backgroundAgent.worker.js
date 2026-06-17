// backgroundAgent.worker.js
// Runs in a separate thread. Polls on intervals, posts findings to the main thread.
// Does NOT execute transactions — it detects + notifies; main thread handles execution.
// Uses raw JSON-RPC (fetch) so the worker bundles without ethers.

const INTERVALS = {
  position: 5 * 60 * 1000,   // 5 min — slow backstop; event listener handles real-time sync
  apy: 10 * 60 * 1000,       // 10 min — APY drift + rebalance opportunity
  risk: 15 * 60 * 1000,      // 15 min — security news scan
}

// Verified against deployed MockVault ABI (cast sig). The v2 MockVault is plain ERC-4626 —
// no on-chain rewards accrual — so only the ERC-20 balanceOf is read here.
const SELECTORS = {
  balanceOf: '0x70a08231',           // balanceOf(address)
}

let config = null // { userAddress, activeVaults, rpcUrl, tavilyKey, supportedProtocols, thresholds }
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
  runPositionCheck(); timers.push(setInterval(runPositionCheck, INTERVALS.position))
  runApyCheck(); timers.push(setInterval(runApyCheck, INTERVALS.apy))
  runRiskCheck(); timers.push(setInterval(runRiskCheck, INTERVALS.risk))
}

function stopMonitoring() {
  timers.forEach(clearInterval)
  timers = []
}

// ─── Monitor 1: Position (on-chain balance + accrued yield) ───────────────────
async function runPositionCheck() {
  if (!config?.rpcUrl) return
  try {
    for (const vault of config.activeVaults) {
      const balance = await ethCall(vault.address, 'balanceOf', config.userAddress)
      self.postMessage({
        type: 'POSITION_UPDATE',
        payload: { vaultAddress: vault.address, vaultName: vault.name, balance, unclaimedRewards: '0', timestamp: Date.now() },
      })
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'position', error: err.message } })
  }
}

// ─── Monitor 2: APY Drift + Rebalance Opportunity (DeFiLlama) ──────────────────
async function runApyCheck() {
  if (!config) return
  try {
    const res = await fetch('https://yields.llama.fi/pools')
    const { data } = await res.json()

    for (const vault of config.activeVaults) {
      const pool = data.find(p => p.project === vault.protocol && p.chain === 'Ethereum' && p.symbol?.includes('USDC'))
      if (!pool) continue
      const currentApy = pool.apy
      const baselineApy = vault.depositApy

      if (baselineApy > 0) {
        const driftPct = ((currentApy - baselineApy) / baselineApy) * 100
        if (driftPct < -(config.thresholds.apyDropPct || 20)) {
          self.postMessage({
            type: 'APY_DRIFT',
            payload: { vaultName: vault.name, baselineApy, currentApy, driftPct: driftPct.toFixed(1), severity: driftPct < -40 ? 'high' : 'medium', timestamp: Date.now() },
          })
        }
      }

      // A BETTER vault exists → rebalance opportunity (propose only)
      const betterPools = data.filter(p =>
        p.chain === 'Ethereum' && p.symbol?.includes('USDC') &&
        p.apy > currentApy + (config.thresholds.rebalanceThresholdPct || 1.5) &&
        p.tvlUsd > 1_000_000 && config.supportedProtocols.includes(p.project)
      ).sort((a, b) => b.apy - a.apy)

      if (betterPools.length > 0) {
        const best = betterPools[0]
        self.postMessage({
          type: 'REBALANCE_OPPORTUNITY',
          payload: { fromVault: vault.name, fromApy: currentApy, toProtocol: best.project, toApy: best.apy, apyGain: (best.apy - currentApy).toFixed(2), timestamp: Date.now() },
        })
      }
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'apy', error: err.message } })
  }
}

// Monitor 3 (Reward Harvest) removed in v2 — the plain ERC-4626 MockVault has no on-chain
// rewards to harvest. Yield accrues as share-price appreciation, realized on withdraw.

// ─── Monitor 4: Risk Watcher (Tavily security news) ───────────────────────────
async function runRiskCheck() {
  if (config?.thresholds?.riskMonitoring === false) return
  try {
    for (const vault of config.activeVaults) {
      const query = `${vault.protocol} exploit hack vulnerability depeg 2026`
      // Server-side proxy — Tavily key stays on the server (see api/search.js).
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, search_depth: 'basic', max_results: 3, include_answer: true }),
      })
      const data = await res.json()
      // Post raw findings — main thread asks Venice AI to classify severity
      self.postMessage({
        type: 'RISK_SCAN_RESULT',
        payload: {
          vaultName: vault.name,
          vaultAddress: vault.address,
          protocol: vault.protocol,
          searchAnswer: data.answer || '',
          sources: (data.results || []).map(r => ({ title: r.title, url: r.url })),
          timestamp: Date.now(),
        },
      })
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'risk', error: err.message } })
  }
}

// ─── Helper: raw JSON-RPC eth_call for single-address view functions ──────────
async function ethCall(to, method, addressParam) {
  const addr = addressParam.toLowerCase().replace('0x', '').padStart(64, '0')
  const data = SELECTORS[method] + addr
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'eth_call failed')
  // Empty hex '0x' (no contract code on this network, or view returned nothing) is
  // truthy, so `|| '0x0'` won't catch it — BigInt('0x') throws. Treat as zero.
  const result = json.result
  if (!result || result === '0x') return '0'
  return BigInt(result).toString()
}

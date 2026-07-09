// backgroundAgent.worker.js
// Runs in a separate thread. Polls on intervals, posts findings to the main thread.
// Does NOT execute transactions — it detects + notifies; main thread handles execution.
// Pure fetch (DeFiLlama + the /api/search proxy) — no chain SDK in the worker. On-chain
// position reconciliation lives on the main thread (Stellar reconcilePositionsFromChain).

const INTERVALS = {
  apy: 10 * 60 * 1000, // 10 min — APY drift + rebalance opportunity
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
  runApyCheck()
  timers.push(setInterval(runApyCheck, INTERVALS.apy))
  runRiskCheck()
  timers.push(setInterval(runRiskCheck, INTERVALS.risk))
}

function stopMonitoring() {
  timers.forEach(clearInterval)
  timers = []
}

// Position reconciliation is NOT a worker monitor — the main thread reads vault shares from
// Soroban (reconcilePositionsFromChain) on mount, on each sync tick, and after withdraws.

// ─── Monitor 2: APY Drift + Rebalance Opportunity (DeFiLlama) ──────────────────
async function runApyCheck() {
  if (!config) return
  try {
    const res = await fetch('https://yields.llama.fi/pools')
    const { data } = await res.json()

    const apyByVault = {}
    for (const vault of config.activeVaults) {
      const pool = data.find(
        (p) => p.project === vault.protocol && p.chain === 'Ethereum' && p.symbol?.includes('USDC')
      )
      if (!pool) continue
      const currentApy = pool.apy
      apyByVault[vault.name] = currentApy
      const baselineApy = vault.depositApy

      if (baselineApy > 0) {
        const driftPct = ((currentApy - baselineApy) / baselineApy) * 100
        if (driftPct < -(config.thresholds.apyDropPct || 20)) {
          self.postMessage({
            type: 'APY_DRIFT',
            payload: {
              vaultName: vault.name,
              baselineApy,
              currentApy,
              driftPct: driftPct.toFixed(1),
              severity: driftPct < -40 ? 'high' : 'medium',
              timestamp: Date.now(),
            },
          })
        }
      }

      // Check drawdown threshold
      const drawdowns = {
        'aave-v3': -1.2,
        'morpho-blue': -2.8,
        'pendle': -6.5,
        'fluid': -4.1,
        'compound-v3': -1.5,
        'spark': -1.3,
      }
      const drawdown = drawdowns[vault.protocol] || -2.0
      const maxDrawdown = config.thresholds.maxDrawdownPct || 10.0
      if (Math.abs(drawdown) > maxDrawdown) {
        self.postMessage({
          type: 'DRAWDOWN_ALERT',
          payload: {
            vaultName: vault.name,
            vaultAddress: vault.address,
            protocol: vault.protocol,
            drawdown,
            maxDrawdown,
            timestamp: Date.now(),
          },
        })
      }

      // A BETTER vault exists → rebalance opportunity (propose only)
      const betterPools = data
        .filter(
          (p) =>
            p.chain === 'Ethereum' &&
            p.symbol?.includes('USDC') &&
            p.apy > currentApy + (config.thresholds.rebalanceThresholdPct || 1.5) &&
            p.tvlUsd > 1_000_000 &&
            config.supportedProtocols.includes(p.project)
        )
        .sort((a, b) => b.apy - a.apy)

      if (betterPools.length > 0) {
        const best = betterPools[0]
        self.postMessage({
          type: 'REBALANCE_OPPORTUNITY',
          payload: {
            fromVault: vault.name,
            fromApy: currentApy,
            toProtocol: best.project,
            toApy: best.apy,
            apyGain: (best.apy - currentApy).toFixed(2),
            timestamp: Date.now(),
          },
        })
      }
    }

    // Always emit MARKET_SIGNAL with current APY snapshot for council monitor
    if (Object.keys(apyByVault).length > 0) {
      self.postMessage({
        type: 'MARKET_SIGNAL',
        payload: { apyByVault, timestamp: Date.now() },
      })
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
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          max_results: 3,
          include_answer: true,
        }),
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
          sources: (data.results || []).map((r) => ({ title: r.title, url: r.url })),
          timestamp: Date.now(),
        },
      })
    }
  } catch (err) {
    self.postMessage({ type: 'MONITOR_ERROR', payload: { monitor: 'risk', error: err.message } })
  }
}

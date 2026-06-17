// frontend/src/strategy/fetchDag.js
// EvoAgentX-inspired DAG fetch layer for the /strategy wizard.
// Independent fetch nodes run together in one Promise.allSettled layer; derived
// nodes run once their deps resolve. Each node is isolated — a thrown/rejected
// node yields null and never aborts siblings. Pure orchestration: nodes inject
// their own side-effectful fetchers, so this file has no network/storage imports.
//
// Why a DAG and not a flat Promise.all: pools, gas, positions and market are
// genuinely independent (one concurrent layer), but on-chain signals depend on
// BOTH market context and gas, so it must run in a second layer. A flat Promise.all
// can't express that ordering; the layered runner can, and stays parallel where it
// can (4 fetches at ~max(latency) instead of sum).

import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { reconcilePositionsFromChain } from '../positionsStore.js'
import { fetchGasSnapshot } from './gasSnapshot.js'
import { deriveSignals } from './mdp.js'

/**
 * @typedef {Object} FetchNode
 * @property {string} id
 * @property {string[]} deps                     // node ids this one waits for
 * @property {(ctx: Object) => Promise<any>} run // ctx = base inputs + resolved dep values
 */

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
}

/**
 * Execute a DAG of fetch nodes layer by layer. Each layer = every not-yet-run
 * node whose deps are all resolved; they run concurrently via Promise.allSettled.
 * A node's result is its resolved value, or null on failure / unsatisfiable deps.
 *
 * @param {FetchNode[]} nodes
 * @param {Object} [base]                  // inputs every node.run receives in ctx
 * @param {(ev:{id:string,phase:'start'|'end',ms?:number,ok?:boolean})=>void} [onEvent]
 * @returns {Promise<{ results:Object, timings:Object, wallMs:number }>}
 */
export async function runFetchDag(nodes, base = {}, onEvent) {
  const results = {}
  const timings = {}
  const done = new Set()
  const wallStart = now()

  let remaining = nodes.slice()
  while (remaining.length) {
    const ready = remaining.filter((n) => n.deps.every((d) => done.has(d)))

    if (ready.length === 0) {
      // No node can advance (missing/cyclic dep) — resolve the rest as null
      // rather than hang the wizard.
      for (const n of remaining) { results[n.id] = null; done.add(n.id) }
      break
    }

    await Promise.allSettled(ready.map(async (n) => {
      const start = now()
      onEvent?.({ id: n.id, phase: 'start' })
      try {
        const ctx = { ...base }
        for (const d of n.deps) ctx[d] = results[d]
        results[n.id] = await n.run(ctx)
        timings[n.id] = now() - start
        onEvent?.({ id: n.id, phase: 'end', ms: timings[n.id], ok: true })
      } catch {
        results[n.id] = null
        timings[n.id] = now() - start
        onEvent?.({ id: n.id, phase: 'end', ms: timings[n.id], ok: false })
      }
    }))

    for (const n of ready) done.add(n.id)
    remaining = remaining.filter((n) => !done.has(n.id))
  }

  return { results, timings, wallMs: now() - wallStart }
}

/**
 * Build and run the concrete /strategy fetch DAG.
 *
 * Layer 0 (independent, concurrent): skill, pools, gas, positions, market.
 * Layer 1 (derived): signals = deriveSignals(market, gas).
 *
 * loadVaultSkill and fetchMarketContext are injected (they live in venice.js) to
 * keep this module free of a circular import back into the strategy axis.
 *
 * @param {Object} p
 * @param {string} p.riskLevel
 * @param {string|null} p.address                // connected wallet, or null pre-connect
 * @param {boolean} p.useStaticVaults
 * @param {boolean} p.marketContextEnabled
 * @param {() => Promise<{content:string,source:string}>} p.loadVaultSkill
 * @param {(riskLevel:string) => Promise<string|null>} p.fetchMarketContext
 * @param {(ev:Object)=>void} [p.onEvent]
 * @returns {Promise<{ skill:any, pools:any, gas:any, positions:any, marketContext:any, signals:any, timings:Object, wallMs:number }>}
 */
export async function runStrategyFetchDag({
  riskLevel, address, useStaticVaults, marketContextEnabled,
  loadVaultSkill, fetchMarketContext, onEvent,
}) {
  const nodes = [
    { id: 'skill', deps: [], run: () => loadVaultSkill() },
    { id: 'pools', deps: [], run: () => (useStaticVaults ? null : fetchDeFiLlamaVaults()) },
    { id: 'gas', deps: [], run: () => fetchGasSnapshot() },
    { id: 'positions', deps: [], run: () => (address ? reconcilePositionsFromChain(address) : null) },
    { id: 'market', deps: [], run: () => (marketContextEnabled ? fetchMarketContext(riskLevel) : null) },
    { id: 'signals', deps: ['market', 'gas'], run: (ctx) => deriveSignals(ctx.market, ctx.gas) },
  ]

  const { results, timings, wallMs } = await runFetchDag(nodes, {}, onEvent)
  return {
    skill: results.skill,
    pools: results.pools,
    gas: results.gas,
    positions: results.positions,
    marketContext: results.market,
    signals: results.signals,
    timings,
    wallMs,
  }
}

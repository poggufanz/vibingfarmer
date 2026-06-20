// frontend/src/strategy/riskCouncil.js
// Pure orchestrator for the Phase-1 risk pipeline: live context → honest VaR/CVaR
// distribution → bounded council debate → one-sentence human gate. The proposer's
// cited numbers are taken straight from the sim output, so an honest run never trips
// the Validator. WAJIB BERHENTI: this function is given NO executor and never moves
// funds — it returns awaitingHuman:true / executed:false and hands a permission
// object to the UI. Execution is a separate, explicit confirmPermission(...) call.
// This is the single seam the "Risk & Council" panel consumes.

import { fuseRiskParams, runRiskSimulation } from './riskParams.js'
import { councilLoop } from './councilLoop.js'
import { buildPermission } from './permissionLayer.js'

/**
 * @param {{basket:Array, riskTier?:string, context?:object, deepRequested?:boolean, proposal:{allocation?:any, payload?:any}}} input
 * @param {{decide?:Function, summarize?:Function, maxIter?:number, runs?:number, horizonDays?:number, seed?:number}} [deps]
 * @returns {Promise<{sim:object, council:object, permission:object, proposalCited:{cvar95:number}, awaitingHuman:true, executed:false}>}
 */
export async function runRiskCouncil(input, deps = {}) {
  const {
    basket,
    riskTier = 'moderate',
    context = {},
    deepRequested = false,
    proposal = {},
  } = input
  const { decide, summarize, maxIter, runs, horizonDays, seed } = deps

  // 1. Fuse params + run the honest-spread simulation.
  const fused = fuseRiskParams({ context, deepRequested })
  const sim = runRiskSimulation(basket, fused, { runs, horizonDays, seed })

  // 2. The proposer cites the sim's own numbers (validator stays consistent on honest runs).
  const proposalCited = { cvar95: sim.metrics.cvar95 }
  const fullProposal = { ...proposal, citedNumbers: proposalCited }

  // 3. Debate (deterministic short-circuit; bounded AI tie-break only on ambiguity).
  const council = await councilLoop(
    { metrics: sim.metrics, proposal: fullProposal, riskTier },
    { decide, maxIter }
  )

  // 4. One-sentence human gate. We STOP here — no execution on this path.
  const permission = await buildPermission(council, { metrics: sim.metrics, riskTier, summarize })

  return { sim, council, permission, proposalCited, awaitingHuman: true, executed: false }
}

// frontend/src/strategy/monitorLoop.js
// The NEVER-STOP cycle spine (autoresearch / Karpathy). Unbounded loop:
// fetch state → gate → simulate → council → execute on keep → reflect → journal
// → sleep → repeat. Cardinal rule: a single error NEVER stops the loop — every
// cycle is wrapped so a throw becomes a journaled `crash` and the next cycle runs.
// All collaborators injected → pure orchestration, no React/network here.

/**
 * @param {Object} deps
 * @param {() => Promise<Object>} deps.getState                                        // mdp StrategyState
 * @param {(proposed:Array, state:Object) => {allocations:Array, violations:string[]}} deps.runGates
 * @param {(state:Object, idea:Object) => {passed:boolean, blockedBy:string|null, reason:string|null}} [deps.gates]  // pure fast-fail gates — FIRST defense, no AI/network
 * @param {(allocations:Array, state:Object) => Object} deps.simulate                   // mdp.scoreReward
 * @param {(input:Object) => Promise<Object>} deps.council                              // councilVerdict (async)
 * @param {(idea:Object, allocations:Array) => Promise<string>} deps.execute            // → txHash
 * @param {(cycle:Object) => void} deps.reflect                                         // ACE reflector
 * @param {{saveCycle:(row:Object)=>void}} deps.journal
 * @param {(ctx:Object)=>void} [deps.recordDecision]                                    // ACC decision log — keep/discard only
 * @param {(ctx:Object)=>void} [deps.curate]   // ACE Curator — grow on failure / ai-conflict only
 * @param {number} [deps.heartbeatMs]
 * @param {(phase:string)=>void} [deps.onPhase]  // live pipeline progress for UI — never blocks the loop
 */
export function createMonitorLoop({ getState, runGates, gates = () => ({ passed: true }), simulate, council, execute, reflect, journal, recordDecision = () => {}, curate = () => {}, heartbeatMs = 60_000, onPhase }) {
  let timer = null
  let cycle = 0
  let running = false
  let nextTickAt = null

  // Phase reporting is observability only — a throwing listener must not kill a cycle.
  const phase = (p) => { try { onPhase?.(p) } catch { /* ignore */ } }

  // Decision capture is observability — a throwing recorder must not kill a cycle.
  const record = (ctx) => { try { recordDecision(ctx) } catch { /* ignore */ } }

  // Curation is fire-and-forget learning — a throwing/slow curator must never kill a cycle.
  const grow = (ctx) => { try { curate(ctx) } catch { /* ignore */ } }

  async function runCycle(idea) {
    cycle += 1
    try {
      phase('observe')
      const state = await getState()

      if (!idea) {
        journal.saveCycle({ cycle, phase: 'observe', verdict: 'idle', turbulence: state.market.turbulence })
        return
      }

      // FIRST line of defense — pure math, no AI, no network. A blocked gate
      // sleeps the loop here, before simulate/council, so no Venice credit burns.
      phase('gate')
      const gate = gates(state, idea)
      if (!gate.passed) {
        journal.saveCycle({ cycle, phase: 'gate', verdict: 'gated', gate: gate.blockedBy, reason: gate.reason, turbulence: state.market.turbulence })
        return
      }

      const { allocations, violations } = runGates(idea.proposed, state)
      phase('simulate')
      const projectedReward = simulate(allocations, state)
      const currentReward = simulate(idea.currentAllocations || [], state)
      phase('council')
      const v = await council({
        action: { kind: idea.kind, violations, apyGain: idea.apyGain },
        currentReward, projectedReward, state, estGasUsdc: idea.estGasUsdc,
      })

      if (v.verdict !== 'keep') {
        record({ cycle, idea, state, verdict: v })
        journal.saveCycle({ cycle, phase: 'evaluate', verdict: 'discard', score: projectedReward.riskAdjustedScore, confidence: v.confidence, reason: v.reason, citedRules: v.citedRules, turbulence: state.market.turbulence })
        return
      }

      // keep → execute, then reflect on the real outcome (ACE).
      try {
        record({ cycle, idea, state, verdict: v })
        phase('execute')
        const txHash = await execute(idea, allocations)
        phase('reflect')
        reflect({ verdict: 'keep', citedRules: v.citedRules, outcome: 'success' })
        journal.saveCycle({ cycle, phase: 'execute', verdict: 'keep', score: projectedReward.riskAdjustedScore, confidence: v.confidence, citedRules: v.citedRules, txHash, turbulence: state.market.turbulence })
        if (v.resolvedBy === 'ai-conflict') grow({ role: v.citedRules[0]?.split('-')[0] || 'yield', outcome: 'success', resolvedBy: v.resolvedBy, citedRules: v.citedRules, reason: v.reason, turbulence: state.market.turbulence })
      } catch (execErr) {
        reflect({ verdict: 'keep', citedRules: v.citedRules, outcome: 'failure' })
        journal.saveCycle({ cycle, phase: 'crash', verdict: 'crash', error: execErr?.message || String(execErr), citedRules: v.citedRules })
        grow({ role: v.citedRules[0]?.split('-')[0] || 'yield', outcome: 'failure', resolvedBy: v.resolvedBy, citedRules: v.citedRules, reason: execErr?.message || String(execErr), turbulence: state.market.turbulence })
      }
    } catch (err) {
      // Crash recovery — autoresearch logs the crash and moves on. The loop lives.
      journal.saveCycle({ cycle, phase: 'crash', verdict: 'crash', error: err?.message || String(err) })
    } finally {
      phase('sleep')
    }
  }

  return {
    start() {
      if (running) return
      running = true
      nextTickAt = Date.now() + heartbeatMs
      runCycle(null)
      timer = setInterval(() => {
        nextTickAt = Date.now() + heartbeatMs
        runCycle(null)
      }, heartbeatMs)
    },
    stop() {
      running = false
      nextTickAt = null
      if (timer) { clearInterval(timer); timer = null }
    },
    submitIdea(idea) { return runCycle(idea) },
    getCycle() { return cycle },
    isRunning() { return running },
    getNextTickAt() { return nextTickAt },
    getHeartbeatMs() { return heartbeatMs },
  }
}
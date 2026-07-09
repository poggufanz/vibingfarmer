import { WorkerAgent, makeAgentId } from './worker.js'
import { generateAgentSkills } from './venice.js'
import { saveSkill } from './skills.js'
import { authorizeAndFundAgent, deployAgentForSession } from './stellar/agentSetup.js'
import { readTokenBalance } from './stellar/agentDeposit.js'
import { SOROBAN_TOKEN_ADDRESS, SOROBAN_DECIMALS } from './stellar/config.js'

// Scope window for a dispatch: agents may deposit up to their allocation, within the period.
const PERIOD_DURATION = 86400
const SCOPE_TTL_SECONDS = 3600
const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1 VFUSD = 10_000_000 (7-dp)
// Gap between serial worker dispatches — keeps the relay off its per-IP rate limit.
const DISPATCH_INTERVAL_MS = 2000

/**
 * Orchestrator Agent — receives the AI plan, authorizes + funds each agent on Stellar (one
 * user-signed step per agent via the wallet kit), then dispatches Worker Agents that each run a
 * gasless session-key deposit through the relay.
 */
export class OrchestratorAgent {
  /**
   * @param {object} config
   * @param {string} config.user - user G... address
   * @param {string|null} config.veniceAuth - base64 SIWE header for Venice x402
   * @param {string|null} config.devApiKey - DeepSeek API key for dev mode
   * @param {string} config.sessionId
   * @param {function} config.onEvent - (eventName, data) => void
   */
  constructor({ user, veniceAuth, devApiKey, sessionId, onEvent }) {
    this.user = user
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.onEvent = onEvent || (() => {})
    this.sessionId = sessionId || `session-${Date.now()}`
  }

  /**
   * Execute full orchestration: generate skills → authorize+fund each agent → dispatch → aggregate.
   * @param {object} strategy - { vaults: [{ address, allocation }], ... }
   * @param {number} totalAmount - total asset amount (human-readable VFUSD)
   * @returns {Promise<{completed:number, failed:number, results:Array, sessionId:string}>}
   */
  async dispatch(strategy, totalAmount) {
    const expiry = Math.floor(Date.now() / 1000) + SCOPE_TTL_SECONDS
    const vaultPlans = strategy.vaults.map((v, i) => ({
      index: i,
      agentId: makeAgentId(i, this.sessionId),
      vault: v.address,
      protocolSlug: v.protocolSlug || null,
      eligibilityToken: v.eligibilityToken || null,
      amountVfusd: totalAmount * v.allocation,
      amountUnits: BigInt(Math.floor(totalAmount * v.allocation * BASE_UNIT)),
    }))

    this.onEvent('orchestrator-started', {
      sessionId: this.sessionId,
      totalAgents: vaultPlans.length,
      vaults: vaultPlans.map((p) => p.vault),
    })

    // Generate skills for all agents (parallel).
    this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'pending' })
    const skillsResults = await Promise.allSettled(
      vaultPlans.map((plan) =>
        generateAgentSkills({
          agentId: plan.agentId,
          vault: plan.vault,
          amount: plan.amountVfusd,
          veniceAuth: this.veniceAuth,
          devApiKey: this.devApiKey,
        }).then((skill) => {
          saveSkill(plan.agentId, skill)
          return { agentId: plan.agentId, skill }
        })
      )
    )
    this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'done' })

    // Surface skill-gen failures (e.g. Venice 401/402) — fallback still lets the agent run.
    skillsResults.forEach((r, i) => {
      const skill = r.value?.skill
      if (skill?.error) {
        this.onEvent('skill-gen-failed', { agentId: vaultPlans[i].agentId, error: skill.error })
      }
    })

    const totalUnits = vaultPlans.reduce((acc, p) => acc + p.amountUnits, 0n)

    // Pre-flight: block BEFORE any wallet popup if the asset balance can't cover the total.
    const bal = await readTokenBalance(this.user)
    if (bal != null && bal < totalUnits) {
      const msg = `Insufficient VFUSD: have ${(Number(bal) / BASE_UNIT).toFixed(2)}, need ${(Number(totalUnits) / BASE_UNIT).toFixed(2)} for this deposit.`
      this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'error', error: msg })
      throw new Error(msg)
    }

    // Option B (fresh agent per run): each worker gets its OWN agent_account instance, deployed
    // below with that worker's fresh session-key pubkey as the constructor-pinned signer. The
    // shared pre-deployed demo agent only accepts ITS constructor-pinned key — depositing with
    // any fresh key failed __check_auth ed25519 verification (Error(Auth, InvalidAction)).
    const workers = vaultPlans.map(
      (p) =>
        new WorkerAgent({
          agentId: p.agentId,
          user: this.user,
          vault: p.vault,
          amount: p.amountUnits,
          sessionId: this.sessionId,
          onEvent: this.onEvent,
          agentAddress: null, // set right after the per-worker deploy below
          eligibilityToken: p.eligibilityToken,
        })
    )

    // Per agent, three user-signed txs (no EIP-5792 batch — the wallet kit signs each): deploy
    // the agent account pinning the session key, registry-authorize the scope, fund the agent.
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
    try {
      for (const w of workers) {
        await w.setupKey() // ed25519 session key (the on-chain agent signer)
        // Deploy BEFORE authorize/fund — both need the fresh agent's address. User-signed and
        // user-paid: the relay's allowlist only fee-bumps vault-deposit invokes, never a deploy.
        w.agentAddress = await deployAgentForSession({
          owner: this.user,
          sessionKey: w.sessionKey,
          cap: w.amount,
          periodDuration: PERIOD_DURATION,
          expiry,
        })
        this.onEvent('AgentDeployed', {
          agentId: w.agentId,
          agent: w.agentAddress,
          signer: w.sessionKey.publicKey,
        })
        await authorizeAndFundAgent({
          owner: this.user,
          agentAddress: w.agentAddress,
          vault: w.vault,
          amount: w.amount,
          capPerPeriod: w.amount,
          periodDuration: PERIOD_DURATION,
          expiry,
        })
        w.scopeAuthorized = true
        this.onEvent('AgentScopeAuthorized', {
          agentId: w.agentId,
          agent: w.agentAddress,
          vault: w.vault,
          token: SOROBAN_TOKEN_ADDRESS,
          capPerPeriod: w.amount,
          periodDuration: PERIOD_DURATION,
          expiry,
          authorized: true,
        })
      }
    } catch (err) {
      this.onEvent('orchestrator-step', {
        step: 'authorizing-scope',
        status: 'error',
        error: err.message,
      })
      throw err
    }
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'done' })

    // Dispatch workers SERIALLY — one completes before the next starts; the gap keeps the relay
    // off its per-IP rate limit. Promise.allSettled-equivalent: a thrown worker is captured, not
    // propagated, so one agent's failure never aborts the others.
    this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'pending' })
    const workerResults = []
    for (let i = 0; i < workers.length; i++) {
      try {
        const res = await workers[i].execute()
        workerResults.push({ status: 'fulfilled', value: res })
      } catch (e) {
        workerResults.push({ status: 'rejected', reason: e })
      }
      if (i < workers.length - 1) await new Promise((r) => setTimeout(r, DISPATCH_INTERVAL_MS))
    }
    this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'done' })

    const results = workerResults.map((r, i) => ({
      agentId: vaultPlans[i].agentId,
      vault: vaultPlans[i].vault,
      success: r.status === 'fulfilled' && r.value?.success,
      txHash: r.value?.txHash,
      error: r.reason?.message || r.value?.error,
    }))

    const completed = results.filter((r) => r.success).length
    const failed = results.length - completed

    this.onEvent('orchestrator-completed', {
      sessionId: this.sessionId,
      completed,
      failed,
      results,
    })

    return { completed, failed, results, sessionId: this.sessionId }
  }
}

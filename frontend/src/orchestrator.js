import { WorkerAgent, makeAgentId, makePlanId } from './worker.js'
import { generateAgentSkills } from './venice.js'
import { saveSkill } from './skills.js'
import { batchCalls, readUsdcBalance } from './wallet.js'
import { buildAuthorizeSessionKeyCall } from './relay.js'
import { USDC_SEPOLIA } from './config.js'

// Scope window for a dispatch: agents may deposit up to their allocation, once, within the hour.
const PERIOD_DURATION = 86400
const SCOPE_TTL_SECONDS = 3600
// Gap between serial worker dispatches — keeps the 1Shot relay off its rate limit so it
// never sheds a request (429/503) and forces the user-signed MetaMask fallback to fire.
const DISPATCH_INTERVAL_MS = 2000

/**
 * Orchestrator Agent — receives Venice plan, dispatches Worker Agents in parallel.
 */
export class OrchestratorAgent {
  /**
   * @param {object} config
   * @param {string} config.user - user address
   * @param {string} config.permissionContext - from ERC-7715
   * @param {string|null} config.veniceAuth - base64 SIWE header for Venice x402
   * @param {string|null} config.devApiKey - DeepSeek API key for dev mode
   * @param {function} config.onEvent - (eventName, data) => void
   */
  constructor({
    user,
    permissionContext,
    veniceAuth,
    devApiKey,
    sessionId,
    onEvent,
    sessionPassphrase,
  }) {
    this.user = user
    this.permissionContext = permissionContext
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.onEvent = onEvent || (() => {})
    this.sessionId = sessionId || `session-${Date.now()}`
    this.sessionPassphrase = sessionPassphrase || null
  }

  /**
   * Execute full orchestration: generate skills → dispatch parallel workers → aggregate.
   * @param {object} strategy - from generateStrategy(): { vaults: [{ address, allocation }], ... }
   * @param {number} totalAmount - total USDC amount (human-readable)
   * @returns {Promise<{completed: number, failed: number, results: Array}>}
   */
  async dispatch(strategy, totalAmount) {
    const planId = makePlanId(this.sessionId)
    const expiry = Math.floor(Date.now() / 1000) + SCOPE_TTL_SECONDS
    const vaultPlans = strategy.vaults.map((v, i) => ({
      index: i,
      agentId: makeAgentId(i, this.sessionId),
      vault: v.address,
      amountUSDC: totalAmount * v.allocation,
      amountUnits: BigInt(Math.floor(totalAmount * v.allocation * 1e6)),
    }))

    this.onEvent('orchestrator-started', {
      sessionId: this.sessionId,
      totalAgents: vaultPlans.length,
      vaults: vaultPlans.map((p) => p.vault),
    })

    // Generate skills for all agents (parallel)
    this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'pending' })
    const skillsResults = await Promise.allSettled(
      vaultPlans.map((plan) =>
        generateAgentSkills({
          agentId: plan.agentId,
          vault: plan.vault,
          amount: plan.amountUSDC,
          veniceAuth: this.veniceAuth,
          devApiKey: this.devApiKey,
        }).then((skill) => {
          saveSkill(plan.agentId, skill)
          return { agentId: plan.agentId, skill }
        })
      )
    )
    this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'done' })

    // Surface skill-gen failures (e.g. Venice 401/402) — fallback still lets the
    // agent run, but the user should see the AI call didn't actually happen.
    skillsResults.forEach((r, i) => {
      const skill = r.value?.skill
      if (skill?.error) {
        this.onEvent('skill-gen-failed', { agentId: vaultPlans[i].agentId, error: skill.error })
      }
    })

    // Scope setup (EIP-5792): ONE user popup batches one AgentRegistry.authorizeSessionKey per
    // worker key. No USDC approve — funding now flows through the ERC-7715 AP redeem (USDC is
    // pushed into the depositor, then depositHeld deposits it; no transferFrom allowance needed).
    // Each worker generates its key first so its address is known before we batch the grants.
    // Deposits are submitted later by each worker (EIP-712 signed) — no further popup, since
    // authorization is the signature, not msg.sender.
    const totalUnits = vaultPlans.reduce((acc, p) => acc + p.amountUnits, 0n)

    // Pre-flight: block the deposit BEFORE the approve popup if USDC balance can't cover it.
    // The depositor's transferFrom would revert mid-flight otherwise — wasting a signature and
    // (pre-verification) seeding a phantom position. Fail fast with an actionable message.
    const usdcBal = await readUsdcBalance(this.user)
    if (usdcBal != null && usdcBal < totalUnits) {
      const msg = `Insufficient USDC: have ${(Number(usdcBal) / 1e6).toFixed(2)}, need ${(Number(totalUnits) / 1e6).toFixed(2)} for this deposit.`
      this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'error', error: msg })
      throw new Error(msg)
    }

    const workers = vaultPlans.map(
      (p) =>
        new WorkerAgent({
          agentId: p.agentId,
          user: this.user,
          vault: p.vault,
          amount: p.amountUnits,
          sessionId: this.sessionId,
          onEvent: this.onEvent,
          planId,
          step: p.index,
          capPerPeriod: p.amountUnits,
          periodDuration: PERIOD_DURATION,
          expiry,
          sessionPassphrase: this.sessionPassphrase,
          // The ONE ERC-7715 AP (granted up-front by the user). Each worker redeems its slice into
          // the depositor, then deposits the now-held USDC (depositHeld) — no per-worker allowance.
          permissionContext: this.permissionContext,
        })
    )

    // Generate every worker key up-front (the on-chain agent identities to authorize).
    await Promise.all(workers.map((w) => w.setupKey()))

    let scopeAuthorized = false
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
    const calls = workers.map((w) =>
      buildAuthorizeSessionKeyCall({
        agent: w.keyAddress,
        vault: w.vault,
        token: USDC_SEPOLIA,
        capPerPeriod: w.capPerPeriod,
        periodDuration: PERIOD_DURATION,
        expiry,
      })
    )
    try {
      const batchHash = await batchCalls(calls)
      if (batchHash) scopeAuthorized = true
      // else: wallet lacks EIP-5792 → each worker self-authorizes its own key (worker Step 1).
    } catch (err) {
      this.onEvent('orchestrator-step', {
        step: 'authorizing-scope',
        status: 'error',
        error: err.message,
      })
      throw err
    }
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'done' })
    workers.forEach((w) => {
      w.scopeAuthorized = scopeAuthorized
    })

    // Surface each authorized scope so the UI can show a single-source permission summary
    // (cap + max-at-risk) and a Revoke button keyed by the worker's on-chain agent address.
    workers.forEach((w, i) =>
      this.onEvent('AgentScopeAuthorized', {
        agentId: vaultPlans[i].agentId,
        agent: w.keyAddress,
        vault: w.vault,
        token: USDC_SEPOLIA,
        capPerPeriod: w.capPerPeriod,
        periodDuration: PERIOD_DURATION,
        expiry,
        authorized: scopeAuthorized,
      })
    )

    // ── A2A coordination: orchestrator redelegates a scoped subset to each worker ──
    // Real ERC-7710 redelegation chain (user root → orchestrator → workers), the on-chain
    // proof of agent-to-agent coordination. Best-effort: any failure (missing orchestrator
    // key, network, unsupported API) silently falls back to existing direct execution.
    // redelegation.js is loaded lazily so a SAK load issue can never break orchestration.
    let workerRedelegations = null
    try {
      const { createOrchestratorAccount, createWorkerRedelegations } =
        await import('./redelegation.js')
      const orchestratorSmartAccount = await createOrchestratorAccount()
      const workerDelegates = vaultPlans.map((p) => ({
        workerId: p.index + 1,
        address: p.vault, // per-worker delegate identity (distinct vault)
        allocationUsdc: p.amountUSDC,
        vaultAddress: p.vault,
      }))
      workerRedelegations = await createWorkerRedelegations({
        orchestratorSmartAccount,
        rootDelegation: this.permissionContext?.rootDelegation || this.permissionContext,
        workers: workerDelegates,
      })
      workerRedelegations.forEach((rd) =>
        this.onEvent('RedelegationCreated', {
          agentId: vaultPlans[rd.workerId - 1]?.agentId,
          workerId: rd.workerId,
          from: 'orchestrator',
          to: `worker-${rd.workerId}`,
          allocationUsdc: rd.allocationUsdc,
          vaultAddress: rd.vaultAddress,
          delegationHash: rd.delegationHash,
        })
      )
    } catch (err) {
      console.warn('[A2A] Redelegation failed, falling back to direct execution:', err)
      workerRedelegations = null
    }

    // Dispatch workers SERIALLY — one fully completes (incl. receipt) before the next starts.
    // Parallel dispatch spiked the 1Shot relay (3 simultaneous requests → 429/503 → every
    // worker fell back to a user-signed MetaMask tx → 3 popups + delegated-EOA in-flight
    // limit). Serial keeps the relay happy so the silent path holds; the 2s gap gives 1Shot
    // and the mempool breathing room. Visually, the vis.js graph also lights up one-by-one.
    this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'pending' })
    const workerResults = []
    for (let i = 0; i < workers.length; i++) {
      const plan = vaultPlans[i]
      try {
        const res = await workers[i].execute()
        // Worker redeemed its redelegation to execute the deposit → A2A redeem proof
        const rd = workerRedelegations?.[i]
        if (rd && res?.success) {
          this.onEvent('RedelegationRedeemed', {
            agentId: plan.agentId,
            workerId: rd.workerId,
            to: `worker-${rd.workerId}`,
            txHash: res.txHash,
            delegationHash: rd.delegationHash,
          })
        }
        workerResults.push({ status: 'fulfilled', value: res })
      } catch (e) {
        workerResults.push({ status: 'rejected', reason: e })
      }
      if (i < workers.length - 1) await new Promise((r) => setTimeout(r, DISPATCH_INTERVAL_MS))
    }
    this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'done' })

    // Aggregate results
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

import { WorkerAgent, makeAgentId } from './worker.js'
import { generateAgentSkills } from './venice.js'
import { saveSkill } from './skills.js'
import { deployAgentForSession, fundAgent, registryAuthorizeAgent } from './stellar/agentSetup.js'
import { saveCachedAgent, takeReusableAgent } from './stellar/agentCache.js'
import { newSessionKey } from './stellar/sessionKey.js'
import { readTokenBalance } from './stellar/agentDeposit.js'
import {
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DECIMALS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
} from './stellar/config.js'

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
  constructor({ user, veniceAuth, devApiKey, sessionId, onEvent, registryAuthorize = false }) {
    this.user = user
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.onEvent = onEvent || (() => {})
    this.sessionId = sessionId || `session-${Date.now()}`
    // Registry.authorize is record-keeping only (deposits are enforced by the agent account's
    // OWN constructor-pinned scope; nothing on the deposit path reads the Registry). Default
    // off: it would cost one extra wallet popup per agent. Flip on to also write the on-chain
    // Registry record (feeds stellar/events.js indexer + the Registry.revoke kill-switch demo).
    this.registryAuthorize = registryAuthorize
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

    // User-signed setup, STRICTLY SEQUENTIAL across agents — load-bearing: every setup tx is
    // sourced from the SAME user account, so each build must fetch the sequence AFTER the
    // previous tx confirmed (parallel setup = txBadSeq races + a stack of queued wallet popups).
    // Each helper in agentSetup.js builds its tx immediately before signing (never pre-built)
    // and hard-checks the submit status; wallet signs are 120s-timeout-capped there so a
    // dismissed popup fails loudly instead of hanging the run.
    //
    // Popup budget per agent: reuse-cache hit = 0 popups (deploy skipped; fund skipped too when
    // the agent still holds enough of the asset) · fresh agent = 2 (deploy + fund) ·
    // +1 when registryAuthorize is flipped on. One agent's setup failure marks THAT worker
    // failed and the run continues; only all-agents-failed aborts.
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
    const nowSec = Math.floor(Date.now() / 1000)
    const takenThisRun = new Set() // one cached agent must not serve two workers of this run
    for (const w of workers) {
      try {
        // Reuse a cached agent when its ON-CHAIN scope still allows this deposit (expiry,
        // revoked, cap headroom via scope_of()) — restores that agent's pinned session key.
        const cached = await takeReusableAgent({
          owner: this.user,
          vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
          amount: w.amount,
          nowSec,
          exclude: takenThisRun,
        })
        if (cached) {
          w.sessionKey = newSessionKey(cached.secret) // signer is constructor-pinned to this key
          await w.setupKey() // idempotent — keeps the restored key, emits the key-setup step
          w.agentAddress = cached.agentAddress
        } else {
          await w.setupKey() // fresh ed25519 session key (the on-chain agent signer)
          // Deploy BEFORE fund — it needs the fresh agent's address. User-signed and user-paid:
          // the relay's allowlist only fee-bumps vault-deposit invokes, never a deploy.
          w.agentAddress = await deployAgentForSession({
            owner: this.user,
            sessionKey: w.sessionKey,
            cap: w.amount,
            periodDuration: PERIOD_DURATION,
            expiry,
          })
          saveCachedAgent({
            owner: this.user,
            vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
            entry: {
              agentAddress: w.agentAddress,
              secret: w.sessionKey.secret,
              signerPub: w.sessionKey.publicKey,
              cap: String(w.amount),
              expiry,
              createdAt: Date.now(),
            },
          })
        }
        takenThisRun.add(w.agentAddress)
        this.onEvent('AgentDeployed', {
          agentId: w.agentId,
          agent: w.agentAddress,
          signer: w.sessionKey.publicKey,
          reused: Boolean(cached),
        })
        if (this.registryAuthorize) {
          await registryAuthorizeAgent({
            owner: this.user,
            agentAddress: w.agentAddress,
            vault: w.vault,
            capPerPeriod: w.amount,
            periodDuration: PERIOD_DURATION,
            expiry,
          })
        }
        // Fund only the shortfall case: a reused agent may still hold the asset from a run
        // that failed before its deposit. null (read failed) funds anyway — the safe side.
        const agentBal = await readTokenBalance(w.agentAddress)
        if (agentBal == null || agentBal < w.amount) {
          await fundAgent({ owner: this.user, agentAddress: w.agentAddress, amount: w.amount })
        }
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
          registryRecorded: this.registryAuthorize,
        })
      } catch (err) {
        // Surface + isolate: THIS worker is out (drives the tile/log 'failed' state), the rest
        // of the run continues. No infinite "started" limbo, no all-or-nothing abort.
        w.setupFailed = true
        w.setupError = `setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
    if (workers.every((w) => w.setupFailed)) {
      const msg = `agent setup failed for all ${workers.length} agents — ${workers[0].setupError}`
      this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'error', error: msg })
      throw new Error(msg)
    }
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'done' })

    // Dispatch workers SERIALLY — one completes before the next starts; the gap keeps the relay
    // off its per-IP rate limit. Promise.allSettled-equivalent: a thrown worker is captured, not
    // propagated, so one agent's failure never aborts the others.
    this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'pending' })
    const workerResults = []
    for (let i = 0; i < workers.length; i++) {
      // A worker whose setup failed was already surfaced ('failed' event) — record and move on.
      if (workers[i].setupFailed) {
        workerResults.push({ status: 'rejected', reason: new Error(workers[i].setupError) })
        continue
      }
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

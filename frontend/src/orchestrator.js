import { WorkerAgent, makeAgentId } from './worker.js'
import { generateAgentSkills } from './venice.js'
import { saveSkill } from './skills.js'
import { deployAgentForSession, fundAgent, registryAuthorizeAgent } from './stellar/agentSetup.js'
import { submitGrant, runAgentPull, readAllowance } from './stellar/grant.js'
import { saveCachedAgent, takeReusableAgent } from './stellar/agentCache.js'
import { newSessionKey } from './stellar/sessionKey.js'
import { readTokenBalance } from './stellar/agentDeposit.js'
import {
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DECIMALS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  USE_FUNDING_ROUTER,
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
  constructor({
    user,
    veniceAuth,
    devApiKey,
    sessionId,
    onEvent,
    registryAuthorize = false,
    grantBudgetUnits = null,
    grantDurationSeconds = null,
  }) {
    this.user = user
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.onEvent = onEvent || (() => {})
    this.sessionId = sessionId || `session-${Date.now()}`
    // One-popup grant knobs (router path only). Budget defaults to the run total; a larger budget
    // buys headroom for 0-popup repeat runs. Duration defaults to SCOPE_TTL_SECONDS. The UI's grant
    // step supplies both; null = use defaults.
    this.grantBudgetUnits = grantBudgetUnits != null ? BigInt(grantBudgetUnits) : null
    this.grantDurationSeconds = grantDurationSeconds || null
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
    const scopeTtl = this.grantDurationSeconds || SCOPE_TTL_SECONDS
    const expiry = Math.floor(Date.now() / 1000) + scopeTtl
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

    // Agent setup — ONE of two paths, chosen by the config knob USE_FUNDING_ROUTER:
    //   • Router (DEFAULT once funding_router is deployed): ONE owner-signed grant deploys every
    //     agent + sets the SEP-41 budget behind a single popup; worker funding is a relayed
    //     router.pull (0 popups). Repeat runs can be 0-popup. — setupViaRouter
    //   • Legacy (router unset, or VITE_LEGACY_AGENT_SETUP=1): per-agent deploy + fund, each a
    //     user-signed popup. — setupLegacy
    // Both isolate a single agent's setup failure (that worker fails, the run continues) and abort
    // only when EVERY agent failed. The pending/error/done step events are emitted HERE so both
    // paths report identically.
    this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
    if (USE_FUNDING_ROUTER) {
      await this.setupViaRouter(workers, expiry)
    } else {
      await this.setupLegacy(workers, expiry)
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

  /**
   * LEGACY setup: per-agent deploy + fund, each a user-signed popup, STRICTLY SEQUENTIAL across
   * agents — load-bearing: every setup tx is sourced from the SAME user account, so each build must
   * fetch the sequence AFTER the previous tx confirmed (parallel setup = txBadSeq races + a stack of
   * queued wallet popups). Each helper in agentSetup.js builds its tx immediately before signing
   * (never pre-built) and hard-checks the submit status; wallet signs are 120s-timeout-capped there.
   * Popup budget per agent: reuse-cache hit = 0 (deploy skipped; fund skipped too when the agent
   * still holds enough) · fresh agent = 2 (deploy + fund) · +1 when registryAuthorize is on.
   */
  async setupLegacy(workers, expiry) {
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
  }

  /**
   * ROUTER setup (one-popup grant flow). Fresh agents can ONLY be created BY a grant (grant deploys
   * them), so the only 0-popup path is reusing STILL-VALID cached agents. Sequence:
   *   1. Try to fill EVERY worker from cache with the router's allowance still covering the run
   *      total → 0 popups (tryReuseAllCached).
   *   2. Otherwise ONE grant popup deploys a fresh agent per worker + (re)sets the budget
   *      (grantFreshAgents). A grant failure marks every worker failed (no agents deployed).
   *   3. Fund each worker via a RELAYED router.pull (agent session-key signed; 0 popups), unless it
   *      already holds enough of the asset. One worker's pull failure isolates that worker.
   */
  async setupViaRouter(workers, expiry) {
    const nowSec = Math.floor(Date.now() / 1000)
    const totalUnits = workers.reduce((acc, w) => acc + w.amount, 0n)

    const reused = await this.tryReuseAllCached(workers, totalUnits, nowSec)
    if (!reused) {
      for (const w of workers) await w.setupKey() // fresh keys the grant pins as agent signers
      try {
        await this.grantFreshAgents(workers, totalUnits, expiry, nowSec)
      } catch (err) {
        // A grant covers ALL workers under one signature — its failure (dismissed popup, sim
        // error) leaves NO agents deployed, so the whole run's setup failed. Mark every worker;
        // dispatch's all-failed check then emits the error step + throws, exactly like legacy.
        for (const w of workers) {
          w.setupFailed = true
          w.setupError = `setup failed: ${err.message}`
          this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
        }
        return
      }
    }

    for (const w of workers) {
      if (w.setupFailed) continue
      try {
        // Fund only the shortfall case (a reused/aborted agent may already hold the asset). The
        // pull is relayed: the agent's session key signs the pull auth entry, the relay fee-bumps
        // (router.pull is now allowlisted) — 0 popups.
        const agentBal = await readTokenBalance(w.agentAddress)
        if (agentBal == null || agentBal < w.amount) {
          const res = await runAgentPull({
            agentAddress: w.agentAddress,
            amount: w.amount,
            sessionKey: w.sessionKey,
          })
          if (!res) throw new Error('relay unconfigured — cannot pull funds to the agent')
          if (res.status !== 'SUCCESS') throw new Error(`router pull reported ${res.status}`)
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
          registryRecorded: false,
        })
      } catch (err) {
        w.setupFailed = true
        w.setupError = `setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
  }

  /**
   * 0-popup fast path: reuse a still-valid cached agent for EVERY worker. Two load-bearing gates:
   * (a) the owner→router SEP-41 allowance must still cover this run's total (budget left to pull),
   * and (b) each worker must find a cached agent whose ON-CHAIN cap still has headroom for its
   * deposit. The common case — an agent whose cap == its already-spent first deposit — fails (b)
   * and rolls to a fresh grant popup. All-or-nothing: partial cache reuse still needs a grant (a
   * grant is the only way to make the missing agents), so we commit the reuse only once EVERY
   * worker has one. Returns true iff all workers were assigned a cached agent.
   */
  async tryReuseAllCached(workers, totalUnits, nowSec) {
    const allowance = await readAllowance({ owner: this.user })
    if (!allowance || allowance.amount < totalUnits) return false
    const taken = new Set()
    const picks = []
    for (const w of workers) {
      const cached = await takeReusableAgent({
        owner: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        amount: w.amount,
        nowSec,
        exclude: taken,
      })
      if (!cached) return false // can't fill every worker from cache → a grant is required
      picks.push([w, cached])
      taken.add(cached.agentAddress)
    }
    for (const [w, cached] of picks) {
      w.sessionKey = newSessionKey(cached.secret) // restore the constructor-pinned session key
      await w.setupKey() // idempotent — keeps the restored key, emits the key-setup step
      w.agentAddress = cached.agentAddress
      this.onEvent('AgentDeployed', {
        agentId: w.agentId,
        agent: w.agentAddress,
        signer: w.sessionKey.publicKey,
        reused: true,
      })
    }
    return true
  }

  /**
   * THE ONE POPUP: a single owner-signed grant that deploys one fresh agent per worker and (re)sets
   * the SEP-41 budget. Budget = run total (or a larger user-chosen budget for 0-popup repeat
   * headroom), clamped up so it can never be below the run total. Caps per agent bound each deposit.
   * The returned Vec<Address> maps by index to the workers; each is cached for reuse.
   */
  async grantFreshAgents(workers, totalUnits, expiry, nowSec) {
    const budget =
      this.grantBudgetUnits != null && this.grantBudgetUnits > totalUnits
        ? this.grantBudgetUnits
        : totalUnits
    const durationSeconds = Math.max(1, expiry - nowSec)
    const agentInits = workers.map((w) => ({
      signer: w.sessionKey.rawPublicKey,
      cap: w.amount,
      vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
      periodDuration: PERIOD_DURATION,
      expiry,
    }))
    const { agentAddresses } = await submitGrant({
      owner: this.user,
      budgetBaseUnits: budget,
      durationSeconds,
      agentInits,
    })
    workers.forEach((w, i) => {
      w.agentAddress = agentAddresses[i]
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
      this.onEvent('AgentDeployed', {
        agentId: w.agentId,
        agent: w.agentAddress,
        signer: w.sessionKey.publicKey,
        reused: false,
      })
    })
  }
}

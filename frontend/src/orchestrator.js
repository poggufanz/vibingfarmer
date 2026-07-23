import { WorkerAgent, makeAgentId } from './worker.js'
import { generateAgentSkills } from './strategist.js'
import { saveSkill } from './skills.js'
import { deployAgentForSession, fundAgent, registryAuthorizeAgent } from './stellar/agentSetup.js'
import {
  submitGrant,
  runAgentPull,
  readAllowance,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
} from './stellar/grant.js'
import { saveCachedAgent, takeReusableAgent } from './stellar/agentCache.js'
import { newSessionKey } from './stellar/sessionKey.js'
import { readTokenBalance } from './stellar/agentDeposit.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
  ZERO32,
  evmAddrToBytes32,
} from './stellar/cctpBurn.js'
import { deriveCctpTransferUnits } from './stellar/format.js'
import { readStoredBaseMandate } from './mergeFlowHelpers.js'
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
   * @param {object|null} config.baseLegContext - { connectedAddress, signTx } — required only when
   *   strategy.vaults contains a chain:'base' entry (only .connectedAddress is read; signTx is
   *   unused since the grant-covers-burn rework — the Base leg's bridge agent is authorized by the
   *   SAME single funding_router grant as the Stellar deposit workers, signed once via the default
   *   wallet-kit path in grantFreshAgents, never through this context).
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
    baseLegContext = null,
  }) {
    this.user = user
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.onEvent = onEvent || (() => {})
    this.sessionId = sessionId || `session-${Date.now()}`
    this.baseLegContext = baseLegContext
    // Single-signature grant knobs (router path only). Budget defaults to the run total; a larger budget
    // buys headroom for signature-free repeat runs. Duration defaults to SCOPE_TTL_SECONDS. The UI's grant
    // step supplies both; null = use defaults.
    this.grantBudgetUnits = grantBudgetUnits != null ? BigInt(grantBudgetUnits) : null
    this.grantDurationSeconds = grantDurationSeconds || null
    // Registry.authorize is record-keeping only (deposits are enforced by the agent account's
    // OWN constructor-pinned scope; nothing on the deposit path reads the Registry). Default
    // off: it would cost one extra wallet signature per agent. Flip on to also write the on-chain
    // Registry record (feeds stellar/events.js indexer + the Registry.revoke kill-switch demo).
    this.registryAuthorize = registryAuthorize
  }

  /**
   * Execute full orchestration: generate skills → authorize+fund each agent → dispatch → aggregate.
   * Splits strategy.vaults by chain FIRST: chain:'base' vaults run through executeBaseLeg (Task 7)
   * as a settled sibling of the Stellar worker pipeline — one leg failing never aborts the other.
   * @param {object} strategy - { vaults: [{ address, allocation, chain? }], ... } — chain defaults
   *   to the Stellar path when absent (regression-safe for every pre-Task-3 strategy).
   * @param {number} totalAmount - total asset amount (human-readable VFUSD)
   * @returns {Promise<{completed:number, failed:number, results:Array, sessionId:string, baseLeg:object|null}>}
   */
  async dispatch(strategy, totalAmount) {
    const allVaults = strategy.vaults || []
    const baseVaults = allVaults.filter((v) => v.chain === 'base')
    const stellarVaults = allVaults.filter((v) => v.chain !== 'base')
    if (baseVaults.length > 0 && !this.baseLegContext) {
      throw new Error('strategy contains base vaults but no base leg context was provided')
    }

    // Base-leg balance preflight — the burn spends STELLAR_USDC_SAC, a DIFFERENT asset from
    // SOROBAN_TOKEN_ADDRESS (VFUSD, checked below for the Stellar leg), so it can't be folded into
    // that total; it needs its own read. Mirrors the Stellar preflight's behavior: throw here and
    // dispatch aborts entirely, before either leg does any work (same fail-fast contract as the
    // pre-existing VFUSD check inside runStellarLegs).
    if (baseVaults.length > 0) {
      const legAmount = baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
      const { burnUnits7 } = deriveCctpTransferUnits(legAmount)
      const burnBal = await readTokenBalance(this.user, { token: STELLAR_USDC_SAC })
      if (burnBal != null && burnBal < burnUnits7) {
        throw new Error(
          `Insufficient USDC for the cross-chain leg: have ${(Number(burnBal) / BASE_UNIT).toFixed(2)}, need ${(Number(burnUnits7) / BASE_UNIT).toFixed(2)} to burn via CCTP.`
        )
      }
    }
    const stellarStrategy = { ...strategy, vaults: stellarVaults }
    const scopeTtl = this.grantDurationSeconds || SCOPE_TTL_SECONDS
    const expiry = Math.floor(Date.now() / 1000) + scopeTtl

    // Grant-covers-burn (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md §4-5): a
    // mixed run's bridge agent joins the SAME single grant as the Stellar deposit workers — never
    // a second signature ("Run campuran: 1 ttd grant, 0 passkey"). mint_recipient is pinned to the
    // ALREADY-valid stored Base mandate's kernel address; app.jsx's preflight
    // (checkStoredBaseMandate) guarantees one exists before Base is ever offered as a strategy
    // option, so this is a read, never a fresh ceremony.
    let bridgeInit = null
    let bridgeSessionKey = null
    // Threaded into executeBaseLeg below (never re-read from storage there) — the exact
    // kernelAddress this grant pinned as mint_recipient, so a mid-run mandate rotation can't
    // desync the runtime burn arg from what's actually on-chain (see baseLeg.js's own doc).
    let bridgeKernelAddress = null
    if (baseVaults.length > 0) {
      const mandate = readStoredBaseMandate()
      if (!mandate) {
        throw new Error('No durable Base mandate is stored for the cross-chain leg.')
      }
      bridgeKernelAddress = mandate.kernelAddress
      const legAmount = baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
      const { burnUnits7: bridgeCap } = deriveCctpTransferUnits(legAmount)
      bridgeSessionKey = newSessionKey()
      bridgeInit = {
        signer: bridgeSessionKey.rawPublicKey,
        cap: bridgeCap,
        token: STELLAR_USDC_SAC,
        target: STELLAR_TOKEN_MESSENGER_MINTER,
        kind: AGENT_KIND_BRIDGE,
        mintRecipient: evmAddrToBytes32(bridgeKernelAddress),
        destinationDomain: CCTP_BASE_DOMAIN,
        periodDuration: PERIOD_DURATION,
        expiry,
      }
    }

    // Resolves once the run's grant (or the no-grant-needed/legacy path) names the bridge agent.
    // The Base leg branch below awaits this before doing any work, so Promise.allSettled still
    // fires both branches immediately, but the Base leg's real work blocks on the SAME grant the
    // Stellar branch triggers inside setupViaRouter — one signature covers both legs. `finally`
    // (in runStellarLegs below) guarantees this always settles even if the Stellar branch throws
    // before ever reaching setup (e.g. the VFUSD preflight) — otherwise the Base leg would hang.
    let resolveBridgeAgent
    const bridgeAgentReady = new Promise((resolve) => {
      resolveBridgeAgent = resolve
    })

    // Stellar leg — MOVED verbatim from the pre-Task-8 dispatch body (only `strategy` →
    // `stellarStrategy` at the vaultPlans line changed) into a local closure so it can run as one
    // settled branch of Promise.allSettled alongside the Base leg below.
    const runStellarLegs = async () => {
      try {
        const vaultPlans = stellarStrategy.vaults.map((v, i) => ({
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

        // Pre-flight: block BEFORE any wallet signature if the asset balance can't cover the total.
        const bal = await readTokenBalance(this.user)
        if (bal != null && bal < totalUnits) {
          const msg = `Insufficient VFUSD: have ${(Number(bal) / BASE_UNIT).toFixed(2)}, need ${(Number(totalUnits) / BASE_UNIT).toFixed(2)} for this deposit.`
          this.onEvent('orchestrator-step', {
            step: 'authorizing-scope',
            status: 'error',
            error: msg,
          })
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
        //     agent + sets the SEP-41 budget behind a single signature; worker funding is a relayed
        //     router.pull (0 further signatures). Repeat runs can be signature-free. — setupViaRouter
        //   • Legacy (router unset, or VITE_LEGACY_AGENT_SETUP=1): per-agent deploy + fund, each a
        //     user signature. — setupLegacy
        // Both isolate a single agent's setup failure (that worker fails, the run continues) and abort
        // only when EVERY agent failed. The pending/error/done step events are emitted HERE so both
        // paths report identically.
        this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
        if (USE_FUNDING_ROUTER) {
          await this.setupViaRouter(workers, expiry, bridgeInit, resolveBridgeAgent)
        } else {
          await this.setupLegacy(workers, expiry)
        }
        if (workers.length > 0 && workers.every((w) => w.setupFailed)) {
          const msg = `Agent setup failed for all ${workers.length} agents: ${workers[0].setupError}`
          this.onEvent('orchestrator-step', {
            step: 'authorizing-scope',
            status: 'error',
            error: msg,
          })
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

        return {
          completed,
          failed,
          results,
          sessionId: this.sessionId,
          agentAddresses: workers.map((w) => w.agentAddress).filter(Boolean),
        }
      } finally {
        // Guarantees bridgeAgentReady always settles, even when this closure throws before ever
        // reaching setupViaRouter (e.g. the VFUSD preflight above) — a no-op if setupViaRouter
        // already resolved it (resolving an already-settled promise is a safe no-op in JS).
        resolveBridgeAgent(null)
      }
    }

    // Base leg (Task 7's executeBaseLeg) never throws — it resolves { success:false, stage, error }
    // on failure. Dynamic import KEPT INSIDE the baseVaults.length>0 branch — gating it here (not
    // just the call) keeps the Base-only dependency chain (passkey bridge, mandate, relayer
    // client, ZeroDev farm flow) out of the Stellar-only path's load AND out of its failure mode:
    // a Base dep-chain resolution error now settles into the baseLeg-rejection mapping below
    // instead of ever reaching a pure-Stellar dispatch. Run as a settled sibling: one leg's
    // failure can never abort the other. The Base branch first awaits bridgeAgentReady — the
    // Stellar branch's grant (or its finally-guaranteed null) — so both branches start together
    // but the Base leg's real work only begins once the shared grant has actually resolved.
    const [stellarSettled, baseSettled] = await Promise.allSettled([
      runStellarLegs(),
      baseVaults.length > 0
        ? bridgeAgentReady.then((bridgeAgentAddress) => {
            if (!bridgeAgentAddress) {
              // Either the grant itself failed (see the Stellar branch's own error/event for that
              // case) or USE_FUNDING_ROUTER is off — a bridge agent can only be deployed via the
              // router's kind:Bridge AgentInit, never the legacy per-agent deploy path.
              throw new Error(
                'No bridge agent was deployed for the cross-chain leg (either the grant failed, or the funding router is unavailable — Base legs require it).'
              )
            }
            return import('./baseLeg.js').then(({ executeBaseLeg }) =>
              executeBaseLeg({
                connectedAddress: this.baseLegContext.connectedAddress,
                bridgeAgentAddress,
                bridgeSessionKey,
                kernelAddress: bridgeKernelAddress,
                baseVaults,
                totalAmount,
                onEvent: (name, data) => this.onEvent(name, data),
              })
            )
          })
        : Promise.resolve(null),
    ])

    // Stellar-only strategies must behave byte-identically to pre-Task-8 dispatch — including
    // rejecting with the SAME error (insufficient balance / all-agents-setup-failed). Re-throw
    // rather than let allSettled swallow it.
    if (stellarSettled.status === 'rejected') {
      throw stellarSettled.reason
    }

    // Base leg contract says it never rejects — this is belt-and-braces in case a future change
    // (or a bug) breaks that contract; map to the same shape executeBaseLeg would have returned.
    const baseLeg =
      baseSettled.status === 'fulfilled'
        ? baseSettled.value
        : { success: false, stage: 'dispatch', error: baseSettled.reason?.message }

    return { ...stellarSettled.value, baseLeg }
  }

  /**
   * LEGACY setup: per-agent deploy + fund, each a user signature, STRICTLY SEQUENTIAL across
   * agents — load-bearing: every setup tx is sourced from the SAME user account, so each build must
   * fetch the sequence AFTER the previous tx confirmed (parallel setup = txBadSeq races + a stack of
   * queued wallet signatures). Each helper in agentSetup.js builds its tx immediately before signing
   * (never pre-built) and hard-checks the submit status; wallet signs are 120s-timeout-capped there.
   * Signature budget per agent: reuse-cache hit = 0 (deploy skipped; fund skipped too when the agent
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
          // The hardened registry derives every record field from the agent contract's own
          // scope_of() — pass ONLY the agent address; scope/cap/expiry come from the chain.
          await registryAuthorizeAgent({ owner: this.user, agentAddress: w.agentAddress })
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
        w.setupError = `Setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
  }

  /**
   * ROUTER setup (single-signature grant flow). Fresh agents can ONLY be created BY a grant (grant deploys
   * them), so the only signature-free path is reusing STILL-VALID cached agents. Sequence:
   *   1. Try to fill EVERY worker from cache with the router's allowance still covering the run
   *      total → 0 further signatures (tryReuseAllCached). Skipped entirely when a bridge agent is
   *      needed — it can NEVER be served from cache (never cached, by design — see baseLeg.js's
   *      grant-covers-burn note), so a grant is unavoidable whenever `bridgeInit` is present, and
   *      it may as well cover every Stellar worker too rather than leave some half-cached.
   *   2. Otherwise a single grant signature deploys a fresh agent per worker (+ the bridge agent,
   *      when present) and (re)sets the budget(s) (grantFreshAgents). A grant failure marks every
   *      worker failed (no agents deployed) and resolves the bridge agent as null.
   *   3. Fund each worker via a RELAYED router.pull (agent session-key signed; 0 further signatures), unless it
   *      already holds enough of the asset. One worker's pull failure isolates that worker.
   * @param {Array} workers
   * @param {number} expiry
   * @param {object|null} [bridgeInit] - a Bridge-kind AgentInit to fold into the SAME grant
   * @param {(bridgeAgentAddress:string|null)=>void} [resolveBridgeAgent] - settles once the bridge
   *   agent's address is known (or null, when no grant ran or it failed)
   */
  async setupViaRouter(workers, expiry, bridgeInit = null, resolveBridgeAgent = () => {}) {
    const nowSec = Math.floor(Date.now() / 1000)
    const totalUnits = workers.reduce((acc, w) => acc + w.amount, 0n)

    const reused = bridgeInit ? false : await this.tryReuseAllCached(workers, totalUnits, nowSec)
    if (!reused) {
      for (const w of workers) await w.setupKey() // fresh keys the grant pins as agent signers
      let bridgeAgentAddress = null
      try {
        bridgeAgentAddress = await this.grantFreshAgents(
          workers,
          totalUnits,
          expiry,
          nowSec,
          bridgeInit
        )
      } catch (err) {
        // A grant covers ALL workers (+ the bridge agent) under one signature — its failure
        // (dismissed signature request, sim error) leaves NOTHING deployed, so the whole run's
        // setup failed. Mark every worker; dispatch's all-failed check then emits the error step +
        // throws, exactly like legacy. The bridge leg settles separately (null -> Base leg fails).
        for (const w of workers) {
          w.setupFailed = true
          w.setupError = `Setup failed: ${err.message}`
          this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
        }
        resolveBridgeAgent(null)
        return
      }
      resolveBridgeAgent(bridgeAgentAddress)
    } else {
      resolveBridgeAgent(null) // cache-reuse path never grants — never reached when bridgeInit is set
    }

    for (const w of workers) {
      if (w.setupFailed) continue
      try {
        // Fund only the shortfall case (a reused/aborted agent may already hold the asset). The
        // pull is relayed: the agent's session key signs the pull auth entry, the relay fee-bumps
        // (router.pull is now allowlisted) — 0 further signatures.
        const agentBal = await readTokenBalance(w.agentAddress)
        if (agentBal == null || agentBal < w.amount) {
          const res = await runAgentPull({
            agentAddress: w.agentAddress,
            amount: w.amount,
            sessionKey: w.sessionKey,
          })
          if (!res)
            throw new Error(
              'The Stellar relay is unavailable. Funds could not be sent to the agent.'
            )
          if (res.status !== 'SUCCESS')
            throw new Error(`The funding router returned ${res.status}.`)
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
        w.setupError = `Setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
  }

  /**
   * signature-free fast path: reuse a still-valid cached agent for EVERY worker. Two load-bearing gates:
   * (a) the owner→router SEP-41 allowance must still cover this run's total (budget left to pull),
   * and (b) each worker must find a cached agent whose ON-CHAIN cap still has headroom for its
   * deposit. The common case — an agent whose cap == its already-spent first deposit — fails (b)
   * and rolls to a fresh grant signature. All-or-nothing: partial cache reuse still needs a grant (a
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
   * THE ONE SIGNATURE: an owner-signed grant that deploys one fresh agent per worker — PLUS the
   * run's bridge agent, when `bridgeInit` is present (folded into the SAME agentInits/budgets, per
   * the grant-covers-burn design: a mixed run costs exactly one grant, never two) — and (re)sets
   * the SEP-41 budget(s). The Stellar-deposit budget is run total (or a larger user-chosen budget
   * for signature-free repeat headroom), clamped up so it can never be below the run total; the
   * bridge budget is always exact (never inflated — a bridge agent is spent once, never reused).
   * The returned Vec<Address> maps by input order: workers first, the bridge agent last (if any) —
   * grant.js's own `bridgeAgentAddress` field already names that last entry, reused verbatim here.
   * @returns {Promise<string|null>} the deployed bridge agent's address, or null when none was requested
   */
  async grantFreshAgents(workers, totalUnits, expiry, nowSec, bridgeInit = null) {
    const budget =
      this.grantBudgetUnits != null && this.grantBudgetUnits > totalUnits
        ? this.grantBudgetUnits
        : totalUnits
    const durationSeconds = Math.max(1, expiry - nowSec)
    // v2 AgentInit (funding_router/src/types.rs): kind 0 = Deposit, target = the vault the agent
    // deposits into. mintRecipient/destinationDomain are Bridge-only fields — a Deposit agent's
    // scope never reads them, so they're pinned to the same harmless zero/none the Rust side
    // ignores for this kind (ZERO32 imported from cctpBurn.js, never redeclared).
    const agentInits = workers.map((w) => ({
      signer: w.sessionKey.rawPublicKey,
      cap: w.amount,
      token: SOROBAN_TOKEN_ADDRESS,
      target: SOROBAN_ACTIVE_VAULT_ADDRESS,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO32,
      destinationDomain: 0,
      periodDuration: PERIOD_DURATION,
      expiry,
    }))
    // budgets carries one entry per distinct token spent by this grant — omitted entirely when
    // there are no Stellar deposit workers (an all-Base strategy grants the bridge init only).
    const budgets = []
    if (workers.length > 0) budgets.push({ budget, token: SOROBAN_TOKEN_ADDRESS })
    if (bridgeInit) {
      agentInits.push(bridgeInit)
      budgets.push({ budget: bridgeInit.cap, token: bridgeInit.token })
    }
    const { agentAddresses, bridgeAgentAddress } = await submitGrant({
      owner: this.user,
      budgets,
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
    return bridgeAgentAddress
  }
}

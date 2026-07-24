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
import { deriveCctpTransferUnits, toBaseUnits } from './stellar/format.js'
import { readStoredBaseMandate } from './mergeFlowHelpers.js'
import {
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DECIMALS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  USE_FUNDING_ROUTER,
} from './stellar/config.js'
import { isLegacyDirectSetupAllowed } from './stellar/agentCreatorManifest.js'
import { PermissionPhaseError } from './strategy/permissionError.js'
import { buildDispatchReceipt } from './strategy/dispatchSummary.js'
// NOTE (Strategy Task 7): every OTHER new dependency this file needed for the permission-locked
// path (`./strategy/reusePreflight.js`, `./stellar/grantReceiptStore.js`, and `readConfirmedLedger`
// from `./stellar/grant.js`, plus `loadCachedAgents`/`SOROBAN_FUNDING_ROUTER_ADDRESS`) is imported
// DYNAMICALLY, inside the methods that actually use it — never at module top-level. Several
// pre-existing test files (orchestrator.baseleg.test.js, kept byte-for-byte per the worktree
// guard) mock `./stellar/agentCache.js` and `./stellar/config.js` with only the small export set
// the LEGACY path needs; a static top-level import here would pull reusePreflight.js's own
// transitive imports (agentCache's `EXPIRY_MARGIN_SECONDS`/`inspectReusableAgents`,
// grantReceiptStore's `NETWORK_PASSPHRASE`, …) into every test's module graph and break those
// mocks even though the legacy path never calls any of this code. Mirrors the file's existing
// `import('./baseLeg.js').then(...)` isolation pattern below.

// Scope window for a dispatch: agents may deposit up to their allocation, within the period.
const PERIOD_DURATION = 86400
const SCOPE_TTL_SECONDS = 3600
const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1 VFUSD = 10_000_000 (7-dp)
// Gap between serial worker dispatches — keeps the relay off its per-IP rate limit.
const DISPATCH_INTERVAL_MS = 2000

/** hex string (0x-prefixed or not) -> 32-byte Uint8Array, for a reviewed AgentInit's
 * `mintRecipient` (reusePreflight.js stores it hex-encoded via `bytesToHex`). */
function hexToBytes32(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32 && i * 2 < clean.length; i++)
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  return bytes
}

/**
 * Bigint-safe per-vault unit split for the legacy `{vaults:[{allocation}]}` shape (review round 2
 * fix — `orchestrator.js`'s previous `BigInt(Math.floor(totalAmount * v.allocation * BASE_UNIT))`
 * let float multiplication corrupt the final on-chain unit value directly). Each ratio is scaled
 * to an integer numerator (parts per 1e10 — ample precision for a JS float ratio) BEFORE any
 * bigint arithmetic touches the total. `localTotalUnits` is what THIS array's own ratios
 * collectively represent (1 for a pure-Stellar run, less than 1 for the Stellar-only slice of a
 * mixed run) — shares floor-divide against it, and any rounding remainder goes to the earliest
 * indices one unit at a time, mirroring planModel.js's `splitEven` remainder rule so no unit of
 * the user's money is silently dropped to truncation.
 */
function splitUnitsByRatio(totalUnits, ratios) {
  const SCALE = 10_000_000_000n
  const scale = (r) => BigInt(Math.round(r * 1e10))
  const localTotalUnits = (totalUnits * scale(ratios.reduce((a, b) => a + b, 0))) / SCALE
  const shares = ratios.map((r) => (totalUnits * scale(r)) / SCALE)
  const remainder = localTotalUnits - shares.reduce((a, b) => a + b, 0n)
  return shares.map((s, i) => (remainder > 0n && BigInt(i) < remainder ? s + 1n : s))
}

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
  async dispatch(strategyOrPlan, totalAmountOrOptions) {
    // Strategy Task 7 (Pocket Crew redesign, Wave 1) — dispatch is overloaded by the SHAPE of its
    // second argument, never by an explicit flag, so every pre-Task-7 call site (a plain
    // human-readable `totalAmount` number) is untouched byte-for-byte and keeps taking the legacy
    // path below. A reviewed StrategyPlan + PermissionDecisionV1 always passes an OBJECT
    // (`{ permissionDecision }`) as the second argument — that shape is the discriminator.
    if (totalAmountOrOptions != null && typeof totalAmountOrOptions === 'object') {
      return this.dispatchPermissioned(strategyOrPlan, totalAmountOrOptions)
    }
    return this.dispatchLegacy(strategyOrPlan, totalAmountOrOptions)
  }

  /**
   * Strategy Task 7 (Pocket Crew redesign, Wave 1) — the permission-locked dispatch path. Consumes
   * an already-reviewed StrategyPlan (planModel.js) plus the PermissionDecisionV1 that Task 5's
   * `preflightPermission` produced for it. Every fact the plan was reviewed against — cap, expiry,
   * period, budget — is taken verbatim from `permissionDecision`, never regenerated here: this
   * method's whole job is refusing to move any fund on anything but that exact reviewed decision.
   *
   * Fresh mode: builds ONE grant strictly from `permissionDecision.reviewedBudgets` /
   * `reviewedAgentInits`, saves + fingerprints the resulting GrantReceiptV1, THEN emits
   * 'grant-confirmed' — before any worker movement. Never touches the agent-reuse cache.
   * Reuse mode: never builds or submits a grant, never calls the wallet/provider. It re-runs
   * Task 5's own `preflightPermission` one more time (a fresh latest-ledger capture, a fresh
   * no-later-mutation proof, a fresh per-agent on-chain scope re-check) immediately before the
   * first pull; any drift from what was reviewed is `PermissionPhaseError`
   * (`phase:'reuse-revalidation', code:'VF_REUSE_EVIDENCE_CHANGED'`) — never a silent fallback to
   * a wallet signature.
   * Both modes reject a stale plan/AgentInit pairing before doing anything else
   * (`phase:'preflight'`).
   *
   * Bridge (Base) allocations are out of scope here — Task 8 owns the mixed-branch custody
   * receipt that will fold them into this path; a plan's `kind:'bridge'` agents are ignored by
   * this method (Task 7 covers Stellar deposit workers only).
   * @param {object} strategyPlan canonical StrategyPlan (planModel.js normalizeStrategyPlan/toDispatchStrategy)
   * @param {{permissionDecision: object}} options
   * @returns {Promise<{completed:number, failed:number, results:Array, sessionId:string, permission:object}>}
   */
  async dispatchPermissioned(strategyPlan, { permissionDecision }) {
    const planAgents = strategyPlan.agents || []
    const bridgeAgents = planAgents.filter((agent) => agent.kind === 'bridge')
    const depositAgents = planAgents.filter((agent) => agent.kind !== 'bridge')
    if (bridgeAgents.length > 0 && permissionDecision?.mode === 'reuse') {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_BASE_REQUIRES_FRESH_GRANT',
        message: 'Base bridge allocations require a fresh reviewed grant.',
      })
    }
    this.assertPermissionMatchesPlan(strategyPlan, permissionDecision, planAgents)
    try {
      for (const agent of planAgents) {
        for (const allocation of agent.kind === 'bridge' ? agent.children || [] : [agent]) {
          const amount = allocation.allocation || allocation.cap
          if (!amount || !/^[0-9]+$/.test(String(amount.units)) || !Number.isInteger(amount.decimals) || amount.decimals < 0) {
            throw new Error(`Invalid canonical amount for ${allocation.allocationId}.`)
          }
        }
      }
    } catch (cause) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_CANONICAL_AMOUNT_INVALID',
        message: cause.message,
        cause,
      })
    }
    let baseMandate = null
    if (bridgeAgents.length > 0) {
      if (!this.baseLegContext) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_CONTEXT_MISSING',
          message: 'Base bridge allocations require an owner-bound Base context.',
        })
      }
      try {
        const { readBaseMandate } = await import('./wallet/baseBinding.js')
        baseMandate = readBaseMandate(this.user)
      } catch (cause) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_MANDATE_UNREADABLE',
          message: 'The owner-bound Base mandate could not be read safely.',
          cause,
        })
      }
      if (!baseMandate?.kernelAddress) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_MANDATE_MISSING',
          message: 'No owner-bound Base mandate is available for this bridge allocation.',
        })
      }
      const reviewedBridge = (permissionDecision.reviewedAgentInits || []).find(
        (init) => init.allocationId === bridgeAgents[0].allocationId
      )
      const expectedRecipient = evmAddrToBytes32(baseMandate.kernelAddress)
      const actualRecipient =
        typeof reviewedBridge?.mintRecipient === 'string'
          ? hexToBytes32(reviewedBridge.mintRecipient)
          : reviewedBridge?.mintRecipient
      const recipientMatches =
        actualRecipient instanceof Uint8Array &&
        actualRecipient.length === expectedRecipient.length &&
        actualRecipient.every((byte, index) => byte === expectedRecipient[index])
      if (
        !reviewedBridge ||
        reviewedBridge.target !== STELLAR_TOKEN_MESSENGER_MINTER ||
        reviewedBridge.destinationDomain !== CCTP_BASE_DOMAIN ||
        !recipientMatches
      ) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BRIDGE_SCOPE_MISMATCH',
          message: 'The reviewed bridge scope no longer matches the owner-bound Base mandate.',
        })
      }
    }

    let workers
    let confirmed
    if (permissionDecision.mode === 'reuse') {
      const { revalidated, credentialByAllocation } = await this.revalidateReuse(
        strategyPlan,
        permissionDecision,
        planAgents
      )
      workers = this.buildReuseWorkers(depositAgents, revalidated, credentialByAllocation)
      // Matched by the actual budgeted token, never approvals[0] — a multi-token receipt's first
      // approval is not guaranteed to be the one this run's deposit budget cares about.
      const primaryToken = permissionDecision.reviewedBudgets?.[0]?.token
      const matchingApproval = revalidated.allowanceExpiryProof?.approvals?.find(
        (a) => a.amount?.token === primaryToken
      )
      const expiryLedger = matchingApproval?.expiryLedger ?? null
      confirmed = {
        version: 1,
        runId: strategyPlan.runId,
        mode: 'reuse',
        planFingerprint: strategyPlan.planFingerprint,
        agentInitFingerprint: permissionDecision.agentInitFingerprint,
        grantReceiptFingerprint: revalidated.grantReceiptFingerprint,
        confirmationCount: (permissionDecision.confirmationCount ?? 0) + 1,
        txHash: null,
        expiryLedger,
        agentAddresses: workers.map((w) => w.agentAddress),
        confirmedAt: Math.floor(Date.now() / 1000),
      }
      this.onEvent('reuse-confirmed', {
        runId: strategyPlan.runId,
        confirmed,
        agentAddresses: confirmed.agentAddresses,
      })
    } else if (permissionDecision.mode === 'fresh') {
      workers = this.buildFreshWorkers(planAgents)
      const granted = await this.grantFreshFromDecision(strategyPlan, workers, permissionDecision)
      confirmed = {
        version: 1,
        runId: strategyPlan.runId,
        mode: 'fresh',
        planFingerprint: strategyPlan.planFingerprint,
        agentInitFingerprint: permissionDecision.agentInitFingerprint,
        grantReceiptFingerprint: granted.grantReceiptFingerprint,
        confirmationCount: 1,
        txHash: granted.txHash,
        expiryLedger: granted.expiryLedger,
        agentAddresses: granted.agentAddresses,
        confirmedAt: granted.confirmedAt,
      }
      this.onEvent('grant-confirmed', {
        runId: strategyPlan.runId,
        confirmed,
        budgets: permissionDecision.reviewedBudgets,
        agentAddresses: granted.agentAddresses,
      })
    } else {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_UNKNOWN_PERMISSION_MODE',
        message: `Unknown permission mode: ${permissionDecision?.mode}`,
      })
    }

    if (bridgeAgents.length > 0) {
      return this.dispatchConfirmedMixed({
        strategyPlan,
        confirmed,
        workers,
        bridgeAgent: bridgeAgents[0],
        baseMandate,
      })
    }

    // Queue events fire for EVERY eligible worker up front, real index, before any turn begins —
    // then the SAME 2,000ms relay-safe serial dispatcher (unchanged from the legacy path) runs
    // pull + deposit per worker, isolating one worker's pull/deposit failure from the rest.
    workers.forEach((w, i) => {
      this.onEvent('worker-queued', {
        allocationId: w.allocationId,
        agentId: w.agentId,
        agent: w.agentAddress,
        queueIndex: i,
      })
    })

    const workerResults = []
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i]
      this.onEvent('worker-started', {
        allocationId: w.allocationId,
        agentId: w.agentId,
        agent: w.agentAddress,
        queueIndex: i,
      })
      try {
        // Fund only the shortfall case (a reused/aborted agent may already hold the asset) — same
        // rule as the legacy router path. The pull is relayed: the agent's own session key signs
        // the pull auth entry, the relay fee-bumps — zero further wallet signatures either mode.
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
        const res = await w.execute()
        workerResults.push({ status: 'fulfilled', value: res })
      } catch (e) {
        workerResults.push({ status: 'rejected', reason: e })
      }
      if (i < workers.length - 1) await new Promise((r) => setTimeout(r, DISPATCH_INTERVAL_MS))
    }

    const results = workerResults.map((r, i) => ({
      agentId: workers[i].agentId,
      allocationId: workers[i].allocationId,
      vault: workers[i].vault,
      success: r.status === 'fulfilled' && r.value?.success,
      txHash: r.value?.txHash,
      error: r.reason?.message || r.value?.error,
    }))
    const completed = results.filter((r) => r.success).length
    const failed = results.length - completed

    return { completed, failed, results, sessionId: this.sessionId, permission: confirmed }
  }

  /** After the shared fresh grant confirms, both execution branches are settled data. A Base
   * failure must therefore never erase completed Stellar deposits (and vice versa). */
  async dispatchConfirmedMixed({ strategyPlan, confirmed, workers, bridgeAgent, baseMandate }) {
    const mandate = baseMandate
    const bridgeWorker = workers.find((worker) => worker.allocationId === bridgeAgent.allocationId)
    const bridgeMaterialError =
      !bridgeWorker?.agentAddress || !bridgeWorker.sessionKey
        ? 'The confirmed grant did not return the reviewed bridge agent material.'
        : null
    const stellarWorkers = workers.filter((worker) => worker !== bridgeWorker)
    stellarWorkers.forEach((worker, index) => {
      this.onEvent('worker-queued', {
        allocationId: worker.allocationId,
        agentId: worker.agentId,
        agent: worker.agentAddress,
        queueIndex: index,
      })
    })
    const runStellar = async () => {
      const settled = []
      for (let index = 0; index < stellarWorkers.length; index++) {
        const worker = stellarWorkers[index]
        this.onEvent('worker-started', {
          allocationId: worker.allocationId,
          agentId: worker.agentId,
          agent: worker.agentAddress,
          queueIndex: index,
        })
        let pullTxHash = null
        let movedToAgent = false
        try {
          const balance = await readTokenBalance(worker.agentAddress)
          movedToAgent = balance != null && balance >= worker.amount
          if (balance == null || balance < worker.amount) {
            const pulled = await runAgentPull({
              agentAddress: worker.agentAddress,
              amount: worker.amount,
              sessionKey: worker.sessionKey,
            })
            if (!pulled) throw new Error('The Stellar relay is unavailable.')
            if (pulled.status !== 'SUCCESS') throw new Error(`The funding router returned ${pulled.status}.`)
            pullTxHash = pulled.hash || null
            movedToAgent = true
          }
          const deposited = await worker.execute()
          settled.push({
            status: 'fulfilled',
            value: {
              ...deposited,
              agentAddress: worker.agentAddress,
              pullTxHash,
              depositTxHash: deposited?.txHash || null,
              custody: deposited?.custody || { location: 'unknown', confirmed: false, checkedAt: null },
            },
          })
        } catch (reason) {
          settled.push({
            status: 'rejected',
            reason,
            value: {
              agentAddress: worker.agentAddress,
              pullTxHash,
              custody: movedToAgent
                ? { location: 'agent', confirmed: true, checkedAt: null }
                : { location: 'unknown', confirmed: false, checkedAt: null },
            },
          })
        }
        if (index < stellarWorkers.length - 1) await new Promise((resolve) => setTimeout(resolve, DISPATCH_INTERVAL_MS))
      }
      return settled.map((entry, index) => ({
        allocationId: stellarWorkers[index].allocationId,
        agentId: stellarWorkers[index].agentId,
        vault: stellarWorkers[index].vault,
        success: entry.status === 'fulfilled' && entry.value?.success,
        txHash: entry.value?.depositTxHash || entry.value?.txHash,
        pullTxHash: entry.value?.pullTxHash || null,
        depositTxHash: entry.value?.depositTxHash || null,
        agentAddress: entry.value?.agentAddress || stellarWorkers[index].agentAddress,
        custody: entry.value?.custody,
        error: entry.reason?.message || entry.value?.error,
      }))
    }
    const bridgeChildren = bridgeAgent.children || []
    const runBase = async () => {
      if (bridgeMaterialError) {
        return {
          success: false,
          runId: strategyPlan.runId,
          grantTxHash: confirmed.txHash,
          error: bridgeMaterialError,
          allocations: bridgeChildren.map((child) => ({
            allocationId: child.allocationId,
            amount: child.allocation,
            error: bridgeMaterialError,
            custody: { location: 'unknown', confirmed: false, checkedAt: null },
          })),
        }
      }
      const baseVaults = bridgeChildren.map((child) => ({
        address: child.address,
        allocationId: child.allocationId,
        allocationAmount: child.allocation,
        amountBaseUnits: BigInt(child.allocation.units),
        allocation: 1,
      }))
      const { executeBaseLeg } = await import('./baseLeg.js')
      return executeBaseLeg({
        connectedAddress: this.baseLegContext.connectedAddress,
        bridgeAgentAddress: bridgeWorker.agentAddress,
        bridgeSessionKey: bridgeWorker.sessionKey,
        kernelAddress: mandate.kernelAddress,
        baseVaults,
        totalAmount: 0,
        runId: strategyPlan.runId,
        grantTxHash: confirmed.txHash,
        onEvent: (name, data) => this.onEvent(name, data),
      })
    }
    const [stellarSettled, baseSettled] = await Promise.allSettled([
      runStellar(),
      runBase(),
    ])
    const stellarResults =
      stellarSettled.status === 'fulfilled'
        ? stellarSettled.value
        : stellarWorkers.map((worker) => ({
            allocationId: worker.allocationId,
            success: false,
            error: stellarSettled.reason?.message || String(stellarSettled.reason),
          }))
    const baseLeg =
      baseSettled.status === 'fulfilled'
        ? baseSettled.value
        : {
            success: false,
            runId: strategyPlan.runId,
            grantTxHash: confirmed.txHash,
            bridgeAgent: bridgeWorker.agentAddress,
            kernelAddress: mandate.kernelAddress,
            error: baseSettled.reason?.message || String(baseSettled.reason),
            allocations: bridgeChildren.map((child) => ({
              allocationId: child.allocationId,
              amount: child.allocation,
              success: false,
              custody: { location: 'owner', confirmed: true, checkedAt: null },
              error: baseSettled.reason?.message || String(baseSettled.reason),
            })),
          }
    const receipt = buildDispatchReceipt({
      plan: strategyPlan,
      permission: confirmed,
      branches: {
        stellar: { results: stellarResults },
        base: { status: baseLeg.success === false ? 'failed' : undefined, results: baseLeg.allocations || [] },
      },
    })
    const completed = stellarResults.filter((result) => result.success).length
    return {
      completed,
      failed: stellarResults.length - completed,
      results: stellarResults,
      sessionId: this.sessionId,
      permission: confirmed,
      baseLeg,
      receipt,
    }
  }

  /** Both modes: reject before any wallet/provider/movement when the reviewed decision no longer
   * describes THIS exact plan — a stale planFingerprint, or a reviewed agent whose cap/expiry/
   * period/target drifted from what the plan now says. `PermissionPhaseError(phase:'preflight')`.
   * Deliberately excludes signer/salt from this STRUCTURAL comparison — that verification is
   * mode-specific and happens separately, immediately before either mode's material actually gets
   * used: fresh mode's `grantFreshFromDecision` fetches + fingerprint-verifies the prepared
   * execution material (`fetchPreparedExecutionMaterial`, never regenerates it); reuse mode's
   * `revalidateReuse` re-proves signer continuity on-chain. */
  assertPermissionMatchesPlan(strategyPlan, permissionDecision, planAgents) {
    if (
      !permissionDecision ||
      strategyPlan.planFingerprint !== permissionDecision.planFingerprint
    ) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_PLAN_FINGERPRINT_MISMATCH',
        message: 'The reviewed permission decision no longer matches this plan.',
      })
    }
    const reviewed = permissionDecision.reviewedAgentInits || []
    const matches =
      planAgents.length === reviewed.length &&
      planAgents.every((agent, i) => {
        const r = reviewed[i]
        return (
          r &&
          r.allocationId === agent.allocationId &&
          r.kind === (agent.kind === 'bridge' ? AGENT_KIND_BRIDGE : AGENT_KIND_DEPOSIT) &&
          (agent.kind === 'bridge' || r.target === SOROBAN_ACTIVE_VAULT_ADDRESS) &&
          r.token === agent.cap.token &&
          r.cap?.token === agent.cap.token &&
          String(r.cap?.units) === String(agent.cap.units) &&
          Number(r.cap?.decimals) === Number(agent.cap.decimals) &&
          Number(r.periodSeconds) === Number(agent.periodSeconds) &&
          Number(r.expiry) === Number(agent.expiry)
        )
      })
    if (!matches) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_AGENT_INIT_FINGERPRINT_MISMATCH',
        message: 'The reviewed agent set no longer matches this plan.',
      })
    }
  }

  /**
   * Reuse mode's ONE revalidation gate, run immediately before the first pull. Never builds or
   * submits a grant, never touches the wallet/provider — it re-runs Task 5's own
   * `preflightPermission` (a fresh latest-ledger capture, a fresh no-later-mutation proof, a fresh
   * per-agent on-chain scope re-check) against the SAME reviewed agent set. Signer/salt are
   * deliberately OMITTED from the structural agentInits passed in — `preflightPermission` resolves
   * them itself from the SAME prepared-execution material this candidate's original fresh review
   * generated (reusePreflight.js), reproducing the review-time fingerprint exactly instead of this
   * method reconstructing (and hoping to match) it. Session-key AVAILABILITY (can we still sign
   * with the deployed agent?) is a separate, explicit check against agentCache.js, read exactly
   * once here and returned as `credentialByAllocation` so `buildReuseWorkers` never re-reads it.
   * Any drift — mode flips away from reuse, the receipt/agent-init fingerprint changes, a picked
   * address or its scope fingerprint changes, or a session key is no longer cached — is evidence
   * the world moved since review: `PermissionPhaseError(phase:'reuse-revalidation',
   * code:'VF_REUSE_EVIDENCE_CHANGED')`, never a silent fallback to a fresh wallet signature.
   * @returns {Promise<{revalidated:object, credentialByAllocation:Map}>}
   */
  async revalidateReuse(strategyPlan, permissionDecision, planAgents) {
    const { loadCachedAgents } = await import('./stellar/agentCache.js')
    const pickedByAllocation = new Map(
      (permissionDecision.agents || []).map((a) => [a.allocationId, a])
    )
    const cachedByAddress = new Map(
      loadCachedAgents({ owner: this.user, vault: SOROBAN_ACTIVE_VAULT_ADDRESS }).map((e) => [
        e.agentAddress,
        e,
      ])
    )

    const credentialByAllocation = new Map()
    const agentInits = planAgents.map((agent) => {
      const picked = pickedByAllocation.get(agent.allocationId)
      const cached = picked ? cachedByAddress.get(picked.agentAddress) : null
      if (!picked || !cached || !cached.secret) {
        throw new PermissionPhaseError({
          phase: 'reuse-revalidation',
          code: 'VF_REUSE_EVIDENCE_CHANGED',
          message: `The session key for allocation ${agent.allocationId} is no longer available.`,
        })
      }
      credentialByAllocation.set(agent.allocationId, { agentAddress: picked.agentAddress, cached })
      return {
        allocationId: agent.allocationId,
        cap: { token: agent.cap.token, units: agent.cap.units, decimals: agent.cap.decimals },
        token: agent.cap.token,
        target: SOROBAN_ACTIVE_VAULT_ADDRESS,
        kind: AGENT_KIND_DEPOSIT,
        mintRecipient: ZERO32,
        destinationDomain: 0,
        periodSeconds: agent.periodSeconds,
        expiry: agent.expiry,
      }
    })

    const { preflightPermission } = await import('./strategy/reusePreflight.js')
    let revalidated
    try {
      revalidated = await preflightPermission({
        runId: permissionDecision.runId,
        owner: this.user,
        planFingerprint: strategyPlan.planFingerprint,
        agentInits,
        reviewedBudgets: permissionDecision.reviewedBudgets,
        durationSeconds: permissionDecision.durationSeconds,
      })
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'reuse-revalidation',
        code: 'VF_REUSE_EVIDENCE_CHANGED',
        message: `Reuse revalidation failed: ${err.message}`,
        cause: err,
      })
    }

    const pickedAddressesMatch =
      revalidated.mode === 'reuse' &&
      revalidated.agents.length === (permissionDecision.agents || []).length &&
      revalidated.agents.every((a) => {
        const before = pickedByAllocation.get(a.allocationId)
        return (
          before &&
          before.agentAddress === a.agentAddress &&
          before.scopeFingerprint === a.scopeFingerprint
        )
      })

    if (
      revalidated.mode !== 'reuse' ||
      revalidated.agentInitFingerprint !== permissionDecision.agentInitFingerprint ||
      revalidated.grantReceiptFingerprint !== permissionDecision.grantReceiptFingerprint ||
      !pickedAddressesMatch
    ) {
      throw new PermissionPhaseError({
        phase: 'reuse-revalidation',
        code: 'VF_REUSE_EVIDENCE_CHANGED',
        message: 'Reuse evidence changed since it was reviewed.',
      })
    }

    return { revalidated, credentialByAllocation }
  }

  /** Task 2's `toDispatchStrategy` already narrows a StrategyPlan to eligible-only allocations
   * before it ever reaches dispatch — this worker-level check (worker.js "Enforcement B") is
   * defense-in-depth against an accidental code-path skip, not a second gate. A synthetic, freshly
   * timestamped pass token honestly reflects that upstream guarantee without re-plumbing Task 3's
   * eligibilityGate.js verdict objects through the plan/permission-decision contract.
   * // ponytail: synthetic pass token — revisit if a future task needs a real per-allocation
   * // eligibility verdict at this exact seam. */
  reviewedEligibilityToken() {
    return {
      protocolSlug: null,
      planIndex: 0,
      eligible: true,
      verdictHash: 'plan-reviewed',
      asOf: Date.now(),
    }
  }

  /** Reuse-mode worker construction: EXACTLY the credentials `revalidateReuse` just re-proved and
   * already read once (`credentialByAllocation`) — never a fresh deploy, never a different cache
   * pick, and never a SECOND cache read (a race between the two reads could otherwise disagree
   * with what was just revalidated). A credential missing here — it was already checked once in
   * `revalidateReuse`, so this is belt-and-braces, not the primary gate — is a typed
   * `PermissionPhaseError`, never a raw `TypeError` from indexing into `undefined`. */
  buildReuseWorkers(planAgents, revalidated, credentialByAllocation) {
    const pickedByAllocation = new Map(revalidated.agents.map((a) => [a.allocationId, a]))
    return planAgents.map((agent) => {
      const picked = pickedByAllocation.get(agent.allocationId)
      const credential = credentialByAllocation.get(agent.allocationId)
      if (!picked || !credential) {
        throw new PermissionPhaseError({
          phase: 'reuse-revalidation',
          code: 'VF_REUSE_EVIDENCE_CHANGED',
          message: `No validated credential for allocation ${agent.allocationId}.`,
        })
      }
      return new WorkerAgent({
        agentId: agent.allocationId,
        allocationId: agent.allocationId,
        user: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        // The plan's own bigint unit string, never a float re-multiplication of a decimal amount —
        // the validated plan and the executed units must be the exact same number.
        amount: BigInt(agent.cap.units),
        sessionId: this.sessionId,
        onEvent: this.onEvent,
        agentAddress: credential.agentAddress,
        sessionKey: newSessionKey(credential.cached.secret),
        eligibilityToken: this.reviewedEligibilityToken(),
      })
    })
  }

  /** Fresh-mode worker construction — no `agentAddress` yet (the grant deploys it). */
  buildFreshWorkers(planAgents) {
    return planAgents.map(
      (agent) =>
        new WorkerAgent({
          agentId: agent.allocationId,
          allocationId: agent.allocationId,
          user: this.user,
          vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
          // Same bigint-units rule as buildReuseWorkers above — see its comment.
          amount: BigInt(agent.cap.units),
          sessionId: this.sessionId,
          onEvent: this.onEvent,
          agentAddress: null,
          eligibilityToken: this.reviewedEligibilityToken(),
        })
    )
  }

  /**
   * Fresh mode's ONE grant. Builds AgentInits strictly from `permissionDecision.reviewedAgentInits`
   * — cap/token/target/kind/period/expiry/mintRecipient/destinationDomain are never regenerated
   * from the plan or a fresh `Date.now()` expiry. Critical fix (review round 2): the signer/salt
   * are ALSO never regenerated here — `w.setupKey()` and grant.js's random-salt fallback used to
   * mint UNREVIEWED material at dispatch time, poisoning the saved receipt's fingerprint forever
   * (a later preflight could never reproduce it, so `mode:'reuse'` became permanently
   * unreachable). Instead this fetches the material `preflightPermission` generated + persisted at
   * REVIEW time (reusePreflight.js's `fetchPreparedExecutionMaterial`) and VERIFIES it still
   * matches `reviewedAgentInits[].signerFingerprint`/`.saltFingerprint` before using it. Missing or
   * mismatched material invalidates the reviewed run — `PermissionPhaseError(phase:'fresh-grant',
   * code:'VF_PREPARED_MATERIAL_MISSING')` — never a silent re-generation. Any wallet rejection,
   * build/simulation failure, submission failure, or unconfirmed on-chain deployment is also
   * `PermissionPhaseError(phase:'fresh-grant')` — no worker ever starts. Calls `submitGrant`
   * exactly once; never touches the reuse cache reads.
   */
  async grantFreshFromDecision(strategyPlan, workers, permissionDecision) {
    const reviewedByAllocation = new Map(
      (permissionDecision.reviewedAgentInits || []).map((r) => [r.allocationId, r])
    )
    const { fetchPreparedExecutionMaterial } = await import('./strategy/reusePreflight.js')

    const agentInits = workers.map((w) => {
      const r = reviewedByAllocation.get(w.allocationId)
      const material = fetchPreparedExecutionMaterial({
        owner: this.user,
        planFingerprint: strategyPlan.planFingerprint,
        allocationId: w.allocationId,
        reviewedAgentInit: r,
      })
      if (!material) {
        throw new PermissionPhaseError({
          phase: 'fresh-grant',
          code: 'VF_PREPARED_MATERIAL_MISSING',
          message: `No prepared execution material for allocation ${w.allocationId} matches the reviewed decision. This run must be re-reviewed.`,
        })
      }
      w.sessionKey = newSessionKey(material.signerSecret)
      return {
        signer: material.signer,
        salt: material.salt,
        cap: BigInt(r.cap.units),
        token: r.cap.token,
        target: r.target,
        kind: r.kind,
        mintRecipient: r.mintRecipient ? hexToBytes32(r.mintRecipient) : ZERO32,
        destinationDomain: r.destinationDomain ?? 0,
        periodDuration: r.periodSeconds,
        expiry: r.expiry,
      }
    })
    const budgets = (permissionDecision.reviewedBudgets || []).map((b) => ({
      budget: BigInt(b.units),
      token: b.token,
    }))

    let submitted
    try {
      submitted = await submitGrant({
        owner: this.user,
        budgets,
        durationSeconds: permissionDecision.durationSeconds,
        agentInits,
      })
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: err instanceof PermissionPhaseError ? err.code : 'VF_GRANT_FAILED',
        message: err.message,
        cause: err,
      })
    }
    if (
      !submitted?.hash ||
      !Array.isArray(submitted.agentAddresses) ||
      submitted.agentAddresses.length !== workers.length ||
      submitted.agentAddresses.some((address) => typeof address !== 'string' || address.length === 0)
    ) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: 'VF_GRANT_EVIDENCE_MISSING',
        message: 'The grant did not return a complete reviewed agent deployment record.',
      })
    }

    const { readConfirmedLedger } = await import('./stellar/grant.js')
    let confirmedLedger
    let confirmedAt
    try {
      ;({ confirmedLedger, confirmedAt } = await readConfirmedLedger({ hash: submitted.hash }))
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: 'VF_GRANT_UNCONFIRMED',
        message: `The grant did not confirm on-chain: ${err.message}`,
        cause: err,
      })
    }

    workers.forEach((w, i) => {
      w.agentAddress = submitted.agentAddresses[i]
      saveCachedAgent({
        owner: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        entry: {
          agentAddress: w.agentAddress,
          secret: w.sessionKey.secret,
          signerPub: w.sessionKey.publicKey,
          cap: String(w.amount),
          expiry: reviewedByAllocation.get(w.allocationId).expiry,
          createdAt: Date.now(),
        },
      })
    })

    // Save + fingerprint the GrantReceiptV1 BEFORE dispatchPermissioned emits 'grant-confirmed' —
    // that event IS the "permission is now active" signal a caller (app.jsx) waits on, so the
    // receipt must already be durable when it fires.
    const { buildGrantReceiptV1, saveGrantReceipt, fingerprintGrantReceipt } =
      await import('./stellar/grantReceiptStore.js')
    const { SOROBAN_FUNDING_ROUTER_ADDRESS } = await import('./stellar/config.js')
    const receipt = buildGrantReceiptV1({
      runId: strategyPlan.runId,
      owner: this.user,
      router: SOROBAN_FUNDING_ROUTER_ADDRESS,
      txHash: submitted.hash,
      confirmedLedger,
      expiryLedger: submitted.expiryLedger,
      allowanceBudgets: permissionDecision.reviewedBudgets,
      agentInitFingerprint: permissionDecision.agentInitFingerprint,
      agentAddresses: submitted.agentAddresses,
      confirmedAt,
    })
    saveGrantReceipt({ receipt })

    return {
      agentAddresses: submitted.agentAddresses,
      txHash: submitted.hash,
      expiryLedger: submitted.expiryLedger,
      confirmedLedger,
      confirmedAt,
      grantReceiptFingerprint: fingerprintGrantReceipt(receipt),
    }
  }

  async dispatchLegacy(strategy, totalAmount) {
    const allVaults = strategy.vaults || []
    const receiptRunId = strategy.runId || this.sessionId
    const baseVaults = allVaults
      .filter((v) => v.chain === 'base')
      .map((vault, index) => ({
        ...vault,
        allocationId: vault.allocationId || `${receiptRunId}:bridge:${index}`,
      }))
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
        // Review round 2 fix: the per-vault ON-CHAIN unit amount is derived via
        // decimalToUnits(totalAmount) + a bigint-exact ratio split (splitUnitsByRatio above) —
        // never `Math.floor(totalAmount * v.allocation * BASE_UNIT)`, whose float multiplication
        // landed directly in the deploy/fund/deposit amount. `amountVfusd` stays float — it is
        // display-only (skill-gen prompt text), never converted to an on-chain unit itself.
        const runTotalUnits = toBaseUnits(totalAmount)
        const perVaultUnits = splitUnitsByRatio(
          runTotalUnits,
          stellarStrategy.vaults.map((v) => v.allocation)
        )
        const vaultPlans = stellarStrategy.vaults.map((v, i) => ({
          index: i,
          agentId: makeAgentId(i, this.sessionId),
          allocationId: v.allocationId || `${receiptRunId}:deposit:${i}`,
          vault: v.address,
          protocolSlug: v.protocolSlug || null,
          eligibilityToken: v.eligibilityToken || null,
          amountVfusd: totalAmount * v.allocation,
          amountUnits: perVaultUnits[i],
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
              allocationId: p.allocationId,
              user: this.user,
              vault: p.vault,
              amount: p.amountUnits,
              sessionId: this.sessionId,
              onEvent: this.onEvent,
              agentAddress: null, // set right after the per-worker deploy below
              eligibilityToken: p.eligibilityToken,
            })
        )

        // Agent setup — the funding router is MANDATORY in production (My Money Task 1): the
        // router path is the only one that ever creates a production agent, and a missing/
        // unhealthy router fails HERE, before any wallet signature or fund movement, rather than
        // silently sliding into a legacy deploy. `setupLegacy` survives ONLY as an explicit
        // dev/test compatibility seam — never a production fallback — gated by
        // `isLegacyDirectSetupAllowed`: production can never enable it through a client flag
        // (Vite bakes VITE_ vars into the client bundle; trusting one for a production
        // authorization decision would let anyone flip it via devtools), dev/test must opt in
        // EXPLICITLY via VITE_ENABLE_LEGACY_AGENT_SETUP=true. Both paths isolate a single agent's
        // setup failure (that worker fails, the run continues) and abort only when EVERY agent
        // failed. The pending/error/done step events are emitted HERE so every reachable path
        // reports identically.
        this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
        if (USE_FUNDING_ROUTER) {
          await this.setupViaRouter(workers, expiry, bridgeInit, resolveBridgeAgent)
        } else if (
          isLegacyDirectSetupAllowed({
            mode: import.meta.env.MODE,
            explicitFlag: import.meta.env.VITE_ENABLE_LEGACY_AGENT_SETUP,
          })
        ) {
          await this.setupLegacy(workers, expiry)
        } else {
          throw new Error('Pocket Crew requires the funding router; no transaction was submitted.')
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
          allocationId: vaultPlans[i].allocationId,
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
    // Base leg contract says it never rejects — this is belt-and-braces in case a future change
    // (or a bug) breaks that contract; map to the same shape executeBaseLeg would have returned.
    const baseLeg =
      baseSettled.status === 'fulfilled'
        ? baseSettled.value
        : { success: false, stage: 'dispatch', error: baseSettled.reason?.message }
    if (
      stellarSettled.status === 'rejected' &&
      (baseVaults.length === 0 || /No bridge agent was deployed/.test(baseLeg?.error || ''))
    ) {
      throw stellarSettled.reason
    }
    const stellarSummary =
      stellarSettled.status === 'fulfilled'
        ? stellarSettled.value
        : {
            completed: 0,
            failed: stellarVaults.length,
            results: stellarVaults.map((vault, index) => ({
              allocationId: vault.allocationId || `${receiptRunId}:deposit:${index}`,
              success: false,
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              error: stellarSettled.reason?.message || String(stellarSettled.reason),
            })),
            sessionId: this.sessionId,
            agentAddresses: [],
          }

    // Legacy callers have not yet migrated to StrategyPlan/PermissionConfirmedV1, but a mixed
    // execution still deserves the exact same custody receipt. Its synthetic plan is derived
    // solely from the integer amounts used by this dispatch; it never converts display floats.
    const stellarPlan = stellarSummary.results.map((result, index) => ({
      allocationId: result.allocationId,
      kind: 'deposit',
      allocation: {
        token: SOROBAN_TOKEN_ADDRESS,
        units: String(
          // vaultPlans is local to runStellarLegs, so the worker amount is reflected in the
          // result only indirectly. Recompute with the same exact splitter used above.
          splitUnitsByRatio(
            toBaseUnits(totalAmount),
            stellarStrategy.vaults.map((vault) => vault.allocation)
          )[index] || 0n
        ),
        decimals: SOROBAN_DECIMALS,
      },
    }))
    const baseEvidence =
      baseLeg?.allocations?.length > 0
        ? baseLeg.allocations
        : baseVaults.map((vault, index) => {
            const { baseTargetUnits6 } = deriveCctpTransferUnits(totalAmount * vault.allocation)
            return {
              allocationId: vault.allocationId,
              amount: { token: 'USDC', units: String(baseTargetUnits6), decimals: 6 },
              success: baseLeg?.success === true,
              finalStatus: baseLeg?.finalStatus || (baseLeg?.success ? 'done' : 'error'),
              error: baseLeg?.error || null,
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              ...baseLeg,
              allocationId: vault.allocationId,
            }
          })
    const receiptPlan = {
      runId: receiptRunId,
      planFingerprint: strategy.planFingerprint || null,
      agents: [
        ...stellarPlan,
        ...(baseVaults.length
          ? [
              {
                allocationId: `${receiptRunId}:bridge`,
                kind: 'bridge',
                children: baseEvidence.map((entry) => ({
                  allocationId: entry.allocationId,
                  allocation: entry.amount,
                })),
              },
            ]
          : []),
      ],
    }
    const receipt = buildDispatchReceipt({
      plan: receiptPlan,
      permission: {
        mode: 'fresh',
        txHash: baseLeg?.grantTxHash || null,
        grantReceiptFingerprint: null,
        expiryLedger: null,
        agentAddresses: stellarSummary.agentAddresses || [],
      },
      branches: {
        stellar: { results: stellarSummary.results },
        base: {
          status: baseLeg?.success === false ? 'failed' : undefined,
          results: baseEvidence,
        },
      },
    })
    return { ...stellarSummary, baseLeg, receipt }
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

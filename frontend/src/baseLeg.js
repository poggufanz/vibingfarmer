// frontend/src/baseLeg.js
// The Base leg of a mixed strategy, packaged as ONE settled unit for the orchestrator. Per the
// grant-covers-burn design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md §4-5):
// the run's SINGLE funding_router grant already deployed this leg's bridge agent — folded in
// alongside the Stellar deposit workers' agent inits by orchestrator.js (see
// OrchestratorAgent.grantFreshAgents) — and a valid durable Base mandate is GUARANTEED to already
// be stored (app.jsx's preflight refuses to offer Base pools otherwise, mergeFlowHelpers.js's
// checkStoredBaseMandate). So this function never runs a passkey ceremony: no ensureBaseOwner, no
// createMandate, no second grant, no signTx. It only: re-validates the stored mandate is still
// live (a TOCTOU guard between strategy generation and dispatch), quotes the Base allocations,
// relays the pull+burn via the bridge agent's session key (both params it receives), then hands
// off to crossChainFarm's existing relayerClient /farm flow. Never throws — every failure resolves
// { success:false, stage, error } so a Base failure can never abort the Stellar workers beside it.
import {
  getMandateStatus as defaultGetMandateStatus,
  quantizeAllocations,
} from './base/relayerClient.js'
import { runFarmFlow as defaultRunFarmFlow } from './crossChainFarm.js'
import { runAgentPull as defaultRunAgentPull } from './stellar/grant.js'
import { runAgentBurn as defaultRunAgentBurn } from './stellar/agentBurn.js'
import { evmAddrToBytes32 } from './stellar/cctpBurn.js'
import { deriveCctpTransferUnits } from './stellar/format.js'
import { BASE_POOL_CATALOG } from './config.js'
import { estimateMinShares as defaultEstimateMinShares } from './base/quotes.js'
import { defaultMakePublicClient } from './wallet/passkeyBase.js'
import { readBaseMandate, validateBaseMandate } from './wallet/baseBinding.js'
import { isVerifiedBaseMandateStatus } from './base/mandateStatus.js'
import { BASE_CROSS_CHAIN_AVAILABLE, BASE_CROSS_CHAIN_UNAVAILABLE_REASON } from './base/config.js'

const PUBLIC_SENSITIVE =
  /secret|private|capability|bearer|authorization|cookie|wallet|passkey|signedxdr|approval|session/i

// This is intentionally stricter than dispatchSummary's legacy receipt sanitizer: Base-leg
// failures can contain SDK error objects, so this boundary must never copy arbitrary dependency
// data into receipts, events, or UI state.
function publicEvidence(value, seen = new WeakSet()) {
  if (value == null) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return PUBLIC_SENSITIVE.test(value) ? null : value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object' || seen.has(value)) return null
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    return value
      .map((entry) => publicEvidence(entry, seen))
      .filter(
        (entry) =>
          entry !== null &&
          !(Array.isArray(entry) && entry.length === 0) &&
          !(
            entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            Object.keys(entry).length === 0
          )
      )
  }
  const projection = {}
  for (const [key, entry] of Object.entries(value)) {
    if (PUBLIC_SENSITIVE.test(key)) continue
    const safe = publicEvidence(entry, seen)
    if (safe !== null) projection[key] = safe
  }
  return projection
}

function baseFailureCode(stage) {
  return stage === 'burn'
    ? 'base_burn_unavailable'
    : stage === 'mandate'
      ? 'base_mandate_unavailable'
      : 'base_farm_unavailable'
}

function publicCustody(remote) {
  const custody = remote?.custody
  if (
    custody &&
    typeof custody === 'object' &&
    typeof custody.location === 'string' &&
    typeof custody.confirmed === 'boolean' &&
    (custody.checkedAt === null || Number.isSafeInteger(custody.checkedAt))
  ) {
    return {
      location: custody.location,
      confirmed: custody.confirmed,
      checkedAt: custody.checkedAt,
    }
  }
  return { location: 'unknown', confirmed: false, checkedAt: null }
}

function unknownSubmissionRecoveryPhase(stage) {
  if (stage === 'pull') return { phase: 'pull', action: 'reconcile-pull' }
  if (stage === 'burn' || stage === 'cctp_burn') {
    return { phase: 'cctp_burn', action: 'reconcile-cctp-burn' }
  }
  return { phase: 'unknown', action: 'reconcile-unknown-base-submission' }
}

function hasCompleteDeliveredEvidence(result, expectedAllocations, { bindingId, runId, jobId }) {
  if (result.associationDelivery?.complete !== true || result.associationDelivery?.blocked === true)
    return false
  if (result.evidenceDelivery?.complete !== true || result.evidenceDelivery?.blocked === true)
    return false
  if (
    !Array.isArray(result.allocations) ||
    result.allocations.length !== expectedAllocations.length
  )
    return false
  return expectedAllocations.every((allocation) => {
    const matches = result.allocations.filter(
      (entry) => entry?.allocationId === allocation.allocationId
    )
    const entry = matches[0]
    return (
      matches.length === 1 &&
      entry?.bindingId === bindingId &&
      entry?.executionId === `${runId}:exec:${allocation.allocationId}` &&
      entry?.childId === jobId &&
      /^0x[0-9a-f]{64}$/.test(entry.userOpHash || '') &&
      /^0x[0-9a-f]{64}$/.test(entry.mintTxHash || '') &&
      /^0x[0-9a-f]{64}$/.test(entry.depositTxHash || '') &&
      Number.isSafeInteger(entry.recoveryVersion) &&
      entry.recoveryVersion >= 0
    )
  })
}

/**
 * @param {{
 *   connectedAddress: string,          // Stellar wallet — used only for logging/identity, never signs here
 *   bridgeAgentAddress: string,        // this leg's bridge agent, deployed by the run's ONE grant
 *   bridgeSessionKey: object,          // that agent's session key (signs pull + deposit_for_burn)
 *   kernelAddress: string,             // Base owner address the SAME grant pinned as mint_recipient —
 *                                      // sourced from orchestrator.js's OWN read of vf_base_mandate, never
 *                                      // re-read here, so a mid-run mandate rotation can't desync the
 *                                      // runtime burn arg from what's actually pinned on-chain.
 *   baseVaults: Array<{address:string, allocation:number}>,
 *   totalAmount: number,
 *   runId?: string,
 *   grantTxHash?: string,
 *   onEvent?: Function,
 *   deps?: object,
 * }} p
 * @returns {Promise<{success:boolean, burnHash?:string, jobId?:string, finalStatus?:string,
 *          baseAccount?:string, stage?:string, error?:string, pulled?:boolean,
 *          bridgeAgentAddress?:string}>}
 */
export async function executeBaseLeg({
  connectedAddress,
  bridgeAgentAddress,
  bridgeSessionKey,
  kernelAddress,
  baseVaults,
  totalAmount,
  runId = null,
  grantTxHash = null,
  onEvent = () => {},
  deps = {},
}) {
  // Global deployment authority fence: this precedes dependency selection, mandate reads,
  // quoting, client creation, pulls, and burns. Keep executeBaseLeg's settled-result contract.
  if (!BASE_CROSS_CHAIN_AVAILABLE) {
    return {
      success: false,
      runId,
      grantTxHash,
      stage: 'availability',
      error: BASE_CROSS_CHAIN_UNAVAILABLE_REASON,
      custody: { location: 'owner', confirmed: true, checkedAt: null },
      bridgeAgent: bridgeAgentAddress || null,
      kernelAddress: kernelAddress || null,
      jobId: null,
      attestation: null,
      recovery: null,
      allocations: [],
    }
  }

  // ponytail: `deps = {}` default only covers undefined; an explicit `deps: null` would throw
  // synchronously on the destructure below, outside the try — guard normalizes both.
  const {
    getMandateStatus = defaultGetMandateStatus,
    runFarmFlow = defaultRunFarmFlow,
    estimateMinShares = defaultEstimateMinShares,
    makePublicClient = defaultMakePublicClient,
    runAgentPull = defaultRunAgentPull,
    runAgentBurn = defaultRunAgentBurn,
    // VF Wallet Task 6: owner+kernel-scoped v3 mandate (wallet/baseBinding.js), never the legacy
    // global vf_base_mandate record — the whole point of this task is that a mismatched owner or
    // kernel fails closed HERE, before any funds move, rather than trusting storage content alone.
    readStoredMandate = readBaseMandate,
  } = deps || {}

  // Strategy Task 13 (Pocket Crew redesign, decision log #22 obligation C): every leg-level event
  // this function emits, AND every event crossChainFarm.js's runFarmFlow emits through the onEvent
  // it is handed below, gets the PARENT bridge agent's own allocationId attached here -- the same
  // canonical `${runId}:bridge:base` planModel.js's expandAgentSlots mints for a plan's single
  // top-level bridge agent (allocationId(runId, 'bridge', 'base')). Derivable from `runId` alone
  // because a reviewed execution may contain at most one bridge agent (orchestrator.js's own
  // VF_MULTIPLE_BRIDGE_AGENTS guard) -- no new param from the caller is needed. Before this, no
  // farm-*/baseleg-* event carried allocationId at all (orchestrator.js forwards its onEvent to
  // executeBaseLeg unwrapped, and executeBaseLeg forwarded it to runFarmFlow unmodified in turn),
  // so flowState.js's BASE_JOB_UPDATED custody entry for a bridge lane could never be keyed.
  // Fixed HERE, not in orchestrator.js (owner-modified, off-limits to stage) — this file and
  // crossChainFarm.js are both clean, and this is the one seam every leg-level event already
  // funnels through.
  const bridgeAllocationId = `${runId || 'unrun'}:bridge:base`
  const safeEmit = (name, data) => {
    try {
      const event = publicEvidence(data)
      onEvent(name, {
        ...(event && typeof event === 'object' && !Array.isArray(event) ? event : {}),
        allocationId: bridgeAllocationId,
      })
    } catch {
      // onEvent is caller UI glue — a broken listener must never abort a settled leg.
    }
  }

  let stage = 'mandate'
  // Set true once the relayed pull confirms — funds have left the owner into the bridge agent.
  // Declared here (not inside `try`) so the `catch` block below can still read it.
  let fundsPulled = false
  try {
    if (!bridgeAgentAddress) {
      throw new Error('No bridge agent address was provided — the run grant must supply one.')
    }
    if (!kernelAddress) {
      throw new Error('No Base kernel address was provided — the run grant must supply one.')
    }
    // Re-validate right before spending it (TOCTOU guard: the app.jsx preflight checked this
    // during strategy generation, which can be minutes before dispatch). No ceremony fallback —
    // mandate setup is its own per-window moment, never something a run performs.
    //
    // VF Wallet Task 6: fail-closed BINDING check first (owner + kernel must match what this
    // grant actually pinned on-chain), then a live relayer confirmation. A binding mismatch is
    // reported distinctly from "expired" — it means the wrong mandate is in storage for this
    // owner/kernel pair, not merely a stale-but-otherwise-correct one.
    const storedMandate = readStoredMandate(connectedAddress)
    const localStatus = validateBaseMandate(storedMandate, {
      stellarOwner: connectedAddress,
      kernelAddress,
    })
    if (localStatus === 'missing') throw new Error('No durable Base mandate is stored.')
    if (localStatus !== 'active') {
      throw new Error(`The stored Base mandate is ${localStatus} for this owner/kernel.`)
    }
    // ownerAddress comes from the CALLER's kernelAddress param (the exact value orchestrator.js
    // already used to pin this grant's mint_recipient on-chain), never re-read from storage here —
    // a mid-run mandate rotation must not desync the runtime burn arg from the pinned scope.
    const ownerAddress = kernelAddress
    // publicClient is a bare read-only RPC client (same one base/dashboardPositions.js uses, via
    // passkeyBase.js's exported defaultMakePublicClient) — live minShares quoting needs chain
    // reads, not wallet auth.
    const publicClient = makePublicClient()
    safeEmit('baseleg-owner', { status: 'done', ownerMode: 'mandate', address: ownerAddress })

    const exactBaseUnits = baseVaults.every((vault) => typeof vault.amountBaseUnits === 'bigint')
      ? baseVaults.reduce((sum, vault) => sum + vault.amountBaseUnits, 0n)
      : null
    // NOTE (reality vs brief): deriveCctpTransferUnits returns
    // { requestedUnits7, baseTargetUnits6, burnUnits7, retainedDustUnits7 } — there is no
    // units7/units6 pair. burnUnits7 is the 7dp burn amount; baseTargetUnits6 is the exact 6dp
    // Base-side total that quantizeAllocations must apportion across (burnUnits7 = baseTargetUnits6 * 10n).
    const { burnUnits7, baseTargetUnits6 } =
      exactBaseUnits != null
        ? { burnUnits7: exactBaseUnits * 10n, baseTargetUnits6: exactBaseUnits }
        : deriveCctpTransferUnits(
            baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
          )
    const allocations = quantizeAllocations(
      baseVaults.map((v) => {
        const cat = BASE_POOL_CATALOG.find(
          (p) => p.address.toLowerCase() === v.address.toLowerCase()
        )
        return {
          allocationId: v.allocationId || null,
          allocationAmount: v.allocationAmount || null,
          amountBaseUnits: v.amountBaseUnits,
          pool: v.address,
          protocol: cat?.protocol,
          amount: totalAmount * v.allocation,
        }
      }),
      { targetUnits: baseTargetUnits6 }
    )
    // Execution-time slippage guard: quote live convertToShares per pool right before the burn,
    // replacing the old hardcoded minShares: 1n no-op (see base/quotes.js).
    const quotedAllocations = await Promise.all(
      allocations.map(async (a) => ({
        ...a,
        minShares: await estimateMinShares({
          pool: a.pool,
          amountBaseUnits: a.amountBaseUnits,
          publicClient,
        }),
      }))
    )

    // Last browser-side gate before runFarmFlow is allowed to durably commit an intent and burn:
    // exactly ONE amount-free live status check, performed after every allocation's live quote and
    // immediately before the farm dispatch. The mandate is named by its public mandateId only —
    // no allocation, pool, amount, or minShares crosses this boundary (the relayer's v3
    // activation evidence already binds the policy); pending/uncertain/revoked/expired/mismatch/
    // unknown/malformed evidence, or a transport failure, all fail closed HERE before money moves.
    let evidence = null
    try {
      evidence = await getMandateStatus(storedMandate.mandateId, {
        stellarOwner: connectedAddress,
        kernelAddress,
      })
    } catch {
      evidence = null
    }
    if (!isVerifiedBaseMandateStatus(evidence)) {
      throw new Error('The stored Base mandate is no longer valid.')
    }
    if (
      (evidence.expected?.bindingId !== undefined &&
        evidence.expected.bindingId !== storedMandate.bindingId) ||
      (evidence.expected?.bindingHash !== undefined &&
        evidence.expected.bindingHash !== storedMandate.bindingHash)
    ) {
      throw new Error('The stored Base mandate binding evidence changed.')
    }
    safeEmit('baseleg-mandate', {
      status: 'done',
      sessionKeyAddress: storedMandate.sessionKeyAddress,
      validUntilSeconds: storedMandate.validUntilSeconds,
      reused: true,
    })

    stage = 'farm'
    // Grant-covered burn: pull moves burnUnits7 from the owner into the bridge agent (relayed,
    // session-key signed), then the SAME session key authorizes the burn itself — the Stellar
    // wallet never signs or pays for either step (it already signed once, in the run's single
    // grant, before this function was even called). Both failures are re-thrown as-is;
    // crossChainFarm catches them and fires 'farm-failed' with stage:'burn', same contract
    // burnViaWallet's old (now-retired-from-this-flow) path had.
    const mintRecipient32 = evmAddrToBytes32(ownerAddress)
    // Once the pull confirms, funds have LEFT the owner and are sitting in the bridge agent — any
    // failure after that point is a "stranded, recoverable via owner sweep" state, not a "nothing
    // moved" one. `stage` flips to 'burn' right there so a pull-ok/burn-fails outcome is reported
    // distinctly from an unstarted one, and `fundsPulled`/`bridgeAgentAddress` ride along in the
    // failure payload below as the recovery handle (an owner_withdraw sweep target).
    const result = await runFarmFlow({
      stellarWallet: { address: connectedAddress },
      baseRecipientAddress: ownerAddress,
      sessionKeyAddress: storedMandate.sessionKeyAddress,
      mandateId: storedMandate.mandateId,
      bindingId: storedMandate.bindingId,
      bindingHash: storedMandate.bindingHash,
      allocations: quotedAllocations,
      burnUnits7,
      // Threaded through to postFarm's owner-bound wire contract. The bridge agent is the
      // recovery handle for a stranded-funds sweep; runId/grantTxHash correlate this job to the
      // shared grant receipt without exposing its session key.
      bridgeAgentAddress,
      runId,
      grantTxHash,
      // safeEmit (not the raw onEvent param) so every farm-* event ALSO carries the bridge
      // agent's allocationId -- see the safeEmit declaration above.
      onEvent: safeEmit,
      deps: {
        burn: async ({ amountUnits }) => {
          const pullRes = await runAgentPull({
            agentAddress: bridgeAgentAddress,
            amount: amountUnits,
            sessionKey: bridgeSessionKey,
          })
          if (!pullRes) throw new Error('The Stellar relay is unavailable for the CCTP burn.')
          if (pullRes.status !== 'SUCCESS')
            throw new Error(`The bridge agent funding pull returned ${pullRes.status}.`)
          fundsPulled = true
          stage = 'burn'
          const burned = await runAgentBurn({
            bridgeAgentAddress,
            amountUnits,
            mintRecipient: mintRecipient32,
            sessionKey: bridgeSessionKey,
          })
          if (!burned) throw new Error('The Stellar relay is unavailable for the CCTP burn.')
          return burned
        },
      },
    })
    const deliveryComplete = hasCompleteDeliveredEvidence(result, quotedAllocations, {
      bindingId: storedMandate.bindingId,
      runId,
      jobId: result.jobId,
    })
    const childResults = quotedAllocations.map((allocation, i) => {
      const remote =
        (result.allocations || []).find(
          (entry) => entry?.allocationId === allocation.allocationId
        ) || null
      const childError = !remote
        ? 'Base evidence is unavailable for this allocation.'
        : result.success === false
          ? 'base_farm_unavailable'
          : null
      const childSuccess =
        deliveryComplete &&
        Boolean(remote) &&
        remote.success !== false &&
        remote.finalStatus !== 'error' &&
        !childError
      return {
        allocationId: allocation.allocationId || `${runId ?? 'run'}-${i}`,
        bindingId: remote?.bindingId || null,
        executionId: remote?.executionId || null,
        childId: remote?.childId || null,
        amount: allocation.allocationAmount || {
          token: 'USDC',
          units: String(allocation.amountBaseUnits),
          decimals: 6,
        },
        burnHash: result.burnHash || null,
        jobId: result.jobId || null,
        bridgeAgentAddress,
        kernelAddress: ownerAddress,
        attestation: publicEvidence(
          remote?.attestation || result.attestation || result.attestationState || null
        ),
        recovery: publicEvidence(remote?.recovery || result.recovery || null),
        finalStatus: remote?.finalStatus || result.finalStatus || null,
        mintTxHash: remote?.mintTxHash || null,
        depositTxHash: remote?.depositTxHash || null,
        userOpHash: remote?.userOpHash || null,
        recoveryVersion: remote?.recoveryVersion ?? null,
        custody: publicCustody(remote),
        success: childSuccess,
        error: childError,
      }
    })
    const success = result.success !== false && childResults.every((child) => child.success)
    const error = success ? null : baseFailureCode(result.stage || 'farm')
    return {
      success,
      runId,
      grantTxHash,
      burnHash: result.burnHash,
      jobId: result.jobId,
      finalStatus: result.finalStatus,
      baseAccount: ownerAddress,
      bridgeAgentAddress,
      kernelAddress: ownerAddress,
      stage: success ? undefined : 'farm',
      error,
      attestation: publicEvidence(result.attestation || result.attestationState || null),
      recovery: publicEvidence(result.recovery || null),
      allocations: childResults,
    }
  } catch (err) {
    // A dependency can reject with anything (bare string, null, plain object) — never assume
    // Error shape, or reading .message here would itself throw and break the never-throws contract.
    const failureEvidence = err && typeof err === 'object' ? err : {}
    const submissionUnknown = failureEvidence.code === 'VF_SUBMISSION_UNKNOWN'
    const reportedStage = ['pull', 'burn', 'cctp_burn'].includes(failureEvidence.stage)
      ? failureEvidence.stage
      : stage
    const reconciliation = unknownSubmissionRecoveryPhase(reportedStage)
    const error = submissionUnknown ? 'base_submission_unknown' : baseFailureCode(reportedStage)
    const uncertaintyRecovery = submissionUnknown
      ? {
          action: reconciliation.action,
          phase: reconciliation.phase,
          reasonCode: 'submission_unknown',
          evidence: {
            submission: 'unknown',
            stage: reconciliation.phase,
            ...(reportedStage !== reconciliation.phase ? { reportedStage } : {}),
            ...(failureEvidence.result !== undefined
              ? { result: publicEvidence(failureEvidence.result) }
              : {}),
          },
        }
      : null
    const failureRecovery = publicEvidence(failureEvidence.recovery || uncertaintyRecovery || null)
    // Stranded-funds observability: once the pull confirmed, the bridge agent is holding the
    // owner's USDC — surface that + the recovery handle (bridgeAgentAddress, for an owner_withdraw
    // sweep) in BOTH the event and the return value, so a pull-ok/burn-fails outcome is never
    // indistinguishable from a nothing-moved one.
    const strandedFunds = fundsPulled ? { pulled: true, bridgeAgentAddress } : {}
    const failureCustody = submissionUnknown
      ? { location: 'unknown', confirmed: false, checkedAt: null }
      : fundsPulled
        ? { location: 'agent', confirmed: true, checkedAt: null }
        : { location: 'owner', confirmed: true, checkedAt: null }
    const allocations = (baseVaults || []).map((vault, i) => ({
      allocationId: vault.allocationId || `${runId ?? 'run'}-${i}`,
      amount: vault.allocationAmount || {
        token: 'USDC',
        units: String(deriveCctpTransferUnits(totalAmount * vault.allocation).baseTargetUnits6),
        decimals: 6,
      },
      finalStatus: 'error',
      stage,
      custody: failureCustody,
      error,
      bridgeAgentAddress: bridgeAgentAddress || null,
      kernelAddress: kernelAddress || null,
      jobId: failureEvidence.jobId || null,
      attestation: publicEvidence(
        failureEvidence.attestation || failureEvidence.attestationState || null
      ),
      recovery: failureRecovery,
    }))
    safeEmit('baseleg-failed', {
      stage,
      error,
      custody: failureCustody,
      recovery: failureRecovery,
      ...strandedFunds,
    })
    return {
      success: false,
      runId,
      grantTxHash,
      stage,
      error,
      custody: failureCustody,
      // Preserve the established recovery signal: bridgeAgentAddress appears only once a pull
      // actually stranded funds. `bridgeAgent` still identifies the deployed agent for receipts.
      bridgeAgent: bridgeAgentAddress || null,
      kernelAddress: kernelAddress || null,
      jobId: failureEvidence.jobId || null,
      attestation: publicEvidence(
        failureEvidence.attestation || failureEvidence.attestationState || null
      ),
      recovery: failureRecovery,
      allocations,
      ...strandedFunds,
    }
  }
}

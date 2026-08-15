// frontend/src/components/strategy/StartStage.jsx
// Strategy Task 12 (Pocket Crew redesign, Wave 5). The "Start" surface: real per-agent execution
// lanes while a confirmed run dispatches, and (once settled) the custody receipt (StrategyReceipt).
// A pure component tree, same convention as PlanStage/ProtectStage: no data fetching, no
// wallet/relayer reads. Every fact this file renders comes from either a real orchestrator event
// already observed (`events`, growing over time) or the settled `DispatchReceiptV1` (`receipt`,
// null until the whole run resolves) -- never a timer, never an optimistic guess.
//
// Step 2's "pure adapter" (`depositLanePhase`/`bridgeLanePhase` below): the REAL event names and
// payload shapes this file maps are read directly from the producers, cited by file:line so a
// reviewer can verify every mapped name against the actual emitter (Task 11's own defect was a
// fixture encoding a shape no producer could emit -- this header exists so that mistake is
// checkable here too):
//   orchestrator.js:409  'reuse-confirmed' {runId, confirmed, agentAddresses} -- reuse mode; the
//                        agent already existed, nothing was created this run.
//   orchestrator.js:430  'grant-confirmed' {runId, confirmed, budgets, agentAddresses} -- fresh
//                        mode; the ONE grant transaction just deployed every agent_account.
//   orchestrator.js:458,526  'worker-queued' {allocationId, agentId, agent, queueIndex} -- fired
//                        for every worker up front, before any turn begins (queue order visible).
//   orchestrator.js:469,537  'worker-started' {allocationId, agentId, agent, queueIndex} -- this
//                        worker's turn begins; the owner->agent pull happens next (no dedicated
//                        event wraps the pull itself in orchestrator.js today).
//   worker.js:75         'started' {agentId, vault, allocationId} (worker.js:191-193's `emit`
//                        wrapper always attaches agentId/allocationId).
//   worker.js:64,69      'step' {step:'key-setup', status:'pending'|'done', allocationId}
//   worker.js:81         'step' {step:'swap', status:'skipped', allocationId} (Stellar is
//                        deposit-only; this always fires skipped, never pending/done).
//   worker.js:125        'step' {step:'deposit', status:'pending', allocationId} -- the
//                        vault.deposit auth entry is now in flight.
//   worker.js:154        'completed' {agentId, vault, txHash, gasMethod, relayer, allocationId}
//   worker.js:113,167    'failed' {agentId, vault, error, skipped?, allocationId}
//   baseLeg.js:133       'baseleg-owner' {status:'done', ownerMode, address}
//   baseLeg.js:174       'baseleg-mandate' {status:'done', sessionKeyAddress, expiry, reused}
//   crossChainFarm.js:113  'farm-burn-started' {address, amountUnits}
//   crossChainFarm.js:126  'farm-burn-confirmed' {burnHash}
//   crossChainFarm.js:151  'farm-relay-dispatched' {jobId, sessionKeyAddress}
//   crossChainFarm.js:154  'farm-completed' {jobId, status:'done'|'error'|'pending', steps}
//   crossChainFarm.js:123,144  'farm-failed' {stage:'burn'|'relay', error, recoveryHint?}
//   baseLeg.js:321       'baseleg-failed' {stage, error, pulled?, bridgeAgentAddress?}
// None of the bridge events above carry `allocationId`/`runId` -- orchestrator.js:637 passes its
// own onEvent straight through to executeBaseLeg with no wrapping, and executeBaseLeg forwards the
// SAME onEvent to runFarmFlow unmodified. This is safe because a reviewed execution may contain
// exactly ONE bridge agent (orchestrator.js:189-194, VF_MULTIPLE_BRIDGE_AGENTS) -- every bridge
// event unambiguously belongs to the plan's single bridge allocation.
//
// Judgment call (documented per the brief's "report every judgment call" instruction): between
// 'farm-relay-dispatched' and the terminal 'farm-completed', the relayer runs BOTH the CCTP
// attestation wait and the Base mint+deposit as one opaque async job -- there is no third event in
// between. This file's own reducer does NOT import frontend/src/strategy/flowState.js (a Foundation
// file, off-limits to edit but readable): flowState.js's PULL_CONFIRMED/DEPOSIT_CONFIRMED event
// types have no real producer today (no event wraps the owner->agent pull in orchestrator.js), and
// ProtectStage.jsx already set the precedent of NOT importing flowState.js when its exact
// vocabulary didn't match a surface's real needs (see ProtectStage.jsx's own header comment). This
// file's phase names instead come directly from the brief's own lane-state list, mapped only onto
// events that genuinely fire.
import { useMemo, useRef } from 'react'
import { StatusNotice, TechnicalDetails, VenueTruth } from '../pocket/Primitives.jsx'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import { usePocketTransition } from '../../design/usePocketTransition.js'
import { SOROBAN_TOKEN_ADDRESS, STELLAR_USDC_SAC } from '../../stellar/config.js'
import { StrategyReceipt } from './StrategyReceipt.jsx'
import { CREW_PERSONAS, personaForOrdinal } from '../../crew/personas.js'
import { baseRecoveryIdentityKey } from '../../strategy/baseRecoveryIdentity.js'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  toAgentIdentityView,
  toBaseCustodyTruth,
  toStartProgress,
} from '../../core/coreRouteAdapters.js'

const TOKEN_SYMBOLS = Object.freeze({
  [SOROBAN_TOKEN_ADDRESS]: 'USDC',
  [STELLAR_USDC_SAC]: 'Circle USDC',
})

function tokenSymbol(token) {
  if (TOKEN_SYMBOLS[token]) return TOKEN_SYMBOLS[token]
  if (typeof token === 'string' && token.length > 12)
    return `${token.slice(0, 4)}…${token.slice(-4)}`
  return token
}

function coreAmountForDisplay(amount) {
  if (!amount || typeof amount !== 'object') return null
  try {
    return normalizeCoreAmount({ ...amount, token: tokenSymbol(amount.token) })
  } catch {
    return null
  }
}

function exactCoreAmountText(amount) {
  const normalized = coreAmountForDisplay(amount)
  return normalized ? formatCoreAmount(normalized) : 'Amount unavailable'
}

function laneProgress(phase) {
  if (phase === 'queued') return toStartProgress('queued')
  if (phase === 'moving') return toStartProgress('pulling')
  if (phase === 'depositing') return toStartProgress('depositing')
  if (phase === 'working' || phase === 'confirmed') return toStartProgress('done')
  return null
}

// Rank 0 is shared by two DIFFERENT labels depending on permission mode -- 'creating' (fresh: the
// grant transaction just deployed this agent) vs 'pending' (reuse: the agent already existed;
// nothing has happened for THIS allocation yet beyond the reuse confirmation that let Start begin
// at all). Neither claims a milestone with no backing event: `pending`/`creating` are the honest
// floor state before this allocation's own 'worker-queued' has arrived.
const DEPOSIT_RANK = Object.freeze({
  pending: 0,
  creating: 0,
  queued: 1,
  moving: 2,
  depositing: 3,
  working: 4,
  failed: 5,
})

export const DEPOSIT_PHASE_LABEL = Object.freeze({
  pending: 'Preparing',
  creating: 'Creating',
  queued: 'Queued',
  moving: 'Moving allocation',
  depositing: 'Depositing',
  working: 'Working',
  failed: 'Failed',
})

/**
 * Pure per-allocation phase derivation for a Stellar deposit lane. Monotonic and forward-only: a
 * later event can only advance the rank, never regress it, and 'failed' is terminal (no later
 * event un-fails a lane). An event for a DIFFERENT allocationId is ignored entirely.
 * @param {string} allocationId
 * @param {'fresh'|'reuse'} permissionMode
 * @param {Array<{name:string, data:object}>} events
 * @returns {'pending'|'creating'|'queued'|'moving'|'depositing'|'working'|'failed'}
 */
export function depositLanePhase(allocationId, permissionMode, events) {
  let phase = permissionMode === 'reuse' ? 'pending' : 'creating'
  for (const evt of events) {
    const data = evt?.data
    if (!data || data.allocationId !== allocationId) continue
    if (phase === 'failed') continue // terminal
    if (evt.name === 'worker-queued') {
      if (DEPOSIT_RANK.queued > DEPOSIT_RANK[phase]) phase = 'queued'
    } else if (evt.name === 'worker-started' || evt.name === 'started') {
      if (DEPOSIT_RANK.moving > DEPOSIT_RANK[phase]) phase = 'moving'
    } else if (evt.name === 'step' && data.step === 'deposit' && data.status === 'pending') {
      if (DEPOSIT_RANK.depositing > DEPOSIT_RANK[phase]) phase = 'depositing'
    } else if (evt.name === 'completed') {
      phase = 'working'
    } else if (evt.name === 'failed') {
      phase = 'failed'
    }
  }
  return phase
}

// Live evidence (txHash/error) a completed/failed worker.js event already carries -- distinct from
// `depositLanePhase` above so a live 'completed' can surface its real tx hash in Technical details
// even before any `receipt` prop exists (the receipt, once it arrives, is still authoritative and
// overrides this in `foldDepositReceipt`).
function depositLaneLiveEvidence(allocationId, events) {
  let txHash = null
  let error = null
  for (const evt of events) {
    const data = evt?.data
    if (!data || data.allocationId !== allocationId) continue
    if (evt.name === 'completed') txHash = data.txHash || null
    else if (evt.name === 'failed') error = data.error || null
  }
  return { txHash, error }
}

const BRIDGE_RANK = Object.freeze({
  ready: 0,
  burning: 1,
  'awaiting-attestation': 2,
  minting: 3,
  confirmed: 4,
  'in-transit': 4,
  failed: 5,
})

export const BRIDGE_PHASE_LABEL = Object.freeze({
  ready: 'Ready',
  burning: 'Burning on Stellar',
  'awaiting-attestation': 'Awaiting attestation',
  minting: 'Minting on Base',
  confirmed: 'Proxy custody',
  'in-transit': 'In transit',
  failed: 'Failed',
})

// Maps a bridge phase onto NetworkIdentity.jsx's own canonical transit vocabulary
// (src/components/pocket/NetworkIdentity.jsx:62-70's TRANSIT_COPY keys) -- that map already speaks
// exactly this vocabulary (source/burning/attesting/minting/arrived/failed/unknown), so this file
// reuses it rather than inventing new transit copy.
const BRIDGE_TRANSIT_STATE = Object.freeze({
  ready: 'source',
  burning: 'burning',
  'awaiting-attestation': 'attesting',
  minting: 'minting',
  confirmed: 'arrived',
  'in-transit': 'unknown',
  failed: 'failed',
})

/**
 * Pure phase derivation for the (at most one) bridge lane. Bridge events carry no allocationId --
 * every event in the stream unambiguously belongs to the plan's single bridge agent (see the
 * header comment). A bridge agent is always fresh-granted (orchestrator.js:196-202 refuses reuse
 * mode with a bridge leg), so there is no reuse-floor branch to consider here.
 * @param {Array<{name:string, data:object}>} events
 * @returns {'ready'|'burning'|'awaiting-attestation'|'minting'|'confirmed'|'failed'}
 */
export function bridgeLanePhase(events) {
  let phase = 'ready'
  let failed = false
  for (const evt of events) {
    const data = evt?.data
    if (failed) continue
    if (evt.name === 'farm-burn-started') {
      if (BRIDGE_RANK.burning > BRIDGE_RANK[phase]) phase = 'burning'
    } else if (evt.name === 'farm-burn-confirmed') {
      if (BRIDGE_RANK['awaiting-attestation'] > BRIDGE_RANK[phase]) phase = 'awaiting-attestation'
    } else if (evt.name === 'farm-relay-dispatched') {
      if (BRIDGE_RANK.minting > BRIDGE_RANK[phase]) phase = 'minting'
    } else if (evt.name === 'farm-completed' && data?.status === 'done') {
      if (BRIDGE_RANK.confirmed > BRIDGE_RANK[phase]) phase = 'confirmed'
    } else if (evt.name === 'farm-completed' && data?.status === 'error') {
      failed = true
    } else if (evt.name === 'farm-failed' || evt.name === 'baseleg-failed') {
      failed = true
    }
  }
  return failed ? 'failed' : phase
}

function laneMarkState(phase) {
  if (phase === 'failed') return 'failed'
  if (phase === 'working' || phase === 'confirmed') return 'confirmed'
  return 'active'
}

function bridgeNetworkContext(phase) {
  return {
    hostNetworkId: 'stellar-testnet',
    sourceNetworkId: 'stellar-testnet',
    destinationNetworkId: 'base-sepolia',
    custodyNetworkId: phase === 'confirmed' ? 'base-sepolia' : 'stellar-testnet',
    transitState: BRIDGE_TRANSIT_STATE[phase] || 'unknown',
  }
}

function stellarNetworkContext(phase) {
  const settled = phase === 'working' || phase === 'confirmed'
  return {
    hostNetworkId: 'stellar-testnet',
    sourceNetworkId: 'stellar-testnet',
    destinationNetworkId: 'stellar-testnet',
    custodyNetworkId: settled ? 'stellar-testnet' : null,
    transitState: settled ? 'none' : 'unknown',
  }
}

// Custody labels only ever come from the settled receipt (never guessed live) -- 'held'/'unmoved'
// for a deposit lane, 'held' relabeled 'Recovery available' for the bridge lane (baseLeg.js's own
// "stranded, recoverable via an owner sweep" vocabulary).
function custodyLabelFor(kind, outcome) {
  if (!outcome || outcome.executionStatus !== 'failed') return null
  const held = outcome.custody?.location === 'agent'
  if (kind === 'bridge') return held ? 'Recovery available' : 'Unmoved'
  return held ? 'Held' : 'Unmoved'
}

/**
 * Fold the settled receipt's authoritative outcome onto a DEPOSIT lane derived from live events.
 * Only a 'succeeded'/'failed' executionStatus overrides the live phase -- a 'pending' or
 * 'unknown'/'not-started' outcome leaves the live-derived phase in place (still working it out;
 * never resolved by absence of proof).
 */
function foldDepositReceipt(lane, outcome) {
  if (!outcome) return lane
  if (outcome.executionStatus === 'succeeded') {
    return {
      ...lane,
      txHash: outcome.txHash,
      error: null,
      custodyLabel: null,
      custody: outcome.custody,
      recoveryEligible: false,
    }
  }
  if (outcome.executionStatus === 'failed') {
    return {
      ...lane,
      phase: 'failed',
      custodyLabel: custodyLabelFor('deposit', outcome),
      error: outcome.error,
      recoveryEligible: true,
      custody: outcome.custody,
    }
  }
  return lane
}

function latestConfirmedRecoveryHash(receipt) {
  const attempts = Array.isArray(receipt?.attempts) ? receipt.attempts : []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (
      attempt?.phase === 'stellar_deposit' &&
      attempt.status === 'confirmed' &&
      typeof attempt.evidence?.txHash === 'string' &&
      attempt.evidence.txHash.length > 0
    ) {
      return attempt.evidence.txHash
    }
  }
  return null
}

// A recovery projection is newer durable evidence than the original DispatchReceiptV1. Fold only
// the strongest terminal verdict: a completed Stellar deposit with receipt-confirmed vault
// custody. This single derived receipt feeds both the lane and StrategyReceipt, preventing a
// recovered allocation from remaining failed/held in one view while appearing complete in another.
function confirmedBaseRecoveryProjection(projection, identityKey) {
  if (!projection || projection.action !== 'complete') return false
  try {
    if (baseRecoveryIdentityKey(projection.identity) !== identityKey) return false
  } catch {
    return false
  }
  const phase = projection.phases?.base_deposit
  const evidence = phase?.evidence
  const event = evidence?.event
  return (
    Number.isSafeInteger(projection.version) &&
    projection.version >= 0 &&
    phase?.state === 'confirmed' &&
    Number.isSafeInteger(phase.recoveryVersion) &&
    phase.recoveryVersion > 0 &&
    phase.recoveryVersion <= projection.version &&
    projection.custody?.location === 'base-proxy' &&
    projection.custody.confirmed === true &&
    /^0x[0-9a-f]{64}$/.test(evidence?.userOpHash || '') &&
    /^0x[0-9a-f]{64}$/.test(evidence?.transactionHash || '') &&
    /^(0|[1-9]\d*)$/.test(evidence?.assets || '') &&
    /^[1-9]\d*$/.test(evidence?.shares || '') &&
    event &&
    /^0x[0-9a-f]{40}$/.test(event.address || '') &&
    /^0x[0-9a-f]{64}$/.test(event.topic0 || '') &&
    typeof event.logIndex === 'string' &&
    /^(0|[1-9]\d*)$/.test(event.logIndex) &&
    /^0x[0-9a-f]{40}$/.test(event.caller || '') &&
    /^0x[0-9a-f]{40}$/.test(event.poolAddress || '') &&
    event.assets === evidence.assets &&
    event.shares === evidence.shares
  )
}

function foldRecoveryReceipt(receipt, recoveryByAllocation, baseRecoveryByIdentity) {
  if (!receipt) return receipt
  const replacements = new Map()
  for (const outcome of receipt.allocations || []) {
    const projection = recoveryByAllocation?.[outcome.allocationId]
    if (
      projection?.action !== 'complete' ||
      projection.receipt?.phases?.stellar_deposit !== 'confirmed' ||
      projection.custody?.location !== 'stellar-vault' ||
      projection.custody.confirmed !== true
    ) {
      let identityKey = null
      try {
        identityKey = baseRecoveryIdentityKey(outcome.identity)
      } catch {
        identityKey = null
      }
      const baseProjection = identityKey
        ? baseRecoveryByIdentity instanceof Map
          ? baseRecoveryByIdentity.get(identityKey)
          : baseRecoveryByIdentity?.[identityKey]
        : null
      if (!identityKey || !confirmedBaseRecoveryProjection(baseProjection, identityKey)) continue
      const evidence = baseProjection.phases.base_deposit.evidence
      replacements.set(outcome.allocationId, {
        ...outcome,
        networkContext: {
          ...outcome.networkContext,
          currentCustodyNetwork: 'base-sepolia',
          transit: false,
        },
        executionStatus: 'succeeded',
        custody: {
          location: 'base-proxy',
          confirmed: true,
          checkedAt: baseProjection.phases.base_deposit.observedAt ?? null,
          amount: outcome.amount,
          reason: null,
          source: 'receipt',
        },
        txHash: evidence.transactionHash,
        error: null,
        evidence: {
          ...outcome.evidence,
          allocationId: outcome.allocationId,
          recoveryVersion: baseProjection.version,
          userOpHash: evidence.userOpHash,
          depositTxHash: evidence.transactionHash,
        },
      })
      continue
    }
    const txHash = latestConfirmedRecoveryHash(projection.receipt)
    replacements.set(outcome.allocationId, {
      ...outcome,
      networkContext: {
        ...outcome.networkContext,
        currentCustodyNetwork: 'stellar-testnet',
        transit: false,
      },
      executionStatus: 'succeeded',
      custody: projection.custody,
      txHash,
      error: null,
      evidence: {
        allocationId: outcome.allocationId,
        recoveryReceiptVersion: projection.version,
        ...(txHash ? { depositTxHash: txHash } : {}),
      },
    })
  }
  if (replacements.size === 0) return receipt
  const replace = (outcome) => replacements.get(outcome.allocationId) || outcome
  const allocations = receipt.allocations.map(replace)
  const stellarResults = (receipt.branches?.stellar?.results || []).map(replace)
  const baseResults = (receipt.branches?.base?.results || []).map(replace)
  const stellarStatus =
    stellarResults.length > 0 && stellarResults.every((row) => row.executionStatus === 'succeeded')
      ? 'succeeded'
      : stellarResults.length > 0 && stellarResults.every((row) => row.executionStatus === 'failed')
        ? 'failed'
        : 'partial'
  const baseStatus =
    baseResults.length > 0 && baseResults.every((row) => row.executionStatus === 'succeeded')
      ? 'succeeded'
      : baseResults.length > 0 && baseResults.every((row) => row.executionStatus === 'failed')
        ? 'failed'
        : baseResults.some((row) => row.executionStatus === 'pending')
          ? 'in-transit'
          : baseResults.length > 0
            ? 'partial'
            : (receipt.branches?.base?.status ?? 'not-planned')
  return {
    ...receipt,
    allocations,
    branches: {
      ...receipt.branches,
      stellar: {
        ...receipt.branches?.stellar,
        status: stellarStatus,
        results: stellarResults,
      },
      base: {
        ...receipt.branches?.base,
        status: baseStatus,
        results: baseResults,
      },
    },
  }
}

// dispatchSummary.js:27-34 (`plannedAllocations`) -- a bridge agent with children NEVER gets an
// entry for its own allocationId in the receipt; only its CHILDREN do (each keyed by its own
// allocationId, branch:'base'). So the bridge lane's settled outcome must be aggregated from its
// children's receipt entries, never looked up by the bridge parent's own allocationId.
function bridgeChildRows(children, allocationById) {
  return children.map((child) => {
    const outcome = allocationById.get(child.allocationId)
    const failed = outcome?.executionStatus === 'failed'
    return {
      allocationId: child.allocationId,
      identity: outcome?.identity || null,
      proxyTarget: child.proxyTarget,
      destination: child.destination,
      failed,
      custodyLabel: failed ? custodyLabelFor('bridge', outcome) : null,
      custody: outcome?.custody || null,
      txHash: outcome?.txHash || null,
      error: outcome?.error || null,
    }
  })
}

function hasFreshBaseCustodyProof(custody) {
  if (!custody || custody.location !== 'base-proxy') return false
  if (custody.confirmed !== true || custody.source !== 'receipt') return false
  return (
    (typeof custody.checkedAt === 'number' && Number.isFinite(custody.checkedAt)) ||
    (typeof custody.checkedAt === 'string' &&
      custody.checkedAt.trim().length > 0 &&
      Number.isFinite(Date.parse(custody.checkedAt)))
  )
}

// `receipt` is only ever passed once the whole run has settled (see this file's own header
// comment), and `buildDispatchReceipt` structurally produces one outcome for EVERY child in
// `plan.agents[].children[]` (dispatchSummary.js's `plannedAllocations`/`buildBranch`) -- so once
// `receipt` exists, every child here already has a real (never-null) custody verdict via
// `inferredCustody()`'s own default. No "not settled yet" branch is needed.
function bridgeSettledPhase(childRows) {
  if (childRows.length === 0) return null
  if (childRows.some((c) => c.failed)) return 'failed'
  if (childRows.every((c) => hasFreshBaseCustodyProof(c.custody))) return 'confirmed'
  return 'in-transit' // pending/unknown residual -- never claim arrived without proof
}

function buildLanes({ plan, permission, events, receipt }) {
  const permissionMode = permission?.mode === 'reuse' ? 'reuse' : 'fresh'
  const allocationById = new Map((receipt?.allocations || []).map((a) => [a.allocationId, a]))

  return plan.agents.map((agent) => {
    if (agent.kind === 'bridge') {
      const children = agent.children || []
      const childRows = bridgeChildRows(children, allocationById)
      const settled = receipt ? bridgeSettledPhase(childRows) : null
      const phase = settled || bridgeLanePhase(events)
      return {
        allocationId: agent.allocationId,
        kind: 'bridge',
        phase,
        custodyLabel: null,
        recoveryEligible: false,
        txHash: null,
        error: null,
        custody: null,
        children: childRows,
      }
    }
    const live = depositLaneLiveEvidence(agent.allocationId, events)
    const lane = {
      allocationId: agent.allocationId,
      kind: 'deposit',
      phase: depositLanePhase(agent.allocationId, permissionMode, events),
      custodyLabel: null,
      recoveryEligible: false,
      txHash: live.txHash,
      error: live.error,
      custody: null,
      children: [],
    }
    return foldDepositReceipt(lane, allocationById.get(agent.allocationId))
  })
}

// A coarse, bucket-level summary -- changes only when a lane's named phase bucket changes, never
// on a worker.js sub-step (key-setup/swap) that this file folds into a single 'moving' bucket.
// This is what makes the live region "batch" agent updates rather than announce every micro-event.
function summarizeLanes(lanes) {
  const counts = new Map()
  for (const lane of lanes) counts.set(lane.phase, (counts.get(lane.phase) || 0) + 1)
  const label = (phase) => DEPOSIT_PHASE_LABEL[phase] || BRIDGE_PHASE_LABEL[phase] || phase
  const parts = [...counts.entries()].map(([phase, n]) => `${n} ${label(phase).toLowerCase()}`)
  return `${lanes.length} agent${lanes.length === 1 ? '' : 's'}: ${parts.join(', ')}`
}

function recoveryControl(projection, pending, { baseChild = false } = {}) {
  if (!projection) {
    return { label: baseChild ? 'Checking Base status' : 'Checking status', disabled: true }
  }
  if (baseChild) {
    const labels = {
      'no-movement': 'No Base movement confirmed',
      'poll-attestation': 'Check attestation',
      'submit-mint': 'Resume transfer to Base',
      'poll-mint': 'Check Base arrival',
      'submit-base-deposit': 'Deposit from Base account',
      'poll-base-deposit': 'Check Base deposit',
      'recovery-in-progress': 'Recovery in progress',
      'manual-review': 'Manual review',
      'owner-action-required': 'Action needed in Base account',
      complete: 'Complete',
    }
    const actionable = new Set([
      'poll-attestation',
      'submit-mint',
      'poll-mint',
      'submit-base-deposit',
      'poll-base-deposit',
    ])
    return {
      label: labels[projection.action] || 'Manual review',
      disabled: pending || !actionable.has(projection.action),
      hidden: projection.action === 'complete',
    }
  }
  if (projection.action === 'blocked-reconcile') {
    return { label: 'Manual review', disabled: true }
  }
  const labels = {
    pull: 'Recover',
    'resubmit-identical-envelope': 'Recover',
    deposit: 'Deposit',
    poll: 'Poll',
    'manual-review': 'Manual review',
    complete: 'Complete',
  }
  const label = labels[projection.action] || 'Manual review'
  const actionable = ['pull', 'resubmit-identical-envelope', 'deposit', 'poll'].includes(
    projection.action
  )
  return { label, disabled: pending || !actionable }
}

function presentAddress(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// Identity is intentionally collected only from records that carry their own allocation key.
// `grant-confirmed.agentAddresses` and `permission.agentAddresses` are vectors without a
// stable allocation binding; using their array position would make a reordered reviewed plan
// silently show one worker's identity on another worker's lane.
function workerAddressFromRecord(record) {
  if (!record || typeof record !== 'object') return null
  return (
    presentAddress(record.agentAddress) ||
    presentAddress(record.agent) ||
    presentAddress(record.bridgeAgentAddress)
  )
}

function receiptAddressFromRecord(record) {
  if (!record || typeof record !== 'object') return null
  const allocationId = presentAddress(record.allocationId)
  const evidence = record.evidence
  if (!allocationId || !evidence || typeof evidence !== 'object') return null
  if (presentAddress(evidence.allocationId) !== allocationId) return null
  const address = presentAddress(evidence.agentAddress)
  return address || null
}

function addKeyedIdentity(map, record, fallbackAllocationId = null, source = 'event') {
  if (!record || typeof record !== 'object') return
  const allocationId = presentAddress(record.allocationId) || fallbackAllocationId
  const address =
    source === 'receipt' ? receiptAddressFromRecord(record) : workerAddressFromRecord(record)
  if (allocationId && address) map.set(allocationId, address)
}

function addKeyedIdentityCollection(map, collection, source = 'event') {
  if (Array.isArray(collection)) {
    collection.forEach((record) => addKeyedIdentity(map, record, null, source))
    return
  }
  if (!collection || typeof collection !== 'object') return
  for (const [allocationId, record] of Object.entries(collection)) {
    if (typeof record === 'string') {
      if (source !== 'receipt') addKeyedIdentity(map, { allocationId, agentAddress: record })
    } else addKeyedIdentity(map, record, allocationId, source)
  }
}

function confirmedAgentAddresses({ plan, runId, events, receipt }) {
  const currentRunId = plan.runId || runId
  const addresses = new Map()

  for (const event of events) {
    const data = event?.data
    if (!data || (data.runId && data.runId !== currentRunId)) continue
    addKeyedIdentity(addresses, data)
    addKeyedIdentityCollection(addresses, data.allocations)
    addKeyedIdentityCollection(addresses, data.agents)
    addKeyedIdentityCollection(addresses, data.confirmed?.allocations)
    addKeyedIdentityCollection(addresses, data.confirmed?.agents)
  }

  if (receipt?.runId === currentRunId) {
    for (const allocation of receipt.allocations || []) {
      addKeyedIdentity(addresses, allocation, null, 'receipt')
    }
    addKeyedIdentityCollection(addresses, receipt.permission?.allocations, 'receipt')
    addKeyedIdentityCollection(addresses, receipt.permission?.agents, 'receipt')
    addKeyedIdentityCollection(addresses, receipt.permission?.agentRecords, 'receipt')
    addKeyedIdentityCollection(addresses, receipt.permission?.addressesByAllocation, 'receipt')
  }

  const allocationIdsByAddress = new Map()
  for (const [allocationId, address] of addresses) {
    const ids = allocationIdsByAddress.get(address) || []
    ids.push(allocationId)
    allocationIdsByAddress.set(address, ids)
  }
  for (const ids of allocationIdsByAddress.values()) {
    if (ids.length > 1) ids.forEach((allocationId) => addresses.delete(allocationId))
  }

  return addresses.size > 0 ? addresses : null
}

function addressPersona(personaByAddress, address) {
  if (typeof address !== 'string' || address.length === 0) return null
  const candidate =
    personaByAddress instanceof Map ? personaByAddress.get(address) : personaByAddress?.[address]
  return CREW_PERSONAS.find((persona) => persona.id === candidate?.id) || null
}

export function StartStage({
  plan,
  permission = null,
  events = [],
  receipt = null,
  personaByAddress = null,
  runId,
  recoveryByAllocation = {},
  recoveryPendingAllocations = new Set(),
  onRecoverAllocation,
  baseRecoveryByIdentity = {},
  baseRecoveryPendingIdentities = new Set(),
  onRecoverBaseChild,
  onViewMoney,
  onMakeAnotherDeposit,
  onViewCrew,
}) {
  const scopeRef = useRef(null)

  const effectiveReceipt = useMemo(
    () => foldRecoveryReceipt(receipt, recoveryByAllocation, baseRecoveryByIdentity),
    [receipt, recoveryByAllocation, baseRecoveryByIdentity]
  )

  const lanes = useMemo(
    () => buildLanes({ plan, permission, events, receipt: effectiveReceipt }),
    [plan, permission, events, effectiveReceipt]
  )
  const agentAddressesByAllocation = useMemo(() => {
    return confirmedAgentAddresses({ plan, runId, events, receipt: effectiveReceipt })
  }, [plan, runId, events, effectiveReceipt])

  const anyFailed = lanes.some((lane) => lane.phase === 'failed')
  const announcement = summarizeLanes(lanes)
  const baseCustodyTruth = toBaseCustodyTruth()
  // Step 2: GSAP animates only state changes the reducer has already committed. `events.length`
  // plus a settled-receipt marker is exactly that committed state -- never a wall-clock timer.
  const stateKey = `${events.length}:${receipt ? 'settled' : 'running'}`
  usePocketTransition(scopeRef, stateKey, { error: anyFailed })

  return (
    <div ref={scopeRef} className="pc-start-stage">
      <div className="pc-strategy-layout">
        <div className="pc-strategy-decision pc-dominant pc-dominant--decision">
          <h2 className="pc-strategy-question">
            {receipt ? 'Your run is complete' : 'Starting your run'}
          </h2>
          <p className="pc-visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>

          <ul className="pc-agent-lanes">
            {lanes.map((lane, index) => {
              const isBridge = lane.kind === 'bridge'
              const planAgent = plan.agents.find(
                (agent) => agent.allocationId === lane.allocationId
              )
              const agentAddress = agentAddressesByAllocation?.get(lane.allocationId) || null
              const assignedPersona = addressPersona(personaByAddress, agentAddress)
              const persona = assignedPersona || personaForOrdinal(index)
              const assignmentSyncing = Boolean(agentAddress && !assignedPersona)
              const currentRunId = plan.runId || runId
              const hasConfirmationEvidence =
                permission?.mode === 'reuse' ||
                events.some(
                  (event) =>
                    (event?.name === 'grant-confirmed' || event?.name === 'reuse-confirmed') &&
                    event.data?.runId === currentRunId
                )
              const identityPhase = agentAddress
                ? permission?.mode === 'reuse'
                  ? 'reused'
                  : 'deployed'
                : hasConfirmationEvidence
                  ? permission?.mode === 'reuse'
                    ? 'reused'
                    : 'deployed'
                  : 'planned'
              const receiptIdentityEvidence = Boolean(
                effectiveReceipt?.allocations?.some(
                  (allocation) =>
                    allocation?.allocationId === lane.allocationId &&
                    receiptAddressFromRecord(allocation)
                )
              )
              const identity = toAgentIdentityView({
                phase: identityPhase,
                allocationId: lane.allocationId,
                runId: currentRunId,
                address: agentAddress,
                verified: Boolean(agentAddress),
                source:
                  identityPhase === 'planned'
                    ? 'reviewed-plan'
                    : identityPhase === 'reused'
                      ? 'owner-discovery'
                      : receiptIdentityEvidence
                        ? 'receipt'
                        : 'creation-event',
                state: lane.phase,
              })
              // Receipt custody may describe a settled status, but it cannot manufacture the
              // visual milestone. Bridge progress is always projected from the received farm
              // event phase; deposit progress remains the allocation event-derived lane phase.
              const progress = laneProgress(isBridge ? bridgeLanePhase(events) : lane.phase)
              const phaseLabel = isBridge
                ? BRIDGE_PHASE_LABEL[lane.phase]
                : DEPOSIT_PHASE_LABEL[lane.phase]
              return (
                <li
                  key={lane.allocationId}
                  className="pc-agent-lane"
                  data-agent-kind={lane.kind}
                  data-lane-phase={lane.phase}
                  data-agent-address={agentAddress || undefined}
                >
                  <AgentMark
                    identity={identity}
                    state={laneMarkState(lane.phase)}
                    size={44}
                    label="agent"
                  />
                  <div className="pc-agent-lane-body" data-pocket-enter>
                    <p className="pc-worker-name">{persona.name}</p>
                    {assignmentSyncing && (
                      <p className="pc-crew-syncing">Crew assignment syncing.</p>
                    )}
                    <div className="pc-agent-lane-meta">
                      <NetworkRoute
                        context={
                          isBridge
                            ? bridgeNetworkContext(lane.phase)
                            : stellarNetworkContext(lane.phase)
                        }
                      />
                      {/* The lane cap is the reviewed canonical amount, never the float projection
                          from buildStrategyViewModel or a rounded display map. */}
                      {identity.showCap && planAgent?.cap && (
                        <p className="pc-lane-cap">{exactCoreAmountText(planAgent.cap)}</p>
                      )}
                    </div>
                    <p className="pc-lane-phase">{phaseLabel || lane.phase}</p>
                    {isBridge && (
                      <VenueTruth
                        kind={baseCustodyTruth.yield.state === 'none' ? 'base-proxy' : 'unknown'}
                      />
                    )}
                    {!isBridge && (
                      <VenueTruth
                        kind="stellar-live"
                        venue="Autofarm Vault"
                        networkContext={stellarNetworkContext(lane.phase)}
                      />
                    )}
                    {progress !== null && (
                      <div
                        className="pc-agent-lane-progress"
                        role="progressbar"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={progress}
                        aria-label={`${phaseLabel || lane.phase} progress`}
                        data-progress={progress}
                      >
                        <span />
                      </div>
                    )}
                    {!isBridge && lane.custodyLabel && <p>{lane.custodyLabel}</p>}
                    {!isBridge && lane.error && <p role="alert">{lane.error}</p>}
                    {/* Step 1: one bridge mark contains ALL Base child destinations -- a single
                        lane/mark for the whole leg, with every child's own destination, custody, and
                        (when it failed) evidence-selected recovery action listed inside it. */}
                    {isBridge && lane.children.length > 0 && (
                      <ul>
                        {lane.children.map((child) => {
                          let identityKey = null
                          try {
                            identityKey = baseRecoveryIdentityKey(child.identity)
                          } catch {
                            identityKey = null
                          }
                          const projection = identityKey
                            ? baseRecoveryByIdentity instanceof Map
                              ? baseRecoveryByIdentity.get(identityKey)
                              : baseRecoveryByIdentity[identityKey]
                            : { action: 'manual-review' }
                          const control = recoveryControl(
                            projection,
                            identityKey != null && baseRecoveryPendingIdentities.has(identityKey),
                            { baseChild: true }
                          )
                          return (
                            <li key={child.allocationId}>
                              {identity.showMoney && (
                                <span>
                                  {/* m-7 (Strategy Task 14 fix round 1): matched PlanStage.jsx's
                                      sibling bridge-child row, which always names the currency
                                      alongside the amount -- this one silently omitted it. */}
                                  {child.proxyTarget || child.destination}:{' '}
                                  {exactCoreAmountText(
                                    planAgent?.children?.find(
                                      (plannedChild) =>
                                        plannedChild.allocationId === child.allocationId
                                    )?.allocation
                                  )}
                                </span>
                              )}
                              {child.custodyLabel && <span> {child.custodyLabel}</span>}
                              {child.error && <span role="alert"> {child.error}</span>}
                              {identity.showAction && child.failed && !control.hidden && (
                                <button
                                  type="button"
                                  className="pc-button pc-button--secondary"
                                  disabled={control.disabled}
                                  onClick={() => {
                                    if (!control.disabled && child.identity) {
                                      onRecoverBaseChild?.(child.identity)
                                    }
                                  }}
                                >
                                  {control.label}
                                </button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {(lane.txHash || agentAddress || lane.allocationId) && (
                      <TechnicalDetails summary={`${persona.name} technical details`}>
                        {/* Owner decision #19: the container no longer defaults to mono -- these
                            two raw values are marked .pc-technical individually so they keep
                            rendering in the mono face. */}
                        <p>
                          Allocation: <span className="pc-technical">{lane.allocationId}</span>
                        </p>
                        {agentAddress && (
                          <p>
                            Agent: <span className="pc-technical">{agentAddress}</span>
                          </p>
                        )}
                        {lane.txHash && (
                          <p>
                            Transaction: <span className="pc-technical">{lane.txHash}</span>
                          </p>
                        )}
                      </TechnicalDetails>
                    )}
                  </div>
                  {!isBridge &&
                    identity.showAction &&
                    lane.recoveryEligible &&
                    (() => {
                      const control = recoveryControl(
                        recoveryByAllocation[lane.allocationId],
                        recoveryPendingAllocations.has(lane.allocationId)
                      )
                      return (
                        <button
                          type="button"
                          className="pc-button pc-button--secondary"
                          disabled={control.disabled}
                          onClick={() => onRecoverAllocation?.(lane.allocationId)}
                        >
                          {control.label}
                        </button>
                      )
                    })()}
                </li>
              )
            })}
          </ul>

          {anyFailed && !receipt && (
            <StatusNotice state="warning" title="One or more agents did not complete">
              <p>
                Agents that already finished stay confirmed. This page keeps reflecting the real
                state.
              </p>
            </StatusNotice>
          )}
        </div>

        {/* Task 7 -- Start's own safety rail (mirrors PlanStage.jsx's `.pc-strategy-aside` "The
            plan so far" panel and ProtectStage.jsx's boundaries section, same two-column layout).
            Task 2 demoted every STAGE heading to h2 and reserved h1 for the route
            (StrategyRoute.jsx) -- this is a sub-section under THIS stage's own h2 above, so its
            title is an h3 here (PlanStage.jsx/ProtectStage.jsx's pre-existing aside titles predate
            that convention and are out of this task's file list to revise). */}
        <aside className="pc-strategy-aside" aria-label="If something goes wrong">
          {/* Fix round 1 (F2): `.pc-strategy-aside` is `display: grid; gap: var(--pc-space-6)`
              (24px) and becomes a 2-column grid at the 768-1023px breakpoint (strategy.css) -- three
              DIRECT grid-item children (h3/ul/details) would let the title land in a different
              column/row than the list it labels there, and sit a full 24px+8px away from it even on
              desktop. PlanStage.jsx's own `.pc-plan-so-far` avoids exactly this by wrapping its
              title + list in one grid-item block; same pattern here, own class (own selector, not
              reaching into PlanStage's reserved name) so the aside's grid only ever sees ONE item
              for this whole panel, at every breakpoint. */}
          <div className="pc-safety-panel">
            <h3 className="pc-aside-title">If something goes wrong</h3>
            <ul className="pc-safety-list">
              <li>A crew member that fails is retried. The others keep going.</li>
              <li>Stop everything with one signature, even if our servers are down.</li>
              <li>Money can only ever come back to your address. Nowhere else.</li>
            </ul>
            <details className="pc-signed-details">
              <summary>What gets signed, exactly</summary>
              <p className="pc-technical">
                funding_router.grant(owner, per-agent caps, expiry, agents[{plan.agents.length}])
                {permission?.mode === 'reuse' ? ' — reused, 0 new signatures this run' : ''}
              </p>
            </details>
          </div>
        </aside>
      </div>

      {receipt && (
        <StrategyReceipt
          receipt={effectiveReceipt}
          runId={runId || plan.runId}
          onViewMoney={onViewMoney}
          onMakeAnotherDeposit={onMakeAnotherDeposit}
          onViewCrew={onViewCrew}
        />
      )}
    </div>
  )
}

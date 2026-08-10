// frontend/src/crossChainFarm.js
// Deposit -> Farm orchestration (Approach C §6 steps 4-7): commit the Base child intent,
// passkey-sign one Stellar CCTP burn, attach its hash to that intent, poll to completion, and emit
// progress events the UI (screens/Farm.jsx) and the force-graph consume. Deliberately NOT part
// of orchestrator.js — see the File Structure rationale note at the top of this plan. Every
// error is caught at its stage and re-thrown with an onEvent('farm-failed', {stage, ...}) fired
// first, so the UI always has a clear, staged failure reason (§7: a mid-flow failure surfaces a
// clear error and leaves funds recoverable).
import { signAndSubmitStellarBurn } from './stellar/cctpBurn.js'
import { postFarm, postFarmAttach, pollFarmStatus } from './base/relayerClient.js'
import { BASE_POOL_CATALOG } from './config.js'
import { assertBaseCrossChainAvailable } from './base/config.js'
import { createCctpTransfer, checkpointCctpTransfer } from './cctp/transferJournal.js'

const CCTP_STELLAR_DOMAIN = 27
const REQUEST_ID = /^[0-9a-f]{32}$/
const STELLAR_HASH = /^[0-9a-f]{64}$/

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '')
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues?.(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function publicFailure(stage) {
  return stage === 'intent'
    ? 'intent_unavailable'
    : stage === 'burn'
      ? 'burn_submission_unknown'
      : stage === 'attach'
        ? 'attach_unavailable'
        : 'status_unavailable'
}

function publicFarmStatus(value, { mandateId, jobId }) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('farm status is malformed')
  if (
    !['done', 'error', 'uncertain', 'blocked', 'depositing', 'pending', 'settling'].includes(
      value.status
    )
  )
    throw new Error('farm status is malformed')
  if (value.jobId !== undefined && value.jobId !== jobId)
    throw new Error('farm status identity changed')
  if (value.mandateId !== undefined && value.mandateId !== mandateId)
    throw new Error('farm status identity changed')
  const allowed = [
    'status',
    'jobId',
    'mandateId',
    'associationDelivery',
    'evidenceDelivery',
    'allocations',
  ]
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('farm status is malformed')
  const delivery = (input) => {
    if (input === undefined) return undefined
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['complete', 'blocked'].includes(key)) ||
      typeof input.complete !== 'boolean' ||
      (input.blocked !== undefined && typeof input.blocked !== 'boolean')
    )
      throw new Error('farm status is malformed')
    return input.blocked === undefined
      ? { complete: input.complete }
      : { complete: input.complete, blocked: input.blocked }
  }
  const allocation = (input) => {
    const keys = [
      'bindingId',
      'executionId',
      'allocationId',
      'childId',
      'userOpHash',
      'mintTxHash',
      'depositTxHash',
      'custody',
      'recoveryVersion',
    ]
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key)) ||
      !keys.every((key) => Object.hasOwn(input, key)) ||
      typeof input.bindingId !== 'string' ||
      typeof input.executionId !== 'string' ||
      typeof input.allocationId !== 'string' ||
      typeof input.childId !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(input.userOpHash) ||
      !/^0x[0-9a-f]{64}$/.test(input.mintTxHash) ||
      !/^0x[0-9a-f]{64}$/.test(input.depositTxHash) ||
      !Number.isSafeInteger(input.recoveryVersion) ||
      input.recoveryVersion < 0
    )
      throw new Error('farm status is malformed')
    const custody = input.custody
    if (
      !custody ||
      typeof custody !== 'object' ||
      Array.isArray(custody) ||
      Object.keys(custody).some((key) => !['location', 'confirmed', 'checkedAt'].includes(key)) ||
      typeof custody.location !== 'string' ||
      typeof custody.confirmed !== 'boolean' ||
      !(custody.checkedAt === null || Number.isSafeInteger(custody.checkedAt))
    )
      throw new Error('farm status is malformed')
    return {
      bindingId: input.bindingId,
      executionId: input.executionId,
      allocationId: input.allocationId,
      childId: input.childId,
      userOpHash: input.userOpHash,
      mintTxHash: input.mintTxHash,
      depositTxHash: input.depositTxHash,
      custody: {
        location: custody.location,
        confirmed: custody.confirmed,
        checkedAt: custody.checkedAt,
      },
      recoveryVersion: input.recoveryVersion,
    }
  }
  if (value.allocations !== undefined && !Array.isArray(value.allocations))
    throw new Error('farm status is malformed')
  const associationDelivery = delivery(value.associationDelivery)
  const evidenceDelivery = delivery(value.evidenceDelivery)
  const allocations =
    value.allocations === undefined ? undefined : value.allocations.map(allocation)
  if (
    value.status === 'done' &&
    (associationDelivery === undefined ||
      evidenceDelivery === undefined ||
      allocations === undefined)
  ) {
    throw new Error('farm status is malformed')
  }
  const projection = { status: value.status, jobId }
  if (associationDelivery !== undefined) projection.associationDelivery = associationDelivery
  if (evidenceDelivery !== undefined) projection.evidenceDelivery = evidenceDelivery
  if (allocations !== undefined) projection.allocations = allocations
  return projection
}

function hasCompleteExpectedFarmEvidence(status, { bindingId, runId, allocations }) {
  if (status.associationDelivery?.complete !== true || status.associationDelivery?.blocked === true)
    return false
  if (status.evidenceDelivery?.complete !== true || status.evidenceDelivery?.blocked === true)
    return false
  if (!Array.isArray(status.allocations) || status.allocations.length !== allocations.length)
    return false
  return allocations.every((expected) => {
    const matches = status.allocations.filter(
      (entry) => entry.allocationId === expected.allocationId
    )
    const child = matches[0]
    return (
      matches.length === 1 &&
      child.bindingId === bindingId &&
      child.executionId === `${runId}:exec:${expected.allocationId}`
    )
  })
}

function browserStorage(deps) {
  return (
    deps.journalStorage ||
    (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null)
  )
}

// Exact bigint units ride the deps calls and event payloads crossing this boundary. Attach a
// non-enumerable `toJSON` so a JSON.stringify of a recorded call or event log serializes them as
// decimal strings instead of throwing — non-enumerable, so deep-equality consumers and every
// spread (`{ ...data, allocationId }` downstream) simply never observe it.
function jsonSafeBigints(payload) {
  Object.defineProperty(payload, 'toJSON', {
    enumerable: false,
    value: () =>
      JSON.parse(
        JSON.stringify({ ...payload }, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      ),
  })
  return payload
}

// Fix loop 2, Fix 2a: pool address -> proxyTarget, the same lookup relayer/src/httpRouter.mjs's
// parseWireAllocations does at :255-258 (lowercased address match). Resolved once at module load
// — BASE_POOL_CATALOG is a static export, not per-request data.
const BASE_POOL_PROXY_TARGETS = new Map(
  BASE_POOL_CATALOG.map((entry) => [entry.address.toLowerCase(), entry.proxyTarget])
)

/**
 * @param {{
 *   stellarWallet: { address: string, signBurn: Function },
 *   baseRecipientAddress: string,        // also the Base kernel address for this leg's owner binding
 *   sessionKeyAddress: string,
 *   mandateId: string,                   // public mandate identity — the proxy supplies capability authority
 *   bindingId?: string,
 *   bindingHash?: string,
 *   allocations: Array<{ pool: string, amount: number, amountBaseUnits: bigint, minShares: bigint }>,
 *   burnUnits7: bigint,           // authoritative total burn input, 7dp Stellar units
 *   bridgeAgentAddress?: string,  // VF Wallet Task 6 wire field (postFarm's `bridgeAgent`) — recovery handle
 *   runId?: string,               // effectively required: every allocationId must equal `${runId}:bridge:${proxyTarget}`, so a missing runId fails the pre-burn guard below for every allocation
 *   grantTxHash?: string,
 *   onEvent?: (name: string, data: object) => void,
 *   deps?: { burn?: Function, postFarm?: Function, postFarmAttach?: Function, pollFarmStatus?: Function, journalStorage?: Storage, requestId?: string },
 * }} p
 * @returns {Promise<{ burnHash: string, jobId: string, finalStatus: string }>}
 */
export async function runFarmFlow({
  stellarWallet,
  baseRecipientAddress,
  sessionKeyAddress,
  mandateId,
  bindingId = null,
  bindingHash = null,
  allocations,
  burnUnits7,
  bridgeAgentAddress = null,
  runId = null,
  grantTxHash = null,
  onEvent = () => {},
  deps = {},
}) {
  assertBaseCrossChainAvailable()

  if (typeof burnUnits7 !== 'bigint' || burnUnits7 <= 0n) {
    throw new Error('burnUnits7 must be a positive bigint')
  }
  if (burnUnits7 % 10n !== 0n) {
    throw new Error('burnUnits7 must be divisible by 10 for a six-decimal CCTP message')
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error('allocations must be a non-empty array')
  }
  if (
    !allocations.every(
      (allocation) =>
        allocation &&
        typeof allocation.amountBaseUnits === 'bigint' &&
        allocation.amountBaseUnits > 0n
    )
  ) {
    throw new Error('every allocation amountBaseUnits must be a positive bigint')
  }
  const allocationTotal = allocations.reduce(
    (total, allocation) => total + allocation.amountBaseUnits,
    0n
  )
  const expectedBaseUnits = burnUnits7 / 10n
  if (allocationTotal !== expectedBaseUnits) {
    throw new Error(
      `allocation amountBaseUnits sum is ${allocationTotal}; expected ${expectedBaseUnits}`
    )
  }
  // Fix loop 2, Fix 2a: postFarm's canonical-allocationId guard (base/relayerClient.js) only ran
  // AFTER burn() above had already submitted the CCTP burn — a non-canonical or missing
  // allocationId meant burned USDC that could never be deposited. Validate the exact identity the
  // relayer requires (relayer/src/httpRouter.mjs:246-262) HERE, before anything moves. Reject
  // missing IDs, duplicate IDs, IDs for a pool absent from the catalog, and IDs that don't equal
  // the canonical string — matching the relayer exactly, not a weakened version of it.
  const seenAllocationIds = new Set()
  for (const alloc of allocations) {
    if (typeof alloc.allocationId !== 'string' || !alloc.allocationId) {
      throw new Error('every allocation requires its reviewed allocationId')
    }
    if (seenAllocationIds.has(alloc.allocationId)) {
      throw new Error(`duplicate allocationId: ${alloc.allocationId}`)
    }
    seenAllocationIds.add(alloc.allocationId)
    const proxyTarget = BASE_POOL_PROXY_TARGETS.get(String(alloc.pool || '').toLowerCase())
    if (!proxyTarget) {
      throw new Error(`allocation pool ${alloc.pool} is not in the Base pool catalog`)
    }
    const canonicalId = `${runId}:bridge:${proxyTarget}`
    if (alloc.allocationId !== canonicalId) {
      throw new Error(
        `allocationId ${alloc.allocationId} does not match the canonical ${canonicalId}`
      )
    }
  }
  const {
    burn = ({ contractId, amountUnits: amt, baseRecipientAddress: dest, kit }) =>
      signAndSubmitStellarBurn({ contractId, amountUnits: amt, baseRecipientAddress: dest, kit }),
    postFarm: postFarmFn = postFarm,
    postFarmAttach: postFarmAttachFn = postFarmAttach,
    pollFarmStatus: pollFn = pollFarmStatus,
  } = deps
  const storage = browserStorage(deps)
  const requestId = deps.requestId || newRequestId()
  if (!REQUEST_ID.test(requestId)) throw new Error('invalid CCTP request identity')
  if (!storage) throw new Error('durable CCTP transfer journal is unavailable')
  const journalOptions = { storage }
  const journal = (fn) => fn(journalOptions)
  {
    if (typeof bindingId !== 'string' || !bindingId || !STELLAR_HASH.test(bindingHash || '')) {
      throw new Error('verified mandate binding evidence is required before a CCTP burn')
    }
    const transferAllocations = allocations.map((allocation) => ({
      allocationId: allocation.allocationId,
      executionId: `${runId}:exec:${allocation.allocationId}`,
      poolAddress: String(allocation.pool).toLowerCase(),
      amount: { token: 'USDC', units: allocation.amountBaseUnits.toString(), decimals: 6 },
      minShares: (allocation.minShares ?? 0n).toString(),
    }))
    createCctpTransfer(
      {
        version: 1,
        direction: 'forward',
        owner: stellarWallet.address,
        requestId,
        state: 'intent_creating',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        reasonCode: null,
        terminalFrom: null,
        transfer: {
          mandateId,
          kernelAddress: baseRecipientAddress.toLowerCase(),
          bindingId,
          bindingHash,
          bridgeAgent: bridgeAgentAddress,
          runId,
          grantTxHash,
          burnUnits7: burnUnits7.toString(),
          allocations: transferAllocations,
          jobId: null,
          burnTxHash: null,
        },
      },
      journalOptions
    )
  }

  let dispatch
  try {
    dispatch = await postFarmFn(
      jsonSafeBigints({
        requestId,
        sourceDomain: CCTP_STELLAR_DOMAIN,
        mandateId,
        stellarOwner: stellarWallet.address,
        kernelAddress: baseRecipientAddress,
        bridgeAgent: bridgeAgentAddress,
        runId,
        grantTxHash,
        allocations,
      })
    )
    if (
      dispatch?.acknowledged !== true ||
      dispatch?.schemaVersion !== 1 ||
      typeof dispatch?.jobId !== 'string' ||
      !dispatch.jobId
    ) {
      throw new Error('farm intent acknowledgement is malformed')
    }
  } catch (err) {
    onEvent('farm-failed', { stage: 'intent', reasonCode: publicFailure('intent') })
    throw err
  }
  journal((options) =>
    checkpointCctpTransfer(
      {
        owner: stellarWallet.address,
        requestId,
        from: 'intent_creating',
        to: 'intent_acked',
        patch: { jobId: dispatch.jobId },
      },
      options
    )
  )
  onEvent('farm-intent-committed', { jobId: dispatch.jobId, schemaVersion: dispatch.schemaVersion })

  journal((options) =>
    checkpointCctpTransfer(
      { owner: stellarWallet.address, requestId, from: 'intent_acked', to: 'burn_submitting' },
      options
    )
  )
  onEvent(
    'farm-burn-started',
    jsonSafeBigints({ address: stellarWallet.address, amountUnits: burnUnits7 })
  )
  let burnResult
  try {
    burnResult = await burn({
      contractId: stellarWallet.address,
      amountUnits: burnUnits7,
      baseRecipientAddress,
      kit: stellarWallet,
    })
  } catch (err) {
    onEvent('farm-failed', { stage: 'burn', reasonCode: publicFailure('burn') })
    throw err
  }
  if (!STELLAR_HASH.test(burnResult?.burnHash || '')) {
    throw new Error('burn confirmation is malformed')
  }
  try {
    journal((options) =>
      checkpointCctpTransfer(
        {
          owner: stellarWallet.address,
          requestId,
          from: 'burn_submitting',
          to: 'burn_confirmed',
          patch: { burnTxHash: burnResult.burnHash },
        },
        options
      )
    )
  } catch (error) {
    // A confirmed hash is public recovery evidence. The write failure leaves the existing
    // burn_submitting row untouched, but UI observers still get the fixed, no-resend diagnosis.
    onEvent('farm-failed', {
      stage: 'attach',
      reasonCode: 'burn_checkpoint_failed',
      jobId: dispatch.jobId,
      burnHash: burnResult.burnHash,
    })
    throw error
  }
  onEvent('farm-burn-confirmed', { burnHash: burnResult.burnHash })

  try {
    journal((options) =>
      checkpointCctpTransfer(
        { owner: stellarWallet.address, requestId, from: 'burn_confirmed', to: 'attach_pending' },
        options
      )
    )
    await postFarmAttachFn({
      mandateId,
      jobId: dispatch.jobId,
      burnTxHash: burnResult.burnHash,
    })
    journal((options) =>
      checkpointCctpTransfer(
        { owner: stellarWallet.address, requestId, from: 'attach_pending', to: 'settling' },
        options
      )
    )
  } catch (err) {
    onEvent('farm-failed', {
      stage: 'attach',
      reasonCode: publicFailure('attach'),
      jobId: dispatch.jobId,
      burnHash: burnResult.burnHash,
    })
    throw err
  }
  onEvent('farm-relay-dispatched', { jobId: dispatch.jobId, sessionKeyAddress })

  let finalStatus
  try {
    finalStatus = await pollFn({ mandateId, jobId: dispatch.jobId })
  } catch (err) {
    onEvent('farm-failed', {
      stage: 'status',
      reasonCode: publicFailure('status'),
      jobId: dispatch.jobId,
    })
    throw err
  }
  const publicStatus = publicFarmStatus(finalStatus, { mandateId, jobId: dispatch.jobId })
  if (
    publicStatus.status === 'done' &&
    !hasCompleteExpectedFarmEvidence(publicStatus, { bindingId, runId, allocations })
  ) {
    throw new Error('farm allocation evidence is malformed')
  }
  if (['done', 'error', 'uncertain', 'blocked'].includes(publicStatus?.status)) {
    journal((options) =>
      checkpointCctpTransfer(
        {
          owner: stellarWallet.address,
          requestId,
          from: 'settling',
          to: publicStatus.status,
          patch: {
            reasonCode: publicStatus.status === 'done' ? 'job_error' : `job_${publicStatus.status}`,
          },
        },
        options
      )
    )
  }
  onEvent('farm-completed', {
    jobId: dispatch.jobId,
    status: publicStatus.status,
  })

  return {
    burnHash: burnResult.burnHash,
    jobId: dispatch.jobId,
    finalStatus: publicStatus.status,
    ...publicStatus,
  }
}

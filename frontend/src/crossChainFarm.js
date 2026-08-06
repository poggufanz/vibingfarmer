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

const CCTP_STELLAR_DOMAIN = 27

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
 *   allocations: Array<{ pool: string, amount: number, amountBaseUnits: bigint, minShares: bigint }>,
 *   burnUnits7: bigint,           // authoritative total burn input, 7dp Stellar units
 *   bridgeAgentAddress?: string,  // VF Wallet Task 6 wire field (postFarm's `bridgeAgent`) — recovery handle
 *   runId?: string,               // effectively required: every allocationId must equal `${runId}:bridge:${proxyTarget}`, so a missing runId fails the pre-burn guard below for every allocation
 *   grantTxHash?: string,
 *   onEvent?: (name: string, data: object) => void,
 *   deps?: { burn?: Function, postFarm?: Function, postFarmAttach?: Function, pollFarmStatus?: Function },
 * }} p
 * @returns {Promise<{ burnHash: string, jobId: string, finalStatus: string }>}
 */
export async function runFarmFlow({
  stellarWallet,
  baseRecipientAddress,
  sessionKeyAddress,
  mandateId,
  allocations,
  burnUnits7,
  bridgeAgentAddress = null,
  runId = null,
  grantTxHash = null,
  onEvent = () => {},
  deps = {},
}) {
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

  let dispatch
  try {
    dispatch = await postFarmFn(
      jsonSafeBigints({
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
    onEvent('farm-failed', { stage: 'intent', error: err.message })
    throw err
  }
  onEvent('farm-intent-committed', { jobId: dispatch.jobId, schemaVersion: dispatch.schemaVersion })

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
    onEvent('farm-failed', { stage: 'burn', error: err.message })
    throw err
  }
  onEvent('farm-burn-confirmed', { burnHash: burnResult.burnHash })

  try {
    await postFarmAttachFn({
      mandateId,
      jobId: dispatch.jobId,
      burnTxHash: burnResult.burnHash,
      stellarOwner: stellarWallet.address,
      kernelAddress: baseRecipientAddress,
    })
  } catch (err) {
    onEvent('farm-failed', {
      stage: 'attach',
      error: err.message,
      recoveryHint: `Base intent job ${dispatch.jobId} is durable and USDC was already burned on Stellar (transaction ${burnResult.burnHash}). Retry the burn attachment for this exact job and hash when the relayer is reachable.`,
    })
    throw err
  }
  onEvent('farm-relay-dispatched', { jobId: dispatch.jobId, sessionKeyAddress })

  const finalStatus = await pollFn({ mandateId, jobId: dispatch.jobId })
  onEvent('farm-completed', {
    jobId: dispatch.jobId,
    status: finalStatus.status,
    steps: finalStatus.steps,
  })

  return { burnHash: burnResult.burnHash, jobId: dispatch.jobId, finalStatus: finalStatus.status }
}

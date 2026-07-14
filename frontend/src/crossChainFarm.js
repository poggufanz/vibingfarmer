// frontend/src/crossChainFarm.js
// Deposit -> Farm orchestration (Approach C §6 steps 4-7): passkey-sign the Stellar CCTP burn,
// hand the burn tx hash + mandate + allocations to the relayer, poll to completion, emit
// progress events the UI (screens/Farm.jsx) and the force-graph consume. Deliberately NOT part
// of orchestrator.js — see the File Structure rationale note at the top of this plan. Every
// error is caught at its stage and re-thrown with an onEvent('farm-failed', {stage, ...}) fired
// first, so the UI always has a clear, staged failure reason (§7: a mid-flow failure surfaces a
// clear error and leaves funds recoverable).
import { signAndSubmitStellarBurn } from './stellar/cctpBurn.js'
import { postFarm, pollFarmStatus } from './base/relayerClient.js'

const CCTP_STELLAR_DOMAIN = 27

/**
 * @param {{
 *   stellarWallet: { address: string, signBurn: Function },
 *   baseRecipientAddress: string,
 *   sessionKeyAddress: string,
 *   serializedApproval: string,
 *   allocations: Array<{ pool: string, amount: number, amountBaseUnits: bigint, minShares: bigint }>,
 *   burnUnits7: bigint,           // authoritative total burn input, 7dp Stellar units
 *   onEvent?: (name: string, data: object) => void,
 *   deps?: { burn?: Function, postFarm?: Function, pollFarmStatus?: Function },
 * }} p
 * @returns {Promise<{ burnHash: string, jobId: string, finalStatus: string }>}
 */
export async function runFarmFlow({
  stellarWallet,
  baseRecipientAddress,
  sessionKeyAddress,
  serializedApproval,
  allocations,
  burnUnits7,
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
  const {
    burn = ({ contractId, amountUnits: amt, baseRecipientAddress: dest, kit }) =>
      signAndSubmitStellarBurn({ contractId, amountUnits: amt, baseRecipientAddress: dest, kit }),
    postFarm: postFarmFn = postFarm,
    pollFarmStatus: pollFn = pollFarmStatus,
  } = deps

  onEvent('farm-burn-started', { address: stellarWallet.address, amountUnits: burnUnits7 })
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

  let dispatch
  try {
    dispatch = await postFarmFn({
      burnTxHash: burnResult.burnHash,
      sourceDomain: CCTP_STELLAR_DOMAIN,
      serializedApproval,
      allocations,
    })
  } catch (err) {
    onEvent('farm-failed', {
      stage: 'relay',
      error: err.message,
      recoveryHint: `USDC was already burned on Stellar (transaction ${burnResult.burnHash}). Funds are in transit through CCTP. Retry the relay dispatch with this burn hash when the relayer is reachable.`,
    })
    throw err
  }
  onEvent('farm-relay-dispatched', { jobId: dispatch.jobId, sessionKeyAddress })

  const finalStatus = await pollFn({ jobId: dispatch.jobId })
  onEvent('farm-completed', {
    jobId: dispatch.jobId,
    status: finalStatus.status,
    steps: finalStatus.steps,
  })

  return { burnHash: burnResult.burnHash, jobId: dispatch.jobId, finalStatus: finalStatus.status }
}

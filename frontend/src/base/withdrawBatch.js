// frontend/src/base/withdrawBatch.js
// Withdraw -> full exit: ONE owner-signed batched userOp = max approvals + a single
// BaseExitSweeper.exitAllAndBurn + approval revocations. The burn AMOUNT is deliberately
// absent from this file. It used to be `totalAssetsForBurn`, and passing the slippage FLOOR
// there stranded 0.5% of every withdraw on Base permanently. The contract reads its own
// balance at execution time instead, which is also the only way to capture interest accrued
// between this read and the userOp landing.
//
// Uses the OWNER's kernel account directly (sudo = passkeyValidator, no session plugin) —
// the session key from wallet/mandate.js is never involved, because its policy never granted
// withdraw (drain-proof by omission, not by a runtime check).
import { encodeFunctionData, parseEventLogs } from 'viem'
import {
  ERC20_ABI,
  BASE_EXIT_SWEEPER_ADDRESS,
  BASE_EXIT_SWEEPER_ABI,
  BASE_USDC_ADDRESS,
  assertBaseCrossChainAvailable,
} from './config.js'
import { buildForwarderHookData, assertHookData } from './hookData.js'
import { createGaslessKernelClient } from './paymaster.js'
import {
  requireCanonicalUserOperationHash,
  requireSuccessfulUserOperation,
} from './userOpReceipt.js'
import { unwindJobCommitment } from './unwindCommitment.js'

const MAX_FEE_BPS = 100n // 1% cap; the actual charged fee is the corridor rate
const MAX_UINT256 = (1n << 256n) - 1n
const SWEPT_EVENT_TOPIC = '0x4f2d11fb664b5f2f436d0d6acfed89a492c2f8fde20a4811da677150003332eb'

const approveCall = (token, spender, amount) => ({
  to: token,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
})

/**
 * Build the full-exit batch. Availability is fenced before any validation or encoding. A
 * malformed hook must never reach a real burn call (the contract re-checks it too, because a
 * deployed contract can be called without this file).
 * @param {{
 *   positions: Array<{pool:string, minAssets:bigint}>,
 *   stellarRecipient: string,
 *   idleUsdc?: bigint,
 *   deadline: bigint,
 *   nowSeconds?: bigint,
 * }} p
 * @returns {Array<{to:string, data:string}>}
 */
function buildUnwindPlan({
  positions,
  stellarRecipient,
  idleUsdc = 0n,
  deadline,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
}) {
  if (typeof deadline !== 'bigint' || deadline <= 0n) {
    throw new TypeError('buildUnwindCalls: deadline must be a positive bigint')
  }
  if (typeof nowSeconds !== 'bigint' || nowSeconds < 0n) {
    throw new TypeError('buildUnwindCalls: nowSeconds must be a non-negative bigint')
  }
  if (deadline <= nowSeconds) {
    throw new Error('buildUnwindCalls: deadline is expired')
  }
  if (typeof idleUsdc !== 'bigint' || idleUsdc < 0n) {
    throw new TypeError('buildUnwindCalls: idleUsdc must be a non-negative bigint')
  }

  const pos = Array.isArray(positions) ? positions : []
  if (pos.some((position) => typeof position?.minAssets !== 'bigint' || position.minAssets < 0n)) {
    throw new TypeError('buildUnwindCalls: every minAssets floor must be a non-negative bigint')
  }
  if (pos.length === 0 && idleUsdc === 0n) {
    throw new Error('buildUnwindCalls: nothing to withdraw (no positions and no idle USDC)')
  }

  const hookData = buildForwarderHookData(stellarRecipient)
  assertHookData(hookData) // throws loudly on anything malformed — never silently proceeds

  const floors = pos.map((p) => p.minAssets)
  // maxFee is a CAP, not the charged amount, and the basis includes idle USDC so a
  // sweep-everything burn is not capped against a much smaller position total.
  const feeBasis = floors.reduce((a, f) => a + f, 0n) + idleUsdc
  const maxFee = (feeBasis * MAX_FEE_BPS) / 10000n

  const hookDataHex = `0x${Buffer.from(hookData).toString('hex')}`
  const sweeperCall = {
    to: BASE_EXIT_SWEEPER_ADDRESS,
    data: encodeFunctionData({
      abi: BASE_EXIT_SWEEPER_ABI,
      functionName: 'exitAllAndBurn',
      args: [pos.map((p) => p.pool), floors, maxFee, deadline, hookDataHex],
    }),
  }

  return {
    maxFee,
    hookData: hookDataHex,
    calls: [
      ...pos.map((p) => approveCall(p.pool, BASE_EXIT_SWEEPER_ADDRESS, MAX_UINT256)),
      approveCall(BASE_USDC_ADDRESS, BASE_EXIT_SWEEPER_ADDRESS, MAX_UINT256),
      sweeperCall,
      ...pos.map((p) => approveCall(p.pool, BASE_EXIT_SWEEPER_ADDRESS, 0n)),
      approveCall(BASE_USDC_ADDRESS, BASE_EXIT_SWEEPER_ADDRESS, 0n),
    ],
  }
}

export function buildUnwindCalls(params) {
  assertBaseCrossChainAvailable()
  return buildUnwindPlan(params).calls
}

/**
 * Owner-signed (passkey), single userOp: build, encode, sign, submit, wait for a REAL success —
 * never reports success on a merely-mined-but-reverted userOp.
 * @param {{
 *   jobId: string,
 *   ownerKernelAccount: object,
 *   publicClient: object,
 *   positions: Array<object>,
 *   stellarRecipient: string,
 *   idleUsdc?: bigint,
 *   deadline: bigint,
 *   nowSeconds?: bigint,
 *   onSubmitted: (userOpHash: string) => Promise<void>,
 *   deps?: { makeGaslessClient?: Function },
 * }} p
 * @returns {Promise<{ unwindTxHash: string, burned: bigint|null, exited: bigint|null, skipped: bigint|null }>}
 */
export async function signAndSubmitUnwind({
  jobId,
  ownerKernelAccount,
  publicClient,
  positions,
  stellarRecipient,
  idleUsdc = 0n,
  deadline,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
  onSubmitted,
  deps = {},
}) {
  assertBaseCrossChainAvailable()
  if (typeof onSubmitted !== 'function') {
    throw new TypeError('signAndSubmitUnwind: onSubmitted checkpoint callback is required')
  }
  const dataSuffix = unwindJobCommitment(jobId)

  const { makeGaslessClient = createGaslessKernelClient } = deps
  const { calls, maxFee, hookData } = buildUnwindPlan({
    positions,
    stellarRecipient,
    idleUsdc,
    deadline,
    nowSeconds,
  })

  const kernelClient = makeGaslessClient({ account: ownerKernelAccount, publicClient })
  const callData = await kernelClient.account.encodeCalls(
    calls.map((c) => ({ to: c.to, value: 0n, data: c.data }))
  )
  let rawUserOpHash
  try {
    rawUserOpHash = await kernelClient.sendUserOperation({ callData, dataSuffix })
  } catch {
    // Once this submission seam is invoked, a rejected promise cannot prove that the bundler
    // did not accept the operation. Task 13 may reconcile it later; this flow must never resend.
    const error = new Error('unwind submission status is unknown')
    error.code = 'submission_unknown'
    throw error
  }

  let userOpHash
  try {
    userOpHash = requireCanonicalUserOperationHash(rawUserOpHash, {
      label: 'unwind user operation',
    })
  } catch {
    // A malformed response is also post-submission ambiguity: there is no canonical identity to
    // checkpoint, but the operation may already exist. Do not expose or retry the malformed value.
    const error = new Error(
      'unwind user operation hash is unavailable; submission status is unknown'
    )
    error.code = 'submission_unknown'
    throw error
  }
  try {
    await onSubmitted(userOpHash)
  } catch {
    const error = new Error('unwind was submitted but its checkpoint failed')
    error.code = 'submitted-but-checkpoint-failed'
    error.userOpHash = userOpHash
    throw error
  }

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash })
  const unwindTxHash = requireSuccessfulUserOperation(receipt, {
    label: 'unwind user operation',
  })
  // The final amount is not knowable before execution (interest accrues right up to the burn,
  // see the file header), so it must come from the `Swept` event, never the pre-sign estimate.
  // A decode miss must NOT turn a landed burn into a reported failure: the money already moved.
  let burned = null
  let exited = null
  let skipped = null
  let evidenceStatus = 'needs_reconcile'
  try {
    const topLevelLogs = Array.isArray(receipt.logs) ? receipt.logs : []
    const sweptCandidates = topLevelLogs.filter(
      (log) =>
        log.address?.toLowerCase() === BASE_EXIT_SWEEPER_ADDRESS.toLowerCase() &&
        log.topics?.[0]?.toLowerCase() === SWEPT_EVENT_TOPIC
    )
    if (sweptCandidates.length !== 1) throw new Error('ambiguous Swept evidence')
    const sweptLogs = parseEventLogs({
      abi: BASE_EXIT_SWEEPER_ABI,
      logs: sweptCandidates,
      eventName: 'Swept',
      strict: true,
    })
    const [sweptLog] = sweptLogs
    if (
      sweptLogs.length === 1 &&
      sweptLog.args?.owner?.toLowerCase() === ownerKernelAccount.address?.toLowerCase() &&
      typeof sweptLog.args?.burned === 'bigint' &&
      sweptLog.args.burned > 0n
    ) {
      ;({ burned, exited, skipped } = sweptLog.args)
      evidenceStatus = 'verified'
    }
  } catch {
    // fall through with nulls - reporting failure, not execution failure
  }

  return {
    userOpHash,
    unwindTxHash,
    burned,
    exited,
    skipped,
    maxFee,
    hookData,
    evidenceStatus,
  }
}

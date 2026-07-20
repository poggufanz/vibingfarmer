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
} from './config.js'
import { buildForwarderHookData, assertHookData } from './hookData.js'
import { createGaslessKernelClient } from './paymaster.js'

const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const STELLAR_CCTP_FORWARDER = 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ'
const STELLAR_DOMAIN = 27
// CCTP v2 FAST transfer: threshold <=1000 = attestation at soft-confirmed level (seconds),
// >=2000 = Base L1 finality (~15-20 min, what users sat through on the first live unwind,
// 2026-07-20). A too-low maxFee silently degrades to standard, i.e. worst case equals the
// old behaviour.
const MIN_FINALITY_FAST = 1000
const MAX_FEE_BPS = 100n // 1% cap; the actual charged fee is the corridor rate
const MAX_UINT256 = (1n << 256n) - 1n
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`

async function forwarderAddressBytes32() {
  const { StrKey } = await import('@stellar/stellar-sdk')
  const raw = StrKey.decodeContract(STELLAR_CCTP_FORWARDER)
  return `0x${Buffer.from(raw).toString('hex')}`
}

const approveCall = (token, spender, amount) => ({
  to: token,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
})

/**
 * Build the full-exit batch. Validates hookData BEFORE returning anything — a malformed hook
 * must never reach a real burn call (the #7313 gotcha; the contract re-checks it too, because
 * a deployed contract can be called without this file).
 * @param {{
 *   positions: Array<{pool:string, minAssets:bigint}>,
 *   stellarRecipient: string,
 *   idleUsdc?: bigint,
 *   forwarderBytes32?: string,
 * }} p
 * @returns {Array<{to:string, data:string}>}
 */
export function buildUnwindCalls({
  positions,
  stellarRecipient,
  idleUsdc = 0n,
  forwarderBytes32,
}) {
  const pos = Array.isArray(positions) ? positions : []
  if (pos.length === 0 && idleUsdc === 0n) {
    throw new Error('buildUnwindCalls: nothing to withdraw (no positions and no idle USDC)')
  }

  const hookData = buildForwarderHookData(stellarRecipient)
  assertHookData(hookData) // throws loudly on anything malformed — never silently proceeds

  const forwarder32 = forwarderBytes32 ?? ZERO_BYTES32
  const floors = pos.map((p) => p.minAssets)
  // maxFee is a CAP, not the charged amount, and the basis includes idle USDC so a
  // sweep-everything burn is not capped against a much smaller position total.
  const feeBasis = floors.reduce((a, f) => a + f, 0n) + idleUsdc
  const maxFee = (feeBasis * MAX_FEE_BPS) / 10000n

  const sweeperCall = {
    to: BASE_EXIT_SWEEPER_ADDRESS,
    data: encodeFunctionData({
      abi: BASE_EXIT_SWEEPER_ABI,
      functionName: 'exitAllAndBurn',
      args: [
        pos.map((p) => p.pool),
        floors,
        forwarder32,
        forwarder32,
        STELLAR_DOMAIN,
        maxFee,
        MIN_FINALITY_FAST,
        `0x${Buffer.from(hookData).toString('hex')}`,
      ],
    }),
  }

  return [
    ...pos.map((p) => approveCall(p.pool, BASE_EXIT_SWEEPER_ADDRESS, MAX_UINT256)),
    approveCall(BASE_USDC, BASE_EXIT_SWEEPER_ADDRESS, MAX_UINT256),
    sweeperCall,
    ...pos.map((p) => approveCall(p.pool, BASE_EXIT_SWEEPER_ADDRESS, 0n)),
    approveCall(BASE_USDC, BASE_EXIT_SWEEPER_ADDRESS, 0n),
  ]
}

/**
 * Owner-signed (passkey), single userOp: build, encode, sign, submit, wait for a REAL success —
 * never reports success on a merely-mined-but-reverted userOp.
 * @param {{
 *   ownerKernelAccount: object,
 *   publicClient: object,
 *   positions: Array<object>,
 *   stellarRecipient: string,
 *   idleUsdc?: bigint,
 *   deps?: { makeGaslessClient?: Function },
 * }} p
 * @returns {Promise<{ unwindTxHash: string, burned: bigint|null, exited: bigint|null, skipped: bigint|null }>}
 */
export async function signAndSubmitUnwind({
  ownerKernelAccount,
  publicClient,
  positions,
  stellarRecipient,
  idleUsdc = 0n,
  deps = {},
}) {
  const { makeGaslessClient = createGaslessKernelClient } = deps
  const forwarderBytes32 = await forwarderAddressBytes32()
  const calls = buildUnwindCalls({ positions, stellarRecipient, idleUsdc, forwarderBytes32 })

  const kernelClient = makeGaslessClient({ account: ownerKernelAccount, publicClient })
  const callData = await kernelClient.account.encodeCalls(
    calls.map((c) => ({ to: c.to, value: 0n, data: c.data }))
  )
  const userOpHash = await kernelClient.sendUserOperation({ callData })
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash })
  const succeeded = receipt?.success === true || receipt?.receipt?.status === 'success'
  if (!succeeded) throw new Error(`unwind userOp did not succeed (userOpHash ${userOpHash})`)

  const unwindTxHash = receipt.receipt.transactionHash
  // The final amount is not knowable before execution (interest accrues right up to the burn,
  // see the file header), so it must come from the `Swept` event, never the pre-sign estimate.
  // A decode miss must NOT turn a landed burn into a reported failure: the money already moved.
  let burned = null
  let exited = null
  let skipped = null
  try {
    const sweptLogs = parseEventLogs({
      abi: BASE_EXIT_SWEEPER_ABI,
      logs: receipt.receipt.logs || [],
      eventName: 'Swept',
    })
    const sweptLog =
      sweptLogs.find((l) => l.address?.toLowerCase() === BASE_EXIT_SWEEPER_ADDRESS.toLowerCase()) ??
      sweptLogs[0]
    if (sweptLog) {
      ;({ burned, exited, skipped } = sweptLog.args)
    }
  } catch {
    // fall through with nulls - reporting failure, not execution failure
  }

  return { unwindTxHash, burned, exited, skipped }
}

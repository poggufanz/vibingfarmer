// frontend/src/base/withdrawBatch.js
// Withdraw -> Unwind (Approach C §6 step 8, §4 "withdraw requires the user's passkey"): ONE
// owner-signed batched userOp = N YieldRouter.withdraw calls + USDC.approve(TokenMessengerV2) +
// depositForBurnWithHook back to the user's own Stellar G-address via CctpForwarder. Uses the
// OWNER's kernel account directly (sudo = passkeyValidator, no session/regular plugin) — the
// session key created in wallet/mandate.js is never involved in withdrawal, because its policy
// never granted `withdraw` (drain-proof by omission, not by a runtime check).
import { encodeFunctionData } from 'viem'
import { YIELD_ROUTER_ADDRESS, YIELD_ROUTER_ABI, ERC20_ABI } from './config.js'
import { buildForwarderHookData, assertHookData } from './hookData.js'
import { createGaslessKernelClient } from './paymaster.js'

// Base Sepolia CCTP V2 constants (spikes/cctp-corridor/addresses.md, SP0-proven reverse leg).
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const BASE_TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const STELLAR_CCTP_FORWARDER = 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ'
const STELLAR_DOMAIN = 27
const MIN_FINALITY_STANDARD = 2000
const MAX_FEE = 0n
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` // valid empty bytes32 default (real calls pass the forwarder)

const DEPOSIT_FOR_BURN_WITH_HOOK_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ type: 'uint64' }],
  },
]

// contractId -> bytes32, viem hex form. StrKey.decodeContract yields the raw 32-byte contract id,
// same as spikes/cctp-corridor/reverse.mjs's `forwarder32`.
async function forwarderAddressBytes32() {
  const { StrKey } = await import('@stellar/stellar-sdk')
  const raw = StrKey.decodeContract(STELLAR_CCTP_FORWARDER)
  return `0x${Buffer.from(raw).toString('hex')}`
}

/**
 * Build the full unwind call array: withdraw from every pool, then approve + burn-with-hook the
 * total back to `stellarRecipient`. Validates hookData BEFORE returning anything — a malformed
 * hook must never reach a real burn call (Global Constraints: the #7313 gotcha).
 * @param {{ withdrawals: Array<{pool:string, shares:bigint, minAssets:bigint}>, stellarRecipient: string, totalAssetsForBurn: bigint, forwarderBytes32?: string }} p
 * @returns {Array<{to:string, data:string}>}
 */
export function buildUnwindCalls({ withdrawals, stellarRecipient, totalAssetsForBurn, forwarderBytes32 }) {
  if (!Array.isArray(withdrawals) || withdrawals.length === 0) {
    throw new Error('buildUnwindCalls requires at least one withdrawal')
  }
  const hookData = buildForwarderHookData(stellarRecipient)
  assertHookData(hookData) // throws loudly on anything malformed — never silently proceeds

  const withdrawCalls = withdrawals.map(({ pool, shares, minAssets }) => ({
    to: YIELD_ROUTER_ADDRESS,
    data: encodeFunctionData({ abi: YIELD_ROUTER_ABI, functionName: 'withdraw', args: [pool, shares, minAssets] }),
  }))

  const approveCall = {
    to: BASE_USDC,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [BASE_TOKEN_MESSENGER_V2, totalAssetsForBurn],
    }),
  }

  const forwarder32 = forwarderBytes32 ?? ZERO_BYTES32 // real calls precompute it; this default keeps encoding valid
  const burnCall = {
    to: BASE_TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_WITH_HOOK_ABI,
      functionName: 'depositForBurnWithHook',
      args: [
        totalAssetsForBurn,
        STELLAR_DOMAIN,
        forwarder32,
        BASE_USDC,
        forwarder32,
        MAX_FEE,
        MIN_FINALITY_STANDARD,
        `0x${Buffer.from(hookData).toString('hex')}`,
      ],
    }),
  }

  return [...withdrawCalls, approveCall, burnCall]
}

/**
 * Owner-signed (passkey), single userOp: build the unwind calls (resolving the forwarder's
 * bytes32 address first), encode, sign, submit, wait for a REAL success — never reports success
 * on a merely-mined-but-reverted userOp.
 * @param {{
 *   ownerKernelAccount: object,   // the account object from createBaseSmartAccount (sudo-only)
 *   publicClient: object,
 *   withdrawals: Array<object>,
 *   stellarRecipient: string,
 *   totalAssetsForBurn: bigint,
 *   deps?: { makeGaslessClient?: Function },
 * }} p
 * @returns {Promise<{ unwindTxHash: string }>}
 */
export async function signAndSubmitUnwind({ ownerKernelAccount, publicClient, withdrawals, stellarRecipient, totalAssetsForBurn, deps = {} }) {
  const { makeGaslessClient = createGaslessKernelClient } = deps
  const forwarderBytes32 = await forwarderAddressBytes32()
  const calls = buildUnwindCalls({ withdrawals, stellarRecipient, totalAssetsForBurn, forwarderBytes32 })

  const kernelClient = makeGaslessClient({ account: ownerKernelAccount, publicClient })
  const callData = await kernelClient.account.encodeCalls(calls.map((c) => ({ to: c.to, value: 0n, data: c.data })))
  const userOpHash = await kernelClient.sendUserOperation({ callData })
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash })
  const succeeded = receipt?.success === true || receipt?.receipt?.status === 'success'
  if (!succeeded) throw new Error(`unwind userOp did not succeed (userOpHash ${userOpHash})`)

  return { unwindTxHash: receipt.receipt.transactionHash }
}

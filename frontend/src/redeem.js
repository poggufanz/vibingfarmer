// redeem.js — encode the ERC-7715 erc20-token-periodic redeem (spike outcome a: managed
// array-param path). The redeem moves USDC from the user's MetaMask smart account into
// AgentVaultDepositor via token.transfer — the ONLY execution the periodic enforcer allows.
// The enforcer does NOT constrain the transfer recipient, so we transfer straight to the
// depositor. The 1Shot Managed API encodes DelegationManager.redeemDelegations from the
// registered ABI + the three on-chain arrays we build here, so we never need the SAK
// DelegationManager.encode calldata helper (that is only for the self-gas session path).
import { encodeFunctionData } from 'viem'
import { createExecution } from '@metamask/smart-accounts-kit'
import { encodeSingleExecution } from '@metamask/smart-accounts-kit/utils'
import { USDC_SEPOLIA } from './config.js'

// ERC-7579 single-call + default exec-type mode (== ExecutionMode.SingleDefault). 32 zero bytes.
// Verified at build time against `ExecutionMode.SingleDefault` from @metamask/smart-accounts-kit.
export const SINGLE_DEFAULT_MODE =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
]

/** erc20 transfer(recipient, amount) calldata — the only action the AP enforcer permits. */
export function buildTransferCalldata({ recipient, amount }) {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [recipient, BigInt(amount)],
  })
}

/**
 * ERC-7579 packed single-execution bytes for transfer(recipient, amount) on `token`.
 * @returns {`0x${string}`} encodeSingleExecution({target: token, value: 0, callData: transfer})
 */
export function encodeRedeemExecution({ recipient, amount, token = USDC_SEPOLIA }) {
  const execution = createExecution({
    target: token,
    value: 0n,
    callData: buildTransferCalldata({ recipient, amount }),
  })
  return encodeSingleExecution(execution)
}

/**
 * Build the three on-chain arrays for DelegationManager.redeemDelegations, ready to hand to
 * the 1Shot managed relay (which registers redeemDelegations(bytes[],bytes32[],bytes[])).
 * @param {object} p
 * @param {string} p.permissionContext  raw ERC-7715 grant context (the encoded delegation chain)
 * @param {string} p.recipient          where USDC lands (AgentVaultDepositor)
 * @param {bigint|string|number} p.amount  USDC units to transfer this redeem
 * @param {string} [p.token]            ERC-20 (defaults to USDC)
 * @returns {{permissionContexts: string[], modes: string[], executionCallDatas: string[]}}
 */
export function buildRedeemArrays({ permissionContext, recipient, amount, token = USDC_SEPOLIA }) {
  return {
    permissionContexts: [permissionContext],
    modes: [SINGLE_DEFAULT_MODE],
    executionCallDatas: [encodeRedeemExecution({ recipient, amount, token })],
  }
}

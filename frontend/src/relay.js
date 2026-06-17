// relay.js — encode/sign/submit for the EIP-712 deposit-only AgentVaultDepositor.
//
// Authorization model (Roadmap v2): the WORKER KEY signs an EIP-712 deposit struct; the
// contract recovers the signer and reads its scope from AgentRegistry. msg.sender is
// irrelevant, so ANY submitter (the 1Shot managed relayer, or the user's own wallet) can
// broadcast the call. Scope is granted up-front via AgentRegistry.authorizeSessionKey
// (user-signed, batched).
//
// Funding (main flow): ONE ERC-7715 erc20-token-periodic Advanced Permission is redeemed per
// worker (relayRedeem → USDC.transfer into the depositor, capped on-chain by the period
// enforcer), then depositHeld deposits the contract-held USDC (AgentHeldDeposit signature) —
// NO per-worker USDC approve. The legacy approve-funded path (signDeposit / relayDeposit /
// buildApproveCall / executeAgentDeposit + transferFrom) is retained as a fallback.

import { encodeFunctionData, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem'
import {
  AGENT_VAULT_DEPOSITOR_ADDRESS,
  AGENT_REGISTRY_ADDRESS,
  SEPOLIA_CHAIN_ID,
  USDC_SEPOLIA,
} from './config.js'
import { broadcastDepositOnChain } from './wallet.js'
import { buildRedeemArrays } from './redeem.js'

const RELAY_PROXY_URL = '/api/relay'

// ─── Deterministic execId ─────────────────────────────────────────────────────
/**
 * Deterministic execId per (owner, vault, planId, step).
 * NOTE: the contract does NOT recompute this — it only stores `executed[execId]` as given.
 * So this is an OFF-CHAIN contract among agent components (worker/orchestrator/retry) to
 * produce a stable id; the on-chain guard just dedupes whatever id it receives. Encoding
 * parity with `abi.encode(address,address,uint256,uint256)` is what matters: viem's
 * encodeAbiParameters yields the identical 32-byte-padded layout, so retries hash the same.
 * @returns {`0x${string}`} bytes32
 */
export function computeExecId({ owner, vault, planId, step }) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, uint256, uint256'), [
      owner,
      vault,
      BigInt(planId),
      BigInt(step),
    ])
  )
}

// ─── EIP-712 typed data (MUST match AgentVaultDepositor: name "VibingFarmer", version "1") ─
export const DEPOSIT_DOMAIN = (chainId, verifyingContract) => ({
  name: 'VibingFarmer',
  version: '1',
  chainId,
  verifyingContract,
})
export const DEPOSIT_TYPES = {
  AgentDeposit: [
    { name: 'amount', type: 'uint256' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'minShares', type: 'uint256' },
    { name: 'execId', type: 'bytes32' },
  ],
}

/**
 * Worker key signs the deposit. `workerSigner` is any viem-style account/wallet client
 * exposing signTypedData (e.g. privateKeyToAccount(pk)). Returns the 0x signature.
 * @param {bigint|string|number} [opts.minShares] floor on ERC-4626 shares minted; 0 opts out.
 */
export async function signDeposit(
  workerSigner,
  { chainId, depositor, amount, minAmount, minShares = 0, execId }
) {
  return workerSigner.signTypedData({
    domain: DEPOSIT_DOMAIN(chainId, depositor),
    types: DEPOSIT_TYPES,
    primaryType: 'AgentDeposit',
    message: {
      amount: BigInt(amount),
      minAmount: BigInt(minAmount),
      minShares: BigInt(minShares),
      execId,
    },
  })
}

// Held-funds deposit: distinct EIP-712 struct so a depositHeld signature can never be replayed
// as an executeAgentDeposit (matches AgentVaultDepositor.HELD_DEPOSIT_TYPEHASH). Same domain.
export const HELD_DEPOSIT_TYPES = {
  AgentHeldDeposit: [
    { name: 'amount', type: 'uint256' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'minShares', type: 'uint256' },
    { name: 'execId', type: 'bytes32' },
  ],
}

/** Worker key signs an AgentHeldDeposit (for depositHeld). Returns the 0x signature. */
export async function signHeldDeposit(
  workerSigner,
  { chainId, depositor, amount, minAmount, minShares = 0, execId }
) {
  return workerSigner.signTypedData({
    domain: DEPOSIT_DOMAIN(chainId, depositor),
    types: HELD_DEPOSIT_TYPES,
    primaryType: 'AgentHeldDeposit',
    message: {
      amount: BigInt(amount),
      minAmount: BigInt(minAmount),
      minShares: BigInt(minShares),
      execId,
    },
  })
}

/** Relay depositHeld via the 1Shot managed proxy. Returns null on failure (caller treats as fatal). */
export async function relayDepositHeld({ amount, minAmount, minShares = 0, execId, sig }) {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'depositHeld',
        amount: String(amount),
        minAmount: String(minAmount),
        minShares: String(minShares),
        execId,
        sig,
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.configured === false || d.error) return null
    return {
      txHash: d.txHash || 'pending',
      status: d.txHash ? 'relayed' : 'submitted',
      relayer: d.relayer,
    }
  } catch {
    return null
  }
}

// ─── Calldata encoders ────────────────────────────────────────────────────────
const DEPOSITOR_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'executeAgentDeposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' },
      { name: 'minShares', type: 'uint256' },
      { name: 'execId', type: 'bytes32' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
]

export function encodeExecuteAgentDeposit({ amount, minAmount, minShares = 0, execId, sig }) {
  return encodeFunctionData({
    abi: DEPOSITOR_DEPOSIT_ABI,
    functionName: 'executeAgentDeposit',
    args: [BigInt(amount), BigInt(minAmount), BigInt(minShares), execId, sig],
  })
}

const REGISTRY_AUTH_ABI = [
  {
    type: 'function',
    name: 'authorizeSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'vault', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'capPerPeriod', type: 'uint96' },
      { name: 'periodDuration', type: 'uint32' },
      { name: 'expiry', type: 'uint40' },
    ],
    outputs: [],
  },
]

/** {to,data} for AgentRegistry.authorizeSessionKey — user-signed, EIP-5792-batchable. */
export function buildAuthorizeSessionKeyCall({
  agent,
  vault,
  token,
  capPerPeriod,
  periodDuration,
  expiry,
}) {
  return {
    to: AGENT_REGISTRY_ADDRESS,
    data: encodeFunctionData({
      abi: REGISTRY_AUTH_ABI,
      functionName: 'authorizeSessionKey',
      args: [agent, vault, token, BigInt(capPerPeriod), Number(periodDuration), Number(expiry)],
    }),
  }
}

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
]

/** {to,data} approving the depositor to pull `amount` USDC (Jalur B transferFrom). */
export function buildApproveCall({ spender = AGENT_VAULT_DEPOSITOR_ADDRESS, amount }) {
  return {
    to: USDC_SEPOLIA,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [spender, BigInt(amount)],
    }),
  }
}

// ─── Submit a signed deposit ──────────────────────────────────────────────────
/**
 * Submit a signed deposit. Managed 1Shot proxy first (gas-abstracted); if unconfigured
 * or failing, broadcast the encoded calldata as a user-signed on-chain tx (one popup).
 * The signature — not msg.sender — is the authorization, so either submitter is valid.
 * @returns {Promise<{txHash: string, status: string, relayer?: string}>}
 */
export async function relayDeposit({ amount, minAmount, minShares = 0, execId, sig }) {
  const managed = await relayDepositManaged({ amount, minAmount, minShares, execId, sig })
  if (managed) return managed
  // Demo-day diagnostic: the popup-per-worker symptom only happens when this fallback fires.
  // Log exactly WHY 1Shot returned null (rate-limit 429/503, auth, not-configured, network)
  // so a fallback during a live demo is explainable from the console, not guesswork.
  console.warn(
    '[relay] 1Shot managed relay returned null — falling back to user-signed MetaMask tx',
    getLastRelayDiag() || {}
  )
  const calldata = encodeExecuteAgentDeposit({ amount, minAmount, minShares, execId, sig })
  const txHash = await broadcastFallback(calldata)
  return { txHash, status: 'onchain' }
}

// Why the last managed-relay attempt returned null. Surfaced via getLastRelayDiag() and
// logged at the fallback site. Cleared on success.
let _lastRelayDiag = null
/** @returns {{reason:string,status?:number,body?:any,error?:string}|null} */
export function getLastRelayDiag() {
  return _lastRelayDiag
}

// Serialize all user-signed fallbacks. The user EOA (delegated under EIP-7702) allows only
// ONE in-flight tx — parallel fallbacks collide with "in-flight transaction limit reached".
// Even if dispatch ever goes parallel again, this chain keeps fallbacks one-at-a-time.
let _fallbackChain = Promise.resolve()
function broadcastFallback(calldata) {
  const run = _fallbackChain.then(() => broadcastDepositOnChain(calldata))
  _fallbackChain = run.catch(() => {}) // a failed link must not poison the queue
  return run
}

/** Managed-API proxy submit. Returns null when unconfigured/failed → caller falls back.
 *  Records why in _lastRelayDiag so the fallback site can log the real reason. */
export async function relayDepositManaged({ amount, minAmount, minShares = 0, execId, sig }) {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'deposit',
        amount: String(amount),
        minAmount: String(minAmount),
        minShares: String(minShares),
        execId,
        sig,
      }),
    })
    if (!res.ok) {
      // 503 not-configured / 429 rate-limit / 4xx-5xx → on-chain fallback
      _lastRelayDiag = {
        reason: 'http-error',
        status: res.status,
        body: await res.text().catch(() => ''),
      }
      return null
    }
    const data = await res.json()
    if (data.configured === false || data.error) {
      _lastRelayDiag = { reason: 'not-configured-or-error', status: res.status, body: data }
      return null
    }
    _lastRelayDiag = null
    return {
      txHash: data.txHash || data.transactionId || 'pending',
      status: data.txHash ? 'relayed' : 'submitted',
      relayer: data.relayer,
    }
  } catch (err) {
    _lastRelayDiag = { reason: 'network-exception', error: err?.message || String(err) }
    return null
  }
}

/**
 * Redeem the ERC-7715 AP for ONE slice: USDC.transfer(depositor, amount), broadcast by the
 * 1Shot server wallet (= the grant grantee, so msg.sender == leaf delegate). Builds the three
 * redeemDelegations arrays client-side and submits them to the managed relay (spike outcome a).
 * Returns null on failure so the caller can surface it (the worker treats null as fatal — a
 * deposit cannot be funded without the redeem).
 * @param {{permissionContext:string, recipient:string, amount:bigint|string|number}} p
 * @returns {Promise<{txHash:string,status:string,relayer?:string}|null>}
 */
export async function relayRedeem({ permissionContext, recipient, amount }) {
  try {
    const { permissionContexts, modes, executionCallDatas } = buildRedeemArrays({
      permissionContext,
      recipient,
      amount,
    })
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'redeem', permissionContexts, modes, executionCallDatas }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.configured === false || d.error) return null
    return {
      txHash: d.txHash || 'pending',
      status: d.txHash ? 'redeemed' : 'submitted',
      relayer: d.relayer,
    }
  } catch {
    return null
  }
}

/** Server wallet (1Shot relayer) address for the current chain — fund it for gas. null if unconfigured. */
export async function getRelayerAddress() {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'wallet' }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.address || null
  } catch {
    return null
  }
}

/** Current chain id as string — small helper kept for callers that branch on chain. */
export const chainIdStr = () => String(SEPOLIA_CHAIN_ID)

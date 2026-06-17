import { ethers } from 'ethers'
import { createWalletClient, custom } from 'viem'
import { baseSepolia } from 'viem/chains'
import { erc7715ProviderActions } from '@metamask/smart-accounts-kit/actions'
import {
  SEPOLIA_CHAIN_ID_HEX,
  AGENT_VAULT_DEPOSITOR_ADDRESS,
  AGENT_REGISTRY_ADDRESS,
  DEPOSITOR_ABI,
  REGISTRY_ABI,
  VAULT_ABI,
  USDC_SEPOLIA,
} from './config.js'
import { requireFlask } from './flaskDetect.js'
import { getReadProvider } from './readProvider.js'
import { prepareSessionAccount, saveSessionGrant, getSessionAddress } from './strategy/session.js'
import { getRelayerAddress } from './relay.js'

/**
 * Normalize the wallet_requestExecutionPermissions result into the fields the
 * session layer needs. SAK returns an array of PermissionResponse objects, each
 * carrying { context, delegationManager, dependencies }.
 * @param {any} result
 * @returns {{permissionContext: string, delegationManager: string|null, grantedPermissions: Array}}
 */
export function parseGrantResult(result) {
  const first = Array.isArray(result) ? result[0] : result
  return {
    permissionContext:
      first?.context || first?.permissionContext || result?.permissionContext || '0xmock',
    delegationManager: first?.delegationManager || null,
    grantedPermissions: Array.isArray(result) ? result : result?.grantedPermissions || [],
  }
}

let ethersProvider = null
let account = null

// ─── MetaMask single-queue guard (-32002 defense) ──────────────────────────────
// MetaMask Flask routes ALL wallet RPC through ONE service-worker queue. A
// wallet_requestExecutionPermissions (ERC-7715) grant in particular stays "in
// process" briefly AFTER its JS promise resolves, so a wallet_sendCalls fired right
// after throws -32002 ("Cannot process requests while a
// wallet_requestExecutionPermissions request is in process"). The EIP-7702-delegated
// EOA also allows only ONE in-flight tx. Two defenses, combined in runWallet():
//   1. SERIALIZE — chain every wallet-mutating call so two never overlap.
//   2. RETRY — ride over the transient busy window once the prior request settles.
let _walletQueue = Promise.resolve()

function isWalletBusy(err) {
  const code = err?.code ?? err?.info?.error?.code
  return (
    code === -32002 || /already pending|in process|already processing/i.test(err?.message || '')
  )
}

/**
 * Enqueue `fn` so it runs only after all prior wallet calls settle, retrying a
 * transient MetaMask-busy (-32002) a few times before giving up. A user rejection
 * (4001) is never retried; any non-busy error surfaces immediately.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function runWallet(fn, { tries = 5, delayMs = 1200 } = {}) {
  const exec = async () => {
    let lastErr
    for (let i = 0; i < tries; i++) {
      try {
        return await fn()
      } catch (err) {
        if (err?.code === 4001 || err?.info?.error?.code === 4001) throw err // user rejected
        if (!isWalletBusy(err)) throw err
        lastErr = err
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw lastErr
  }
  // Run on the tail of the queue regardless of whether a prior link resolved or rejected,
  // and never let a failed link poison the chain for the next caller.
  const run = _walletQueue.then(exec, exec)
  _walletQueue = run.catch(() => {})
  return run
}

// Base Sepolia (84532) params for wallet_addEthereumChain — the chain may not be
// pre-registered in the user's MetaMask, so switch can fail with 4902 (unknown chain).
const BASE_SEPOLIA_PARAMS = {
  chainId: SEPOLIA_CHAIN_ID_HEX,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
}

/** Switch to Base Sepolia, adding the chain to MetaMask first if it's unknown (4902). */
async function switchOrAddChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    })
  } catch (e) {
    // 4902 = chain not added to MetaMask → add it, which also switches.
    if (e?.code === 4902 || /Unrecognized chain|not added/i.test(e?.message || '')) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [BASE_SEPOLIA_PARAMS],
      })
    } else {
      throw e
    }
  }
}

/**
 * Connect MetaMask Flask, switch to Sepolia if needed.
 * Returns connected account address.
 * @returns {Promise<string>} account address
 */
export async function connectWallet() {
  if (!window.ethereum) throw new Error('MetaMask Flask not found. Install Flask 13.9+.')

  // Request accounts
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  account = accounts[0]

  // Ensure Base Sepolia (add the chain if MetaMask doesn't know it yet)
  const chainId = await window.ethereum.request({ method: 'eth_chainId' })
  if (chainId !== SEPOLIA_CHAIN_ID_HEX) {
    try {
      await switchOrAddChain()
    } catch (e) {
      throw new Error(`Switch to Base Sepolia in MetaMask. Current: ${chainId}`)
    }
  }

  // Setup ethers provider for contract calls
  ethersProvider = new ethers.BrowserProvider(window.ethereum)

  return account
}

/**
 * Get connected account. Must call connectWallet() first.
 * @returns {string|null}
 */
export function getAccount() {
  return account
}

/**
 * Get the ethers BrowserProvider set up by connectWallet().
 * Used by attestation.js for read/sign access. Null until connected.
 * @returns {ethers.BrowserProvider|null}
 */
export function getProvider() {
  return ethersProvider
}

/**
 * Silently re-read the already-authorized account WITHOUT prompting MetaMask.
 * Uses `eth_accounts` (read-only, no popup) so a page reload can restore the
 * connected address when the user previously approved this dapp. Rebuilds the
 * ethers provider so downstream contract calls work right after reload.
 * @returns {Promise<string|null>} connected address, or null if none / locked.
 */
export async function getAccountsSilent() {
  if (!window?.ethereum) return null
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    const addr = accounts?.[0] || null
    if (addr) {
      account = addr
      ethersProvider = new ethers.BrowserProvider(window.ethereum)
    }
    return addr
  } catch {
    return null
  }
}

/**
 * Subscribe to MetaMask account changes (account switch / disconnect / lock).
 * Keeps the module account cache in sync and notifies the caller with the new
 * account list. Returns an unsubscribe fn (no-op if the provider can't emit).
 * @param {(accounts: string[]) => void} cb
 * @returns {() => void}
 */
export function onAccountsChanged(cb) {
  if (!window?.ethereum?.on) return () => {}
  const handler = (accounts) => {
    account = accounts?.[0] || null
    ethersProvider = account ? new ethers.BrowserProvider(window.ethereum) : null
    cb(accounts || [])
  }
  window.ethereum.on('accountsChanged', handler)
  return () => {
    try {
      window.ethereum.removeListener?.('accountsChanged', handler)
    } catch {
      /* ignore */
    }
  }
}

/** Prompt MetaMask to switch to Base Sepolia (adds the chain if unknown). */
export async function switchToSepolia() {
  if (!window.ethereum) throw new Error('MetaMask Flask not found.')
  await switchOrAddChain()
}

/**
 * Request a REAL ERC-7715 erc20-token-periodic permission on Base Sepolia via MetaMask SAK.
 * EIP-7702 is handled internally by SAK — do NOT call eth_signAuthorization.
 * Grantee (`to`) = the redeemer that will broadcast the redeem: the 1Shot server wallet for the
 * managed path (redeem spike outcome a), or the in-browser session EOA as a self-gas fallback.
 * @param {bigint|string|number} capUnits - period cap in USDC units (>= total planned deposit)
 * @param {number} expirySeconds - seconds from now
 * @returns {Promise<{permissionContext: string, delegationManager: string|null, grantee: string, grantedPermissions: Array}>}
 */
export async function requestERC7715Permission(capUnits, expirySeconds = 86400) {
  if (!window.ethereum) throw new Error('MetaMask Flask not found.')
  if (!account) throw new Error('Wallet not connected. Call connectWallet() first.')

  // Gate: ERC-7715 needs MetaMask Flask 13.5+. Surface FLASK_REQUIRED:<type> for the UI gate.
  try {
    await requireFlask()
  } catch (err) {
    if (err.message?.startsWith('FLASK_REQUIRED')) throw new Error(err.message)
    throw err
  }

  // Ensure the session account exists (self-gas fallback grantee + redemption identity).
  prepareSessionAccount()

  // Grantee = the redeemer that broadcasts the redeem. redeemDelegations checks
  // msg.sender == leaf delegate, so this MUST equal whoever submits the redeem. Prefer the
  // 1Shot server wallet (managed redeem, spike outcome a); fall back to the session EOA.
  const grantee = (await getRelayerAddress()) || getSessionAddress() || prepareSessionAccount()

  const walletClient = createWalletClient({ transport: custom(window.ethereum) }).extend(
    erc7715ProviderActions()
  )

  // Serialized via runWallet so MetaMask's post-grant "in process" window can't -32002-jam the
  // authorizeSessionKey batch fired right after.
  const result = await runWallet(() =>
    walletClient.requestExecutionPermissions([
      {
        chainId: baseSepolia.id,
        from: account,
        to: grantee,
        expiry: Math.floor(Date.now() / 1000) + expirySeconds,
        permission: {
          type: 'erc20-token-periodic',
          isAdjustmentAllowed: true,
          data: {
            tokenAddress: USDC_SEPOLIA,
            periodAmount: BigInt(capUnits), // bigint — the SAK shape (NOT the stale hex)
            periodDuration: 86400,
            justification: 'Vibing Farmer: fund multi-vault yield deposits',
          },
        },
      },
    ])
  )

  if (!result) throw new Error('No permission result returned from MetaMask')
  const grantData = { ...parseGrantResult(result), grantee }
  saveSessionGrant(grantData)
  return grantData
}

/**
 * Authorize a worker key (agent) in AgentRegistry — user-signed. Grants ONE scope:
 * (vault, token, capPerPeriod, periodDuration, expiry). One agent key = one scope forever.
 * @param {string} agent - worker key address (EIP-712 signer the depositor will recover)
 * @param {string} vault - ERC-4626 vault address
 * @param {string} token - underlying asset (USDC)
 * @param {bigint} capPerPeriod - uint96 max spend per period (units)
 * @param {number} periodDuration - uint32 seconds
 * @param {number} expiry - uint40 unix timestamp
 * @returns {Promise<string>} tx hash
 */
export async function authorizeSessionKeyOnChain(
  agent,
  vault,
  token,
  capPerPeriod,
  periodDuration,
  expiry
) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  return runWallet(async () => {
    const signer = await ethersProvider.getSigner()
    const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, signer)
    const tx = await registry.authorizeSessionKey(
      agent,
      vault,
      token,
      capPerPeriod,
      periodDuration,
      expiry
    )
    await tx.wait()
    return tx.hash
  })
}

/**
 * Broadcast an already-signed executeAgentDeposit calldata (user pays gas). The EIP-712
 * worker signature inside `calldata` is the authorization — msg.sender is irrelevant — so
 * the user's wallet broadcasting is just as valid as the relayer doing it.
 * @param {string} calldata - encoded executeAgentDeposit(amount,minAmount,minShares,execId,sig)
 * @returns {Promise<string>} tx hash
 */
export async function broadcastDepositOnChain(calldata) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  try {
    // Serialized + busy-retried: rides over MetaMask's transient -32002 window after a
    // 7715 grant / batch, and never overlaps another in-flight tx on the delegated EOA.
    return await runWallet(async () => {
      const signer = await ethersProvider.getSigner()
      const tx = await signer.sendTransaction({
        to: AGENT_VAULT_DEPOSITOR_ADDRESS,
        data: calldata,
        gasLimit: 350000n,
      })
      await tx.wait()
      return tx.hash
    })
  } catch (err) {
    // -32002 still after retries → MetaMask is wedged on a stuck request the user must clear.
    const code = err?.code ?? err?.info?.error?.code
    if (code === -32002 || /already pending|in process/i.test(err?.message || '')) {
      throw new Error(
        'MetaMask busy: a wallet request is still pending. Open MetaMask and resolve/close it (or restart the extension), then retry.'
      )
    }
    throw err
  }
}

/** Read the user's USDC balance (raw 6-decimal units) via the read-only provider, or null on failure. */
export async function readUsdcBalance(user) {
  try {
    const erc20 = new ethers.Contract(
      USDC_SEPOLIA,
      ['function balanceOf(address) view returns (uint256)'],
      getReadProvider()
    )
    return await erc20.balanceOf(user)
  } catch {
    return null
  }
}

/** Approve the depositor to pull `amount` USDC (Jalur B transferFrom) — user-signed.
 *  Used as the non-batched fallback when the wallet lacks EIP-5792. */
export async function approveDepositorOnChain(amount) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  return runWallet(async () => {
    const signer = await ethersProvider.getSigner()
    const erc20 = new ethers.Contract(
      USDC_SEPOLIA,
      ['function approve(address spender, uint256 amount) returns (bool)'],
      signer
    )
    const tx = await erc20.approve(AGENT_VAULT_DEPOSITOR_ADDRESS, BigInt(amount))
    await tx.wait()
    return tx.hash
  })
}

/** Revoke a single agent scope — user-signed AgentRegistry.revokeAgent. Works even if the
 *  relayer is down (purely protective; the headline "user can revoke any time" rests on it). */
export async function revokeAgentDirect(agent) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  const signer = await ethersProvider.getSigner()
  const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, signer)
  const tx = await registry.revokeAgent(agent)
  await tx.wait()
  return tx.hash
}

/** Revoke many agent scopes in one user-signed tx — AgentRegistry.revokeMany. */
export async function revokeManyDirect(agents) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  const signer = await ethersProvider.getSigner()
  const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, signer)
  const tx = await registry.revokeMany(agents)
  await tx.wait()
  return tx.hash
}

/** Read an agent's full scope from AgentRegistry (or null on failure). */
export async function readScope(agent) {
  try {
    const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, getReadProvider())
    const s = await registry.scopeOf(agent)
    return {
      owner: s.owner,
      vault: s.vault,
      token: s.token,
      capPerPeriod: s.capPerPeriod,
      periodDuration: Number(s.periodDuration),
      spentInPeriod: s.spentInPeriod,
      periodStart: Number(s.periodStart),
      expiry: Number(s.expiry),
      revoked: s.revoked,
    }
  } catch {
    return null
  }
}

/** User-signed ERC-4626 withdraw of `assets` (token units) from `vault` to the user.
 *  The user owns the shares (deposit minted them to the owner), so this is a direct tx.
 *  Returns { txHash, status }. */
export async function withdrawFromVaultOnChain(vault, assets, user) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  const signer = await ethersProvider.getSigner()
  const contract = new ethers.Contract(vault, VAULT_ABI, signer)
  const tx = await contract.withdraw(BigInt(assets), user, user, { gasLimit: 300000n })
  await tx.wait()
  return { txHash: tx.hash, status: 'onchain' }
}

/** User-signed ERC-4626 redeem of `shares` from `vault` back to the user (owner == receiver).
 *  The v2 MockVault is plain ERC-4626: no relayer/session-key withdraw path, so withdraw is
 *  always a direct user tx (the user owns the shares). Returns { txHash, status }. */
export async function redeemFromVaultOnChain(vault, shares, user) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  const signer = await ethersProvider.getSigner()
  const contract = new ethers.Contract(vault, VAULT_ABI, signer)
  const tx = await contract.redeem(BigInt(shares), user, user, { gasLimit: 300000n })
  await tx.wait()
  return { txHash: tx.hash, status: 'onchain' }
}

/** The v2 MockVault has no depositTimestamp — kept as a 0-stub so UI callers don't break. */
export async function readVaultDepositTimestamp() {
  return 0
}

/**
 * Batch many calls into ONE user confirmation via EIP-5792 wallet_sendCalls
 * (MetaMask Flask + EIP-7702: calls run from the user's own account address).
 * Polls wallet_getCallsStatus for real confirmation timing.
 * @param {Array<{to:string,data:string}>} calls
 * @returns {Promise<string|null>} representative tx hash, or null if wallet lacks EIP-5792
 */
export async function batchCalls(calls) {
  if (!window.ethereum || !account) throw new Error('Wallet not connected.')
  let res
  try {
    // Serialized + busy-retried so the 7715 grant fully settles before this batch fires
    // (otherwise -32002 "wallet_requestExecutionPermissions in process").
    res = await runWallet(() =>
      window.ethereum.request({
        method: 'wallet_sendCalls',
        params: [
          {
            version: '2.0.0',
            from: account,
            chainId: SEPOLIA_CHAIN_ID_HEX,
            atomicRequired: true,
            calls: calls.map((c) => ({ to: c.to, data: c.data })),
          },
        ],
      })
    )
  } catch (e) {
    if (e?.code === 4001) throw e // user rejected — surface it
    return null // method unsupported → caller falls back
  }
  const id = typeof res === 'string' ? res : res?.id
  for (let i = 0; i < 90; i++) {
    const st = await window.ethereum.request({ method: 'wallet_getCallsStatus', params: [id] })
    const code = st?.status
    if (code === 'CONFIRMED' || code === 200) return st?.receipts?.[0]?.transactionHash || id
    if (code === 'FAILED' || (typeof code === 'number' && code >= 400))
      throw new Error('Batch tx reverted')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Batch confirmation timed out')
}

/**
 * Subscribe to an on-chain event and call callback on each. Routes to the right contract:
 * AgentAuthorized / AgentRevoked → AgentRegistry; AgentDepositExecuted → AgentVaultDepositor.
 * @param {string} eventName
 * @param {function} callback - (...args, event) => void (ethers v6 listener signature)
 * @returns {function} unsubscribe function
 */
export async function onContractEvent(eventName, callback) {
  if (!ethersProvider) throw new Error('Wallet not connected.')
  const isRegistry = eventName === 'AgentAuthorized' || eventName === 'AgentRevoked'
  const contract = isRegistry
    ? new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, ethersProvider)
    : new ethers.Contract(AGENT_VAULT_DEPOSITOR_ADDRESS, DEPOSITOR_ABI, ethersProvider)
  contract.on(eventName, callback)
  return () => contract.off(eventName, callback)
}

/**
 * Sign a SIWE message for Venice x402 wallet authentication.
 * Returns base64-encoded X-Sign-In-With-X header value.
 * No private key needed — MetaMask personal_sign only.
 * SIWE expires in 5 minutes; call fresh per session.
 * @param {string} address - connected wallet address
 * @returns {Promise<string>} base64 header value
 */
export async function signSiweForVenice(address) {
  const now = new Date()
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const resourceUrl = 'https://api.venice.ai/api/v1/chat/completions'
  const message = [
    'api.venice.ai wants you to sign in with your Ethereum account:',
    address,
    '',
    'Sign in to Venice AI',
    '',
    `URI: ${resourceUrl}`,
    'Version: 1',
    'Chain ID: 8453',
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${new Date(now.getTime() + 5 * 60 * 1000).toISOString()}`,
  ].join('\n')

  const signature = await window.ethereum.request({
    method: 'personal_sign',
    params: [message, address],
  })

  return btoa(
    JSON.stringify({
      address,
      message,
      signature,
      timestamp: now.getTime(),
      chainId: 8453,
    })
  )
}

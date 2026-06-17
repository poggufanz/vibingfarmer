// Server-side 1Shot Managed API proxy. Keeps ONESHOT_KEY / ONESHOT_SECRET /
// ONESHOT_BIZ_ID off the client bundle (mirrors api/ai.js).
//
// Why this exists: the keyless 1Shot Permissionless Relayer is mainnet-only
// (verified live via relayer_getCapabilities). Real, gas-abstracted 1Shot on
// Base Sepolia (84532) only exists through the Managed Dev Platform API, which
// authenticates with key+secret and a funded server wallet — secrets that can
// never ship in a Vite client bundle.
//
// Execution model (server-wallet-as-relayer):
//   The 1Shot server wallet broadcasts executeAgentDeposit(amount, minAmount, execId, sig).
//   Authorization is the EIP-712 WORKER-KEY signature inside `sig` — the depositor recovers
//   the signer and reads its scope from AgentRegistry — so msg.sender (the server wallet) is
//   irrelevant. The server wallet only sponsors gas; the cryptographic boundary is the sig +
//   the on-chain scope. No EIP-7702 / delegation redemption required.
//
// Two POST actions:
//   { action: 'wallet' }
//       → { address, chainId, walletId }      (auto-provisions the server wallet)
//   { action: 'deposit', amount, minAmount, execId, sig }
//       → { txHash, status }                  (executes + polls to a real hash)

import { applyCors, rateLimit } from './_guard.js'

const CHAIN_ID = 84532 // Base Sepolia

// 1Shot NewSolidityStructParam shape: `type` is the BASE enum
// (address/bool/bytes/int/string/uint/struct) — bit/byte width goes in `typeSize`,
// and `index` (ordinal position) is REQUIRED. bytes32 → {type:'bytes',typeSize:32};
// uint256 → {type:'uint',typeSize:256}; dynamic bytes → {type:'bytes'} (no typeSize).
const DEPOSIT_FN = 'executeAgentDeposit'
const DEPOSIT_INPUTS = [
  { name: 'amount', type: 'uint', typeSize: 256, index: 0 },
  { name: 'minAmount', type: 'uint', typeSize: 256, index: 1 },
  { name: 'minShares', type: 'uint', typeSize: 256, index: 2 },
  { name: 'execId', type: 'bytes', typeSize: 32, index: 3 },
  { name: 'sig', type: 'bytes', index: 4 },
]

// depositHeld has the SAME 5 scalar inputs as executeAgentDeposit (deposits contract-held
// USDC pushed in by an ERC-7715 redeem; authorization is still the worker EIP-712 sig).
const HELD_FN = 'depositHeld'

// DelegationManager (Base Sepolia) — target of the ERC-7715 redeem. The 1Shot Managed API
// encodes redeemDelegations(bytes[],bytes32[],bytes[]) from this ABI + the three arrays the
// client builds (spike outcome a: array params accepted). isArray flags the array base type.
const DM_ADDRESS = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
const REDEEM_FN = 'redeemDelegations'
const REDEEM_INPUTS = [
  { name: 'permissionContexts', type: 'bytes', isArray: true, index: 0 },
  { name: 'modes', type: 'bytes', typeSize: 32, isArray: true, index: 1 },
  { name: 'executionCallDatas', type: 'bytes', isArray: true, index: 2 },
]

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const BYTES_RE = /^0x[0-9a-fA-F]*$/
const UINT_RE = /^[0-9]+$/

// Canonical depositor address — server-controlled, NEVER from the client.
// A client-supplied target would let a caller make the funded server wallet
// register + execute against an arbitrary contract (and poison the method cache).
function depositorAddress() {
  return (
    process.env.AGENT_VAULT_DEPOSITOR_ADDRESS ||
    process.env.VITE_AGENT_VAULT_DEPOSITOR_ADDRESS ||
    ''
  )
}

// Warm-process caches — survive across calls in the same dev middleware process
// or warm serverless lambda. Re-resolved from the API on cold start.
let _client = null
let _serverWallet = null // { id, accountAddress }
const _contractMethodIds = new Map() // `${depositorAddress.toLowerCase()}:${fnName}` → methodId

// ─── execId replay guard (gas-drain DoS defense) ───
// A valid {execId,sig} resubmitted repeatedly reverts AlreadyExecuted ON-CHAIN, but
// each replay still costs the funded server wallet a broadcast + gas for the reverting
// tx. We short-circuit BEFORE broadcasting on two layers:
//   1. warm-process cache of execIds we've already terminally handled (cheap, also
//      collapses concurrent duplicates by marking in-flight).
//   2. authoritative on-chain read of `executed[execId]` — survives cold starts and
//      catches execIds first landed via another path. Fail-open on RPC error so a real
//      deposit is never blocked by an RPC hiccup.
const _seenExecIds = new Map() // execId → { state:'in-flight'|'done', txHash?, at }
const SEEN_MAX = 5000
const SEEN_TTL_MS = 30 * 60_000

function pruneSeen(now) {
  for (const [k, v] of _seenExecIds) {
    if (now - v.at > SEEN_TTL_MS) _seenExecIds.delete(k)
  }
}

// Public mapping getter: `mapping(bytes32 => bool) public executed`.
const EXECUTED_ABI = [
  {
    type: 'function',
    name: 'executed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
]

function rpcUrl() {
  return (
    process.env.RPC_URL ||
    process.env.VITE_RPC_URL ||
    process.env.SEPOLIA_RPC ||
    'https://sepolia.base.org'
  )
}

/** Authoritative on-chain check of `executed[execId]`. Fail-open (returns false) on any error. */
async function isExecutedOnChain(depositor, execId) {
  try {
    const { encodeFunctionData, decodeFunctionResult } = await import('viem')
    const data = encodeFunctionData({ abi: EXECUTED_ABI, functionName: 'executed', args: [execId] })
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: depositor, data }, 'latest'],
      }),
    })
    const json = await res.json()
    if (!json?.result) return false
    return (
      decodeFunctionResult({ abi: EXECUTED_ABI, functionName: 'executed', data: json.result }) ===
      true
    )
  } catch {
    return false // never block a legitimate deposit on an RPC failure
  }
}

// Positively-confirmed code presence at `addr`. A relayed executeAgentDeposit to a
// CODELESS address does NOT revert — the EVM treats a call to an account with no code
// as a successful no-op, so 1Shot reports a green tx while USDC never moves and no shares
// mint (the "1Shot succeeds but vault shares didn't increase" symptom). We refuse to
// broadcast in that case so the client falls back to a user-signed tx against the live
// contract. Fail-OPEN (returns true) on any RPC error — never block a real deposit on a hiccup.
async function hasCode(addr) {
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [addr, 'latest'],
      }),
    })
    const json = await res.json()
    if (typeof json?.result !== 'string') return true // inconclusive → don't block
    return json.result !== '0x' && json.result !== '0x0'
  } catch {
    return true // RPC failure → fail-open, let the deposit proceed
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body // pre-parsed (serverless)
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function getClient() {
  if (_client) return _client
  const apiKey = process.env.ONESHOT_KEY
  const apiSecret = process.env.ONESHOT_SECRET
  if (!apiKey || !apiSecret || !process.env.ONESHOT_BIZ_ID) return null
  // Dynamic import so a missing package / missing creds never breaks vite.config load.
  return import('@uxly/1shot-client').then(({ OneShotClient }) => {
    _client = new OneShotClient({ apiKey, apiSecret })
    return _client
  })
}

/** Resolve (or auto-create) the Base Sepolia server wallet that sponsors gas. */
async function resolveServerWallet(client, bizId) {
  if (_serverWallet) return _serverWallet
  const list = await client.wallets.list(bizId, { chainId: CHAIN_ID })
  const existing = (list?.response || list?.data || list)?.[0]
  if (existing?.accountAddress) {
    _serverWallet = { id: existing.id, accountAddress: existing.accountAddress }
    return _serverWallet
  }
  const created = await client.wallets.create(bizId, {
    chainId: CHAIN_ID,
    name: 'Vibing Farmer Relayer (Base Sepolia)',
    description: 'Sponsors gas for AgentVaultDepositor.executeAgentDeposit',
  })
  _serverWallet = { id: created.id, accountAddress: created.accountAddress }
  return _serverWallet
}

const FN_META = {
  [DEPOSIT_FN]: {
    inputs: DEPOSIT_INPUTS,
    name: 'AgentVaultDepositor.executeAgentDeposit',
    desc: 'Relayed agent deposit authorized by an EIP-712 worker-key signature',
  },
  [HELD_FN]: {
    inputs: DEPOSIT_INPUTS,
    name: 'AgentVaultDepositor.depositHeld',
    desc: 'Deposit contract-held USDC (ERC-7715 redeemed) authorized by an EIP-712 worker-key signature',
  },
  [REDEEM_FN]: {
    inputs: REDEEM_INPUTS,
    name: 'DelegationManager.redeemDelegations',
    desc: 'ERC-7710 redeem of an ERC-7715 AP (USDC transfer to depositor)',
  },
}

/** Resolve (or auto-register) a contract method bound to the server wallet. */
async function resolveContractMethod(client, bizId, depositor, walletId, fnName = DEPOSIT_FN) {
  const cacheKey = `${depositor.toLowerCase()}:${fnName}`
  const cached = _contractMethodIds.get(cacheKey)
  if (cached) return cached
  const list = await client.contractMethods.list(bizId, { chainId: CHAIN_ID })
  const methods = list?.response || list?.data || list || []
  const match = methods.find(
    (m) =>
      m.functionName === fnName &&
      (m.contractAddress || '').toLowerCase() === depositor.toLowerCase()
  )
  if (match) {
    _contractMethodIds.set(cacheKey, match.id)
    return match.id
  }
  const meta = FN_META[fnName]
  const created = await client.contractMethods.create(bizId, {
    chainId: CHAIN_ID,
    contractAddress: depositor,
    walletId,
    name: meta.name,
    description: meta.desc,
    functionName: fnName,
    stateMutability: 'nonpayable',
    inputs: meta.inputs,
    outputs: [],
  })
  // Defend against a platform that dedups create-by-name and returns a PRE-EXISTING method
  // bound to a different (stale) contractAddress. Executing that would broadcast to the wrong
  // address. If the registered target doesn't match what we asked for, refuse — the caller
  // catches and falls back to a user-signed tx against the correct contract.
  const createdAddr = (created.contractAddress || '').toLowerCase()
  if (createdAddr && createdAddr !== depositor.toLowerCase()) {
    throw new Error(
      `1Shot method bound to ${created.contractAddress}, expected ${depositor} — refusing stale target`
    )
  }
  _contractMethodIds.set(cacheKey, created.id)
  return created.id
}

/** Poll a 1Shot transaction to a real on-chain hash (or terminal failure). */
async function pollForHash(client, txId, { tries = 16, intervalMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const tx = await client.transactions.get(txId)
    if (tx?.transactionHash) return { txHash: tx.transactionHash, status: tx.status }
    if (tx?.status === 'Failed') throw new Error('1Shot transaction failed')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  // Submitted but not yet mined within budget — return id so client can keep polling.
  return { txHash: null, status: 'Submitted', transactionId: txId }
}

// Shared executor for the two scalar-input deposit methods (executeAgentDeposit + depositHeld):
// same validation, stale-address guard, execId replay short-circuit, and managed broadcast —
// only the registered contract method (fnName) differs. The on-chain `executed[execId]` mapping
// is shared by both methods, so sharing the warm replay cache across them is correct.
async function runDepositLike(res, client, bizId, fnName, body) {
  const { amount, minAmount, minShares, execId, sig } = body
  // Target contract is server-controlled — NEVER from the client. Authorization is the EIP-712
  // worker-key signature; the server wallet just sponsors gas.
  const depositor = depositorAddress()
  if (!ADDRESS_RE.test(depositor)) return bad(res, 'Depositor address not configured')
  // Stale-address guard: a relayed call to a codeless address "succeeds" as a no-op and silently
  // eats the deposit. Refuse → client surfaces it. Logs the bad address for diagnosis.
  if (!(await hasCode(depositor))) {
    console.error('[api/relay] depositor has NO CODE — refusing no-op broadcast:', depositor)
    return bad(res, 'Depositor address has no code on-chain (stale/misconfigured): ' + depositor)
  }
  if (!UINT_RE.test(String(amount ?? ''))) return bad(res, 'Invalid amount')
  if (!UINT_RE.test(String(minAmount ?? ''))) return bad(res, 'Invalid minAmount')
  if (!UINT_RE.test(String(minShares ?? '0'))) return bad(res, 'Invalid minShares')
  if (!BYTES32_RE.test(execId || '')) return bad(res, 'Invalid execId')
  if (!BYTES_RE.test(sig || '') || (sig || '').length < 4) return bad(res, 'Invalid sig')

  // ─── Replay short-circuit (never re-broadcast a spent execId) ───
  const now = Date.now()
  if (_seenExecIds.size > SEEN_MAX) pruneSeen(now)
  const seen = _seenExecIds.get(execId)
  if (seen) {
    if (seen.state === 'done') {
      return res.end(
        JSON.stringify({
          txHash: seen.txHash || null,
          status: 'duplicate',
          relayer: seen.relayer || null,
        })
      )
    }
    res.statusCode = 409
    return res.end(JSON.stringify({ error: 'execId already in flight' }))
  }
  if (await isExecutedOnChain(depositor, execId)) {
    _seenExecIds.set(execId, { state: 'done', txHash: null, at: now })
    return res.end(JSON.stringify({ txHash: null, status: 'duplicate' }))
  }
  _seenExecIds.set(execId, { state: 'in-flight', at: now }) // collapse concurrent dupes

  const wallet = await resolveServerWallet(client, bizId)
  try {
    const methodId = await resolveContractMethod(client, bizId, depositor, wallet.id, fnName)
    const tx = await client.contractMethods.execute(methodId, {
      amount: String(amount),
      minAmount: String(minAmount),
      minShares: String(minShares ?? 0),
      execId,
      sig,
    })
    const result = await pollForHash(client, tx.id)
    _seenExecIds.set(execId, {
      state: 'done',
      txHash: result.txHash || null,
      relayer: wallet.accountAddress,
      at: Date.now(),
    })
    return res.end(JSON.stringify({ ...result, relayer: wallet.accountAddress }))
  } catch (e) {
    // Failed submit → drop the guard so a genuine retry of THIS execId is allowed.
    _seenExecIds.delete(execId)
    throw e
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }

  // Origin allowlist + per-IP rate limit. Origin is forgeable (curl) → not auth;
  // the cap blunts gas-drain DoS that would spam the funded 1Shot relayer wallet.
  if (!applyCors(req, res)) return
  if (!rateLimit(req, res, { max: 15, windowMs: 60_000, bucket: 'relay' })) return
  res.setHeader('Content-Type', 'application/json')

  const bizId = process.env.ONESHOT_BIZ_ID
  const client = await getClient()
  if (!client || !bizId) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Relay proxy not configured', configured: false }))
  }

  try {
    const body = await readBody(req)
    const action = body.action

    if (action === 'wallet') {
      const wallet = await resolveServerWallet(client, bizId)
      return res.end(
        JSON.stringify({
          address: wallet.accountAddress,
          chainId: CHAIN_ID,
          walletId: wallet.id,
        })
      )
    }

    // executeAgentDeposit (Jalur B transferFrom) and depositHeld (ERC-7715-redeemed funds) share
    // the same scalar inputs + replay/guard machinery — only the registered method differs.
    // await so a throw from pollForHash ("1Shot transaction failed") is caught by this
    // handler's try/catch → 502, instead of escaping as an unhandled rejection that crashes
    // the dev server / serverless process. `return <promise>` does NOT route through the catch.
    if (action === 'deposit') return await runDepositLike(res, client, bizId, DEPOSIT_FN, body)
    if (action === 'depositHeld') return await runDepositLike(res, client, bizId, HELD_FN, body)

    if (action === 'redeem') {
      // ERC-7715 redeem: server wallet (= the grant grantee) broadcasts
      // DelegationManager.redeemDelegations → USDC.transfer to the depositor. The three arrays
      // are validated then executed; the AP period cap is enforced on-chain by the enforcer.
      const { permissionContexts, modes, executionCallDatas } = body
      if (
        !Array.isArray(permissionContexts) ||
        !permissionContexts.length ||
        !permissionContexts.every((x) => BYTES_RE.test(x || ''))
      ) {
        return bad(res, 'Invalid permissionContexts')
      }
      if (!Array.isArray(modes) || !modes.length || !modes.every((x) => BYTES32_RE.test(x || ''))) {
        return bad(res, 'Invalid modes')
      }
      if (
        !Array.isArray(executionCallDatas) ||
        !executionCallDatas.length ||
        !executionCallDatas.every((x) => BYTES_RE.test(x || ''))
      ) {
        return bad(res, 'Invalid executionCallDatas')
      }
      const wallet = await resolveServerWallet(client, bizId)
      const methodId = await resolveContractMethod(client, bizId, DM_ADDRESS, wallet.id, REDEEM_FN)
      const tx = await client.contractMethods.execute(methodId, {
        permissionContexts,
        modes,
        executionCallDatas,
      })
      const result = await pollForHash(client, tx.id)
      return res.end(JSON.stringify({ ...result, relayer: wallet.accountAddress }))
    }

    return bad(res, 'Unknown action')
  } catch (err) {
    // Log full detail server-side (vite terminal / serverless logs) for debugging —
    // ZodError from a malformed contractMethod create surfaces here. Never echo to client.
    console.error('[api/relay] error:', err?.message || err, err?.issues || '')
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Relay proxy failed' }))
  }
}

function bad(res, msg) {
  res.statusCode = 400
  return res.end(JSON.stringify({ error: msg }))
}

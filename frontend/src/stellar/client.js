// Browser-side Soroban client. Read-only calls via simulate; state-changing calls build an
// assembled tx for the caller to sign (user wallet) or attach an agent auth entry to. Balances
// come from Horizon (the Soroban RPC returns sequence only).
//
// Every networked fn takes an injected `server` so unit tests run without a network. Defaults
// lazily construct the real SDK so a missing package never breaks the vite config load.
import { xdr } from '@stellar/stellar-sdk'
import { SOROBAN_RPC_URL, HORIZON_URL, NETWORK_PASSPHRASE } from './config.js'
import {
  addrScVal,
  i128ScVal,
  u64ScVal,
  u32ScVal,
  bytes32ScVal,
  symbolScVal,
  fromScVal,
} from './scval.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

/** Singleton Soroban RPC server. */
let _server = null
export async function rpcServer() {
  if (_server) return _server
  const { rpc } = await sdk()
  _server = new rpc.Server(SOROBAN_RPC_URL)
  return _server
}

/** Singleton Horizon server. */
let _horizon = null
export async function horizonServer() {
  if (_horizon) return _horizon
  const { Horizon } = await sdk()
  _horizon = new Horizon.Server(HORIZON_URL)
  return _horizon
}

// Encode a heterogeneous JS arg list to ScVal. { addr } → Address, { i128 } → i128, raw ScVal
// passthrough. Keeps call sites declarative: encodeArgs([{ addr: from }, { i128: amount }]).
export function encodeArgs(args = []) {
  return args.map((a) => {
    // Raw ScVal first: js-xdr unions expose EVERY arm accessor on the prototype, so the
    // `'i128' in a` / `'addr' in a` sniffs below are true for any ScVal and would misroute it.
    if (a instanceof xdr.ScVal) return a
    if (a && typeof a === 'object' && 'addr' in a) return addrScVal(a.addr)
    if (a && typeof a === 'object' && 'i128' in a) return i128ScVal(a.i128)
    if (a && typeof a === 'object' && 'u64' in a) return u64ScVal(a.u64)
    if (a && typeof a === 'object' && 'u32' in a) return u32ScVal(a.u32)
    if (a && typeof a === 'object' && 'bytes32' in a) return bytes32ScVal(a.bytes32)
    if (a && typeof a === 'object' && 'symbol' in a) return symbolScVal(a.symbol)
    return a // already an ScVal
  })
}

/**
 * Read-only contract call. Builds an invoke op against a throwaway source, simulates it, and
 * decodes the return value. No fee, no signature, no submission.
 * @param {{ contract: string, method: string, args?: Array, server?: object }} p
 * @returns {Promise<unknown>} decoded native return value
 */
export async function readContract({ contract, method, args = [], server }) {
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, Account, Keypair, BASE_FEE } = await sdk()
  const source = new Account(Keypair.random().publicKey(), '0') // reads never touch sequence
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...encodeArgs(args)))
    .setTimeout(30)
    .build()
  const sim = await s.simulateTransaction(tx)
  if (sim.error || !sim.result)
    throw new Error(`Contract read simulation failed: ${sim.error || 'no result'}`)
  return fromScVal(sim.result.retval)
}

/**
 * Build + simulate-assemble a state-changing invoke. Returns the assembled (unsigned)
 * transaction and its base64 XDR. The caller signs it (user wallet) or attaches an agent
 * auth entry, then submits.
 * @param {{ source: string, contract: string, method: string, args?: Array, server?: object }} p
 * @returns {Promise<{ tx: object, xdr: string }>}
 */
export async function buildInvokeTx({ source, contract, method, args = [], server }) {
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, BASE_FEE } = await sdk()
  const account = await s.getAccount(source) // sequence for the source (must exist + be funded)
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...encodeArgs(args)))
    .setTimeout(60)
    .build()
  const tx = await s.prepareTransaction(raw) // simulate + assemble (sets the resource fee)
  return { tx, xdr: tx.toEnvelope().toXDR('base64') }
}

/**
 * Build + simulate-assemble a create-contract-from-wasm-hash deploy (createContractV2, with
 * constructor args). The deployer address = `source` (the connected user wallet), so the only
 * auth the simulation records is source-account credentials — signing the tx envelope covers
 * it; no separate auth-entry signing (the constructor's own token.approve sub-call authorizes
 * itself via invoker-contract auth inside the wasm). The created contract address is the create
 * host fn's return value, read from an explicit pre-simulation.
 * @param {{ source: string, wasmHash: string, constructorArgs?: Array, salt?: Uint8Array,
 *           server?: object }} p wasmHash = 64-char hex of an ALREADY-uploaded wasm
 * @returns {Promise<{ tx: object, xdr: string, contractAddress: string }>}
 */
export async function buildCreateContractTx({
  source,
  wasmHash,
  constructorArgs = [],
  salt,
  server,
}) {
  if (!/^[0-9a-f]{64}$/i.test(wasmHash || ''))
    throw new Error('wasmHash must be a 64-char hex string')
  const s = server || (await rpcServer())
  const { TransactionBuilder, Operation, Address, BASE_FEE } = await sdk()
  const account = await s.getAccount(source)
  const saltBytes = salt || globalThis.crypto.getRandomValues(new Uint8Array(32))
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(source),
        wasmHash: Buffer.from(wasmHash, 'hex'),
        salt: saltBytes,
        constructorArgs: encodeArgs(constructorArgs),
      })
    )
    .setTimeout(60)
    .build()
  // Simulate FIRST to learn the to-be-created contract address (the host fn's retval)…
  const sim = await s.simulateTransaction(raw)
  if (sim.error || !sim.result)
    throw new Error(`Contract deployment simulation failed: ${sim.error || 'no result'}`)
  const contractAddress = fromScVal(sim.result.retval)
  // …then prepare (simulate + assemble, sets the resource fee) exactly like buildInvokeTx.
  const tx = await s.prepareTransaction(raw)
  return { tx, xdr: tx.toEnvelope().toXDR('base64'), contractAddress }
}

/** Poll getTransaction until it leaves NOT_FOUND or the budget is spent. */
async function poll(server, hash, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await server.getTransaction(hash)
    if (r.status && r.status !== 'NOT_FOUND') return r.status
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }
  return 'PENDING'
}

/**
 * Submit a user-signed transaction (base64 XDR) the user pays for — redeem / claim /
 * registry-authorize. (Agent gasless deposits go through submitViaRelay in relay.js instead.)
 * @param {{ signedXdr: string, server?: object, pollTries?: number, pollIntervalMs?: number }} p
 * @returns {Promise<{ hash: string, status: string }>}
 */
export async function submitUserTx({ signedXdr, server, pollTries = 10, pollIntervalMs = 2000 }) {
  const s = server || (await rpcServer())
  const { TransactionBuilder } = await sdk()
  const tx = server ? signedXdr : TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  // ponytail: when a fake server is injected (tests) it accepts the raw xdr; the real path
  // rebuilds the Transaction object the SDK's sendTransaction expects.
  const sent = await s.sendTransaction(server ? { xdr: signedXdr } : tx)
  if (sent.status === 'ERROR') throw new Error('RPC rejected the transaction')
  const status = await poll(s, sent.hash, pollTries, pollIntervalMs)
  return { hash: sent.hash, status }
}

/**
 * Native XLM balance of an account, read from Horizon (NOT the Soroban RPC).
 * @param {string} pubkey
 * @returns {Promise<number>}
 */
export async function horizonNativeBalance(pubkey) {
  const horizon = await horizonServer()
  const acct = await horizon.loadAccount(pubkey)
  return Number(acct.balances.find((b) => b.asset_type === 'native')?.balance ?? 0)
}

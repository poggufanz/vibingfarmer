// frontend/src/stellar/cctpBurn.js
// Forward CCTP leg (Stellar -> Base): USDC_SAC.approve(TokenMessengerMinter) then
// deposit_for_burn, both passkey-signed by the user's Stellar smart wallet and self-paid by a
// fresh Friendbot-funded ephemeral fee-payer — mirrors wallet/submit.js's submitApprove pattern
// exactly, because the existing gasless relay (stellar/relay.js) allowlists ONLY the vault
// deposit contract and would refuse a call to TokenMessengerMinter (see memory: "relay allowlist
// fail-closed"). Ported verbatim from the PROVEN reference implementation
// spikes/cctp-corridor/roundtrip.mjs's `stellarApproveAndBurn` (do not re-derive these constants
// or the arg order — see spikes/cctp-corridor/addresses.md).
import { rpcServer } from './client.js'
import { NETWORK_PASSPHRASE } from './config.js'

// --- Proven testnet constants (spikes/cctp-corridor/addresses.md, confirmed live in SP0) ---
export const STELLAR_TOKEN_MESSENGER_MINTER = 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP'
export const STELLAR_USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const CCTP_STELLAR_DOMAIN = 27
export const CCTP_BASE_DOMAIN = 6
export const CCTP_MIN_FINALITY_STANDARD = 2000 // finalized, no fast-fee (default — safer than Fast)
export const CCTP_MAX_FEE = 0n
const APPROVE_ALLOWANCE_HEADROOM = 10n // approve 10x the burn amount, mirrors roundtrip.mjs's generosity
const APPROVE_EXPIRY_LEDGER_HEADROOM = 100_000 // ~6 days at 5s/ledger

const FRIENDBOT = 'https://friendbot.stellar.org'
const ZERO32 = new Uint8Array(32)

/**
 * Left-pad a 20-byte EVM address into a 32-byte buffer (BytesN<32> mint_recipient). Ported from
 * spikes/cctp-corridor/roundtrip.mjs's `evmAddrToBytes32`.
 * @param {string} addr - 0x-prefixed 20-byte EVM address
 * @returns {Uint8Array} 32 bytes
 */
export function evmAddrToBytes32(addr) {
  const hex = addr.replace(/^0x/, '').toLowerCase()
  if (hex.length !== 40 || !/^[0-9a-f]{40}$/.test(hex)) throw new Error(`bad evm address ${addr}`)
  const out = new Uint8Array(32)
  out.set(Buffer.from(hex, 'hex'), 12)
  return out
}

async function defaultFund(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

async function defaultMakeEphemeral() {
  const { Keypair } = await import('@stellar/stellar-sdk')
  return Keypair.random()
}

// Real op assembler + submitter: builds the invoke (source = ephemeral fee-payer), simulates,
// extracts the ONE auth entry credentialed to `contractId`, has the wallet sign it via
// kit.signAuthEntry, re-assembles around the signed entry with a freshly-fetched sequence
// (avoids txBadSeq — same lesson as wallet/submit.js), the ephemeral signs the tx source, submits,
// and polls to success. Mirrors submit.js's defaultSignSubmitApprove almost exactly.
async function defaultBuildAndSubmitOp({ contractId, contract, method, args, kit, ephemeral, server }) {
  const sdk = await import('@stellar/stellar-sdk')
  const { TransactionBuilder, Operation, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const scArgs = args.map((a) => (a instanceof xdr.ScVal ? a : encodeArg(sdk, a)))
  const ephAcct = await server.getAccount(ephemeral.publicKey())
  const op = new Contract(contract).call(method, ...scArgs)
  const recRaw = new TransactionBuilder(ephAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`${method} sim failed: ${recSim.error}`)
  const entries = recSim.result?.auth ?? []
  const wantScAddress = Address.fromString(contractId).toScAddress().toXDR('base64')
  const mine = entries.filter(
    (e) =>
      e.credentials().switch().name === 'sorobanCredentialsAddress' &&
      e.credentials().address().address().toXDR('base64') === wantScAddress
  )
  if (mine.length !== 1) throw new Error(`expected 1 auth entry for the wallet, got ${mine.length}`)
  const signed = await kit.signAuthEntry(mine[0])
  const enfAcct = await server.getAccount(ephemeral.publicKey())
  const enforcedRaw = new TransactionBuilder(enfAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [signed] }))
    .setTimeout(60)
    .build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`${method} auth sim failed: ${enfSim.error}`)
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(ephemeral)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  let r = await server.getTransaction(sent.hash)
  for (let i = 0; i < 30 && r.status === 'NOT_FOUND'; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    r = await server.getTransaction(sent.hash)
  }
  if (r.status !== 'SUCCESS') throw new Error(`${method} did not succeed: ${r.status}`)
  return { hash: sent.hash }
}

function encodeArg(sdk, a) {
  const { Address, nativeToScVal, xdr } = sdk
  if (a && typeof a === 'object' && 'addr' in a) return Address.fromString(a.addr).toScVal()
  if (a && typeof a === 'object' && 'i128' in a) return nativeToScVal(a.i128, { type: 'i128' })
  if (a && typeof a === 'object' && 'u32' in a) return nativeToScVal(a.u32, { type: 'u32' })
  if (a && typeof a === 'object' && 'bytes32' in a) return xdr.ScVal.scvBytes(Buffer.from(a.bytes32))
  throw new Error(`cctpBurn: unrecognized arg shape ${JSON.stringify(a)}`)
}

/**
 * Approve + deposit_for_burn on the user's Stellar Passkey Kit smart wallet, bridging to a Base
 * address. Both ops are self-paid by a fresh ephemeral fee-payer (the existing relay refuses
 * non-deposit calls) and passkey-signed via `kit.signAuthEntry`.
 * @param {{
 *   contractId: string,           // the smart wallet's G... address
 *   amountUnits: bigint,          // 7dp Stellar units
 *   baseRecipientAddress: string, // 0x... the user's Base smart account
 *   kit: object,                  // from wallet/passkeyStellar.js's createStellarPasskeyWallet (or its returned kit)
 *   server?: object,
 *   deps?: { fund?: Function, makeEphemeral?: Function, buildAndSubmitOp?: Function },
 * }} p
 * @returns {Promise<{ approveHash: string, burnHash: string }>}
 */
export async function signAndSubmitStellarBurn({ contractId, amountUnits, baseRecipientAddress, kit, server, deps = {} }) {
  const {
    fund = defaultFund,
    makeEphemeral = defaultMakeEphemeral,
    buildAndSubmitOp = defaultBuildAndSubmitOp,
  } = deps
  const s = server ?? (await rpcServer())
  const ephemeral = await makeEphemeral()
  await fund(ephemeral.publicKey())

  const latest = await s.getLatestLedger?.()
  const expLedger = (latest?.sequence ?? 0) + APPROVE_EXPIRY_LEDGER_HEADROOM

  const { hash: approveHash } = await buildAndSubmitOp({
    contractId,
    contract: STELLAR_USDC_SAC,
    method: 'approve',
    args: [
      { addr: contractId },
      { addr: STELLAR_TOKEN_MESSENGER_MINTER },
      { i128: amountUnits * APPROVE_ALLOWANCE_HEADROOM },
      { u32: expLedger },
    ],
    kit,
    ephemeral,
    server: s,
  })

  const { hash: burnHash } = await buildAndSubmitOp({
    contractId,
    contract: STELLAR_TOKEN_MESSENGER_MINTER,
    method: 'deposit_for_burn',
    args: [
      { addr: contractId },
      { i128: amountUnits },
      { u32: CCTP_BASE_DOMAIN },
      { bytes32: evmAddrToBytes32(baseRecipientAddress) },
      { addr: STELLAR_USDC_SAC },
      { bytes32: ZERO32 },
      { i128: CCTP_MAX_FEE },
      { u32: CCTP_MIN_FINALITY_STANDARD },
    ],
    kit,
    ephemeral,
    server: s,
  })

  return { approveHash, burnHash }
}

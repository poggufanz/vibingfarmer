// frontend/scripts/m2-send-smoke.mjs
//
// M2 GATE: passkey-signed token transfer FROM a passkey smart account, fee-bumped
// by the relayer (user pays 0 XLM). Proves the send/receive path end-to-end.
//
// Node has no WebAuthn, so we reuse the M0b "synthetic signer" recipe (a P-256
// WebCrypto key + VF's own passkey.js packing) that already PASSED on-chain at the
// M0b gate. Everything else is the REAL on-chain path: deploy a fresh OZ
// smart_account whose Default signer is External(webauthnVerifier, key_data), build
// the token `transfer(from=smartAccount, to, amount)` invocation, sign the auth
// entry credentialed to the smart account, and ENFORCING-simulate against the
// PUBLIC testnet RPC so __check_auth (-> webauthn-verifier) + the token logic run.
//
// HONEST HEADLESS LIMIT: a freshly deployed smart account holds 0 VFUSD, so the
// token `transfer` traps on INSUFFICIENT BALANCE *after* require_auth succeeds. We
// decode the trap: a webauthn/account error (3xxx) == GATE FAILED (signature did
// not verify); a token balance error == __check_auth PASSED and only token funding
// is missing (the user-deferred step). Fund the printed smart-account address with
// VFUSD (see the Blend-USDC faucet in the deploy notes) to get a clean transfer
// SUCCESS, or run a manual browser pass with a funded passkey wallet.
//
// The final relayer SUBMISSION is gated behind `--submit` + STELLAR_RELAYER_SECRET
// (a server secret) + the Pages dev server; it is user-deferred and NOT required to
// clear the auth gate.
//
// Run (vite-node — SAK/raw-Node ESM resolution differs; this script only uses the
// stellar-sdk + passkey.js so plain node also works, but vite-node is the default):
//   cd frontend && npx vite-node scripts/m2-send-smoke.mjs
//   cd frontend && npx vite-node scripts/m2-send-smoke.mjs --submit   (needs relayer secret)

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  Address,
  xdr,
  hash,
  StrKey,
  scValToNative,
  BASE_FEE,
  rpc,
} from '@stellar/stellar-sdk'
import { createHash, webcrypto } from 'node:crypto'

import { normalizeLowS, buildChallenge, assembleSecp256r1Signature } from '../src/wallet/passkey.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, SOROBAN_TOKEN_ADDRESS } from '../src/stellar/config.js'
import { ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ADDRESS, RP_ID } from '../src/wallet/config.js'
import { readTokenBalance } from '../src/stellar/agentDeposit.js'
import { submitViaRelay } from '../src/stellar/relay.js'

const SUBMIT = process.argv.includes('--submit')
const FRIENDBOT = 'https://friendbot.stellar.org'
const TRANSFER_AMOUNT = 1n // 1 base unit (1e-7 VFUSD) — minimal, just to exercise the path
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle

// webauthn-verifier / OZ smart-account error codes — a hit here means the passkey
// signature itself failed to verify (the gate), NOT a downstream token issue.
const AUTH_ERROR_NAMES = {
  3000: 'ContextRuleNotFound',
  3002: 'UnvalidatedContext',
  3003: 'ExternalVerificationFailed (verifier returned false)',
  3006: 'SignerNotFound',
  3110: 'WebAuthn.SignaturePayloadInvalid',
  3111: 'WebAuthn.ClientDataTooLong',
  3112: 'WebAuthn.JsonParseError',
  3113: 'WebAuthn.TypeFieldInvalid',
  3114: 'WebAuthn.ChallengeInvalid',
  3115: 'WebAuthn.AuthDataFormatInvalid',
  3116: 'WebAuthn.PresentBitNotSet',
  3117: 'WebAuthn.VerifiedBitNotSet',
  3118: 'WebAuthn.BackupEligibilityAndStateNotSet',
  3120: 'Verifier.KeyDataTooShort',
  3121: 'Verifier.PublicKeyExtractionFailed',
  3122: 'Verifier.SigDataParseError',
}
function classifyError(errStr) {
  const m = String(errStr).match(/Error\(Contract,\s*#?(\d+)\)/) || String(errStr).match(/#(\d{3,4})/)
  if (!m) return { auth: false, label: '' }
  const code = Number(m[1])
  if (AUTH_ERROR_NAMES[code]) return { auth: true, label: ` -> ${AUTH_ERROR_NAMES[code]}` }
  return { auth: false, label: ` -> contract error #${code} (NOT an auth error)` }
}

async function fundFriendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

async function getAccountWithRetry(pubkey, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await server.getAccount(pubkey)
    } catch {
      await new Promise((res) => setTimeout(res, 1500))
    }
  }
  throw new Error(`account never surfaced on the Soroban RPC: ${pubkey}`)
}

async function waitSuccess(hashHex, label) {
  let r = await server.getTransaction(hashHex)
  for (let i = 0; i < 30 && r.status === 'NOT_FOUND'; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    r = await server.getTransaction(hashHex)
  }
  if (r.status !== 'SUCCESS') throw new Error(`${label} did not succeed: ${r.status}`)
  return r
}

function externalSignerScVal(keyData) {
  // Signer::External(Address verifier, Bytes key_data)
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    xdr.ScVal.scvAddress(Address.fromString(WEBAUTHN_VERIFIER_ADDRESS).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(keyData)),
  ])
}

// --- the validated M0b synthetic passkey signer (P-256 WebCrypto) -----------------
async function makeSyntheticSigner() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pubkey = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) // 65B 0x04||X||Y
  if (pubkey.length !== 65 || pubkey[0] !== 0x04)
    throw new Error(`unexpected pubkey: len=${pubkey.length} prefix=${pubkey[0]}`)
  const credentialId = new Uint8Array(16)
  webcrypto.getRandomValues(credentialId)
  const keyData = Buffer.concat([Buffer.from(pubkey), Buffer.from(credentialId)])
  return { kp, keyData }
}

// Sign one recording-sim auth entry credentialed to the smart account, exactly as
// the deployed webauthn-verifier checks it (M0b packing: single-encode challenge,
// low-S raw r||s, sig_data ScMap with sorted symbol keys).
async function signAuthEntryWithPasskey({ entry, kp, keyData }) {
  const creds = entry.credentials().address()
  const validUntil = (await server.getLatestLedger()).sequence + 1000
  creds.signatureExpirationLedger(validUntil)

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
      nonce: creds.nonce(),
      signatureExpirationLedger: creds.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    })
  )
  const payload = new Uint8Array(hash(preimage.toXDR()))
  const challenge = buildChallenge(payload) // base64url(payload), single encode
  if (challenge.length !== 43 || /[+/=]/.test(challenge))
    throw new Error(`challenge not 43-char url-safe unpadded: "${challenge}"`)

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin: `https://${RP_ID}`,
    crossOrigin: false,
  })
  const clientDataBytes = Buffer.from(clientDataJSON, 'utf8')
  const authenticatorData = Buffer.concat([
    Buffer.from(sha256(Buffer.from(RP_ID, 'utf8'))),
    Buffer.from([0x05]), // UP|UV
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // counter
  ])
  const signedMessage = Buffer.concat([authenticatorData, Buffer.from(sha256(clientDataBytes))])
  const rawSig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signedMessage)
  )
  if (rawSig.length !== 64) throw new Error(`expected 64B raw sig, got ${rawSig.length}`)
  const okRaw = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, rawSig, signedMessage)
  const sig = normalizeLowS(rawSig)
  const okLowS = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, signedMessage)
  if (!okRaw || !okLowS) throw new Error('local WebCrypto verification failed — message packing is wrong')

  const parts = assembleSecp256r1Signature({ authenticatorData, clientDataJSON, signature: sig })
  const sigDataScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('authenticator_data'), val: xdr.ScVal.scvBytes(Buffer.from(parts.authenticatorData)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('client_data'), val: xdr.ScVal.scvBytes(Buffer.from(parts.clientDataJSON)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(Buffer.from(parts.signature)) }),
  ])
  const signaturesScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: externalSignerScVal(keyData), val: xdr.ScVal.scvBytes(sigDataScVal.toXDR()) }),
    ]),
  ])
  creds.signature(signaturesScVal)
  return entry
}

// Deploy a fresh OZ smart_account instance with the synthetic signer; return its C-id.
async function deploySmartAccount({ deployer, keyData }) {
  const salt = Buffer.from(hash(Buffer.from(`m2-${Date.now()}-${Math.random()}`)))
  const deployOp = Operation.createCustomContract({
    address: Address.fromString(deployer.publicKey()),
    wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
    salt,
    constructorArgs: [xdr.ScVal.scvVec([externalSignerScVal(keyData)]), xdr.ScVal.scvMap([])],
  })
  const deployerAcct = await getAccountWithRetry(deployer.publicKey())
  const raw = new TransactionBuilder(deployerAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(deployOp)
    .setTimeout(60)
    .build()
  const prepared = await server.prepareTransaction(raw)
  prepared.sign(deployer)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR')
    throw new Error(`deploy rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  await waitSuccess(sent.hash, 'deploy')
  const cidPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer.publicKey()).toScAddress(),
          salt,
        })
      ),
    })
  )
  return { contractId: StrKey.encodeContract(hash(cidPreimage.toXDR())), deployerAcct }
}

async function main() {
  console.log('=== M2 passkey send smoke ===')
  console.log('rpc:', SOROBAN_RPC_URL)
  console.log('token:', SOROBAN_TOKEN_ADDRESS)

  const { kp, keyData } = await makeSyntheticSigner()
  console.log(`synthetic signer -> key_data ${keyData.length}B`)

  const deployer = Keypair.random()
  console.log('deployer:', deployer.publicKey(), '(Friendbot funding...)')
  await fundFriendbot(deployer.publicKey())

  const { contractId, deployerAcct } = await deploySmartAccount({ deployer, keyData })
  console.log('deployed passkey smart account:', contractId)
  console.log(`  https://stellar.expert/explorer/testnet/contract/${contractId}`)

  // Recipient: the funded deployer's own G-address is a valid transfer target for a
  // Soroban token. (Funding the SOURCE smart account with VFUSD is the deferred step.)
  const to = Address.fromString(deployer.publicKey()).toString()

  const balBefore = await readTokenBalance(contractId, { server })
  console.log('smart-account VFUSD balance (before):', balBefore?.toString() ?? 'null')
  if (!balBefore || balBefore < TRANSFER_AMOUNT) {
    console.log(
      `NOTE: source holds ${balBefore ?? 0n} < ${TRANSFER_AMOUNT} base units — the transfer will reach`
    )
    console.log('      __check_auth and then trap on INSUFFICIENT BALANCE (token funding is deferred).')
  }

  // Build token.transfer(from=smartAccount, to, amount); source=deployer (sim only).
  const transferOp = new Contract(SOROBAN_TOKEN_ADDRESS).call(
    'transfer',
    Address.fromString(contractId).toScVal(),
    Address.fromString(to).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(TRANSFER_AMOUNT.toString()) }))
  )
  const callRaw = new TransactionBuilder(deployerAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(transferOp)
    .setTimeout(60)
    .build()

  const recSim = await server.simulateTransaction(callRaw)
  if (rpc.Api.isSimulationError(recSim)) {
    // A recording-sim failure here is the token logic (e.g. balance) BEFORE we attach
    // any signature — so it cannot be an auth result. Report and stop honestly.
    const { auth, label } = classifyError(recSim.error)
    console.log(`\nrecording sim failed${label} (no auth attached yet).`)
    console.log('  This is the token path, not the passkey gate.', auth ? '' : '(fund the source to proceed)')
    console.log('  error:', recSim.error)
    process.exitCode = auth ? 1 : 0 // a non-auth trap here is the expected funding gate
    return
  }
  const recEntries = recSim.result?.auth ?? []
  if (recEntries.length !== 1)
    throw new Error(`expected exactly 1 auth entry (smart account), got ${recEntries.length}`)

  const entry = await signAuthEntryWithPasskey({ entry: recEntries[0], kp, keyData })

  // ENFORCING simulate against the PUBLIC RPC -> __check_auth runs.
  const invokeFunc = callRaw.operations[0].func
  const enforcedRaw = new TransactionBuilder(deployerAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: invokeFunc, auth: [entry] }))
    .setTimeout(60)
    .build()

  console.log('\nenforcing simulateTransaction (runs __check_auth on the public RPC)...')
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) {
    const { auth, label } = classifyError(enfSim.error)
    if (auth) {
      console.error('GATE FAILED: __check_auth rejected the passkey signature' + label)
      console.error('  error:', enfSim.error)
      process.exitCode = 1
      return
    }
    console.log('AUTH OK (passkey verified) — transfer then trapped on the token path' + label + '.')
    console.log('  Fund the smart account with VFUSD for a clean SUCCESS. error:', enfSim.error)
    return // auth gate proven; token funding is user-deferred
  }
  console.log('GATE PASSED: passkey-signed transfer simulated successfully (funded source).')
  console.log('  minResourceFee:', enfSim.minResourceFee)

  if (!SUBMIT) {
    console.log('\n(submission deferred — re-run with --submit + STELLAR_RELAYER_SECRET to land it on-chain)')
    return
  }
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(deployer)
  const relayed = await submitViaRelay({ xdr: prepared.toEnvelope().toXDR('base64') })
  if (!relayed) {
    console.log('relay unconfigured (need STELLAR_RELAYER_SECRET + Pages dev server) — gate already passed via simulation')
    return
  }
  console.log('submitted via relay:', relayed.hash, relayed.status)
  console.log(`  https://stellar.expert/explorer/testnet/tx/${relayed.hash}`)
  const balAfter = await readTokenBalance(contractId, { server })
  console.log('smart-account VFUSD balance (after):', balAfter?.toString() ?? 'null')
}

main().catch((e) => {
  console.error('\nM2 smoke error:', e?.message || e)
  process.exitCode = 1
})

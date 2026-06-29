// frontend/scripts/m0b-passkey-authentry-smoke.mjs
//
// M0b MAKE-OR-BREAK GATE: proof that a secp256r1 passkey signature verifies on-chain
// (OZ smart-account `__check_auth` -> webauthn-verifier `verify`) on Stellar testnet.
//
// Node has no WebAuthn, so we synthesize the authenticator with a P-256 WebCrypto key
// (the "synthetic signer" recipe from the Task 8 brief). Everything else is the REAL
// on-chain packing: VF's own passkey.js helpers (buildChallenge / normalizeLowS /
// assembleSecp256r1Signature) assemble the exact bytes the deployed verifier checks.
//
//   1. generate a P-256 keypair (WebCrypto) -> uncompressed 65B pubkey
//   2. key_data = pubkey(65) || credentialId   (smart-account-kit buildKeyData layout)
//   3. deploy a fresh OZ smart_account instance whose Default context-rule signer is
//      External(webauthnVerifier, key_data)  -- funded by a throwaway Friendbot deployer
//   4. build the smallest authorized self-call (update_context_rule_name) that triggers
//      __check_auth; recording-simulate to get the auth entry
//   5. compute payload = sha256(HashIdPreimage::SorobanAuthorization XDR);
//      challenge = buildChallenge(payload) = base64url(payload)  (SINGLE encode)
//      authenticatorData = sha256(rpId) ++ 0x05 ++ counter ; clientDataJSON = {type,challenge,origin}
//      sign authenticatorData ++ sha256(clientDataJSON) with WebCrypto (RAW r||s) ->
//      normalizeLowS (skip derToRaw) -> assembleSecp256r1Signature -> sig_data ScMap XDR
//   6. attach the signed auth entry and ENFORCING-simulate against the PUBLIC testnet RPC.
//      __check_auth runs during simulateTransaction -> passing it (no auth trap) IS the gate.
//
// The final relayer SUBMISSION is gated behind `--submit` + STELLAR_RELAYER_SECRET (a
// server secret); it is a user-deferred step and is NOT required to clear the gate.
//
// Run (vite-node — SAK/raw-Node ESM resolution differs, but this script only uses the
// stellar-sdk + passkey.js, so plain node works too; vite-node is the project default):
//   cd frontend && npx vite-node scripts/m0b-passkey-authentry-smoke.mjs
//   cd frontend && npx vite-node scripts/m0b-passkey-authentry-smoke.mjs --submit   (needs relayer secret)

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  Address,
  Account,
  xdr,
  hash,
  StrKey,
  scValToNative,
  BASE_FEE,
  rpc,
} from '@stellar/stellar-sdk'
import { createHash, webcrypto } from 'node:crypto'

import { normalizeLowS, buildChallenge, assembleSecp256r1Signature } from '../src/wallet/passkey.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from '../src/stellar/config.js'
import { ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ADDRESS, RP_ID } from '../src/wallet/config.js'
import { submitViaRelay } from '../src/stellar/relay.js'

const SUBMIT = process.argv.includes('--submit')
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle

// Decode the known OZ smart-account / webauthn-verifier error codes for a readable trap reason.
const ERROR_NAMES = {
  3000: 'ContextRuleNotFound',
  3002: 'UnvalidatedContext',
  3003: 'ExternalVerificationFailed (verifier returned false)',
  3006: 'SignerNotFound',
  3110: 'WebAuthn.SignaturePayloadInvalid',
  3111: 'WebAuthn.ClientDataTooLong',
  3112: 'WebAuthn.JsonParseError',
  3113: 'WebAuthn.TypeFieldInvalid',
  3114: 'WebAuthn.ChallengeInvalid (challenge != base64url(payload))',
  3115: 'WebAuthn.AuthDataFormatInvalid',
  3116: 'WebAuthn.PresentBitNotSet (UP flag)',
  3117: 'WebAuthn.VerifiedBitNotSet (UV flag)',
  3118: 'WebAuthn.BackupEligibilityAndStateNotSet',
  3120: 'Verifier.KeyDataTooShort',
  3121: 'Verifier.PublicKeyExtractionFailed',
  3122: 'Verifier.SigDataParseError',
}
function explainError(errStr) {
  if (!errStr) return ''
  const m = String(errStr).match(/Error\(Contract,\s*#?(\d+)\)/) || String(errStr).match(/#(\d{4})/)
  if (m && ERROR_NAMES[Number(m[1])]) return ` -> ${ERROR_NAMES[Number(m[1])]}`
  return ''
}

async function fundFriendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

// Friendbot lands on Horizon a ledger or two before the Soroban RPC surfaces the account.
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

function defaultContextTypeScVal() {
  // ContextRuleType::Default  (unit enum variant -> Vec[Symbol])
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')])
}

function externalSignerScVal(keyData) {
  // Signer::External(Address verifier, Bytes key_data)
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    xdr.ScVal.scvAddress(Address.fromString(WEBAUTHN_VERIFIER_ADDRESS).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(keyData)),
  ])
}

async function main() {
  console.log('=== M0b passkey auth-entry smoke ===')
  console.log('rpc:', SOROBAN_RPC_URL)
  console.log('verifier:', WEBAUTHN_VERIFIER_ADDRESS)
  console.log('account wasm hash:', ACCOUNT_WASM_HASH)

  // ---- 1. synthetic P-256 signer ------------------------------------------------------
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pubkey = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) // 65B, 0x04||X||Y
  if (pubkey.length !== 65 || pubkey[0] !== 0x04)
    throw new Error(`unexpected pubkey: len=${pubkey.length} prefix=${pubkey[0]}`)
  const credentialId = new Uint8Array(16)
  webcrypto.getRandomValues(credentialId)
  const keyData = Buffer.concat([Buffer.from(pubkey), Buffer.from(credentialId)]) // pubkey||credId
  console.log(`synthetic signer: pubkey 65B + credId ${credentialId.length}B -> key_data ${keyData.length}B`)

  // ---- 2. deploy a fresh smart-account instance with this signer -----------------------
  const deployer = Keypair.random()
  console.log('deployer:', deployer.publicKey(), '(Friendbot funding...)')
  await fundFriendbot(deployer.publicKey())

  const salt = Buffer.from(hash(Buffer.from(`m0b-${Date.now()}-${Math.random()}`)))
  const signersVec = xdr.ScVal.scvVec([externalSignerScVal(keyData)])
  const policiesMap = xdr.ScVal.scvMap([]) // no policies
  const deployOp = Operation.createCustomContract({
    address: Address.fromString(deployer.publicKey()),
    wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
    salt,
    constructorArgs: [signersVec, policiesMap],
  })

  const deployerAcct = await getAccountWithRetry(deployer.publicKey())
  const deployRaw = new TransactionBuilder(deployerAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(deployOp)
    .setTimeout(60)
    .build()
  const deployPrepared = await server.prepareTransaction(deployRaw)
  deployPrepared.sign(deployer)
  const deploySent = await server.sendTransaction(deployPrepared)
  if (deploySent.status === 'ERROR')
    throw new Error(`deploy rejected: ${JSON.stringify(deploySent.errorResult ?? deploySent)}`)
  await waitSuccess(deploySent.hash, 'deploy')

  // Deterministic contract id from (deployer, salt).
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
  const contractId = StrKey.encodeContract(hash(cidPreimage.toXDR()))
  console.log('deployed smart account:', contractId)
  console.log(`  https://stellar.expert/explorer/testnet/contract/${contractId}`)

  // ---- 3. read the Default context-rule id (auto-created by the constructor) -----------
  const readSrc = new Account(Keypair.random().publicKey(), '0')
  const readTx = new TransactionBuilder(readSrc, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call('get_context_rules', defaultContextTypeScVal()))
    .setTimeout(30)
    .build()
  const readSim = await server.simulateTransaction(readTx)
  if (rpc.Api.isSimulationError(readSim))
    throw new Error(`get_context_rules sim failed: ${readSim.error}`)
  const rules = scValToNative(readSim.result.retval)
  if (!rules?.length) throw new Error('no Default context rule found on the deployed account')
  const ruleId = Number(rules[0].id)
  console.log(`Default context rule id=${ruleId}, signers=${rules[0].signers?.length}`)

  // ---- 4. build the authorized self-call (recording sim -> auth entry) -----------------
  const newName = xdr.ScVal.scvString('m0b')
  const callOp = new Contract(contractId).call(
    'update_context_rule_name',
    xdr.ScVal.scvU32(ruleId),
    newName
  )
  const callRaw = new TransactionBuilder(deployerAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(callOp)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(callRaw)
  if (rpc.Api.isSimulationError(recSim))
    throw new Error(`recording sim of update_context_rule_name failed: ${recSim.error}`)
  const recEntries = recSim.result?.auth ?? []
  if (recEntries.length !== 1)
    throw new Error(`expected exactly 1 auth entry, got ${recEntries.length}`)
  const entry = recEntries[0]
  const creds = entry.credentials().address()

  // ---- 5. sign the auth entry with the synthetic passkey signer ------------------------
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
  const payload = new Uint8Array(hash(preimage.toXDR())) // 32B = the __check_auth signature_payload
  const challenge = buildChallenge(payload) // base64url(payload), single encode (the fix)
  if (challenge.length !== 43 || /[+/=]/.test(challenge))
    throw new Error(`challenge not 43-char url-safe unpadded: "${challenge}"`)

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin: `https://${RP_ID}`,
    crossOrigin: false,
  })
  const clientDataBytes = Buffer.from(clientDataJSON, 'utf8')

  // authenticatorData = sha256(rpId)(32) ++ flags(0x05 = UP|UV) ++ counter(4B BE)
  const authenticatorData = Buffer.concat([
    Buffer.from(sha256(Buffer.from(RP_ID, 'utf8'))),
    Buffer.from([0x05]),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
  ])

  // WebAuthn signs: authenticatorData ++ sha256(clientDataJSON). WebCrypto ECDSA returns
  // RAW r||s (64B) -> skip derToRaw, apply low-S directly.
  const signedMessage = Buffer.concat([authenticatorData, Buffer.from(sha256(clientDataBytes))])
  const rawSig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, signedMessage)
  )
  if (rawSig.length !== 64) throw new Error(`expected 64B raw sig, got ${rawSig.length}`)

  // Local sanity: (r,s) and the low-S form (r, n-s) are both valid P-256 signatures; if this
  // fails, the message construction is wrong before we ever touch the chain.
  const okRaw = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, rawSig, signedMessage)
  const sig = normalizeLowS(rawSig)
  const okLowS = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, signedMessage)
  console.log(`local verify: raw=${okRaw} lowS=${okLowS}`)
  if (!okRaw || !okLowS) throw new Error('local WebCrypto verification failed — message packing is wrong')

  const parts = assembleSecp256r1Signature({ authenticatorData, clientDataJSON, signature: sig })

  // sig_data = XDR of WebAuthnSigData { authenticator_data, client_data, signature } as an
  // ScMap with sorted symbol keys (a < c < s) — exactly smart-account-kit buildSignatureMapEntry.
  const sigDataScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('authenticator_data'),
      val: xdr.ScVal.scvBytes(Buffer.from(parts.authenticatorData)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('client_data'),
      val: xdr.ScVal.scvBytes(Buffer.from(parts.clientDataJSON)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signature'),
      val: xdr.ScVal.scvBytes(Buffer.from(parts.signature)),
    }),
  ])
  const sigDataXdr = sigDataScVal.toXDR()

  // Signatures(Map<Signer, Bytes>) — newtype tuple struct -> Vec[ Map[ signer -> sig_data ] ].
  const signaturesScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: externalSignerScVal(keyData), val: xdr.ScVal.scvBytes(sigDataXdr) }),
    ]),
  ])
  creds.signature(signaturesScVal)

  // ---- 6. ENFORCING simulate against the PUBLIC RPC -> __check_auth runs ---------------
  const invokeFunc = callRaw.operations[0].func
  const sorobanData = recSim.transactionData.build()
  const enforcedRaw = new TransactionBuilder(deployerAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(sorobanData)
    .addOperation(Operation.invokeHostFunction({ func: invokeFunc, auth: [entry] }))
    .setTimeout(60)
    .build()

  console.log('\nenforcing simulateTransaction (runs __check_auth on the public RPC)...')
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) {
    console.error('GATE FAILED: __check_auth trapped during simulation')
    console.error('  error:', enfSim.error + explainError(enfSim.error))
    process.exitCode = 1
    return
  }
  console.log('GATE PASSED: __check_auth verified the secp256r1 passkey signature on-chain.')
  console.log('  minResourceFee:', enfSim.minResourceFee)
  console.log('  retval:', JSON.stringify(scValToNative(enfSim.result.retval)))

  // ---- final relayer submission (user-deferred; needs STELLAR_RELAYER_SECRET) ----------
  if (!SUBMIT) {
    console.log('\n(submission deferred — re-run with --submit + STELLAR_RELAYER_SECRET to land it on-chain)')
    return
  }
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(deployer)
  const relayed = await submitViaRelay({ xdr: prepared.toEnvelope().toXDR('base64') })
  if (!relayed) {
    console.log('relay unconfigured/failed (need STELLAR_RELAYER_SECRET + Pages dev server) — gate already passed via simulation')
    return
  }
  console.log('submitted via relay:', relayed.hash, relayed.status)
  console.log(`  https://stellar.expert/explorer/testnet/tx/${relayed.hash}`)
}

main().catch((e) => {
  console.error('\nM0b smoke error:', e?.message || e)
  process.exitCode = 1
})

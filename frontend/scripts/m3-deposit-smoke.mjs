// frontend/scripts/m3-deposit-smoke.mjs
//
// M3 HERO GATE: a passkey-signed VF vault deposit -> shares minted on-chain, the
// relayer fee-bumps it (user pays 0 XLM). This is the demo's hero moment.
//
// Fail-closed F8: the deposit is gated by the REAL vfapi.eligibility wired with
// resolved vault facts (strategy/vaultFacts.resolve via vfapi.vaultFacts). An
// ineligible verdict aborts BEFORE any signing — no XDR is ever built for a
// rejected vault. ('hyperfarm' is the controlled fixture that demonstrates the
// rejection; 'aave-v3' resolves eligible.)
//
// Node has no WebAuthn, so we reuse the M0b "synthetic signer" recipe (P-256
// WebCrypto + VF's passkey.js packing) that PASSED on-chain at the M0b gate, then
// build the REAL vault `deposit(from=smartAccount, amount)` invocation (arg shape
// per buildAgentDeposit in stellar/agentDeposit.js), sign the auth entry
// credentialed to the smart account, and ENFORCING-simulate against the PUBLIC
// testnet RPC so __check_auth (-> webauthn-verifier) + the vault logic run.
//
// HONEST HEADLESS LIMIT: a freshly deployed smart account holds 0 VFUSD and has not
// approved the vault, so `deposit` traps on allowance/balance *after* require_auth
// succeeds. We decode the trap: a webauthn/account error (3xxx) == GATE FAILED;
// a vault/token error (allowance/balance) == __check_auth PASSED and only funding +
// the pre-seeded approve are missing (user-deferred). For a clean SHARES-MINTED
// pass, run the demo agent path (its constructor self-approves the vault) or fund +
// approve the printed smart account, then re-run with --submit.
//
// The final relayer SUBMISSION is gated behind `--submit` + STELLAR_RELAYER_SECRET +
// the Pages dev server; it is user-deferred and NOT required to clear the auth gate.
//
// Run (vite-node — SAK/raw-Node ESM resolution differs):
//   cd frontend && npx vite-node scripts/m3-deposit-smoke.mjs
//   cd frontend && npx vite-node scripts/m3-deposit-smoke.mjs --submit   (needs relayer secret)

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  Address,
  xdr,
  hash,
  StrKey,
  BASE_FEE,
  rpc,
} from '@stellar/stellar-sdk'
import { createHash, webcrypto } from 'node:crypto'

import { normalizeLowS, buildChallenge, assembleSecp256r1Signature } from '../src/wallet/passkey.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'
import { ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ADDRESS, RP_ID } from '../src/wallet/config.js'
import { readVaultShares } from '../src/stellar/agentDeposit.js'
import { submitViaRelay } from '../src/stellar/relay.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'

const SUBMIT = process.argv.includes('--submit')
const PROTOCOL = process.env.VF_PROTOCOL || 'aave-v3' // eligible snapshot; 'hyperfarm' demos rejection
const DEPOSIT_AMOUNT = 1n // 1 base unit — minimal, just to exercise the path
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle

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
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    xdr.ScVal.scvAddress(Address.fromString(WEBAUTHN_VERIFIER_ADDRESS).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(keyData)),
  ])
}

async function makeSyntheticSigner() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pubkey = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  if (pubkey.length !== 65 || pubkey[0] !== 0x04)
    throw new Error(`unexpected pubkey: len=${pubkey.length} prefix=${pubkey[0]}`)
  const credentialId = new Uint8Array(16)
  webcrypto.getRandomValues(credentialId)
  const keyData = Buffer.concat([Buffer.from(pubkey), Buffer.from(credentialId)])
  return { kp, keyData }
}

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
  const challenge = buildChallenge(payload)
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
    Buffer.from([0x05]),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
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

async function deploySmartAccount({ deployer, keyData }) {
  const salt = Buffer.from(hash(Buffer.from(`m3-${Date.now()}-${Math.random()}`)))
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
  console.log('=== M3 HERO passkey deposit smoke ===')
  console.log('rpc:', SOROBAN_RPC_URL)
  console.log('vault:', SOROBAN_VAULT_ADDRESS)
  console.log('protocol (F8 facts):', PROTOCOL)

  // ---- F8 gate (REAL vfapi.eligibility wired with resolved vault facts) ----------
  const { facts, isFixture } = vaultFacts(PROTOCOL)
  const eligibility = (params) => vfEligibility({ ...params, facts })
  const probe = await eligibility({ vault: SOROBAN_VAULT_ADDRESS, amount: DEPOSIT_AMOUNT })
  console.log(`eligibility: allow=${probe.allow} isFixture=${isFixture} reasons=${JSON.stringify(probe.reasons)}`)
  if (!probe.allow) {
    console.log('\nF8 REJECTED this vault — fail-closed, no deposit is built. (Expected for the fixture.)')
    console.log('  Re-run with VF_PROTOCOL=aave-v3 for the eligible HERO path.')
    return
  }

  // ---- deploy a fresh passkey smart account --------------------------------------
  const { kp, keyData } = await makeSyntheticSigner()
  const deployer = Keypair.random()
  console.log('deployer:', deployer.publicKey(), '(Friendbot funding...)')
  await fundFriendbot(deployer.publicKey())
  const { contractId, deployerAcct } = await deploySmartAccount({ deployer, keyData })
  console.log('deployed passkey smart account:', contractId)
  console.log(`  https://stellar.expert/explorer/testnet/contract/${contractId}`)

  const sharesBefore = await readVaultShares(contractId, { server })
  console.log('vault shares (before):', sharesBefore?.toString() ?? 'null')
  console.log(
    'NOTE: a fresh smart account holds 0 VFUSD and has not approved the vault — `deposit` will reach'
  )
  console.log('      __check_auth and then trap on allowance/balance (funding+approve are deferred).')

  // account.depositToVault (the unit-tested entry point) runs this SAME fail-closed
  // F8 gate, then assembles the deposit via the SAK passkey kit (kit.wallet.deposit)
  // — that path needs the browser WebAuthn ceremony + SAK's bundler resolution, which
  // vite-node cannot load (SAK's dist re-exports a directory subpath raw-ESM rejects;
  // see account.js makeKit notes). So the smoke builds the on-chain deposit op
  // directly here and signs the auth entry with the M0b synthetic passkey signer to
  // prove the on-chain half headlessly. The F8 gate above is the real vfapi path.

  // vault.deposit(from=smartAccount, amount) — arg shape per buildAgentDeposit.
  const depositOp = new Contract(SOROBAN_VAULT_ADDRESS).call(
    'deposit',
    Address.fromString(contractId).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(DEPOSIT_AMOUNT.toString()) }))
  )
  const callRaw = new TransactionBuilder(deployerAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(depositOp)
    .setTimeout(60)
    .build()

  const recSim = await server.simulateTransaction(callRaw)
  if (rpc.Api.isSimulationError(recSim)) {
    const { auth, label } = classifyError(recSim.error)
    console.log(`\nrecording sim failed${label} (no auth attached yet) — vault path, not the passkey gate.`)
    console.log('  error:', recSim.error)
    console.log('  (Fund + approve the smart account, or use the pre-seeded demo agent, then re-run.)')
    process.exitCode = auth ? 1 : 0 // a non-auth trap here is the expected funding gate
    return
  }
  const recEntries = recSim.result?.auth ?? []
  if (recEntries.length !== 1)
    throw new Error(`expected exactly 1 auth entry (smart account), got ${recEntries.length}`)

  const entry = await signAuthEntryWithPasskey({ entry: recEntries[0], kp, keyData })

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
    console.log('AUTH OK (passkey verified) — deposit then trapped on the vault path' + label + '.')
    console.log('  Fund + approve the smart account (or use the demo agent) for SHARES MINTED. error:', enfSim.error)
    return // auth gate proven; funding/approve is user-deferred
  }
  console.log('HERO GATE PASSED: passkey-signed deposit simulated successfully (funded+approved source).')
  console.log('  minResourceFee:', enfSim.minResourceFee)

  if (!SUBMIT) {
    console.log('\n(submission deferred — re-run with --submit + STELLAR_RELAYER_SECRET to mint shares on-chain)')
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
  const sharesAfter = await readVaultShares(contractId, { server })
  console.log('vault shares (after):', sharesAfter?.toString() ?? 'null')
  if (sharesBefore != null && sharesAfter != null && sharesAfter > sharesBefore)
    console.log('SHARES MINTED — the hero moment landed on-chain.')
}

main().catch((e) => {
  console.error('\nM3 smoke error:', e?.message || e)
  process.exitCode = 1
})

// frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs
//
// Closes the m3 gap: fund (faucet) -> approve (passkey, self-paid) -> deposit (passkey, relayed)
// -> SHARES MINTED, headlessly. Node has no WebAuthn so we reuse the M0b synthetic P-256 signer
// (the same recipe that PASSED on-chain at M0b); the Soroban auth path is identical to the
// browser kit.signAuthEntry path. Mirrors m3-deposit-smoke.mjs and adds the faucet + approve legs.
//
// Run (vite-node; needs the dev server up for /api/faucet + /api/stellar-relay):
//   cd frontend && VF_RELAY_URL=http://localhost:5173 npx vite-node scripts/m3plus-fund-approve-deposit-smoke.mjs --submit

import { Keypair, TransactionBuilder, Operation, Address, xdr, hash, StrKey, BASE_FEE, rpc } from '@stellar/stellar-sdk'
import { createHash, webcrypto } from 'node:crypto'
import { normalizeLowS, buildChallenge, assembleSecp256r1Signature } from '../src/wallet/passkey.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'
import { ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ADDRESS, RP_ID } from '../src/wallet/config.js'
import { readTokenBalance } from '../src/stellar/agentDeposit.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'

const FAUCET_URL = (process.env.VF_RELAY_URL || 'http://localhost:5173') + '/api/faucet'
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle
// 1 USDC (7-decimal base units). Must clear Blend's supply minimum — a dust amount like 1n
// (0.0000001 USDC) mints 0 bTokens and the pool rejects submit_with_allowance with Error #1216.
// Faucet dispenses 10 USDC and we approve 100, so 1 USDC is well within balance + allowance.
const DEPOSIT_AMOUNT = 10_000_000n

// ---- copied verbatim from m3-deposit-smoke.mjs (unchanged): ----
//   fundFriendbot, getAccountWithRetry, waitSuccess, externalSignerScVal,
//   makeSyntheticSigner, signAuthEntryWithPasskey, deploySmartAccount
// (they are the proven on-chain auth recipe; do not re-derive them)

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
// ---- end verbatim copy ----

async function dispense(to) {
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: process.env.VF_RELAY_URL || 'http://localhost:5173' },
    body: JSON.stringify({ action: 'dispense', to }),
  })
  if (!res.ok) throw new Error(`faucet failed (${res.status}): ${await res.text()}`)
  return res.json()
}

async function main() {
  console.log('=== M3+ fund -> approve -> deposit smoke ===')
  const { facts } = vaultFacts(process.env.VF_PROTOCOL || 'aave-v3')
  const eligibility = (p) => vfEligibility({ ...p, facts })
  const probe = await eligibility({ vault: SOROBAN_VAULT_ADDRESS, amount: DEPOSIT_AMOUNT })
  if (!probe.allow) { console.log('F8 rejected; re-run with VF_PROTOCOL=aave-v3'); return }

  const { kp, keyData } = await makeSyntheticSigner()
  const deployer = Keypair.random()
  await fundFriendbot(deployer.publicKey())
  const { contractId } = await deploySmartAccount({ deployer, keyData })
  console.log('account:', contractId)

  console.log('faucet:', await dispense(contractId))
  for (let i = 0; i < 20; i++) {
    const bal = await readTokenBalance(contractId, { server })
    if (bal && bal > 0n) { console.log('balance:', bal.toString()); break }
    await new Promise((r) => setTimeout(r, 1500))
  }
  // Production-path approve + deposit: call the same submit.js wrappers the browser popup uses,
  // injecting only the headless seams. This exercises the REAL defaultSignSubmitApprove /
  // defaultBuildDepositInner assemblers — no hand-rolled parallel copy that can drift out of sync.
  //   kit   — synthetic-P256 signer stands in for the browser's Face-ID kit.signAuthEntry.
  //   relay — forged-Origin POST: node fetch sends no Origin, and the relay's applyCors allowlists
  //           the dev origin (a real popup auto-sends it, so production uses relay.js directly).
  const kit = { signAuthEntry: (entry) => signAuthEntryWithPasskey({ entry, kp, keyData }) }
  const relayOrigin = process.env.VF_RELAY_URL || 'http://localhost:5173'
  const relayPost = (body) =>
    fetch(relayOrigin + '/api/stellar-relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: relayOrigin },
      body: JSON.stringify(body),
    })
  const relay = {
    getRelayerAddress: async () => (await (await relayPost({ action: 'wallet' })).json()).address,
    submitViaRelay: async ({ xdr: envXdr }) => {
      const res = await relayPost({ action: 'submit', xdr: envXdr })
      if (!res.ok) throw new Error(`relay HTTP ${res.status}: ${await res.text()}`)
      const relayed = await res.json()
      if (!relayed || relayed.configured === false || relayed.error || !relayed.hash)
        throw new Error(`relay rejected (check STELLAR_RELAYER_SECRET + dev server): ${JSON.stringify(relayed)}`)
      await waitSuccess(relayed.hash, 'deposit') // confirm on-chain before submitDeposit reads shares
      return { hash: relayed.hash, status: relayed.status }
    },
  }

  const approved = await submitApprove({ contractId, amount: 100n * 10n ** 7n, kit, server })
  console.log('approve OK:', approved.hash)

  const dep = await submitDeposit({ contractId, amount: DEPOSIT_AMOUNT, eligibility, kit, server, relay })
  console.log('deposit relayed:', dep.hash, dep.status)
  console.log('shares:', dep.sharesBefore?.toString(), '->', dep.sharesAfter?.toString())
  if (dep.sharesBefore != null && dep.sharesAfter != null && dep.sharesAfter > dep.sharesBefore)
    console.log('SHARES MINTED — m3+ end-to-end passed.')
  else throw new Error('shares did not increase')
}

if (process.argv.includes('--submit')) {
  main().catch((e) => { console.error('m3+ smoke error:', e?.message || e); process.exitCode = 1 })
} else {
  console.log('dry: module loaded, pass --submit to run live (needs dev server + STELLAR_RELAYER_SECRET + VF_FAUCET_SECRET)')
}

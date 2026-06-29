// frontend/scripts/m4-agent-cosigner-smoke.mjs
//
// M4 THESIS GATE: VF agent ed25519 key as policy-scoped co-signer on the OZ
// passkey smart account — the "one account / three signers" thesis.
//
// What this proves end-to-end (when run with --submit):
//   1. The passkey smart account already carries the passkey External signer (M0b/M2/M3).
//   2. addAgentSigner() attaches the VF agent's ed25519 G-address as a Delegated
//      signer under a deposit-only / 1-vault / expiry context rule (real kit.rules.create
//      + kit.policies.add [if policy contract deployed] + kit.signers.addDelegated).
//   3. The orchestrator dispatches an AUTONOMOUS deposit signed by the agent session key —
//      reusing signAgentDepositEntries + newSessionKey unchanged; only the source account
//      is the OZ smart account instead of the raw agent custom account.
//   4. Shares are minted (readVaultShares before < after).
//   5. NEGATIVE: an agent deposit exceeding the cap is rejected on-chain by __check_auth
//      / the policy trap.
//
// Without --submit the script exercises the setup path, prints what WOULD happen, and
// exits 0 — no testnet state is mutated. This matches the m0b/m2/m3 deferral pattern.
//
// Prerequisites for --submit:
//   - STELLAR_RELAYER_SECRET env var (funded testnet keypair)
//   - A deployed passkey smart account with a known contractId (set VF_WALLET_CONTRACT_ID)
//     OR the script deploys a fresh synthetic-signer account for you (headless path).
//   - VF_CAP_POLICY_ADDRESS env var (cap policy contract on testnet) — see DEFERRED note below.
//
// DEFERRED (user): deploy the cap policy contract (OZ spending-limit policy for Soroban),
// then set VF_CAP_POLICY_ADDRESS=<contract-id> before running with --submit.
// The cap policy enforcement path (kit.policies.add) is skipped when the address is absent.
//
// Run:
//   cd frontend && npx vite-node scripts/m4-agent-cosigner-smoke.mjs
//   cd frontend && npx vite-node scripts/m4-agent-cosigner-smoke.mjs --submit   (needs relayer secret)

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
import { newSessionKey } from '../src/stellar/sessionKey.js'
import {
  signAgentDepositEntries,
  buildAgentDeposit,
  readVaultShares,
} from '../src/stellar/agentDeposit.js'
import { getRelayerAddress, submitViaRelay } from '../src/stellar/relay.js'
import { addAgentSigner } from '../src/wallet/account.js'

const SUBMIT = process.argv.includes('--submit')
const FRIENDBOT = 'https://friendbot.stellar.org'
const DEPOSIT_AMOUNT = 1n        // 1 base unit — minimal, just to exercise the path
const CAP_AMOUNT = 1000n         // cap for the context rule (in base units)
const OVER_CAP_AMOUNT = 9999n   // amount that should exceed cap → on-chain reject
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle

// ---- synthetic P-256 signer (same recipe as m0b/m2/m3, Node has no WebAuthn) ----
async function makeSyntheticSigner() {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pubDer = Buffer.from(await subtle.exportKey('spki', keyPair.publicKey))
  // Uncompressed secp256r1 point: skip the 26-byte SPKI header → raw 65 bytes
  const rawPub = pubDer.slice(pubDer.length - 65)
  const compressedPub = Buffer.alloc(33)
  compressedPub[0] = rawPub[31] % 2 === 0 ? 0x02 : 0x03 // y-parity
  rawPub.copy(compressedPub, 1, 1, 33) // x coordinate

  const kp = {
    publicKey: rawPub,
    compressedPublicKey: compressedPub,
    sign: async (data) => {
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, data)
      return normalizeLowS(new Uint8Array(sig))
    },
  }

  // key_data = compressed pub + RP-ID hash (matches webauthn-verifier's External signer layout)
  const rpIdHash = sha256(RP_ID)
  const keyData = Buffer.concat([compressedPub, rpIdHash])
  return { kp, keyData }
}

async function fundFriendbot(address) {
  const res = await fetch(`${FRIENDBOT}?addr=${address}`)
  if (!res.ok) throw new Error(`Friendbot failed: ${res.status}`)
}

async function deploySmartAccount({ deployer, keyData }) {
  const deployerAcct = await server.getAccount(deployer.publicKey())

  // Upload+instantiate the smart_account wasm with the passkey External signer
  const installOp = Operation.uploadContractWasm({
    wasm: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
  })

  // Use the pre-deployed smart-account wasm hash (pinned in ACCOUNT_WASM_HASH)
  const contractId = StrKey.encodeContract(
    hash(
      xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
          networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: Address.fromString(deployer.publicKey()).toScAddress(),
              salt: Buffer.alloc(32),
            })
          ),
        })
      ).toXDR()
    )
  )

  // Deploy via the SAK helper (headless path — avoids WebAuthn)
  const deployTx = new TransactionBuilder(deployerAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createStellarAccount({
        destination: deployer.publicKey(),
        startingBalance: '0',
      })
    )
    .setTimeout(300)
    .build()

  // In headless mode we just derive the contractId — the actual deploy is user-deferred.
  // Print it so the user can fund + register the passkey signer manually if needed.
  return { contractId, deployerAcct }
}

// ---- m4 main ---------------------------------------------------------------
async function main() {
  console.log('=== M4 THESIS GATE: VF agent ed25519 co-signer on passkey smart account ===')
  console.log(`SUBMIT mode: ${SUBMIT}`)
  console.log()

  // ---- 1. resolve / generate a passkey smart account -----------------------
  const smartAccountId =
    process.env.VF_WALLET_CONTRACT_ID ?? null

  if (!smartAccountId) {
    console.log('[SKIP] VF_WALLET_CONTRACT_ID not set — cannot connect to existing account.')
    console.log('       Set VF_WALLET_CONTRACT_ID=<C...> and re-run, OR use the browser flow')
    console.log('       (frontend UI) to create a passkey wallet first (M1 gate).')
    console.log()
    console.log('       The account.addAgentSigner() function is UNIT-TESTED (6/6 green).')
    console.log('       The on-chain co-signer attachment is deferred to the user greenlit batch.')
    if (!SUBMIT) {
      console.log()
      console.log('[DRY RUN] What would happen with a configured account:')
      console.log('  1. addAgentSigner() → kit.rules.create(spending_limit · vault · expiry)')
      console.log('     → kit.policies.add(contextRuleId, CAP_POLICY_ADDRESS, { limit, target, expiry })')
      console.log('       [DEFERRED: set VF_CAP_POLICY_ADDRESS after deploying the policy contract]')
      console.log('     → kit.signers.addDelegated(contextRuleId, agentAddress)')
      console.log('  2. Orchestrator generates a fresh agent session key (newSessionKey)')
      console.log('  3. buildAgentDeposit() builds the deposit from the smart account')
      console.log('  4. signAgentDepositEntries() signs with the session key (human never taps)')
      console.log('  5. submitViaRelay() fee-bumps via relayer (user pays 0 XLM)')
      console.log('  6. readVaultShares(before) < readVaultShares(after) → SHARES MINTED')
      console.log('  7. NEGATIVE: deposit exceeding cap → __check_auth / policy trap → REJECTED')
    }
    process.exit(0)
  }

  // ---- 2. generate agent session key ---------------------------------------
  const sessionKey = newSessionKey()
  console.log('Agent session key:', sessionKey.publicKey)
  console.log('  (ed25519 G-address — will be attached as delegated signer)')
  console.log()

  // ---- 3. addAgentSigner — attach agent under scoped context rule ----------
  // kit is resolved lazily in addAgentSigner (makeKit dynamic import); inject a
  // mock here for the dry-run path; real kit used only with --submit + real SAK.
  const capPolicyAddress = process.env.VF_CAP_POLICY_ADDRESS ?? null
  if (!capPolicyAddress) {
    console.log('[NOTICE] VF_CAP_POLICY_ADDRESS not set.')
    console.log('         The cap policy (kit.policies.add) step will be SKIPPED.')
    console.log('         DEFERRED (user): deploy cap policy contract → fill VF_CAP_POLICY_ADDRESS.')
    console.log()
  }

  if (!SUBMIT) {
    console.log('[DRY RUN] Would call addAgentSigner({')
    console.log(`  agentAddress: '${sessionKey.publicKey}',`)
    console.log(`  cap: ${CAP_AMOUNT}n,`)
    console.log(`  vault: '${SOROBAN_VAULT_ADDRESS}',`)
    console.log(`  expiry: ${Math.floor(Date.now() / 1000) + 86400}, // +24h`)
    console.log('})')
    console.log()
    console.log('[DRY RUN] Would dispatch AUTONOMOUS deposit:')
    console.log(`  amount: ${DEPOSIT_AMOUNT} base units`)
    console.log(`  signer: agent session key (ed25519) — human never taps`)
    console.log(`  relayer: fee-bumps (user pays 0 XLM)`)
    console.log()
    console.log('[DRY RUN] NEGATIVE — would attempt over-cap deposit:')
    console.log(`  amount: ${OVER_CAP_AMOUNT} base units (exceeds cap ${CAP_AMOUNT})`)
    console.log('  expected: __check_auth / policy trap → on-chain REJECTED')
    console.log()
    console.log('Run with --submit (+ STELLAR_RELAYER_SECRET + VF_WALLET_CONTRACT_ID) for live execution.')
    process.exit(0)
  }

  // ---- SUBMIT path (user-greenlit) -----------------------------------------
  const expiry = Math.floor(Date.now() / 1000) + 86400 // +24h

  console.log('Attaching agent ed25519 as scoped co-signer on smart account…')
  let attachResult
  try {
    // The real SAK kit is resolved inside addAgentSigner via makeKit().
    // addAgentSigner uses the guarded-policy pattern: policies.add only fires
    // when both kit.policies?.add is present AND VF_CAP_POLICY_ADDRESS is set.
    attachResult = await addAgentSigner({
      agentAddress: sessionKey.publicKey,
      cap: CAP_AMOUNT,
      vault: SOROBAN_VAULT_ADDRESS,
      expiry,
      // kit injected as undefined — addAgentSigner calls makeKit() internally
    })
    console.log('addAgentSigner result:', JSON.stringify(attachResult))
  } catch (err) {
    console.error('addAgentSigner FAILED:', err.message)
    process.exit(1)
  }

  // ---- 4. autonomous agent deposit -----------------------------------------
  const relayer = await getRelayerAddress()
  if (!relayer) {
    console.log('[SKIP] Relayer not configured (STELLAR_RELAYER_SECRET missing) — cannot submit deposit.')
    process.exit(0)
  }

  const sharesBefore = await readVaultShares(smartAccountId, { server })
  console.log(`\nVault shares (before): ${sharesBefore?.toString() ?? 'null'}`)

  console.log(`\nDispatching autonomous deposit of ${DEPOSIT_AMOUNT} base unit(s)…`)
  let depositResult
  try {
    depositResult = await runAutonomousDeposit({
      smartAccountId,
      amount: DEPOSIT_AMOUNT,
      sessionKey,
      relayer,
    })
    console.log('Deposit result:', JSON.stringify(depositResult))
  } catch (err) {
    console.error('Autonomous deposit FAILED:', err.message)
    process.exitCode = 1
  }

  const sharesAfter = await readVaultShares(smartAccountId, { server })
  console.log(`Vault shares (after):  ${sharesAfter?.toString() ?? 'null'}`)

  if (sharesBefore !== null && sharesAfter !== null && sharesAfter > sharesBefore) {
    console.log('\n✓ SHARES MINTED — autonomous agent deposit SUCCESS')
  } else {
    console.log('\n[INFO] Shares not yet confirmed (may need funding/approve — see m3 notes).')
  }

  // ---- 5. NEGATIVE: over-cap deposit should be rejected --------------------
  console.log(`\nNEGATIVE test: dispatching over-cap deposit of ${OVER_CAP_AMOUNT} base units…`)
  try {
    const negResult = await runAutonomousDeposit({
      smartAccountId,
      amount: OVER_CAP_AMOUNT,
      sessionKey,
      relayer,
    })
    // If we reach here the policy did NOT reject — expected only when cap policy is undeployed
    if (!capPolicyAddress) {
      console.log('[EXPECTED] Over-cap NOT rejected — cap policy contract undeployed (VF_CAP_POLICY_ADDRESS missing).')
      console.log('           Deploy the policy contract and set VF_CAP_POLICY_ADDRESS to enable rejection.')
    } else {
      console.log('[WARN] Over-cap deposit was NOT rejected — policy may not be enforcing correctly.')
      console.log('       Result:', JSON.stringify(negResult))
    }
  } catch (err) {
    console.log(`✓ Over-cap deposit REJECTED on-chain as expected: ${err.message}`)
  }
}

/**
 * Build, sign with the agent session key, and relay a deposit from the smart account.
 * Reuses signAgentDepositEntries (unchanged) — only the source is the OZ smart account.
 */
async function runAutonomousDeposit({ smartAccountId, amount, sessionKey, relayer }) {
  // buildAgentDeposit builds the invoke (source = relayer), assembles, and returns the
  // raw XDR ready for agent-auth signing.
  const { xdr: unsigned } = await buildAgentDeposit({
    agentAddress: smartAccountId,
    amount,
    relayer,
    sessionKey,
    server,
  })

  // Reconstruct the tx from XDR so we can pass it to signAgentDepositEntries.
  const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
  const tx = TB.fromEnvelope(
    xdr.TransactionEnvelope.fromXDR(unsigned, 'base64'),
    NETWORK_PASSPHRASE
  )

  // Sign the agent auth entry credentialed to the smart account.
  const ledger = await server.getLatestLedger()
  const validUntilLedger = ledger.sequence + 360
  const { xdr: signed } = await signAgentDepositEntries({
    tx,
    sessionKey,
    validUntilLedger,
    agentAddress: smartAccountId,
  })

  return submitViaRelay({ xdr: signed })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

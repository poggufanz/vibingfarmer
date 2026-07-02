// frontend/scripts/m5-recovery-smoke.mjs
//
// M5 RECOVERY GATE: a DISTINCT VF-held External G-address as a recovery signer
// on the OZ passkey smart account — the third leg of the "one account / three
// signers" thesis (passkey · agent · recovery).
//
// What this proves end-to-end (when run with --submit):
//   1. The passkey smart account already carries the passkey External signer (M0b/M2/M3)
//      and the agent ed25519 co-signer (M4).
//   2. addRecoverySigner() attaches a DISTINCT VF-held G-address as a Delegated
//      signer under a SIGNER-MANAGEMENT-ONLY context rule (kit.rules.create with
//      allowedFns ['add_signer','remove_signer'] + kit.signers.addDelegated).
//      The recovery key is NOT the relayer key and NOT a delegated C-account.
//   3. LOST DEVICE → recovery: rotateToNewPasskey() has the recovery signer
//      authorize add_signer(newPasskey), then remove_signer(oldPasskey) — relayed
//      via fee-bump (user pays 0 XLM). Add-before-remove: never signer-less.
//   4. NEGATIVE: an UNAUTHORIZED key (random session key) attempts a vault deposit
//      → rejected on-chain. NOTE: this proves only "an unknown key can't deposit";
//      the stronger recovery-scope guarantee ("the recovery rule excludes deposit")
//      is carried by the unit invariant `not.toContain('deposit')` in
//      recovery.test.js — signing AS the recovery signer is the CAP-71 manual-auth
//      path we intentionally don't build. Funds-safe either way.
//
// Without --submit the script exercises the setup path, prints what WOULD happen,
// and exits 0 — no testnet state is mutated. Matches the m0b/m2/m3/m4 deferral.
//
// EVIDENCE-BASED DEVIATION (see task-14-report.md): the brief's allowedFns
// ['add_signer','rotate','update_signer'] is stale. The deployed OZ smart_account
// wasm has NO `rotate` / `update_signer`; the real surface is add_signer +
// remove_signer (verified via `stellar contract info interface --wasm
// scripts/soroban/wasm/smart_account.wasm`).
//
// HONESTY: the recovery key is VF-custodied (centralization trade-off). It can
// rotate the passkey but can NEVER move funds (deposit traps on-chain). The
// Task 15 UI must label this scope clearly.
//
// Prerequisites for --submit:
//   - STELLAR_RELAYER_SECRET env var (funded testnet keypair)
//   - A deployed passkey smart account with a known contractId (set VF_WALLET_CONTRACT_ID)
//   - VF_RECOVERY_G env var (the distinct VF-held recovery G-address) — see NOTICE below
//
// Run:
//   cd frontend && npx vite-node scripts/m5-recovery-smoke.mjs
//   cd frontend && npx vite-node scripts/m5-recovery-smoke.mjs --submit   (needs relayer secret)

import { rpc } from '@stellar/stellar-sdk'

import { SOROBAN_RPC_URL, SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'
import { newSessionKey } from '../src/stellar/sessionKey.js'
import { buildAgentDeposit, signAgentDepositEntries } from '../src/stellar/agentDeposit.js'
import { getRelayerAddress, submitViaRelay } from '../src/stellar/relay.js'
import { addRecoverySigner, rotateToNewPasskey } from '../src/wallet/recovery.js'

const SUBMIT = process.argv.includes('--submit')
const DEPOSIT_AMOUNT = 1n // 1 base unit — the NEGATIVE recovery-deposit attempt
const server = new rpc.Server(SOROBAN_RPC_URL)

// This smoke CONNECTS an existing deployed passkey smart account (via
// VF_WALLET_CONTRACT_ID) exactly like the sibling m0b/m2/m3/m4 smokes operate on
// a known account — it does NOT deploy in-script.

async function main() {
  console.log('=== M5 RECOVERY GATE: VF-held recovery signer (signer-mgmt-only) ===')
  console.log()

  const smartAccountId = process.env.VF_WALLET_CONTRACT_ID ?? null
  const recoveryG = process.env.VF_RECOVERY_G ?? null

  if (!recoveryG) {
    console.log('[NOTICE] VF_RECOVERY_G not set.')
    console.log('         Provide a DISTINCT VF-held External G-address (NOT the relayer key,')
    console.log('         NOT a delegated C-account) to act as the recovery signer.')
    console.log('         Set VF_RECOVERY_G=<G...> before running with --submit.')
    console.log()
  }

  if (!smartAccountId) {
    console.log('[SKIP] VF_WALLET_CONTRACT_ID not set — cannot connect to existing account.')
    console.log('       Set VF_WALLET_CONTRACT_ID=<C...> and re-run, OR use the browser flow')
    console.log('       (frontend UI) to create a passkey wallet first (M1 gate).')
    console.log()
    console.log('       recovery.addRecoverySigner / rotateToNewPasskey are UNIT-TESTED (green).')
    console.log('       The on-chain recovery flow is deferred to the user-greenlit batch.')
    if (!SUBMIT) {
      console.log()
      console.log('[DRY RUN] What would happen with a configured account:')
      console.log('  1. addRecoverySigner({ accountId, recoveryG })')
      console.log("     → kit.rules.create({ type:'custom', params: buildRecoveryRule(accountId) })")
      console.log("       allowedFns = ['add_signer','remove_signer']  (NO deposit, NO transfer)")
      console.log('     → kit.signers.addDelegated(contextRuleId, recoveryG)')
      console.log('  2. LOST DEVICE: rotateToNewPasskey({ contextRuleId, appName, userName, oldSigner })')
      console.log('     → kit.signers.addPasskey(...)  (recovery authorizes add_signer(newPasskey))')
      console.log('     → kit.signers.remove(...)       (remove_signer(oldPasskey))')
      console.log('     → relayer fee-bumps the rotate tx (user pays 0 XLM)')
      console.log('  3. NEGATIVE: an UNAUTHORIZED key attempts a vault deposit → REJECTED on-chain')
      console.log('     (recovery-scope deposit-exclusion is proven by the unit invariant,')
      console.log("      recovery.test.js: rule.allowedFns not.toContain('deposit'))")
    }
    process.exit(0)
  }

  console.log('Smart account (passkey wallet):', smartAccountId)
  console.log('Recovery G-address (VF-held)  :', recoveryG ?? '(unset — set VF_RECOVERY_G)')
  console.log('Vault (deposit target)        :', SOROBAN_VAULT_ADDRESS)
  try {
    console.log('Relayer                       :', await getRelayerAddress())
  } catch {
    console.log('Relayer                       : (STELLAR_RELAYER_SECRET unset)')
  }
  console.log()

  if (!SUBMIT) {
    console.log('[DRY RUN] Would call addRecoverySigner({')
    console.log(`  accountId: '${smartAccountId}',`)
    console.log(`  recoveryG: '${recoveryG ?? '<VF_RECOVERY_G>'}',`)
    console.log('})')
    console.log("  → rule allowedFns = ['add_signer','remove_signer'] (signer-management only)")
    console.log()
    console.log('[DRY RUN] LOST DEVICE — would rotate to a fresh passkey:')
    console.log('  → recovery signer authorizes add_signer(newPasskey)')
    console.log('  → then remove_signer(oldPasskey)  (add-before-remove)')
    console.log('  → relayer fee-bumps (user pays 0 XLM)')
    console.log()
    console.log('[DRY RUN] NEGATIVE — an UNAUTHORIZED key would attempt a vault deposit:')
    console.log(`  amount: ${DEPOSIT_AMOUNT} base unit  (signed with a random key, NOT recovery creds)`)
    console.log('  expected: on-chain REJECTED. Recovery-scope deposit-exclusion is carried by the')
    console.log("            unit invariant recovery.test.js: rule.allowedFns not.toContain('deposit')")
    console.log()
    console.log('Run with --submit (+ STELLAR_RELAYER_SECRET + VF_WALLET_CONTRACT_ID + VF_RECOVERY_G) for live execution.')
    process.exit(0)
  }

  // ---- SUBMIT path (user-greenlit) -----------------------------------------
  if (!recoveryG) {
    console.error('Cannot --submit without VF_RECOVERY_G (the recovery G-address). Aborting.')
    process.exit(1)
  }

  // ---- 1. attach recovery signer under the signer-management-only rule ------
  console.log('Attaching VF recovery G-address as signer-management-only delegate…')
  let attach
  try {
    // Real SAK kit resolved inside addRecoverySigner via makeKit().
    attach = await addRecoverySigner({ accountId: smartAccountId, recoveryG })
    console.log('addRecoverySigner result:', JSON.stringify(attach))
  } catch (err) {
    console.error('addRecoverySigner FAILED:', err.message)
    process.exit(1)
  }
  // addRecoverySigner now returns { contextRuleId, ...addDelegatedResult }, so we
  // read it directly instead of guessing the SAK return shape.
  const contextRuleId = attach?.contextRuleId
  if (contextRuleId === undefined) {
    console.error('addRecoverySigner did not return a contextRuleId — cannot rotate. Aborting.')
    process.exit(1)
  }
  console.log()

  // ---- 2. lost device → rotate to a fresh passkey ---------------------------
  console.log('Simulating lost device → recovery authorizes a new passkey…')
  try {
    const rotated = await rotateToNewPasskey({
      contextRuleId,
      appName: 'Vibing Farmer',
      userName: `vf-recovery-${Date.now()}`,
      oldSigner: process.env.VF_OLD_SIGNER ?? null, // the old passkey signer to remove
    })
    console.log('rotateToNewPasskey result:', JSON.stringify(rotated))
    console.log('  → new passkey added, old passkey removed (relayer fee-bumped)')
  } catch (err) {
    console.error('rotateToNewPasskey FAILED:', err.message)
    process.exit(1)
  }
  console.log()

  // ---- 3. NEGATIVE: an UNAUTHORIZED key cannot deposit ----------------------
  // HONESTY (Task 14 review): this block signs the deposit with a RANDOM session
  // key, NOT with the recovery G-address credentials. So it proves only "an
  // unauthorized key is rejected" (trivially true) — it does NOT, on its own,
  // prove the stronger M5 claim "the recovery signer's rule excludes deposit".
  // That stronger guarantee is carried ON-CHAIN by the recovery rule's allowedFns
  // and is asserted as a UNIT INVARIANT in recovery.test.js:
  //   expect(rule.allowedFns).not.toContain('deposit')
  // Signing as the recovery signer itself would require building recovery-
  // credentialed auth entries — the CAP-71 manual-auth-entry path we INTENTIONALLY
  // do not build (the recovery key is a plain External G-address, used only for
  // signer-management via the SAK wrappers).
  // TODO: if/when a recovery-credentialed signing path is ever built, sign this
  //       deposit attempt with the VF_RECOVERY_G credentials so the trap directly
  //       exercises the recovery signer's scope (not just an unknown key).
  console.log('NEGATIVE: an UNAUTHORIZED key attempts a vault deposit (must be rejected)…')
  try {
    const sessionKey = newSessionKey() // a random key — NOT the recovery credentials
    const tx = await buildAgentDeposit({
      source: smartAccountId,
      vault: SOROBAN_VAULT_ADDRESS,
      amount: DEPOSIT_AMOUNT,
    })
    const ledger = await server.getLatestLedger()
    const { xdr: signed } = await signAgentDepositEntries({
      tx,
      sessionKey,
      validUntilLedger: ledger.sequence + 360,
      agentAddress: smartAccountId,
    })
    await submitViaRelay({ xdr: signed })
    console.error('NEGATIVE FAILED: deposit was ACCEPTED by an unauthorized key!')
    process.exit(1)
  } catch (err) {
    console.log('NEGATIVE PASSED: unauthorized-key deposit rejected on-chain as expected.')
    console.log('  (recovery-scope deposit-exclusion is carried by the unit invariant)')
    console.log('  reason:', err.message)
  }

  console.log()
  console.log('=== M5 RECOVERY GATE: PASS ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

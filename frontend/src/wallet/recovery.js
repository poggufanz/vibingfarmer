import { makeKit } from './account.js'

// M5 RECOVERY — the third signer in the "one account / three signers" thesis.
//
// The recovery signer is a DISTINCT VF-held External G-address (NOT the relayer
// key, NOT a delegated C-account → dodges the CAP-71 manual-auth-entry hazard).
// Its authority is enforced ON-CHAIN: a context rule that permits ONLY the
// account's own signer-management functions. Any other context (vault deposit,
// token transfer) traps in __check_auth.
//
// EVIDENCE-BASED DEVIATION FROM BRIEF (see task-14-report.md):
// The brief's Step 1 asserted allowedFns = ['add_signer', 'rotate', 'update_signer'].
// The deployed OZ smart_account wasm exposes NO `rotate` and NO `update_signer`.
// Verified with:
//   stellar contract info interface --wasm scripts/soroban/wasm/smart_account.wasm
// → the real signer-management surface is `add_signer` + `remove_signer`
//   (rotate = add new signer then remove old; there is no atomic `rotate` fn).
// So buildRecoveryRule binds the recovery signer to ['add_signer', 'remove_signer'].

// HONESTY (Task 15 UI label): the recovery key is VF-custodied — a centralization
// trade-off. If VF is compromised the recovery signer could rotate the passkey
// (but STILL cannot move funds — deposit/transfer trap on-chain). Surface this
// in the recovery UI so users understand the scope of the recovery authority.

export function buildRecoveryRule(accountId) {
  return {
    allowedContract: accountId, // the account itself — self signer-management only
    allowedFns: ['add_signer', 'remove_signer'], // real OZ smart_account fn names
    name: 'recovery-signer-management-only',
  }
}

// Attach the recovery G-address as a delegated signer bound to the
// signer-management-only context rule. `kit` is resolved lazily in the body —
// makeKit is async, so a default param would make it a Promise (mirrors
// addAgentSigner / sendToken in account.js). Injected kits short-circuit await.
export async function addRecoverySigner({ accountId, recoveryG, kit }) {
  kit = kit ?? (await makeKit())
  const spec = buildRecoveryRule(accountId)
  const { contextRuleId } = await kit.rules.create({ type: 'custom', params: spec })
  return kit.signers.addDelegated(contextRuleId, recoveryG)
}

// Lost-device recovery: add the NEW passkey first, then remove the OLD one.
// Add-before-remove ensures the account is never left signer-less. These SAK
// wrappers map onto the account's on-chain add_signer / remove_signer.
export async function rotateToNewPasskey({ contextRuleId, appName, userName, oldSigner, kit }) {
  kit = kit ?? (await makeKit())
  await kit.signers.addPasskey(contextRuleId, appName, userName) // recovery authorizes add_signer(newPasskey)
  return kit.signers.remove(contextRuleId, oldSigner) // remove_signer(oldPasskey) — rotate out
}

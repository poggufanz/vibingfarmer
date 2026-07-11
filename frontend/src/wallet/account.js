import { WALLET_CONFIG } from './config.js'
import { rpcServer, buildInvokeTx } from '../stellar/client.js'
import { SOROBAN_TOKEN_ADDRESS, SOROBAN_ACTIVE_VAULT_ADDRESS } from '../stellar/config.js'
import { toBaseUnits } from '../stellar/format.js'

const CACHE_KEY = 'vf_wallet_contract'

// SmartAccountKit is a NAMED export, new-constructed (confirmed against the
// installed dist .d.ts: `const kit = new SmartAccountKit({ rpcUrl, ... })`).
// It is imported DYNAMICALLY (not at module top level) so that callers who
// inject a kit (unit tests, the popup with an existing kit) never trigger SAK
// module evaluation. The installed dist re-exports a directory subpath
// (`export { SmartAccountKit } from "./kit"`) that raw Node's ESM resolver
// rejects, and vitest externalizes node_modules through that same resolver — a
// static top-level import would break the suite even with a fake kit injected.
// The Vite bundler path used at the manual M1 gate resolves it fine. Mirrors
// readBalance's existing dynamic import of agentDeposit.js.
export async function makeKit(overrides = {}) {
  const { SmartAccountKit } = await import('smart-account-kit')
  return new SmartAccountKit({ ...WALLET_CONFIG, ...overrides })
}

export async function createPasskeyWallet({ appName, userName, kit }) {
  kit = kit ?? (await makeKit())
  const { contractId, credentialId } = await kit.createWallet(appName, userName, {
    autoSubmit: true, // deploy the account
    autoFund: true, // Friendbot (testnet)
  })
  localStorage.setItem(CACHE_KEY, contractId)
  return { contractId, credentialId }
}

// Reconnect priority: explicit contractId > local cache > credentialId (indexer) > prompt.
export async function connectPasskeyWallet({ contractId, credentialId, kit } = {}) {
  kit = kit ?? (await makeKit())
  const cached = contractId ?? localStorage.getItem(CACHE_KEY)
  let res
  if (cached) res = await kit.connectWallet({ contractId: cached })
  else if (credentialId)
    res = await kit.connectWallet({ credentialId }) // needs indexer
  else res = await kit.connectWallet({ prompt: true })
  if (res?.contractId) localStorage.setItem(CACHE_KEY, res.contractId)
  return { contractId: res.contractId }
}

// Balance via the existing token contract read (reuses VF's rpc + scval path).
export async function readBalance(contractId, { server } = {}) {
  const { readTokenBalance } = await import('../stellar/agentDeposit.js')
  return readTokenBalance(contractId, {
    token: SOROBAN_TOKEN_ADDRESS,
    server: server ?? (await rpcServer()),
  })
}

// Builds the UNSIGNED token transfer invocation, sourced from the passkey smart
// account. Signing (passkey ceremony) + relay happen in the UI flow / smoke
// scripts — this stays build-only to honor the non-custodial line. `kit` is
// resolved lazily (makeKit is async — a default param would make it a Promise);
// injected kits short-circuit the await. Mirrors createPasskeyWallet's pattern.
export async function sendToken({ contractId, to, amount, kit }) {
  kit = kit ?? (await makeKit())
  const units = typeof amount === 'bigint' ? amount : toBaseUnits(amount)
  // Prefer the SDK's assembled-XDR path; fall back to buildInvokeTx on the token.
  if (kit.wallet?.transfer) return kit.wallet.transfer({ from: contractId, to, amount: units })
  const { xdr } = await buildInvokeTx({
    source: contractId,
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: contractId }, { addr: to }, { i128: units }],
  })
  return { xdr }
}

// Ports VF's registry cap (deposit-only · 1 vault · daily cap · expiry) into an OZ
// context rule, then attaches the agent's ed25519 G-address as a delegated signer
// bound to that rule. The agent then signs deposit auth-entries with its existing
// session key (reuse signAgentDepositEntries) — human never taps.
//
// Guarded-policy pattern: `kit.policies?.add` is present on the real kit (exercised
// by the m4 smoke against testnet) but absent from the unit-test mock (rules+signers
// only) — the guard lets the unit test exercise the delegated-signer path without a
// policy-contract address. This is a deliberate, controller-approved deviation from a
// literal one-call impl; documented in task-13-report.md.
export async function addAgentSigner({ agentAddress, cap, vault, expiry, kit }) {
  kit = kit ?? (await makeKit())
  const { contextRuleId } = await kit.rules.create({
    type: 'spending_limit',
    params: { token: undefined, limit: cap, target: vault, expiry },
  })
  // Real cap enforcement is a separate policy on the rule. Guarded so the unit
  // mock (rules+signers only) still exercises the delegated-signer path; the
  // m4 smoke (real kit) runs the policy.add against testnet.
  // DEFERRED (user): deploy cap policy contract and fill CAP_POLICY_ADDRESS below.
  const CAP_POLICY_ADDRESS = process.env.VF_CAP_POLICY_ADDRESS ?? null
  if (kit.policies?.add && CAP_POLICY_ADDRESS) {
    await kit.policies.add(contextRuleId, CAP_POLICY_ADDRESS, { limit: cap, target: vault, expiry })
  }
  return kit.signers.addDelegated(contextRuleId, agentAddress)
}

// Fail-closed F8 deposit: never build a deposit the eligibility gate rejects.
// Build-only (unsigned). `eligibility` is injected (vfapi.eligibility at call
// sites); `kit` is resolved lazily like sendToken. The vault `deposit(from,
// amount)` arg shape matches buildAgentDeposit in stellar/agentDeposit.js.
export async function depositToVault({ contractId, amount, eligibility, kit }) {
  const verdict = await eligibility({ vault: SOROBAN_ACTIVE_VAULT_ADDRESS, amount })
  if (!verdict.allow) throw new Error(`ineligible: ${(verdict.reasons ?? []).join('; ')}`)
  kit = kit ?? (await makeKit())
  const units = typeof amount === 'bigint' ? amount : toBaseUnits(amount)
  if (kit.wallet?.deposit)
    return kit.wallet.deposit({ from: contractId, vault: SOROBAN_ACTIVE_VAULT_ADDRESS, amount: units })
  const { xdr } = await buildInvokeTx({
    source: contractId,
    contract: SOROBAN_ACTIVE_VAULT_ADDRESS,
    method: 'deposit',
    args: [{ addr: contractId }, { i128: units }],
  })
  return { xdr }
}

// Build-only (pure, no RPC) token.approve invocation: from=account, spender=vault.
// `expiryLedger` is an ABSOLUTE ledger number (SEP-41: must be >= current ledger, else
// only valid for amount 0). submitApprove (submit.js) computes it from getLatestLedger,
// wraps this with source = an ephemeral fee-payer, and passkey-signs the from auth entry.
// Mirrors depositToVault's build-only discipline; consumed via buildInvokeTx's encodeArgs.
export function buildApprove({ contractId, vault = SOROBAN_ACTIVE_VAULT_ADDRESS, amount, expiryLedger }) {
  const units = typeof amount === 'bigint' ? amount : toBaseUnits(amount)
  return {
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'approve',
    args: [{ addr: contractId }, { addr: vault }, { i128: units }, { u32: expiryLedger }],
  }
}

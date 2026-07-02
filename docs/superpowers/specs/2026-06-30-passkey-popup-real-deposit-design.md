# Passkey Popup → Real On-Chain Deposit (self-service fund + approve + deposit)

**Date:** 2026-06-30
**Branch:** feature/wallet
**Status:** Design approved — pending spec review → implementation plan

---

## 1. Problem

The VF Wallet extension popup currently runs a **ceremony round-trip only**: `handleDepositApprove` /
`handleSend` build an *unsigned* XDR, `postSignRequest` derives a **demo challenge**
(`base64url(sha256(xdrBytes))` — NOT the real Soroban auth-entry preimage), the ceremony tab runs a
WebAuthn `get`, and **nothing is submitted on-chain**. The UI honestly says "No transfer is submitted
yet; the verified on-chain submit runs in the testnet batch."

The only working passkey sign+submit code lives in the smoke scripts (`scripts/m3-deposit-smoke.mjs`
`signAuthEntryWithPasskey` + enforced tx + `submitViaRelay`). The wallet library has **no production
submit path**.

**Goal:** make the popup's **deposit** land a real testnet transaction that **mints vault shares**,
gaslessly through VF's relayer (user pays 0 XLM), for any fresh passkey wallet — by adding a
self-service **Enable deposits** step (fund VFUSD + approve the vault).

### Out of scope (YAGNI)

- Real **send** (token transfer). The relay is deposit-only; a send would be self-paid. Deposit is the
  hero. Send stays a labeled demo for now.
- The **agent** (ed25519 session-key) path — untouched.
- SAK's own `RelayerClient` / launchtube fee-sponsoring — reuse VF's existing funded relay instead.

---

## 2. Prerequisites already fixed (this session)

- `STELLAR_RELAYER_SECRET` is set + funded (relayer `GBVJ34MT…`, ~20,000 testnet XLM). It was never
  the missing piece.
- **Bug fixed:** `SOROBAN_VAULT_ADDRESS` in `frontend/.env` and `.env.local` was a wrong placeholder
  (`CCTGGJVV…` / `CCDXZ6BU…`); the relay guard `assertVaultDeposit` rejected every deposit. Both now set
  to the deployed Blend vault `CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU`.
- **`VF_RELAY_URL` knob** added to `src/stellar/config.js` (committed) so headless runs can reach the
  relay at an absolute URL. Browser/test behavior unchanged.

These make the relay pipeline reachable and correct; this feature builds the wallet-side submit on top.

---

## 3. Key constraints (why the architecture is what it is)

1. **A Face-ID prompt dismisses an extension popup.** All WebAuthn signing must run in a **full tab**
   (`ceremony.html`), never the popup. This is already VF's pattern — we extend it.
2. **A Soroban tx needs a classic G-account as `source`** (fee + sequence). The passkey smart account is
   a **contract** (C-address); it authorizes via `__check_auth`, it is never the tx source.
   - **Deposit** → source = **relayer** G-account; VF's `/api/stellar-relay` signs the source + wraps a
     fee-bump → user pays 0. (Matches the m3 smoke.)
   - **Approve** → VF relay is **deposit-only** (refuses non-`deposit`), so the approve is **self-paid**:
     source = an **ephemeral Friendbot-funded** G-account that pays the tiny fee; the passkey signs the
     auth entry. (The m3-smoke pattern: ephemeral key = fee-payer, passkey = authorizer.)
3. **Deposit needs allowance + balance.** `vault.deposit(from=account, amount)` does
   `token.transfer_from(spender=vault, from=account)`, which requires the account to (a) hold VFUSD and
   (b) have `approve`d the vault. A fresh passkey account has neither. Unlike the deposit-only agent, the
   passkey smart account **can** sign its own `approve` (general smart account).
   - **XLM** funding is trivial (Friendbot funds the ephemeral source).
   - **VFUSD** funding needs a faucet: only the **vf-deployer** key (SAC asset admin) can mint/transfer
     VFUSD. Hence a server-side `/api/faucet`.

---

## 4. Architecture

```
POPUP (extension popup, no signing)
  intent { action, params }                     result { hash, status, ... }
        │  chrome.runtime.sendMessage                 ▲  chrome.runtime message
        ▼                                             │
BACKGROUND SW (router)  ── opens ──►  CEREMONY TAB (full tab; SAK + passkey ceremony in-context)
                                          │  makeKit + connect(contractId)
                                          │  ┌─ action='deposit' ─ build vault.deposit (F8 gate)
                                          │  │                     → SAK signAuthEntry (Face-ID)
                                          │  │                     → inner XDR (source=relayer)
                                          │  │                     → submitViaRelay  (gasless)
                                          │  │                     → poll vault shares
                                          │  └─ action='approve' ─ faucet(mint VFUSD) [if needed]
                                          │                        → build token.approve(spender=vault)
                                          │                        → SAK signAuthEntry (Face-ID)
                                          │                        → submit via RPC (source=ephemeral)
                                          └─► postMessage result
```

Server side: `/api/stellar-relay` (existing, gasless deposit fee-bump) + `/api/faucet` (new, VFUSD mint).

---

## 5. Components

### 5.1 `src/wallet/submit.js` (NEW) — production sign+submit on SAK

Pure module; SAK + relay injected for testability (mirrors `account.js makeKit` lazy-import discipline).

```js
/**
 * Build vault.deposit(from=contractId, amount), passkey-sign its auth entry (SAK signAuthEntry,
 * Face-ID ceremony), assemble with source = relayer, hand the signed inner XDR to VF's gasless relay.
 * F8 eligibility is enforced before any signing (fail-closed).
 * @returns {Promise<{ hash, status, sharesBefore, sharesAfter }>}
 */
export async function submitDeposit({ contractId, amount, eligibility, kit, relay, server })

/**
 * Build token.approve(from=contractId, spender=vault, amount=cap, expiration_ledger), passkey-sign,
 * submit via RPC with source = an ephemeral Friendbot-funded fee-payer (relay is deposit-only).
 * @returns {Promise<{ hash, status }>}
 */
export async function submitApprove({ contractId, amount, expiryLedgers, kit, server })
```

- `relay` defaults to `{ submitViaRelay, getRelayerAddress }` from `stellar/relay.js`; injectable.
- Reuses `account.depositToVault` (build + F8 gate) for the deposit invocation; adds `account.buildApprove`
  for the approve invocation.
- The deposit's inner-tx **source = relayer pubkey** (from `getRelayerAddress()`), so VF's relay signs
  source/sequence + fee-bumps. The approve's source = a fresh `Keypair.random()` Friendbot-funded inside
  `submitApprove`.

### 5.2 `src/wallet/account.js` (CHANGED) — add `buildApprove`

```js
/** Build the UNSIGNED token.approve(from, spender=vault, amount, expiration_ledger) invocation. */
export async function buildApprove({ contractId, amount, vault, expiryLedgers, kit })
```

Mirrors `depositToVault` (build-only; signing/submit live in `submit.js`).

### 5.3 `frontend/api/faucet.js` + `frontend/functions/api/faucet.js` (NEW) — VFUSD faucet

Server-side mint/transfer of VFUSD from **vf-deployer** (SAC asset admin) to a target C-address.

- Action: `{ action: 'mint', to: '<C-address>', amount? }` → `{ hash, status }`.
- Reads `VF_FAUCET_SECRET` (= vf-deployer secret, server-only) + `SOROBAN_TOKEN_ADDRESS`. Returns
  `{ configured: false }` (503) when unset (BYOK-style lockdown safe).
- Guards: `applyCors` (origin allowlist) + `rateLimit` (tight, e.g. max 3 / 60s, bucket `faucet`).
- Caps `amount` server-side (e.g. ≤ 100 VFUSD) so the faucet can't be drained.
- Wired into `vite.config.js` middleware (`/api/faucet`) + propagated env, same pattern as stellar-relay.
- **Security note:** dispenses *testnet* SAC tokens only; the admin secret never reaches the client.
  This is a deliberate dev/testnet faucet, gated + capped + rate-limited.

### 5.4 `extension/ceremony.{js,html}` (CHANGED) — action-carrying ceremony tab

Generalize from "`get` assertion only" to an action runner. `ceremony.js` reads `action` +
params from the query/string, loads SAK (`makeKit` + `connectPasskeyWallet({contractId})`), runs the
matching `submit.js` helper (the SAK passkey ceremony happens in-tab), and posts a structured result
back via `chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', action, ok, hash, status, error })`.

`ceremony.html` shows live status ("Awaiting Face ID…", "Submitting…", "Minted N shares — view tx").

### 5.5 `extension/background.js` (CHANGED) — route action + carry result

- On `SIGN_REQUEST { action, params }` → open `ceremony.html?action=…` (params passed via query or
  `chrome.storage.session`).
- On `CEREMONY_RESULT` → forward to the popup (or persist in `chrome.storage.session` so a re-opened
  popup can read the last result, since the popup may have been dismissed).

### 5.6 `extension/popup.jsx` (CHANGED) — real flow + honest copy

- **Deposit screen:** after the F8 eligibility verdict, an **Enable deposits** action and a **Deposit**
  action. No on-chain allowance read (Soroban has no cheap allowance getter): `readTokenBalance` gates
  whether the faucet mints, and **Enable deposits** is **idempotent** — it mints VFUSD if balance is low,
  then (re)issues the passkey approve. An expired/spent allowance simply means the user taps **Enable
  deposits** again. If a **Deposit** sim fails with an allowance/balance trap, the popup routes the user
  to **Enable deposits** with that hint.
- **Result:** replace the `signing-pending` "no transfer submitted yet" copy with a real status:
  tx hash + Stellar Expert link + Δshares on success; clear error on failure.
- Reads the last `CEREMONY_RESULT` from `chrome.storage.session` on mount (popup may have been dismissed
  by the Face-ID prompt).

---

## 6. Data flow — deposit (happy path)

1. Popup: user enters amount → F8 `eligibility` check → verdict shown.
2. Popup: "Approve & Deposit" → if allowance/balance short, runs **Enable deposits** first (§7).
3. Popup → background `SIGN_REQUEST { action:'deposit', amount, contractId }`.
4. Background opens `ceremony.html?action=deposit&…`.
5. Tab: `makeKit` + `connect(contractId)` → `submitDeposit({contractId, amount, eligibility, kit})`:
   - `depositToVault` builds the invocation (re-runs F8 fail-closed).
   - SAK recording-sim → `signAuthEntry` (Face-ID) over the **real** auth preimage.
   - Assemble inner tx with **source = relayer** → `submitViaRelay({xdr})`.
   - Poll `readVaultShares` before/after.
6. Tab → background → popup: `{ ok:true, hash, sharesBefore, sharesAfter }`.
7. Popup shows "Minted (sharesAfter − sharesBefore) shares" + tx link.

## 6b. Data flow — Enable deposits (fund + approve)

1. Popup: balance 0 → background → tab `action:'approve'`.
2. Tab: call `/api/faucet { action:'mint', to:contractId }` → VFUSD minted to the account.
3. Tab: `submitApprove({contractId, amount:cap, expiryLedgers})`:
   - `buildApprove` → `token.approve(from=account, spender=vault, cap, now+TTL)`.
   - SAK `signAuthEntry` (Face-ID).
   - Submit via RPC with **source = ephemeral Friendbot-funded keypair** (self-paid; relay won't sponsor).
4. Result back to popup → "Deposits enabled" → user can now Deposit.

---

## 7. Error handling

- **F8 ineligible** → abort before any signing (already enforced in `depositToVault`; re-asserted in
  `submitDeposit`). Popup shows the rejection reasons.
- **Insufficient allowance/balance** → popup routes to **Enable deposits** instead of failing the deposit.
- **Ceremony cancelled / verifier reject** → SAK throws → tab posts `{ ok:false, error }` → popup error.
- **Relay unconfigured / failed** → `submitViaRelay` returns null → `submitDeposit` surfaces an honest
  "relay unavailable" error (no silent success).
- **Faucet unconfigured (503)** → popup shows "faucet disabled on this deploy; fund manually".
- **Replay** → the relay's warm-process `_seen` guard + on-chain `executed`/nonce already bound this.

---

## 8. Testing

- **vitest units (must stay green; current suite 404):**
  - `submit.test.js` — `submitDeposit` with injected mock `kit` + mock `relay`: asserts F8 gate runs,
    inner-tx source = relayer, `submitViaRelay` called with the signed XDR, returns hash + share delta.
    `submitApprove` asserts ephemeral source funded + approve built with `spender=vault`.
  - `account.test.js` — `buildApprove` arg shape.
  - `api/faucet.test.js` — handler: 503 when unset, mint path with mocked SAC admin, cap enforcement,
    cors/rate-limit rejection.
  - `config.test.js` / `relay.test.js` — unchanged, still assert the relative default.
- **Headless smoke (new, testnet):** `scripts/m3plus-fund-approve-deposit-smoke.mjs` — synthetic P-256
  signer (like m3) → faucet/mint VFUSD → passkey approve → passkey deposit via relay → assert shares
  minted. Closes the m3 "funded+approved → SHARES MINTED" gap end-to-end headlessly. Run via vite-node
  with `VF_RELAY_URL` + dev server.
- **Manual E2E (Chrome):** load `extension-dist`, create wallet, Enable deposits, Deposit, confirm the tx
  on Stellar Expert + balance/shares move. (Documented, not automated — real Face-ID can't run headless.)

---

## 9. Build order (for the implementation plan)

1. `account.buildApprove` + unit test.
2. `src/wallet/submit.js` (`submitDeposit`, `submitApprove`) + unit tests (mock kit + relay).
3. `/api/faucet.js` + Pages wrapper + vite wiring + `_guard` + unit test + `.env(.local).example` keys.
4. Headless `m3plus` fund→approve→deposit smoke; prove shares minted on testnet.
5. `extension/ceremony.{js,html}` action runner + `background.js` routing + result relay.
6. `extension/popup.jsx` Enable-deposits + Deposit real flow + honest copy + `chrome.storage.session`
   result read.
7. Rebuild `extension-dist`; manual Chrome E2E; update HonestyLabels copy.

---

## 10. Security checklist

- vf-deployer faucet secret (`VF_FAUCET_SECRET`) server-only; never in the client bundle; 503 when unset.
- Faucet: origin allowlist + tight rate limit + server-side amount cap (testnet SAC only).
- Relay stays deposit-only (`assertVaultDeposit` unchanged) — approve does NOT go through it.
- Non-custodial line preserved: the passkey signs every auth entry; the server only fee-sponsors deposits
  and mints test tokens. No user key ever leaves the device.
- Ephemeral approve fee-payer holds only Friendbot XLM; throwaway per approve.

---

## 11. Open follow-ups (not blocking)

- Agent **cap policy** still not enforced on-chain (`VF_CAP_POLICY_ADDRESS` unset) — separate item.
- Real **send** submit — deferred (relay deposit-only).
- Faucet for production deploy — testnet-only; a mainnet build would drop `/api/faucet`.

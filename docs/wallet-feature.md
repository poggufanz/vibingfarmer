# VF Wallet — Feature Guide (Flow & Usage)

**Status:** working, proven live on Stellar testnet (Gate 1 headless + Gate 2 extension).
**Branch:** `feature/wallet` · **Type:** passkey (Face-ID / Windows Hello) Stellar smart-wallet, gasless deposits.

> **Tagline:** "MetaMask, but a passkey." No seed phrase, no browser-held private key — your fingerprint/face *is* the signer, and the user pays **0 gas** on deposits.

---

## 1. What it is

VF Wallet is a non-custodial Stellar smart-wallet where the controlling signer is a **secp256r1 WebAuthn credential** (Face-ID / Windows Hello), not a seed phrase. It is built on OpenZeppelin's **smart-account-kit (SAK)** and ships two ways:

- as a **library** (`frontend/src/wallet/`) consumed by the app and by on-chain smoke scripts, and
- as a packaged **Chrome MV3 extension** (`frontend/extension/`) with an Acid-Yield-styled popup.

The wallet is an on-chain OZ `smart_account` contract with **one account / three signer roles**:

| Signer | Key type | What it can do |
|--------|----------|----------------|
| **Passkey** (owner) | secp256r1 (WebAuthn) | Everything — sign deposits, approves, manage signers |
| **Agent** (delegated) | ed25519 G-address | Deposit-only, 1 vault, daily cap, expiry (scoped by a spending-limit context rule) |
| **Recovery** (VF-custodied) | ed25519 G-address | `add_signer` / `remove_signer` **only** — can rotate a lost passkey, can **never** move funds |

---

## 2. End-to-end flow

```
                    ┌─────────────── User's device ───────────────┐
   Face-ID / Windows Hello  ──►  passkey signs Soroban auth entry
                    └──────────────────────┬──────────────────────┘
                                           │ UNSIGNED tx (source = relayer)
                                           ▼
   POST /api/stellar-relay ──►  server fee-bumps with STELLAR_RELAYER_SECRET
                                           │  (user pays 0 XLM)
                                           ▼
                        Soroban RPC  ──►  AgentVaultDepositor / Blend vault
                                           │
                                           ▼
                        shares minted  ──►  popup shows Δshares + tx hash
```

### The steps (user-facing → code)

1. **Create wallet** — "Create new wallet (Face ID)". SAK runs the WebAuthn *create* ceremony (`navigator.credentials.create`), deploys the `smart_account` on testnet, and Friendbot-funds it. Contract id cached in `localStorage['vf_wallet_contract']`.
   `account.js:createPasskeyWallet → kit.createWallet`

2. **Reconnect (returning user)** — resolves in priority order: explicit contractId → localStorage cache → credentialId (needs SAK indexer) → prompt. No fresh registration needed.
   `account.js:connectPasskeyWallet`

3. **Enable deposits — approve (self-paid)** — faucet-dispenses Blend USDC, then passkey-signs a SEP-41 `token.approve(spender = vault)`. The **approve leg is NOT gasless**: a fresh Friendbot-funded ephemeral key self-signs and self-pays via RPC, because the relay is deposit-only. Allowance auto-expires after ~24h (`APPROVE_TTL_LEDGERS`).
   `submit.js:submitApprove → defaultSignSubmitApprove` · build via `account.js:buildApprove`

4. **F8 eligibility gate (fail-closed)** — before *any* deposit signing, the app-layer F8 gate runs over vault facts (ponzi ratio < 1.5, audit, staleness ≤ 30d). Ineligible → **throws before building**, Face-ID button stays disabled.
   `account.js:depositToVault` / `submit.js` re-asserts · verdict UI `ui/ApproveOverlay.jsx` (verdict shown **above** the amount)

5. **Deposit — sign + gasless submit** — assembles `vault.deposit` with **source = the relayer**, simulates to get the single Soroban auth entry, passkey-signs that entry (`kit.signAuthEntry`, Face-ID), re-fetches the relayer sequence (avoids `txBadSeq`), re-simulates, and hands the **unsigned** XDR to the relay. The server fee-bumps and submits → **user pays 0**.
   `submit.js:submitDeposit → defaultBuildDepositInner → kit.signAuthEntry / relay.submitViaRelay`

6. **Confirm** — re-reads vault shares, returns `{hash, status, sharesBefore, sharesAfter}`. Ceremony tab posts `CEREMONY_RESULT` back to the popup ("Minted N shares" + Stellar Expert link).
   `submit.js:submitDeposit` (return) · `extension/ceremony.js`

7. **Add recovery signer** — attaches a VF-held ed25519 recovery G-address under a context rule scoped to **signer-management only** (verified against the deployed wasm — there is no atomic rotate).
   `recovery.js:addRecoverySigner / buildRecoveryRule`

8. **Add agent signer** — ports VF's registry cap (deposit-only · 1 vault · cap · 7-day expiry) into an OZ spending-limit context rule + binds the agent G-address as a delegated signer.
   `account.js:addAgentSigner`

9. **Lost-device recovery** — `rotateToNewPasskey` adds the NEW passkey **before** removing the old signer (never left signer-less), authorized by the recovery signer.
   `recovery.js:rotateToNewPasskey`

### Passkey signing internals (why it works on-chain)

- **Challenge binding** — the passkey signs the 32-byte Soroban `signature_payload` = `sha256(HashIdPreimage::SorobanAuthorization)`, single-encoded as url-safe unpadded base64 (43 chars). **Not** a second sha256 — a re-hash yields on-chain `ChallengeInvalid`. `passkey.js:buildChallenge / assertChallengeMatches`
- **Signature normalization** — the DER ECDSA sig is converted to 64-byte `r‖s` and forced **low-S** (`s > n/2 → n − s`); the OZ webauthn-verifier rejects high-S. `passkey.js:derToRaw / normalizeLowS / assembleSecp256r1Signature`

---

## 3. How to use it

### 3a. As a user (Chrome extension)

1. Build the extension: `cd frontend; $env:VF_API_BASE='http://localhost:5173'; $env:VITE_VF_RP_ID='origin'; npm run build:ext`
2. `chrome://extensions` → Developer mode → **Load unpacked** → select `frontend/extension-dist/`.
3. Note the generated **extension id**, put `chrome-extension://<id>` in `ALLOWED_ORIGIN`, restart `npm run dev`.
4. Click the **VF Wallet** icon → the popup opens:
   - **Create wallet (Face ID)** → Windows Hello / Face-ID ceremony runs in a ceremony tab.
   - **Enable deposits** → faucet + approve (Face ID).
   - **Deposit** → enter USDC → **Check eligibility** (F8) → **Approve with Face ID** → relayed → popup shows real tx hash + Δshares.
   - **Recovery / Agent** → add scoped signers. **Activity** → Stellar Expert link.

> **Requires Chrome 122+** with a platform authenticator (Windows Hello / Touch ID), or a DevTools **virtual authenticator** for a deterministic run.

### 3b. Reproduce end-to-end (dev + gates)

> Frontend tooling runs under **Windows PowerShell** (rollup needs the win32 binary), **not WSL**. Soroban tooling is WSL-only.

1. Fill `frontend/.dev.vars` with funded testnet secrets:
   ```
   STELLAR_RELAYER_SECRET=S...            # funded testnet XLM — pays gas
   VF_FAUCET_SECRET=S...                  # treasury funded with Blend USDC
   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
   STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
   SOROBAN_VAULT_ADDRESS=CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU
   SOROBAN_TOKEN_ADDRESS=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
   ALLOWED_ORIGIN=chrome-extension://<ext-id>
   ```
2. **Gate 1 (headless, production path):** `npm run dev`, then in a second shell:
   ```
   $env:VF_RELAY_URL='http://localhost:5173'
   npx vite-node scripts/m3plus-fund-approve-deposit-smoke.mjs --submit
   ```
   Expect **`SHARES MINTED`** (drives the real `submit.js` assemblers with a synthetic-P256 signer + forged-Origin relay POST).
3. **Gate 2 (extension + real WebAuthn):** build:ext + load unpacked (§3a), walk Create → Enable → Deposit in Chrome 122 + Windows Hello.
4. **Unit suite:** `cd frontend; npm test` (Vitest; wallet specs inject a fake kit — no network).

---

## 4. Component map

| File | Role |
|------|------|
| `frontend/src/wallet/config.js` | SAK config (net/rpc/relay + OZ wasm hash + webauthn verifier); **rpId resolution** |
| `frontend/src/wallet/account.js` | Lifecycle + build-only ops: create/connect, `depositToVault` (F8-gated), `addAgentSigner`, `buildApprove` |
| `frontend/src/wallet/passkey.js` | secp256r1 primitives: challenge binding, DER→raw, low-S, ceremony runner, verifier sig assembly |
| `frontend/src/wallet/submit.js` | Production sign+submit: `submitDeposit` (gasless), `submitApprove` (self-paid) |
| `frontend/src/wallet/recovery.js` | Third signer: `addRecoverySigner` (signer-mgmt only), `rotateToNewPasskey` (add-before-remove) |
| `frontend/src/wallet/ui/ApproveOverlay.jsx` | Verdict-first approve dialog; Face-ID button disabled when ineligible |
| `frontend/src/wallet/ui/HonestyLabels.jsx` | Scoped honesty disclaimers |
| `frontend/src/vfapi/client.js` | Non-custodial thin client: eligibility + vaultFacts + build UNSIGNED XDR + submit. Never signs/holds secrets |
| `frontend/src/stellar/relay.js` | Browser relay client (pure fetch): `submitViaRelay` / `getRelayerAddress` |
| `frontend/api/stellar-relay.js` | Server gasless relay: fee-bump + `assertVaultDeposit` + CORS/rate-limit/replay guards |
| `frontend/functions/api/stellar-relay.js` | Cloudflare Pages Functions copy of the relay endpoint |
| `frontend/extension/popup.jsx` | Popup UI (welcome/create/home/send/deposit/recovery/agent/activity) |
| `frontend/extension/background.js` | MV3 service worker: `SIGN_REQUEST` → opens ceremony tab → relays `CEREMONY_RESULT` to popup |
| `frontend/extension/ceremony.js` | Ceremony tab: `connectPasskeyWallet` then `submitDeposit`/`submitApprove`; posts result back |
| `frontend/extension/manifest.json` | MV3 manifest — Chrome 122+, host perms (localhost/soroban-testnet/friendbot), `storage`+`tabs` |
| `deployments/stellar-testnet.json` | Live testnet addresses (relayer, vault, token, registry, verifier) |
| `docs/gate2-extension-e2e.md` | Gate 2 runbook (build knobs, secrets, load-unpacked, rpId finding, troubleshooting) |

### Why the extension needs a separate ceremony tab
The OS WebAuthn prompt **closes the MV3 popup**. So the popup posts `SIGN_REQUEST` to the background SW, which opens `ceremony.html` in a tab; the tab runs the Face-ID ceremony + submit and posts `CEREMONY_RESULT` back. The result is persisted to `storage.session` so it survives the popup being dismissed. (`background.js`)

---

## 5. Proven-live evidence

- **Gate 1 (headless):** `m3plus` smoke drove the real `submit.js` assemblers on testnet → deposit `c5af44ed…`, later `963cb688…` with **SHARES 0 → 1e7**. Three sim-invisible bugs fixed at first real `--submit`: `txBadSeq` (re-fetch source before enforced build), Blend dust Error #1216 (deposit ≥ 1 USDC = `1e7` base units), relay 403 (node fetch has no Origin → forge it).
- **Gate 2 (extension + real WebAuthn):** **PASSED LIVE 2026-06-30** in Chrome 122 + Windows Hello (commits `1280440` backend wiring + `1ed4df8` omit rpId). Test-machine ext id `ekigobifpjjlgbmhkcoikopdklfmfeil`.
- **Live addresses** (`deployments/stellar-testnet.json`): vault `CBZNITAP…NQOU`, Blend USDC `CAQCFVLO…RCJU`, registry `CAEHOZGU…NZOQ`; SAK 0.2.10 / bindings 0.1.2, `ACCOUNT_WASM_HASH a12e8fa9…`, webauthn_verifier `CBSHV66W…`.

---

## 6. The critical config knob: WebAuthn `rpId`

A `chrome-extension://` origin **rejects any explicit `rpId`** ("`<id>` is an invalid domain"), and `localhost` mismatches. So the extension **must OMIT rpId**:

- Build with `VITE_VF_RP_ID=origin` → `RP_ID` becomes `undefined` → `config.js` omits `rpId` → Chrome/SAK default the relying party to the extension's own origin (works for both register **and** sign).
- The web-app build leaves `VITE_VF_RP_ID` unset → `rpId='localhost'`.

This was the finding that unblocked the live Gate 2 pass.

---

## 7. Honest limits (surfaced in-app via HonestyLabels)

- **F8 eligibility is app-layer only** — fail-closed in JS, **not** enforced on-chain. Vault-facts snapshot numbers may be placeholder; run the refresh script pre-demo.
- **Agent spending cap is NOT enforced on-chain yet** — `addAgentSigner` guards `kit.policies.add` behind `VF_CAP_POLICY_ADDRESS` (currently null/deferred); only the context-rule shape is set.
- **Recovery key is VF-custodied** — a real centralization trade-off. Scoped on-chain to `add_signer`/`remove_signer` only, so a compromised VF could rotate the passkey but **cannot move funds**.
- **Testnet PoC-grade** — passkey-on-Stellar is mainnet-live at the protocol layer, but these wallet contracts are testnet PoC. Do not use real funds.
- **Deposit is gasless; approve is not** — deposit is relayer-sponsored (user pays 0); approve self-pays from a fresh Friendbot ephemeral key because the relay is deposit-only.

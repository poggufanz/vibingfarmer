# VF Wallet (Passkey Smart-Wallet Spike) — Design Spec

> **Date:** 2026-06-29 · **Branch:** `feature/wallet` · **Status:** approved design, pre-plan
> **Scope:** single-chain Stellar/Soroban testnet · adds a passkey (Face ID) human signer to VF's existing agent-swarm world
> **Research basis:** `planning/vfwallet-passkey-research.md` (51 sources, 4 adversarial verdicts) · **Brainstorm scope:** `planning/vfwallet.md`
> **Project rule:** this folder is never committed (write-only).

---

## 0. One-liner

"MetaMask, but passkey" for VF — a Chromium-extension wallet you open with Face ID (no seed phrase), built as a Stellar **smart account** that holds, on **one** account: the user's passkey signer, VF's existing ed25519 agent signer (cap/expiry-scoped), and a recovery signer. Signing stays on the user's device; VF's existing fee-bump relayer sponsors gas; F8 eligibility shows a verdict before every Face ID approve.

This is a **real, timeboxed spike** with a written fallback — not a from-scratch rebuild. It reuses VF's proven testnet pipeline (agent_account ed25519 signing, fee-bump relayer, registry, vault, deposit flow) and adds *only* the passkey/smart-account layer on top.

---

## 1. Locked decisions (from brainstorm 2026-06-29)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| Effort | What this is | **Real timeboxed spike** on `feature/wallet` | Hero demo: create → Face ID → send/receive → sign a VF deposit, live on testnet |
| Account model | Where the passkey lives | **A — OZ `smart-account-kit`** (audited contracts) with a **written B-fallback** | One account composes passkey + ed25519 agent + policy; reuses *audited* webauthn-verifier (no hand-rolled crypto); reuses VF ed25519 signing as an External signer |
| Platform | Where it runs | **Real Chromium extension** (MV3) | Matches the design literally; Chromium-first (Chrome 122+), excludes Safari web extensions |
| Timebox | How bounded | **Milestone-gated, no day cap** + cut-to-B trigger | Pass/fail milestones (§6), not a calendar |
| Approve UI | Sign-time treatment | **Verdict-first (variant B)** | Foregrounds F8 (VF's differentiator); fastest read before a Face ID tap |
| Relayer | Submission/gas | **Reuse VF's `/api/stellar-relay`** | A secp256r1 entry is just one more auth-entry on the same account; do NOT adopt Launchtube (legacy) |
| F8 | Eligibility gate | **App-layer primary** fail-closed gate | AI score is not on-chain-verifiable; on-chain policy enforces only cap/expiry/allowlist |

**Rejected:** extending VF's hand-rolled `agent_account` with secp256r1 (C) — hand-rolling WebAuthn crypto in a timebox is the footgun zone, and vfwallet.md's own rule forbids vibe-coding the key/crypto layer.

---

## 2. Architecture

```
Chromium Extension (MV3)
├─ Popup UI ............ design screens (welcome/onboarding/recovery/home/agent/signers/activity + overlays)
├─ Background SW ....... session/connection state, message bus
└─ Ceremony tab ....... WebAuthn create/get runs HERE, not in popup (popup closes on the OS prompt)
        │
        ▼
OZ Smart Account (one per user, smart-account-kit)  — audited account wasm + verifiers
├─ Signer: secp256r1 passkey (Face ID) → webauthn-verifier · context rule: full human authority
├─ Signer: ed25519 agent (VF session key) → ed25519-verifier · context rule: spending_limit/volume_cap
│                                                              (deposit-only · 1 vault · daily cap · expiry — ports VF registry cap)
└─ Signer: ed25519 recovery (VF-held, External G-addr) → context rule: add/rotate-signer ONLY (on-chain enforced — see §4)
        │
        ▼
VF fee-bump relayer (/api/stellar-relay, REUSED) → sponsors XLM fee only, never authorizes
        │
        ▼
VF vault (Blend-USDC, testnet) — existing deposit flow, unchanged
```

**Key property:** the `HashIdPreimage::SorobanAuthorization` preimage + its sha256 are curve-agnostic, so VF's existing ed25519 auth-entry assembly is reused unchanged up to the 32-byte hash. Only the **secp256r1 entry's signature shape + WebAuthn challenge-binding + low-S normalization** are new, and the audited OZ webauthn-verifier handles the on-chain verification.

**Extension WebAuthn handling (the hardest part — see M0):**
- Chromium-only (Chrome 122+); Firefox 150+ later; **never Safari web extension** (`NotAllowedError`).
- The Face ID prompt **closes the popup** → the WebAuthn ceremony runs in an extension-owned **tab/page**, which returns the assertion to the background SW.
- RP-ID is **claimed via `host_permissions`** (Chrome 122+ extension mechanism) — distinct from `.well-known/webauthn` Related Origin Requests. The RP server (VF API) must allowlist the `chrome-extension://<id>` origin.

---

## 3. Components (small, bounded; reuse VF where it already works)

| Unit | Purpose | Depends on | New / Reused |
|------|---------|-----------|--------------|
| `extension/` | MV3 manifest, popup host, background SW, ceremony tab page | Chrome APIs | **New** |
| `wallet/passkey.js` | WebAuthn create/get · DER→r‖s · **low-S normalize** · challenge = `base64url(sha256(authPreimage))` · assemble secp256r1 auth-entry | smart-account-kit, stellar-sdk | **New** |
| `wallet/account.js` | smart-account-kit wrapper: `createWallet` / `connectWallet` (credential→contractId) / `addSigner` / `rotateSigner` / `readBalance` | smart-account-kit | **New** |
| `stellar/sessionKey.js`, `agentDeposit.js`, `relay.js`, `events.js` | agent ed25519 path: session key, deposit auth-entry signing, relay submit, event poll | — | **Reused as-is** |
| `vfapi/` | thin client: `eligibility(F8)` · `vaultFacts` · `buildUnsignedTx` · `simulate` | VF API endpoints | **New (thin)** |
| `ui/` | design screens; **Approve = verdict-first** | — | **New** (ports design HTML) |

Each unit answers: *what it does / how to use it / what it depends on* (table above). `passkey.js` is the one security-critical unit and stays small + fully tested.

---

## 4. Recovery (on-chain-scoped)

**Two signers from account creation:** user passkey + a VF-held **External ed25519 recovery signer** (G-address, NOT a delegated C-account → dodges the CAP-71 manual-auth-entry simulation hazard).

**The recovery signer's authority is enforced on-chain, not by convention** (amendment 1): its OZ context rule binds it to call **only** the account's own signer-management functions (`add_signer` / `update_signer` / `rotate` on the smart account itself). Any other context (e.g. a vault `deposit`, a token `transfer`) **traps** in `__check_auth`. This makes the "scoped recovery" claim literally true.

**Flow:** lost device → new device → register a new passkey → recovery signer authorizes `add_signer(newPasskey)` → relayer fee-bumps (0 gas) → old passkey rotated out.

**Honest framing (label in UI + pitch):** the recovery key is VF-custodied for the demo = a centralization trade-off. Production upgrade path = 2-of-3 threshold signer set or SEP-30 recovery-signer servers (roadmap, not in the spike). A lone lost passkey with no surviving authorizer = bricked account (standard for contract accounts).

**Do NOT** use SoroPass `recover()` here — it is account *discovery* (re-finding accounts from factory events), not device-loss recovery.

---

## 5. VF API ("one brain", thin clients)

**Hard rule (non-custodial line):** the API returns **analysis + UNSIGNED transactions only**. It never receives a secret/seed, never signs for the user, never stores credentials. Signing happens on the user's device (passkey); VF's existing relayer fee-bumps + submits. This is an extension of the fee-bump pattern VF already runs.

| Endpoint | Returns |
|----------|---------|
| `POST /eligibility` | F8 score + reasons for a {vault, amount} (app-layer gate) |
| `GET /vault-facts` | snapshot vault facts (APY, audit, caps) |
| `POST /build-tx {kind: deposit\|send\|add-signer, params}` | assembled **unsigned** XDR with the secp256r1 auth-entry placeholder |
| `POST /simulate` | simulation result (shares out, balance delta) for the Approve screen |
| `POST /submit` | **existing `/api/stellar-relay`** — fee-bump + submit signed XDR |

Endpoint shape returns assembled XDR (matches VF's current client pattern). Same endpoints serve the extension today and any future app/extension client. Channels/parallel-relayer is **out of scope** (single batched human-approved tx needs one sequence).

---

## 6. Milestone ladder (gates + cut-to-B trigger)

No day cap; each milestone is a pass/fail gate. **M0 carries the debugging budget** (amendment 2) — the WebAuthn-in-extension layer (RP-ID claiming + ceremony tab) is the single hardest, most schedule-risky step, so it is isolated and gets the most slack.

| Milestone | Pass condition | Gate behavior |
|-----------|----------------|---------------|
| **M0a** | RP-ID claimed via `host_permissions` + a WebAuthn `create`/`get` ceremony completes in the extension's ceremony tab and returns an assertion to the SW (Chrome 122+). | The riskiest spike. Most debugging time budgeted here. |
| **M0b (GATE)** | A secp256r1 passkey signs a Soroban auth-entry that passes `__check_auth` on a **deployed OZ account, testnet** (low-S + challenge-binding correct). | **Fail / stuck → CUT TO B:** ship the passkey wallet on the default single-signer account; VF agent stays on its existing `agent_account`; composition thesis → roadmap. Or abandon → polish. |
| **M1** | Create account via Face ID + `connectWallet` + read balance. | — |
| **M2** | Send/receive USDC via passkey + relayer fee-bump. | — |
| **M3 (HERO)** | Sign a VF deposit via passkey → shares minted, verified on-chain. | The demo's hero moment. |
| **M4 (THESIS GATE)** | VF agent ed25519 added as a **policy-scoped co-signer on the same account**; runs an autonomous scoped deposit (human never taps). | **Too costly → ship M1–M3 as B**, thesis → roadmap. |
| **M5** | Recovery: `add_signer(newPasskey)` authorized by the scoped recovery signer; old passkey rotated out. | — |
| **M6** | Approve verdict-first UI + extension packaging polish. | — |

**B-fallback (written, so it's not a panic decision):** if M0b or M4 fails the gate, deliver the passkey **human wallet** (create / login / send / receive / sign-deposit via Face ID) on a single-signer smart account; the VF agent keeps running unchanged on its existing `agent_account`; the "one account, three signers" composition is documented as roadmap. M1–M3 + M5 still constitute a working, honest demo.

---

## 7. Testing & honesty

**Contract:** do not re-audit OZ verifiers. Write **testnet integration tests** for the composed account: passkey-sign happy path, agent-sign-under-cap, recovery `add_signer` (and a negative: recovery signer attempting a `deposit` → **rejected on-chain**), cap-exceeded → rejected.

**Frontend (vitest):** `passkey.js` — **assert low-S normalization** (feed a known high-S sig → expect normalized output) and **challenge-binding** (assert challenge == `base64url(sha256(authPreimage))`, mismatch → reject); `buildUnsignedTx` shape; vfapi thin-client. **Baseline: keep the current 325 frontend tests green** (post-F5) and add to them.

**E2E:** manual testnet run of M0b–M3 (the demo path), capture screenshots/gif.

**Honesty labels (per the "prove claims in code" standard):** F8 is app-layer (not on-chain); recovery key is VF-custodied (centralization); everything is testnet-grade; passkey-on-Stellar is mainnet-live at the *protocol* layer (P21) but the wallet *contracts* are app-layer/testnet PoC-grade.

---

## 8. Open risks (carried into the plan)

- **smart-account-kit SDK is young** (created Dec 2025, single maintainer) — **pin versions**; the audited guarantee is at the OZ *contract* layer, not the TS SDK. Keep the option of calling OZ contracts directly.
- **Canonical wasm hashes / verifier addresses may need self-deployment** on testnet (README shows placeholders).
- **Extension WebAuthn** is the top schedule risk (M0) — RP-ID claiming + ceremony tab + `chrome-extension://` origin allowlist.
- **Apple high-S signatures** (~50% of authenticators) — must normalize client-side, never in the relay.
- **ES256-only** registration (COSE alg −7); other algs unverifiable on Soroban.

---

## 9. What this spec does NOT change

VF's existing decimals (1e7), the agent_account ed25519 signing pipeline, the fee-bump relayer trust model (sponsor-only), the Blend-USDC vault, and the 325-test frontend baseline all stay. The passkey layer is **additive**.

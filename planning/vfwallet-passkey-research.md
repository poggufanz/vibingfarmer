# VF Wallet — Passkey Smart-Wallet on Stellar/Soroban: Decision-Grade Research Report

**Generated:** 2026-06-29 · **Sources:** 50 unique web URLs (+1 local VF repo file) · **Confidence:** High on protocol primitives and stack positioning; Medium on SDK maturity and the effort to express F8 as an on-chain policy.

---

## Executive Summary

**Build VF Wallet on `kalepail/smart-account-kit`** — the TypeScript SDK wrapping the *audited* OpenZeppelin `stellar-contracts` smart-account package — rather than on the now-legacy `passkey-kit` or the passkey-only `SoroPass`. This is the single most important finding: only the OZ smart-account model natively composes all three signers VF needs on ONE account via "context rules" — a secp256r1 passkey (Face ID human approve), VF's existing ed25519 ephemeral agent, and a policy signer — and its underlying Rust contracts were audited by OpenZeppelin Security at RC v0.7.0 (2026-04-28) with fixes merged ([Stellar Contracts RC v0.7.0 Audit](https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit)). VF's existing ed25519 auth-entry signing carries over essentially unchanged because OZ accounts authorize through standard Soroban `__check_auth`/auth entries — only the passkey entry's *signature field shape* differs and needs a WebAuthn challenge-binding check plus low-S normalization ([CAP-0051](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md)). VF can **reuse its existing fee-bump relayer unchanged** for passkey-signed transactions: a secp256r1 signature is just one more auth entry on the same account, and the relay only sponsors XLM fees, never authorizes ([Signing Soroban contract invocations](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations)). The honest demo recovery story is "deploy with two signers from day one (user passkey + a VF-held ed25519 recovery key), then 'lose passkey → recovery key authorizes a new passkey'," explicitly labeling the recovery key's centralization as the known production gap. The biggest caveat is maturity: the *contracts* are audited, but the smart-account-kit SDK is young (created Dec 2025, single maintainer) and F8's AI score cannot be a true on-chain policy — keep it in the app layer as the primary fail-closed gate.

---

## 1) Stack Decision: smart-account-kit vs passkey-kit vs SoroPass

**Pick: `smart-account-kit` (on audited OZ stellar-contracts).** It is the only option that models VF's actual goal — passkey + ed25519 agent + policy on one account.

| Dimension | smart-account-kit ✅ PICK | passkey-kit ❌ legacy | SoroPass ❌ scope-mismatch |
|---|---|---|---|
| Multi-signer (passkey + ed25519 + policy) | Yes, via context rules ([README](https://github.com/kalepail/smart-account-kit)) | Yes (legacy precursor) | **No** — passkey-only (ES256) ([justmert/soropass](https://github.com/justmert/soropass)) |
| Audited contract layer | Yes — OZ RC v0.7.0, fixes merged ([audit](https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit)) | "demo material only, not audited" ([passkey-kit](https://github.com/kalepail/passkey-kit)) | Unaudited, single maintainer |
| Maintainer positioning | "recommended solution" ([ecosystem-resources](https://github.com/stellar/ecosystem-resources/blob/main/wallet-integration/smart-account-kit.md)) | "legacy precursor… use smart-account-kit" ([npm](https://registry.npmjs.org/passkey-kit)) | Open RFC to plug into wallets-kit ([#95](https://github.com/Creit-Tech/Stellar-Wallets-Kit/issues/95)) |
| Relayer / fee sponsor | OZ Relayer (`relayerUrl`), maps to VF's fee-bump ([Relayer guide](https://docs.openzeppelin.com/relayer/1.3.x/guides/stellar-channels-guide)) | OZ Relayer | "never holds funds or keys" |
| SDK maturity | **Low** — created 2025-12-18, ~14 stars, single contributor | Still shipping (v0.12.0, Jan 2026) | **Very new**, ~1 star |

**Why not the others:** `passkey-kit`'s own banner says it is the "legacy precursor to OpenZeppelin Smart Accounts. For new projects, use smart-account-kit," and its contract is "demo material only… not audited" ([passkey-kit](https://github.com/kalepail/passkey-kit)). `SoroPass` is a thin passkey-only (secp256r1/ES256) layer for stellar-wallets-kit — it is not a multi-curve/policy account and so cannot host VF's ed25519 agent or F8 policy ([justmert/soropass](https://github.com/justmert/soropass)).

The OZ model maps near 1:1 onto VF: passkey = External signer on a webauthn verifier; ed25519 agent = External signer on the ed25519 verifier; VF's cap/expiry = a `spending_limit` policy on a context rule (OZ even ships an "AI Agent" example: `Signer::External(secp256r1_verifier, agent_key)` + `volume_cap_policy` expiring 12h) ([Smart Accounts](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account), [Context Rules](https://docs.openzeppelin.com/stellar-contracts/accounts/context-rules)). Contract logic is canonical/shared (audited wasm + reusable verifiers); you deploy per-user account *instances* referencing a wasm hash + verifier address ([packages/accounts](https://github.com/OpenZeppelin/stellar-contracts/tree/main/packages/accounts)).

---

## 2) WebAuthn → Soroban Mechanics: What Changes vs VF's ed25519 Auth-Entry

VF already produces exactly what a passkey needs. The `HashIdPreimage::SorobanAuthorization` preimage and its sha256 are **curve-agnostic**, so VF's existing ed25519 auth-entry assembly is reused unchanged up to where it signs the 32-byte hash. The on-chain primitive is the Protocol-21 / CAP-0051 host function `secp256r1_verify(pubkey BytesN<65> SEC-1, msg_digest Hash<32>, sig BytesN<64> r‖s)`, which **traps** on failure ([CAP-0051](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md), [soroban_sdk crypto](https://docs.rs/soroban-sdk/latest/soroban_sdk/crypto/struct.Crypto.html)).

Deltas for a secp256r1 entry vs VF's ed25519 entry:

1. **The contract verifies the WebAuthn digest, not the raw payload.** `__check_auth` recomputes `sha256(authenticatorData ‖ sha256(clientDataJSON))`, verifies *that*, then parses `clientDataJSON`, reads the base64url `challenge`, and asserts it equals `base64url(sha256(XDR(HashIdPreimage::SorobanAuthorization)))` — the equality binds the device assertion to exactly one tx ([contract-webauthn-secp256r1 lib.rs](https://github.com/kalepail/soroban-passkey/blob/main/contracts/contract-webauthn-secp256r1/src/lib.rs), [justmert/soropass](https://github.com/justmert/soropass), [veil](https://github.com/Miracle656/veil)). VF must add this string check; ed25519 has no equivalent.
2. **Signature field shape changes** to `Secp256r1Signature{authenticator_data, client_data_json, signature: BytesN<64>}`; multi-signer wallets key it as `Signatures(Map<SignerKey, Signature>)` with `SignerKey::Secp256r1(credential_id)` selecting the stored 65-byte key (passkey-kit), while OZ offloads to a reusable WebAuthn verifier via `AuthPayload{signers, context_rule_ids}` ([passkey-kit #32](https://github.com/kalepail/passkey-kit/issues/32), [Discussion #1499](https://github.com/stellar/stellar-protocol/discussions/1499), [OZ Authorization Flow](https://docs.openzeppelin.com/stellar-contracts/accounts/authorization-flow), [OZ webauthn-verifier](https://github.com/OpenZeppelin/stellar-contracts/blob/main/examples/multisig-smart-account/webauthn-verifier/src/contract.rs)).
3. **Client-side crypto:** ES256-only registration (COSE alg −7), DER→r‖s conversion, and **mandatory low-S normalization** — ~50% of Apple authenticators emit high-S, which the host rejects; normalize on the signing side, never by the relay ([Discussion #1435](https://github.com/stellar/stellar-protocol/discussions/1435)). ed25519 needs none of this.
4. **The fee-bump relayer is unaffected** — passkey signing stays client-side and rides the same relay path the ed25519 agent uses today.

OZ adds a cross-contract call (verifier offload) and binds `context_rule_ids` into the digest (`sha256(signature_payload ‖ context_rule_ids.to_xdr())`), so its preimage assembly differs slightly from the lighter passkey-kit map model — an architecture choice to settle in brainstorm.

---

## 3) Recovery: Minimum-Honest Demo vs Production

A Stellar passkey wallet is a contract account; recovery = "add or rotate another signer," and that mutation must itself be authorized by an **already-valid** signer. There is no magic reset — if the sole passkey is lost and no other signer was pre-installed, the account is permanently bricked, "similar to losing a traditional secret key" ([Soneso onboarding](https://github.com/Soneso/stellar_flutter_sdk/blob/master/documentation/smart-accounts/onboarding.md), [Smart wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)).

- **Minimum-honest demo (recommended):** deploy with two signers from creation — user passkey + a VF-held ed25519 *recovery* signer authorized ONLY to call add/rotate-passkey. Demo "lose passkey → recovery signer authorizes adding a new passkey; relayer fee-bumps it for 0 gas." This is a real, testnet-proven PoC ([Cheesecake Labs `rotate_signer`](https://cheesecakelabs.com/blog/building-a-passkey-enabled-smart-wallet-on-the-stellar-network/)) — and Cheesecake itself flags the centralized recovery account as a production trade-off. `add_signer`/`addPasskey` is first-class in both kits ([Signers and Verifiers](https://docs.openzeppelin.com/stellar-contracts/accounts/signers-and-verifiers)).
- **Production upgrade path:** replace the single recovery key with a 2-of-3 threshold policy, or SEP-30 recovery-signer servers on weighted/threshold accounts (`replaceDeviceKey` locks the old key) ([SEP-30](https://developers.stellar.org/docs/build/apps/wallet/sep30)). Passkey cloud-sync (iCloud Keychain / Google Password Manager) helps but is not universal.
- **Do NOT use SoroPass `recover()` for device loss** — it is account *discovery* (re-finding existing accounts from factory events, no indexer), and SoroPass lists multi-device recovery as an **unshipped** milestone ([SoroPass](https://soropass.dev/), [SDK docs](https://docs.soropass.dev/docs/sdk)). Wire it for reconnect/login UX only, if at all.

**Implementation hazard:** Soroban simulation does *not* auto-include auth entries for delegated (G/C-address) signers invoked inside `__check_auth`; the client must construct them manually until CAP-71 ([Signers and Verifiers](https://docs.openzeppelin.com/stellar-contracts/accounts/signers-and-verifiers)) — relevant if VF's recovery signer is a delegated account.

---

## 4) Browser / Device + Extension Support: What to Target First

**Target Chrome desktop + mobile Safari (iOS) for the passkey login first; treat the browser-EXTENSION build as Chromium-first (and Firefox 150+), explicitly excluding Safari web extensions.**

- Platform passkeys (Face ID/Touch ID) are broadly usable in 2026: Safari iOS ~100% WebAuthn / ~95% passkey-ready; Chrome desktop ~100% WebAuthn / ~87–90% passkey-ready, with Chrome-on-macOS using Touch ID via iCloud Keychain since Chrome 118 ([Corbado Benchmark 2026](https://www.corbado.com/passkey-benchmark-2026/web-passkey-readiness), [State of Passkeys iOS](https://state-of-passkeys.io/ios), [passkeys.dev device support](https://passkeys.dev/device-support/), [Chrome iCloud Keychain](https://developer.chrome.com/blog/passkeys-on-icloud-keychain)).
- **Extension caveat (load-bearing for VF's app + extension plan):** WebAuthn RP-ID claiming inside an extension works on Chromium (Chrome 122+) and only *recently* on Firefox 150 (landed ~Mar 2026), but **NOT in Safari web extensions** (Apple throws `NotAllowedError`; only an ephemeral `safari-web-extension://UUID` origin exists) ([MDN WebAuthn in extensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api), [Apple Developer Forums](https://developer.apple.com/forums/thread/774351), [Bitwarden `isChromium()` commit](https://github.com/bitwarden/clients/commit/6cbdecef43065798e6855d85ce72a9df1416c4bc), [Firefox Bug 1956484](https://github.com/mozilla-firefox/firefox/commit/a8b511c2be77)).
- Practical extension gotchas: the credential prompt closes the popup (open a new tab instead); the RP server must allowlist the `chrome-extension://` / `moz-extension://` origin. Note "RP-ID claiming via host_permissions" is a *different* mechanism from "Related Origin Requests" (`.well-known/webauthn`) ([Related Origin Requests](https://web.dev/articles/webauthn-related-origin-requests)).

---

## 5) Relayer + Policy / F8: Reuse the Fee-Bump Relayer; Keep F8 in the App Layer

**Relayer — REUSE VF's existing `frontend/api/stellar-relay.js` unchanged.** A Stellar C-account cannot sign a transaction envelope — it authorizes only via auth entries, and a separate G-account is the tx source paying fees ([Signing Soroban invocations](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations)). VF's relay already implements this canonical fee-payer pattern that Launchtube and OZ Channels formalize, and "the relay does NOT authorize the deposit… only pays the XLM fee" ([VF repo `frontend/api/stellar-relay.js`](file:///C:/SharredData/project/competition/vibing-farmer/frontend/api/stellar-relay.js)). A secp256r1 passkey entry is just another auth entry on the same account, so it rides the same path.
- **Do NOT adopt Launchtube** (now legacy, superseded by OZ Relayer + Channels) ([stellar/launchtube](https://github.com/stellar/launchtube), [kalepail/launchtube](https://github.com/kalepail/launchtube)).
- The *only* real limitation of single-relayer reuse is parallel throughput: VF's one relayer source serializes on one sequence number. OZ **Channels** pools channel accounts to give each concurrent tx its own sequence — adopt it only if VF dispatches multiple per-vault deposits in parallel ([Channels](https://docs.openzeppelin.com/relayer/plugins/channels), [relayer-plugin-channels](https://github.com/OpenZeppelin/relayer-plugin-channels), [Stellar Channels Guide](https://docs.openzeppelin.com/relayer/1.5.x/guides/stellar-channels-guide)). Otherwise, if the human approves one batched tx, channels are unnecessary.

**F8 — keep the score≥70 AI judgment in the app layer.** A policy signer (`SignerKey.Policy(contract)`) runs `enforce()` inside `__check_auth` and panics to deny, but it can ONLY constrain what is visible on-chain: the call `Context` (target contract, fn, args) plus on-chain/policy state and ledger time ([Policies](https://docs.openzeppelin.com/stellar-contracts/accounts/policies), [complex-account example](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/complex-account), [Context Rules](https://docs.openzeppelin.com/stellar-contracts/accounts/context-rules)). An off-chain AI score is unverifiable on-chain unless you write a *signed eligibility attestation* the policy reads — which merely relocates trust to that attester (and VF's F5 attestation is explicitly non-authoritative). The **on-chain-enforceable half** of F8 — vault allowlist, cap, expiry, daily volume — is *already* enforced by VF's `agent_account.__check_auth` + registry; a `SignerKey.Policy` contract is the "correct" framework home for those *if* VF migrates to the OZ model, but adds no security over the existing checks. Verdict: app-layer F8 as the primary fail-closed gate; policy signers reserved for the cap/expiry/allowlist invariants.

---

## 6) Integration + Realistic Timebox

**Recommendation: adopt the OZ smart-account model (via smart-account-kit) on the HUMAN-login account rather than extending the hand-rolled `agent_account`** — but pin versions and keep the option of calling OZ contracts directly, given SDK youth. The mapping is near 1:1 and the contract layer is audited; the cost is porting VF's bespoke `__check_auth` + cap into OZ policies and storing a 65-byte P-256 key.

**Minimal demo (maps to vfwallet.md Q1):** create account → Face ID register/login → send/receive → sign a VF deposit, with a 2-signer account (passkey + VF recovery ed25519) and the existing relayer fee-bumping.

**Footgun list:**
- High-S signatures from Apple authenticators → must normalize to low-S client-side ([Discussion #1435](https://github.com/stellar/stellar-protocol/discussions/1435)).
- base64url alphabet/padding mismatch breaks the challenge check (kalepail hardcodes a 43-char unpadded buffer for a 32-byte hash) ([contract-webauthn lib.rs](https://github.com/kalepail/soroban-passkey/blob/main/contracts/contract-webauthn-secp256r1/src/lib.rs)).
- Register ES256-only; other COSE algs are unverifiable on Soroban.
- Delegated-signer auth entries not auto-simulated (manual construction until CAP-71).
- Safari extension WebAuthn unsupported — don't promise a Safari extension.
- smart-account-kit is young/single-maintainer — pin versions; audited guarantee is at the OZ contract layer, not the SDK.
- Canonical testnet/mainnet addresses for the OZ account wasm hash + verifiers may need self-deployment (README shows placeholders).

**Day estimate (judgment, not researched):** the research does not give a calibrated day count — that stays a user judgment call. Given vfwallet.md's own rule (stretch/roadmap, hard timebox, only after MVP+demo+pitch are safe), a defensible hard cut-loss is the brainstorm decision; the testnet PoCs (Cheesecake `rotate_signer`, brozorec two-signer demo) suggest the *core* passkey-sign + recovery loop is a few-day spike for someone who already has VF's ed25519 auth-entry pipeline. Decimals stay at 1e7 throughout (orthogonal to signatures; caps live in the contract).

---

## Verified / Drift Watch

This is fast-moving, status-sensitive tech. The four adversarial verdicts:

1. **"secp256r1 passkey wallets are LIVE on mainnet (Protocol 21 / CAP-0051), not just testnet" → CONFIRMED-WITH-CAVEAT.** The *native secp256r1 verification host function* is mainnet-live since Protocol 21 (June 18, 2024) ([Protocol 21 live](https://stellar.org/blog/developers/protocol-21-is-live-on-stellar-mainnet), [CAP-0051](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md), [protocol-upgrades](https://stellar.org/protocol-upgrades), [stellar-core v21.0.0](https://github.com/stellar/stellar-core/releases/tag/v21.0.0), [Stellar passkey feature](https://stellar.org/blog/foundation-news/introducing-the-new-stellar-passkey-feature-seamless-web3-smart-wallet-functionality-on-mainnet)). **Caveat:** that is the protocol *primitive*; the wallet *contracts* are application-layer and many reference implementations/demos still run primarily on testnet, with no finalized SEP for the contract-account interface.

2. **"passkey-kit is legacy; recommended new stack is smart-account-kit on audited OZ contracts" → CONFIRMED-WITH-CAVEAT.** Confirmed by the maintainer's own banner (kalepail authors both) and Stellar's ecosystem-resources ("recommended… built on audited OpenZeppelin"). **Caveats:** "legacy" = superseded-but-still-maintained (v0.12.0, Jan 2026), not npm-deprecated; "audited" applies to the OZ Rust contracts, NOT the young TS SDK (Dec 2025, single contributor); and the main Stellar dev-docs "Smart wallets" guide still lists Passkey Kit without a legacy flag (documentation lag) ([Smart wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)).

3. **"Device-loss recovery via adding a NEW passkey signer is real/shipped/testnet-proven (SoroPass and/or smart-account-kit)" → CONFIRMED-WITH-CAVEAT.** Real and testnet-proven via OZ audited `add_signer`, kalepail/Soneso SDKs, brozorec two-signer demo, and Cheesecake `rotate_signer` PoC ([brozorec/smart-account-sign](https://github.com/brozorec/smart-account-sign), [Cheesecake Labs](https://cheesecakelabs.com/blog/building-a-passkey-enabled-smart-wallet-on-the-stellar-network/), [Soneso onboarding](https://github.com/Soneso/stellar_flutter_sdk/blob/master/documentation/smart-accounts/onboarding.md)). **Caveats:** (a) **SoroPass is a misleading citation for THIS pattern** — its shipped "recover" is address re-discovery and multi-device recovery is unshipped; (b) recovery only works if a *surviving* authorizer already exists (a lone lost passkey = bricked); (c) everything is recent (Dec 2025–Jun 2026) and mostly testnet/PoC-grade, not mainnet-battle-tested.

4. **"Platform passkeys broadly usable across Chrome desktop + Safari iOS AND can work inside a browser extension (rpId/related-origins caveats)" → CONFIRMED-WITH-CAVEAT.** Platform passkey usability is strongly confirmed (Q1–Mar 2026 data). **Caveats:** the extension portion is browser-specific — Chromium (Chrome 122+) and Firefox 150+ only; **Safari web extensions do NOT support it** (`NotAllowedError`). The phrase "rpId/related-origins" conflates two distinct mechanisms. For a VF browser-extension build, plan Chromium/Firefox-only.

---

## Open Questions for Brainstorm (mapped to vfwallet.md Q1–Q6)

- **Q1 — Minimal demo shape & realistic time.** *Answered:* the create-account → Face ID → send/receive → sign-VF-deposit loop is buildable on smart-account-kit + audited OZ contracts, reusing VF's ed25519 auth-entry pipeline and existing relayer; testnet PoCs exist. *Judgment call:* the exact day count and the hard cut-loss timebox (research gives no calibrated estimate).
- **Q2 — Recovery flow.** *Answered:* ship the 2-signer "passkey + VF-held ed25519 recovery key → rotate to new passkey" pattern (Cheesecake-proven); SoroPass `recover()` is NOT device-loss recovery. *Judgment call:* whether to label/upgrade toward 2-of-3 threshold or SEP-30 for the pitch, and whether the recovery signer is delegated (CAP-71 simulation pain) or external.
- **Q3 — Browser/device target.** *Answered:* target Chrome desktop + mobile Safari first for the web app; if/when an extension ships, Chromium-first + Firefox 150+, exclude Safari extensions. *Judgment call:* app-only vs app+extension for the submission (changes whether OZ Channels and extension-origin allowlisting matter).
- **Q4 — Extend existing agent_account vs new account.** *Answered:* research favors adopting the OZ smart-account model on a fresh human-login account (audited, composes all 3 signers) over extending the hand-rolled `agent_account`; the ed25519 agent migrates in as an External signer with unchanged auth-entry signing. *Judgment call:* the contract-rewrite cost vs keeping bespoke `__check_auth`, and external-vs-delegated for the agent signer (cost/revocation tradeoffs not evaluated).
- **Q5 — VF API endpoints.** *Answered:* the "API returns analysis + UNSIGNED tx, never signs/holds keys" rule is fully compatible — all signing stays client-side and rides the existing relayer; minimal set is eligibility(F8) / vault-facts / build-unsigned-tx / simulate, plus build-unsigned add/rotate-signer for recovery. *Judgment call:* exact endpoint contract shape (`{func, auth}` vs source-signed `{xdr}`) and whether to self-host OZ Relayer+Channels behind the same `submit()` interface for parallel deposits.
- **Q6 — Timebox before cut-loss.** *Answered (constraints):* this is stretch/roadmap, on a separate branch, only after MVP+demo(F11)+pitch(F12) are safe; the footgun list (low-S, base64url, ES256-only, CAP-71, SDK youth) is the concrete risk surface to budget against. *Judgment call:* the actual day limit — undetermined by research, set in brainstorm.

---

## Sources

1. [kalepail/passkey-kit (GitHub)](https://github.com/kalepail/passkey-kit) — legacy banner; "demo material only, not audited."
2. [passkey-kit on npm](https://registry.npmjs.org/passkey-kit) — same legacy/recommended banner; v0.12.0 Jan 2026.
3. [kalepail/smart-account-kit (GitHub)](https://github.com/kalepail/smart-account-kit) — recommended SDK; passkey+ed25519+policy, SignerManager, relayerUrl; young repo.
4. [stellar/ecosystem-resources smart-account-kit.md](https://github.com/stellar/ecosystem-resources/blob/main/wallet-integration/smart-account-kit.md) — "recommended solution"; Migration-from-Passkey-Kit (legacy/deprecated).
5. [Stellar Contracts RC v0.7.0 Audit — OpenZeppelin](https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit) — audit of smart_account + ed25519/webauthn verifiers + policies; fixes merged.
6. [Smart Accounts — OpenZeppelin Docs](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) — context rules + signers + policies; AI-agent example.
7. [Context Rules — OpenZeppelin Docs](https://docs.openzeppelin.com/stellar-contracts/accounts/context-rules) — on-chain-derivable rule examples (spending_limit, volume_cap, time_window).
8. [justmert/soropass (GitHub)](https://github.com/justmert/soropass) — passkey-only, ES256, low-S; recover=discovery; multi-device recovery unshipped.
9. [PasskeyModule RFC — Stellar-Wallets-Kit #95](https://github.com/Creit-Tech/Stellar-Wallets-Kit/issues/95) — open RFC to register a passkey module in wallets-kit.
10. [OpenZeppelin Relayer — Stellar channels guide (1.3.x)](https://docs.openzeppelin.com/relayer/1.3.x/guides/stellar-channels-guide) — fee-sponsor model; auth stays with account signers.
11. [stellar-contracts/packages/accounts (GitHub)](https://github.com/OpenZeppelin/stellar-contracts/tree/main/packages/accounts) — canonical account wasm + reusable verifiers.
12. [CAP-0051](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md) — secp256r1 host fn; SEC-1 pubkey, r‖s sig, traps on failure; ES256 equivalence.
13. [soroban_sdk crypto (docs.rs)](https://docs.rs/soroban-sdk/latest/soroban_sdk/crypto/struct.Crypto.html) — `secp256r1_verify` signature.
14. [contract-webauthn-secp256r1 lib.rs (kalepail)](https://github.com/kalepail/soroban-passkey/blob/main/contracts/contract-webauthn-secp256r1/src/lib.rs) — WebAuthn digest + challenge==base64url(payload) check.
15. [Miracle656/veil (GitHub)](https://github.com/Miracle656/veil) — corroborates challenge = Soroban auth-preimage hash.
16. [Discussion #1435 (stellar-protocol)](https://github.com/stellar/stellar-protocol/discussions/1435) — low-S requirement; ~50% Apple high-S rejected.
17. [passkey-kit issue #32](https://github.com/kalepail/passkey-kit/issues/32) — Signatures(Map<SignerKey,Signature>) wire shape (open, unconfirmed).
18. [Discussion #1499 (stellar-protocol)](https://github.com/stellar/stellar-protocol/discussions/1499) — single-signer Signature struct; first-class passkey support since P21.
19. [OZ Authorization Flow](https://docs.openzeppelin.com/stellar-contracts/accounts/authorization-flow) — AuthPayload + context_rule_ids digest binding.
20. [OZ webauthn-verifier (GitHub)](https://github.com/OpenZeppelin/stellar-contracts/blob/main/examples/multisig-smart-account/webauthn-verifier/src/contract.rs) — key_data/sig_data layout; canonicalize_key strips credential-id.
21. [Smart wallets — Stellar Docs](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets) — contract accounts, mixable signers; still lists Passkey Kit (doc lag).
22. [Signers and Verifiers — OpenZeppelin Docs](https://docs.openzeppelin.com/stellar-contracts/accounts/signers-and-verifiers) — add_signer; delegated/external; CAP-71 simulation hazard.
23. [Cheesecake Labs — Passkey-Enabled Smart Wallet on Stellar](https://cheesecakelabs.com/blog/building-a-passkey-enabled-smart-wallet-on-the-stellar-network/) — testnet rotate_signer recovery PoC; centralization flagged.
24. [SoroPass (soropass.dev)](https://soropass.dev/) — "recovery from factory events, no indexer"; never holds funds/keys.
25. [SoroPass SDK docs](https://docs.soropass.dev/docs/sdk) — recover() = discovery via factory events.
26. [Recovery (SEP-30) — Stellar Docs](https://developers.stellar.org/docs/build/apps/wallet/sep30) — 2-of-3 recovery-signer servers; replaceDeviceKey.
27. [Soneso stellar_flutter_sdk smart-accounts onboarding](https://github.com/Soneso/stellar_flutter_sdk/blob/master/documentation/smart-accounts/onboarding.md) — single-signer loss = bricked; backup signers recommended.
28. [stellar/launchtube (GitHub)](https://github.com/stellar/launchtube) — legacy; superseded by OZ Relayer + Channels.
29. [OpenZeppelin Stellar Channels Guide (1.5.x)](https://docs.openzeppelin.com/relayer/1.5.x/guides/stellar-channels-guide) — user signs auth, fund account fee-bumps.
30. [Channels — OpenZeppelin Docs](https://docs.openzeppelin.com/relayer/plugins/channels) — channel-account pool for parallel sequence numbers.
31. [OpenZeppelin/relayer-plugin-channels (GitHub)](https://github.com/OpenZeppelin/relayer-plugin-channels) — channels pipeline.
32. [kalepail/launchtube (GitHub)](https://github.com/kalepail/launchtube) — simulate+sign+submit, no XLM/G-addresses needed.
33. [Signing Soroban contract invocations — Stellar Docs](https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations) — C-accounts authorize via auth entries; G-account is fee-payer source.
34. [Policies — OpenZeppelin Docs](https://docs.openzeppelin.com/stellar-contracts/accounts/policies) — Policy trait enforce()/install(); max 5 policies/rule.
35. [Complex account example — Stellar Docs](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/complex-account) — policy reads spend amount from on-chain args only.
36. [Protocol 21 is Live on Stellar Mainnet](https://stellar.org/blog/developers/protocol-21-is-live-on-stellar-mainnet) — P21 mainnet June 18, 2024.
37. [Stellar Protocol Upgrades index](https://stellar.org/protocol-upgrades) — Protocol 21 = CAP-0051 secp256r1.
38. [stellar-core v21.0.0 release notes](https://github.com/stellar/stellar-core/releases/tag/v21.0.0) — secp256r1 support in Soroban host.
39. [Stellar Passkey Feature on Mainnet (blog)](https://stellar.org/blog/foundation-news/introducing-the-new-stellar-passkey-feature-seamless-web3-smart-wallet-functionality-on-mainnet) — official passkey smart-wallet feature.
40. [brozorec/smart-account-sign (GitHub)](https://github.com/brozorec/smart-account-sign) — testnet demo, two signers (ed25519 + passkey).
41. [Soneso iOS/Mac SDK — Smart Account Kit README](https://github.com/Soneso/stellar-ios-mac-sdk/blob/master/docs/smart-accounts/README.md) — addNewPasskeySigner / addPasskey one-step flow.
42. [Web Passkey Readiness Benchmark 2026 — Corbado](https://www.corbado.com/passkey-benchmark-2026/web-passkey-readiness) — Safari iOS ~100%/~95%; Chrome desktop ~100%/~87–90%.
43. [Passkey Adoption on iOS 2026 — State of Passkeys](https://state-of-passkeys.io/ios) — iOS Safari/Chrome passkey support.
44. [Device Support matrix — passkeys.dev](https://passkeys.dev/device-support/) — synced passkeys Chrome 129+, macOS 13+, iOS 16+.
45. [Chrome passkeys on iCloud Keychain (macOS) — Chrome for Developers](https://developer.chrome.com/blog/passkeys-on-icloud-keychain) — Touch ID via iCloud Keychain since Chrome 118.
46. [WebAuthn API in web extensions — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api) — Firefox 150 / Chrome 122 RP-ID claiming.
47. [Passkeys with Safari Web Extension (NotAllowedError) — Apple Developer Forums](https://developer.apple.com/forums/thread/774351) — Safari extensions unsupported.
48. [Bitwarden clients commit (isChromium only)](https://github.com/bitwarden/clients/commit/6cbdecef43065798e6855d85ce72a9df1416c4bc) — extension passkeys gated to Chromium.
49. [Firefox Bug 1956484 commit](https://github.com/mozilla-firefox/firefox/commit/a8b511c2be77) — extensions claim WebAuthn RP IDs via host permissions (Mar 2026).
50. [Related Origin Requests — web.dev](https://web.dev/articles/webauthn-related-origin-requests) — distinct .well-known/webauthn origin allowlist mechanism.
51. [VF repo `frontend/api/stellar-relay.js` (local)](file:///C:/SharredData/project/competition/vibing-farmer/frontend/api/stellar-relay.js) — VF's existing fee-bump relayer; relay pays XLM only, never authorizes.

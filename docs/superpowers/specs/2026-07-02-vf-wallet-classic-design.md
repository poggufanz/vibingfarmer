# VF Wallet — Classic ed25519 Mode (Design Spec)

> **Status:** Approved 2026-07-02 (brainstorming). Ready for implementation plan.
> **Branch:** continue on `feature/wallet` (or `feature/wallet-classic`).
> **Chain:** Stellar **testnet** only (PoC).
> **Timing:** post-hackathon. Does NOT block the 15 Jul submission (passkey wallet already live).
> **Supersedes/refines:** `planning/wallet-improve.md` — this spec is the modernized, research-validated version of that handoff.

---

## 0. Decision (read first)

VF Wallet today = **Soroban passkey smart account** (`C…` address; secp256r1/WebAuthn Face-ID signer; gasless via relayer; recovery = rotate-signer). This spec adds a **classic ed25519 self-custody wallet** (`G…` address; secret key `S…` / 24-word mnemonic; user pays own gas; recovery = the mnemonic).

**Positioning: classic-only focus.** The new UX is built entirely around the Freighter-style classic wallet ("mirip MetaMask, di Stellar → Freighter"). The live passkey smart-account path **stays in the codebase, untouched, and all its tests stay green**, but it is **not featured** in the new wallet UX. No dual-mode switcher in the primary flow.

Classic mode is architecturally **simpler** than passkey: signing is pure ed25519 JS crypto, so there is **no WebAuthn ceremony** and therefore **no `ceremony.html` tab** for the classic path.

---

## 1. Goal & user stories

A user can:
1. **Create** a classic wallet → 24-word mnemonic (SEP-0005) → ed25519 keypair → see the phrase **once** for backup → secret stored encrypted locally.
2. See their **`G…` address**, **balances**, **token list**, and **portfolio value ($)**.
3. **Send / Receive** Stellar assets — sign locally with the ed25519 key, pay own gas.
4. **Recover / import** an existing wallet from secret key `S…` **or** 24-word mnemonic.
5. See **transaction history** (Horizon).
6. Keep VF's protective edge on the send flow: **clear-signing** (anti-blind-signing) plus **F8 vault risk-gating** when a destination is a known VF vault.

---

## 2. In scope / Out of scope

**In scope:**
- Classic ed25519 wallet: create, import (secret + mnemonic), encrypted local storage, local signing.
- Full-wallet UI: portfolio value, token list + USD, receive (QR), send (any asset), history.
- Lock/unlock + auto-lock.
- Clear-sign confirmation on every send; F8 verdict surfaced when destination ∈ vault catalog.
- Friendbot funding button for unfunded testnet accounts.

**Out of scope (documented upgrade paths, not now):**
- Multichain (BTC/ETH/SOL). Swap/DEX (Soroswap). Hardware wallet, WalletConnect.
- Mainnet. Service-worker/offscreen-document keyring. Argon2-WASM KDF. Shamir/social recovery. SEP-30 recovery server. SEP-10/24 anchor flows.

---

## 3. Modernized stack (2026 research-validated)

The single most load-bearing corrections vs the original `wallet-improve.md` assumptions:

| Original assumption | Corrected decision (current practice) |
|---|---|
| mnemonic lib unspecified / `stellar-hd-wallet` | **`@scure/bip39`** (audited) + SLIP-0010 ed25519 deriver (`micro-key-producer` slip10, or `ed25519-hd-key`) → `Keypair.fromRawEd25519Seed(seed)`. 24 words (SEP-5's own recommendation). Path `m/44'/148'/0'` (all hardened). Avoid the lightly-maintained `stellar-hd-wallet`. |
| "AES-GCM + PBKDF2/scrypt" | **AES-256-GCM + PBKDF2-HMAC-SHA256 @ 600,000 iters** via WebCrypto (zero-dep; exactly MetaMask `browser-passworder`). WebCrypto is PBKDF2-native; scrypt/Argon2 would need WASM (deferred). Do NOT copy the ecosystem's scrypt-2^15 (below OWASP). AES-GCM chosen knowingly ≠ byte-compatible with Freighter's NaCl `secretbox` format (no interop needed). |
| "in-memory keypair only while unlocked" | **MV3-correct key handling** — see §5. Cache the *derived AES vault-key*, not the raw secret, in `chrome.storage.session`. |
| Horizon `/accounts` for balances | ✓ correct for **classic-only** wallet. (RPC is now the recommended real-time API; SAC/`C…` contract balances require RPC `getSACBalance` — not relevant here.) |
| Horizon for history | ✓ the only real source (RPC keeps ~7 days). Note Horizon is legacy/maintenance-mode + SDF public instance caps history at 1 year. Fine for PoC. |
| — (not in original) | **Clear-signing** (decode XDR → human-readable before sign) is a required anti-pattern fix. **Supply-chain** was the #1 wallet-drain vector in 2025 (Trust Wallet ~$8M via leaked Web Store creds) → pin deps, strict CSP, no remote code. |

Already installed & correct: `@stellar/stellar-sdk@^16.0.1` (scoped; `Keypair` API stable across v12→v16; Node 20+ toolchain).

New deps (minimal, **pinned**): `@scure/bip39`, a SLIP-0010 ed25519 deriver, `qrcode`. Encryption is zero-dep (WebCrypto). `@creit.tech/stellar-wallets-kit` (already present) is a dapp-connect kit — not used for the classic key core.

---

## 4. Architecture

**Popup-hosted keyring.** All classic crypto (derive, decrypt, sign) runs in the popup while it is open — appropriate because a wallet user is looking at the popup to send. No background signing, no ceremony tab.

**Service worker (existing `background.js`) classic role = auto-lock only:** a `chrome.alarms` timer that clears the cached vault-key from `chrome.storage.session` on idle timeout. Existing passkey SW routing (SIGN_REQUEST → ceremony tab) is left intact for the untouched passkey path.

**Storage split (MV3):**
- Vault **ciphertext** → `chrome.storage.local` (persists to uninstall; encrypted, so disk-safe).
- Derived **AES vault-key** (JWK, while unlocked) → `chrome.storage.session` (in-memory; cleared on browser close / reload; `setAccessLevel: TRUSTED_CONTEXTS` to exclude content scripts).
- **Never** plaintext secret in `.local` / `localStorage` / IndexedDB.

---

## 5. Security model (non-negotiable)

**Vault crypto** — `vault.js`:
- AES-256-GCM. Key = PBKDF2-HMAC-SHA256(password, salt, 600_000). Fresh **16-byte random salt** + **12-byte random IV per encryption** (`crypto.getRandomValues`; AES-GCM IV reuse is catastrophic).
- Stored blob = `{ version, ciphertext, iv, salt, kdf: {name:'PBKDF2', hash:'SHA-256', iters:600000} }`. `version` enables future KDF migration (e.g. Argon2id).
- Never send secret/mnemonic to any server. VF API stays analysis + unsigned-tx only. Relayer never sees a classic secret.

**MV3 key handling** — `session.js` (MetaMask `cacheEncryptionKey` pattern):
- Unlock: derive AES vault-key from password → cache **the derived key** (not the raw `S…`) in `chrome.storage.session` (`TRUSTED_CONTEXTS`).
- On demand: re-decrypt vault → reconstruct ed25519 secret as a `Uint8Array` → sign → wipe. Popup survives close/reopen within the auto-lock window without re-prompting because the session key persists in memory.
- Lock (manual / alarm / browser close): clear the session key; the raw secret is never persisted to begin with.

**Memory hygiene** — `classicAccount.js` `withSecret(fn)`:
- Secret only ever a `Uint8Array`, **never a `String`**. `buf.fill(0)` in a `try/finally` on every code path incl. errors. Drop the password string ref (`password = ''`) immediately after deriving.
- Accepted residual risk (label honestly, don't over-claim): while unlocked, a key exists in memory and JS cannot guarantee wiping; this only shrinks lifetime/forms, it does not defeat an attacker already running code on the machine.

**Backup show-once** — create flow:
- Interstitial (what a recovery phrase is; VF cannot recover it; never share) → **blur/click-to-reveal** → **subset-confirm** (re-enter e.g. words #3, #7, #11) → skip-with-explicit-warning.
- **No "Copy" button** on the phrase (clipboard is plaintext, malware-readable, hijackable). `spellcheck="false"`, `autocomplete="off"` on phrase + confirm inputs. Never log the phrase; don't inject into DOM before reveal. Surface SEAL "prohibited practices" (no photo / cloud / message / password-manager).

**Import validation** — import flow:
- Mnemonic: validate word count (12/24) + each word against BIP-39 wordlist + **checksum**; loud, prominent error highlighting the bad word (a valid checksum ≠ correct phrase — ~1/256 wrong 24-word phrases pass and silently derive a different wallet). Paste allowed here (opposite of backup), still warn re clipboard.
- Secret key: validate **StrKey** (`S…`, base32, CRC16, length), then **derive and display the `G…` address for confirmation before saving**.

**Lock/unlock UX:**
- Password screen on every unlock. Copy states plainly: "this password unlocks the local vault only in this browser; it is **not** a recovery mechanism — your 24 words are."
- Password floor 12+ chars with a strength meter (don't over-force). **Wrong-password backoff** (rate-limit attempts).
- Auto-lock default **~10 min idle** + on browser close (session already clears) + manual **Lock** button, via `chrome.alarms`, resetting on activity.

**Supply-chain:** pin all deps + commit lockfile, strict MV3 CSP (MV3 already bans remote code), no `eval`, minimize dependency count, protect Chrome Web Store publishing credentials (2FA, rotate, alert on new releases).

**HonestyLabels (reuse `ui/HonestyLabels.jsx`):** "your 24-word phrase is the only recovery — VF cannot restore it"; "testnet-grade PoC, do not use real funds"; **"while unlocked, this wallet holds a key in memory (`chrome.storage.session`) — anyone who can already run code on your machine could read it; lock the wallet when done."** (Note 3 — do not over-claim the session-key posture; it is standard hot-wallet, stated plainly.)

---

## 6. Send flow — clear-sign all + F8 for vaults (the honest differentiator)

Build tx → **clear-sign always** → sign locally → submit (own gas, Horizon/RPC; **not** the relayer).

- **Clear-sign is rich for payments.** `clearSign.js` decodes the payment XDR and shows destination, asset, amount, memo, and fee for explicit confirm. This is the real anti-blind-signing win.
- **Contract invokes are NOT generic-decoded to text.** (Note 1) Human-readable decoding of arbitrary Soroban `invoke` auth entries is hard and error-prone; do not attempt it. Yield deposits go through the **existing deposit flow** (relay-signed, `ApproveOverlay`, F8 gate) — not the generic classic send screen. The classic send screen is for **payments**; the deposit action stays where it is.
- **F8 reuse (honest):** if a send destination ∈ the known vault catalog (`config`), surface the existing `vfapi.eligibility({vault, amount})` verdict via `ApproveOverlay`, including the footgun guard: "this is a vault contract — a plain payment will not deposit; use Deposit." F8 scores **vaults** (ponzi APY, fact staleness), not arbitrary recipients.
- **Claim discipline:** "clear-signing + vault risk-gating," **not** "we risk-scan every recipient." A real recipient scanner (scam-list / Blockaid-style / heuristics) is out of scope — no such data source exists in-repo.

---

## 7. Data, prices, history

- **Balances:** Horizon `GET /accounts/{G}` → `balances[]` (native XLM + trustlines). Amounts as **strings/BigInt, 7 decimals** — never JS floats.
- **Portfolio value / prices** — `prices.js`: CoinGecko `GET /simple/price?ids=stellar&vs_currencies=usd` for XLM/USD; known stablecoins (USDC) pegged ≈ $1; other issued assets **balance-only** (no free USD feed) for the PoC.
  - **(Note 2) CoinGecko-from-extension caveat:** the free tier has rate limits and may hit CORS from a `chrome-extension://` origin. Not a blocker (Freighter also uses an external price API), but **anticipate**: on CORS/limit failure, either **route the price fetch through the VF API gateway** (already scoped, server-side) **or cache the last good price** with a short TTL and degrade to balance-only. Design `prices.js` so the price source is swappable.
- **History** — `history.js`: Horizon `/accounts/{G}/payments` + `/transactions`, cursor-paged, rendered in the existing Activity tab. (Horizon legacy/maintenance + 1-yr cap acknowledged; indexer is a later upgrade.)
- **Funding:** a new `G…` is unfunded → show **"Fund via Friendbot (testnet)"** on home until activated.

---

## 8. Component map (new files, `frontend/src/wallet/`)

| File | Role |
|---|---|
| `classicKeypair.js` | ed25519 keypair + SEP-0005 mnemonic (create/fromSecret/fromMnemonic/generateMnemonic) |
| `vault.js` | AES-256-GCM + PBKDF2-600k encrypted secret store (`chrome.storage.local`) |
| `session.js` | unlock→cache derived AES-key (`chrome.storage.session`, TRUSTED_CONTEXTS); lock/clear; `chrome.alarms` auto-lock |
| `classicAccount.js` | lifecycle: create/import/unlock/lock; `withSecret` (decrypt→sign→wipe); `readBalances`; `signAndSubmit` (own gas) |
| `prices.js` | swappable USD price source + `portfolioValue` |
| `history.js` | Horizon tx/payment history |
| `clearSign.js` | decode **payment** XDR → human-readable confirm object |
| `ui/*` | welcome, create, backup (show-once), import, home (portfolio+tokens+fund), send (clear-sign), receive (QR), history, unlock, settings |

Reused unchanged: `vfapi/client.js` (`eligibility`, `vaultFacts`), `stellar/*` (RPC/Horizon/format), `ui/HonestyLabels.jsx`, `ui/ApproveOverlay.jsx`, extension shell + `background.js` (add one alarm handler).

---

## 9. Testing

**Unit (vitest, fake `chrome.storage`):**
- `classicKeypair`: SEP-0005 **known test vectors** (Stellar-published); invalid `S…` rejected; invalid mnemonic / bad checksum rejected with word index.
- `vault`: encrypt→decrypt round-trip; wrong password throws; assert **no plaintext** persisted (inspect stored blob).
- `session`: unlock caches derived key not raw secret; lock/alarm clears it.
- `classicAccount`: create/import lifecycle; `withSecret` wipes buffer on success **and** on thrown error.
- `clearSign`: payment XDR decodes to expected dest/asset/amount/memo.

**Manual testnet smoke:** create → Friendbot fund → send XLM to another address → confirm on Stellar Expert → reimport from mnemonic on a fresh browser profile → **same `G…` recovered**.

**Regression:** all existing passkey + wallet tests stay green (do not touch the live path).

---

## 10. Acceptance criteria

- [ ] Create classic wallet → `G…` shown, 24-word phrase shown once + subset-confirmed, secret encrypted at rest (no plaintext in storage).
- [ ] Import from secret key AND from mnemonic → same address recovered; StrKey + BIP-39 checksum validated with clear errors.
- [ ] Home shows portfolio value ($) + token list; unfunded account offers Friendbot funding.
- [ ] Send any asset → **clear-signed** (dest/asset/amount/memo shown) → signed locally → submitted → visible on Stellar Expert; user paid own gas.
- [ ] Sending to a known vault surfaces the F8 verdict + "use Deposit" footgun guard.
- [ ] Receive shows QR + copyable `G…`.
- [ ] History shows past transactions from Horizon.
- [ ] Wrong password never decrypts; secret never leaves device; VF API never receives a secret; unlocked-session posture labeled honestly.
- [ ] Auto-lock (idle + close + manual) clears the session key.
- [ ] Existing passkey path + all prior tests still green.

---

## 11. Honesty notes (for agent + pitch)

- Classic mode is **self-custody with a user-held secret** — VF cannot recover it (the Freighter trade-off, stated plainly).
- Classic mode is **not gasless** — it's a plain EOA paying its own XLM fees. Only the passkey path is relayer-sponsored. Both kept; classic is featured.
- Differentiator vs Freighter is **clear-signing on send + F8 vault risk-gating + a gasless passkey mode still available** — not a recipient scanner. Don't ship a plain clone; don't over-claim.
- Testnet PoC until a security audit. Do not enable mainnet in this scope.

---

## 12. Sources (key)

- SEP-0005 (BIP-39 + SLIP-0010 ed25519, `m/44'/148'/x'`): https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
- js-stellar-sdk CHANGELOG (v12→v16, Keypair, RPC rename): https://github.com/stellar/js-stellar-sdk/blob/master/CHANGELOG.md
- `@scure/bip39` (audited): https://github.com/paulmillr/scure-bip39
- OWASP Password Storage (Argon2id / scrypt 2^17 / PBKDF2 ≥600k): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- MetaMask `browser-passworder` (PBKDF2 + AES-GCM) + PR #17950 (session-cached key): https://github.com/MetaMask/browser-passworder
- Chrome `chrome.storage` (session/local, limits, `setAccessLevel`): https://developer.chrome.com/docs/extensions/reference/api/storage
- Least Authority — MV2→MV3 security (session storage as sanctioned answer): https://leastauthority.com/blog/manifest-v2-to-v3-challenges-and-security-considerations/
- Stellar APIs overview (RPC recommended; Horizon legacy/1-yr cap): https://developers.stellar.org/docs/data/apis
- Freighter (non-custodial, local encrypted keys, Blockaid): https://www.freighter.app/
- Trust Wallet extension breach 2025 (supply-chain): https://thehackernews.com/2025/12/trust-wallet-chrome-extension-bug.html
- SlowMist — clipboard risks: https://slowmist.medium.com/beginners-guide-to-web3-security-clipboard-risks-77e5b23c4fe1

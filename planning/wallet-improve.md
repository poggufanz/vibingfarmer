# VF Wallet → Freighter-tier (Classic Keypair Mode) — Scope for AI Agent

> **Handoff doc.** Evolve VF Wallet from passkey-only smart account into a full Stellar wallet
> that ALSO supports a classic ed25519 keypair mode (Freighter-style: secret key + G-address + recovery).
> **Branch:** continue on `feature/wallet` (or `feature/wallet-classic`). **Chain:** Stellar testnet.
> **Timing note:** post-hackathon work. Does NOT block the 15 Jul submission (passkey wallet already live).

---

## 0. Architecture decision (READ FIRST)

VF Wallet currently = **Soroban smart account** (address `C...`, signers: passkey/agent/recovery,
recovery via rotate-signer). Freighter = **classic keypair** (address `G...`, secret key `S...` /
mnemonic, recovery via secret key). These are DIFFERENT wallet types.

**Decision: add a second wallet MODE — "Classic" — alongside the existing "Passkey" mode.**
Do NOT remove or refactor the passkey smart-account path (it is live/proven). Classic mode is additive.

| | Passkey mode (EXISTING) | Classic mode (NEW — this scope) |
|---|---|---|
| Address | `C...` (contract) | `G...` (keypair) |
| Signer | secp256r1 WebAuthn (Face ID) | ed25519 keypair |
| Backup/Recovery | rotate-signer (VF-custodied recovery) | **secret key `S...` / 24-word mnemonic (SEP-0005)** |
| Gas | gasless (relayer) | user pays own gas (classic EOA) |
| Feels like | "login with Face ID" | "Freighter / MetaMask" |

User picks mode at wallet creation. Both modes share the same UI shell (home/send/receive/history).

---

## 1. Goal

A user can:
1. **Create a classic wallet** → generate ed25519 keypair (or 24-word mnemonic), see the secret
   **once** for backup, wallet stored encrypted locally.
2. See their **G-address** + **balance** + **token list** + **portfolio value ($)**.
3. **Send / Receive** any Stellar asset (sign locally with the ed25519 key).
4. **Recover** an existing wallet by importing secret key `S...` or mnemonic.
5. See **transaction history** (from Horizon).
6. Still use VF's protective features (F8 scan-before-send, deposit to vault) — classic mode pays own gas.

---

## 2. In scope / Out of scope

**In scope:**
- Classic ed25519 wallet: create, import (secret key + mnemonic), encrypted local storage, sign locally.
- Full-wallet UI: portfolio value, token list w/ balances + USD, receive (QR), send (any asset), history.
- Mode switcher (Passkey ↔ Classic) at create + in account menu.
- F8 "scan before send" hook on the send flow (reuse existing eligibility/risk engine).

**Out of scope (later / not now):**
- Multi-chain (BTC/ETH/SOL) — that's ICP chain-fusion, different stack. Stellar-only here.
- Swap / DEX integration (Soroswap) — separate scope.
- Hardware wallet, WalletConnect.
- Mainnet. Testnet PoC only.

---

## 3. Security requirements (NON-NEGOTIABLE — classic mode handles secrets)

Adding a classic keypair reintroduces secret management. The agent MUST:

1. **Encrypt secret at rest.** Never store `S...` / mnemonic in plaintext. Encrypt with a
   user-set password (WebCrypto AES-GCM + PBKDF2/scrypt KDF). Store only ciphertext in
   `chrome.storage.local` / IndexedDB.
2. **Never send secret to any server.** Signing happens locally in the extension. VF API stays
   analysis + unsigned-tx only (existing rule). The relayer never sees a secret.
3. **Show-once backup.** Display the mnemonic/secret exactly once at creation, force the user to
   confirm they saved it (re-enter 2–3 words), then never show again without password.
4. **Clear warnings** (HonestyLabels): "your secret is the only recovery — VF cannot restore it",
   "testnet-grade PoC, do not use real funds".
5. **Standards:** ed25519 via `@stellar/stellar-sdk` `Keypair`; mnemonic via **SEP-0005**
   (BIP-39 + ed25519 derivation `m/44'/148'/0'`). Use a vetted lib, do NOT hand-roll crypto.
6. **Lock/unlock:** wallet auto-locks; password required to unlock/sign.

---

## 4. Tasks (ordered, each testable)

### T1 — `wallet/classicKeypair.js` (core, TDD)
- `createKeypair()` → `{ publicKey (G...), secret (S...) }` (ed25519, stellar-sdk `Keypair.random()`).
- `fromMnemonic(mnemonic, index=0)` → Keypair (SEP-0005 derivation).
- `fromSecret(secret)` → Keypair (validate `S...`).
- `generateMnemonic()` → 24 words (BIP-39).
- Unit tests: known SEP-0005 test vectors (Stellar publishes them), invalid secret rejected.

### T2 — `wallet/vault.js` (encrypted local store, TDD)
- `encryptSecret(secret, password)` → ciphertext (AES-GCM + KDF salt/iv).
- `decryptSecret(ciphertext, password)` → secret (throws on wrong password).
- `saveWallet({label, publicKey, ciphertext})` / `loadWallets()` / `removeWallet()` →
  `chrome.storage.local`.
- Unit tests: round-trip encrypt/decrypt, wrong password fails, no plaintext persisted.

### T3 — `wallet/classicAccount.js` (lifecycle)
- `createClassicWallet({label, password})` → generate mnemonic → keypair → encrypt → save →
  return `{ publicKey, mnemonic }` (mnemonic shown once by UI).
- `importFromSecret({secret, password, label})` / `importFromMnemonic({...})`.
- `unlock(password)` / `lock()`; in-memory keypair only while unlocked.
- `readBalances(publicKey)` → all Stellar assets + amounts (Horizon `/accounts`).
- `signAndSubmit(tx, password)` → decrypt → sign with ed25519 → submit via RPC/Horizon
  (classic mode pays own gas; NOT the relayer).

### T4 — Portfolio + token list data
- `wallet/prices.js` — fetch USD price per asset (reuse whatever price source F8/vaultFacts uses,
  or a simple price API). `portfolioValue(balances)` → total $.
- Token list = balances + per-asset USD + total card.

### T5 — Send flow with F8 scan-before-send
- `sendAsset({from, to, asset, amount, password})` → build tx → **run F8/risk check on `to`
  address first** → if flagged, warn + require explicit confirm → sign locally → submit.
- Reuse existing eligibility/risk engine (`vfapi/client.js` / `strategy/*`). This is the
  differentiator: Freighter doesn't scan; VF does.

### T6 — Transaction history
- `wallet/history.js` — fetch from Horizon `/accounts/{G}/transactions` + `/payments`, render
  in the existing Activity tab.

### T7 — Receive
- QR of the G-address (any QR lib already bundled, else add one pinned) + copy button.

### T8 — UI: mode switcher + screens
- Welcome: "Create Passkey wallet (Face ID)" OR "Create Classic wallet (secret key)".
- Classic create: password set → show 24-word mnemonic (show-once + confirm) → done.
- Classic import: paste secret `S...` or mnemonic + set password.
- Home: portfolio value card, token list, address+copy, receive/send buttons (match Fradium/Freighter layout).
- Account menu: switch wallet, lock, export (password-gated, show-once), settings.
- Reuse `ui/HonestyLabels.jsx` for the secret-backup + testnet warnings.

### T9 — Tests + smoke
- Unit: T1/T2 crypto vectors, T3 lifecycle (fake storage).
- Manual testnet smoke: create classic wallet → Friendbot fund → send XLM to another address →
  confirm on Stellar Expert → reimport from mnemonic on a fresh profile → same address recovered.
- Keep existing passkey wallet tests green (do not break the live path).

---

## 5. Component map (new files)

| File | Role |
|------|------|
| `frontend/src/wallet/classicKeypair.js` | ed25519 keypair + SEP-0005 mnemonic derivation |
| `frontend/src/wallet/vault.js` | AES-GCM encrypted secret store (chrome.storage.local) |
| `frontend/src/wallet/classicAccount.js` | Classic wallet lifecycle: create/import/unlock/sign/submit/balances |
| `frontend/src/wallet/prices.js` | USD prices + portfolio value |
| `frontend/src/wallet/history.js` | Horizon tx/payment history |
| `frontend/src/wallet/ui/*` | mode switcher, create/import/backup screens, portfolio+token list |
| (reuse) `vfapi/client.js`, `strategy/*` | F8 scan-before-send |
| (reuse) `stellar/*` | Horizon/RPC clients, format, scval |

---

## 6. Acceptance criteria

- [ ] Create classic wallet → G-address shown, mnemonic shown once + confirmed, secret encrypted at rest (no plaintext in storage).
- [ ] Import from secret key AND from mnemonic → same address recovered.
- [ ] Home shows portfolio value ($) + token list with balances.
- [ ] Send any asset → signed locally, submitted, visible on Stellar Expert; user paid own gas.
- [ ] Send flow runs F8/risk scan on destination and warns on flagged address.
- [ ] Receive shows QR + copyable G-address.
- [ ] History shows past transactions from Horizon.
- [ ] Wrong password never decrypts; secret never leaves device; VF API never receives a secret.
- [ ] Existing passkey wallet path still works + all prior tests green.

---

## 7. Honest notes (for the agent + pitch)

- Classic mode is **self-custody with user-held secret** — VF cannot recover it. This is the
  Freighter trade-off, stated plainly to the user.
- Classic mode is **not gasless** (it's a plain EOA). Only the passkey smart-account path is
  relayer-sponsored. Keep both; let the user choose.
- Differentiator vs Freighter/Fradium: **scan-before-send (F8) + optional yield deposit from the
  wallet + a gasless passkey mode**. Don't ship a plain clone — keep the protective edge.
- Testnet PoC only until a security audit. Do not enable mainnet in this scope.
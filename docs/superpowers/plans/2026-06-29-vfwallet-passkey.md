# VF Wallet (Passkey Smart-Wallet Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chromium-extension passkey (Face ID) smart wallet for Vibing Farmer on Stellar testnet — create → Face ID → send/receive → sign a VF deposit — built on OZ `smart-account-kit`, composing the user's passkey + VF's ed25519 agent + a scoped recovery signer on **one** account, reusing VF's existing fee-bump relayer and deposit pipeline.

**Architecture:** A new MV3 extension (`frontend/extension/`) hosts a popup UI and a dedicated **ceremony tab** (WebAuthn must run outside the popup, which the OS prompt closes). Wallet logic lives in `frontend/src/wallet/` (passkey crypto + SAK wrapper) and `frontend/src/vfapi/` (thin client over VF's existing F8 eligibility + vault-facts + build/simulate/relay). The audited OZ webauthn-verifier handles on-chain secp256r1 verification; only the client-side signature shape (DER→r‖s), WebAuthn challenge-binding, and low-S normalization are new. VF's `frontend/src/stellar/*` (relay, agent deposit, session key, events, scval, config) is reused unchanged.

**Tech Stack:** JavaScript (ESM), React 18 + Vite 5, Vitest, Chrome MV3 extension, `smart-account-kit` + `smart-account-kit-bindings`, `@stellar/stellar-sdk` (already 16.x), `@simplewebauthn/browser` (via SAK), OZ Stellar Contracts (smart_account + webauthn-verifier + ed25519-verifier wasm), `stellar` CLI (WSL) for testnet deploys.

---

## 0. Research re-validation checkpoint (READ BEFORE M0)

This plan was re-validated against **live sources on 2026-06-29** (the SDK is young/single-maintainer, so versions drift). The spec's assumed `account.js` API (`addSigner`/`rotateSigner`/`readBalance`) **does not match the live SDK** and has been corrected below.

**Re-verify these pins at the start of Task 0** (`pnpm view <pkg> version`, repo README) — if any moved, reconcile the affected task before coding:

| Dependency | Pinned version (validated 2026-06-29) | Notes |
|---|---|---|
| `smart-account-kit` | **0.2.10** (published 2026-03-03, latest) | Frozen since March — single maintainer, possibly paused. Pin exact. |
| `smart-account-kit-bindings` | **0.1.2** (SAK dep) | Contract client bindings — **the deployed account/verifier wasm must match the OZ contract version these bindings target**, not blindly "latest OZ". |
| OZ `stellar-contracts` | **v0.7.2** (2026-06-09); audit baseline **v0.7.0** | Source of `smart_account`, `webauthn-verifier`, `ed25519-verifier` wasm. |
| `@stellar/stellar-sdk` | VF has **^16.0.1** ✓ (SAK floor `>=14.6.0`) | **No upgrade needed.** |
| `@creit.tech/stellar-wallets-kit` | VF has **^2.3.0** ✓ (SAK peerDep `>=2.0.0`) | Watch: confirm exact peer scope string (`@creit.tech` vs `@creit-tech`) on install; VF already provides `@creit.tech`. |
| `@simplewebauthn/browser` | **^13.2.2** (SAK dep, transitive) | Used by SAK; we may call `navigator.credentials` directly in the ceremony tab — see Task 4. |

**Live API surface (v0.2.10) — authoritative for this plan:**
- `kit.createWallet(appName, userName, options?)` → `{ contractId, credentialId }`; `options` includes `autoSubmit` (deploy), `autoFund` (Friendbot, testnet).
- `kit.connectWallet(options?)` — `options`: `{ prompt }`, `{ fresh }`, `{ credentialId }`, `{ contractId }`. No-arg = silent restore from session.
- `kit.authenticatePasskey()` — passkey auth without connecting. `kit.disconnect()` — clears session only.
- `kit.fundWallet(nativeTokenContract)` — Friendbot fund (testnet).
- `kit.signers` (`SignerManager`): `addPasskey(contextRuleId, appName, userName, options?)`, `addDelegated(contextRuleId, address)`, `remove(contextRuleId, signer)`.
- `kit.rules` (`ContextRuleManager`): `get(id)` (direct contract read), `list()` / `getAll(type)` (**indexer-backed**), `remove(id)`, `updateName(id, name)`; context-rule builder helpers exported (e.g. `createCreateContractContext`).
- `kit.externalSigners` (`ExternalSignerManager`) — G-address signers (recovery path).
- `kit.policies.add(contextRuleId, policyAddress, installParams)` — policy signers.
- `kit.multiSigners` (`MultiSignerManager`) + `buildSelectedSigners()` + `resolveContextRuleIds`.
- `kit.credentials` — pending-credential lifecycle: `create`/`save`/`deploy`/`sync`/`delete`.
- `kit.wallet` — raw contract client for unwrapped methods: `upgrade`, `batch_add_signer`, `get_signer_id`, `get_policy_id`, `get_context_rules_count`.
- `kit.indexer` (`IndexerClient | null`), `DEFAULT_INDEXER_URLS`, `IndexerClient.forNetwork(passphrase)`; `getContractDetailsFromIndexer(contractId)`, `discoverContractsByCredential(credentialId)`, `discoverContractsByAddress(address)`.
- Config (required): `rpcUrl`, `networkPassphrase`, `accountWasmHash`, `webauthnVerifierAddress`; (optional): `rpId`, `rpName`, `relayerUrl`.
- Returns `{ tx }` for invokeHostFunction flows, `{ xdr }` for signed/deploy flows → maps to VF's "assemble XDR, relayer submits" pattern.

**Two non-obvious dependencies the spec did not surface (both validated above):**
1. **Indexer.** SAK relies on a hosted indexer for credential→contract discovery and active-rule listing. The happy reconnect uses the **session-cached `contractId`** (no indexer). Cold/cross-device discovery (M5 recovery, fresh login on a new device) **requires** the indexer. → Persist `contractId` locally; treat the default hosted indexer as a demo-time external dependency to smoke-test; never put it on the M1–M3 critical path.
2. **Self-deployed wasm.** `accountWasmHash` + `webauthnVerifierAddress` are placeholders in the SDK README → **Task 6 deploys/installs them on testnet** from the OZ contract version matching bindings `0.1.2`, and records them in `deployments/stellar-testnet.json` + `frontend/src/wallet/config.js`.

---

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec.

- **Chain:** single-chain **Stellar/Soroban testnet** only. Network passphrase `Test SDF Network ; September 2015`; RPC `https://soroban-testnet.stellar.org`. Reuse `frontend/src/stellar/config.js`.
- **Decimals:** token base unit is **1e7** (7-dp). Reuse `BASE_UNIT` / `toDisplay` / `toBaseUnits` from `frontend/src/stellar/format.js`. Never hardcode 1e6.
- **Non-custodial line (hard rule):** the VF API returns **analysis + UNSIGNED transactions only**. It never receives a secret/seed, never signs for the user, never stores credentials. Signing happens on-device (passkey); VF's existing relayer fee-bumps + submits only.
- **Relayer:** reuse `frontend/src/stellar/relay.js` `submitViaRelay({ xdr })` → `/api/stellar-relay`. The relayer **sponsors the XLM fee only, never authorizes**. Do NOT adopt Launchtube. The recovery signer must be a **distinct** VF-held G-address, not the relayer key.
- **Platform:** real Chromium extension (MV3), **Chrome 122+**. Exclude Safari web extensions (`NotAllowedError`). Firefox 150+ is later, out of scope.
- **WebAuthn:** ES256-only (COSE alg −7); RP-ID claimed via `host_permissions`; the ceremony runs in an extension-owned **tab**, not the popup; the RP server (VF API) allowlists the `chrome-extension://<id>` origin.
- **Crypto:** mandatory client-side **low-S normalization** (~50% of Apple authenticators emit high-S; the host rejects high-S). Never normalize in the relay. Challenge MUST equal `base64url(sha256(authPreimage))` (unpadded, 43 chars for a 32-byte hash).
- **Do not re-audit OZ verifiers.** The audited guarantee is at the OZ **contract** layer, not the TS SDK. Keep the option of calling OZ contracts directly via `kit.wallet`.
- **Baseline:** keep the current **325 frontend vitest tests green** (post-F5) and add to them. Pin all new dependency versions exactly (see §0).
- **What this spec does NOT change:** VF's 1e7 decimals, the `agent_account` ed25519 signing pipeline, the fee-bump relayer trust model, the Blend-USDC vault, the 325-test baseline. The passkey layer is **additive**.
- **Honesty labels (per "prove claims in code"):** F8 is app-layer (not on-chain); recovery key is VF-custodied (centralization trade-off); everything is testnet-grade; passkey-on-Stellar is mainnet-live at the protocol layer (P21) but these wallet contracts are testnet PoC-grade.
- **Project rule:** `planning/` and `docs/superpowers/` are git-ignored locally but **not actually gitignored in this repo** — never `git add -A`. Stage only the real source/test files each task names.

---

## File Structure

**New — extension shell (`frontend/extension/`):**
- `manifest.json` — MV3 manifest; `host_permissions` for RP-ID claiming + VF API origin; background SW; popup; web-accessible ceremony page.
- `background.js` — service worker: session/connection state, message bus between popup ↔ ceremony tab.
- `popup.html` + `popup.jsx` — popup host mounting the React UI.
- `ceremony.html` + `ceremony.js` — the ceremony tab: runs `navigator.credentials.create/get`, returns the assertion to the SW.
- `vite.config.extension.js` — second Vite build target emitting the unpacked extension to `frontend/extension-dist/`.

**New — wallet core (`frontend/src/wallet/`):**
- `config.js` — SAK config object (rpc, passphrase, `accountWasmHash`, `webauthnVerifierAddress`, `rpId`, `rpName`, `relayerUrl`, indexer toggle). Reads `frontend/src/stellar/config.js` for shared values.
- `passkey.js` — **security-critical, fully unit-tested.** `derToRaw(der)`, `normalizeLowS(rawSig)`, `buildChallenge(authPreimage)`, `runCeremony({ kind, challenge, ... })` (drives the ceremony tab), `assembleSecp256r1Entry(...)`.
- `account.js` — SAK wrapper: `makeKit()`, `createPasskeyWallet({ appName, userName })`, `connectPasskeyWallet({ contractId?, credentialId? })`, `readBalance(contractId)`, `addRecoverySigner(...)`, `addAgentSigner(...)`, `rotatePasskey(...)`. **Note the name `connectPasskeyWallet`** — do NOT collide with VF's existing `connectWallet` in `frontend/src/stellar/walletKit.js` (Freighter EOA connect).
- `recovery.js` — recovery context-rule construction + the signer-management-only binding (§4).
- `ui/` — design screens + the **Approve = verdict-first** overlay (ports design HTML).

**New — VF API thin client (`frontend/src/vfapi/`):**
- `client.js` — `eligibility({ vault, amount })`, `vaultFacts()`, `buildUnsignedTx({ kind, params })`, `simulate(xdr)`, `submit(xdr)`. Wraps existing F8 modules + relay; adds the `build-tx` assembly.

**Reused unchanged (`frontend/src/stellar/` + `frontend/src/strategy/`):**
- `stellar/relay.js` — `submitViaRelay({ xdr })`, `getRelayerAddress()`.
- `stellar/agentDeposit.js` — `signAgentDepositEntries(...)`, `buildAgentDeposit(...)`, `runAgentDeposit(...)`, `readVaultShares(...)`, `readTokenBalance(...)`.
- `stellar/sessionKey.js` — `newSessionKey(secret)`.
- `stellar/client.js` — `rpcServer()`, `readContract(...)`, `buildInvokeTx(...)`, `submitUserTx(...)`, `horizonNativeBalance(...)`.
- `stellar/scval.js`, `stellar/events.js` (`pollEvents`), `stellar/format.js`, `stellar/config.js`.
- `strategy/eligibilityGate.js` — `evaluate(input, nowMs)`, `mintToken(...)`, `verifyToken(...)` + constants. `strategy/vaultFacts.js` — `resolve(protocol)`. `strategy/vaultFactsSnapshot.js`, `strategy/eligibilitySentence.js`.

**Modified:**
- `deployments/stellar-testnet.json` — add `smartAccount` block (wasm hash, verifier address, indexer url).
- `frontend/package.json` — add pinned `smart-account-kit` (+ transitive bindings).

---

## Milestone → Task map

| Milestone (spec §6) | Tasks | Gate |
|---|---|---|
| Prep | 0 | — |
| **M0a** | 1–5 | ceremony completes in extension tab |
| infra | 6 | wasm/verifier deployed |
| **M0b (GATE)** | 7–8 | passkey auth-entry passes `__check_auth` → else **CUT TO B** |
| M1 | 7 (connect/balance) | — |
| M2 | 9–10 | — |
| **M3 (HERO)** | 11–12 | deposit → shares minted on-chain |
| **M4 (THESIS GATE)** | 13 | agent co-signer autonomous deposit → else **ship M1–M3 as B** |
| M5 | 14 | recovery rotate + on-chain negative |
| M6 | 15 | packaging + polish |

---

## Task 0: Re-validate pins, add deps, scaffold extension build

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/extension/vite.config.extension.js`
- Create: `frontend/extension/manifest.json`
- Create: `frontend/src/wallet/.keep`, `frontend/src/vfapi/.keep`

**Interfaces:**
- Produces: pinned `smart-account-kit@0.2.10` installed; an extension build command `npm run build:ext`; empty `wallet/` + `vfapi/` dirs.

- [ ] **Step 1: Re-verify the §0 pins are still current**

Run: `cd frontend && npm view smart-account-kit version && npm view smart-account-kit dist-tags --json && npm view smart-account-kit-bindings version`
Expected: `0.2.10` (or newer). If newer, open the live README (`https://github.com/kalepail/smart-account-kit`) and reconcile any signature changes into Tasks 4/7/13/14 before continuing. Record the observed version in this task's commit message.

- [ ] **Step 2: Install the SDK pinned**

Run: `cd frontend && npm install --save-exact smart-account-kit@0.2.10`
Expected: installs; note any peer-dependency warning for `stellar-wallets-kit` and confirm VF's `@creit.tech/stellar-wallets-kit@^2.3.0` satisfies it. If npm reports an **unmet** peer with a different scope (`@creit-tech` vs `@creit.tech`), document it here — it is a known SDK quirk, not a blocker (the kit is present).

- [ ] **Step 3: Add the extension build target**

Create `frontend/extension/vite.config.extension.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Second build target: emits the unpacked MV3 extension.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: resolve(__dirname, '../extension-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        ceremony: resolve(__dirname, 'ceremony.html'),
        background: resolve(__dirname, 'background.js'),
      },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
})
```

Add to `frontend/package.json` scripts: `"build:ext": "vite build -c extension/vite.config.extension.js"`.

- [ ] **Step 4: Minimal MV3 manifest (RP-ID via host_permissions)**

Create `frontend/extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "VF Wallet",
  "version": "0.1.0",
  "minimum_chrome_version": "122",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "host_permissions": ["https://<VF_API_HOST>/*"],
  "web_accessible_resources": [
    { "resources": ["ceremony.html", "ceremony.js"], "matches": ["<all_urls>"] }
  ],
  "permissions": ["storage", "tabs"]
}
```

Replace `<VF_API_HOST>` with the deployed VF API origin (the RP-ID host). `host_permissions` is the Chrome 122+ mechanism that lets the extension claim that RP-ID.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/extension/vite.config.extension.js frontend/extension/manifest.json frontend/src/wallet/.keep frontend/src/vfapi/.keep
git commit -m "chore: add pinned smart-account-kit + MV3 extension build scaffold"
```

---

## Task 1: Wallet config object

**Files:**
- Create: `frontend/src/wallet/config.js`
- Test: `frontend/src/wallet/config.test.js`

**Interfaces:**
- Consumes: `NETWORK_PASSPHRASE`, `SOROBAN_RPC_URL`, `RELAY_PROXY_URL` from `frontend/src/stellar/config.js`.
- Produces: `WALLET_CONFIG` object + `makeWalletConfig(overrides)`; constants `RP_ID`, `RP_NAME`. `accountWasmHash` + `webauthnVerifierAddress` start as `null` (filled by Task 6).

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/wallet/config.test.js
import { describe, it, expect } from 'vitest'
import { makeWalletConfig, RP_ID } from './config.js'

describe('wallet config', () => {
  it('inherits VF testnet network + relay path, never invents its own', () => {
    const c = makeWalletConfig()
    expect(c.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(c.rpcUrl).toBe('https://soroban-testnet.stellar.org')
    expect(c.relayerUrl).toBe('/api/stellar-relay')
    expect(c.rpId).toBe(RP_ID)
  })
  it('exposes wasm/verifier slots that must be set before use', () => {
    const c = makeWalletConfig()
    expect('accountWasmHash' in c).toBe(true)
    expect('webauthnVerifierAddress' in c).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/config.test.js`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/wallet/config.js
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, RELAY_PROXY_URL } from '../stellar/config.js'

// RP-ID is the host the extension claims via host_permissions (Task 0 manifest).
export const RP_ID = import.meta.env?.VITE_VF_RP_ID ?? 'localhost'
export const RP_NAME = 'Vibing Farmer'

// accountWasmHash + webauthnVerifierAddress are filled in by Task 6 (self-deployed on testnet).
export function makeWalletConfig(overrides = {}) {
  return {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    relayerUrl: RELAY_PROXY_URL,
    rpId: RP_ID,
    rpName: RP_NAME,
    accountWasmHash: null,
    webauthnVerifierAddress: null,
    ...overrides,
  }
}

export const WALLET_CONFIG = makeWalletConfig()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/config.js frontend/src/wallet/config.test.js
git commit -m "feat: wallet config inheriting VF testnet network + relay path"
```

---

## Task 2: passkey.js — DER→r‖s + low-S normalization (security-critical, TDD)

**Files:**
- Create: `frontend/src/wallet/passkey.js`
- Test: `frontend/src/wallet/passkey.test.js`

**Interfaces:**
- Produces: `derToRaw(derBytes: Uint8Array): Uint8Array` (64-byte r‖s), `normalizeLowS(raw: Uint8Array): Uint8Array`. Used by Task 4 ceremony assembly and Task 8 on-chain signing.

**Why this task is isolated:** ~50% of Apple authenticators emit high-S signatures that the Soroban host rejects. This is the single most failure-prone line in the spike and gets its own test cycle with known vectors.

- [ ] **Step 1: Write the failing test (known-vector low-S normalization)**

```js
// frontend/src/wallet/passkey.test.js
import { describe, it, expect } from 'vitest'
import { derToRaw, normalizeLowS } from './passkey.js'

// secp256r1 curve order n:
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = N >> 1n

function sToBig(raw) {
  return BigInt('0x' + Buffer.from(raw.slice(32, 64)).toString('hex'))
}

describe('passkey signature normalization', () => {
  it('derToRaw extracts 64-byte r||s from a DER ECDSA signature', () => {
    // DER: 30 44 02 20 <32B r> 02 20 <32B s>
    const r = new Uint8Array(32).fill(0x11)
    const s = new Uint8Array(32).fill(0x22)
    const der = Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s])
    const raw = derToRaw(der)
    expect(raw.length).toBe(64)
    expect(Buffer.from(raw.slice(0, 32)).toString('hex')).toBe('11'.repeat(32))
    expect(Buffer.from(raw.slice(32)).toString('hex')).toBe('22'.repeat(32))
  })

  it('normalizeLowS flips a high-S signature to n - s', () => {
    const r = new Uint8Array(32).fill(0x01)
    const highS = BigInt('0x' + (N - 5n).toString(16).padStart(64, '0'))
    const sBytes = Uint8Array.from(Buffer.from(highS.toString(16).padStart(64, '0'), 'hex'))
    const raw = Uint8Array.from([...r, ...sBytes])
    const out = normalizeLowS(raw)
    expect(sToBig(out)).toBe(5n) // n - (n-5) = 5, which is <= n/2
    expect(sToBig(out) <= HALF_N).toBe(true)
  })

  it('normalizeLowS leaves an already-low-S signature untouched', () => {
    const r = new Uint8Array(32).fill(0x01)
    const lowS = Uint8Array.from(Buffer.from((7n).toString(16).padStart(64, '0'), 'hex'))
    const raw = Uint8Array.from([...r, ...lowS])
    const out = normalizeLowS(raw)
    expect(sToBig(out)).toBe(7n)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: FAIL — `Cannot find module './passkey.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/wallet/passkey.js
// secp256r1 (P-256) curve order.
const SECP256R1_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = SECP256R1_N >> 1n

function bytesToBig(b) {
  return BigInt('0x' + Buffer.from(b).toString('hex'))
}
function bigTo32(n) {
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'))
}

// DER ECDSA (SEQUENCE{ INTEGER r, INTEGER s }) → 64-byte r||s. Strips leading
// 0x00 sign-padding and left-pads each integer back to 32 bytes.
export function derToRaw(der) {
  let i = 0
  if (der[i++] !== 0x30) throw new Error('bad DER: no SEQUENCE')
  i++ // total length
  if (der[i++] !== 0x02) throw new Error('bad DER: no r INTEGER')
  let rLen = der[i++]
  let r = der.slice(i, i + rLen); i += rLen
  if (der[i++] !== 0x02) throw new Error('bad DER: no s INTEGER')
  let sLen = der[i++]
  let s = der.slice(i, i + sLen)
  const pad = (x) => {
    while (x.length > 32 && x[0] === 0x00) x = x.slice(1)
    const out = new Uint8Array(32)
    out.set(x, 32 - x.length)
    return out
  }
  const raw = new Uint8Array(64)
  raw.set(pad(r), 0)
  raw.set(pad(s), 32)
  return raw
}

// Soroban / OZ webauthn-verifier requires low-S: if s > n/2, replace with n - s.
export function normalizeLowS(raw) {
  const r = raw.slice(0, 32)
  let s = bytesToBig(raw.slice(32, 64))
  if (s > HALF_N) s = SECP256R1_N - s
  const out = new Uint8Array(64)
  out.set(r, 0)
  out.set(bigTo32(s), 32)
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/passkey.js frontend/src/wallet/passkey.test.js
git commit -m "feat: passkey DER->raw + mandatory low-S normalization with known vectors"
```

---

## Task 3: passkey.js — WebAuthn challenge-binding to the Soroban auth-preimage (TDD)

**Files:**
- Modify: `frontend/src/wallet/passkey.js`
- Test: `frontend/src/wallet/passkey.test.js` (add cases)

**Interfaces:**
- Consumes: `derToRaw`, `normalizeLowS` (Task 2).
- Produces: `buildChallenge(authPreimageHash: Uint8Array): string` — returns `base64url(sha256(...))` as an **unpadded 43-char** string for a 32-byte input; `assertChallengeMatches(clientDataJSON, expectedChallenge): void` (throws on mismatch).

- [ ] **Step 1: Write the failing test**

```js
// add to frontend/src/wallet/passkey.test.js
import { buildChallenge, assertChallengeMatches } from './passkey.js'
import { createHash } from 'crypto'

describe('passkey challenge binding', () => {
  it('challenge == base64url(sha256(preimage)), unpadded, 43 chars for 32B', () => {
    const preimage = Uint8Array.from(createHash('sha256').update('vf-auth-entry').digest())
    const ch = buildChallenge(preimage)
    expect(ch).not.toMatch(/[=]/)         // unpadded
    expect(ch).not.toMatch(/[+/]/)        // url-safe alphabet
    expect(ch.length).toBe(43)            // sha256 → 32B → 43 base64url chars
  })

  it('assertChallengeMatches throws when clientDataJSON challenge != expected', () => {
    const preimage = Uint8Array.from(createHash('sha256').update('x').digest())
    const expected = buildChallenge(preimage)
    const goodClientData = JSON.stringify({ type: 'webauthn.get', challenge: expected, origin: 'chrome-extension://abc' })
    const badClientData = JSON.stringify({ type: 'webauthn.get', challenge: 'tampered', origin: 'chrome-extension://abc' })
    expect(() => assertChallengeMatches(goodClientData, expected)).not.toThrow()
    expect(() => assertChallengeMatches(badClientData, expected)).toThrow(/challenge mismatch/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: FAIL — `buildChallenge is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to frontend/src/wallet/passkey.js
function base64urlNoPad(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(bytes) {
  // Browser path: crypto.subtle. The hash IS the challenge input — the OZ
  // webauthn-verifier checks the assertion was made over sha256(authPreimage).
  if (globalThis.crypto?.subtle) {
    const d = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return new Uint8Array(d)
  }
  // Node/test path:
  const { createHash } = await import('crypto')
  return Uint8Array.from(createHash('sha256').update(Buffer.from(bytes)).digest())
}

// Caller passes the 32-byte HashIdPreimage::SorobanAuthorization sha256 (the
// same hash VF's ed25519 path already signs). We re-hash to bind the WebAuthn
// challenge, matching the OZ verifier's expectation.
export async function buildChallenge(authPreimageHash) {
  const h = await sha256(authPreimageHash)
  return base64urlNoPad(h)
}

export function assertChallengeMatches(clientDataJSON, expectedChallenge) {
  const parsed = typeof clientDataJSON === 'string' ? JSON.parse(clientDataJSON) : clientDataJSON
  if (parsed.challenge !== expectedChallenge) {
    throw new Error(`challenge mismatch: got ${parsed.challenge}, expected ${expectedChallenge}`)
  }
}
```

> The test calls `buildChallenge` synchronously but it is `async`. Update the test's two `buildChallenge` calls to `await` (mark the test callbacks `async`). If the implementer prefers a sync API, swap `crypto.subtle` for a sync sha256 — but `crypto.subtle.digest` is async in the browser, so keep `async` and `await` in tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/passkey.js frontend/src/wallet/passkey.test.js
git commit -m "feat: bind WebAuthn challenge to base64url(sha256(authPreimage))"
```

---

## Task 4: passkey.js — ceremony runner + secp256r1 entry assembly

**Files:**
- Modify: `frontend/src/wallet/passkey.js`
- Test: `frontend/src/wallet/passkey.test.js` (add)

**Interfaces:**
- Consumes: `derToRaw`, `normalizeLowS`, `buildChallenge`, `assertChallengeMatches`.
- Produces: `runCeremony({ kind, challenge, rpId, allowCredentials? }): Promise<{ authenticatorData, clientDataJSON, signature }>` (driven via a message to the ceremony tab in production; directly callable with an injected `credentials` provider in tests); `assembleSecp256r1Signature({ authenticatorData, clientDataJSON, rawSig })` → the bytes the OZ webauthn-verifier expects.

**M0a investigation note (do this first, then code):** Determine the SAK signing seam. Check whether `kit.authenticatePasskey()` / SAK's internal sign step lets you (a) inject the Soroban-preimage challenge and (b) run the ceremony in the extension tab. If SAK owns `navigator.credentials.get` internally and assumes a web/popup context, bypass it for the **per-transaction assertion** and use `runCeremony` below, then hand the assembled secp256r1 entry to `kit.wallet` directly. Record the finding in the commit message — it decides whether Tasks 8/12 call SAK's sign or our `runCeremony`.

- [ ] **Step 1: Write the failing test (injectable credentials provider)**

```js
// add to frontend/src/wallet/passkey.test.js
import { runCeremony } from './passkey.js'

describe('passkey ceremony runner', () => {
  it('passes the bound challenge to the authenticator and returns normalized parts', async () => {
    const fakeAssertion = {
      response: {
        authenticatorData: new Uint8Array([0xaa]).buffer,
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({ type: 'webauthn.get', challenge: 'CH', origin: 'chrome-extension://x' })
        ).buffer,
        signature: Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...new Uint8Array(32).fill(1), 0x02, 0x20, ...new Uint8Array(32).fill(2)]).buffer,
      },
    }
    const provider = { get: async (opts) => { provider.seen = opts; return fakeAssertion } }
    const out = await runCeremony({ kind: 'get', challenge: 'CH', rpId: 'localhost', provider })
    // challenge reached the authenticator:
    expect(new TextDecoder().decode(provider.seen.publicKey.challenge)).toContain('CH')
    expect(out.signature.length).toBe(64) // DER → raw, already low-S
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: FAIL — `runCeremony is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to frontend/src/wallet/passkey.js
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(Buffer.from(s, 'base64'))
}

// In production, the popup posts {kind, challenge, rpId} to the ceremony TAB
// (the OS prompt closes the popup); the tab calls navigator.credentials and
// posts the assertion back. `provider` defaults to navigator.credentials so the
// same function runs in the tab and in tests (injected fake).
export async function runCeremony({ kind, challenge, rpId, allowCredentials, provider }) {
  const creds = provider ?? globalThis.navigator?.credentials
  if (!creds) throw new Error('no credentials provider (run inside the ceremony tab)')
  const challengeBytes = new TextEncoder().encode(challenge)
  let assertion
  if (kind === 'get') {
    assertion = await creds.get({
      publicKey: {
        challenge: challengeBytes,
        rpId,
        allowCredentials: allowCredentials ?? [],
        userVerification: 'required',
      },
    })
  } else {
    throw new Error(`create ceremony handled by SAK.createWallet, not runCeremony`)
  }
  const r = assertion.response
  const rawSig = normalizeLowS(derToRaw(new Uint8Array(r.signature)))
  return {
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new TextDecoder().decode(r.clientDataJSON),
    signature: rawSig,
  }
}

// Layout the OZ webauthn-verifier expects for sig_data: authenticatorData +
// clientDataJSON + the 64-byte low-S signature. Exact field packing is verified
// on-chain in Task 8; keep this the single place that assembles it.
export function assembleSecp256r1Signature({ authenticatorData, clientDataJSON, signature }) {
  return { authenticatorData, clientDataJSON: new TextEncoder().encode(clientDataJSON), signature }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/passkey.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/passkey.js frontend/src/wallet/passkey.test.js
git commit -m "feat: ceremony runner (injectable provider) + secp256r1 entry assembly"
```

---

## Task 5: Extension shell — background SW, popup host, ceremony tab (M0a gate)

**Files:**
- Create: `frontend/extension/background.js`
- Create: `frontend/extension/popup.html`, `frontend/extension/popup.jsx`
- Create: `frontend/extension/ceremony.html`, `frontend/extension/ceremony.js`
- Test: `frontend/extension/background.test.js` (message routing only)

**Interfaces:**
- Consumes: `runCeremony` (Task 4).
- Produces: a loadable unpacked extension where popup → SW → ceremony-tab → SW → popup round-trips an assertion. **M0a pass condition:** a WebAuthn `create`/`get` ceremony completes in the ceremony tab and returns an assertion to the SW (Chrome 122+).

- [ ] **Step 1: Write the failing test (SW message router is pure + unit-testable)**

```js
// frontend/extension/background.test.js
import { describe, it, expect, vi } from 'vitest'
import { handleMessage } from './background.js'

describe('background message router', () => {
  it('opens a ceremony tab for SIGN_REQUEST and resolves with the assertion', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 7 })) }
    const pending = new Map()
    const reply = vi.fn()
    await handleMessage({ type: 'SIGN_REQUEST', challenge: 'CH', rpId: 'localhost' }, { tabs, pending }, reply)
    expect(tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('ceremony.html') }))
    // ceremony tab posts the result back:
    await handleMessage({ type: 'CEREMONY_RESULT', tabId: 7, assertion: { signature: [1] } }, { tabs, pending }, reply)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'SIGN_RESULT' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run extension/background.test.js`
Expected: FAIL — `Cannot find module './background.js'`.

- [ ] **Step 3: Write the SW router + ceremony tab + popup host**

```js
// frontend/extension/background.js
// Pure-ish router so it is unit-testable; chrome.* is injected as `env`.
const inflight = new Map()

export async function handleMessage(msg, env, reply) {
  const tabs = env.tabs ?? chrome.tabs
  const pending = env.pending ?? inflight
  if (msg.type === 'SIGN_REQUEST') {
    const url = `${chrome?.runtime?.getURL?.('ceremony.html') ?? 'ceremony.html'}?challenge=${encodeURIComponent(msg.challenge)}&rpId=${encodeURIComponent(msg.rpId)}`
    const tab = await tabs.create({ url, active: true })
    pending.set(tab.id, reply)
    return
  }
  if (msg.type === 'CEREMONY_RESULT') {
    const r = pending.get(msg.tabId)
    if (r) { r({ type: 'SIGN_RESULT', assertion: msg.assertion }); pending.delete(msg.tabId) }
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg, {}, sendResponse); return true
  })
}
```

```js
// frontend/extension/ceremony.js
import { runCeremony } from '../src/wallet/passkey.js'

const params = new URLSearchParams(location.search)
const challenge = params.get('challenge')
const rpId = params.get('rpId')

;(async () => {
  try {
    const out = await runCeremony({ kind: 'get', challenge, rpId })
    chrome.runtime.sendMessage({
      type: 'CEREMONY_RESULT',
      tabId: (await chrome.tabs.getCurrent())?.id,
      assertion: {
        authenticatorData: Array.from(out.authenticatorData),
        clientDataJSON: out.clientDataJSON,
        signature: Array.from(out.signature),
      },
    })
    window.close()
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'CEREMONY_ERROR', error: String(e) })
  }
})()
```

Create `frontend/extension/ceremony.html` (loads `ceremony.js` as a module) and `frontend/extension/popup.html` + `popup.jsx` (mounts a placeholder React screen with a "Test ceremony" button posting `SIGN_REQUEST`). Keep popup minimal here — real screens land in Tasks 11/15.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run extension/background.test.js`
Expected: PASS.

- [ ] **Step 5: M0a manual gate — load unpacked + run a real ceremony**

Run: `cd frontend && npm run build:ext`
Then in Chrome 122+: `chrome://extensions` → Developer mode → Load unpacked → `frontend/extension-dist/`. For deterministic dev, open DevTools → **WebAuthn** tab → Add virtual authenticator (CTAP2, internal, ES256). Click "Test ceremony" in the popup.
Expected: a ceremony tab opens, the virtual authenticator produces an assertion, and the SW logs `SIGN_RESULT`. **This is the M0a gate.** Capture a screenshot to `docs/` (local). Real Face ID is exercised at demo time.

- [ ] **Step 6: Commit**

```bash
git add frontend/extension/background.js frontend/extension/background.test.js frontend/extension/ceremony.html frontend/extension/ceremony.js frontend/extension/popup.html frontend/extension/popup.jsx
git commit -m "feat: MV3 extension shell with ceremony-tab WebAuthn round-trip (M0a)"
```

---

## Task 6: Deploy webauthn-verifier + install account wasm on testnet (infra)

**Files:**
- Modify: `deployments/stellar-testnet.json`
- Modify: `frontend/src/wallet/config.js` (fill `accountWasmHash` + `webauthnVerifierAddress`)
- Create: `scripts/soroban/deploy-smart-account.sh`

**Interfaces:**
- Produces: a deployed `webauthnVerifierAddress` (C-address) + an installed `accountWasmHash` on testnet, recorded in `deployments/stellar-testnet.json` under a new `smartAccount` key, and read into `WALLET_CONFIG`.

**Critical version note (§0):** the deployed account + verifier wasm must come from the OZ `stellar-contracts` release that **`smart-account-kit-bindings@0.1.2` targets**, not blindly the newest OZ tag. Verify the bindings' expected contract version (check `smart-account-kit-bindings` source or SAK README "Setup") before downloading wasm. If the SDK ships canonical testnet addresses for the verifier, prefer those over self-deploying.

- [ ] **Step 1: Determine wasm source**

Check SAK README "Setup/Deployment" + `smart-account-kit-bindings@0.1.2` for the expected OZ contract version. If the SDK exposes default testnet addresses (e.g. `DEFAULT_*` constants or a setup script), use them and skip self-deploy (jump to Step 4). Otherwise download the matching `webauthn_verifier.wasm` + `smart_account.wasm` from the OZ `stellar-contracts` release.

- [ ] **Step 2: Write the deploy script (WSL — Soroban tooling is WSL-only)**

```bash
# scripts/soroban/deploy-smart-account.sh  (run via: wsl -e bash -lc "...")
set -euo pipefail
NET=testnet
SRC=vf-deployer   # existing funded testnet identity (CLI-only, never browser-imported)

# 1. install the OZ smart_account wasm → prints the wasm hash
ACCOUNT_HASH=$(stellar contract install --network $NET --source $SRC --wasm ./wasm/smart_account.wasm)
echo "accountWasmHash=$ACCOUNT_HASH"

# 2. deploy the webauthn-verifier → prints its contract id
VERIFIER=$(stellar contract deploy --network $NET --source $SRC --wasm ./wasm/webauthn_verifier.wasm)
echo "webauthnVerifierAddress=$VERIFIER"
```

- [ ] **Step 3: Run it**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && bash scripts/soroban/deploy-smart-account.sh"`
Expected: prints a 64-hex `accountWasmHash` and a `C...` verifier address. Copy both.

- [ ] **Step 4: Record addresses**

Add to `deployments/stellar-testnet.json`:

```json
"smartAccount": {
  "accountWasmHash": "<64-hex>",
  "webauthnVerifierAddress": "C...",
  "ozContractsVersion": "v0.7.x",
  "sakVersion": "0.2.10",
  "indexerUrl": "<DEFAULT_INDEXER_URL for testnet, or self-hosted>"
}
```

Update `frontend/src/wallet/config.js` `makeWalletConfig` defaults to read these (import the JSON or inline the constants — match how `frontend/src/stellar/config.js` does it).

- [ ] **Step 5: Verify config wiring**

Run: `cd frontend && npx vitest run src/wallet/config.test.js`
Update the Task 1 test to assert `accountWasmHash` + `webauthnVerifierAddress` are now non-null. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add deployments/stellar-testnet.json frontend/src/wallet/config.js frontend/src/wallet/config.test.js scripts/soroban/deploy-smart-account.sh
git commit -m "feat: deploy webauthn-verifier + install smart-account wasm on testnet"
```

---

## Task 7: account.js — create / connect / balance (M1)

**Files:**
- Create: `frontend/src/wallet/account.js`
- Test: `frontend/src/wallet/account.test.js`

**Interfaces:**
- Consumes: `WALLET_CONFIG` (Task 1/6); the `smart-account-kit` default export / named `Kit`.
- Produces: `makeKit(overrides?)`, `createPasskeyWallet({ appName, userName }) → { contractId, credentialId }`, `connectPasskeyWallet({ contractId?, credentialId? }) → { contractId }`, `readBalance(contractId) → bigint`. **Persists `contractId` to `localStorage` (`vf_wallet_contract`) so reconnect never needs the indexer.**

- [ ] **Step 1: Write the failing test (SAK injected as a fake)**

```js
// frontend/src/wallet/account.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPasskeyWallet, connectPasskeyWallet } from './account.js'

const store = {}
beforeEach(() => { for (const k in store) delete store[k]
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v }, removeItem: (k) => { delete store[k] } }
})

function fakeKit() {
  return {
    createWallet: vi.fn(async () => ({ contractId: 'CWALLET', credentialId: 'CRED1' })),
    connectWallet: vi.fn(async (opts) => ({ contractId: opts?.contractId ?? 'CWALLET' })),
  }
}

describe('passkey wallet account', () => {
  it('createPasskeyWallet returns ids and caches contractId locally', async () => {
    const kit = fakeKit()
    const out = await createPasskeyWallet({ appName: 'VF', userName: 'u', kit })
    expect(out).toEqual({ contractId: 'CWALLET', credentialId: 'CRED1' })
    expect(store['vf_wallet_contract']).toBe('CWALLET')
  })

  it('connectPasskeyWallet prefers the cached contractId (no indexer)', async () => {
    store['vf_wallet_contract'] = 'CCACHED'
    const kit = fakeKit()
    const out = await connectPasskeyWallet({ kit })
    expect(kit.connectWallet).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'CCACHED' }))
    expect(out.contractId).toBe('CCACHED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: FAIL — `Cannot find module './account.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/wallet/account.js
import SmartAccountKit from 'smart-account-kit'   // confirm the exact import name at Task 0
import { WALLET_CONFIG } from './config.js'
import { rpcServer } from '../stellar/client.js'
import { SOROBAN_TOKEN_ADDRESS } from '../stellar/config.js'

const CACHE_KEY = 'vf_wallet_contract'

export function makeKit(overrides = {}) {
  return new SmartAccountKit({ ...WALLET_CONFIG, ...overrides })
}

export async function createPasskeyWallet({ appName, userName, kit = makeKit() }) {
  const { contractId, credentialId } = await kit.createWallet(appName, userName, {
    autoSubmit: true,   // deploy the account
    autoFund: true,     // Friendbot (testnet)
  })
  localStorage.setItem(CACHE_KEY, contractId)
  return { contractId, credentialId }
}

// Reconnect priority: explicit contractId > local cache > credentialId (indexer) > prompt.
export async function connectPasskeyWallet({ contractId, credentialId, kit = makeKit() } = {}) {
  const cached = contractId ?? localStorage.getItem(CACHE_KEY)
  let res
  if (cached) res = await kit.connectWallet({ contractId: cached })
  else if (credentialId) res = await kit.connectWallet({ credentialId })  // needs indexer
  else res = await kit.connectWallet({ prompt: true })
  if (res?.contractId) localStorage.setItem(CACHE_KEY, res.contractId)
  return { contractId: res.contractId }
}

// Balance via the existing token contract read (reuses VF's rpc + scval path).
export async function readBalance(contractId, { server } = {}) {
  const { readTokenBalance } = await import('../stellar/agentDeposit.js')
  return readTokenBalance(contractId, { token: SOROBAN_TOKEN_ADDRESS, server: server ?? (await rpcServer()) })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: PASS.

- [ ] **Step 5: M1 manual gate**

In the extension popup (dev build): create a wallet via the virtual authenticator, then read balance. Expected: a `C...` contractId returned, deployed on testnet (verify on an explorer), Friendbot-funded XLM, balance reads without error. Capture screenshot.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/wallet/account.js frontend/src/wallet/account.test.js
git commit -m "feat: passkey wallet create/connect/balance with local contractId cache (M1)"
```

---

## Task 8: M0b GATE — passkey signs a Soroban auth-entry that passes `__check_auth`

**Files:**
- Create: `frontend/scripts/m0b-passkey-authentry-smoke.mjs`
- Modify: `frontend/src/wallet/passkey.js` (only if the on-chain run reveals a packing fix)

**Interfaces:**
- Consumes: `runCeremony`, `assembleSecp256r1Signature`, `buildChallenge` (Tasks 2–4); the deployed account + verifier (Task 6); `submitViaRelay` (`stellar/relay.js`).
- Produces: proof that a secp256r1 passkey signature verifies on-chain on the deployed OZ account.

**This is the spike's make-or-break gate.** No new unit test — it is an end-to-end testnet run. The unit-level crypto is already proven (Tasks 2–4); this validates the **on-chain packing + challenge-binding + low-S** against the real verifier.

- [ ] **Step 1: Write the smoke script**

```js
// frontend/scripts/m0b-passkey-authentry-smoke.mjs
// Builds a no-op / self-call invocation on the deployed smart account, has the
// passkey sign its auth-entry, fee-bumps via the VF relayer, submits, asserts success.
import { makeKit } from '../src/wallet/account.js'
// 1. connect an existing deployed wallet (contractId from Task 7 / cache)
// 2. build the simplest authorized self-call (e.g. a read-through invoke that
//    still triggers __check_auth, or get_signer_id via kit.wallet)
// 3. compute the auth-preimage sha256, buildChallenge(), runCeremony() (use the
//    DevTools virtual authenticator), assemble the secp256r1 entry
// 4. submitViaRelay({ xdr }); assert the tx succeeds (status SUCCESS, no
//    __check_auth trap). Print the tx hash.
```

(Fill the body using `kit.wallet` raw methods + the auth-entry assembly; keep it the minimal call that exercises `__check_auth`.)

- [ ] **Step 2: Run it on testnet**

Run: `cd frontend && node scripts/m0b-passkey-authentry-smoke.mjs`
Expected: prints a testnet tx hash with `SUCCESS`. If it traps:
  - `Error(Auth, InvalidAction)` / signature failure → check **low-S** (Task 2) and the **sig_data packing** (Task 4 `assembleSecp256r1Signature` field order vs the OZ verifier's `key_data`/`sig_data` layout).
  - challenge failure → check **base64url unpadded 43-char** challenge (Task 3) and that `clientDataJSON.challenge` equals `buildChallenge(authPreimage)`.

- [ ] **Step 3: M0b decision gate**

**PASS** → continue to M1–M3. **Record the tx hash** as proof in `docs/` (local).
**FAIL / stuck (budget exhausted)** → **CUT TO B**: ship the passkey wallet on the **default single-signer account** (Tasks 7/9/10/12 still work — they do not depend on the agent composition), VF's agent stays on its existing `agent_account`, and the "one account / three signers" composition moves to roadmap (skip Tasks 13). Document the cut in the demo script.

- [ ] **Step 4: Commit**

```bash
git add frontend/scripts/m0b-passkey-authentry-smoke.mjs frontend/src/wallet/passkey.js
git commit -m "test: M0b on-chain passkey auth-entry smoke (gate)"
```

---

## Task 9: vfapi/client.js — thin client over F8 eligibility + vault-facts + build/simulate/relay

**Files:**
- Create: `frontend/src/vfapi/client.js`
- Test: `frontend/src/vfapi/client.test.js`

**Interfaces:**
- Consumes: `strategy/eligibilityGate.js` `evaluate(input, nowMs)`; `strategy/vaultFacts.js` `resolve(protocol)`; `strategy/vaultFactsSnapshot.js`; `stellar/relay.js` `submitViaRelay({ xdr })`.
- Produces: `eligibility({ vault, amount }) → { allow, verdict, reasons }`, `vaultFacts(protocol) → facts`, `buildUnsignedTx({ kind, params }) → { xdr }`, `simulate(xdr) → { sharesOut, balanceDelta }`, `submit(xdr) → result`. **Hard rule: returns analysis + UNSIGNED XDR only; never signs, never takes a secret.**

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/vfapi/client.test.js
import { describe, it, expect, vi } from 'vitest'
import { eligibility, buildUnsignedTx } from './client.js'

describe('vfapi thin client', () => {
  it('eligibility delegates to the F8 gate and returns a fail-closed verdict', async () => {
    const facts = { /* a known-rejected fixture: ponzi ratio < 1.5 */ }
    const out = await eligibility({ vault: 'CVAULT', amount: 100n, facts, nowMs: 1_000_000 })
    expect(out).toHaveProperty('allow')
    expect(out).toHaveProperty('reasons')
  })

  it('buildUnsignedTx returns { xdr } and never a signature/secret', async () => {
    const assemble = vi.fn(async () => ({ xdr: 'AAAA...' }))
    const out = await buildUnsignedTx({ kind: 'deposit', params: { amount: 100n }, assemble })
    expect(out).toEqual({ xdr: 'AAAA...' })
    expect(JSON.stringify(out)).not.toMatch(/secret|seed|privateKey/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/vfapi/client.test.js`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/vfapi/client.js
import { evaluate } from '../strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../strategy/vaultFacts.js'
import { submitViaRelay } from '../stellar/relay.js'

// App-layer, fail-closed F8 gate. (HONESTY: app-layer, not on-chain-verifiable.)
export async function eligibility({ vault, amount, facts, nowMs }) {
  const verdict = evaluate({ vault, amount, facts }, nowMs)
  return { allow: verdict.allow ?? verdict.eligible ?? false, verdict, reasons: verdict.reasons ?? [] }
}

export function vaultFacts(protocol) {
  return resolveVaultFacts(protocol)
}

// `assemble` is injected (test) or defaults to the real SDK/stellar build path.
// Returns UNSIGNED XDR only — the non-custodial line.
export async function buildUnsignedTx({ kind, params, assemble }) {
  if (!assemble) throw new Error('assemble fn required (wired in Task 10/12/13)')
  const { xdr } = await assemble({ kind, params })
  return { xdr }
}

export async function submit(xdr) {
  return submitViaRelay({ xdr })
}
```

Adjust `evaluate`'s expected `input`/return shape to the real `eligibilityGate.js` signature when wiring (read it first; the test fixture must match a known-rejected case, e.g. ponzi ratio < `PONZI_RATIO_MAX`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/vfapi/client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/vfapi/client.js frontend/src/vfapi/client.test.js
git commit -m "feat: vfapi thin client (F8 eligibility + vault-facts + unsigned-tx + relay)"
```

---

## Task 10: Send / receive USDC via passkey + relayer fee-bump (M2)

**Files:**
- Modify: `frontend/src/wallet/account.js` (add `sendToken`)
- Test: `frontend/src/wallet/account.test.js` (add)
- Create: `frontend/scripts/m2-send-smoke.mjs`

**Interfaces:**
- Consumes: `connectPasskeyWallet`, `runCeremony`, `buildChallenge`, `submitViaRelay`, `toBaseUnits` (`stellar/format.js`).
- Produces: `sendToken({ contractId, to, amount }) → { xdr }` (unsigned, then passkey-signed + relayed). Receiving needs no code — funds arrive at the `C...` address.

- [ ] **Step 1: Write the failing test (build path returns unsigned XDR)**

```js
// add to frontend/src/wallet/account.test.js
import { sendToken } from './account.js'

it('sendToken builds an unsigned token transfer XDR scoped to the passkey account', async () => {
  const kit = { wallet: { transfer: vi.fn(async () => ({ xdr: 'TXDR' })) } }
  const out = await sendToken({ contractId: 'CWALLET', to: 'CDEST', amount: 5n, kit })
  expect(out.xdr).toBe('TXDR')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: FAIL — `sendToken is not a function`.

- [ ] **Step 3: Implement `sendToken` (unsigned build; sign+relay at call sites)**

```js
// add to frontend/src/wallet/account.js
import { toBaseUnits } from '../stellar/format.js'

// Builds the unsigned transfer invocation on the token contract, sourced from
// the passkey smart account. Signing (passkey ceremony) + relay happen in the
// UI flow (Task 11) — this stays build-only to honor the non-custodial line.
export async function sendToken({ contractId, to, amount, kit = makeKit() }) {
  const units = typeof amount === 'bigint' ? amount : toBaseUnits(amount)
  // Prefer the SDK's assembled-XDR path; fall back to buildInvokeTx on the token.
  if (kit.wallet?.transfer) return kit.wallet.transfer({ from: contractId, to, amount: units })
  const { buildInvokeTx } = await import('../stellar/client.js')
  const { i128ScVal, addrScVal } = await import('../stellar/scval.js')
  const { SOROBAN_TOKEN_ADDRESS } = await import('../stellar/config.js')
  const tx = await buildInvokeTx({
    source: contractId, contract: SOROBAN_TOKEN_ADDRESS, method: 'transfer',
    args: [addrScVal(contractId), addrScVal(to), i128ScVal(units)],
  })
  return { xdr: tx.toXDR() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: PASS.

- [ ] **Step 5: M2 manual gate**

Run `frontend/scripts/m2-send-smoke.mjs`: connect → build transfer → passkey-sign (virtual authenticator) → `submitViaRelay` → confirm the recipient balance increased and the user paid 0 XLM fee (relayer fee-bumped). Capture screenshot/gif.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/wallet/account.js frontend/src/wallet/account.test.js frontend/scripts/m2-send-smoke.mjs
git commit -m "feat: passkey send/receive USDC via relayer fee-bump (M2)"
```

---

## Task 11: Approve screen — verdict-first overlay

**Files:**
- Create: `frontend/src/wallet/ui/ApproveOverlay.jsx`
- Create: `frontend/src/wallet/ui/ApproveOverlay.test.jsx`

**Interfaces:**
- Consumes: `vfapi/client.js` `eligibility`, `simulate`; `strategy/eligibilitySentence.js` for the human sentence; `runCeremony` trigger.
- Produces: `<ApproveOverlay verdict simulate onApprove onReject />` — renders the **F8 verdict first** (variant B), then the simulation, then a single Face ID approve button.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/wallet/ui/ApproveOverlay.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApproveOverlay } from './ApproveOverlay.jsx'

describe('Approve overlay (verdict-first)', () => {
  it('shows the F8 verdict above the amount and disables approve when ineligible', () => {
    render(<ApproveOverlay verdict={{ allow: false, reasons: ['ponzi ratio below 1.5'] }}
      simulate={{ sharesOut: '0' }} onApprove={vi.fn()} onReject={vi.fn()} />)
    const verdict = screen.getByTestId('verdict')
    const amount = screen.getByTestId('amount')
    // verdict appears before amount in the DOM (verdict-first):
    expect(verdict.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: /face id/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/ui/ApproveOverlay.test.jsx`
Expected: FAIL — module not found. (If `@testing-library/react` is absent, add it as a dev dep, pinned, in this step.)

- [ ] **Step 3: Implement the overlay (verdict-first, per DESIGN.md)**

```jsx
// frontend/src/wallet/ui/ApproveOverlay.jsx
export function ApproveOverlay({ verdict, simulate, onApprove, onReject }) {
  const eligible = !!verdict?.allow
  return (
    <div role="dialog" aria-label="Approve transaction">
      <p data-testid="verdict" data-eligible={eligible}>
        {eligible ? 'Eligible' : 'Not eligible'} — {(verdict?.reasons ?? []).join('; ')}
      </p>
      <p data-testid="amount">Shares out: {simulate?.sharesOut ?? '—'}</p>
      <button onClick={onReject}>Cancel</button>
      <button disabled={!eligible} onClick={onApprove}>Approve with Face ID</button>
    </div>
  )
}
```

Style per `DESIGN.md` (read it before visual work); keep the **verdict node first** and the Face ID button gated on `verdict.allow`. A human decline keeps its teeth — never auto-approve.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/ui/ApproveOverlay.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/ui/ApproveOverlay.jsx frontend/src/wallet/ui/ApproveOverlay.test.jsx frontend/package.json
git commit -m "feat: verdict-first Approve overlay gated on F8 eligibility"
```

---

## Task 12: M3 HERO — sign a VF deposit via passkey → shares minted

**Files:**
- Modify: `frontend/src/wallet/account.js` (add `depositToVault`)
- Test: `frontend/src/wallet/account.test.js` (add)
- Create: `frontend/scripts/m3-deposit-smoke.mjs`

**Interfaces:**
- Consumes: `vfapi.eligibility` (gate before sign), `runCeremony`, `submitViaRelay`, `readVaultShares` (`stellar/agentDeposit.js`), `SOROBAN_VAULT_ADDRESS`.
- Produces: `depositToVault({ contractId, amount }) → { xdr }` (unsigned vault deposit from the passkey account). **M3 pass: passkey-signed deposit → shares minted, verified via `readVaultShares` before/after.**

- [ ] **Step 1: Write the failing test (build path + eligibility gate)**

```js
// add to frontend/src/wallet/account.test.js
import { depositToVault } from './account.js'

it('depositToVault refuses to build when F8 says ineligible (fail-closed)', async () => {
  const eligibility = vi.fn(async () => ({ allow: false, reasons: ['stale facts'] }))
  await expect(depositToVault({ contractId: 'CWALLET', amount: 10n, eligibility }))
    .rejects.toThrow(/ineligible|not eligible/i)
})

it('depositToVault builds an unsigned vault deposit when eligible', async () => {
  const eligibility = vi.fn(async () => ({ allow: true, reasons: [] }))
  const kit = { wallet: { deposit: vi.fn(async () => ({ xdr: 'DXDR' })) } }
  const out = await depositToVault({ contractId: 'CWALLET', amount: 10n, eligibility, kit })
  expect(out.xdr).toBe('DXDR')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: FAIL — `depositToVault is not a function`.

- [ ] **Step 3: Implement `depositToVault` (gate → build unsigned)**

```js
// add to frontend/src/wallet/account.js
import { SOROBAN_VAULT_ADDRESS } from '../stellar/config.js'

// Fail-closed: never build a deposit the F8 gate rejects. Build-only (unsigned).
export async function depositToVault({ contractId, amount, eligibility, kit = makeKit() }) {
  const verdict = await eligibility({ vault: SOROBAN_VAULT_ADDRESS, amount })
  if (!verdict.allow) throw new Error(`ineligible: ${verdict.reasons.join('; ')}`)
  const units = typeof amount === 'bigint' ? amount : (await import('../stellar/format.js')).toBaseUnits(amount)
  if (kit.wallet?.deposit) return kit.wallet.deposit({ from: contractId, vault: SOROBAN_VAULT_ADDRESS, amount: units })
  const { buildInvokeTx } = await import('../stellar/client.js')
  const { i128ScVal, addrScVal } = await import('../stellar/scval.js')
  const tx = await buildInvokeTx({
    source: contractId, contract: SOROBAN_VAULT_ADDRESS, method: 'deposit',
    args: [addrScVal(contractId), i128ScVal(units)],
  })
  return { xdr: tx.toXDR() }
}
```

(Match the vault's real `deposit` method signature — read the vault ABI / reuse `buildAgentDeposit` arg shape from `agentDeposit.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: PASS.

- [ ] **Step 5: M3 HERO manual gate**

Run `frontend/scripts/m3-deposit-smoke.mjs`: read `readVaultShares(contractId)` (before) → build deposit → Approve overlay (eligible) → passkey-sign → `submitViaRelay` → read `readVaultShares` (after). Expected: **shares increased**, tx SUCCESS on testnet, 0 XLM user fee. Capture the hero **gif** (`docs/`, local). This is the demo's hero moment.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/wallet/account.js frontend/src/wallet/account.test.js frontend/scripts/m3-deposit-smoke.mjs
git commit -m "feat: passkey-signed VF deposit, shares minted on-chain (M3 hero)"
```

---

## Task 13: M4 THESIS GATE — add VF agent ed25519 as a policy-scoped co-signer

**Files:**
- Modify: `frontend/src/wallet/account.js` (add `addAgentSigner`)
- Test: `frontend/src/wallet/account.test.js` (add)
- Create: `frontend/scripts/m4-agent-cosigner-smoke.mjs`

**Interfaces:**
- Consumes: `kit.rules` (create a `spending_limit`/`volume_cap` context rule), `kit.signers.addDelegated(contextRuleId, agentGAddress)`; VF's `signAgentDepositEntries` + `newSessionKey` (`stellar/*`); the deployed account.
- Produces: `addAgentSigner({ contextRuleId, agentAddress }) → result` — adds the agent ed25519 key under a deposit-only / 1-vault / daily-cap / expiry context rule. **M4 pass: the agent runs an autonomous scoped deposit (human never taps); cap-exceeded → rejected on-chain.**

- [ ] **Step 1: Write the failing test**

```js
// add to frontend/src/wallet/account.test.js
import { addAgentSigner } from './account.js'

it('addAgentSigner attaches the ed25519 agent under a scoped context rule', async () => {
  const kit = {
    rules: { create: vi.fn(async () => ({ contextRuleId: 3 })) },
    signers: { addDelegated: vi.fn(async () => ({ ok: true })) },
  }
  const out = await addAgentSigner({ agentAddress: 'GAGENT', cap: 100n, vault: 'CVAULT', expiry: 999, kit })
  expect(kit.signers.addDelegated).toHaveBeenCalledWith(3, 'GAGENT')
  expect(out.ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: FAIL — `addAgentSigner is not a function`.

- [ ] **Step 3: Implement `addAgentSigner` (scoped context rule → delegated ed25519)**

```js
// add to frontend/src/wallet/account.js
// Ports VF's registry cap (deposit-only · 1 vault · daily cap · expiry) into an
// OZ context rule, then attaches the agent's ed25519 G-address as a delegated
// signer bound to that rule. The agent then signs deposit auth-entries with its
// existing session key (reuse signAgentDepositEntries) — human never taps.
export async function addAgentSigner({ agentAddress, cap, vault, expiry, kit = makeKit() }) {
  const { contextRuleId } = await kit.rules.create({
    type: 'spending_limit',
    params: { token: undefined, limit: cap, target: vault, expiry },
  })
  return kit.signers.addDelegated(contextRuleId, agentAddress)
}
```

(Use the real `kit.rules` context-rule builder helper + param names confirmed at Task 0 — `spending_limit`/`volume_cap` shape. The agent's signing reuses `signAgentDepositEntries({ tx, sessionKey, validUntilLedger, agentAddress })` unchanged, only the source account becomes the OZ smart account.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: PASS.

- [ ] **Step 5: M4 THESIS manual gate**

Run `frontend/scripts/m4-agent-cosigner-smoke.mjs`:
  1. add the agent ed25519 as a scoped co-signer on the **same** account;
  2. orchestrator dispatches an **autonomous** deposit signed by the agent session key (no passkey tap) → SUCCESS, shares minted;
  3. **negative:** an agent deposit exceeding the cap → **rejected on-chain** (`__check_auth` trap / policy reject).
Expected: (2) succeeds, (3) fails on-chain. Capture both.

**Gate decision:** PASS → continue. **Too costly / fails** → **ship M1–M3 (+M5) as B**; the composition thesis → roadmap; the agent keeps running on its existing `agent_account`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/wallet/account.js frontend/src/wallet/account.test.js frontend/scripts/m4-agent-cosigner-smoke.mjs
git commit -m "feat: VF agent ed25519 as policy-scoped co-signer on one account (M4 thesis)"
```

---

## Task 14: M5 Recovery — scoped recovery signer + rotate, with on-chain negative

**Files:**
- Create: `frontend/src/wallet/recovery.js`
- Test: `frontend/src/wallet/recovery.test.js`
- Create: `frontend/scripts/m5-recovery-smoke.mjs`

**Interfaces:**
- Consumes: `kit.rules` (a signer-management-only context rule), `kit.externalSigners` / `kit.signers.addDelegated`, `kit.signers.addPasskey`, `kit.signers.remove`, `kit.wallet.batch_add_signer`.
- Produces: `buildRecoveryRule(accountId) → ruleSpec` (binds the recovery signer to **only** the account's own `add_signer`/`update_signer`/`rotate`), `addRecoverySigner({ accountId, recoveryG }) `, `rotateToNewPasskey({ accountId, newPasskey, oldSigner })`. **M5 pass: recovery authorizes `add_signer(newPasskey)`, old passkey rotated out; recovery signer attempting a `deposit` → trap on-chain.**

- [ ] **Step 1: Write the failing test (rule is signer-management-scoped)**

```js
// frontend/src/wallet/recovery.test.js
import { describe, it, expect } from 'vitest'
import { buildRecoveryRule } from './recovery.js'

describe('recovery rule scope', () => {
  it('binds the recovery signer to ONLY the account self signer-management fns', () => {
    const rule = buildRecoveryRule('CACCOUNT')
    expect(rule.allowedContract).toBe('CACCOUNT')           // the account itself
    expect(rule.allowedFns.sort()).toEqual(['add_signer', 'rotate', 'update_signer'])
    // a vault deposit must NOT be permitted by this rule:
    expect(rule.allowedFns).not.toContain('deposit')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/recovery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the recovery rule + helpers**

```js
// frontend/src/wallet/recovery.js
import { makeKit } from './account.js'

// The recovery signer's authority is enforced ON-CHAIN (§4 amendment 1): its
// context rule permits ONLY the account's own signer-management functions. Any
// other context (vault deposit, token transfer) traps in __check_auth.
export function buildRecoveryRule(accountId) {
  return {
    allowedContract: accountId,
    allowedFns: ['add_signer', 'update_signer', 'rotate'],
    name: 'recovery-signer-management-only',
  }
}

// Recovery signer = a DISTINCT VF-held External G-address (NOT the relayer key,
// NOT a delegated C-account → dodges the CAP-71 manual-auth-entry hazard).
export async function addRecoverySigner({ accountId, recoveryG, kit = makeKit() }) {
  const spec = buildRecoveryRule(accountId)
  const { contextRuleId } = await kit.rules.create({ type: 'custom', params: spec })
  return kit.signers.addDelegated(contextRuleId, recoveryG)
}

export async function rotateToNewPasskey({ accountId, contextRuleId, appName, userName, oldSigner, kit = makeKit() }) {
  await kit.signers.addPasskey(contextRuleId, appName, userName)   // recovery authorizes this
  return kit.signers.remove(contextRuleId, oldSigner)              // rotate old passkey out
}
```

(Confirm whether the signer-management-only scope is expressed as a custom context rule or a policy contract at Task 0; if OZ ships no built-in "self signer-management" rule type, a tiny policy contract enforces it — note that as a sub-step and deploy it like Task 6.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet/recovery.test.js`
Expected: PASS.

- [ ] **Step 5: M5 manual gate (incl. on-chain negative)**

Run `frontend/scripts/m5-recovery-smoke.mjs`:
  1. add the recovery signer (scoped) at/after account creation;
  2. simulate lost device → new passkey → recovery signer authorizes `add_signer(newPasskey)` → relayer fee-bumps → old passkey `remove`d;
  3. **negative:** recovery signer attempts a vault `deposit` → **rejected on-chain** (trap).
Expected: (2) succeeds, (3) fails. This makes the "scoped recovery" claim literally true. Capture both. **HONESTY label:** recovery key is VF-custodied (centralization) — surface in UI + pitch; production path = 2-of-3 / SEP-30 (roadmap).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/wallet/recovery.js frontend/src/wallet/recovery.test.js frontend/scripts/m5-recovery-smoke.mjs
git commit -m "feat: on-chain-scoped recovery signer + rotate, with deposit-trap negative (M5)"
```

---

## Task 15: M6 — packaging, honesty labels, baseline green

**Files:**
- Modify: `frontend/extension/popup.jsx` (wire real screens: welcome/onboarding/recovery/home/agent/signers/activity + Approve overlay)
- Create: `docs/vfwallet-demo-notes.md` (local; demo path M0b–M3 + honesty labels)
- Modify: `frontend/src/wallet/ui/*` (polish per `DESIGN.md`)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: an installable unpacked extension, polished verdict-first Approve, documented honesty labels, full green test suite.

- [ ] **Step 1: Wire the popup screens to the wallet/vfapi modules**

Connect `popup.jsx` routes to `createPasskeyWallet`/`connectPasskeyWallet`/`readBalance`/`sendToken`/`depositToVault`/`ApproveOverlay`. Keep the ceremony in the tab (never the popup).

- [ ] **Step 2: Add honesty labels in the UI**

Surface, verbatim where shown: F8 is **app-layer (not on-chain)**; recovery key is **VF-custodied (centralization)**; **testnet-grade**; passkey-on-Stellar is mainnet-live at the protocol layer but these wallet contracts are testnet PoC-grade.

- [ ] **Step 3: Run the FULL suite — baseline must stay green + new tests pass**

Run: `cd frontend && npm test`
Expected: the original **325 tests stay green** plus all new `wallet/*`, `vfapi/*`, `extension/*` tests. Fix any regression before proceeding.

- [ ] **Step 4: Build + load-unpacked sanity**

Run: `cd frontend && npm run build:ext`
Load `frontend/extension-dist/` in Chrome 122+. Walk the demo path (create → Face ID → send/receive → deposit). Expected: clean run, no console errors, ceremony in tab.

- [ ] **Step 5: Lint + format**

Run: `cd frontend && npm run lint && npm run format:check`
Expected: no new errors. Fix any.

- [ ] **Step 6: Commit**

```bash
git add frontend/extension/popup.jsx frontend/src/wallet/ui docs/vfwallet-demo-notes.md
git commit -m "feat: extension packaging, verdict-first screens, honesty labels (M6)"
```

---

## Self-Review (run after building the plan)

**Spec coverage:**
- §1 locked decisions → Account model A (SAK) Tasks 1/6/7; Chromium MV3 Tasks 0/5; verdict-first Task 11; reuse relay Tasks 9/10/12; F8 app-layer Task 9. ✓
- §2 architecture (3 signers, one account) → passkey Tasks 2–5/7; agent co-signer Task 13; recovery Task 14; curve-agnostic preimage reuse Tasks 8/13. ✓
- §3 components → `extension/` T0/T5, `passkey.js` T2–4, `account.js` T7/10/12/13, reused stellar/* (Interfaces blocks), `vfapi/` T9, `ui/` T11/15. ✓
- §4 recovery (on-chain-scoped, External G-address, not SoroPass, CAP-71 dodge) → Task 14 + `buildRecoveryRule` negative test. ✓
- §5 VF API (unsigned-only, endpoints) → Task 9 thin client + non-custodial assertions. ✓
- §6 milestone ladder + cut-to-B → Milestone→Task map + explicit gates in Tasks 8 (M0b) and 13 (M4). ✓
- §7 testing → unit (low-S, challenge-binding) Tasks 2/3; on-chain integration smokes Tasks 8/12/13/14; negative tests Tasks 13/14; 325 baseline Task 15. ✓
- §8 open risks → SDK pin §0 + Task 0; self-deploy wasm Task 6; extension WebAuthn Tasks 4/5; high-S Task 2; ES256-only Global Constraints. ✓ **Plus two risks the spec missed, surfaced by re-research: the indexer dependency (§0 + Task 7 cache) and the bindings-vs-OZ-version match (Task 6).**
- §9 invariants → Global Constraints "does NOT change" list. ✓

**Placeholder scan:** every code step shows real code; on-chain milestones (no unit test possible) use scripted smokes with explicit expected output, not "TODO". The two script bodies (Tasks 8 M0b, smokes) are stubbed with precise step lists because their exact XDR assembly depends on the M0 SAK-seam finding — flagged, not hand-waved.

**Type consistency:** `connectPasskeyWallet` (not `connectWallet` — avoids the `stellar/walletKit.js` collision) used consistently T7/10/12; `buildChallenge` is `async` (T3 note corrects the test); `eligibility({ vault, amount })` shape consistent T9/12; `contextRuleId` threading consistent T13/14.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-29-vfwallet-passkey.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best here: M0b/M4 are hard gates where a fresh reviewer per task catches drift early.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints.

Which approach?

# Passkey Popup → Real On-Chain Deposit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VF Wallet popup's **deposit** land a real testnet transaction that mints vault shares — gaslessly via VF's relayer (user pays 0 XLM) — for any fresh passkey wallet, by adding a self-service **Enable deposits** step (fund the token + approve the vault).

**Architecture:** The popup never signs. It routes an `{action, params}` intent through the background service-worker, which opens a full **ceremony tab** (Face-ID can't run in a dismissible popup). The ceremony tab loads SAK (`smart-account-kit`), connects the passkey wallet, and runs `src/wallet/submit.js`: build the invoke → recording-simulate → `kit.signAuthEntry` (Face-ID) → assemble → submit. **Deposit** assembles with `source = relayer` and submits via VF's gasless relay (`/api/stellar-relay`). **Approve** is self-paid (the relay is deposit-only): `source = an ephemeral Friendbot-funded keypair`, submitted via RPC. A new server endpoint `/api/faucet` dispenses testnet tokens from a funded VF treasury so a fresh account has a balance to approve+deposit.

**Tech Stack:** Node/ESM, React 18 (extension popup), Vite (app + extension build), Vitest (units), `@stellar/stellar-sdk@^16` (Soroban), `smart-account-kit@0.2.10` (passkey signing), Cloudflare Pages Functions + Vite dev middleware (server endpoints).

## Global Constraints

- **Non-custodial:** the passkey signs every auth entry (`kit.signAuthEntry`). The server only fee-sponsors deposits and dispenses test tokens. No user private key ever leaves the device.
- **Relay is deposit-only:** `assertVaultDeposit` in `api/stellar-relay.js` stays unchanged. Approve must NOT go through the relay — it is self-paid via an ephemeral source.
- **Fail-closed F8:** never build or sign a deposit the eligibility gate rejects. The gate runs in `account.depositToVault` AND is re-asserted in `submit.js`.
- **Server secrets stay server-side:** `VF_FAUCET_SECRET` (vf-deployer secret) is never in the client bundle; endpoint returns `{ configured: false }` (503) when unset — BYOK-style lockdown safe.
- **Testnet only:** the faucet dispenses testnet SAC tokens; a mainnet build drops `/api/faucet`.
- **Honest copy:** replace "no transfer submitted yet" with the real tx hash + Stellar Expert link + Δshares; keep the existing `HonestyLabels` disclaimers accurate.
- **Suite stays green:** the existing Vitest suite (404 tests) must remain green; every task adds tests and runs them.
- **Money/auth values exact:** token base units use 7 decimals (`SOROBAN_DECIMALS = 7`, `toBaseUnits`). Cap the faucet server-side.

---

## Confirmed research (verify-current, 2026-06-30 — do not re-litigate)

These were confirmed against the INSTALLED versions + current official docs before this plan was written:

1. **`@stellar/stellar-sdk@16` Soroban path — STABLE.** Proven by the working `scripts/m3-deposit-smoke.mjs`: `rpc.Server`, `simulateTransaction`, `prepareTransaction`, `rpc.Api.isSimulationError`, `rpc.assembleTransaction(tx, sim).build()`, `new Contract(addr).call(method, ...ScVal)`, `Operation.invokeHostFunction({ func, auth })`, `TransactionBuilder.buildFeeBumpTransaction` (in the relay), `xdr.HashIdPreimage.envelopeTypeSorobanAuthorization`. No deprecations to route around — mirror the smoke.
2. **SAC token interface (SEP-41) — CONFIRMED current.** `approve(from: Address, spender: Address, amount: i128, expiration_ledger: u32)` — `from.require_auth()`; `expiration_ledger` is an **absolute ledger number that must be ≥ the current ledger** (else only valid for `amount = 0`; an expired entry is treated as a 0 allowance). `transfer_from(spender, from, to, amount)` — `spender.require_auth()`, spends allowance + balance. ⇒ `vault.deposit(from=account)` (which does `transfer_from(spender=vault, from=account)`) requires the account to hold a balance AND have a live allowance to the vault.
3. **`smart-account-kit@0.2.10` — CONFIRMED.** Public method `signAuthEntry(entry: xdr.SorobanAuthorizationEntry, options?: { credentialId?: string; expiration?: number }): Promise<xdr.SorobanAuthorizationEntry>`. SAK owns the whole ceremony (Soroban auth preimage → `@simplewebauthn/browser` `startAuthentication` → secp256r1 low-S compact → keyData lookup by `credentialId` → External-signer ScVal). ⇒ `submit.js` calls `kit.signAuthEntry(recordedEntry)` — no hand-packing. **Verify in Task 4/7:** that `kit.connectWallet({ contractId })` populates the default `credentialId` for `signAuthEntry`; if not, pass `credentialId` explicitly.

---

## File Structure

| File | Create / Modify | Responsibility |
|------|------|------|
| `frontend/src/stellar/scval.js` | Modify | add `u32ScVal` helper |
| `frontend/src/stellar/client.js` | Modify | add `{ u32 }` case to `encodeArgs` |
| `frontend/src/wallet/account.js` | Modify | add `buildApprove` (pure, data-only) |
| `frontend/src/wallet/account.test.js` | Modify | `buildApprove` arg-shape test |
| `frontend/src/wallet/submit.js` | Create | `submitDeposit` + `submitApprove` (sign+submit on SAK) |
| `frontend/src/wallet/submit.test.js` | Create | orchestration units (mock kit/relay/server) |
| `frontend/api/faucet.js` | Create | server token-dispense handler (mirrors `stellar-relay.js`) |
| `frontend/functions/api/faucet.js` | Create | Cloudflare Pages wrapper |
| `frontend/api/faucet.test.js` | Create | handler units (503, dispense, cap, cors/rate-limit) |
| `frontend/vite.config.js` | Modify | wire `/api/faucet` + propagate `VF_FAUCET_SECRET`/`SOROBAN_TOKEN_ADDRESS` |
| `frontend/.env.example`, `frontend/.dev.vars.example` | Modify | add `VF_FAUCET_SECRET`, `SOROBAN_TOKEN_ADDRESS` |
| `frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs` | Create | headless testnet smoke: fund → approve → deposit → shares minted |
| `frontend/extension/ceremony.js` | Modify | action runner (deposit/approve) — SAK ceremony in-tab |
| `frontend/extension/ceremony.html` | Modify | live status UI |
| `frontend/extension/background.js` | Modify | route `action`, relay `CEREMONY_RESULT` to popup + `chrome.storage.session` |
| `frontend/extension/background.test.js` | Create/Modify | router unit test for the action + result path |
| `frontend/extension/popup.jsx` | Modify | Enable-deposits + Deposit real flow + honest result copy |
| `frontend/src/wallet/ui/HonestyLabels.jsx` | Modify | deposit-scope copy reflects real submit |

---

## Reference snippets (grounded — copy these patterns)

**`src/stellar/config.js` (exact values):**
```js
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
export const SOROBAN_VAULT_ADDRESS = 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'
export const SOROBAN_TOKEN_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU' // = Blend USDC
export const SOROBAN_DECIMALS = 7
export const RELAY_PROXY_URL =
  (typeof process !== 'undefined' && process.env && process.env.VF_RELAY_URL) || '/api/stellar-relay'
```

**`src/stellar/relay.js` (existing — consume as-is):** `submitViaRelay({ xdr }) → { hash, status, relayer } | null`, `getRelayerAddress() → string | null`.

**`src/stellar/client.js` (existing):** `rpcServer()` → `new rpc.Server(...)`; `buildInvokeTx({ source, contract, method, args })` → `{ tx, xdr }`; `encodeArgs([...])` maps `{addr}`/`{i128}`/`{u64}`/`{bytes32}`/`{symbol}`/raw-ScVal.

**`src/stellar/agentDeposit.js` (existing):** `readVaultShares(addr, { server }) → bigint|null`, `readTokenBalance(addr, { token, server }) → bigint|null`.

**`scripts/m3-deposit-smoke.mjs` (the proven sign+submit reference)** — `submit.js` and the new smoke mirror its deposit-assembly (lines 263–332): recording-sim → sign auth entry → `setSorobanData` + `Operation.invokeHostFunction({ func, auth: [entry] })` → enforcing-sim → `rpc.assembleTransaction(...).build()` → submit. The new code swaps: source = relayer (deposit) or ephemeral (approve); signer = `kit.signAuthEntry` (browser) or the synthetic P-256 signer (smoke).

**`api/stellar-relay.js` handler shape (the mirror target for the faucet):** `import { applyCors, rateLimit } from './_guard.js'`; env via `() => process.env.X || default`; `export default async function handler(req, res)`; flow = method-check → `applyCors` → `rateLimit({ max, windowMs, bucket })` → `setHeader('Content-Type','application/json')` → secret-check (503 `{ error, configured:false }`) → `readBody(req)` → `await import('@stellar/stellar-sdk')` → dispatch on `body.action`; `bad(res, msg)` = 400.

**`api/_guard.js` (existing — reuse):** `applyCors(req, res) → boolean`; `rateLimit(req, res, { max, windowMs, bucket }) → boolean`.

---

## Task 1: `buildApprove` + `u32` arg encoding

**Files:**
- Modify: `frontend/src/stellar/scval.js`
- Modify: `frontend/src/stellar/client.js` (the `encodeArgs` function)
- Modify: `frontend/src/wallet/account.js`
- Test: `frontend/src/wallet/account.test.js`

**Interfaces:**
- Consumes: `SOROBAN_TOKEN_ADDRESS`, `SOROBAN_VAULT_ADDRESS` from `../stellar/config.js`; `toBaseUnits` from `../stellar/format.js`.
- Produces: `buildApprove({ contractId, vault, amount, expiryLedger }) → { contract, method: 'approve', args }` where `args = [{ addr: contractId }, { addr: vault }, { i128 }, { u32: expiryLedger }]`. Consumed by `submitApprove` (Task 2) via `buildInvokeTx`.

- [ ] **Step 1: Write the failing test** — append to `frontend/src/wallet/account.test.js`:

```js
import { buildApprove } from './account.js'
import { SOROBAN_TOKEN_ADDRESS, SOROBAN_VAULT_ADDRESS } from '../stellar/config.js'

describe('buildApprove', () => {
  it('builds an approve invocation: from=account, spender=vault, i128 amount, u32 expiry', () => {
    const out = buildApprove({
      contractId: 'CACCOUNT',
      vault: SOROBAN_VAULT_ADDRESS,
      amount: 5n,
      expiryLedger: 123456,
    })
    expect(out.contract).toBe(SOROBAN_TOKEN_ADDRESS)
    expect(out.method).toBe('approve')
    expect(out.args).toEqual([
      { addr: 'CACCOUNT' },
      { addr: SOROBAN_VAULT_ADDRESS },
      { i128: 5n },
      { u32: 123456 },
    ])
  })

  it('defaults the spender to the configured vault', () => {
    const out = buildApprove({ contractId: 'CACCOUNT', amount: 1n, expiryLedger: 9 })
    expect(out.args[1]).toEqual({ addr: SOROBAN_VAULT_ADDRESS })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/account.test.js -t buildApprove`
Expected: FAIL with `buildApprove is not a function` (not yet exported).

- [ ] **Step 3: Add `u32ScVal` to `scval.js`** (only if absent — grep first: `rg "u32ScVal" src/stellar/scval.js`). If missing, add next to the other ScVal helpers:

```js
// u32 scalar (e.g. SAC approve expiration_ledger — an absolute ledger number)
export const u32ScVal = (n) => xdr.ScVal.scvU32(Number(n))
```

(Confirm `xdr` is already imported at the top of `scval.js`; the existing `u64ScVal` proves the import pattern.)

- [ ] **Step 4: Add the `{ u32 }` case to `encodeArgs` in `client.js`** — insert alongside the existing `u64` line:

```js
    if (a && typeof a === 'object' && 'u32' in a) return u32ScVal(a.u32)
```

Add `u32ScVal` to the existing import from `./scval.js` in `client.js`.

- [ ] **Step 5: Add `buildApprove` to `account.js`** — append after `depositToVault`:

```js
// Build-only (pure, no RPC) token.approve invocation: from=account, spender=vault.
// `expiryLedger` is an ABSOLUTE ledger number (SEP-41: must be >= current ledger, else
// only valid for amount 0). submitApprove (submit.js) computes it from getLatestLedger,
// wraps this with source = an ephemeral fee-payer, and passkey-signs the from auth entry.
// Mirrors depositToVault's build-only discipline; consumed via buildInvokeTx's encodeArgs.
export function buildApprove({ contractId, vault = SOROBAN_VAULT_ADDRESS, amount, expiryLedger }) {
  const units = typeof amount === 'bigint' ? amount : toBaseUnits(amount)
  return {
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'approve',
    args: [{ addr: contractId }, { addr: vault }, { i128: units }, { u32: expiryLedger }],
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/wallet/account.test.js`
Expected: PASS (existing account tests + the 2 new `buildApprove` tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/stellar/scval.js frontend/src/stellar/client.js frontend/src/wallet/account.js frontend/src/wallet/account.test.js
git commit -m "feat(wallet): buildApprove + u32 arg encoding for SAC approve"
```

---

## Task 2: `submit.js` — `submitDeposit` + `submitApprove`

**Files:**
- Create: `frontend/src/wallet/submit.js`
- Test: `frontend/src/wallet/submit.test.js`

**Interfaces:**
- Consumes: `buildApprove` (Task 1); `submitViaRelay`, `getRelayerAddress` from `../stellar/relay.js`; `readVaultShares` from `../stellar/agentDeposit.js`; `rpcServer`, `buildInvokeTx` from `../stellar/client.js`; `depositToVault` from `./account.js` (F8 gate reuse); `@stellar/stellar-sdk`; a connected `kit` with `signAuthEntry`.
- Produces:
  - `submitDeposit({ contractId, amount, eligibility, kit, relay?, server? }) → { hash, status, sharesBefore, sharesAfter }`
  - `submitApprove({ contractId, amount, vault?, expiryLedgers?, kit, server? }) → { hash, status }`
  - Both accept hidden injectable seams (`buildInner` / `signSubmitApprove`, `readShares`, `makeEphemeral`, `fund`) for unit tests; defaults are the real implementations.

- [ ] **Step 1: Write the failing test** — `frontend/src/wallet/submit.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { submitDeposit, submitApprove } from './submit.js'
import { SOROBAN_VAULT_ADDRESS } from '../stellar/config.js'

describe('submitDeposit (orchestration)', () => {
  const okElig = vi.fn(async () => ({ allow: true, reasons: [] }))

  it('runs the F8 gate, sources the inner tx at the relayer, relays the signed XDR, returns the share delta', async () => {
    const relay = {
      getRelayerAddress: vi.fn(async () => 'GRELAYER'),
      submitViaRelay: vi.fn(async () => ({ hash: 'HASH', status: 'SUCCESS' })),
    }
    const buildInner = vi.fn(async () => 'INNERXDR')
    const readShares = vi
      .fn()
      .mockResolvedValueOnce(0n) // before
      .mockResolvedValueOnce(5n) // after
    const out = await submitDeposit({
      contractId: 'CACCT',
      amount: 1n,
      eligibility: okElig,
      kit: {},
      relay,
      server: {},
      buildInner,
      readShares,
    })
    expect(okElig).toHaveBeenCalled()
    expect(buildInner).toHaveBeenCalledWith(expect.objectContaining({ relayer: 'GRELAYER', contractId: 'CACCT' }))
    expect(relay.submitViaRelay).toHaveBeenCalledWith({ xdr: 'INNERXDR' })
    expect(out).toEqual({ hash: 'HASH', status: 'SUCCESS', sharesBefore: 0n, sharesAfter: 5n })
  })

  it('fails closed when F8 rejects — never builds or relays', async () => {
    const relay = { getRelayerAddress: vi.fn(), submitViaRelay: vi.fn() }
    const buildInner = vi.fn()
    await expect(
      submitDeposit({
        contractId: 'CACCT',
        amount: 1n,
        eligibility: vi.fn(async () => ({ allow: false, reasons: ['stale facts'] })),
        kit: {},
        relay,
        buildInner,
        readShares: vi.fn(async () => 0n),
      })
    ).rejects.toThrow(/ineligible/)
    expect(buildInner).not.toHaveBeenCalled()
    expect(relay.submitViaRelay).not.toHaveBeenCalled()
  })

  it('surfaces an honest error when the relay is unconfigured', async () => {
    const relay = { getRelayerAddress: vi.fn(async () => null), submitViaRelay: vi.fn() }
    await expect(
      submitDeposit({ contractId: 'CACCT', amount: 1n, eligibility: okElig, kit: {}, relay, buildInner: vi.fn(), readShares: vi.fn(async () => 0n) })
    ).rejects.toThrow(/relay unavailable/)
  })
})

describe('submitApprove (orchestration)', () => {
  it('funds an ephemeral source and approves the vault as spender', async () => {
    const fund = vi.fn(async () => {})
    const makeEphemeral = vi.fn(() => ({ publicKey: () => 'GEPHEMERAL' }))
    const signSubmitApprove = vi.fn(async () => ({ hash: 'AHASH', status: 'SUCCESS' }))
    const out = await submitApprove({
      contractId: 'CACCT',
      amount: 100n,
      vault: SOROBAN_VAULT_ADDRESS,
      kit: {},
      server: {},
      fund,
      makeEphemeral,
      signSubmitApprove,
    })
    expect(makeEphemeral).toHaveBeenCalled()
    expect(fund).toHaveBeenCalledWith('GEPHEMERAL')
    expect(signSubmitApprove).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'CACCT', vault: SOROBAN_VAULT_ADDRESS })
    )
    expect(out).toEqual({ hash: 'AHASH', status: 'SUCCESS' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet/submit.test.js`
Expected: FAIL — `submit.js` does not exist / exports undefined.

- [ ] **Step 3: Write `submit.js`** — `frontend/src/wallet/submit.js`:

```js
// Production passkey sign+submit on SAK. Pure-ish: SAK (`kit`), relay, and server are injected
// for testability (mirrors account.js makeKit discipline). Mirrors scripts/m3-deposit-smoke.mjs
// for the on-chain assembly; swaps the synthetic signer for kit.signAuthEntry (browser Face-ID).
//
//   submitDeposit  — source = relayer; submitted via the gasless relay (user pays 0).
//   submitApprove  — source = an ephemeral Friendbot-funded fee-payer; self-paid via RPC
//                    (the relay is deposit-only and refuses a non-deposit).

import { submitViaRelay as realSubmitViaRelay, getRelayerAddress as realGetRelayer } from '../stellar/relay.js'
import { readVaultShares } from '../stellar/agentDeposit.js'
import { rpcServer } from '../stellar/client.js'
import { buildApprove } from './account.js'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'

const FRIENDBOT = 'https://friendbot.stellar.org'
const APPROVE_TTL_LEDGERS = 17_280 // ~24h on testnet (5s ledgers); allowance auto-expires after

const realRelay = { submitViaRelay: realSubmitViaRelay, getRelayerAddress: realGetRelayer }

async function assertEligible(eligibility, amount, vault) {
  const verdict = await eligibility({ vault, amount })
  if (!verdict.allow) throw new Error(`ineligible: ${(verdict.reasons ?? []).join('; ')}`)
}

// ── deposit ───────────────────────────────────────────────────────────────────
/**
 * F8-gated, passkey-signed vault deposit assembled with source = relayer, relayed gaslessly.
 * @returns {Promise<{ hash, status, sharesBefore, sharesAfter }>}
 */
export async function submitDeposit({
  contractId,
  amount,
  eligibility,
  kit,
  vault = SOROBAN_VAULT_ADDRESS,
  relay = realRelay,
  server,
  readShares = readVaultShares,
  buildInner = defaultBuildDepositInner,
}) {
  await assertEligible(eligibility, amount, vault) // F8 fail-closed BEFORE any signing
  const relayer = await relay.getRelayerAddress()
  if (!relayer) throw new Error('relay unavailable (relayer address unconfigured)')
  const s = server ?? (await rpcServer())
  const sharesBefore = await readShares(contractId, { server: s })
  const xdr = await buildInner({ contractId, amount, vault, relayer, kit, server: s })
  const relayed = await relay.submitViaRelay({ xdr })
  if (!relayed) throw new Error('relay unavailable (submission failed)')
  const sharesAfter = await readShares(contractId, { server: s })
  return { hash: relayed.hash, status: relayed.status, sharesBefore, sharesAfter }
}

// Real assembler (covered by the m3plus smoke, not the unit test). Mirrors m3 lines 263–322.
async function defaultBuildDepositInner({ contractId, amount, vault, relayer, kit, server }) {
  const sdk = await import('@stellar/stellar-sdk')
  const { TransactionBuilder, Operation, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const units = typeof amount === 'bigint' ? amount : BigInt(amount)
  const relayerAcct = await server.getAccount(relayer)
  const depositOp = new Contract(vault).call(
    'deposit',
    Address.fromString(contractId).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(units.toString()) }))
  )
  const recRaw = new TransactionBuilder(relayerAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(depositOp)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`deposit sim failed: ${recSim.error}`)
  const entries = recSim.result?.auth ?? []
  if (entries.length !== 1) throw new Error(`expected 1 auth entry, got ${entries.length}`)
  const signed = await kit.signAuthEntry(entries[0]) // Face-ID; SAK owns the ceremony
  const enforcedRaw = new TransactionBuilder(relayerAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [signed] }))
    .setTimeout(60)
    .build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`deposit auth sim failed: ${enfSim.error}`)
  // source = relayer, left UNSIGNED — VF's relay signs source + fee-bumps (user pays 0).
  return rpc.assembleTransaction(enforcedRaw, enfSim).build().toEnvelope().toXDR('base64')
}

// ── approve (self-paid) ─────────────────────────────────────────────────────────
/**
 * Passkey-signed token.approve(spender=vault), fee-paid by a fresh ephemeral Friendbot source.
 * @returns {Promise<{ hash, status }>}
 */
export async function submitApprove({
  contractId,
  amount,
  vault = SOROBAN_VAULT_ADDRESS,
  expiryLedgers = APPROVE_TTL_LEDGERS,
  kit,
  server,
  fund = fundFriendbot,
  makeEphemeral = defaultMakeEphemeral,
  signSubmitApprove = defaultSignSubmitApprove,
}) {
  const s = server ?? (await rpcServer())
  const ephemeral = await makeEphemeral()
  await fund(ephemeral.publicKey())
  return signSubmitApprove({ contractId, amount, vault, expiryLedgers, kit, server: s, ephemeral })
}

async function fundFriendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

async function defaultMakeEphemeral() {
  const { Keypair } = await import('@stellar/stellar-sdk')
  return Keypair.random()
}

// Real approve assembler (covered by the m3plus smoke). source = ephemeral (self-paid).
async function defaultSignSubmitApprove({ contractId, amount, vault, expiryLedgers, kit, server, ephemeral }) {
  const sdk = await import('@stellar/stellar-sdk')
  const { TransactionBuilder, Operation, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const units = typeof amount === 'bigint' ? amount : BigInt(amount)
  const latest = await server.getLatestLedger()
  const expiryLedger = latest.sequence + expiryLedgers
  const { method, args } = buildApprove({ contractId, vault, amount: units, expiryLedger })
  void args // shape asserted by the buildApprove unit test; built explicitly below for SDK ScVals
  const ephAcct = await getAccountWithRetry(server, ephemeral.publicKey())
  const approveOp = new Contract(/* token */ buildApprove({ contractId, vault, amount: units, expiryLedger }).contract).call(
    method,
    Address.fromString(contractId).toScVal(),
    Address.fromString(vault).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(units.toString()) })),
    xdr.ScVal.scvU32(expiryLedger)
  )
  const recRaw = new TransactionBuilder(ephAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(approveOp)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`approve sim failed: ${recSim.error}`)
  const entries = recSim.result?.auth ?? []
  if (entries.length !== 1) throw new Error(`expected 1 auth entry, got ${entries.length}`)
  const signed = await kit.signAuthEntry(entries[0]) // Face-ID over the approve auth entry
  const enforcedRaw = new TransactionBuilder(ephAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [signed] }))
    .setTimeout(60)
    .build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`approve auth sim failed: ${enfSim.error}`)
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(ephemeral) // self-paid: ephemeral signs the source (relay is deposit-only)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`approve rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  const r = await waitSuccess(server, sent.hash, 'approve')
  return { hash: sent.hash, status: r.status }
}

async function getAccountWithRetry(server, pubkey, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await server.getAccount(pubkey)
    } catch {
      await new Promise((res) => setTimeout(res, 1500))
    }
  }
  throw new Error(`account never surfaced on the RPC: ${pubkey}`)
}

async function waitSuccess(server, hashHex, label) {
  let r = await server.getTransaction(hashHex)
  for (let i = 0; i < 30 && r.status === 'NOT_FOUND'; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    r = await server.getTransaction(hashHex)
  }
  if (r.status !== 'SUCCESS') throw new Error(`${label} did not succeed: ${r.status}`)
  return r
}
```

Also add the missing import at the top of the file:

```js
import { SOROBAN_VAULT_ADDRESS } from '../stellar/config.js'
```

> **Note on `defaultSignSubmitApprove`:** it re-derives the token contract from `buildApprove(...).contract` to keep `SOROBAN_TOKEN_ADDRESS` sourced in one place (Task 1). The explicit ScVal op-build (rather than `buildInvokeTx`) mirrors the proven m3 assembly so the auth-entry array is exactly `[smart-account entry]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/wallet/submit.test.js`
Expected: PASS (all `submitDeposit` + `submitApprove` orchestration tests). The real assemblers are not exercised here — the smoke (Task 4) covers them.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/submit.js frontend/src/wallet/submit.test.js
git commit -m "feat(wallet): submitDeposit (gasless relay) + submitApprove (self-paid) on SAK signAuthEntry"
```

---

## Task 3: `/api/faucet` — server token dispense

**Files:**
- Create: `frontend/api/faucet.js`
- Create: `frontend/functions/api/faucet.js`
- Test: `frontend/api/faucet.test.js`
- Modify: `frontend/vite.config.js`
- Modify: `frontend/.env.example`, `frontend/.dev.vars.example`

**Interfaces:**
- HTTP: `POST /api/faucet { action: 'dispense', to: '<C-address>', amount? } → { hash, status }`; `503 { error, configured:false }` when `VF_FAUCET_SECRET` unset.
- Consumes `applyCors`, `rateLimit` from `./_guard.js`; `@stellar/stellar-sdk`; env `VF_FAUCET_SECRET`, `SOROBAN_TOKEN_ADDRESS`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`.
- Produces a `dispenseToken({ secret, token, to, amount, passphrase, sdk, rpcServer }) → { hash, status }` exported pure function (testable, mirrors `feeBumpAndSubmit`).

> **Token mechanism (read first):** `SOROBAN_TOKEN_ADDRESS` is **Blend USDC** — VF does **not** hold its SAC admin key, so a `mint` will not authorize. The faucet therefore does a **`transfer` from a pre-funded vf-deployer treasury** (`from = VF_FAUCET_SECRET` account, which holds testnet Blend USDC obtained out-of-band). The on-chain op is `transfer(from=deployer, to=target, amount)` — the deployer signs as tx source, satisfying `from.require_auth()` via source-account auth. The action is named **`dispense`** (not `mint`) to stay honest. **Prerequisite:** fund the `VF_FAUCET_SECRET` account with testnet Blend USDC before the demo (re-use the existing Blend-USDC faucet path). *Admin alternative:* if a future build uses a VF-admin'd SAC, swap the op to `mint(to, amount)` — same handler, change one op.

- [ ] **Step 1: Write the failing test** — `frontend/api/faucet.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler, { dispenseToken, CAP_BASE_UNITS } from './faucet.js'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
function mockReq(body, { origin = 'http://localhost:5173', method = 'POST' } = {}) {
  return { method, headers: { origin, 'x-real-ip': '1.2.3.4' }, body }
}

beforeEach(() => {
  delete process.env.VF_FAUCET_SECRET
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.SOROBAN_TOKEN_ADDRESS = 'CTOKEN'
})

describe('/api/faucet handler', () => {
  it('returns 503 configured:false when VF_FAUCET_SECRET is unset', async () => {
    const res = mockRes()
    await handler(mockReq({ action: 'dispense', to: 'CACCT' }), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })

  it('rejects a disallowed origin (403)', async () => {
    process.env.VF_FAUCET_SECRET = 'SSECRET'
    const res = mockRes()
    await handler(mockReq({ action: 'dispense', to: 'CACCT' }, { origin: 'https://evil.example' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('405 on non-POST', async () => {
    const res = mockRes()
    await handler(mockReq({}, { method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })
})

describe('dispenseToken (cap + transfer)', () => {
  const sdk = {
    Keypair: { fromSecret: () => ({ publicKey: () => 'GDEPLOYER', sign: vi.fn() }) },
    TransactionBuilder: vi.fn(() => ({
      addOperation() { return this },
      setTimeout() { return this },
      build: () => ({ sign: vi.fn() }),
    })),
    Contract: vi.fn(() => ({ call: vi.fn(() => ({})) })),
    Address: { fromString: () => ({ toScVal: () => ({}) }) },
    xdr: { ScVal: { scvI128: () => ({}) }, Int128Parts: vi.fn(), Int64: { fromString: () => 0n }, Uint64: { fromString: () => 0n } },
    BASE_FEE: '100',
    rpc: { Api: { isSimulationError: () => false }, assembleTransaction: () => ({ build: () => ({ sign: vi.fn() }) }) },
  }
  const rpcServer = {
    getAccount: vi.fn(async () => ({})),
    simulateTransaction: vi.fn(async () => ({ minResourceFee: '1', transactionData: { build: () => ({}) }, result: {} })),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'FHASH' })),
    getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
  }

  it('caps the dispensed amount at CAP_BASE_UNITS', async () => {
    const out = await dispenseToken({
      secret: 'SSECRET', token: 'CTOKEN', to: 'CACCT', amount: 10n ** 18n, // absurdly large
      passphrase: 'Test SDF Network ; September 2015', sdk, rpcServer,
    })
    expect(out.hash).toBe('FHASH')
    // The i128 op was built with the capped value, not the requested one:
    expect(sdk.xdr.Uint64.fromString).toHaveBeenCalledWith(CAP_BASE_UNITS.toString())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run api/faucet.test.js`
Expected: FAIL — `faucet.js` does not exist.

- [ ] **Step 3: Write `api/faucet.js`** (mirror `api/stellar-relay.js` exactly):

```js
// Server-side testnet token faucet. Dispenses a CAPPED amount of the demo SAC token
// (Blend USDC) from a funded VF treasury (VF_FAUCET_SECRET) to a target C-address, so a
// fresh passkey smart account can approve + deposit. The treasury secret is server-held —
// never in the client bundle. Abuse-bounded: origin allowlist + tight per-IP rate limit
// (_guard.js) + a hard server-side amount cap. Testnet only — a mainnet build drops this.
//
//   { action: 'dispense', to: '<C-address>', amount? } → { hash, status }

import { applyCors, rateLimit } from './_guard.js'

const PASSPHRASE = () =>
  process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const FAUCET_SECRET = () => process.env.VF_FAUCET_SECRET || ''
const TOKEN_ADDR = () => process.env.SOROBAN_TOKEN_ADDRESS || ''

// 7-decimal token (SOROBAN_DECIMALS = 7). Cap a single dispense at 100 tokens.
export const CAP_BASE_UNITS = 100n * 10n ** 7n
const DEFAULT_BASE_UNITS = 10n * 10n ** 7n // 10 tokens default

export class FaucetError extends Error {}

/**
 * transfer(from=treasury, to, amount) of the SAC token; treasury (secret) signs the source.
 * @returns {Promise<{ hash, status }>}
 */
export async function dispenseToken({ secret, token, to, amount, passphrase, sdk, rpcServer, pollTries = 10, pollIntervalMs = 1500 }) {
  const { Keypair, TransactionBuilder, Operation, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const capped = amount && BigInt(amount) > 0n ? (BigInt(amount) > CAP_BASE_UNITS ? CAP_BASE_UNITS : BigInt(amount)) : DEFAULT_BASE_UNITS
  const kp = Keypair.fromSecret(secret)
  const source = await rpcServer.getAccount(kp.publicKey())
  const op = new Contract(token).call(
    'transfer',
    Address.fromString(kp.publicKey()).toScVal(),
    Address.fromString(to).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(capped.toString()) }))
  )
  const raw = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(60)
    .build()
  const sim = await rpcServer.simulateTransaction(raw)
  if (rpc.Api.isSimulationError(sim)) throw new FaucetError(`faucet sim failed: ${sim.error}`)
  const prepared = rpc.assembleTransaction(raw, sim).build()
  prepared.sign(kp)
  const sent = await rpcServer.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new FaucetError('RPC rejected the faucet transfer')
  for (let i = 0; i < pollTries; i++) {
    const r = await rpcServer.getTransaction(sent.hash)
    if (r.status && r.status !== 'NOT_FOUND') return { hash: sent.hash, status: r.status }
    if (pollIntervalMs) await new Promise((res) => setTimeout(res, pollIntervalMs))
  }
  return { hash: sent.hash, status: 'PENDING' }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}
function bad(res, msg) {
  res.statusCode = 400
  return res.end(JSON.stringify({ error: msg }))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }
  if (!applyCors(req, res)) return
  if (!rateLimit(req, res, { max: 3, windowMs: 60_000, bucket: 'faucet' })) return
  res.setHeader('Content-Type', 'application/json')

  const secret = FAUCET_SECRET()
  if (!secret) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Faucet not configured', configured: false }))
  }
  try {
    const body = await readBody(req)
    if (body.action !== 'dispense') return bad(res, 'Unknown action')
    if (typeof body.to !== 'string' || !body.to) return bad(res, 'Invalid recipient')
    const token = TOKEN_ADDR()
    if (!token) {
      res.statusCode = 503
      return res.end(JSON.stringify({ error: 'Faucet token unset', configured: false }))
    }
    const mod = await import('@stellar/stellar-sdk')
    const sdk = {
      Keypair: mod.Keypair, TransactionBuilder: mod.TransactionBuilder, Operation: mod.Operation,
      Contract: mod.Contract, Address: mod.Address, xdr: mod.xdr, BASE_FEE: mod.BASE_FEE, rpc: mod.rpc,
    }
    const rpcServer = new mod.rpc.Server(RPC_URL())
    const out = await dispenseToken({ secret, token, to: body.to, amount: body.amount, passphrase: PASSPHRASE(), sdk, rpcServer })
    return res.end(JSON.stringify(out))
  } catch (err) {
    console.error('[api/faucet] error:', err?.message || err)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Faucet failed' }))
  }
}
```

- [ ] **Step 4: Write the Pages wrapper** — `frontend/functions/api/faucet.js`:

```js
// Cloudflare Pages Function → /api/faucet. Thin wrapper over ../../api/faucet.js.
// Requires `nodejs_compat` (already set in wrangler.jsonc): dynamically imports
// @stellar/stellar-sdk and reads process.env.VF_FAUCET_SECRET / SOROBAN_TOKEN_ADDRESS.
import handler from '../../api/faucet.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
```

- [ ] **Step 5: Wire `/api/faucet` into `vite.config.js`** — add the import + the three middleware lines + env propagation:

```js
// near the other proxy imports (after stellarRelayProxy):
import faucetProxy from './api/faucet.js'
```
```js
// in the env-propagation block (after SOROBAN_VAULT_ADDRESS):
  if (env.VF_FAUCET_SECRET) process.env.VF_FAUCET_SECRET = env.VF_FAUCET_SECRET
  if (env.SOROBAN_TOKEN_ADDRESS) process.env.SOROBAN_TOKEN_ADDRESS = env.SOROBAN_TOKEN_ADDRESS
```
```js
// in BOTH configureServer(s) and configurePreviewServer(s), after the stellar-relay line:
      s.middlewares.use('/api/faucet', faucetProxy)
```

- [ ] **Step 6: Add env keys** — append to `frontend/.env.example` AND `frontend/.dev.vars.example`, in the Soroban server-side group:

```bash
# Testnet token faucet (server-only; leave unset to disable /api/faucet with 503)
VF_FAUCET_SECRET=S...                    # vf-deployer secret; treasury must hold testnet Blend USDC
SOROBAN_TOKEN_ADDRESS=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run api/faucet.test.js`
Expected: PASS (503 unset, 403 origin, 405 method, cap enforcement).

- [ ] **Step 8: Commit**

```bash
git add frontend/api/faucet.js frontend/functions/api/faucet.js frontend/api/faucet.test.js frontend/vite.config.js frontend/.env.example frontend/.dev.vars.example
git commit -m "feat(api): /api/faucet testnet token dispense (capped, gated, rate-limited)"
```

---

## Task 4: Headless smoke — fund → approve → deposit → shares minted

**Files:**
- Create: `frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs`

**Interfaces:**
- Consumes: the proven m3 building blocks (`signAuthEntryWithPasskey`, `makeSyntheticSigner`, `deploySmartAccount`, `fundFriendbot` — copy from `m3-deposit-smoke.mjs`); `/api/faucet` (via `VF_RELAY_URL` host or a direct fetch); `submitViaRelay` from `../src/stellar/relay.js`; `readVaultShares`, `readTokenBalance` from `../src/stellar/agentDeposit.js`.
- Produces: a runnable testnet proof that closes the m3 "funded+approved → SHARES MINTED" gap end-to-end headlessly. Node has no WebAuthn, so it uses the synthetic P-256 signer (the M0b recipe) instead of `kit.signAuthEntry` — the on-chain auth path is identical.

> This is an integration smoke, not a unit test. It is the coverage for `submit.js`'s real assemblers and `/api/faucet`. It needs the dev server (for `/api/faucet` + `/api/stellar-relay`), `STELLAR_RELAYER_SECRET`, `VF_FAUCET_SECRET` (funded), and `VF_RELAY_URL` set to the dev origin.

- [ ] **Step 1: Write the smoke script** — `frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs`:

```js
// frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs
//
// Closes the m3 gap: fund (faucet) -> approve (passkey, self-paid) -> deposit (passkey, relayed)
// -> SHARES MINTED, headlessly. Node has no WebAuthn so we reuse the M0b synthetic P-256 signer
// (the same recipe that PASSED on-chain at M0b); the Soroban auth path is identical to the
// browser kit.signAuthEntry path. Mirrors m3-deposit-smoke.mjs and adds the faucet + approve legs.
//
// Run (vite-node; needs the dev server up for /api/faucet + /api/stellar-relay):
//   cd frontend && VF_RELAY_URL=http://localhost:5173 npx vite-node scripts/m3plus-fund-approve-deposit-smoke.mjs --submit

import { Keypair, TransactionBuilder, Operation, Contract, Address, xdr, hash, StrKey, BASE_FEE, rpc } from '@stellar/stellar-sdk'
import { createHash, webcrypto } from 'node:crypto'
import { normalizeLowS, buildChallenge, assembleSecp256r1Signature } from '../src/wallet/passkey.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, SOROBAN_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } from '../src/stellar/config.js'
import { ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ADDRESS, RP_ID } from '../src/wallet/config.js'
import { readVaultShares, readTokenBalance } from '../src/stellar/agentDeposit.js'
import { submitViaRelay } from '../src/stellar/relay.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'

const FAUCET_URL = (process.env.VF_RELAY_URL || 'http://localhost:5173') + '/api/faucet'
const FRIENDBOT = 'https://friendbot.stellar.org'
const server = new rpc.Server(SOROBAN_RPC_URL)
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest())
const subtle = webcrypto.subtle
const DEPOSIT_AMOUNT = 1n

// ---- copy these verbatim from m3-deposit-smoke.mjs (unchanged): ----
//   fundFriendbot, getAccountWithRetry, waitSuccess, externalSignerScVal,
//   makeSyntheticSigner, signAuthEntryWithPasskey, deploySmartAccount
// (they are the proven on-chain auth recipe; do not re-derive them)

async function dispense(to) {
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: process.env.VF_RELAY_URL || 'http://localhost:5173' },
    body: JSON.stringify({ action: 'dispense', to }),
  })
  if (!res.ok) throw new Error(`faucet failed (${res.status}): ${await res.text()}`)
  return res.json()
}

// Build + synthetic-sign + submit a SAC approve from an ephemeral self-paid source.
async function approveViaPasskey({ contractId, kp, keyData }) {
  const ephemeral = Keypair.random()
  await fundFriendbot(ephemeral.publicKey())
  const ephAcct = await getAccountWithRetry(ephemeral.publicKey())
  const latest = await server.getLatestLedger()
  const expiry = latest.sequence + 17_280
  const op = new Contract(SOROBAN_TOKEN_ADDRESS).call(
    'approve',
    Address.fromString(contractId).toScVal(),
    Address.fromString(SOROBAN_VAULT_ADDRESS).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString((100n * 10n ** 7n).toString()) })),
    xdr.ScVal.scvU32(expiry)
  )
  const recRaw = new TransactionBuilder(ephAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).addOperation(op).setTimeout(60).build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`approve rec-sim failed: ${recSim.error}`)
  const entry = await signAuthEntryWithPasskey({ entry: recSim.result.auth[0], kp, keyData })
  const enforcedRaw = new TransactionBuilder(ephAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).setSorobanData(recSim.transactionData.build()).addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [entry] })).setTimeout(60).build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`approve enf-sim failed: ${enfSim.error}`)
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(ephemeral)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error(`approve rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  await waitSuccess(sent.hash, 'approve')
  console.log('approve OK:', sent.hash)
}

async function main() {
  console.log('=== M3+ fund -> approve -> deposit smoke ===')
  const { facts } = vaultFacts(process.env.VF_PROTOCOL || 'aave-v3')
  const eligibility = (p) => vfEligibility({ ...p, facts })
  const probe = await eligibility({ vault: SOROBAN_VAULT_ADDRESS, amount: DEPOSIT_AMOUNT })
  if (!probe.allow) { console.log('F8 rejected; re-run with VF_PROTOCOL=aave-v3'); return }

  const { kp, keyData } = await makeSyntheticSigner()
  const deployer = Keypair.random()
  await fundFriendbot(deployer.publicKey())
  const { contractId } = await deploySmartAccount({ deployer, keyData })
  console.log('account:', contractId)

  console.log('faucet:', await dispense(contractId))
  for (let i = 0; i < 20; i++) {
    const bal = await readTokenBalance(contractId, { server })
    if (bal && bal > 0n) { console.log('balance:', bal.toString()); break }
    await new Promise((r) => setTimeout(r, 1500))
  }
  await approveViaPasskey({ contractId, kp, keyData })

  const sharesBefore = await readVaultShares(contractId, { server })
  // deposit leg: build (source=relayer), synthetic-sign, relay — identical to m3 lines 263-332
  // (copy that block here, substituting the relayer source for the deployer source).
  const relayerAddr = (await (await fetch((process.env.VF_RELAY_URL || 'http://localhost:5173') + '/api/stellar-relay', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: process.env.VF_RELAY_URL || 'http://localhost:5173' },
    body: JSON.stringify({ action: 'wallet' }),
  })).json()).address
  const relayerAcct = await getAccountWithRetry(relayerAddr)
  const depositOp = new Contract(SOROBAN_VAULT_ADDRESS).call(
    'deposit',
    Address.fromString(contractId).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(DEPOSIT_AMOUNT.toString()) }))
  )
  const recRaw = new TransactionBuilder(relayerAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).addOperation(depositOp).setTimeout(60).build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`deposit rec-sim failed: ${recSim.error}`)
  const entry = await signAuthEntryWithPasskey({ entry: recSim.result.auth[0], kp, keyData })
  const enforcedRaw = new TransactionBuilder(relayerAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(), networkPassphrase: NETWORK_PASSPHRASE,
  }).setSorobanData(recSim.transactionData.build()).addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [entry] })).setTimeout(60).build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`deposit enf-sim failed: ${enfSim.error}`)
  const preparedXdr = rpc.assembleTransaction(enforcedRaw, enfSim).build().toEnvelope().toXDR('base64')
  const relayed = await submitViaRelay({ xdr: preparedXdr })
  if (!relayed) throw new Error('relay unconfigured — set STELLAR_RELAYER_SECRET + start dev server')
  console.log('deposit relayed:', relayed.hash, relayed.status)
  const sharesAfter = await readVaultShares(contractId, { server })
  console.log('shares:', sharesBefore?.toString(), '->', sharesAfter?.toString())
  if (sharesBefore != null && sharesAfter != null && sharesAfter > sharesBefore) console.log('SHARES MINTED — m3+ end-to-end passed.')
  else throw new Error('shares did not increase')
}
main().catch((e) => { console.error('m3+ smoke error:', e?.message || e); process.exitCode = 1 })
```

- [ ] **Step 2: Start the dev server** (separate terminal)

Run: `cd frontend && npm run dev`
Expected: Vite serves on `http://localhost:5173` with `/api/faucet` + `/api/stellar-relay` middleware mounted. Ensure `.env.local` has `STELLAR_RELAYER_SECRET`, `VF_FAUCET_SECRET` (treasury funded with testnet Blend USDC), `SOROBAN_TOKEN_ADDRESS`, `SOROBAN_VAULT_ADDRESS`.

- [ ] **Step 3: Run the smoke**

Run: `cd frontend && VF_RELAY_URL=http://localhost:5173 npx vite-node scripts/m3plus-fund-approve-deposit-smoke.mjs --submit`
Expected: prints `account: C…`, `faucet: { hash, status:'SUCCESS' }`, `balance: …`, `approve OK: …`, `deposit relayed: … SUCCESS`, and finally **`SHARES MINTED — m3+ end-to-end passed.`** If it fails on the deposit with a non-auth trap, the approve/balance leg didn't land — inspect the faucet + approve hashes on Stellar Expert.

- [ ] **Step 4: Verify the `kit.signAuthEntry` credentialId assumption (research follow-up)**

Add a one-off log to confirm a connected SAK kit exposes `signAuthEntry` and a default `credentialId` after `connectWallet({ contractId })`:
Run: `cd frontend && npx vite-node -e "import('./src/wallet/account.js').then(async m => { const k = await m.makeKit(); console.log('signAuthEntry?', typeof k.signAuthEntry); })"`
Expected: `signAuthEntry? function`. (If `connectWallet` does not set a default credentialId, Task 6's ceremony must pass `credentialId` into `kit.signAuthEntry(entry, { credentialId })` — note it for Task 6.)

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/m3plus-fund-approve-deposit-smoke.mjs
git commit -m "test(smoke): m3plus fund->approve->deposit proves shares minted end-to-end"
```

---

## Task 5: Extension — action-carrying ceremony tab + background routing

**Files:**
- Modify: `frontend/extension/ceremony.js`
- Modify: `frontend/extension/ceremony.html`
- Modify: `frontend/extension/background.js`
- Test: `frontend/extension/background.test.js`

**Interfaces:**
- Background consumes `SIGN_REQUEST { action, params }` from the popup; opens `ceremony.html?action=…` and (for params too large for a query string) stashes params in `chrome.storage.session`.
- Background consumes `CEREMONY_RESULT { action, ok, hash, status, sharesBefore?, sharesAfter?, error? }` from the tab; persists it to `chrome.storage.session` (key `vf_last_result`) AND forwards to any open popup.
- Ceremony tab produces `CEREMONY_RESULT` by running `submit.js` against a connected SAK kit.

- [ ] **Step 1: Write the failing test** — extend/replace `frontend/extension/background.test.js` (router is already pure-testable via injected `env`):

```js
import { describe, it, expect, vi } from 'vitest'
import { handleMessage } from './background.js'

describe('background router — action ceremony', () => {
  it('opens ceremony.html with the action and stashes params in session storage', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 7 })) }
    const session = { set: vi.fn(async () => {}) }
    await handleMessage(
      { type: 'SIGN_REQUEST', action: 'deposit', params: { contractId: 'CACCT', amount: '1.5' } },
      { tabs, storageSession: session },
      vi.fn()
    )
    expect(tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('action=deposit'), active: true }))
    expect(session.set).toHaveBeenCalledWith(expect.objectContaining({ ['vf_params_7']: { contractId: 'CACCT', amount: '1.5' } }))
  })

  it('persists CEREMONY_RESULT to session and forwards it to the popup', async () => {
    const session = { set: vi.fn(async () => {}) }
    const runtime = { sendMessage: vi.fn() }
    await handleMessage(
      { type: 'CEREMONY_RESULT', action: 'deposit', ok: true, hash: 'H', status: 'SUCCESS', sharesBefore: '0', sharesAfter: '5' },
      { storageSession: session, runtime },
      vi.fn()
    )
    expect(session.set).toHaveBeenCalledWith(expect.objectContaining({ vf_last_result: expect.objectContaining({ ok: true, hash: 'H' }) }))
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SIGN_RESULT', ok: true, hash: 'H' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run extension/background.test.js`
Expected: FAIL — router still uses the old `SIGN_REQUEST { challenge, rpId }` shape, no `storageSession`.

- [ ] **Step 3: Rewrite `background.js`** as the action router:

```js
// Pure-ish router so it is unit-testable; chrome.* injected as `env`.
const inflight = new Map()

export async function handleMessage(msg, env, reply) {
  const tabs = env.tabs ?? chrome.tabs
  const storageSession = env.storageSession ?? chrome.storage?.session
  const runtime = env.runtime ?? chrome.runtime
  const pending = env.pending ?? inflight

  if (msg.type === 'SIGN_REQUEST') {
    const base =
      typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome.runtime.getURL('ceremony.html') : 'ceremony.html'
    const url = `${base}?action=${encodeURIComponent(msg.action)}`
    const tab = await tabs.create({ url, active: true })
    if (storageSession?.set) await storageSession.set({ [`vf_params_${tab.id}`]: msg.params ?? {} })
    pending.set(tab.id, reply)
    return
  }

  if (msg.type === 'CEREMONY_RESULT') {
    const result = { type: 'SIGN_RESULT', action: msg.action, ok: msg.ok, hash: msg.hash, status: msg.status, sharesBefore: msg.sharesBefore, sharesAfter: msg.sharesAfter, error: msg.error }
    if (storageSession?.set) await storageSession.set({ vf_last_result: { ...result, at: Date.now() } })
    // Forward to an open popup (best-effort; the popup may have been dismissed by Face-ID).
    runtime?.sendMessage?.(result)
    const r = pending.get(msg.tabId)
    if (r) {
      r(result)
      pending.delete(msg.tabId)
    }
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg, {}, sendResponse)
    return true
  })
}
```

- [ ] **Step 4: Run the router test**

Run: `cd frontend && npx vitest run extension/background.test.js`
Expected: PASS.

- [ ] **Step 5: Rewrite `ceremony.js`** as the action runner:

```js
import { makeKit, connectPasskeyWallet } from '../src/wallet/account.js'
import { submitDeposit, submitApprove } from '../src/wallet/submit.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'

const params = new URLSearchParams(location.search)
const action = params.get('action')
const setStatus = (t) => { const el = document.getElementById('status'); if (el) el.textContent = t }

async function loadParams() {
  const tabId = (await chrome.tabs.getCurrent())?.id
  const got = await chrome.storage.session.get(`vf_params_${tabId}`)
  return { tabId, p: got[`vf_params_${tabId}`] ?? {} }
}

;(async () => {
  const { tabId, p } = await loadParams()
  try {
    const kit = await makeKit()
    await connectPasskeyWallet({ contractId: p.contractId, kit })
    let out
    if (action === 'deposit') {
      setStatus('Awaiting Face ID…')
      const { facts } = vaultFacts(p.protocol || 'aave-v3')
      const eligibility = (q) => vfEligibility({ ...q, facts })
      const amount = BigInt(Math.round(parseFloat(p.amount) * 1e7))
      out = await submitDeposit({ contractId: p.contractId, amount, eligibility, kit })
      setStatus(`Minted ${BigInt(out.sharesAfter) - BigInt(out.sharesBefore)} shares.`)
      chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', tabId, action, ok: true, hash: out.hash, status: out.status, sharesBefore: String(out.sharesBefore), sharesAfter: String(out.sharesAfter) })
    } else if (action === 'approve') {
      setStatus('Enabling deposits — funding + Face ID…')
      // Idempotent: mint only if the balance is low, then (re)issue the approve.
      const { readBalance } = await import('../src/wallet/account.js')
      const bal = await readBalance(p.contractId)
      if (!bal || bal < 10n ** 7n) {
        await fetch('/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dispense', to: p.contractId }) })
      }
      out = await submitApprove({ contractId: p.contractId, amount: 100n * 10n ** 7n, kit })
      setStatus('Deposits enabled.')
      chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', tabId, action, ok: true, hash: out.hash, status: out.status })
    } else {
      throw new Error(`unknown ceremony action: ${action}`)
    }
    setTimeout(() => window.close(), 1200)
  } catch (e) {
    setStatus(`Failed: ${e.message}`)
    chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', tabId, action, ok: false, error: String(e.message || e) })
  }
})()
```

> **If Task 4 Step 4 found no default `credentialId`:** capture it from `connectPasskeyWallet`'s return (extend `account.js connectPasskeyWallet` to also return `credentialId`) and pass `kit.signAuthEntry(entry, { credentialId })` inside `submit.js` (thread a `credentialId` option through `submitDeposit`/`submitApprove`).

- [ ] **Step 6: Update `ceremony.html`** to show live status:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>VF Wallet — Passkey ceremony</title>
  </head>
  <body>
    <p id="status">Starting passkey ceremony…</p>
    <script type="module" src="./ceremony.js"></script>
  </body>
</html>
```

- [ ] **Step 7: Run the full extension test subset**

Run: `cd frontend && npx vitest run extension/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/extension/ceremony.js frontend/extension/ceremony.html frontend/extension/background.js frontend/extension/background.test.js
git commit -m "feat(ext): action-carrying ceremony tab + background result routing"
```

---

## Task 6: Popup — Enable-deposits + real Deposit + honest result

**Files:**
- Modify: `frontend/extension/popup.jsx`
- Modify: `frontend/src/wallet/ui/HonestyLabels.jsx`

**Interfaces:**
- Consumes background `SIGN_RESULT` (via `chrome.runtime.onMessage`) and `chrome.storage.session` key `vf_last_result` (read on mount — the popup may have been dismissed by Face-ID).
- Sends `SIGN_REQUEST { action: 'deposit' | 'approve', params: { contractId, amount, protocol? } }`.

- [ ] **Step 1: Replace `postSignRequest`** in `popup.jsx` with an action sender (drops the demo `base64url(sha256(xdr))` challenge):

```jsx
function postSignRequest(action, params) {
  chrome.runtime.sendMessage({ type: 'SIGN_REQUEST', action, params })
}
```

- [ ] **Step 2: Rewrite `handleDepositApprove`** as the two-action flow:

```jsx
async function handleEnableDeposits() {
  clear()
  setStatus('Opening Enable-deposits ceremony…')
  postSignRequest('approve', { contractId: wallet.contractId })
  setScreen('signing-pending')
}

async function handleDepositApprove() {
  clear()
  try {
    // Re-run the F8 gate in-popup for an early verdict; the ceremony re-asserts fail-closed.
    await depositToVault({
      contractId: wallet.contractId,
      amount: BigInt(Math.round(parseFloat(depositAmount) * 1e7)),
      eligibility,
    })
    postSignRequest('deposit', { contractId: wallet.contractId, amount: depositAmount })
    setStatus('Opening deposit ceremony — approve with Face ID in the new tab…')
    setDepositVerdict(null)
    setScreen('signing-pending')
  } catch (e) {
    // An allowance/balance trap routes the user to Enable deposits instead of failing.
    if (/allowance|balance|insufficient/i.test(e.message)) {
      setError('Deposits not enabled yet — tap "Enable deposits" first.')
    } else {
      setError(e.message)
    }
  }
}
```

Add an **Enable deposits** button on the deposit screen next to **Approve & Deposit** (wire `onClick={handleEnableDeposits}`).

- [ ] **Step 3: Read results — add a mount effect + message listener** in the popup component:

```jsx
useEffect(() => {
  // The popup may have been dismissed during Face-ID; recover the last result on reopen.
  chrome.storage?.session?.get?.('vf_last_result').then((g) => {
    const r = g?.vf_last_result
    if (r) applyResult(r)
  })
  const onMsg = (m) => { if (m?.type === 'SIGN_RESULT') applyResult(m) }
  chrome.runtime?.onMessage?.addListener(onMsg)
  return () => chrome.runtime?.onMessage?.removeListener(onMsg)
}, [])

function applyResult(r) {
  if (!r.ok) { setError(r.error || 'Ceremony failed'); setScreen('home'); return }
  if (r.action === 'deposit') {
    const minted = BigInt(r.sharesAfter ?? '0') - BigInt(r.sharesBefore ?? '0')
    setStatus(`Minted ${minted} shares. tx: ${r.hash}`)
  } else if (r.action === 'approve') {
    setStatus('Deposits enabled — you can deposit now.')
  }
  setLastTx(r.hash || null) // new state: const [lastTx, setLastTx] = useState(null)
  setScreen('result')
}
```

- [ ] **Step 4: Replace the `signing-pending` copy + add a real `result` screen** — swap the "No transfer is submitted yet" block (current lines ~293–296) for honest copy and a result view with the Stellar Expert link:

```jsx
// signing-pending screen body:
<p>Approve with Face ID in the ceremony tab. This popup may be dismissed — reopen it to see the result.</p>

// new 'result' screen:
{screen === 'result' && (
  <div>
    <p data-testid="result-status">{status}</p>
    {lastTx && (
      <a href={`https://stellar.expert/explorer/testnet/tx/${lastTx}`} target="_blank" rel="noreferrer">
        View on Stellar Expert
      </a>
    )}
    <button onClick={() => setScreen('home')}>Done</button>
  </div>
)}
```

- [ ] **Step 5: Update the deposit HonestyLabel** — `src/wallet/ui/HonestyLabels.jsx` line 12: keep the F8 on-chain disclaimer (still true) but drop any "ceremony only / not submitted" implication. Current value is accurate (F8 app-layer) — **no change required** unless a "not submitted" string exists there; verify with `rg "not submitted|ceremony round" src/wallet/ui/HonestyLabels.jsx` (expected: no matches → leave as-is).

- [ ] **Step 6: Run the popup/unit suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — full suite green (404 + new tests). Fix any popup test that asserted the old "not submitted yet" copy to assert the new honest copy.

- [ ] **Step 7: Commit**

```bash
git add frontend/extension/popup.jsx frontend/src/wallet/ui/HonestyLabels.jsx
git commit -m "feat(ext): popup Enable-deposits + real deposit result with tx link + honest copy"
```

---

## Task 7: Rebuild + manual Chrome E2E + final verification

**Files:**
- Build output: `frontend/extension-dist/` (generated)

**Interfaces:** none (verification task).

- [ ] **Step 1: Full suite green**

Run: `cd frontend && npx vitest run`
Expected: PASS — 404 baseline + all new tests, 0 failures.

- [ ] **Step 2: Build the extension**

Run: `cd frontend && npm run build:ext`
Expected: `extension-dist/` rebuilt with `popup.js`, `ceremony.js` (SAK bundled), `background.js`, `popup.html`, `ceremony.html`, `manifest.json`. No build errors.

- [ ] **Step 3: Re-run the headless end-to-end smoke** (regression gate before manual)

Run: `cd frontend && VF_RELAY_URL=http://localhost:5173 npx vite-node scripts/m3plus-fund-approve-deposit-smoke.mjs --submit` (dev server up)
Expected: `SHARES MINTED — m3+ end-to-end passed.`

- [ ] **Step 4: Manual Chrome E2E** (real Face-ID can't run headless — documented manual gate). Record with GIF if useful.

  1. `chrome://extensions` → Developer mode → **Load unpacked** → select `frontend/extension-dist` (Chrome ≥ 122 per manifest).
  2. Open the popup → **Create wallet** (Face-ID) → home shows a contract id + balance.
  3. Deposit screen → enter an amount → **Enable deposits**: a ceremony tab opens ("Enabling deposits — funding + Face ID…") → Face-ID → "Deposits enabled."
  4. **Approve & Deposit**: ceremony tab → Face-ID → "Minted N shares."
  5. Reopen the popup → **result** screen shows the minted shares + a working **Stellar Expert** tx link.
  6. Confirm on Stellar Expert: the deposit tx succeeded and the account's vault shares increased.

- [ ] **Step 5: Final honesty sweep**

Run: `cd frontend && rg -n "not submitted|ceremony round-trip|testnet batch" extension/ src/wallet/`
Expected: no stale "not submitted / runs in the testnet batch" copy remains on the deposit path. Any match → update to the real-submit copy.

- [ ] **Step 6: Commit the rebuilt dist (if tracked)**

```bash
git add frontend/extension-dist
git commit -m "build(ext): rebuild extension-dist with real deposit submit flow"
```

> If `extension-dist` is gitignored (per the recent `chore: gitignore extension-dist build output` commit), skip Step 6 — the build is regenerated, not committed.

---

## Self-Review (done while writing — recorded for the implementer)

- **Spec coverage:** §5.1 submit.js → Task 2; §5.2 buildApprove → Task 1; §5.3 faucet → Task 3; §5.4 ceremony → Task 5; §5.5 background → Task 5; §5.6 popup → Task 6; §6/§6b data flows → Tasks 5–6; §7 error handling → submit.js throws + popup routing (Task 2/6); §8 tests → Tasks 1–4 units + Task 4 smoke + Task 7 manual; §9 build order → Tasks 1–7; §10 security → Task 3 (gate/cap/rate-limit, secret server-only, relay stays deposit-only) + Global Constraints.
- **Deviations from spec (deliberate, with reason):**
  1. Faucet action `mint` → **`dispense`** and op = **`transfer` from a funded treasury** (not `mint`): `SOROBAN_TOKEN_ADDRESS` is Blend USDC, which VF does not admin (memory: no admin key). Honest naming; `mint` kept as a one-op swap for a future VF-admin'd SAC.
  2. `buildApprove` is **pure/data-only** (returns `{contract, method, args}`) rather than returning XDR like `depositToVault`: keeps it RPC-free and trivially unit-testable (spec §8 asks only for "arg shape"); `submitApprove` does the RPC assembly.
  3. `submit.js` does **not** call `kit.wallet.deposit` (which would submit from SAK's own source) — it uses `kit.signAuthEntry` + manual assembly so the inner source is the relayer (gasless) / ephemeral (approve), per the m3 proof.
- **Type consistency:** `submitDeposit` returns `{ hash, status, sharesBefore, sharesAfter }` (Task 2) — consumed unchanged by ceremony.js (Task 5) and popup `applyResult` (Task 6). `CEREMONY_RESULT`/`SIGN_RESULT` carry the same field names across background/ceremony/popup. `buildApprove` arg order (Task 1) matches `submitApprove`'s explicit op-build and the smoke (Task 4) and SEP-41 (`from, spender, amount, expiration_ledger`).
- **Open risk flagged for execution:** the `kit.signAuthEntry` default-`credentialId` assumption is verified in Task 4 Step 4 with a Task 6 fallback (thread `credentialId` explicitly) if it fails.

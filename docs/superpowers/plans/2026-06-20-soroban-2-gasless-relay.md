# Sub-project 2 — Soroban Gasless Relay (fee-bump) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the EVM 1Shot relay with a Stellar-native gasless relay: a server endpoint that wraps an agent-signed inner Soroban transaction in a **fee-bump** paid by a server-held relayer keypair, submits it via Soroban RPC, and polls it to a result — so the user/agent pays 0 XLM.

**Architecture:** The relay is a **dumb fee sponsor**. The client (step 3 worker, not this sub-project) builds + simulates + signs the inner `vault.deposit(agent, amount)` transaction (the agent custom account authorizes via its `__check_auth` ed25519 auth entry). It POSTs the inner-tx XDR to `/api/stellar-relay`. The server parses it, validates it targets the deployed vault's `deposit`, wraps it with `TransactionBuilder.buildFeeBumpTransaction` signed by `STELLAR_RELAYER_SECRET`, submits via `rpc.Server.sendTransaction`, polls `getTransaction`, and returns `{ hash, status }`. Mirrors the existing `api/relay.js` proxy shape (default `handler(req,res)`, `_guard.js` CORS + rate-limit, vite dev middleware + Cloudflare Pages Function wrapper).

**Tech Stack:** `@stellar/stellar-sdk` (fee-bump builder + `rpc.Server`), Node serverless handler, Vite dev middleware, Cloudflare Pages Functions, Vitest.

## Global Constraints

These apply to every task. Exact values copied from the spec + deployment manifest.

- **Network passphrase (EXACT):** `Test SDF Network ; September 2015`
- **Soroban RPC:** `https://soroban-testnet.stellar.org`
- **Deployed vault (fee-bump target allowlist):** `CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF` (from `deployments/stellar-testnet.json` → `rwa.vault`)
- **Deposit entrypoint (1a/1c pin):** `deposit(from: Address, amount: i128)`, function symbol `deposit`, `amount` = `args[1]`.
- **Relayer secret is SERVER-ONLY:** read from `process.env.STELLAR_RELAYER_SECRET` (an `S...` secret key). NEVER import it into `src/` or any `VITE_`-prefixed var — it must not reach the client bundle (same rule as `ONESHOT_*`).
- **Do NOT touch the EVM relay** (`api/relay.js`, `src/relay.js`, `functions/api/relay.js`). EVM decommission is sub-project 6 (last); both stacks coexist during migration. All new code lives under `frontend/src/stellar/`, `frontend/api/stellar-relay.js`, `frontend/functions/api/stellar-relay.js`.
- **Inner-source funding is OUT OF SCOPE (step 3 owns it):** a fee-bump's inner transaction has a source G-account that must already exist on-ledger with min reserve. The relay only sponsors the **transaction fee**, not account reserves. Session-account creation + friendbot/sponsored-reserve funding belongs to sub-project 3 (worker/wallet). This sub-project's tests/smoke script friendbot-fund their own throwaway inner account.
- **ESM, immutable style, no `console.log` in shipped `src/` code** (server handler logging via `console.error` for diagnostics is allowed, matching `api/relay.js`).
- **Tests:** Vitest. `vi.mock` for the SDK. Mirror `src/relay.test.js` (mock `global.fetch`) for client tests. Default `vitest run` must stay deterministic — the live testnet check is a manual script, not an auto-test.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/stellar/config.js` | Public Stellar testnet constants (passphrase, RPC, vault addr, relay proxy URL). Client-safe, SDK-free. |
| `frontend/src/stellar/relay.js` | Client helper: `submitViaRelay({xdr})`, `getRelayerAddress()`. Pure `fetch`, no SDK. |
| `frontend/src/stellar/relay.test.js` | Unit tests for the client helper (mock `fetch`). |
| `frontend/api/stellar-relay.js` | Server endpoint: default `handler`, named `feeBumpAndSubmit`, `assertVaultDeposit`, `_clearSeen`. |
| `frontend/api/stellar-relay.test.js` | Unit tests for the server core (mock SDK + req/res). |
| `frontend/functions/api/stellar-relay.js` | Cloudflare Pages Function wrapper (`toPagesFunction(handler)`). |
| `frontend/scripts/stellar-relay-smoke.mjs` | Manual live-testnet proof: real fee-bump of a no-auth Soroban tx; asserts server paid the fee. |
| `frontend/vite.config.js` (modify) | Propagate `STELLAR_*` env to `process.env`; register `/api/stellar-relay` dev+preview middleware. |
| `frontend/.env.example` (modify) | Document `STELLAR_RELAYER_SECRET`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `SOROBAN_VAULT_ADDRESS`. |
| `frontend/package.json` (modify) | Add `@stellar/stellar-sdk`. |

**Cross-task interface (pin these names — every task depends on them):**
- `config.js` exports: `NETWORK_PASSPHRASE`, `SOROBAN_RPC_URL`, `SOROBAN_VAULT_ADDRESS`, `RELAY_PROXY_URL` (all strings).
- `submitViaRelay({ xdr }) → Promise<{ hash, status, relayer } | null>`
- `getRelayerAddress() → Promise<string | null>`
- `feeBumpAndSubmit({ xdr, secret, passphrase, vaultAddr, sdk, rpcServer }) → Promise<{ hash, status, relayer }>`
  - `sdk = { TransactionBuilder, FeeBumpTransaction, Keypair, Address }`
  - `rpcServer = { sendTransaction(tx), getTransaction(hash) }`
- `assertVaultDeposit(innerTx, vaultAddr, sdk) → void` (throws `RelayError` on mismatch; no-op when `vaultAddr` is falsy)
- `_clearSeen() → void` (test hook — clears the warm replay cache)

---

## Task 1: Dependency + Stellar config constants

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/.env.example`
- Create: `frontend/src/stellar/config.js`
- Test: `frontend/src/stellar/config.test.js`

**Interfaces:**
- Produces: `NETWORK_PASSPHRASE`, `SOROBAN_RPC_URL`, `SOROBAN_VAULT_ADDRESS`, `RELAY_PROXY_URL` — consumed by Tasks 2/3/6.

- [ ] **Step 1: Install the SDK**

Run: `cd frontend && npm install @stellar/stellar-sdk`
Expected: adds `@stellar/stellar-sdk` (>= 12, for the `rpc.Server` export) to `dependencies`. Pin the resolved version (do not loosen to `*`).

- [ ] **Step 2: Write the failing config test**

Create `frontend/src/stellar/config.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  SOROBAN_VAULT_ADDRESS,
  RELAY_PROXY_URL,
} from './config.js'

describe('stellar config', () => {
  it('pins the testnet passphrase exactly (a wrong passphrase silently fails every signature)', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015')
  })
  it('points at the soroban testnet RPC', () => {
    expect(SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org')
  })
  it('matches the deployed vault from deployments/stellar-testnet.json', () => {
    expect(SOROBAN_VAULT_ADDRESS).toBe('CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF')
  })
  it('routes to the new stellar relay proxy (NOT the EVM /api/relay)', () => {
    expect(RELAY_PROXY_URL).toBe('/api/stellar-relay')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/stellar/config.test.js`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 4: Write the config module**

Create `frontend/src/stellar/config.js`:

```js
// Public Stellar testnet constants for the chain layer. Client-safe (no secrets, no SDK).
// Addresses synced from deployments/stellar-testnet.json — re-sync after any redeploy or a
// quarterly testnet reset (same discipline as the EVM config.js address sync).

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'

// Deposit target. The server relay refuses to fee-bump anything that does not invoke this
// contract's `deposit` (defense-in-depth on top of the per-IP rate limit).
export const SOROBAN_VAULT_ADDRESS = 'CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF'

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
export const RELAY_PROXY_URL = '/api/stellar-relay'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/stellar/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Document the new env vars**

Append to `frontend/.env.example` (server-side, NOT `VITE_`-prefixed — same handling as `ONESHOT_*`):

```bash
# ─── Soroban gasless relay (sub-project 2) ───
# Relayer keypair SECRET (S...). Server-only — never expose to the client bundle.
# Generate + fund on testnet:  stellar keys generate relayer --network testnet --fund
# then read the secret with:    stellar keys show relayer
STELLAR_RELAYER_SECRET=S...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF
```

- [ ] **Step 7: Commit**

```bash
cd frontend && git add package.json package-lock.json .env.example src/stellar/config.js src/stellar/config.test.js
git commit -m "feat: stellar relay config + @stellar/stellar-sdk dep"
```

---

## Task 2: Client relay helper

**Files:**
- Create: `frontend/src/stellar/relay.js`
- Test: `frontend/src/stellar/relay.test.js`

**Interfaces:**
- Consumes: `RELAY_PROXY_URL` (Task 1).
- Produces: `submitViaRelay({ xdr })`, `getRelayerAddress()` — consumed by sub-project 3.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/relay.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { submitViaRelay, getRelayerAddress } from './relay.js'

describe('stellar client relay', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs action:submit + xdr and maps { hash, status, relayer }', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hash: 'abc', status: 'SUCCESS', relayer: 'GREL' }),
    }))
    const out = await submitViaRelay({ xdr: 'AAA>>>base64' })
    expect(out).toEqual({ hash: 'abc', status: 'SUCCESS', relayer: 'GREL' })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body).toEqual({ action: 'submit', xdr: 'AAA>>>base64' })
    expect(global.fetch.mock.calls[0][0]).toBe('/api/stellar-relay')
  })

  it('returns null when the relay is unconfigured (configured:false)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ configured: false }) }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it('returns null on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it('returns null on a network throw (never crashes the worker)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it('getRelayerAddress returns the relayer pubkey', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ address: 'GREL' }) }))
    expect(await getRelayerAddress()).toBe('GREL')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/stellar/relay.test.js`
Expected: FAIL — `Cannot find module './relay.js'`.

- [ ] **Step 3: Write the client helper**

Create `frontend/src/stellar/relay.js`:

```js
// Client helper for the gasless fee-bump relay. Pure fetch — no SDK, no secrets.
// The worker (sub-project 3) builds + signs the inner deposit tx and calls submitViaRelay
// with its base64 XDR. The server wraps it in a fee-bump and pays the XLM.

import { RELAY_PROXY_URL } from './config.js'

/**
 * Submit an agent-signed inner Soroban transaction (base64 XDR) to the gasless relay.
 * @param {{ xdr: string }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 *   null when the relay is unconfigured or the request fails — caller decides the fallback.
 */
export async function submitViaRelay({ xdr }) {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', xdr }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (d.configured === false || d.error) return null
    return { hash: d.hash, status: d.status, relayer: d.relayer }
  } catch {
    return null
  }
}

/**
 * Relayer (fee source) public key — fund it with testnet XLM. null if unconfigured.
 * @returns {Promise<string | null>}
 */
export async function getRelayerAddress() {
  try {
    const res = await fetch(RELAY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'wallet' }),
    })
    if (!res.ok) return null
    const d = await res.json()
    return d.address || null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/stellar/relay.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/stellar/relay.js src/stellar/relay.test.js
git commit -m "feat: stellar client relay helper (submitViaRelay/getRelayerAddress)"
```

---

## Task 3: Server fee-bump core + handler

**Files:**
- Create: `frontend/api/stellar-relay.js`
- Test: `frontend/api/stellar-relay.test.js`

**Interfaces:**
- Consumes: `_guard.js` (`applyCors`, `rateLimit`) — existing.
- Produces: default `handler(req,res)`; named `feeBumpAndSubmit({ xdr, secret, passphrase, vaultAddr, sdk, rpcServer })`, `RelayError`, `_clearSeen()`. `assertVaultDeposit` is added in Task 4 (this task ships it as a no-op stub so the call site exists).

- [ ] **Step 1: Write the failing test**

Create `frontend/api/stellar-relay.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { feeBumpAndSubmit, RelayError, _clearSeen } from './stellar-relay.js'

const PASS = 'Test SDF Network ; September 2015'
const SECRET = 'SABCD' // never parsed — Keypair.fromSecret is faked below

// Fake SDK. fromXDR returns a fake inner Transaction; buildFeeBumpTransaction returns a fake
// fee-bump with a sign() spy; instanceof FeeBumpTransaction is used to reject already-bumped tx.
class FakeFeeBump {}
function makeSdk({ innerFee = '100000', innerHashHex = 'aa', alreadyBumped = false } = {}) {
  const signSpy = vi.fn()
  const builtFeeBump = { sign: signSpy }
  const buildFeeBumpTransaction = vi.fn(() => builtFeeBump)
  const inner = alreadyBumped
    ? new FakeFeeBump()
    : { fee: innerFee, operations: [], hash: () => Buffer.from(innerHashHex, 'hex') }
  return {
    sdk: {
      TransactionBuilder: { fromXDR: vi.fn(() => inner), buildFeeBumpTransaction },
      FeeBumpTransaction: FakeFeeBump,
      Keypair: { fromSecret: () => ({ publicKey: () => 'GREL' }) },
      Address: {},
    },
    signSpy,
    buildFeeBumpTransaction,
    builtFeeBump,
  }
}
function makeRpc({ sendStatus = 'PENDING', getStatuses = ['SUCCESS'] } = {}) {
  const queue = [...getStatuses]
  return {
    sendTransaction: vi.fn(async () => ({ status: sendStatus, hash: 'OUTERHASH' })),
    getTransaction: vi.fn(async () => ({ status: queue.shift() ?? 'NOT_FOUND' })),
  }
}

describe('feeBumpAndSubmit', () => {
  beforeEach(() => _clearSeen())

  it('fee-bumps, signs with the relayer key, submits, polls to SUCCESS', async () => {
    const { sdk, signSpy, buildFeeBumpTransaction } = makeSdk({ innerHashHex: '11' })
    const rpc = makeRpc({ getStatuses: ['NOT_FOUND', 'SUCCESS'] })
    const out = await feeBumpAndSubmit({
      xdr: 'INNERXDR', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc,
    })
    expect(out).toEqual({ hash: 'OUTERHASH', status: 'SUCCESS', relayer: 'GREL' })
    expect(buildFeeBumpTransaction).toHaveBeenCalledOnce()
    expect(signSpy).toHaveBeenCalledOnce()
    expect(rpc.sendTransaction).toHaveBeenCalledOnce()
  })

  it('rejects an already-fee-bumped inner tx (the relay must be the fee source)', async () => {
    const { sdk } = makeSdk({ alreadyBumped: true })
    const rpc = makeRpc()
    await expect(
      feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc })
    ).rejects.toBeInstanceOf(RelayError)
    expect(rpc.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws when the RPC rejects the submission (status ERROR)', async () => {
    const { sdk } = makeSdk({ innerHashHex: '22' })
    const rpc = makeRpc({ sendStatus: 'ERROR' })
    await expect(
      feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc })
    ).rejects.toBeInstanceOf(RelayError)
  })

  it('short-circuits a replayed inner tx without re-broadcasting (same inner hash)', async () => {
    const a = makeSdk({ innerHashHex: '33' })
    const rpcA = makeRpc({ getStatuses: ['SUCCESS'] })
    await feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk: a.sdk, rpcServer: rpcA })
    const b = makeSdk({ innerHashHex: '33' }) // same inner hash → duplicate
    const rpcB = makeRpc({ getStatuses: ['SUCCESS'] })
    const out = await feeBumpAndSubmit({ xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk: b.sdk, rpcServer: rpcB })
    expect(out.status).toBe('duplicate')
    expect(rpcB.sendTransaction).not.toHaveBeenCalled()
  })

  it('returns PENDING (not an error) when the tx is still NOT_FOUND after the poll budget', async () => {
    const { sdk } = makeSdk({ innerHashHex: '44' })
    const rpc = makeRpc({ getStatuses: [] }) // always NOT_FOUND
    const out = await feeBumpAndSubmit({
      xdr: 'X', secret: SECRET, passphrase: PASS, vaultAddr: '', sdk, rpcServer: rpc,
      pollTries: 2, pollIntervalMs: 0,
    })
    expect(out.status).toBe('PENDING')
    expect(out.hash).toBe('OUTERHASH')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run api/stellar-relay.test.js`
Expected: FAIL — `Cannot find module './stellar-relay.js'`.

- [ ] **Step 3: Write the server module**

Create `frontend/api/stellar-relay.js`:

```js
// Server-side Soroban gasless relay. Wraps an agent-signed inner Soroban transaction in a
// fee-bump paid by the server's relayer keypair, submits via Soroban RPC, polls to a result.
//
// Security model (dumb fee sponsor): the relay does NOT authorize the deposit — the inner tx
// already carries the agent custom account's __check_auth ed25519 auth entry, signed client-side
// by the agent session key. The relay only pays the XLM fee. Abuse is bounded by: origin
// allowlist + per-IP rate limit (_guard.js) AND the vault-target allowlist (assertVaultDeposit,
// Task 4) so the relayer never sponsors an unrelated transaction. The relayer SECRET is
// server-held (STELLAR_RELAYER_SECRET) — never in the client bundle.
//
// Actions:
//   { action: 'wallet' }            → { address }           (relayer pubkey — fund it)
//   { action: 'submit', xdr }       → { hash, status }      (fee-bump + submit + poll)

import { applyCors, rateLimit } from './_guard.js'

const PASSPHRASE = () =>
  process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const RELAYER_SECRET = () => process.env.STELLAR_RELAYER_SECRET || ''
const VAULT_ADDR = () => process.env.SOROBAN_VAULT_ADDRESS || ''

// Fee-bump base fee = inner fee + this margin (stroops). 0.1 XLM is generous on testnet and
// safely clears the SDK's "fee-bump fee >= inner fee" floor for our single-op deposit txs.
const FEE_MARGIN = 1_000_000n

export class RelayError extends Error {}

// ─── warm-process replay guard, keyed by inner-tx hash (hex) ───
const _seen = new Map() // innerHash → { state:'in-flight'|'done', out?, at }
const SEEN_MAX = 5000
const SEEN_TTL_MS = 30 * 60_000
export function _clearSeen() {
  _seen.clear()
}
function pruneSeen(now) {
  for (const [k, v] of _seen) if (now - v.at > SEEN_TTL_MS) _seen.delete(k)
}

// Replaced by a real implementation in Task 4. No-op when vaultAddr is falsy.
export function assertVaultDeposit(_inner, _vaultAddr, _sdk) {}

/** Poll getTransaction until it leaves NOT_FOUND, or the budget is spent. */
async function pollResult(rpcServer, hash, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await rpcServer.getTransaction(hash)
    if (r.status && r.status !== 'NOT_FOUND') return r
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }
  return { status: 'PENDING' } // submitted but not yet observed — client may keep polling
}

/**
 * Fee-bump an agent-signed inner Soroban tx and submit it. Pays the fee from `secret`.
 * @param {object} p
 * @param {string} p.xdr            base64 inner-tx envelope (agent-auth signed)
 * @param {string} p.secret         relayer S... secret
 * @param {string} p.passphrase     network passphrase
 * @param {string} p.vaultAddr      allowlisted deposit target ('' = skip the guard)
 * @param {object} p.sdk            { TransactionBuilder, FeeBumpTransaction, Keypair, Address }
 * @param {object} p.rpcServer      { sendTransaction, getTransaction }
 * @returns {Promise<{ hash, status, relayer }>}
 */
export async function feeBumpAndSubmit({
  xdr,
  secret,
  passphrase,
  vaultAddr,
  sdk,
  rpcServer,
  pollTries = 10,
  pollIntervalMs = 2000,
}) {
  const { TransactionBuilder, FeeBumpTransaction, Keypair } = sdk

  const inner = TransactionBuilder.fromXDR(xdr, passphrase)
  if (inner instanceof FeeBumpTransaction) {
    throw new RelayError('inner tx is already fee-bumped')
  }
  assertVaultDeposit(inner, vaultAddr, sdk)

  // Replay short-circuit (don't pay to re-broadcast a spent inner tx).
  const innerHash = inner.hash().toString('hex')
  const now = Date.now()
  if (_seen.size > SEEN_MAX) pruneSeen(now)
  const prev = _seen.get(innerHash)
  if (prev) {
    if (prev.state === 'done') return { ...prev.out, status: 'duplicate' }
    throw new RelayError('inner tx already in flight')
  }
  _seen.set(innerHash, { state: 'in-flight', at: now })

  try {
    const kp = Keypair.fromSecret(secret)
    const baseFee = (BigInt(inner.fee) + FEE_MARGIN).toString()
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(kp, baseFee, inner, passphrase)
    feeBump.sign(kp)

    const send = await rpcServer.sendTransaction(feeBump)
    if (send.status === 'ERROR') {
      throw new RelayError('RPC rejected the fee-bump submission')
    }
    const result = await pollResult(rpcServer, send.hash, pollTries, pollIntervalMs)
    const out = { hash: send.hash, status: result.status, relayer: kp.publicKey() }
    _seen.set(innerHash, { state: 'done', out, at: Date.now() })
    return out
  } catch (e) {
    _seen.delete(innerHash) // failed submit → allow a genuine retry of this inner tx
    throw e
  }
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
  if (!rateLimit(req, res, { max: 15, windowMs: 60_000, bucket: 'stellar-relay' })) return
  res.setHeader('Content-Type', 'application/json')

  const secret = RELAYER_SECRET()
  if (!secret) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Stellar relay not configured', configured: false }))
  }

  try {
    const body = await readBody(req)
    // Dynamic import so a missing package never breaks the vite.config load.
    const mod = await import('@stellar/stellar-sdk')
    const sdk = {
      TransactionBuilder: mod.TransactionBuilder,
      FeeBumpTransaction: mod.FeeBumpTransaction,
      Keypair: mod.Keypair,
      Address: mod.Address,
    }

    if (body.action === 'wallet') {
      return res.end(JSON.stringify({ address: mod.Keypair.fromSecret(secret).publicKey() }))
    }

    if (body.action === 'submit') {
      if (typeof body.xdr !== 'string' || !body.xdr) return bad(res, 'Invalid xdr')
      const rpcServer = new mod.rpc.Server(RPC_URL())
      try {
        const out = await feeBumpAndSubmit({
          xdr: body.xdr,
          secret,
          passphrase: PASSPHRASE(),
          vaultAddr: VAULT_ADDR(),
          sdk,
          rpcServer,
        })
        return res.end(JSON.stringify(out))
      } catch (e) {
        if (e instanceof RelayError && /in flight/.test(e.message)) {
          res.statusCode = 409
          return res.end(JSON.stringify({ error: e.message }))
        }
        throw e
      }
    }

    return bad(res, 'Unknown action')
  } catch (err) {
    console.error('[api/stellar-relay] error:', err?.message || err)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Stellar relay failed' }))
  }
}
```

> Note: pre-v12 `@stellar/stellar-sdk` exports the RPC client as `mod.SorobanRpc.Server`. With the version pinned in Task 1 (>= 12), `mod.rpc.Server` is correct. If the install resolved an older line, change `new mod.rpc.Server` to `new mod.SorobanRpc.Server`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run api/stellar-relay.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add api/stellar-relay.js api/stellar-relay.test.js
git commit -m "feat: soroban fee-bump relay core + handler (submit/wallet, replay guard)"
```

---

## Task 4: Vault-target allowlist (defense-in-depth)

The rate limit is the security floor; this stops the funded relayer from being a generic fee sponsor for unrelated transactions. It replaces the `assertVaultDeposit` no-op stub from Task 3 with a real check: the inner tx must be exactly one `InvokeHostFunction` calling the deployed vault's `deposit`.

**Files:**
- Modify: `frontend/api/stellar-relay.js` (replace `assertVaultDeposit`)
- Test: `frontend/api/stellar-relay.test.js` (add a describe block)

**Interfaces:**
- `assertVaultDeposit(inner, vaultAddr, sdk)` — throws `RelayError` unless `inner` is a single `invokeHostFunction` op invoking contract `vaultAddr`, function `deposit`. No-op when `vaultAddr` is falsy (so the relay still works before addresses are wired and so the smoke script can bypass it).

- [ ] **Step 1: Write the failing test**

Add to `frontend/api/stellar-relay.test.js`:

```js
import { assertVaultDeposit } from './stellar-relay.js'

const VAULT = 'CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF'

// A fake inner tx whose single op decodes to invokeContract(contractStr, fnStr).
function depositTx(contractStr, fnStr) {
  return {
    operations: [
      {
        type: 'invokeHostFunction',
        func: {
          switch: () => ({ name: 'hostFunctionTypeInvokeContract' }),
          invokeContract: () => ({
            contractAddress: () => ({ __sc: contractStr }),
            functionName: () => fnStr, // ScSymbol stringifies to the symbol
          }),
        },
      },
    ],
  }
}
// Fake Address.fromScAddress: reads back the contract string our fixture tucked in.
const sdkAddr = { Address: { fromScAddress: (sc) => ({ toString: () => sc.__sc }) } }

describe('assertVaultDeposit', () => {
  it('passes a single deposit op to the configured vault', () => {
    expect(() => assertVaultDeposit(depositTx(VAULT, 'deposit'), VAULT, sdkAddr)).not.toThrow()
  })
  it('rejects a call to a different contract', () => {
    expect(() => assertVaultDeposit(depositTx('CWRONG', 'deposit'), VAULT, sdkAddr)).toThrow(RelayError)
  })
  it('rejects a non-deposit function', () => {
    expect(() => assertVaultDeposit(depositTx(VAULT, 'redeem'), VAULT, sdkAddr)).toThrow(RelayError)
  })
  it('rejects a multi-operation tx', () => {
    const tx = depositTx(VAULT, 'deposit')
    tx.operations.push(tx.operations[0])
    expect(() => assertVaultDeposit(tx, VAULT, sdkAddr)).toThrow(RelayError)
  })
  it('rejects a non-invoke op', () => {
    expect(() => assertVaultDeposit({ operations: [{ type: 'payment' }] }, VAULT, sdkAddr)).toThrow(RelayError)
  })
  it('is a no-op when vaultAddr is empty (pre-wiring / smoke bypass)', () => {
    expect(() => assertVaultDeposit(depositTx('CANY', 'anything'), '', sdkAddr)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run api/stellar-relay.test.js`
Expected: FAIL — the stub never throws, so the rejection cases fail.

- [ ] **Step 3: Replace the stub**

In `frontend/api/stellar-relay.js`, replace the `assertVaultDeposit` no-op with:

```js
/**
 * Reject anything that is not a single InvokeHostFunction calling `vaultAddr`.deposit.
 * No-op when vaultAddr is falsy. Throws RelayError on mismatch.
 */
export function assertVaultDeposit(inner, vaultAddr, sdk) {
  if (!vaultAddr) return
  const ops = inner.operations || []
  if (ops.length !== 1 || ops[0].type !== 'invokeHostFunction') {
    throw new RelayError('relay sponsors a single vault deposit only')
  }
  const hf = ops[0].func
  if (hf.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new RelayError('inner op is not a contract invocation')
  }
  const ic = hf.invokeContract()
  const contract = sdk.Address.fromScAddress(ic.contractAddress()).toString()
  const fnName = ic.functionName().toString()
  if (contract !== vaultAddr) throw new RelayError('inner tx does not target the vault')
  if (fnName !== 'deposit') throw new RelayError('inner tx is not a deposit')
}
```

> XDR shape note: in a decoded `Transaction`, an invoke op is `{ type:'invokeHostFunction', func: xdr.HostFunction, auth: [...] }`. `func.invokeContract()` returns `xdr.InvokeContractArgs` with `.contractAddress()` (an `xdr.ScAddress`) and `.functionName()` (an `xdr.ScSymbol` that stringifies to the symbol). `Address.fromScAddress(scAddress).toString()` yields the `C...` string. If a future SDK changes these accessor names, the smoke script (Task 6) catches it against live testnet.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run api/stellar-relay.test.js`
Expected: PASS (all Task 3 + Task 4 tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add api/stellar-relay.js api/stellar-relay.test.js
git commit -m "feat: vault-target allowlist on the soroban relay (defense-in-depth)"
```

---

## Task 5: Wire the endpoint into dev/preview + Cloudflare Pages

**Files:**
- Create: `frontend/functions/api/stellar-relay.js`
- Modify: `frontend/vite.config.js`
- Test: `frontend/functions/api/stellar-relay.test.js`

**Interfaces:**
- Consumes: `handler` (Task 3), `toPagesFunction` (existing `api/_pagesAdapter.js`).

- [ ] **Step 1: Write the failing wrapper test**

Create `frontend/functions/api/stellar-relay.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { onRequest } from './stellar-relay.js'

describe('stellar-relay pages function', () => {
  it('exports an onRequest handler', () => {
    expect(typeof onRequest).toBe('function')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run functions/api/stellar-relay.test.js`
Expected: FAIL — `Cannot find module './stellar-relay.js'`.

- [ ] **Step 3: Write the Pages Function wrapper**

Create `frontend/functions/api/stellar-relay.js` (mirror `functions/api/relay.js`):

```js
// Cloudflare Pages Function → /api/stellar-relay
// Thin wrapper over the Soroban fee-bump relay (../../api/stellar-relay.js).
// Requires the `nodejs_compat` flag (already set in wrangler.jsonc) — the handler
// dynamically imports `@stellar/stellar-sdk` and reads process.env.STELLAR_* secrets.
import handler from '../../api/stellar-relay.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run functions/api/stellar-relay.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Register the dev/preview middleware + propagate env**

In `frontend/vite.config.js`:

1. Add the import near the other proxy imports (top of file):

```js
import stellarRelayProxy from './api/stellar-relay.js'
```

2. Inside the `defineConfig` callback, after the `ONESHOT_*` propagation block, add:

```js
  // Soroban gasless relay (sub-project 2) — server-side only, never in the client bundle.
  if (env.STELLAR_RELAYER_SECRET) process.env.STELLAR_RELAYER_SECRET = env.STELLAR_RELAYER_SECRET
  if (env.SOROBAN_RPC_URL) process.env.SOROBAN_RPC_URL = env.SOROBAN_RPC_URL
  if (env.STELLAR_NETWORK_PASSPHRASE)
    process.env.STELLAR_NETWORK_PASSPHRASE = env.STELLAR_NETWORK_PASSPHRASE
  if (env.SOROBAN_VAULT_ADDRESS) process.env.SOROBAN_VAULT_ADDRESS = env.SOROBAN_VAULT_ADDRESS
```

3. In BOTH `configureServer(s)` and `configurePreviewServer(s)`, add the middleware line alongside the existing ones:

```js
      s.middlewares.use('/api/stellar-relay', stellarRelayProxy)
```

- [ ] **Step 6: Confirm Pages routing + build**

- `functions/api/stellar-relay.js` is auto-routed by Cloudflare Pages from its file path. If a `_routes.json` with an explicit `include` allowlist exists (search: `npx vitest --version` is unrelated — instead check `git ls-files | grep _routes.json`), add `/api/stellar-relay` to its `include` array.
- `wrangler.jsonc` already enables `nodejs_compat` for `api/relay.js`; no change needed.

Run: `cd frontend && npm run build`
Expected: build succeeds (the new function + vite import resolve; `@stellar/stellar-sdk` is server-side only and not pulled into the client bundle because nothing in `src/` imports it).

- [ ] **Step 7: Run the full suite**

Run: `cd frontend && npm test`
Expected: all prior tests + the new stellar tests PASS; no regressions in the EVM suite.

- [ ] **Step 8: Commit**

```bash
cd frontend && git add vite.config.js functions/api/stellar-relay.js functions/api/stellar-relay.test.js
git commit -m "feat: wire /api/stellar-relay into dev/preview + cloudflare pages"
```

---

## Task 6: Live testnet smoke proof + verification

Mocked unit tests prove orchestration; this proves the real fee-bump math and Soroban-RPC submission against live testnet, and that the **server pays the fee** (the gasless guarantee). It calls `feeBumpAndSubmit` directly with `vaultAddr: ''` (allowlist bypassed) wrapping a no-auth view invoke, so it needs no agent/vault auth.

**Files:**
- Create: `frontend/scripts/stellar-relay-smoke.mjs`

**Interfaces:**
- Consumes: `feeBumpAndSubmit` (Task 3), `@stellar/stellar-sdk`, `deployments/stellar-testnet.json`.

- [ ] **Step 1: Generate + fund the relayer key**

Run (WSL, where `stellar` CLI lives):
```bash
wsl -e bash -lc "stellar keys generate relayer --network testnet --fund && stellar keys show relayer"
```
Copy the printed `S...` secret into `frontend/.env` as `STELLAR_RELAYER_SECRET=...` (also set `SOROBAN_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `SOROBAN_VAULT_ADDRESS` from `.env.example`).

- [ ] **Step 2: Write the smoke script**

Create `frontend/scripts/stellar-relay-smoke.mjs`:

```js
// Live testnet proof of the gasless fee-bump relay. NOT part of `vitest run`.
// Run: node scripts/stellar-relay-smoke.mjs   (needs a funded STELLAR_RELAYER_SECRET in env)
//
// 1. Generate + friendbot-fund a throwaway inner-source account.
// 2. Build a no-auth Soroban view invoke (vault.decimals()) as the inner tx, simulate+assemble.
// 3. feeBumpAndSubmit() wraps it (relayer pays the fee) and submits.
// 4. Assert SUCCESS + the relayer's XLM dropped while the inner source's XLM is unchanged.

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransaction,
  Address,
  Contract,
  Networks,
  rpc,
} from '@stellar/stellar-sdk'
import { feeBumpAndSubmit, _clearSeen } from '../api/stellar-relay.js'

const PASS = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET
const RPC = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const secret = process.env.STELLAR_RELAYER_SECRET
if (!secret) throw new Error('STELLAR_RELAYER_SECRET not set (generate + fund a testnet key first)')

const deployments = JSON.parse(readFileSync(new URL('../../deployments/stellar-testnet.json', import.meta.url)))
const VAULT = deployments.rwa.vault
const server = new rpc.Server(RPC)
const sdk = { TransactionBuilder, FeeBumpTransaction, Keypair, Address }

async function xlm(pubkey) {
  const { balances } = await server.getAccount(pubkey).then((a) => a) // throws if not funded
  return Number(balances?.find?.((b) => b.asset_type === 'native')?.balance ?? 0)
}

async function main() {
  _clearSeen()
  const relayer = Keypair.fromSecret(secret).publicKey()

  // 1. throwaway inner source, friendbot-funded
  const inner = Keypair.random()
  await fetch(`https://friendbot.stellar.org?addr=${inner.publicKey()}`).then((r) => r.json())
  const innerAccount = await server.getAccount(inner.publicKey())

  // 2. no-auth view invoke (vault.decimals()) — valid tx, no agent/vault auth required
  const tx = new TransactionBuilder(innerAccount, { fee: '100', networkPassphrase: PASS })
    .addOperation(new Contract(VAULT).call('decimals'))
    .setTimeout(60)
    .build()
  const prepared = await server.prepareTransaction(tx) // simulate + assemble (sets resource fee)
  prepared.sign(inner)
  const xdr = prepared.toEnvelope().toXDR('base64')

  const relayerBefore = await server.getAccount(relayer)
  const innerBefore = await server.getAccount(inner.publicKey())

  // 3. relay it (allowlist bypassed for the smoke: vaultAddr '')
  const out = await feeBumpAndSubmit({
    xdr, secret, passphrase: PASS, vaultAddr: '', sdk, rpcServer: server,
  })
  console.log('relay result:', out)

  // 4. gasless assertion
  const relayerAfter = await server.getAccount(relayer)
  const innerAfter = await server.getAccount(inner.publicKey())
  const nat = (a) => Number(a.balances.find((b) => b.asset_type === 'native').balance)
  const relayerPaid = nat(relayerBefore) - nat(relayerAfter)
  const innerPaid = nat(innerBefore) - nat(innerAfter)
  console.log({ status: out.status, relayerPaidXLM: relayerPaid, innerPaidXLM: innerPaid })
  if (out.status !== 'SUCCESS') throw new Error('expected SUCCESS, got ' + out.status)
  if (relayerPaid <= 0) throw new Error('relayer did not pay the fee — fee-bump not applied')
  if (innerPaid !== 0) throw new Error('inner source paid — NOT gasless')
  console.log('OK — gasless fee-bump verified')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

> If `server.getAccount(...).balances` is not present on your SDK's RPC account type, read balances via Horizon instead: `new Horizon.Server('https://horizon-testnet.stellar.org').loadAccount(pubkey)` then `.balances`. The assertion logic is unchanged.

- [ ] **Step 3: Run the smoke script and verify**

Run: `cd frontend && node scripts/stellar-relay-smoke.mjs`
Expected output (numbers vary):
```
relay result: { hash: '...', status: 'SUCCESS', relayer: 'G...' }
{ status: 'SUCCESS', relayerPaidXLM: 0.00xxxxx, innerPaidXLM: 0 }
OK — gasless fee-bump verified
```
This confirms: the SDK fee-bump accessors are correct, Soroban RPC accepts the fee-bumped tx, it reaches `SUCCESS`, the relayer paid the XLM, and the inner source paid nothing.

- [ ] **Step 4: Record the relayer pubkey in the deployment manifest**

Add the relayer pubkey to `deployments/stellar-testnet.json` so the operator/frontend know which account to fund:

```json
  "relayer": "G..."
```
(insert as a top-level key alongside `registry`).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add scripts/stellar-relay-smoke.mjs
cd .. && git add deployments/stellar-testnet.json
git commit -m "test: live testnet gasless fee-bump smoke proof + record relayer pubkey"
```

- [ ] **Step 6: Set Cloudflare env (manual, for deployed Pages)**

In the Cloudflare Pages project settings (Production + Preview), set: `STELLAR_RELAYER_SECRET`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `SOROBAN_VAULT_ADDRESS`. Fund the relayer pubkey with testnet XLM (it must hold enough to pay fee-bumps across the demo). This is a deploy-config step, not code.

---

## Self-Review

**1. Spec coverage** (decomposition item 2 = "Gasless relay (fee-bump / OZ Relayer)"):
- Fee-bump model, server pays XLM → Tasks 3 + 6. ✅
- Replaces 1Shot (EVM) without deleting it (coexist until step 6) → new `stellar-relay.*` files, EVM untouched. ✅
- Testnet passphrase / RPC pinned exactly (§3 fact-check, §8) → Global Constraints + Task 1. ✅
- Storage/TTL: N/A — the relay is stateless server code; on-chain TTL is owned by the contracts (sub-project 1). ✅
- Interface published for sub-projects 3/4 (the contract between layers, §7) → `submitViaRelay({xdr})` is the seam; inner-tx building is explicitly step 3. ✅
- Inner-source funding boundary documented so step 3 owns it (§8 sponsored reserves). ✅

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step ships full code; every run step has an exact command + expected result. ✅

**3. Type/name consistency:** `feeBumpAndSubmit({ xdr, secret, passphrase, vaultAddr, sdk, rpcServer })`, `sdk = { TransactionBuilder, FeeBumpTransaction, Keypair, Address }`, `rpcServer = { sendTransaction, getTransaction }`, `assertVaultDeposit(inner, vaultAddr, sdk)`, `RelayError`, `_clearSeen`, `submitViaRelay`, `getRelayerAddress`, `RELAY_PROXY_URL='/api/stellar-relay'`, `SOROBAN_VAULT_ADDRESS` — identical across config, client, server, tests, smoke, and the File Structure interface block. ✅

**Open risk (flagged, not blocking):** the exact `@stellar/stellar-sdk` XDR accessor names in `assertVaultDeposit` (`func.invokeContract().contractAddress()/functionName()`, `Address.fromScAddress`) and the `rpc.Server` vs `SorobanRpc.Server` export are version-sensitive. Mocked tests pass regardless; the **Task 6 smoke script is the live guard** that catches any accessor drift before this sub-project is considered done.

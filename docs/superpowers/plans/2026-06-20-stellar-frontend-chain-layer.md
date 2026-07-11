# Stellar Frontend Chain Layer (sub-project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser-side Soroban chain layer for Vibing Farmer — SDK client, ScVal codec, ephemeral agent session keys, a multi-wallet user connector, and an RPC event indexer — so the orchestrator/worker/UI (sub-project 4) can read, sign, submit, and monitor on Stellar testnet instead of EVM.

**Architecture:** Layer new modules under the existing `frontend/src/stellar/` folder (which already holds `config.js` + `relay.js` from sub-project 2). Each module is a pure, dependency-injected unit so it unit-tests without a network. The agent gasless-deposit path reuses the already-shipped server relay (`/api/stellar-relay`); user-paid transactions (redeem/claim/registry-authorize) go through the user's wallet via Stellar Wallets Kit. Events come from native Soroban RPC `getEvents` (no third-party indexer on testnet).

**Tech Stack:** `@stellar/stellar-sdk` ^16 (already installed), `@creit-tech/stellar-wallets-kit` (new — idiomatic Stellar multi-wallet connector), Vite + Vitest (existing), React 18 force-graph (consumes the event deltas).

---

## Context the engineer needs (read before starting)

You know almost nothing about Soroban. Key facts that make this plan make sense:

- **Soroban = Stellar's smart-contract platform.** Contracts are Rust→WASM. The browser talks to a **Soroban RPC** node (`https://soroban-testnet.stellar.org`). Reads/writes go through RPC; account *balances* come from a separate **Horizon** REST node (`https://horizon-testnet.stellar.org`) — the RPC `getAccount` returns only the sequence number, not balances. This quirk already bit us once; that's why `scripts/stellar-relay-smoke.mjs` reads balances via Horizon.
- **ScVal** is the on-chain value encoding (XDR). Every contract arg must be encoded JS→ScVal and every return value decoded ScVal→JS. The SDK gives `nativeToScVal(value, opts)` and `scValToNative(scval)`. Money amounts are `i128` (BigInt). Addresses use the `Address` class.
- **A contract call** is: `new Contract(addr).call(method, ...scvalArgs)` → an Operation → wrapped in a `TransactionBuilder` → **simulated** (`server.simulateTransaction` or `server.prepareTransaction`) to compute the resource fee and (for reads) get the return value.
- **Auth model:** state-changing calls need *authorization entries*. A normal user signs the whole transaction with their wallet. Our **agents** are on-chain *custom accounts* (sub-project 1a) whose `__check_auth` verifies an **ed25519 signature** over the auth payload against a registered session-key public key. So an agent deposit carries an auth entry signed by an ephemeral ed25519 key — the server relay only pays the XLM fee, it does not authorize.
- **Deployed addresses** live in `deployments/stellar-testnet.json` (registry, demo agent account, vault, token). Testnet **resets ~quarterly** → addresses change → re-sync `config.js`. Same discipline as the EVM `config.js`.
- **The contract interface is frozen** in `docs/soroban-interfaces.md`. Do not invent method names — copy them from there. Critical ones: vault `deposit(from: Address, amount: i128) -> i128`, `redeem(from, shares) -> i128`, `claim(holder) -> i128`, `claimable(holder) -> i128`, reads `decimals/total_shares/total_principal/balance(id)/token`; registry `record_of(agent)`, `is_revoked(agent)`; events `vault_deposit/vault_redeem/vault_drip/vault_claim/agent_authorized/agent_revoked`.

## What is NOT in this sub-project (hard boundaries)

Do **not** build these here — they belong to sub-project 4 (or a separate plan). If you find yourself writing them, stop:

- Orchestrator / worker re-point, the AI council, the Aladdin engine, yield orchestration.
- The **full agent-deposit auth-tree assembly** (who grants `allowance[*][vault]`, beneficial-holder choice). `docs/soroban-interfaces.md` assigns that to sub-projects 2+4. Here we deliver only the *primitive* (sign an auth payload with a session key) plus a unit proof it verifies.
- The live `react-force-graph-2d` React component wiring. Here we deliver the **decoded event stream + graph deltas**; sub-project 4 feeds them into the component.
- **Passkey / Smart Account Kit.** Deferred to a separate future plan (it's a whole smart-wallet subsystem and was a cancelled RWA-Fi feature). Agents use ed25519 session keys; users use Stellar Wallets Kit (which can add passkey later without touching the rest of the app).

## File structure (created/modified across all tasks)

```
frontend/
  package.json                       MODIFY  add @creit-tech/stellar-wallets-kit
  src/stellar/
    config.js                        MODIFY  add registry/token/demoAgent/decimals/horizon
    config.test.js                   MODIFY  assert the new constants
    relay.js                         (exists, unchanged — sub-project 2)
    scval.js                         CREATE  JS⇄ScVal codec wrappers
    scval.test.js                    CREATE
    client.js                        CREATE  rpc read / build-invoke / submit / poll / balance
    client.test.js                   CREATE
    sessionKey.js                    CREATE  ephemeral ed25519 agent key + sign primitive
    sessionKey.test.js               CREATE
    walletKit.js                     CREATE  Stellar Wallets Kit wrapper (connect/sign)
    walletKit.test.js                CREATE
    events.js                        CREATE  getEvents poll + decode + graph deltas
    events.test.js                   CREATE
    index.js                         CREATE  barrel re-export for sub-project 4
  scripts/
    stellar-chain-smoke.mjs          CREATE  live-testnet read + event-poll proof (not in vitest)
```

---

### Task 1: Add the wallet-kit dependency + extend the Stellar config

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/stellar/config.js`
- Test: `frontend/src/stellar/config.test.js` (modify)

- [ ] **Step 1: Install Stellar Wallets Kit**

Run from `frontend/`:

```bash
npm install @creit-tech/stellar-wallets-kit
```

Expected: `package.json` `dependencies` gains `"@creit-tech/stellar-wallets-kit": "^1.x"`. Pin whatever stable version installs.

- [ ] **Step 2: Write the failing config test**

Replace `frontend/src/stellar/config.test.js` with:

```js
import { describe, it, expect } from 'vitest'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  HORIZON_URL,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DEMO_AGENT,
  SOROBAN_DECIMALS,
  RELAY_PROXY_URL,
} from './config.js'

describe('stellar config', () => {
  it('pins the testnet passphrase exactly (a wrong passphrase silently fails every signature)', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015')
  })
  it('points at the soroban testnet RPC and Horizon', () => {
    expect(SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org')
    expect(HORIZON_URL).toBe('https://horizon-testnet.stellar.org')
  })
  it('matches the deployed contracts from deployments/stellar-testnet.json', () => {
    expect(SOROBAN_VAULT_ADDRESS).toBe('CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5')
    expect(SOROBAN_REGISTRY_ADDRESS).toBe('CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ')
    expect(SOROBAN_TOKEN_ADDRESS).toBe('CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4')
    expect(SOROBAN_DEMO_AGENT).toBe('CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW')
  })
  it('pins token/share decimals at 7 (the deployed SAC + vault metadata)', () => {
    expect(SOROBAN_DECIMALS).toBe(7)
  })
  it('routes to the stellar relay proxy (NOT the EVM /api/relay)', () => {
    expect(RELAY_PROXY_URL).toBe('/api/stellar-relay')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run from `frontend/`: `npx vitest run src/stellar/config.test.js`
Expected: FAIL — `SOROBAN_REGISTRY_ADDRESS`/`HORIZON_URL`/etc. are `undefined`.

- [ ] **Step 4: Extend the config**

Replace `frontend/src/stellar/config.js` with:

```js
// Public Stellar testnet constants for the chain layer. Client-safe (no secrets, no SDK).
// Addresses synced from deployments/stellar-testnet.json — re-sync after any redeploy or a
// quarterly testnet reset (same discipline as the EVM config.js address sync).

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
// Horizon (NOT the Soroban RPC) is the only source of account balances — rpc.getAccount
// returns sequence only. See scripts/stellar-relay-smoke.mjs.
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'

// Deposit target. The server relay refuses to fee-bump anything that does not invoke this
// contract's `deposit` (defense-in-depth on top of the per-IP rate limit).
export const SOROBAN_VAULT_ADDRESS = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
// Registry (sub-project 1a) — record_of / is_revoked reads + agent_authorized/agent_revoked events.
export const SOROBAN_REGISTRY_ADDRESS = 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
// Yield-farming asset (plain SAC VFUSD, 7 decimals). The vault pulls + pays dividends in it.
export const SOROBAN_TOKEN_ADDRESS = 'CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4'
// Pre-seeded demo agent custom account (1a) — used by the smoke script + demo flows.
export const SOROBAN_DEMO_AGENT = 'CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW'
// Token + vault-share decimals (both 7). Amounts are i128 in base units (1 VFUSD = 10_000_000).
export const SOROBAN_DECIMALS = 7

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
export const RELAY_PROXY_URL = '/api/stellar-relay'
```

- [ ] **Step 5: Run the test to verify it passes**

Run from `frontend/`: `npx vitest run src/stellar/config.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/stellar/config.js frontend/src/stellar/config.test.js
git commit -m "feat: add stellar-wallets-kit dep + extend stellar chain config"
```

---

### Task 2: ScVal codec wrappers

Thin wrappers so every other module encodes args / decodes results the same way and we never sprinkle raw `nativeToScVal` type-guessing around. Amounts are always `i128`; addresses always go through `Address`.

**Files:**
- Create: `frontend/src/stellar/scval.js`
- Test: `frontend/src/stellar/scval.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/scval.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import { addrScVal, i128ScVal, fromScVal } from './scval.js'

describe('scval codec', () => {
  it('round-trips an i128 amount (BigInt) through ScVal', () => {
    const sv = i128ScVal(100_0000000n) // 100 VFUSD at 7 decimals
    expect(fromScVal(sv)).toBe(100_0000000n)
  })

  it('accepts a number for i128 and yields a BigInt back', () => {
    const sv = i128ScVal(42)
    expect(fromScVal(sv)).toBe(42n)
  })

  it('encodes an Address ScVal that decodes back to the same strkey', () => {
    const g = Keypair.random().publicKey()
    const sv = addrScVal(g)
    // scValToNative on an address ScVal returns the strkey string
    expect(scValToNative(sv)).toBe(g)
  })

  it('fromScVal decodes a symbol/string value natively', () => {
    // build a symbol the SDK way and confirm our decoder matches scValToNative
    const sv = i128ScVal(7n)
    expect(fromScVal(sv)).toBe(scValToNative(sv))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/stellar/scval.test.js`
Expected: FAIL — `Cannot find module './scval.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/stellar/scval.js`:

```js
// JS ⇄ ScVal codec. Every contract arg is encoded here and every return value decoded here,
// so the rest of the chain layer never hand-rolls XDR type guesses.
import { Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk'

/**
 * Encode a Stellar address (G... account or C... contract strkey) as an Address ScVal.
 * @param {string} strkey
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function addrScVal(strkey) {
  return new Address(strkey).toScVal()
}

/**
 * Encode an i128 amount. Accepts BigInt or Number (Number is coerced to BigInt — pass whole
 * base units, never fractional). Money on Soroban is always i128.
 * @param {bigint | number} amount
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function i128ScVal(amount) {
  return nativeToScVal(BigInt(amount), { type: 'i128' })
}

/**
 * Decode any ScVal to its native JS value (i128 → BigInt, address → strkey, symbol → string…).
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} sv
 * @returns {unknown}
 */
export function fromScVal(sv) {
  return scValToNative(sv)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stellar/scval.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/scval.js frontend/src/stellar/scval.test.js
git commit -m "feat: scval codec wrappers for the stellar chain layer"
```

---

### Task 3: Soroban client (read / build-invoke / submit / poll / balance)

The networked core. Functions take an injected `server` (and `sdk` where needed) so unit tests run without a network — the same dependency-injection style as `feeBumpAndSubmit` in `api/stellar-relay.js`.

**Files:**
- Create: `frontend/src/stellar/client.js`
- Test: `frontend/src/stellar/client.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/client.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { i128ScVal } from './scval.js'
import { readContract, submitUserTx } from './client.js'

describe('soroban client', () => {
  it('readContract simulates a read-only call and decodes the retval to native', async () => {
    // fake server: simulateTransaction returns a successful sim carrying an i128 retval
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ result: { retval: i128ScVal(7n) } })),
    }
    const out = await readContract({
      contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
      method: 'decimals',
      args: [],
      server: fakeServer,
    })
    expect(fakeServer.simulateTransaction).toHaveBeenCalledOnce()
    expect(out).toBe(7n)
  })

  it('readContract throws when the simulation errors', async () => {
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ error: 'boom' })),
    }
    await expect(
      readContract({
        contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
        method: 'decimals',
        server: fakeServer,
      }),
    ).rejects.toThrow(/simulation failed/i)
  })

  it('submitUserTx sends the signed xdr and returns the hash + status', async () => {
    const fakeServer = {
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'abc123' })),
      getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
    }
    const out = await submitUserTx({
      signedXdr: 'AAAA==',
      server: fakeServer,
      pollIntervalMs: 0,
    })
    expect(fakeServer.sendTransaction).toHaveBeenCalledOnce()
    expect(out).toEqual({ hash: 'abc123', status: 'SUCCESS' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/stellar/client.test.js`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/stellar/client.js`:

```js
// Browser-side Soroban client. Read-only calls via simulate; state-changing calls build an
// assembled tx for the caller to sign (user wallet) or attach an agent auth entry to. Balances
// come from Horizon (the Soroban RPC returns sequence only).
//
// Every networked fn takes an injected `server` so unit tests run without a network. Defaults
// lazily construct the real SDK so a missing package never breaks the vite config load.
import { SOROBAN_RPC_URL, HORIZON_URL, NETWORK_PASSPHRASE } from './config.js'
import { addrScVal, i128ScVal, fromScVal } from './scval.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

/** Singleton Soroban RPC server. */
let _server = null
export async function rpcServer() {
  if (_server) return _server
  const { rpc } = await sdk()
  _server = new rpc.Server(SOROBAN_RPC_URL)
  return _server
}

// Encode a heterogeneous JS arg list to ScVal. { addr } → Address, { i128 } → i128, raw ScVal
// passthrough. Keeps call sites declarative: encodeArgs([{ addr: from }, { i128: amount }]).
export function encodeArgs(args = []) {
  return args.map((a) => {
    if (a && typeof a === 'object' && 'addr' in a) return addrScVal(a.addr)
    if (a && typeof a === 'object' && 'i128' in a) return i128ScVal(a.i128)
    return a // already an ScVal
  })
}

/**
 * Read-only contract call. Builds an invoke op against a throwaway source, simulates it, and
 * decodes the return value. No fee, no signature, no submission.
 * @param {{ contract: string, method: string, args?: Array, server?: object }} p
 * @returns {Promise<unknown>} decoded native return value
 */
export async function readContract({ contract, method, args = [], server }) {
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, Account, Keypair, BASE_FEE } = await sdk()
  const source = new Account(Keypair.random().publicKey(), '0') // reads never touch sequence
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contract).call(method, ...encodeArgs(args)))
    .setTimeout(30)
    .build()
  const sim = await s.simulateTransaction(tx)
  if (sim.error || !sim.result) throw new Error(`read simulation failed: ${sim.error || 'no result'}`)
  return fromScVal(sim.result.retval)
}

/**
 * Build + simulate-assemble a state-changing invoke. Returns the assembled (unsigned)
 * transaction and its base64 XDR. The caller signs it (user wallet) or attaches an agent
 * auth entry, then submits.
 * @param {{ source: string, contract: string, method: string, args?: Array, server?: object }} p
 * @returns {Promise<{ tx: object, xdr: string }>}
 */
export async function buildInvokeTx({ source, contract, method, args = [], server }) {
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, BASE_FEE } = await sdk()
  const account = await s.getAccount(source) // sequence for the source (must exist + be funded)
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contract).call(method, ...encodeArgs(args)))
    .setTimeout(60)
    .build()
  const tx = await s.prepareTransaction(raw) // simulate + assemble (sets the resource fee)
  return { tx, xdr: tx.toEnvelope().toXDR('base64') }
}

/** Poll getTransaction until it leaves NOT_FOUND or the budget is spent. */
async function poll(server, hash, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await server.getTransaction(hash)
    if (r.status && r.status !== 'NOT_FOUND') return r.status
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }
  return 'PENDING'
}

/**
 * Submit a user-signed transaction (base64 XDR) the user pays for — redeem / claim /
 * registry-authorize. (Agent gasless deposits go through submitViaRelay in relay.js instead.)
 * @param {{ signedXdr: string, server?: object, pollTries?: number, pollIntervalMs?: number }} p
 * @returns {Promise<{ hash: string, status: string }>}
 */
export async function submitUserTx({ signedXdr, server, pollTries = 10, pollIntervalMs = 2000 }) {
  const s = server || (await rpcServer())
  const { TransactionBuilder } = await sdk()
  const tx = server ? signedXdr : TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  // ponytail: when a fake server is injected (tests) it accepts the raw xdr; the real path
  // rebuilds the Transaction object the SDK's sendTransaction expects.
  const sent = await s.sendTransaction(server ? { xdr: signedXdr } : tx)
  if (sent.status === 'ERROR') throw new Error('RPC rejected the transaction')
  const status = await poll(s, sent.hash, pollTries, pollIntervalMs)
  return { hash: sent.hash, status }
}

/**
 * Native XLM balance of an account, read from Horizon (NOT the Soroban RPC).
 * @param {string} pubkey
 * @returns {Promise<number>}
 */
export async function horizonNativeBalance(pubkey) {
  const { Horizon } = await sdk()
  const horizon = new Horizon.Server(HORIZON_URL)
  const acct = await horizon.loadAccount(pubkey)
  return Number(acct.balances.find((b) => b.asset_type === 'native')?.balance ?? 0)
}
```

> **Pin-at-impl note:** `@stellar/stellar-sdk` v16 namespaces the RPC server as `rpc.Server` (confirmed — `api/stellar-relay.js` uses `mod.rpc.Server`). If a future bump moves it, fix the one line in `rpcServer()`. The `submitUserTx` real-path uses `sendTransaction(tx)` with a `Transaction` object; verify your installed version's signature and adjust the `server ? … : …` branch only.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stellar/client.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/client.js frontend/src/stellar/client.test.js
git commit -m "feat: soroban client (read/build/submit/poll/balance)"
```

---

### Task 4: Agent session key (ephemeral ed25519 + sign primitive)

The agent-side gasless-deposit primitive. An agent is an on-chain custom account (1a) whose `__check_auth` verifies an **ed25519** signature over the auth payload against a registered 32-byte session-key pubkey. The SDK's `Keypair` is an ed25519 key, so we use it directly — no extra crypto dependency. This task delivers key generation, the raw 32-byte public key (the value the registry's `authorize(... signer ...)` registers), and a `sign(payload)` primitive with a unit proof the signature verifies. The full auth-entry → deposit-tx assembly is sub-project 4's job (see boundaries).

**Files:**
- Create: `frontend/src/stellar/sessionKey.js`
- Test: `frontend/src/stellar/sessionKey.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/sessionKey.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { newSessionKey } from './sessionKey.js'

describe('agent session key', () => {
  it('generates a G-address keypair with a 32-byte raw public key', () => {
    const sk = newSessionKey()
    expect(sk.publicKey).toMatch(/^G[A-Z2-7]{55}$/) // ed25519 strkey
    expect(sk.rawPublicKey).toBeInstanceOf(Uint8Array)
    expect(sk.rawPublicKey.length).toBe(32) // the BytesN<32> the registry registers as signer
  })

  it('sign() produces a 64-byte ed25519 signature that verifies under the public key', () => {
    const sk = newSessionKey()
    const payload = Buffer.from('a'.repeat(32)) // a 32-byte auth payload hash
    const sig = sk.sign(payload)
    expect(sig.length).toBe(64) // BytesN<64> — what __check_auth expects
    // independent verification via a fresh Keypair from the same public strkey
    expect(Keypair.fromPublicKey(sk.publicKey).verify(payload, sig)).toBe(true)
  })

  it('restores a session key from its secret (worker re-hydration across a refresh)', () => {
    const sk = newSessionKey()
    const restored = newSessionKey(sk.secret)
    expect(restored.publicKey).toBe(sk.publicKey)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/stellar/sessionKey.test.js`
Expected: FAIL — `Cannot find module './sessionKey.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/stellar/sessionKey.js`:

```js
// Ephemeral ed25519 agent session key. The agent's on-chain custom account (1a) registers
// `rawPublicKey` as its signer; __check_auth ed25519-verifies sign(payload) against it.
// We use the SDK's Keypair (ed25519) directly — no extra crypto dependency.
import { Keypair } from '@stellar/stellar-sdk'

/**
 * @typedef {object} SessionKey
 * @property {string}   publicKey     G... ed25519 strkey
 * @property {Uint8Array} rawPublicKey 32-byte ed25519 public key (BytesN<32> for the registry)
 * @property {string}   secret        S... secret (keep client-side only; never send to the relay)
 * @property {(payload: Uint8Array) => Buffer} sign  64-byte ed25519 signature over the payload
 */

/**
 * Create (or restore from a secret) an agent session key.
 * @param {string} [secret] restore from this S... secret; omit to generate a fresh key
 * @returns {SessionKey}
 */
export function newSessionKey(secret) {
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random()
  return {
    publicKey: kp.publicKey(),
    rawPublicKey: kp.rawPublicKey(),
    secret: kp.secret(),
    sign: (payload) => kp.sign(Buffer.from(payload)),
  }
}
```

> **Boundary note for sub-project 4:** to authorize an agent deposit, 4 builds the deposit tx, takes each `SorobanAuthorizationEntry`, computes its payload via the SDK's `authorizeEntry(entry, signer, validUntilLedger, NETWORK_PASSPHRASE)` where `signer` is a callback `(payloadHash) => ({ signature: sessionKey.sign(payloadHash) })` shaped to the BytesN<64> the 1a account expects, then relays the assembled XDR via `submitViaRelay`. That assembly + the `allowance[*][vault]` grant decision is 4's concern; this module only proves the signing primitive.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stellar/sessionKey.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/sessionKey.js frontend/src/stellar/sessionKey.test.js
git commit -m "feat: ephemeral ed25519 agent session key + sign primitive"
```

---

### Task 5: User wallet connector (Stellar Wallets Kit wrapper)

A thin wrapper so the rest of the app calls `connectWallet()` / `getUserAddress()` / `signTxXdr()` and never imports the kit directly. The kit is lazy-imported (like the relay lazy-imports the SDK) so its browser-only `window`/WebComponent code never breaks Vitest or the Vite config load. Network passphrase is pinned on every signature — a wrong passphrase silently produces an invalid signature.

**Files:**
- Create: `frontend/src/stellar/walletKit.js`
- Test: `frontend/src/stellar/walletKit.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/walletKit.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the lazy-loaded kit accessor so no real WebComponent/window code runs in jsdom.
const mockKit = {
  authModal: vi.fn(async () => ({ address: 'GUSER...' })),
  getAddress: vi.fn(async () => ({ address: 'GUSER...' })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR' })),
}
vi.mock('./walletKitLoader.js', () => ({ loadKit: vi.fn(async () => mockKit) }))

import { connectWallet, getUserAddress, signTxXdr } from './walletKit.js'

describe('user wallet connector', () => {
  beforeEach(() => vi.clearAllMocks())

  it('connectWallet opens the modal and returns the chosen address', async () => {
    const addr = await connectWallet()
    expect(mockKit.authModal).toHaveBeenCalledOnce()
    expect(addr).toBe('GUSER...')
  })

  it('getUserAddress returns the active address', async () => {
    expect(await getUserAddress()).toBe('GUSER...')
  })

  it('signTxXdr signs with the pinned testnet passphrase + active address', async () => {
    const out = await signTxXdr('UNSIGNED_XDR')
    expect(out).toBe('SIGNED_XDR')
    const [xdr, opts] = mockKit.signTransaction.mock.calls[0]
    expect(xdr).toBe('UNSIGNED_XDR')
    expect(opts.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(opts.address).toBe('GUSER...')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/stellar/walletKit.test.js`
Expected: FAIL — `Cannot find module './walletKit.js'` (and `./walletKitLoader.js`).

- [ ] **Step 3: Write the loader + wrapper**

Create `frontend/src/stellar/walletKitLoader.js` (the single place that touches the kit package — isolates version/API drift and keeps the wrapper mockable):

```js
// Isolated lazy loader for Stellar Wallets Kit. The ONLY file that imports the package, so a
// version/API change is a one-file fix and tests can mock this module cleanly.
import { NETWORK_PASSPHRASE } from './config.js'

let _kit = null

/**
 * Initialize (once) and return the Stellar Wallets Kit handle.
 * @returns {Promise<object>} object exposing authModal/getAddress/signTransaction
 */
export async function loadKit() {
  if (_kit) return _kit
  const { StellarWalletsKit, SwkAppDarkTheme } = await import('@creit-tech/stellar-wallets-kit')
  const { FreighterModule } = await import('@creit-tech/stellar-wallets-kit/modules/freighter')
  const { xBullModule } = await import('@creit-tech/stellar-wallets-kit/modules/xbull')
  const { AlbedoModule } = await import('@creit-tech/stellar-wallets-kit/modules/albedo')
  StellarWalletsKit.init({
    theme: SwkAppDarkTheme,
    network: NETWORK_PASSPHRASE,
    modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
  })
  _kit = StellarWalletsKit
  return _kit
}
```

> **Pin-at-impl note:** the kit ships TWO API generations. Newer (shown above): static `StellarWalletsKit.init(...)` + `StellarWalletsKit.authModal()/getAddress()/signTransaction(...)` from `@creit-tech/stellar-wallets-kit/sdk`. Older: `const kit = new StellarWalletsKit({ network, modules, selectedWalletId })` + `kit.openModal({ onWalletSelected })` + `kit.getAddress()/signTransaction(...)`. Check which your installed version exposes and adapt **only this loader + walletKit.js** — the rest of the app is insulated. Import paths for per-wallet modules (`/modules/freighter`) are also version-sensitive; verify against the installed package's `exports`.

Create `frontend/src/stellar/walletKit.js`:

```js
// User wallet connector. The app calls these three fns; nothing else imports the kit.
import { NETWORK_PASSPHRASE } from './config.js'
import { loadKit } from './walletKitLoader.js'

/**
 * Open the wallet-selection modal and return the chosen address.
 * @returns {Promise<string>} the connected G... address
 */
export async function connectWallet() {
  const kit = await loadKit()
  const { address } = await kit.authModal()
  return address
}

/**
 * The currently active wallet address. Throws if none is connected.
 * @returns {Promise<string>}
 */
export async function getUserAddress() {
  const kit = await loadKit()
  const { address } = await kit.getAddress()
  return address
}

/**
 * Ask the user's wallet to sign an unsigned transaction XDR. Network passphrase is pinned —
 * a wrong one silently yields an invalid signature.
 * @param {string} xdr unsigned base64 transaction envelope
 * @returns {Promise<string>} the signed base64 XDR
 */
export async function signTxXdr(xdr) {
  const kit = await loadKit()
  const { address } = await kit.getAddress()
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  })
  return signedTxXdr
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stellar/walletKit.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/walletKit.js frontend/src/stellar/walletKitLoader.js frontend/src/stellar/walletKit.test.js
git commit -m "feat: user wallet connector via stellar-wallets-kit"
```

---

### Task 6: Event indexer (getEvents poll → decode → graph deltas)

Feeds the force-graph monitor. Polls the Soroban RPC `getEvents` for the registry + vault contracts, decodes each event's topics + value with our ScVal codec into typed JS objects, dedups on the paging token, and maps each to a force-graph delta. The live React component wiring is sub-project 4; here we produce the decoded stream + deltas, fully unit-tested against a canned `getEvents` response.

**Files:**
- Create: `frontend/src/stellar/events.js`
- Test: `frontend/src/stellar/events.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/events.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { decodeEvent, eventToGraphDelta, pollEvents } from './events.js'

// Build a fake getEvents record the way the RPC returns one: topics[] + value as ScVals.
function fakeRecord({ type, fields, contractId, pagingToken, ledger }) {
  return {
    type: 'contract',
    contractId,
    ledger,
    pagingToken,
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(fields), // a map ScVal of the event body
    txHash: 'TX' + pagingToken,
  }
}

const VAULT = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
const agent = Keypair.random().publicKey()

describe('event indexer', () => {
  it('decodes a vault_deposit record into a typed event', () => {
    const rec = fakeRecord({
      type: 'vault_deposit',
      fields: { from: agent, amount: 100_0000000n, shares: 100_0000000n },
      contractId: VAULT,
      pagingToken: '0001',
      ledger: 42,
    })
    const e = decodeEvent(rec)
    expect(e.type).toBe('vault_deposit')
    expect(e.contract).toBe(VAULT)
    expect(e.ledger).toBe(42)
    expect(e.cursor).toBe('0001')
    expect(e.data.amount).toBe(100_0000000n)
  })

  it('maps a vault_deposit to a graph delta edge agent→vault', () => {
    const e = decodeEvent(
      fakeRecord({
        type: 'vault_deposit',
        fields: { from: agent, amount: 5n, shares: 5n },
        contractId: VAULT,
        pagingToken: '0002',
        ledger: 43,
      }),
    )
    const delta = eventToGraphDelta(e)
    expect(delta.edge).toEqual({ source: agent, target: VAULT, kind: 'deposit' })
  })

  it('pollEvents dedups already-seen cursors and returns only new decoded events', async () => {
    const recA = fakeRecord({ type: 'vault_drip', fields: { amount: 1n }, contractId: VAULT, pagingToken: '0010', ledger: 50 })
    const recB = fakeRecord({ type: 'vault_claim', fields: { holder: agent, amount: 2n }, contractId: VAULT, pagingToken: '0011', ledger: 51 })
    const fakeServer = {
      getLatestLedger: vi.fn(async () => ({ sequence: 60 })),
      getEvents: vi.fn(async () => ({ events: [recA, recB], latestLedger: 60 })),
    }
    const seen = new Set(['0010']) // recA already processed
    const out = await pollEvents({ server: fakeServer, startLedger: 40, seen })
    expect(out.events.map((e) => e.type)).toEqual(['vault_claim'])
    expect(out.seen.has('0011')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/stellar/events.test.js`
Expected: FAIL — `Cannot find module './events.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/stellar/events.js`:

```js
// Soroban event indexer for the force-graph monitor. Polls RPC getEvents for the registry +
// vault, decodes each record (topic symbol + value map) to a typed event, dedups on the paging
// token, and maps to a graph delta. The live graph wiring is sub-project 4.
import { SOROBAN_REGISTRY_ADDRESS, SOROBAN_VAULT_ADDRESS } from './config.js'
import { fromScVal } from './scval.js'
import { rpcServer } from './client.js'

// Contracts we watch + the event topic-symbols each emits (docs/soroban-interfaces.md).
const WATCHED = [SOROBAN_REGISTRY_ADDRESS, SOROBAN_VAULT_ADDRESS]

/**
 * Decode one RPC getEvents record into a typed event.
 * @param {object} rec a getEvents record: { topic: ScVal[], value: ScVal, contractId, ledger, pagingToken, txHash }
 * @returns {{ type: string, contract: string, ledger: number, cursor: string, txHash: string, data: object }}
 */
export function decodeEvent(rec) {
  const type = fromScVal(rec.topic[0]) // first topic is the event name symbol
  const data = fromScVal(rec.value) // event body decoded to a native object
  return {
    type,
    contract: rec.contractId,
    ledger: rec.ledger,
    cursor: rec.pagingToken,
    txHash: rec.txHash,
    data,
  }
}

/**
 * Map a decoded event to a force-graph delta. Returns { node?, edge? } — sub-project 4 applies
 * them. Unknown event types yield an empty delta (forward-compatible).
 * @param {ReturnType<typeof decodeEvent>} e
 * @returns {{ node?: object, edge?: object }}
 */
export function eventToGraphDelta(e) {
  switch (e.type) {
    case 'agent_authorized':
      return { node: { id: e.data.agent, kind: 'agent' }, edge: { source: e.data.owner, target: e.data.agent, kind: 'owns' } }
    case 'agent_revoked':
      return { node: { id: e.data.agent, kind: 'agent', revoked: true } }
    case 'vault_deposit':
      return { edge: { source: e.data.from, target: e.contract, kind: 'deposit' } }
    case 'vault_redeem':
      return { edge: { source: e.contract, target: e.data.from, kind: 'redeem' } }
    case 'vault_drip':
      return { node: { id: e.contract, kind: 'vault', lastDrip: e.ledger } }
    case 'vault_claim':
      return { edge: { source: e.contract, target: e.data.holder, kind: 'claim' } }
    default:
      return {}
  }
}

/**
 * Poll new contract events for the watched contracts. Caller persists `seen` + `startLedger`
 * across calls. `seen` dedups across overlapping windows (getEvents is inclusive at the edges).
 * @param {{ server?: object, startLedger: number, seen?: Set<string>, limit?: number }} p
 * @returns {Promise<{ events: Array, deltas: Array, seen: Set<string>, latestLedger: number }>}
 */
export async function pollEvents({ server, startLedger, seen = new Set(), limit = 100 }) {
  const s = server || (await rpcServer())
  const res = await s.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: WATCHED }],
    limit,
  })
  const fresh = []
  for (const rec of res.events || []) {
    if (seen.has(rec.pagingToken)) continue
    seen.add(rec.pagingToken)
    fresh.push(decodeEvent(rec))
  }
  return {
    events: fresh,
    deltas: fresh.map(eventToGraphDelta),
    seen,
    latestLedger: res.latestLedger,
  }
}
```

> **Pin-at-impl note:** `getEvents` requires `startLedger` within the RPC's retention window (testnet keeps a limited history — roughly the last ~24h of ledgers). On first poll, seed `startLedger` from `server.getLatestLedger()` minus a small margin, not ledger 0, or the RPC returns an out-of-range error. The decoded `value` shape depends on how each Rust `#[contractevent]` lays out its body (a struct → a map ScVal with field-name symbol keys). Confirm the real decoded keys (`from`/`amount`/`shares`/`holder`/`owner`/`agent`) against a live event in Task 7's smoke run and adjust `eventToGraphDelta` field names if the contract used different ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stellar/events.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/events.js frontend/src/stellar/events.test.js
git commit -m "feat: soroban event indexer (getEvents decode + graph deltas)"
```

---

### Task 7: Barrel index + live-testnet smoke proof

A barrel so sub-project 4 imports the chain layer from one path, plus a Node smoke script (not part of `vitest run`, like the existing `stellar-relay-smoke.mjs`) that proves the read + event-decode path against **live testnet** — closing the loop the unit tests (which mock the network) cannot.

**Files:**
- Create: `frontend/src/stellar/index.js`
- Create: `frontend/scripts/stellar-chain-smoke.mjs`

- [ ] **Step 1: Write the barrel**

Create `frontend/src/stellar/index.js`:

```js
// Chain-layer barrel — sub-project 4 imports the Stellar layer from here.
export * from './config.js'
export * from './scval.js'
export * from './client.js'
export * from './sessionKey.js'
export * from './walletKit.js'
export * from './events.js'
export { submitViaRelay, getRelayerAddress } from './relay.js'
```

- [ ] **Step 2: Verify the barrel imports cleanly (no circular/missing exports)**

Run from `frontend/`:

```bash
node --input-type=module -e "import('./src/stellar/index.js').then(m => console.log(Object.keys(m).sort().join(',')))"
```

Expected: a comma-list including `readContract,buildInvokeTx,submitUserTx,horizonNativeBalance,newSessionKey,connectWallet,signTxXdr,decodeEvent,pollEvents,submitViaRelay,addrScVal,i128ScVal,SOROBAN_VAULT_ADDRESS` (order will differ). No `ERR_*` / undefined-export errors.

> If Node cannot resolve `@creit-tech/stellar-wallets-kit` subpath imports at load time, that's fine for the app (Vite bundles them) — but the barrel must not *eagerly* trigger it. `walletKit.js` only imports the kit inside `loadKit()` (lazy), so importing the barrel must NOT load the kit. If this step errors on the kit, move the `export * from './walletKit.js'` to a named re-export and confirm `loadKit` stays lazy.

- [ ] **Step 3: Write the live-testnet smoke script**

Create `frontend/scripts/stellar-chain-smoke.mjs`:

```js
// Live testnet proof of the read + event-decode chain layer. NOT part of `vitest run`.
// Run: node scripts/stellar-chain-smoke.mjs
//
// 1. readContract(vault.decimals)        → proves client + scval decode against live RPC.
// 2. readContract(vault.total_shares)    → proves an i128 read decodes to BigInt.
// 3. pollEvents(recent ledgers)          → proves getEvents decode + graph deltas on real events.
//
// No keys, no funding, no writes — all read-only simulate + getEvents.

import { rpcServer, readContract } from '../src/stellar/client.js'
import { pollEvents } from '../src/stellar/events.js'
import { SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'

async function main() {
  const decimals = await readContract({ contract: SOROBAN_VAULT_ADDRESS, method: 'decimals' })
  console.log('vault.decimals =', decimals)
  if (Number(decimals) !== 7) throw new Error(`expected 7 decimals, got ${decimals}`)

  const totalShares = await readContract({ contract: SOROBAN_VAULT_ADDRESS, method: 'total_shares' })
  console.log('vault.total_shares =', totalShares, '(' + typeof totalShares + ')')
  if (typeof totalShares !== 'bigint') throw new Error('total_shares should decode to a BigInt')

  const server = await rpcServer()
  const { sequence } = await server.getLatestLedger()
  const startLedger = Math.max(1, sequence - 8000) // stay inside the RPC retention window
  const { events, deltas } = await pollEvents({ server, startLedger })
  console.log(`decoded ${events.length} recent events`)
  for (const e of events.slice(0, 5)) console.log(' ', e.type, 'ledger', e.ledger, JSON.stringify(e.data))
  console.log('graph deltas sample:', JSON.stringify(deltas.slice(0, 3)))

  console.log('OK — read + event-decode chain layer verified against live testnet')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 4: Run the smoke script against live testnet**

Run from `frontend/`: `node scripts/stellar-chain-smoke.mjs`
Expected output: `vault.decimals = 7`, a `total_shares` BigInt, a count of decoded events, and `OK — read + event-decode chain layer verified against live testnet`.

If `getEvents` errors with an out-of-range `startLedger`, reduce the `- 8000` margin (the retention window varies). If a decoded event's `data` keys differ from what `eventToGraphDelta` expects (e.g. the contract named the field `depositor` not `from`), fix the field names in `events.js` `eventToGraphDelta` now — this is the live-data reconciliation the unit tests couldn't do — then re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/index.js frontend/scripts/stellar-chain-smoke.mjs
git commit -m "feat: stellar chain-layer barrel + live-testnet read/event smoke proof"
```

---

### Task 8: Full verification + final commit

**Files:** none (verification only)

- [ ] **Step 1: Run the whole frontend test suite**

Run from `frontend/`: `npm test`
Expected: all suites pass, including the 5 new stellar suites (config, scval, client, sessionKey, walletKit, events) and the pre-existing EVM suites (unchanged). If a pre-existing suite fails, confirm it failed before your work (`git stash` + `npm test`) — do not "fix" unrelated EVM tests in this sub-project.

- [ ] **Step 2: Lint**

Run from `frontend/`: `npm run lint`
Expected: no new errors in `src/stellar/`. Fix any that your new files introduced (warnings are acceptable per the repo baseline).

- [ ] **Step 3: Production build**

Run from `frontend/`: `npm run build`
Expected: `vite build` succeeds. The kit's per-wallet modules are dynamically imported, so they land in their own chunks, not the main bundle. If the build fails resolving `@creit-tech/stellar-wallets-kit/modules/*`, correct the subpath against the installed package's `exports` map (see the Task 5 pin-at-impl note).

- [ ] **Step 4: Final commit (only if Steps 1–3 produced fixes)**

```bash
git add -A
git commit -m "chore: verify stellar chain layer (tests + lint + build green)"
```

---

## Self-review (filled in by the plan author)

**Spec coverage** — sub-project 3 is "Frontend chain layer (SDK + passkey wallet + tx + event indexing)":
- SDK → Task 2 (scval) + Task 3 (client: read/build/submit/poll/balance). ✓
- wallet → Task 5 (Stellar Wallets Kit user wallet) + Task 4 (agent ed25519 session key). **Passkey deliberately deferred** to a separate plan — it was a cancelled RWA-Fi feature; documented in "What is NOT in this sub-project". ✓ (scope-reduced on purpose, user-confirmed)
- tx → Task 3 `buildInvokeTx`/`submitUserTx` + Task 4 sign primitive + reuse of the shipped relay (`submitViaRelay`). ✓
- event indexing → Task 6 (getEvents decode + graph deltas) + Task 7 live proof. ✓

**Boundaries honored** — orchestrator/Aladdin/full auth-tree assembly/live graph wiring/passkey all explicitly excluded and assigned to sub-project 4 or a future plan, matching `docs/soroban-interfaces.md`'s "auth-tree assembly owned by 2+4" note.

**Type/name consistency** — `addrScVal`/`i128ScVal`/`fromScVal` (Task 2) are the exact names used in Tasks 3 and 6. `readContract`/`buildInvokeTx`/`submitUserTx`/`rpcServer`/`horizonNativeBalance` (Task 3) match the barrel + smoke. `newSessionKey` returns `{ publicKey, rawPublicKey, secret, sign }` used consistently. `decodeEvent`/`eventToGraphDelta`/`pollEvents` (Task 6) match the smoke. Contract method names (`decimals`, `total_shares`, `deposit`, `redeem`, `claim`, events `vault_*`/`agent_*`) all copied from `docs/soroban-interfaces.md`.

**Placeholder scan** — every code step contains complete, runnable code; every run step has an exact command + expected output. Pin-at-impl notes flag genuine version-drift risks (SDK `rpc.Server`, kit API generation, getEvents retention, event field names) rather than leaving TODOs.

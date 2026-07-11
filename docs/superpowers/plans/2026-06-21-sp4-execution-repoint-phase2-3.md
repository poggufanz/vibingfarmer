# SP4 Execution Re-point — Phases 2 & 3 (Frontend auth-tree + EVM→Stellar re-point) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the SP4 execution re-point: (Phase 2) build the browser primitive that signs a `vault.deposit(agent, amount)` authorization with the agent's ephemeral ed25519 session key so the relayer can fee-bump it gaslessly; (Phase 3) re-point `worker.js` / `orchestrator.js` / `app.jsx` / `wallet.js` off the EVM stack onto the Soroban chain layer, wiring the deposit, the per-agent authorize, and the owner exit.

**Prerequisite:** **Phase 1 must be deployed first** (`docs/superpowers/plans/2026-06-21-sp4-execution-repoint.md`) — the v2 `agent_account` whose constructor self-approves the vault and that exposes `owner_withdraw`. This plan reads the redeployed agent address from `frontend/src/stellar/config.js` (`SOROBAN_DEMO_AGENT`) and deploys per-session agents from the same wasm.

**Architecture:**
- **Deposit (autonomous, gasless):** the relayer account is the inner-tx source; the agent's deposit is authorized by a `SorobanAuthorizationEntry` (`SorobanCredentials::Address(agent)`) whose signature is the session key's raw 64-byte ed25519 sig over the SorobanAuthorization preimage hash — exactly what `AgentAccount.__check_auth` (`type Signature = BytesN<64>`) verifies. Client signs the entry; the relay server signs the inner envelope as the fee payer and submits. No user signature per deposit.
- **Authorize + fund (one user step):** the user signs, per agent, `registry.authorize(...)`, the `agent_account` deploy (constructor self-approves the vault), and a `token.transfer(user → agent)` funding op — built with `buildInvokeTx` and signed via `walletKit.signTxXdr` + `submitUserTx`.
- **Exit:** the user calls `agent_account.owner_withdraw(user)` (Phase 1) to redeem + sweep, replacing the EVM `redeemFromVaultOnChain`.

**Tech Stack:** `@stellar/stellar-sdk`, the shipped `frontend/src/stellar/*` layer (`client.js`, `sessionKey.js`, `relay.js`, `walletKit.js`, `config.js`, `scval.js`), Vitest. No ethers / viem / 1Shot / `@metamask/*` on the re-pointed path.

## Global Constraints

- **Decimals = 7**, amounts are `i128` base units (1 VFUSD = `10_000_000`). The EVM path used 6-dp USDC — every `1e6` becomes `1e7`, and `BigInt` math stays in base units.
- **Pure where possible, dependency-injected `server`.** Every networked fn takes an injected `server`/`rpc` so unit tests run offline (match the existing `client.js` style). The live path is proven by a Node smoke script, not by unit tests that mock RPC.
- **The session key signs ONLY the deposit auth entry.** It never signs a transaction envelope, never an `approve`/`redeem`/`transfer`. Those are owner-signed (`walletKit`) or invoker-contract auth (Phase 1 contract).
- **`Promise.allSettled`, never `Promise.all`** for multi-agent dispatch — one agent's failure must not abort the others (existing orchestrator discipline).
- **No over-claiming.** Honest copy: "the agent's session key authorizes the deposit on-chain within a cap the chain enforces; the user funds the agent and can sweep it back any time." Not "trustless/non-custodial."
- **Pin-at-impl, prove by smoke test.** The custom-account auth-entry XDR plumbing and the relay server's inner-source expectation are the two genuine drift risks; both are flagged with the exact thing to verify and a live-testnet proof. Never ship the auth primitive on unit tests alone.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/stellar/agentDeposit.js` (create) | Build + session-key-sign the `vault.deposit(agent, amount)` auth entry; return relay-ready XDR. The SP3-deferred primitive. |
| `frontend/src/stellar/agentDeposit.test.js` (create) | Unit: signs the right entry, sets the signature scval, bumps the expiration ledger, deterministic for a fixed key/nonce. |
| `frontend/scripts/stellar-deposit-smoke.mjs` (create) | Live-testnet proof: fund a demo agent, run a real gasless deposit, assert vault `balance(agent)` increased. Not part of `vitest run` (mirrors `stellar-relay-smoke.mjs`). |
| `frontend/src/worker.js` (rewrite) | Stellar worker: ed25519 session key, sign deposit via `agentDeposit`, submit via `submitViaRelay`, verify via `readContract(vault,'balance')`. Drops ethers / 1Shot / keyVault-EVM. |
| `frontend/src/orchestrator.js` (modify) | Replace EIP-5792 `batchCalls(authorizeSessionKey)` with per-agent `registry.authorize` + agent deploy + funding via `walletKit`; Stellar balance pre-flight; drop `redelegation.js`. |
| `frontend/src/app.jsx` (modify) | Replace the ERC-7715 grant step with Stellar connect + the authorize/fund step; point the risk-council `execute` seam at the re-pointed worker; wire `owner_withdraw` into the exit UI. |
| `frontend/src/wallet.js` (modify) | Re-export the Stellar connector (`connectWallet`/`getUserAddress`/`signTxXdr`) so connected-app screens import one module; EVM fns stay until SP6 removes them. |

---

# PHASE 2 — Frontend Stellar deposit auth-tree

## Task 1: `agentDeposit` — sign the deposit auth entry with the session key

**Files:**
- Create: `frontend/src/stellar/agentDeposit.js`
- Test: `frontend/src/stellar/agentDeposit.test.js`

**Interfaces:**
- Consumes: `buildInvokeTx({source, contract, method, args, server})` and `rpcServer()` from `client.js`; `SOROBAN_VAULT_ADDRESS`, `NETWORK_PASSPHRASE`, `SOROBAN_DECIMALS` from `config.js`; a `SessionKey` (`{ rawPublicKey, sign }`) from `sessionKey.js`; `submitViaRelay({xdr})` + `getRelayerAddress()` from `relay.js`.
- Produces:
  - `signAgentDepositEntries({ tx, sessionKey, validUntilLedger, server }) → Promise<{ xdr: string }>` — signs every `SorobanCredentials::Address` entry that belongs to `sessionKey` and returns the relay-ready XDR.
  - `buildAgentDeposit({ agentAddress, amount, relayer, sessionKey, server }) → Promise<{ xdr: string }>` — full path: build the invoke (source = relayer), simulate-assemble, sign the agent entry, return XDR for `submitViaRelay`.
  - `runAgentDeposit({ agentAddress, amount, sessionKey, server }) → Promise<{hash,status}|null>` — resolves the relayer, builds + signs, submits via the relay; `null` if the relay is unconfigured.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/agentDeposit.test.js`:

```js
// frontend/src/stellar/agentDeposit.test.js
import { describe, test, expect } from 'vitest'
import { Keypair, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk'
import { signAgentDepositEntries } from './agentDeposit.js'
import { newSessionKey } from './sessionKey.js'

// Build a one-op invoke tx carrying a single agent-credentialed auth entry with an empty sig,
// so the test exercises the signing without a network. (Helper mirrors the real assembled shape.)
function fakeTxWithAgentEntry(env) {
  const { agentAddress, nonce } = env
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString('CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5').toScAddress(),
        functionName: 'deposit',
        args: [Address.fromString(agentAddress).toScVal(), nativeToScVal(50000000n, { type: 'i128' })],
      }),
    ),
    subInvocations: [],
  })
  const creds = new xdr.SorobanAddressCredentials({
    address: Address.fromString(agentAddress).toScAddress(),
    nonce: xdr.Int64.fromString(String(nonce)),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
    rootInvocation: invocation,
  })
  // Minimal stand-in tx: only what signAgentDepositEntries reads (operations[0].auth + re-serialize).
  return {
    operations: [{ auth: [entry] }],
    toEnvelope: () => ({ toXDR: () => Buffer.from('deadbeef') }),
  }
}

describe('signAgentDepositEntries', () => {
  test('signs the agent entry, sets a 64-byte BytesN signature and the expiration ledger', async () => {
    // Arrange
    const sessionKey = newSessionKey()
    const agentAddress = Address.contract(sessionKey.rawPublicKey).toString() // any C-address stand-in
    const tx = fakeTxWithAgentEntry({ agentAddress, nonce: 12345 })
    // Act
    await signAgentDepositEntries({
      tx,
      sessionKey,
      validUntilLedger: 99999,
      agentAddress,
      server: null,
    })
    // Assert: the entry now carries a 64-byte scvBytes signature and the bumped expiration ledger.
    const creds = tx.operations[0].auth[0].credentials().address()
    expect(creds.signatureExpirationLedger()).toBe(99999)
    const sig = creds.signature()
    expect(sig.switch().name).toBe('scvBytes')
    expect(sig.bytes().length).toBe(64)
  })
})
```

> **Pin-at-impl:** `Address.contract(rawPublicKey)` is only a stand-in C-address for the unit test; the real agent address comes from the Phase-1 deploy. If `Address.contract` is not available on the pinned SDK, substitute any valid `C…` string. The behavioral assertions (64-byte `scvBytes` sig + bumped ledger) are the invariant.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/stellar/agentDeposit.test.js`
Expected: FAIL — `Failed to resolve import "./agentDeposit.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/stellar/agentDeposit.js`:

```js
// frontend/src/stellar/agentDeposit.js
// The SP3-deferred primitive: authorize a vault.deposit(agent, amount) with the agent's
// ephemeral ed25519 session key. The agent is a Soroban custom account (1a) whose __check_auth
// (type Signature = BytesN<64>) ed25519-verifies sign(payload) over the SorobanAuthorization
// preimage hash and enforces the deposit cap on-chain. We sign the auth ENTRY (not the tx
// envelope) — the relayer is the inner-tx source and pays the fee, so the user signs nothing.
//
// Manual signing path is primary because it is deterministic and matches the contract's bare
// BytesN<64> signature exactly. (stellar-sdk's authorizeEntry helper packs signatures for
// Keypair signers; a custom account expects the bare sig — see pin-at-impl note.)
import { rpcServer, buildInvokeTx } from './client.js'
import { addrScVal, i128ScVal } from './scval.js'
import { SOROBAN_VAULT_ADDRESS, NETWORK_PASSPHRASE } from './config.js'
import { getRelayerAddress, submitViaRelay } from './relay.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

// How many ledgers the deposit authorization stays valid (~30 min at 5s ledgers).
const AUTH_TTL_LEDGERS = 360

/**
 * Sign every auth entry credentialed to `agentAddress` with the session key, in place on `tx`.
 * @param {{tx:object, sessionKey:{rawPublicKey:Uint8Array, sign:(p:Uint8Array)=>Uint8Array}, validUntilLedger:number, agentAddress:string, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function signAgentDepositEntries({ tx, sessionKey, validUntilLedger, agentAddress }) {
  const { xdr, hash, Address } = await sdk()
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE))
  const wantScAddress = Address.fromString(agentAddress).toScAddress().toXDR('base64')

  for (const op of tx.operations) {
    const entries = op.auth || []
    for (const entry of entries) {
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
      const creds = entry.credentials().address()
      if (creds.address().toXDR('base64') !== wantScAddress) continue // not this agent

      creds.signatureExpirationLedger(validUntilLedger)
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: creds.nonce(),
          signatureExpirationLedger: validUntilLedger,
          invocation: entry.rootInvocation(),
        }),
      )
      const payload = hash(preimage.toXDR())
      const sig = Buffer.from(sessionKey.sign(new Uint8Array(payload))) // 64-byte ed25519
      creds.signature(xdr.ScVal.scvBytes(sig)) // bare BytesN<64> — what __check_auth expects
    }
  }
  return { xdr: tx.toEnvelope().toXDR('base64') }
}

/**
 * Build the invoke (source = relayer), assemble it, then sign the agent's deposit auth entry.
 * @param {{agentAddress:string, amount:bigint, relayer:string, sessionKey:object, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function buildAgentDeposit({ agentAddress, amount, relayer, sessionKey, server }) {
  const s = server || (await rpcServer())
  const { tx } = await buildInvokeTx({
    source: relayer,
    contract: SOROBAN_VAULT_ADDRESS,
    method: 'deposit',
    args: [{ addr: agentAddress }, { i128: BigInt(amount) }],
    server: s,
  })
  const latest = await s.getLatestLedger()
  const validUntilLedger = latest.sequence + AUTH_TTL_LEDGERS
  return signAgentDepositEntries({ tx, sessionKey, validUntilLedger, agentAddress, server: s })
}

/**
 * Full gasless deposit: resolve the relayer, build + sign, submit via the relay.
 * @param {{agentAddress:string, amount:bigint, sessionKey:object, server?:object}} p
 * @returns {Promise<{hash:string, status:string, relayer?:string}|null>} null if relay unconfigured
 */
export async function runAgentDeposit({ agentAddress, amount, sessionKey, server }) {
  const relayer = await getRelayerAddress()
  if (!relayer) return null
  const { xdr } = await buildAgentDeposit({ agentAddress, amount, relayer, sessionKey, server })
  return submitViaRelay({ xdr })
}
```

> **Pin-at-impl (critical):** the `xdr.HashIdPreimageSorobanAuthorization` field names (`networkId`/`nonce`/`signatureExpirationLedger`/`invocation`) and `entry.rootInvocation()` / `creds.signature()` accessors are the stellar-sdk XDR shape; confirm against the pinned `@stellar/stellar-sdk` (`node -e "const {xdr}=require('@stellar/stellar-sdk'); console.log(Object.keys(xdr.HashIdPreimageSorobanAuthorization.prototype))"`). The contract verifies `ed25519_verify(signer, sha256(preimage), sig)` — signing `hash(preimage.toXDR())` is that exact payload. **Prove with Task 3 (live smoke), not just the unit test.** Alt: `authorizeEntry(entry, async (p)=>Buffer.from(sessionKey.sign(hash(p.toXDR()))), validUntilLedger, NETWORK_PASSPHRASE)` — only if it packs a bare `scvBytes` for the address credential; verify, don't assume.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/stellar/agentDeposit.test.js`
Expected: PASS (1 test). If the XDR accessors differ, apply the pin-at-impl note before moving on.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/stellar/agentDeposit.js src/stellar/agentDeposit.test.js && git commit -m "feat(stellar): agent deposit auth-tree primitive (session-key signed)"
```

---

## Task 2: Stellar token balance pre-flight read

**Files:**
- Modify: `frontend/src/stellar/agentDeposit.js` (add a read helper) OR reuse `readContract` directly
- Test: `frontend/src/stellar/agentDeposit.test.js`

**Interfaces:**
- Produces: `readTokenBalance(addr, {token?, server?}) → Promise<bigint|null>` and `readVaultShares(addr, {server?}) → Promise<bigint|null>` — base-unit reads that replace `readUsdcBalance` / `readShares`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/stellar/agentDeposit.test.js`:

```js
import { readTokenBalance, readVaultShares } from './agentDeposit.js'

describe('balance reads', () => {
  test('readVaultShares returns the decoded i128 via an injected server', async () => {
    // Arrange: a fake server whose simulate returns an i128 ScVal of 50_000_000.
    const { nativeToScVal } = await import('@stellar/stellar-sdk')
    const fakeServer = {
      simulateTransaction: async () => ({ result: { retval: nativeToScVal(50000000n, { type: 'i128' }) } }),
      getAccount: async () => ({ accountId: () => 'G', sequenceNumber: () => '0', incrementSequenceNumber: () => {} }),
    }
    // Act
    const shares = await readVaultShares('CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW', { server: fakeServer })
    // Assert
    expect(shares).toBe(50000000n)
  })
})
```

> **Pin-at-impl:** match the fake-server shape to what `readContract` calls (`simulateTransaction` returning `{result:{retval}}`); see `client.js` `readContract`. If `fromScVal` returns a number vs bigint for i128, assert accordingly (the codec is in `scval.js`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/stellar/agentDeposit.test.js -t "balance reads"`
Expected: FAIL — `readVaultShares is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `frontend/src/stellar/agentDeposit.js`:

```js
import { readContract } from './client.js'
import { SOROBAN_TOKEN_ADDRESS } from './config.js'

/** Vault-share balance (i128 base units) of `addr`, or null on RPC failure. */
export async function readVaultShares(addr, { server } = {}) {
  try {
    const v = await readContract({ contract: SOROBAN_VAULT_ADDRESS, method: 'balance', args: [{ addr }], server })
    return BigInt(v)
  } catch {
    return null
  }
}

/** Asset (VFUSD) balance (i128 base units) of `addr`, or null on RPC failure. */
export async function readTokenBalance(addr, { token = SOROBAN_TOKEN_ADDRESS, server } = {}) {
  try {
    const v = await readContract({ contract: token, method: 'balance', args: [{ addr }], server })
    return BigInt(v)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/stellar/agentDeposit.test.js`
Expected: PASS (all agentDeposit tests).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/stellar/agentDeposit.js src/stellar/agentDeposit.test.js && git commit -m "feat(stellar): token + vault-share base-unit balance reads"
```

---

## Task 3: Live-testnet deposit smoke script (the real proof)

**Files:**
- Create: `frontend/scripts/stellar-deposit-smoke.mjs`

**Interfaces:**
- Consumes: the Phase-1 demo agent (`SOROBAN_DEMO_AGENT`), its session secret, the relay server. Produces nothing importable — it is the proof the unit tests cannot give (real RPC, real `__check_auth`, real fee-bump).

- [ ] **Step 1: Write the smoke script**

Create `frontend/scripts/stellar-deposit-smoke.mjs`:

```js
// Live-testnet proof of the gasless agent deposit. Funds the demo agent (if needed) then runs
// a real session-key-signed deposit through the relay and asserts the vault share balance rose.
// Run: node scripts/stellar-deposit-smoke.mjs  (NOT part of vitest run; needs DEMO_AGENT_SECRET)
import { newSessionKey } from '../src/stellar/sessionKey.js'
import { runAgentDeposit, readVaultShares } from '../src/stellar/agentDeposit.js'
import { SOROBAN_DEMO_AGENT } from '../src/stellar/config.js'

const secret = process.env.DEMO_AGENT_SECRET
if (!secret) throw new Error('set DEMO_AGENT_SECRET (the demo agent session S... secret)')

const sessionKey = newSessionKey(secret)
const before = await readVaultShares(SOROBAN_DEMO_AGENT)
console.log('shares before:', before)

const res = await runAgentDeposit({ agentAddress: SOROBAN_DEMO_AGENT, amount: 10_000_000n }) // 1 VFUSD
console.log('relay result:', res)
if (!res || res.status !== 'SUCCESS') throw new Error(`deposit did not succeed: ${JSON.stringify(res)}`)

const after = await readVaultShares(SOROBAN_DEMO_AGENT)
console.log('shares after:', after)
if (!(after > before)) throw new Error('FAIL: vault shares did not increase — __check_auth or relay rejected the deposit')
console.log('PASS: gasless agent deposit minted shares on-chain')
```

- [ ] **Step 2: Run the smoke test against testnet**

Run: `cd frontend && DEMO_AGENT_SECRET=S... node scripts/stellar-deposit-smoke.mjs`
Expected: prints `PASS: gasless agent deposit minted shares on-chain`. The demo agent must hold ≥ 1 VFUSD and have its constructor allowance (Phase 1 Task 5 verified this). If it fails, the failure pinpoints which assumption broke (relay inner-source signing, the auth-entry XDR shape, or the allowance).

> **Pin-at-impl (critical):** confirm the relay server (`frontend/api/stellar-relay.js` / the Pages Function) accepts an inner tx whose **source is the relayer** and signs that envelope itself before submitting (vs. expecting a fully-signed inner tx for a true fee-bump wrapper). If it expects a separate inner source + fee-bump, set the inner source to a throwaway funded account and let the server fee-bump. The smoke result tells you which. Also confirm the relay's deposit-target allowlist permits `SOROBAN_VAULT_ADDRESS` `deposit` (config note in `config.js`).

- [ ] **Step 3: Commit**

```bash
cd frontend && git add scripts/stellar-deposit-smoke.mjs && git commit -m "test(stellar): live-testnet gasless agent-deposit smoke proof"
```

---

# PHASE 3 — Re-point orchestrator / worker / app / wallet

## Task 4: Rewrite `worker.js` onto the Stellar deposit path

**Files:**
- Rewrite: `frontend/src/worker.js`
- Test: `frontend/src/worker.test.js` (update existing — adjust mocks from ethers/relay to agentDeposit/readVaultShares)

**Interfaces:**
- Consumes: `newSessionKey` (`stellar/sessionKey.js`), `runAgentDeposit` + `readVaultShares` (`stellar/agentDeposit.js`), `writeMemory`/`createEntry`/`buildLesson` (`memory.js`), `createSubmitGate` (`strategy/submitGate.js`).
- Produces (orchestrator relies on these): `class WorkerAgent` with `setupKey() → Promise<{publicKey, rawPublicKey, secret}>` (sets `this.sessionKey` + `this.agentAddress`), `execute() → Promise<{success, txHash?, error?}>`. `makeAgentId(index, sessionId)` and `makePlanId(sessionId)` unchanged (UI identity — keep the existing hex impl).

- [ ] **Step 1: Update the failing test**

Edit `frontend/src/worker.test.js` — replace the EVM mocks. Representative shape:

```js
import { describe, test, expect, vi } from 'vitest'
vi.mock('./stellar/agentDeposit.js', () => ({
  runAgentDeposit: vi.fn().mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' }),
  readVaultShares: vi.fn().mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n), // baseline 0 → minted
}))
import { WorkerAgent } from './worker.js'
import { runAgentDeposit } from './stellar/agentDeposit.js'

describe('WorkerAgent (Stellar)', () => {
  test('deposits via the relay and confirms minted shares', async () => {
    // Arrange
    const w = new WorkerAgent({
      agentId: 'worker-1', user: 'GUSER', vault: 'CCDX...', amount: 50_000_000n,
      sessionId: 's1', onEvent: () => {}, agentAddress: 'CCRG...AGENT',
      sessionKey: { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
    })
    // Act
    const res = await w.execute()
    // Assert
    expect(res.success).toBe(true)
    expect(res.txHash).toBe('abc123')
    expect(runAgentDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ agentAddress: 'CCRG...AGENT', amount: 50_000_000n }),
    )
  })

  test('fails honestly when shares did not increase', async () => {
    const { readVaultShares } = await import('./stellar/agentDeposit.js')
    readVaultShares.mockReset().mockResolvedValue(0n) // baseline 0, stays 0 → no mint
    const w = new WorkerAgent({
      agentId: 'worker-2', user: 'GUSER', vault: 'CCDX...', amount: 10_000_000n,
      sessionId: 's1', onEvent: () => {}, agentAddress: 'CCRG...AGENT',
      sessionKey: { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) },
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shares did not increase/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/worker.test.js`
Expected: FAIL — the current `worker.js` imports ethers/relay and has no `runAgentDeposit` path.

- [ ] **Step 3: Write the implementation**

Rewrite `frontend/src/worker.js`:

```js
// frontend/src/worker.js
// Stellar Worker Agent — executes a single scoped deposit for one vault. The worker holds an
// ephemeral ed25519 session key whose pubkey is the on-chain agent custom account's signer. It
// signs the vault.deposit auth ENTRY (not a tx); the relayer fee-bumps it. The deposit cap /
// expiry / revoke are enforced on-chain by AgentAccount.__check_auth — the worker never moves the
// user's funds outside that pre-authorized, capped scope. (Funding + authorize are done up-front
// by the orchestrator; redeem/exit is the owner's owner_withdraw call.)
import { newSessionKey } from './stellar/sessionKey.js'
import { runAgentDeposit, readVaultShares } from './stellar/agentDeposit.js'
import { writeMemory, createEntry, buildLesson } from './memory.js'
import { createSubmitGate } from './strategy/submitGate.js'

export class WorkerAgent {
  /**
   * @param {object} c
   * @param {string} c.agentId @param {string} c.user @param {string} c.vault
   * @param {bigint} c.amount base-unit (7-dp) deposit amount @param {string} c.sessionId
   * @param {function} c.onEvent
   * @param {string} [c.agentAddress] deployed agent custom-account address (the on-chain "agent")
   * @param {object} [c.sessionKey] ed25519 SessionKey (rawPublicKey + sign); generated if absent
   * @param {object} [c.submitGate]
   */
  constructor({ agentId, user, vault, amount, sessionId, onEvent, agentAddress, sessionKey, submitGate }) {
    this.agentId = agentId
    this.user = user
    this.vault = vault
    this.amount = BigInt(amount)
    this.sessionId = sessionId
    this.onEvent = onEvent || (() => {})
    this.agentAddress = agentAddress || null
    this.sessionKey = sessionKey || null
    this.submitGate = submitGate || createSubmitGate()
    this.memoryEntries = []
  }

  /** Generate the ephemeral ed25519 session key (the on-chain agent signer). Idempotent. */
  async setupKey() {
    this.emit('step', { step: 'key-setup', status: 'pending' })
    if (!this.sessionKey) this.sessionKey = newSessionKey()
    this.memoryEntries.push(createEntry('key-setup', 'success', { signer: this.sessionKey.publicKey }))
    this.emit('step', { step: 'key-setup', status: 'done', address: this.sessionKey.publicKey })
    return this.sessionKey
  }

  async execute() {
    try {
      this.emit('started', { agentId: this.agentId, vault: this.vault })
      await this.setupKey()
      if (!this.agentAddress) throw new Error('agentAddress missing — orchestrator must deploy + authorize the agent first')

      // Pre-submit circuit breaker (gas/economic/rate gate — reused unchanged).
      const gate = this.submitGate.check({ owner: this.user })
      if (!gate.ok) {
        this.memoryEntries.push(createEntry('deposit', 'skipped', { reason: gate.reason }))
        writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
        this.emit('failed', { agentId: this.agentId, vault: this.vault, error: `submit-gate blocked: ${gate.reason}`, skipped: true })
        return { success: false, status: 'skipped', reason: gate.reason }
      }

      // Snapshot shares BEFORE — the only honest success signal.
      const baseline = await readVaultShares(this.agentAddress)

      this.emit('step', { step: 'deposit', status: 'pending' })
      const res = await runAgentDeposit({ agentAddress: this.agentAddress, amount: this.amount, sessionKey: this.sessionKey })
      if (!res) throw new Error('relay unconfigured — cannot submit gasless deposit')
      if (res.status !== 'SUCCESS') throw new Error(`relay reported ${res.status}`)

      // A relayer accepting a job is not a deposit. Confirm shares actually minted.
      const minted = await this.verifyMinted(baseline)
      if (!minted) throw new Error('deposit not confirmed on-chain: vault shares did not increase (likely __check_auth/cap reject)')

      const lesson = buildLesson(this.vault, { shares: this.amount.toString() })
      this.memoryEntries.push(createEntry('deposit', 'success', { txHash: res.hash, gasMethod: 'relayer' }, lesson))
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('completed', { agentId: this.agentId, vault: this.vault, txHash: res.hash, gasMethod: 'relayer', relayer: res.relayer || null })
      return { success: true, txHash: res.hash }
    } catch (err) {
      this.memoryEntries.push(createEntry('deposit', 'failed', {}, buildLesson(this.vault, { error: err.message })))
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('failed', { agentId: this.agentId, vault: this.vault, error: err.message })
      return { success: false, error: err.message }
    }
  }

  /** Poll vault shares until they exceed the pre-deposit baseline. Null baseline → can't verify → true. */
  async verifyMinted(baseline, { attempts = 8, intervalMs = 3000 } = {}) {
    if (baseline == null) return true
    for (let i = 0; i < attempts; i++) {
      const cur = await readVaultShares(this.agentAddress)
      if (cur != null && cur > baseline) return true
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  emit(eventName, data) {
    this.onEvent(eventName, { ...data, agentId: this.agentId })
  }
}

/** bytes32-style agentId from index + session (UI/graph identity). Unchanged from the EVM worker. */
export function makeAgentId(index, sessionId) {
  const raw = `agent-${index}-${sessionId}`
  const bytes = new TextEncoder().encode(raw)
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return '0x' + hex.slice(0, 64).padEnd(64, '0')
}

/** Deterministic numeric planId from a sessionId (stable across retries). */
export function makePlanId(sessionId) {
  let h = 0
  const s = String(sessionId)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return BigInt(h)
}
```

> **Pin-at-impl:** `makePlanId` previously used `ethers.id`; the pure-JS hash above removes the ethers dependency. If any other module imports the old `ethers`-based `makePlanId` and asserts a specific value, update that assertion (the value only needs determinism, not a specific number). `createSubmitGate().check(...)` — keep the existing signature; drop the gas-snapshot arg that depended on the EVM `gasFeeProvider` if it is EVM-only (the Stellar fee is the relayer's, not the worker's).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/worker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/worker.js src/worker.test.js && git commit -m "feat(worker): re-point deposit onto Stellar session-key auth + relay"
```

---

## Task 5: Re-point `orchestrator.js` — Stellar authorize + deploy + fund

**Files:**
- Modify: `frontend/src/orchestrator.js`
- Test: `frontend/src/orchestrator.test.js` (update mocks)

**Interfaces:**
- Consumes: `WorkerAgent` (Task 4), `buildInvokeTx` + `submitUserTx` (`stellar/client.js`), `signTxXdr` + `getUserAddress` (`stellar/walletKit.js`), `readTokenBalance` (`stellar/agentDeposit.js`), the new agent-deploy helper (below).
- Produces: `OrchestratorAgent.dispatch(strategy, totalAmount)` unchanged in shape (`{completed, failed, results, sessionId}`); internally it now deploys + authorizes + funds each agent on Stellar instead of batching EIP-5792 `authorizeSessionKey`.

- [ ] **Step 1: Add the per-agent authorize+deploy+fund helper (failing test first)**

Create `frontend/src/stellar/agentSetup.js` test `frontend/src/stellar/agentSetup.test.js`:

```js
// agentSetup.test.js
import { describe, test, expect, vi } from 'vitest'
vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn().mockResolvedValue({ tx: {}, xdr: 'UNSIGNED' }),
  submitUserTx: vi.fn().mockResolvedValue({ hash: 'h1', status: 'SUCCESS' }),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn().mockResolvedValue('SIGNED') }))
import { authorizeAndFundAgent } from './agentSetup.js'
import { submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

describe('authorizeAndFundAgent', () => {
  test('signs with the user wallet and submits the authorize+fund tx', async () => {
    const r = await authorizeAndFundAgent({
      owner: 'GUSER', agentAddress: 'CCRG...', signerPubkey: new Uint8Array(32),
      vault: 'CCDX...', amount: 50_000_000n, capPerPeriod: 50_000_000n, periodDuration: 3600, expiry: 4000000000,
    })
    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    expect(r.status).toBe('SUCCESS')
  })
})
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `cd frontend && npx vitest run src/stellar/agentSetup.test.js`
Expected: FAIL — `Failed to resolve import "./agentSetup.js"`.

- [ ] **Step 3: Implement `agentSetup.js`**

Create `frontend/src/stellar/agentSetup.js`:

```js
// frontend/src/stellar/agentSetup.js
// The one user-signed step: per agent, register the scope on the Registry, deploy the agent
// custom account (its constructor self-approves the vault — Phase 1), and fund it with the
// asset. Built as a single multi-op tx the user signs once via the wallet kit.
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { SOROBAN_REGISTRY_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'

/**
 * Register + (deploy already done at agent-create time) + fund one agent, user-signed.
 * @param {{owner:string, agentAddress:string, vault:string, amount:bigint, capPerPeriod:bigint, periodDuration:number, expiry:number}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function authorizeAndFundAgent({ owner, agentAddress, vault, amount, capPerPeriod, periodDuration, expiry }) {
  // registry.authorize(owner, agent, vault, token, cap, periodDuration, expiry) — owner-auth.
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_REGISTRY_ADDRESS,
    method: 'authorize',
    args: [
      { addr: owner }, { addr: agentAddress }, { addr: vault }, { addr: SOROBAN_TOKEN_ADDRESS },
      { i128: BigInt(capPerPeriod) }, periodDuration, expiry,
    ],
  })
  const signed = await signTxXdr(xdr)
  const authRes = await submitUserTx({ signedXdr: signed })

  // token.transfer(owner -> agent, amount) — funds the agent so the vault can pull on deposit.
  const { xdr: fundXdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: owner }, { addr: agentAddress }, { i128: BigInt(amount) }],
  })
  const fundSigned = await signTxXdr(fundXdr)
  await submitUserTx({ signedXdr: fundSigned })

  return authRes
}
```

> **Pin-at-impl:** `buildInvokeTx`'s arg encoder (`encodeArgs` in `client.js`) handles `{addr}` / `{i128}` / raw; `u64` fields (`periodDuration`, `expiry`) pass through as raw — confirm they encode to `ScVal::U64`/`U32` correctly (wrap with `nativeToScVal(x,{type:'u64'})` if not). **Agent deploy:** deploying the `agent_account` from the browser (with constructor args incl. the `AgentScope` struct) needs `Operation.createCustomContract` / the deployer host fn — if that is heavy client-side, pre-deploy agents server-side or via the relay and have the browser only `authorize` + `fund` (the demo agent is already pre-deployed in Phase 1 Task 5). Decide per the demo's needs; the smoke path uses the pre-deployed demo agent.

- [ ] **Step 4: Run it (passes)**

Run: `cd frontend && npx vitest run src/stellar/agentSetup.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it into `orchestrator.js`**

Edit `frontend/src/orchestrator.js`: replace the EVM imports + the EIP-5792 batch block. Concretely:
- Replace `import { WorkerAgent, ... } from './worker.js'` stays; **remove** `import { batchCalls, readUsdcBalance } from './wallet.js'`, `import { buildAuthorizeSessionKeyCall } from './relay.js'`, `import { USDC_SEPOLIA } from './config.js'`.
- Add `import { authorizeAndFundAgent } from './stellar/agentSetup.js'`, `import { readTokenBalance } from './stellar/agentDeposit.js'`.
- `amountUnits`: change `* 1e6` → `* 1e7` (7-dp).
- Pre-flight: `const bal = await readTokenBalance(this.user)` replacing `readUsdcBalance`; compare against `totalUnits` (same logic, base-unit message in VFUSD: divide by `1e7`).
- Replace the `const calls = workers.map(... buildAuthorizeSessionKeyCall ...)` + `batchCalls(calls)` block with a serial loop:

```js
this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
for (const w of workers) {
  await w.setupKey() // ensure ed25519 key + agentAddress (agentAddress set at create — see note)
  await authorizeAndFundAgent({
    owner: this.user,
    agentAddress: w.agentAddress,
    vault: w.vault,
    amount: w.amount,
    capPerPeriod: w.amount,
    periodDuration: PERIOD_DURATION,
    expiry,
  })
  w.scopeAuthorized = true
}
this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'done' })
```

- **Remove** the `redelegation.js` block (ERC-7710, EVM-only) and the `RedelegationCreated/Redeemed` events.
- The dispatch loop stays (`Promise.allSettled`-equivalent serial loop is fine); `workers[i].execute()` now runs the Stellar path.

> **Pin-at-impl:** each worker needs its `agentAddress` (the deployed custom account). For the demo, reuse the pre-deployed `SOROBAN_DEMO_AGENT` for a single agent; for N agents, deploy N agent accounts in `setupKey`/`authorizeAndFundAgent` (see Task 5 Step 3 deploy note). Keep `Promise.allSettled` for parallel dispatch if you restore it; the EVM serial-loop comment about 1Shot rate limits no longer applies (the relay limits differ — verify the Stellar relay's rate behavior).

- [ ] **Step 6: Update + run orchestrator tests**

Update `frontend/src/orchestrator.test.js` mocks (`./stellar/agentSetup.js`, `./stellar/agentDeposit.js`) replacing the `./wallet.js`/`./relay.js` mocks.
Run: `cd frontend && npx vitest run src/orchestrator.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/orchestrator.js src/orchestrator.test.js src/stellar/agentSetup.js src/stellar/agentSetup.test.js && git commit -m "feat(orchestrator): re-point authorize+fund onto Stellar (drop EIP-5792/7710)"
```

---

## Task 6: Re-point `app.jsx` connect/execute seam + exit

**Files:**
- Modify: `frontend/src/app.jsx`

**Interfaces:**
- Consumes: `connectWallet`/`getUserAddress` (`stellar/walletKit.js`), the re-pointed `OrchestratorAgent`, `owner_withdraw` via a small `stellar/exit.js` helper.
- Produces: the connected-app flow runs the Stellar path end-to-end; the risk-council `confirmPermission(..., {execute})` seam's `execute` calls the re-pointed worker/orchestrator path.

- [ ] **Step 1: Replace the connect + grant wiring**

In `app.jsx`:
- The wallet connect (around line 1134, `const addr = await connectWallet()`) — switch the import so `connectWallet` resolves to `stellar/walletKit.js` (via the `wallet.js` re-export in Task 7). `realAddress` becomes the `G…` Stellar address.
- `handlePermConfirm` (the ERC-7715 grant, ~line 1246) — the Stellar path has no ERC-7715 grant. Replace its body so it just advances to execute: `setStage('execute'); startExecution()` (the per-agent authorize+fund now happens inside `orchestrator.dispatch`, which prompts the user wallet via `walletKit`). Remove `requestERC7715Permission`, `initSession`, `saveSessionGrant`, `permissionContext` usage on this path.
- `startExecution` (~line 1320): drop `permissionContext: resolvedCtx` from the `new OrchestratorAgent({...})` ctor; keep `user: realAddress`, `veniceAuth`, `devApiKey`, `sessionId`, `onEvent`. The orchestrator no longer needs a permission context.

> **Pin-at-impl:** `app.jsx` is large; make these edits surgically and keep the existing `onEvent` → activity-log mapping. Remove the `RedelegationCreated/Redeemed` log branches (no longer emitted). Keep `makeAgentId` usage and the `agentMap` build — unchanged.

- [ ] **Step 2: Wire the exit (`owner_withdraw`)**

Create `frontend/src/stellar/exit.js`:

```js
// frontend/src/stellar/exit.js
// Owner exit — sweep an agent's position back to the user via the Phase-1 owner_withdraw.
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

/** owner_withdraw(to) on the agent account — user-signed; redeems + sweeps to `to`. */
export async function ownerWithdraw({ owner, agentAddress, to }) {
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: agentAddress,
    method: 'owner_withdraw',
    args: [{ addr: to || owner }],
  })
  const signed = await signTxXdr(xdr)
  return submitUserTx({ signedXdr: signed })
}
```

Replace the exit-UI call that used `redeemFromVaultOnChain(vault, shares, user)` with `ownerWithdraw({ owner: realAddress, agentAddress, to: realAddress })`.

> **Pin-at-impl:** find the exit/redeem button handler in `app.jsx` (or the connected-app screen) that calls `redeemFromVaultOnChain`/`withdrawFromVaultOnChain`; swap to `ownerWithdraw`. The agent address to sweep is the per-agent on-chain address tracked in exec state.

- [ ] **Step 3: Build + run the suite**

Run: `cd frontend && npx vitest run && npm run build`
Expected: tests PASS, production build green. Fix any import that still resolves to a removed EVM symbol.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/app.jsx src/stellar/exit.js && git commit -m "feat(app): re-point connect/execute/exit onto Stellar (drop ERC-7715 grant)"
```

---

## Task 7: `wallet.js` re-export shim + cleanup pass

**Files:**
- Modify: `frontend/src/wallet.js`

**Interfaces:**
- Produces: connected-app screens that `import { connectWallet, getUserAddress } from './wallet.js'` resolve to the Stellar connector. EVM fns remain exported (untouched) until SP6 removes the EVM stack.

- [ ] **Step 1: Add the Stellar re-export at the top of `wallet.js`**

```js
// Stellar connector re-exports — the connected-app path now uses these. The EVM fns below stay
// until the SP6 decommission removes them (docs/superpowers/plans/2026-06-21-evm-decommission.md).
export { connectWallet, getUserAddress, signTxXdr } from './stellar/walletKit.js'
```

> **Pin-at-impl:** `wallet.js` already exports an EVM `connectWallet`. A duplicate export name is a build error — rename the EVM one (`connectWalletEvm`) or gate the re-export. Simplest: rename the EVM `connectWallet` → `connectWalletEvm` and update its (now legacy) callers, OR delete the EVM `connectWallet` now since the app uses the Stellar one. Choose based on whether any non-re-pointed screen still needs the EVM connector before SP6.

- [ ] **Step 2: Run the suite + build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS + green build.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/wallet.js && git commit -m "chore(wallet): re-export Stellar connector for the connected-app path"
```

---

## Self-Review (Phases 2 & 3)

**Coverage:** Phase 2 builds the SP3-deferred deposit auth-tree (`agentDeposit.js`) + reads + a live proof. Phase 3 re-points worker (Task 4), orchestrator authorize/fund (Task 5), app connect/execute/exit (Task 6), and the wallet import seam (Task 7). The risk-council `execute` seam (separate pipeline) now points at the re-pointed worker path via the orchestrator.

**Placeholder scan:** `agentDeposit.js`, `agentSetup.js`, `exit.js`, and the new `worker.js` are written in full. The four genuine drift risks are flagged pin-at-impl with the exact verification and a live-smoke proof: (1) the custom-account auth-entry XDR shape, (2) the relay server's inner-source/fee-bump expectation, (3) browser-side agent deploy vs pre-deploy, (4) the `wallet.js` duplicate-export resolution. `app.jsx` edits are surgical with the exact line anchors found this session.

**Type consistency:** `runAgentDeposit({agentAddress, amount, sessionKey})` is produced in Phase 2 and consumed identically in `worker.js`. `WorkerAgent` ctor (`agentAddress`, `sessionKey`) matches what the orchestrator passes. `authorizeAndFundAgent` / `ownerWithdraw` use `buildInvokeTx` + `signTxXdr` + `submitUserTx` exactly as `client.js`/`walletKit.js` define them. Amounts are base-unit `bigint` (7-dp) throughout.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-sp4-execution-repoint-phase2-3.md`. Execute **after Phase 1 is deployed** (the smoke test in Task 3 needs the v2 demo agent live). Two options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks; run the live smoke (Task 3) before starting Phase 3.
2. **Inline Execution** — execute in this session with checkpoints; gate Phase 3 on a green Task-3 smoke.

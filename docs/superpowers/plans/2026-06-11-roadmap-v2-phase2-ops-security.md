# Roadmap v2 — Phase 2: Ops Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the off-chain operator side as safe as the contract: per-worker key lifecycle, an off-chain circuit breaker that gates submission, and a written threat model with hard numbers.

**Architecture:** Each worker gets its own ephemeral key (never a master key), scoped via `AgentRegistry.authorizeSessionKey` and encrypted at rest. A pre-submit gate (ported from the Hermes idea) takes a fresh gas snapshot, halts on anomalies and uneconomic gas, and logs every executed/skipped decision. On-chain `Pausable` (from Phase 1) is the hard stop; the off-chain gate is the soft stop.

**Tech Stack:** JS (ESM), Vitest, libsodium (`libsodium-wrappers`), ethers v6 (`Wallet.createRandom`), the Phase 1 `AgentVaultDepositor.pause()`.

**Depends on:** Phase 1 (registry + Pausable depositor) AND Phase 1's **EIP-712 auth decision (settled)**. The deposit submit path is: worker key signs the EIP-712 `AgentDeposit` digest → 1Shot relayer broadcasts. Therefore `keyVault.openKey` must be called **exactly at the signing site** (right before `signDeposit`, Phase 5 Task 2), and the worker integration here (Task 4) wires into that path — NOT the legacy `relayDeposit` user-signed batch, which Phase 5 removes.

> **⚠️ SIGNATURE SYNC:** Phase 1 made deposits EIP-712 signed — real signature is `executeAgentDeposit(uint256 amount, uint256 minAmount, bytes32 execId, bytes sig)`. In Task 5's `PauseInvariantTest`, give `worker` a private key (`uint256 workerPk = 0xB0B; address worker = vm.addr(workerPk);`), add the `_sign` helper from Phase 1 Task 3, and call `dep.executeAgentDeposit(50e6, 50e6, keccak256("x"), _sign(workerPk, 50e6, 50e6, keccak256("x")))` (NO `vm.prank(worker)` — the signer is recovered from the sig). The pause assertion is unchanged — `whenNotPaused` reverts before signature recovery.

> **RULE for the implementing agent (applies to every task):** a module built without an explicit integration task is **NOT done**. Each `Create` task that introduces a production module MUST be paired with a `Modify` task that wires it into the real execution path, and the self-review must answer *"who calls this on the production path?"* — not just *"is the test green?"*. `keyVault`, `keyStore`, `gasSnapshot`, and `submitGate` are all wired into `worker.js` by the single dedicated integration task (Task 4) for this reason.

---

## File Structure

- Create: `frontend/src/strategy/keyVault.js` — generate key (ethers), **derive secret via KDF** (`crypto_pwhash`), seal/open, honest zeroize.
- Create: `frontend/src/strategy/keyStore.js` — explicit at-rest storage (IndexedDB in browser, in-memory in Node/test) for sealed blobs, keyed by agent address.
- Create: `frontend/src/strategy/gasSnapshot.js` — **producer** of `{ maxFeePerGas, at }` from the RPC provider; the gate consumes this. Without it the gate's `gasSnapshotAt` is `undefined` → every deposit silently `stale_gas`-skipped (accidental kill switch).
- Create: `frontend/src/strategy/submitGate.js` — pre-submit circuit breaker (gas freshness + **economic gate** + rate anomaly + **bounded** decision log).
- Modify: `frontend/src/worker.js` — Task 4: real wiring — generate+seal key at plan time (→ keyStore), `openKey` at the EIP-712 sign site, `gasSnapshot.refresh()` + `submitGate.check` before submit.
- Create: `test/PauseInvariant.t.sol` — Task 5.
- Create: `docs/technical-threat-model.md` — max-loss formula, compromised-server matrix, relayer trust, AI-output-as-untrusted.
- Modify: `docs/technical-security-privacy.md` — add "Key lifecycle" section.
- Tests: `*.test.js` alongside each new module (Vitest mock pattern from `session.test.js`).

> **Key-gen dependency decision (do not let the agent pick):** the frontend is ethers v6 until Phase 5. Generate the worker key with **`ethers.Wallet.createRandom()`** now (no early viem dep). The EIP-712 signing itself happens in Phase 5 where viem lands; `keyVault` only produces/seals/opens the raw `0x` private key, which ethers can do today.

> **Honesty constraint (carries into the threat model + security doc):** `zeroize` wipes a `Uint8Array` in place. The opened private key is a `0x`-hex **JS string**, which is immutable and **cannot be wiped**. Do NOT claim a key is "zeroized after use" once it has been turned into a hex string for signing. The honest claim is **"exposure window minimized"**: open → sign → drop the only reference immediately. Only the byte buffers (derived secret, raw key bytes) are actually zeroized.

> **`rtk` note:** test commands below use `rtk npm …` (the user's token-optimized wrapper). If the executing agent's environment has no `rtk` on PATH **[VERIFY]**, drop the `rtk` prefix — plain `npm --prefix frontend run test …` is equivalent.

---

## Task 1: Per-worker key lifecycle (keyVault + keyStore)

**Files:**
- Create: `frontend/src/strategy/keyVault.js`
- Create: `frontend/src/strategy/keyVault.test.js`
- Create: `frontend/src/strategy/keyStore.js`
- Create: `frontend/src/strategy/keyStore.test.js`

- [ ] **Step 1: Write the failing keyVault test**

```js
// frontend/src/strategy/keyVault.test.js
import { describe, it, expect } from 'vitest';
import { generateWorkerKey, deriveSecret, newSalt, sealKey, openKey, zeroize } from './keyVault.js';

describe('keyVault', () => {
  it('generates a fresh private key + address each call', async () => {
    const a = await generateWorkerKey();
    const b = await generateWorkerKey();
    expect(a.privateKey).not.toEqual(b.privateKey);
    expect(a.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('derives a stable 32-byte secret from passphrase + salt (KDF)', async () => {
    const salt = await newSalt();
    const a = await deriveSecret('correct horse battery staple', salt);
    const b = await deriveSecret('correct horse battery staple', salt);
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic for same input
  });

  it('different passphrase yields a different secret', async () => {
    const salt = await newSalt();
    const a = await deriveSecret('p1', salt);
    const b = await deriveSecret('p2', salt);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('seals then opens back to the same key', async () => {
    const { privateKey } = await generateWorkerKey();
    const salt = await newSalt();
    const secret = await deriveSecret('session-passphrase', salt); // production secret source
    const blob = await sealKey(privateKey, secret);
    expect(blob).not.toContain(privateKey.slice(2)); // not stored in clear
    const opened = await openKey(blob, secret);
    expect(opened).toEqual(privateKey);
  });

  it('zeroize wipes a Uint8Array buffer in place', () => {
    const buf = new Uint8Array([1, 2, 3]);
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- keyVault`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement keyVault.js**

```js
// frontend/src/strategy/keyVault.js
// One responsibility: per-worker key material — generate, derive an at-rest
// secret from a session passphrase (KDF), seal/open, zeroize byte buffers.
// Never a master key; never persisted in clear.
//
// HONESTY: openKey returns a 0x-hex JS string for ethers signing. Strings are
// immutable — that value CANNOT be wiped. Callers minimize the exposure window
// (open -> sign -> drop reference). zeroize() only wipes Uint8Array buffers
// (the derived secret + raw key bytes), which is all we can actually clear.
import _sodium from 'libsodium-wrappers';
import { Wallet } from 'ethers';

let sodiumReady;
async function sodium() {
  if (!sodiumReady) sodiumReady = _sodium.ready.then(() => _sodium);
  return sodiumReady;
}

export async function generateWorkerKey() {
  const w = Wallet.createRandom(); // ethers v6 — no viem dep before Phase 5
  return { privateKey: w.privateKey, address: w.address };
}

/** Fresh random salt for crypto_pwhash. Persist it alongside the sealed blob. */
export async function newSalt() {
  const s = await sodium();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

/**
 * Derive a 32-byte symmetric secret from a session passphrase + salt.
 * INTERACTIVE limits (2 ops / 64 MB) are browser-feasible; raise to MODERATE
 * on higher-security deployments (roadmap: move to a KMS entirely).
 */
export async function deriveSecret(passphrase, salt) {
  const s = await sodium();
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES, // 32
    passphrase,
    salt,
    s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    s.crypto_pwhash_ALG_DEFAULT,
  );
}

/** Seal a 0x-hex private key with a 32-byte symmetric secret. Returns base64 blob. */
export async function sealKey(privateKeyHex, secret32) {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const msg = s.from_hex(privateKeyHex.slice(2));
  const cipher = s.crypto_secretbox_easy(msg, nonce, secret32);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0); out.set(cipher, nonce.length);
  zeroize(msg); // wipe the raw key bytes; the hex-string arg is the caller's problem
  return s.to_base64(out);
}

export async function openKey(blobB64, secret32) {
  const s = await sodium();
  const all = s.from_base64(blobB64);
  const nonce = all.slice(0, s.crypto_secretbox_NONCEBYTES);
  const cipher = all.slice(s.crypto_secretbox_NONCEBYTES);
  const msg = s.crypto_secretbox_open_easy(cipher, nonce, secret32);
  const hex = '0x' + s.to_hex(msg);
  zeroize(msg); // wipe bytes; the returned hex string is immutable, see header note
  return hex;
}

/** Wipe a Uint8Array in place. No-op (by design) on anything that is not a buffer. */
export function zeroize(buf) {
  if (buf && typeof buf.fill === 'function') buf.fill(0);
}
```

- [ ] **Step 4: Run keyVault to verify it passes**

Run: `rtk npm --prefix frontend run test -- keyVault`
Expected: PASS. (If `libsodium-wrappers` is missing: `rtk npm --prefix frontend i libsodium-wrappers` then re-run.)

- [ ] **Step 5: Write the failing keyStore test**

```js
// frontend/src/strategy/keyStore.test.js
import { describe, it, expect } from 'vitest';
import { createKeyStore } from './keyStore.js';

describe('keyStore', () => {
  it('puts, gets, and deletes a sealed blob by address (in-memory default)', async () => {
    const ks = createKeyStore(); // Node/test → in-memory adapter
    await ks.put('0xAbc', 'sealed-blob');
    expect(await ks.get('0xAbc')).toBe('sealed-blob');
    await ks.del('0xAbc');
    expect(await ks.get('0xAbc')).toBeUndefined();
  });

  it('keeps a separate blob per address', async () => {
    const ks = createKeyStore();
    await ks.put('0x1', 'a');
    await ks.put('0x2', 'b');
    expect(await ks.get('0x1')).toBe('a');
    expect(await ks.get('0x2')).toBe('b');
  });
});
```

- [ ] **Step 6: Implement keyStore.js**

```js
// frontend/src/strategy/keyStore.js
// Explicit at-rest storage for sealed worker-key blobs, keyed by agent address.
// Browser: IndexedDB. Node/test: in-memory. The sealed blob and its salt live
// here; the derived secret NEVER does (it is re-derived from the session
// passphrase on demand, so an attacker reading this store cannot decrypt).
function memoryAdapter() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    del: async (k) => { m.delete(k); },
  };
}

function idbAdapter(dbName = 'vibing-farmer', storeName = 'sealed-keys') {
  const open = () => new Promise((res, rej) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(storeName, mode);
      const os = t.objectStore(storeName);
      const r = fn(os);
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (os) => os.get(k)),
    set: (k, v) => tx('readwrite', (os) => os.put(v, k)),
    del: (k) => tx('readwrite', (os) => os.delete(k)),
  };
}

export function createKeyStore(adapter) {
  const store = adapter
    ?? (typeof indexedDB !== 'undefined' ? idbAdapter() : memoryAdapter());
  return {
    put: (address, blob) => store.set(`key:${address}`, blob),
    get: (address) => store.get(`key:${address}`),
    del: (address) => store.del(`key:${address}`),
  };
}
```

- [ ] **Step 7: Run keyStore to verify it passes**

Run: `rtk npm --prefix frontend run test -- keyStore`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/strategy/keyVault.js frontend/src/strategy/keyVault.test.js frontend/src/strategy/keyStore.js frontend/src/strategy/keyStore.test.js frontend/package.json frontend/package-lock.json
git commit -m "feat(security): per-worker key lifecycle (KDF-sealed, at-rest keyStore)"
```

---

## Task 2: Gas snapshot producer (gasSnapshot)

> **Why this is its own task:** the gate (Task 3) consumes `gasSnapshotAt`. Nothing else produces it. If this module does not exist and get wired (Task 4), `gasSnapshot?.at` is `undefined` → the gate returns `stale_gas` for EVERY deposit → all deposits silently skipped. That is an accidental kill switch, not a safety feature.

**Files:**
- Create: `frontend/src/strategy/gasSnapshot.js`
- Create: `frontend/src/strategy/gasSnapshot.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/gasSnapshot.test.js
import { describe, it, expect } from 'vitest';
import { createGasSnapshotProvider } from './gasSnapshot.js';

describe('gasSnapshot', () => {
  it('starts empty, then refreshes fee data and stamps a timestamp', async () => {
    let t = 1000;
    const provider = { getFeeData: async () => ({ maxFeePerGas: 7n }) };
    const gs = createGasSnapshotProvider({ provider, now: () => t });
    expect(gs.current()).toBeNull();
    const snap = await gs.refresh();
    expect(snap.maxFeePerGas).toBe(7n);
    expect(snap.at).toBe(1000);
    expect(gs.current()).toEqual(snap);
  });

  it('re-stamps `at` on each refresh', async () => {
    let t = 0;
    const provider = { getFeeData: async () => ({ maxFeePerGas: 1n }) };
    const gs = createGasSnapshotProvider({ provider, now: () => t });
    await gs.refresh();
    t = 5000;
    const snap = await gs.refresh();
    expect(snap.at).toBe(5000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- gasSnapshot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement gasSnapshot.js**

```js
// frontend/src/strategy/gasSnapshot.js
// One responsibility: produce a fresh { maxFeePerGas, at } from the RPC provider.
// The submitGate consumes `at` for freshness and `maxFeePerGas` for the economic
// check. Refresh immediately before each submit window — never reuse a stale one.
export function createGasSnapshotProvider({ provider, now = () => Date.now() }) {
  let last = null;

  async function refresh() {
    const fee = await provider.getFeeData(); // ethers v6: { maxFeePerGas, ... }
    last = { maxFeePerGas: fee.maxFeePerGas, at: now() };
    return last;
  }

  return { refresh, current: () => last };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend run test -- gasSnapshot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/gasSnapshot.js frontend/src/strategy/gasSnapshot.test.js
git commit -m "feat(security): gas snapshot producer feeding the pre-submit gate"
```

---

## Task 3: Pre-submit circuit breaker (submitGate)

**Files:**
- Create: `frontend/src/strategy/submitGate.js`
- Create: `frontend/src/strategy/submitGate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/submitGate.test.js
import { describe, it, expect } from 'vitest';
import { createSubmitGate } from './submitGate.js';

const MAX_GAS_AGE_MS = 15_000;
const MAX_PER_MIN = 5;

describe('submitGate', () => {
  it('blocks when the gas snapshot is stale', () => {
    const gate = createSubmitGate({ now: () => 100_000, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 100_000 - 20_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_gas');
  });

  it('blocks when gas cost exceeds expected benefit (economic gate)', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 0, estGasCostWei: 100n, expectedBenefitWei: 50n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('uneconomic');
  });

  it('allows when gas cost is below expected benefit', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 0, estGasCostWei: 30n, expectedBenefitWei: 50n });
    expect(r.ok).toBe(true);
  });

  it('blocks when rate exceeds maxPerMin for an owner', () => {
    let t = 0;
    const gate = createSubmitGate({ now: () => t, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: 2 });
    const fresh = () => ({ owner: '0xA', gasSnapshotAt: t });
    expect(gate.check(fresh()).ok).toBe(true);
    expect(gate.check(fresh()).ok).toBe(true);
    const r = gate.check(fresh());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('rate_anomaly');
  });

  it('records every decision to the log', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    gate.check({ owner: '0xA', gasSnapshotAt: 0 });
    gate.check({ owner: '0xA', gasSnapshotAt: -99_999 });
    expect(gate.log()).toHaveLength(2);
    expect(gate.log()[1]).toMatchObject({ owner: '0xA', ok: false, reason: 'stale_gas' });
  });

  it('caps the decision log (ring buffer, no unbounded growth)', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN, maxDecisions: 3 });
    for (let i = 0; i < 6; i++) gate.check({ owner: '0xA', gasSnapshotAt: 0 });
    expect(gate.log()).toHaveLength(3); // oldest evicted
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- submitGate`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement submitGate.js**

```js
// frontend/src/strategy/submitGate.js
// One responsibility: decide whether a single deposit may be submitted RIGHT NOW.
// Soft circuit breaker; the hard stop is AgentVaultDepositor.pause() on-chain.
// Three guards, cheapest first:
//   1. stale_gas    — snapshot older than maxGasAgeMs (or missing)
//   2. uneconomic   — gas cost >= expected benefit (the Hermes fast-fail idea)
//   3. rate_anomaly — more than maxPerMin submits for one owner inside a minute
// The decision log is a bounded ring buffer (maxDecisions) so a long-running
// worker cannot leak memory through it.
const ONE_MIN = 60_000;

export function createSubmitGate({
  now = () => Date.now(),
  maxGasAgeMs = 15_000,
  maxPerMin = 5,
  maxDecisions = 1000,
} = {}) {
  const hits = new Map(); // owner -> number[] timestamps
  const decisions = [];

  function record(decision) {
    decisions.push(decision);
    if (decisions.length > maxDecisions) decisions.shift(); // ring buffer
    return decision;
  }

  function check({ owner, gasSnapshotAt, estGasCostWei, expectedBenefitWei }) {
    const t = now();
    let ok = true, reason = 'ok';

    if (gasSnapshotAt == null || t - gasSnapshotAt > maxGasAgeMs) {
      ok = false; reason = 'stale_gas';
    } else if (
      estGasCostWei != null && expectedBenefitWei != null &&
      estGasCostWei >= expectedBenefitWei
    ) {
      ok = false; reason = 'uneconomic';
    } else {
      const arr = (hits.get(owner) || []).filter((ts) => t - ts < ONE_MIN);
      if (arr.length >= maxPerMin) { ok = false; reason = 'rate_anomaly'; }
      else { arr.push(t); hits.set(owner, arr); }
    }

    return record({ at: t, owner, ok, reason });
  }

  return { check, log: () => decisions };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend run test -- submitGate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/submitGate.js frontend/src/strategy/submitGate.test.js
git commit -m "feat(security): pre-submit circuit breaker (gas-freshness + economic + rate)"
```

---

## Task 4: Wire keyVault + keyStore + gasSnapshot + submitGate into worker.js

> **This is the task that makes Task 1–3 real.** Without it, all four modules are dead code that passes its own tests. The self-review MUST name the production caller of each.

**Files:**
- Modify: `frontend/src/worker.js`
- Modify (or create) the worker test: `frontend/src/worker.test.js`

- [ ] **Step 0: Confirm the Blocker-1 sign site exists**

The submit path is EIP-712: worker key signs the `AgentDeposit` digest, relayer broadcasts. Locate the sign + submit sites:

Run: `rtk grep -n "signDeposit\|relayDeposit\|submitRelay\|getFeeData" frontend/src/worker.js`

If `signDeposit` is not yet present (it lands in Phase 5 Task 2), wire `openKey` to the **placeholder sign call** the worker uses today and leave a `// TODO(phase5): signDeposit` marker exactly there — do NOT wire into the legacy `relayDeposit` user-signed batch, which Phase 5 removes.

- [ ] **Step 1: Wire key generation + sealing at plan-creation time**

Where the worker is constructed / a plan is created (one key per worker), generate and seal:

```js
import { generateWorkerKey, deriveSecret, newSalt, sealKey, openKey } from './strategy/keyVault.js';
import { createKeyStore } from './strategy/keyStore.js';
import { createGasSnapshotProvider } from './strategy/gasSnapshot.js';
import { createSubmitGate } from './strategy/submitGate.js';

const keyStore = createKeyStore();
const submitGate = createSubmitGate();
// gasProvider = the ethers v6 provider the worker already holds
const gasSnapshot = createGasSnapshotProvider({ provider: gasProvider });

// --- at plan creation (once per worker) ---
const { privateKey, address } = await generateWorkerKey();
const salt = await newSalt();                       // persist next to the blob
const secret = await deriveSecret(sessionPassphrase, salt);
const sealed = await sealKey(privateKey, secret);
await keyStore.put(address, { sealed, salt });      // at rest; secret is NOT stored
// authorize this `address` on-chain via AgentRegistry.authorizeSessionKey(...)
// drop the plaintext privateKey reference here — exposure window minimized
```

- [ ] **Step 2: Wire gasSnapshot.refresh + submitGate.check immediately before submit**

```js
// --- inside the per-step execute, immediately before the EIP-712 sign+submit ---
const snap = await gasSnapshot.refresh();
const gateResult = submitGate.check({
  owner,
  gasSnapshotAt: snap.at,
  estGasCostWei: snap.maxFeePerGas * EST_DEPOSIT_GAS, // EST_DEPOSIT_GAS: named const
  expectedBenefitWei,                                  // from the strategy's per-step yield est
});
if (!gateResult.ok) {
  return { step, status: 'skipped', reason: gateResult.reason };
}
```

- [ ] **Step 3: Wire openKey at the EIP-712 sign site (and only there)**

```js
// --- at the sign site (right before signDeposit; Phase 5 Task 2) ---
const { sealed, salt } = await keyStore.get(address);
const secret = await deriveSecret(sessionPassphrase, salt);
const pk = await openKey(sealed, secret); // 0x-hex string — see honesty note
const sig = await signDeposit(pk, digest); // TODO(phase5): real signDeposit
// drop `pk` immediately; it is an immutable string and cannot be zeroized
```

- [ ] **Step 4: Worker integration test — prove the production caller exists**

Add a test that fails if the wiring is removed (mock the strategy modules; assert the sign site calls `openKey` and a stale/uneconomic snapshot skips the deposit):

```js
// frontend/src/worker.test.js (add to the existing suite)
import { describe, it, expect, vi } from 'vitest';

it('skips submit when the gate blocks (stale gas)', async () => {
  // arrange a worker whose gasSnapshot returns an old `at`, run a step,
  // assert the step result is { status: 'skipped', reason: 'stale_gas' }
  // and that signDeposit/openKey were never called.
});

it('opens the sealed key only at the sign site on the happy path', async () => {
  // arrange fresh gas + economic snapshot, run a step,
  // assert openKey was called exactly once and AFTER the gate passed.
});
```

Fill these against the real worker surface found in Step 0.

- [ ] **Step 5: Run the worker suite**

Run: `rtk npm --prefix frontend run test -- worker`
Expected: PASS. Then run the whole frontend suite to catch regressions: `rtk npm --prefix frontend run test`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/worker.js frontend/src/worker.test.js
git commit -m "feat(security): wire key lifecycle, gas snapshot, and submit gate into worker"
```

---

## Task 5: Pause invariant — paused never traps user funds

**Files:**
- Create: `test/PauseInvariant.t.sol`

- [ ] **Step 1: Write the test (paused blocks, unpause restores, no idle reserve)**

```solidity
// test/PauseInvariant.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PauseInvariantTest is Test {
    AgentRegistry reg; AgentVaultDepositor dep; MockERC20 token; MockVault vault;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xB0B;
    address worker;

    function setUp() public {
        worker = vm.addr(workerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);
        token.mint(owner, 1_000e6);
        vm.prank(owner); token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    // EIP-712 sign helper (mirrors Phase 1 Task 3).
    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId)
        internal view returns (bytes memory)
    {
        bytes32 digest = dep.hashAgentDeposit(amount, minAmount, execId); // Phase 1 helper
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_pausedBlocks_thenUnpauseWorks_noIdleFunds() public {
        bytes32 execId = keccak256("x");
        dep.pause();
        vm.expectRevert(); // whenNotPaused reverts before signature recovery
        dep.executeAgentDeposit(50e6, 50e6, execId, _sign(workerPk, 50e6, 50e6, execId));
        // no funds moved while paused
        assertEq(token.balanceOf(address(dep)), 0);
        assertEq(dep.reserves(address(token)), 0);

        dep.unpause();
        // execId reuse after a reverted attempt is intentional: the revert rolled
        // back executed[execId]=true, proving a failed attempt does not burn the id.
        dep.executeAgentDeposit(50e6, 50e6, execId, _sign(workerPk, 50e6, 50e6, execId));
        assertEq(token.balanceOf(address(dep)), 0); // atomic: nothing idle after
        assertEq(dep.reserves(address(token)), 0);
        assertGt(vault.balanceOf(owner), 0);
    }
}
```

- [ ] **Step 2: Run**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge test --match-contract PauseInvariantTest -vvv"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/PauseInvariant.t.sol
git commit -m "test(security): pause never traps user funds (atomic-flow invariant)"
```

---

## Task 6: Threat model document + key-lifecycle section

**Files:**
- Create: `docs/technical-threat-model.md`
- Modify: `docs/technical-security-privacy.md`

- [ ] **Step 1: Write the threat model**

Create `docs/technical-threat-model.md`:

````markdown
# Threat Model — Vibing Farmer (Base Sepolia)

## 1. Max-loss formula
Per agent, worst case loss = `capPerPeriod × ceil((expiry − now) / periodDuration)`.
Example: cap 100 USDC, period 1 day, expiry +7 days → max 700 USDC at risk for that one agent, never the whole wallet. Fixed-window allows up to `2×cap` across a single boundary (documented, matches MetaMask enforcer behavior).

## 2. Compromised server — can vs cannot (post-Phase 1)
| Attacker with the server / a worker key CAN | CANNOT |
|---|---|
| Trigger a deposit of the scoped token, into the scoped vault, credited to the scope owner, ≤ remaining cap | Redirect funds to any other address (vault+owner derived from on-chain scope) |
| Replay nothing (execId idempotency) | Exceed `capPerPeriod` |
| — | Deposit after `expiry` or after `revokeAgent` |
| — | Touch a token/vault it was not scoped to |
| — | Custody user funds (balance is asserted 0 throughout) |

## 3. Relayer trust (1Shot)
1Shot can censor/delay during a crash. Mitigation: a **worker-signed EIP-712 fallback** — the same worker key that signs the relayer path re-broadcasts the identical `AgentDeposit` signature via the project's own RPC. This is NOT a separate user signature; the user is not in the loop at submit time (that is the whole point of the scoped session key). The fallback therefore inherits the exact same on-chain caps and cannot exceed scope. **[VERIFY own-RPC broadcast path on Base Sepolia.]**

## 4. AI output is untrusted input
Venice AI strategy/skill JSON is schema-validated client-side and bounded by on-chain caps. A malicious/hallucinated plan cannot exceed the registry scope.

## 5. Key-material exposure (honest)
The sealed key is at rest under a KDF-derived secret (`keyStore`); the secret is re-derived from the session passphrase and never stored. At sign time the key becomes a `0x`-hex JS string — immutable, therefore **not zeroizable**. We minimize the exposure window (open → sign → drop reference); we do NOT claim the in-memory key is wiped. Byte buffers (derived secret, raw key bytes) ARE zeroized. Roadmap: move sealing/signing into a KMS so the plaintext key never enters JS.

## 6. Destructive-test results
Filled in from Phase 4, Task 4 (live "stolen key" / mid-plan revoke / relayer-down drills).
````

- [ ] **Step 2: Add the Key Lifecycle section to the security doc**

Append to `docs/technical-security-privacy.md`:

````markdown
## Key lifecycle (worker / session keys)
1. One private key per worker, generated at plan time (`keyVault.generateWorkerKey`, ethers v6), never a master key.
2. Scoped on-chain via `AgentRegistry.authorizeSessionKey`; the key can do nothing outside its scope.
3. Stored encrypted at rest in `keyStore` (IndexedDB in browser) as a libsodium sealed box under a **KDF-derived** secret (`deriveSecret` → `crypto_pwhash`). The derived secret is re-computed from the session passphrase on demand and is **never persisted next to the blob** — an attacker reading storage cannot decrypt.
4. Decrypted to memory only at the EIP-712 sign site. The opened key is an immutable hex string and **cannot be zeroized** — we minimize the exposure window instead (open → sign → drop reference). Byte buffers are zeroized.
5. Rotation = `authorizeSessionKey(newKey, scope)` + `revokeAgent(oldKey)`. The old key is dead permanently by design (one agent = one scope, forever).
6. Production roadmap: move the sealing secret — ideally the whole sign operation — to a KMS so the plaintext key never enters JS.
````

- [ ] **Step 3: Verify the docs render the key facts**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && grep -c 'capPerPeriod' docs/technical-threat-model.md && grep -c 'Key lifecycle' docs/technical-security-privacy.md"`
Expected: both ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add docs/technical-threat-model.md docs/technical-security-privacy.md
git commit -m "docs(security): threat model with max-loss numbers + honest key lifecycle"
```

---

## Self-Review checklist

- [ ] **Every Create-module task has a paired wiring task with a NAMED production caller.** keyVault/keyStore/gasSnapshot/submitGate → all called from `worker.js` in Task 4; the answer to "who calls this on the production path?" is written down, not assumed. A green unit test is NOT sufficient evidence a module is integrated.
- [ ] Roadmap 2.1 (idempotency) is already in Phase 1 Task 3; agent-side execId persistence is part of the worker change in Task 4.
- [ ] 2.2 → Task 1 (keyVault+keyStore); 2.3 → Tasks 2+3+5 (gas producer, gate, pause invariant); 2.4 → Task 6.
- [ ] Economic gate is present (Task 3 `uneconomic` reason), not silently dropped; decision log is a bounded ring buffer.
- [ ] gasSnapshot has a real producer (Task 2) AND a wiring site (Task 4 Step 2) — the gate never receives `undefined`.
- [ ] Honesty: no "zeroized after" claim for the hex-string key anywhere (code comments, threat model §5, security doc point 4).
- [ ] No placeholders; every code step has full code.
- [ ] Type consistency: `createSubmitGate({now,maxGasAgeMs,maxPerMin,maxDecisions})`, `check({owner,gasSnapshotAt,estGasCostWei,expectedBenefitWei})→{ok,reason}`, `createGasSnapshotProvider({provider,now})→{refresh,current}`, `keyVault` (`generateWorkerKey/deriveSecret/newSalt/sealKey/openKey/zeroize`), `createKeyStore(adapter)→{put,get,del}` identical across tests and impl.

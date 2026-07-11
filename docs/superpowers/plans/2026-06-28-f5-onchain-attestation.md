# F5 On-Chain Strategy Attestation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the AI strategy hash on Stellar testnet via a minimal Soroban `attestation` contract, so "this AI produced exactly this strategy at this ledger time" is publicly, immutably verifiable — user-signed for genuine provenance, relayer-fee-bumped so the user pays 0 XLM.

**Architecture:** A leaf Soroban contract `attest(attester, strategy_hash, label)` bumps a per-attester counter and emits `StrategyAttested`. The frontend builds the invoke, the user's wallet signs the *inner* tx (so `require_auth(attester)` is satisfied by source-account auth), and the existing fee-bump relay pays the fee. `hashStrategy` stays the pure off-chain source of truth; on-chain attestation is purely additive and never blocks strategy execution.

**Tech Stack:** Rust + soroban-sdk 26.1.0 (WSL-only tooling), React 18 / Vite ESM frontend, `@stellar/stellar-sdk`, vitest, Stellar fee-bump relay (`/api/stellar-relay`).

**Spec:** `docs/superpowers/specs/2026-06-21-onchain-strategy-attestation-design.md` (status APPROVED 2026-06-28).

## Global Constraints

- **soroban-sdk = `26.1.0`** via `{ workspace = true }`; crate `edition = "2021"`; `crate-type = ["cdylib", "lib"]`.
- **Soroban tooling runs in WSL ONLY.** Wrap every `cargo`/`stellar` call: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && <cmd>"`. Never run cargo/stellar directly in PowerShell.
- **WASM target `wasm32v1-none`**; built wasm must be **< 64 KB**; `cargo clippy --all-targets -- -D warnings` must be clean.
- **Workspace members = `["contracts/*"]` (glob)** — a new `soroban/contracts/attestation/` crate is auto-included. Do NOT edit `soroban/Cargo.toml`.
- **`DataKey` must NOT contain an `Admin` variant** (collides with OZ `AccessControlStorageKey::Admin`, #2006). This contract has no admin.
- **`symbol_short!` max 9 chars.** The `label` Symbol is a provider name (`venice`/`deepseek`/`fallback`/`strategy`) — always ≤ 9 chars; slice to 9 in the frontend before encoding.
- **`env.events().all().events()` returns only the LAST invocation's events** — assert event counts immediately after the emitting call.
- **Persistent storage:** always call `.extend_ttl(&key, 17_280, 518_400)` after any `.set`.
- **Attestation stays non-blocking:** every on-chain path is wrapped so a failure (relay null, RPC down, no wallet) silently falls back to the off-chain hash. A failed attest must NEVER abort strategy execution.
- **Frontend:** ESM modules, no `console.log` in shipped code (use `console.warn` for non-blocking skips only), networked functions accept an injected `server` param for offline tests.
- **Commits:** conventional type prefix (`feat`/`test`/`fix`/`chore`), no step numbers in messages. Attribution is disabled globally.
- **Do NOT commit the spec or this plan** — `docs/superpowers/` is local-only per CLAUDE.md.
- **Do NOT run the full `deploy-seed.sh`** — it redeploys the live Blend vault and would orphan it. Deploy the attestation contract with a direct one-off command (Task 2).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `soroban/contracts/attestation/Cargo.toml` | Crate manifest | Create |
| `soroban/contracts/attestation/src/lib.rs` | Contract: `attest` + `count_of`, `DataKey`, `StrategyAttested` event | Create |
| `soroban/contracts/attestation/src/test.rs` | Contract unit tests | Create |
| `frontend/src/stellar/scval.js` | Add `bytes32ScVal` + `symbolScVal` encoders | Modify |
| `frontend/src/stellar/client.js` | Dispatch `{bytes32}`/`{symbol}` arg tags in `encodeArgs` | Modify |
| `frontend/src/stellar/scval.test.js` | Encoder tests | Create (or extend if present) |
| `frontend/src/stellar/attestation.js` | `attestOnChain` + `readAttestationCount` (on-chain layer) | Create |
| `frontend/src/stellar/attestation.test.js` | Offline tests for the on-chain layer | Create |
| `frontend/src/stellar/config.js` | Export `SOROBAN_ATTESTATION_ADDRESS` | Modify |
| `frontend/scripts/stellar-attest-smoke.mjs` | Live testnet proof (in-process fee-bump) | Create |
| `frontend/src/attestation.js` | Wire `attestStrategyOnChain` to the on-chain layer; `formatAttestation` explorer link | Modify |
| `frontend/src/app.jsx` | Pass `attester: realAddress` into the attestation effect | Modify |
| `frontend/src/agents.jsx` | Strategy-card chip: "attested on-chain" + explorer link | Modify |
| `frontend/src/components/ExplorerPage.jsx` | (Optional, Task 7) surface on-chain `strategy_attested` events | Modify |
| `frontend/src/stellar/events.js` | (Optional, Task 7) add attestation contract to watched list | Modify |
| `deployments/stellar-testnet.json` | Record `attestation` address | Modify |
| `soroban/deploy-seed.sh` | Record attestation deploy for reproducibility | Modify |

---

## Task 1: Soroban `attestation` contract (TDD)

**Files:**
- Create: `soroban/contracts/attestation/Cargo.toml`
- Create: `soroban/contracts/attestation/src/lib.rs`
- Create: `soroban/contracts/attestation/src/test.rs`

**Interfaces:**
- Produces (Rust, auto-generated client `AttestationClient`):
  - `attest(env: Env, attester: Address, strategy_hash: BytesN<32>, label: Symbol) -> u32` — `attester.require_auth()`, bump per-attester `u32` counter (persistent), emit `StrategyAttested`, return new count.
  - `count_of(env: Env, attester: Address) -> u32` — view, `0` if none.
  - Event `StrategyAttested { attester: Address, strategy_hash: BytesN<32>, ledger: u32, label: Symbol }`, topic `"strategy_attested"`.

- [ ] **Step 1: Create the crate manifest**

Create `soroban/contracts/attestation/Cargo.toml`:

```toml
[package]
name = "attestation"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

- [ ] **Step 2: Write the failing tests**

Create `soroban/contracts/attestation/src/test.rs`:

```rust
#![cfg(test)]
use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    Address, BytesN, Env,
};

fn setup(env: &Env) -> (AttestationClient<'static>, Address) {
    let id = env.register(Attestation, ());
    let client = AttestationClient::new(env, &id);
    let attester = Address::generate(env);
    (client, attester)
}

#[test]
fn attest_increments_count_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, attester) = setup(&env);
    let h = BytesN::from_array(&env, &[7u8; 32]);

    let n1 = client.attest(&attester, &h, &symbol_short!("venice"));
    assert_eq!(n1, 1);
    // events().all() returns only the last invocation's events
    assert_eq!(env.events().all().len(), 1);

    let n2 = client.attest(&attester, &h, &symbol_short!("venice"));
    assert_eq!(n2, 2);
    assert_eq!(client.count_of(&attester), 2);
}

#[test]
fn count_of_is_zero_for_unknown_attester() {
    let env = Env::default();
    let (client, attester) = setup(&env);
    assert_eq!(client.count_of(&attester), 0);
}

#[test]
fn attest_rejects_without_auth() {
    let env = Env::default();
    // no mock_all_auths → require_auth has nothing to satisfy
    let (client, attester) = setup(&env);
    let h = BytesN::from_array(&env, &[1u8; 32]);
    let res = client.try_attest(&attester, &h, &symbol_short!("strat"));
    assert!(res.is_err());
}
```

- [ ] **Step 3: Run the tests to verify they fail (no contract yet)**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p attestation"
```
Expected: FAIL — `cannot find value/type Attestation`, `AttestationClient` undefined.

- [ ] **Step 4: Implement the contract**

Create `soroban/contracts/attestation/src/lib.rs`:

```rust
#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, Symbol,
};

mod test;

const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Counter(Address),
}

#[contractevent(topics = ["strategy_attested"])]
pub struct StrategyAttested {
    pub attester: Address,
    pub strategy_hash: BytesN<32>,
    pub ledger: u32,
    pub label: Symbol,
}

#[contract]
pub struct Attestation;

#[contractimpl]
impl Attestation {
    /// Record a strategy hash on-chain for `attester`. Bumps the attester's
    /// counter, emits StrategyAttested, returns the new count. Leaf call —
    /// no cross-contract invocation, no admin.
    pub fn attest(
        env: Env,
        attester: Address,
        strategy_hash: BytesN<32>,
        label: Symbol,
    ) -> u32 {
        attester.require_auth();

        let key = DataKey::Counter(attester.clone());
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0) + 1;
        env.storage().persistent().set(&key, &count);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        StrategyAttested {
            attester,
            strategy_hash,
            ledger: env.ledger().sequence(),
            label,
        }
        .publish(&env);

        count
    }

    /// How many attestations `attester` has recorded. 0 if none.
    pub fn count_of(env: Env, attester: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Counter(attester))
            .unwrap_or(0)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p attestation"
```
Expected: PASS — 3 tests (`attest_increments_count_and_emits_event`, `count_of_is_zero_for_unknown_attester`, `attest_rejects_without_auth`).

- [ ] **Step 6: Clippy + build wasm; check size < 64 KB**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy -p attestation --all-targets -- -D warnings && stellar contract build && ls -l target/wasm32v1-none/release/attestation.wasm"
```
Expected: clippy clean; `attestation.wasm` exists; size well under 65536 bytes.

- [ ] **Step 7: Commit**

```bash
git add soroban/contracts/attestation
git commit -m "feat: add minimal Soroban attestation contract (attest + count_of)"
```

---

## Task 2: Deploy `attestation` to testnet + record address

> Deploy ONLY the attestation contract with a one-off command. Do NOT run the full `deploy-seed.sh` (it would redeploy the live Blend vault). The attestation contract has **no constructor args**.

**Files:**
- Modify: `frontend/src/stellar/config.js` (add export)
- Modify: `deployments/stellar-testnet.json` (record address)
- Modify: `soroban/deploy-seed.sh` (record for reproducibility)

**Interfaces:**
- Produces: `SOROBAN_ATTESTATION_ADDRESS` (a `C...` strkey) exported from `config.js`; `attestation` key in `deployments/stellar-testnet.json`.

- [ ] **Step 1: Build + deploy the attestation contract (WSL)**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && stellar contract deploy --wasm target/wasm32v1-none/release/attestation.wasm --source vf-deployer --network testnet"
```
Expected: prints a `C...` contract address on the last line. Copy it. (If the wasm path differs, fall back to `target/wasm32-unknown-unknown/release/attestation.wasm`, mirroring `deploy-seed.sh`.)

- [ ] **Step 2: Record the address in `deployments/stellar-testnet.json`**

Add a root-level `"attestation"` key (peer to `registry`, `relayer`, `vault`). Example shape (use the real address from Step 1):

```json
  "demoAgentSigner": "dd4139236bc836df336b1d6a360ad90d234613950cff078ebc03d28876c1698b",
  "attestation": "C_REPLACE_WITH_DEPLOYED_ADDRESS",
  "vault": {
```

- [ ] **Step 3: Export the address from `config.js`**

In `frontend/src/stellar/config.js`, add after `SOROBAN_REGISTRY_ADDRESS` (match the existing hardcoded-`export const` pattern):

```js
export const SOROBAN_ATTESTATION_ADDRESS = 'C_REPLACE_WITH_DEPLOYED_ADDRESS'
```

- [ ] **Step 4: Patch `deploy-seed.sh` for reproducibility (idempotent)**

In `soroban/deploy-seed.sh`, after the existing contract deploys and before the Python `json.dump` block (the `out` dict, ~lines 84-93), add a deploy that reuses an existing address if present, else deploys:

```bash
# Attestation contract (additive; reuse if already recorded so a reseed never re-deploys it)
ATTESTATION=$(python3 -c "import json;print(json.load(open('$OUT')).get('attestation',''))" 2>/dev/null || true)
if [ -z "$ATTESTATION" ]; then
  ATTESTATION=$(stellar contract deploy --wasm "$WASM_DIR/attestation.wasm" \
    --source vf-deployer --network "$NET")
fi
```

Then add `"attestation": ATTESTATION` to the `out` dict that gets `json.dump`ed (alongside `registry`, `relayer`, etc.).

- [ ] **Step 5: Verify the address reads back**

Run (read-only, proves the contract is live and `count_of` works):
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract invoke --id C_REPLACE_WITH_DEPLOYED_ADDRESS --source vf-deployer --network testnet -- count_of --attester GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS"
```
Expected: prints `0` (no attestations yet for that address).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/stellar/config.js deployments/stellar-testnet.json soroban/deploy-seed.sh
git commit -m "chore: deploy attestation contract to testnet + record address"
```

---

## Task 3: Add `bytes32` + `symbol` ScVal encoders (TDD)

**Files:**
- Modify: `frontend/src/stellar/scval.js`
- Modify: `frontend/src/stellar/client.js:27-34` (`encodeArgs`)
- Create/Modify: `frontend/src/stellar/scval.test.js`

**Interfaces:**
- Consumes: `nativeToScVal` from `@stellar/stellar-sdk` (already imported in `scval.js`).
- Produces:
  - `bytes32ScVal(v: string | Buffer | Uint8Array): xdr.ScVal` — accepts a `0x`-prefixed hex string (or raw 32-byte bytes); returns `ScVal::Bytes` of length 32.
  - `symbolScVal(s: string): xdr.ScVal` — returns `ScVal::Symbol`.
  - `encodeArgs` now dispatches `{ bytes32 }` and `{ symbol }` tags (in addition to existing `{ addr }`, `{ i128 }`, `{ u64 }`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/scval.test.js` (if it exists, append these tests):

```js
import { describe, it, expect } from 'vitest'
import { bytes32ScVal, symbolScVal } from './scval.js'
import { encodeArgs } from './client.js'

describe('bytes32ScVal', () => {
  it('encodes a 0x-prefixed hex string to 32-byte ScVal bytes', () => {
    const hex = '0x' + 'ab'.repeat(32)
    const sv = bytes32ScVal(hex)
    expect(sv.switch().name).toBe('scvBytes')
    expect(sv.bytes().length).toBe(32)
  })
})

describe('symbolScVal', () => {
  it('encodes a string to an ScVal symbol', () => {
    const sv = symbolScVal('venice')
    expect(sv.switch().name).toBe('scvSymbol')
  })
})

describe('encodeArgs dispatch', () => {
  it('maps {bytes32} and {symbol} tags to the right ScVals', () => {
    const [b, s] = encodeArgs([{ bytes32: '0x' + '01'.repeat(32) }, { symbol: 'strategy' }])
    expect(b.switch().name).toBe('scvBytes')
    expect(b.bytes().length).toBe(32)
    expect(s.switch().name).toBe('scvSymbol')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/stellar/scval.test.js`
Expected: FAIL — `bytes32ScVal`/`symbolScVal` not exported; `encodeArgs` does not handle the tags.

- [ ] **Step 3: Add the encoders to `scval.js`**

In `frontend/src/stellar/scval.js`, after `u64ScVal` (mirror its `nativeToScVal` style):

```js
export function bytes32ScVal(v) {
  const buf =
    typeof v === 'string' ? Buffer.from(v.replace(/^0x/, ''), 'hex') : Buffer.from(v)
  if (buf.length !== 32) throw new Error(`bytes32 must be 32 bytes, got ${buf.length}`)
  return nativeToScVal(buf, { type: 'bytes' })
}

export function symbolScVal(s) {
  return nativeToScVal(String(s), { type: 'symbol' })
}
```

- [ ] **Step 4: Dispatch the tags in `encodeArgs` (`client.js:27-34`)**

Update the import at the top of `client.js` to include the new encoders, then add two branches in `encodeArgs`:

```js
// add bytes32ScVal, symbolScVal to the existing scval.js import
export function encodeArgs(args = []) {
  return args.map((a) => {
    if (a && typeof a === 'object' && 'addr' in a) return addrScVal(a.addr)
    if (a && typeof a === 'object' && 'i128' in a) return i128ScVal(a.i128)
    if (a && typeof a === 'object' && 'u64' in a) return u64ScVal(a.u64)
    if (a && typeof a === 'object' && 'bytes32' in a) return bytes32ScVal(a.bytes32)
    if (a && typeof a === 'object' && 'symbol' in a) return symbolScVal(a.symbol)
    return a // already an ScVal
  })
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run src/stellar/scval.test.js`
Expected: PASS — all 3 new tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/stellar/scval.js frontend/src/stellar/client.js frontend/src/stellar/scval.test.js
git commit -m "feat: add bytes32 and symbol ScVal encoders"
```

---

## Task 4: Frontend on-chain layer `stellar/attestation.js` (TDD)

**Files:**
- Create: `frontend/src/stellar/attestation.js`
- Create: `frontend/src/stellar/attestation.test.js`

**Interfaces:**
- Consumes: `buildInvokeTx`, `readContract` (`client.js`); `submitViaRelay` (`relay.js`); `signTxXdr` (`walletKit.js`); `SOROBAN_ATTESTATION_ADDRESS` (`config.js`).
  - `buildInvokeTx({ source, contract, method, args, server }) -> { tx, xdr }`
  - `signTxXdr(xdr) -> Promise<string>` (signed XDR)
  - `submitViaRelay({ xdr }) -> Promise<{ hash, status, relayer } | null>`
  - `readContract({ contract, method, args, server }) -> Promise<native>`
- Produces:
  - `attestOnChain({ attester, strategyHash, label, server }) -> Promise<{ hash, status } | null>` — builds the `attest` invoke (source = attester), user signs inner tx, relayer fee-bumps. `null` when relay unconfigured.
  - `readAttestationCount(attester, { server }) -> Promise<number | null>`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stellar/attestation.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ tx: {}, xdr: 'UNSIGNED_XDR' })),
  readContract: vi.fn(async () => 3),
}))
vi.mock('./walletKit.js', () => ({
  signTxXdr: vi.fn(async () => 'SIGNED_XDR'),
}))
vi.mock('./relay.js', () => ({
  submitViaRelay: vi.fn(async () => ({ hash: 'TXHASH', status: 'SUCCESS', relayer: 'GREL' })),
}))

import { attestOnChain, readAttestationCount } from './attestation.js'
import { buildInvokeTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { submitViaRelay } from './relay.js'

const ATTESTER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const HASH = '0x' + 'ab'.repeat(32)

describe('attestOnChain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds attest invoke with source=attester, user-signs, relays', async () => {
    const out = await attestOnChain({ attester: ATTESTER, strategyHash: HASH, label: 'venice' })

    const call = buildInvokeTx.mock.calls[0][0]
    expect(call.source).toBe(ATTESTER)
    expect(call.method).toBe('attest')
    expect(call.args[0]).toEqual({ addr: ATTESTER })
    expect(call.args[1]).toEqual({ bytes32: HASH })
    expect(call.args[2]).toEqual({ symbol: 'venice' })

    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED_XDR')
    expect(submitViaRelay).toHaveBeenCalledWith({ xdr: 'SIGNED_XDR' })
    expect(out).toEqual({ hash: 'TXHASH', status: 'SUCCESS', relayer: 'GREL' })
  })

  it('truncates label to 9 chars (symbol_short limit) and defaults to "strategy"', async () => {
    await attestOnChain({ attester: ATTESTER, strategyHash: HASH, label: 'a-very-long-provider-name' })
    expect(buildInvokeTx.mock.calls[0][0].args[2]).toEqual({ symbol: 'a-very-lo' })

    await attestOnChain({ attester: ATTESTER, strategyHash: HASH })
    expect(buildInvokeTx.mock.calls[1][0].args[2]).toEqual({ symbol: 'strategy' })
  })
})

describe('readAttestationCount', () => {
  it('returns the decoded count as a number', async () => {
    expect(await readAttestationCount(ATTESTER, { server: {} })).toBe(3)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/stellar/attestation.test.js`
Expected: FAIL — `attestation.js` does not exist.

- [ ] **Step 3: Implement `stellar/attestation.js`**

Create `frontend/src/stellar/attestation.js`:

```js
// On-chain strategy attestation (Soroban). User signs the inner attest tx
// (attester = user → require_auth satisfied by source-account auth); the relay
// fee-bumps so the user pays 0 XLM. hashStrategy stays pure in src/attestation.js.
import { buildInvokeTx, readContract } from './client.js'
import { submitViaRelay } from './relay.js'
import { signTxXdr } from './walletKit.js'
import { SOROBAN_ATTESTATION_ADDRESS } from './config.js'

/**
 * Attest a strategy hash on-chain. Returns { hash, status } on success, or null
 * when the relay is unconfigured/unreachable. Never throws on relay failure.
 * @param {{ attester: string, strategyHash: string, label?: string, server?: object }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 */
export async function attestOnChain({ attester, strategyHash, label, server }) {
  const sym = String(label || 'strategy').slice(0, 9) // symbol_short! max 9 chars
  const { xdr } = await buildInvokeTx({
    source: attester,
    contract: SOROBAN_ATTESTATION_ADDRESS,
    method: 'attest',
    args: [{ addr: attester }, { bytes32: strategyHash }, { symbol: sym }],
    server,
  })
  const signed = await signTxXdr(xdr) // user wallet signs the inner tx
  return submitViaRelay({ xdr: signed }) // server wraps in fee-bump, pays XLM
}

/**
 * Read how many attestations an address has recorded.
 * @param {string} attester
 * @param {{ server?: object }} [opts]
 * @returns {Promise<number | null>}
 */
export async function readAttestationCount(attester, { server } = {}) {
  try {
    const n = await readContract({
      contract: SOROBAN_ATTESTATION_ADDRESS,
      method: 'count_of',
      args: [{ addr: attester }],
      server,
    })
    return Number(n)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/stellar/attestation.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/attestation.js frontend/src/stellar/attestation.test.js
git commit -m "feat: add on-chain attestation client (attestOnChain + readAttestationCount)"
```

---

## Task 5: Live testnet smoke (the real proof)

> Proves the contract works end-to-end on testnet via the exact prod mechanism: a signed inner tx wrapped in a relayer fee-bump. The smoke does the fee-bump **in-process with the SDK** (node can't POST to the relative `/api/stellar-relay` URL). The relay server runs the same `buildFeeBumpTransaction` call (`frontend/api/stellar-relay.js:121`).

**Files:**
- Create: `frontend/scripts/stellar-attest-smoke.mjs`

**Interfaces:**
- Consumes: `buildInvokeTx`, `rpcServer` (`client.js`); `readAttestationCount` (`stellar/attestation.js`); `SOROBAN_ATTESTATION_ADDRESS`, `NETWORK_PASSPHRASE`, `SOROBAN_RPC_URL` (`config.js`); `@stellar/stellar-sdk`.
- Env vars (loaded from `frontend/.env` via `dotenv/config`, mirroring `stellar-deposit-smoke.mjs`):
  - `STELLAR_RELAYER_SECRET` (S...) — funded relayer; fee source.
  - `ATTEST_SMOKE_SECRET` (S...) — funded attester; defaults to `STELLAR_RELAYER_SECRET` if unset (then inner source == fee source, still a valid fee-bump and a valid attest).

- [ ] **Step 1: Write the smoke script**

Create `frontend/scripts/stellar-attest-smoke.mjs`:

```js
// frontend/scripts/stellar-attest-smoke.mjs
// Live testnet proof: attest a known hash, fee-bump in-process, assert count rose.
// Run: cd frontend && node scripts/stellar-attest-smoke.mjs
import 'dotenv/config'
import { Keypair, TransactionBuilder, BASE_FEE, rpc } from '@stellar/stellar-sdk'
import { buildInvokeTx } from '../src/stellar/client.js'
import { readAttestationCount } from '../src/stellar/attestation.js'
import {
  SOROBAN_ATTESTATION_ADDRESS,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from '../src/stellar/config.js'

const relayerSecret = process.env.STELLAR_RELAYER_SECRET
if (!relayerSecret) throw new Error('set STELLAR_RELAYER_SECRET (funded relayer S... secret)')
const attesterSecret = process.env.ATTEST_SMOKE_SECRET || relayerSecret

const relayerKp = Keypair.fromSecret(relayerSecret)
const attesterKp = Keypair.fromSecret(attesterSecret)
const attester = attesterKp.publicKey()
const server = new rpc.Server(SOROBAN_RPC_URL)
const strategyHash = '0x' + 'ab'.repeat(32) // a known, reproducible test hash

const before = (await readAttestationCount(attester, { server })) ?? 0
console.log('count before:', before, 'attester:', attester)

// Build inner attest tx with attester as source, then user(attester)-sign it.
const { tx } = await buildInvokeTx({
  source: attester,
  contract: SOROBAN_ATTESTATION_ADDRESS,
  method: 'attest',
  args: [{ addr: attester }, { bytes32: strategyHash }, { symbol: 'smoke' }],
  server,
})
tx.sign(attesterKp)

// Relayer wraps it in a fee-bump (relayer = fee source) and pays the XLM.
const feeBump = TransactionBuilder.buildFeeBumpTransaction(
  relayerKp,
  (Number(BASE_FEE) * 100).toString(), // generous fee ceiling for a Soroban tx
  tx,
  NETWORK_PASSPHRASE,
)
feeBump.sign(relayerKp)

const sent = await server.sendTransaction(feeBump)
console.log('submitted:', sent.hash, sent.status)
let result = await server.getTransaction(sent.hash)
for (let i = 0; i < 30 && result.status === 'NOT_FOUND'; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  result = await server.getTransaction(sent.hash)
}
console.log('final status:', result.status)
if (result.status !== 'SUCCESS') throw new Error(`attest did not succeed: ${result.status}`)

const after = (await readAttestationCount(attester, { server })) ?? 0
console.log('count after:', after)
if (!(after > before)) throw new Error('FAIL: attestation count did not increase')
console.log('PASS: strategy attested on-chain')
console.log(`https://stellar.expert/explorer/testnet/tx/${sent.hash}`)
```

- [ ] **Step 2: Run the smoke against testnet**

Run: `cd frontend && node scripts/stellar-attest-smoke.mjs`
Expected: prints `count before`, `submitted ... PENDING`, `final status: SUCCESS`, `count after` = before+1, `PASS`, and a `stellar.expert` URL. Open the URL to visually confirm the `StrategyAttested` event.

> If `STELLAR_RELAYER_SECRET` is unfunded, the run fails at `sendTransaction`. Fund it on testnet (friendbot) first. The contract + offline tests (Tasks 1, 3, 4) are the capability proof; this smoke is the live proof.

- [ ] **Step 3: Commit**

```bash
git add frontend/scripts/stellar-attest-smoke.mjs
git commit -m "test: add live testnet attestation smoke script"
```

---

## Task 6: Wire on-chain attestation into the app (TDD)

**Files:**
- Modify: `frontend/src/attestation.js:39-47` (`attestStrategyOnChain`), `:53-62` (`formatAttestation`)
- Modify: `frontend/src/app.jsx:344-350` (attestation effect), uses `realAddress` (`:328`)
- Modify: `frontend/src/agents.jsx:837-875` (StrategyCard chip)
- Modify: `frontend/src/attestation.test.js` (create if absent)

**Interfaces:**
- Consumes: `attestOnChain` from `stellar/attestation.js` (Task 4).
- Produces (changed signatures):
  - `attestStrategyOnChain(strategy, { attester } = {}) -> Promise<{ strategyHash, txHash, explorerUrl } | null>` — computes pure `strategyHash`; if `attester` present, attempts on-chain attest and captures `txHash`; always non-blocking; falls back to `{ txHash: null }`.
  - `formatAttestation(attestation)` — now sets `explorerUrl` + on-chain label when `txHash` present.

- [ ] **Step 1: Write the failing tests**

Create/extend `frontend/src/attestation.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./stellar/attestation.js', () => ({
  attestOnChain: vi.fn(),
}))

import { attestStrategyOnChain, formatAttestation, hashStrategy } from './attestation.js'
import { attestOnChain } from './stellar/attestation.js'

const strategy = {
  selected_vaults: [{ address: 'C1', protocol: 'Blend', allocation: 100, expected_apy: 5, reasoning: 'x' }],
  generatedBy: 'venice',
}

describe('attestStrategyOnChain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captures txHash when an attester is given and the relay succeeds', async () => {
    attestOnChain.mockResolvedValue({ hash: 'TX123', status: 'SUCCESS' })
    const r = await attestStrategyOnChain(strategy, { attester: 'GUSER' })
    expect(attestOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ attester: 'GUSER', label: 'venice' }),
    )
    expect(r.txHash).toBe('TX123')
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('falls back to off-chain hash when no attester (txHash null)', async () => {
    const r = await attestStrategyOnChain(strategy, {})
    expect(attestOnChain).not.toHaveBeenCalled()
    expect(r.txHash).toBeNull()
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('falls back when the relay returns null (non-blocking)', async () => {
    attestOnChain.mockResolvedValue(null)
    const r = await attestStrategyOnChain(strategy, { attester: 'GUSER' })
    expect(r.txHash).toBeNull()
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('formatAttestation', () => {
  it('adds a stellar.expert explorer link + on-chain label when txHash present', () => {
    const f = formatAttestation({ strategyHash: '0x' + 'a'.repeat(64), txHash: 'TX123' })
    expect(f.explorerUrl).toBe('https://stellar.expert/explorer/testnet/tx/TX123')
    expect(f.label).toBe('Strategy attested on-chain')
  })
  it('keeps off-chain label when no txHash', () => {
    const f = formatAttestation({ strategyHash: '0x' + 'a'.repeat(64), txHash: null })
    expect(f.explorerUrl).toBeNull()
    expect(f.label).toBe('Strategy hash (off-chain verifiable)')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/attestation.test.js`
Expected: FAIL — `attestStrategyOnChain` ignores `attester`/never calls `attestOnChain`; `formatAttestation` always returns `explorerUrl: null`.

- [ ] **Step 3: Update `attestStrategyOnChain` (`attestation.js:39-47`)**

Add the import at the top of `frontend/src/attestation.js`:

```js
import { attestOnChain } from './stellar/attestation.js'
```

Replace the body:

```js
export async function attestStrategyOnChain(strategy, { attester } = {}) {
  try {
    const strategyHash = strategy.strategyHash || hashStrategy(strategy)
    if (!attester) return { strategyHash, txHash: null, explorerUrl: null }
    const r = await attestOnChain({ attester, strategyHash, label: strategy.generatedBy })
    return { strategyHash, txHash: r?.hash || null, explorerUrl: null }
  } catch (err) {
    console.warn('[Attestation] Skipped (non-blocking):', err.message)
    return null
  }
}
```

- [ ] **Step 4: Update `formatAttestation` (`attestation.js:53-62`)**

```js
export function formatAttestation(attestation) {
  if (!attestation) return null
  const txHash = attestation.txHash || null
  return {
    hash: attestation.strategyHash.slice(0, 10) + '...',
    fullHash: attestation.strategyHash,
    txHash,
    explorerUrl: txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null,
    label: txHash ? 'Strategy attested on-chain' : 'Strategy hash (off-chain verifiable)',
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd frontend && npx vitest run src/attestation.test.js`
Expected: PASS — all tests green.

- [ ] **Step 6: Pass `attester` into the attestation effect (`app.jsx:344-350`)**

Change the `attestStrategyOnChain(rawStrategy)` call to pass the connected address (`realAddress`, declared at `app.jsx:328`):

```jsx
  useE(() => {
    if (!rawStrategy?.strategyHash || strategyAttestation || attesting) return
    setAttesting(true)
    attestStrategyOnChain(rawStrategy, { attester: realAddress })
      .then((a) => setStrategyAttestation(formatAttestation(a)))
      .finally(() => setAttesting(false))
  }, [rawStrategy, realAddress])
```

(The effect still fires on `rawStrategy?.strategyHash`; when `realAddress` is undefined, `attestStrategyOnChain` cleanly returns the off-chain hash — graceful degradation.)

- [ ] **Step 7: Show the on-chain link in the StrategyCard chip (`agents.jsx:837-875`)**

In the `attestation ?` branch, render the explorer link when `attestation.explorerUrl` is set. Replace the inner content of that branch:

```jsx
          {attestation ? (
            <>
              <span style={{ color: 'var(--ok)', fontSize: 8 }}>●</span>
              <span>{attestation.label}</span>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span>Hash: {attestation.hash}</span>
              {attestation.explorerUrl ? (
                <a
                  href={attestation.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: 'auto', color: 'var(--accent)' }}
                >
                  View on-chain ↗
                </a>
              ) : (
                <span style={{ color: 'var(--text-faint)', marginLeft: 'auto' }}>
                  Deterministic · reproducible from strategy JSON
                </span>
              )}
            </>
          ) : attesting ? (
```

- [ ] **Step 8: Run the full frontend suite + build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: all tests pass (existing + new); build succeeds.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/attestation.js frontend/src/attestation.test.js frontend/src/app.jsx frontend/src/agents.jsx
git commit -m "feat: wire on-chain attestation into strategy flow + show explorer link"
```

---

## Task 7 (OPTIONAL — additive polish): Surface `strategy_attested` in the public Explorer

> The core judging proof (on-chain tx + explorer link) ships in Task 6 on the strategy card. This task adds the public ExplorerPage feed. **Note:** the spec's claim that ExplorerPage uses EVM `getReadProvider`/`ethers` is stale — `ExplorerPage.jsx` is already Stellar-only and reads attestations from `localStorage` via `history.js`. This task makes the table *also* show on-chain attestation events. There is no ethers import to remove.

**Files:**
- Modify: `frontend/src/stellar/events.js` (add attestation contract to the watched-contracts list)
- Modify: `frontend/src/components/ExplorerPage.jsx:144-174` (`AttestationsTable`)

**Interfaces:**
- Consumes: `pollEvents({ server, startLedger, seen })` (`events.js`) — returns `{ events, ... }` where each event is `{ type, contract, ledger, cursor, txHash, data }`. `eventToGraphDelta` returns `{}` for unknown types (forward-compatible — no graph change needed).

- [ ] **Step 1: Add the attestation contract to the watched list in `events.js`**

`pollEvents` filters to a watched-contracts array. Locate it:

Run: `cd frontend && npx rg -n "SOROBAN_VAULT_ADDRESS|WATCHED|contractIds|filters" src/stellar/events.js`

Add `SOROBAN_ATTESTATION_ADDRESS` to that array (and to the `config.js` import in `events.js`). Example (match the actual variable name found):

```js
import { SOROBAN_ATTESTATION_ADDRESS } from './config.js'
// ...add SOROBAN_ATTESTATION_ADDRESS to the WATCHED / contractIds array used by getEvents
```

- [ ] **Step 2: Write the failing test for the explorer read**

Add to `frontend/src/stellar/events.test.js` (mirror the existing `fakeRecord` builder there):

```js
it('decodes a strategy_attested event', () => {
  const rec = fakeRecord({
    type: 'strategy_attested',
    fields: { attester: agent, strategy_hash: 'ab'.repeat(32), ledger: 99, label: 'venice' },
    contractId: 'CATTEST_PLACEHOLDER',
    pagingToken: '0099',
    ledger: 99,
  })
  const e = decodeEvent(rec)
  expect(e.type).toBe('strategy_attested')
  expect(e.data.label).toBe('venice')
})
```

Run: `cd frontend && npx vitest run src/stellar/events.test.js` — expected PASS (decodeEvent is type-agnostic; this just locks the behavior).

- [ ] **Step 3: Render on-chain attestations in `AttestationsTable` (`ExplorerPage.jsx:144-174`)**

Add an effect that polls `strategy_attested` events and renders them as rows (with stellar.expert links), merged ahead of the localStorage `getStrategies()` rows. Keep the existing localStorage rows as a fallback so the table is never empty pre-attest:

```jsx
// inside AttestationsTable
const [onchain, setOnchain] = useState([])
useEffect(() => {
  let alive = true
  ;(async () => {
    try {
      const { rpcServer } = await import('../stellar/client.js')
      const { pollEvents } = await import('../stellar/events.js')
      const server = await rpcServer()
      const { sequence } = await server.getLatestLedger()
      const startLedger = Math.max(1, sequence - 8000)
      const { events } = await pollEvents({ server, startLedger })
      if (alive) setOnchain(events.filter((e) => e.type === 'strategy_attested'))
    } catch {
      /* non-blocking — table still shows localStorage rows */
    }
  })()
  return () => {
    alive = false
  }
}, [])
```

Render `onchain` rows above the existing `strategies.map(...)` rows, each linking `https://stellar.expert/explorer/testnet/tx/${e.txHash}`.

- [ ] **Step 4: Run the suite + build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/events.js frontend/src/stellar/events.test.js frontend/src/components/ExplorerPage.jsx
git commit -m "feat: surface on-chain strategy attestations in the public explorer"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|--------------|------|
| §4 contract (`attest`/`count_of`, storage A, event) | Task 1 |
| §7 config/deploy (crate, address, deploy-seed, deployments json) | Task 2 (workspace edit dropped — glob covers it) |
| §5 `{bytes32}`/`{sym}` encoders (flagged missing) | Task 3 |
| §5 `stellar/attestation.js` (`attestOnChain`/`readAttestationCount`) | Task 4 |
| §6 gas model (user-signed + relayer fee-bump) | Tasks 4 (browser) + 5 (smoke) |
| §8 live smoke | Task 5 |
| §5 wiring (`attestation.js`, `app.jsx`, `agents.jsx`) | Task 6 |
| §5 ExplorerPage feed | Task 7 (optional; spec's ethers-removal premise corrected) |
| §8 test plan (contract TDD, frontend vitest, live smoke) | Tasks 1, 3, 4, 6 (offline) + 5 (live) |

No spec requirement is unaddressed. Two spec items corrected against codebase reality: (a) `soroban/Cargo.toml` workspace edit is unnecessary (glob members); (b) ExplorerPage has no ethers import to remove (already Stellar-only) — Task 7 is purely additive.

**2. Placeholder scan:** Only intentional `C_REPLACE_WITH_DEPLOYED_ADDRESS` / `CATTEST_PLACEHOLDER` markers, which Task 2 fills with the real deployed address before later tasks consume it. The `rg`/locate step in Task 7 Step 1 is a bounded one-line edit (the watched-array name varies); all other steps carry complete code.

**3. Type consistency:** `attestOnChain({ attester, strategyHash, label, server })` and `readAttestationCount(attester, { server })` are defined identically in Task 4 and consumed in Tasks 5 & 6. `attestStrategyOnChain(strategy, { attester })` and `formatAttestation` return `{ strategyHash, txHash, explorerUrl }` consistently across Task 6's tests and bodies. Arg tags `{ addr }`/`{ bytes32 }`/`{ symbol }` match the encoders added in Task 3. Contract `attest(attester, strategy_hash, label) -> u32` and `count_of -> u32` match the client calls in Tasks 4 & 5.

---

## Execution Handoff

(Filled by the writing-plans skill after save.)

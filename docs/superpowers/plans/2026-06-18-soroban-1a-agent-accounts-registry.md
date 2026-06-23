# Soroban Sub-Project 1a — Agent Smart Accounts + Thin Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Local-only doc.** `docs/superpowers/` is gitignored per project rule — do **not** commit this plan.
> **Source spec:** `docs/superpowers/specs/2026-06-18-stellar-soroban-rwafi-migration-design.md` (sub-project 1, component 1a). Read §4 (migration map), §5 (architecture), ADR table §6, §8 (testnet), §9 (risks) before starting.

**Goal:** Build the Soroban permission layer that replaces the EVM `AgentRegistry.sol` + EIP-712 session keys — an agent **custom account** (`__check_auth`) that cryptographically enforces a capped/expiring per-agent scope, plus a thin **Registry** contract recording agent→owner→scope metadata + revoke state for the audit trail and force-graph monitor.

**Architecture:** Two Soroban (Rust→WASM) contracts in a new `soroban/` cargo workspace, kept entirely separate from the existing Foundry `contracts/` (Solidity, unchanged). The **agent account** is a per-worker custom-account contract: it holds an ed25519 session public key + an `AgentScope`, and its `__check_auth` verifies the signature **and** enforces scope (allowed vault + asset, cap-per-period with rolling reset, expiry, revoked) against the authorization contexts. The **registry** is a separate contract the owner writes to at grant time (and revoke time) so off-chain indexers/the graph can read agent topology without simulating every account. Hand-rolled `__check_auth` is the chosen path (spec ADR "Permission model" fallback) because the OpenZeppelin Smart Accounts module testnet-readiness is an unvalidated risk (spec §9) — Task 1 validates and records that decision; the registry + scope schema are stable regardless of which signer backend wins later.

**Tech Stack:** Rust `#![no_std]`, `soroban-sdk = "25.0.1"` (pin; verify latest on crates.io at Task 0), `stellar-cli` (`stellar contract …`), `cargo test` + soroban testutils, Soroban testnet (`Test SDF Network ; September 2015`). Toolchain runs under **WSL** mirroring the existing Foundry convention (`wsl -e bash -c "cd /mnt/c/... && <cmd>"`) — Foundry/cargo do not run in PowerShell on this machine.

**Scope boundary (read this):** This plan is component **1a only**. It produces a working, independently testable permission layer. It does **NOT** build the RWA token (1b), the FOBXX-dividend vault (1c), or the allocation guardrail (1d) — those are separate plans. Where 1a must enforce against the vault's `deposit` call, this plan **pins the inter-layer interface convention** (Task 5) that 1c will implement; 1a does not depend on 1c existing to compile or test (tests use a stub vault address + mocked contexts).

---

## File Structure

New cargo workspace at repo root `soroban/` (sibling of `contracts/`, `frontend/`):

```
soroban/
├── Cargo.toml                         # workspace manifest (members + shared release profile)
├── README.md                          # how to build/test/deploy (WSL commands)
├── .gitignore                         # target/
├── contracts/
│   ├── agent_account/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                 # contract entry + module wiring
│   │       ├── types.rs               # AgentScope, Signature, DataKey, AccountError
│   │       ├── account.rs             # __constructor + admin/scope ops + CustomAccountInterface
│   │       └── test.rs                # unit tests (TDD)
│   └── registry/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                 # contract entry
│           ├── types.rs               # AgentRecord, DataKey, RegistryError, events
│           ├── registry.rs            # authorize/revoke/scope_of/is_revoked
│           └── test.rs                # unit tests (TDD)
deployments/
└── stellar-testnet.json               # NEW — deployed contract ids (mirrors base-sepolia.json)
scripts/
└── soroban/
    └── deploy-seed.sh                 # deploy both + seed one demo agent → writes stellar-testnet.json
docs/
└── soroban-interfaces.md              # NEW (committed-candidate) — pinned inter-layer interface for 2/3/4 + 1c
```

Responsibility split: `types.rs` holds all `#[contracttype]`/`#[contracterror]` definitions (shared, no logic) so they can be eyeballed in isolation; `account.rs`/`registry.rs` hold logic; `test.rs` holds tests. Each file stays well under the 800-line cap.

---

### Task 0: Scaffold the Soroban workspace

**Files:**
- Create: `soroban/Cargo.toml`
- Create: `soroban/.gitignore`
- Create: `soroban/README.md`
- Create: `soroban/contracts/agent_account/Cargo.toml`
- Create: `soroban/contracts/agent_account/src/lib.rs`

- [ ] **Step 1: Confirm toolchain in WSL**

Run:
```bash
wsl -e bash -c "stellar --version && cargo --version && rustup target list --installed | grep wasm32"
```
Expected: prints a `stellar` version, a `cargo` version, and at least one `wasm32*` target. If `stellar` is missing: `wsl -e bash -c "cargo install --locked stellar-cli"`. If no wasm target: `wsl -e bash -c "rustup target add wasm32-unknown-unknown"` (the build also accepts `wasm32v1-none` on newer SDKs; `stellar contract build` selects the right one — do not hardcode).

- [ ] **Step 2: Check the current soroban-sdk version**

Run:
```bash
wsl -e bash -c "curl -s https://crates.io/api/v1/crates/soroban-sdk | head -c 400"
```
Expected: JSON containing `"max_stable_version":"25.x.x"` (or newer). **Pin whatever the current stable major is** in every `Cargo.toml` below; if it is not `25.x`, substitute the real version everywhere this plan writes `25.0.1`.

- [ ] **Step 3: Create the workspace manifest**

`soroban/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["contracts/*"]

[workspace.dependencies]
soroban-sdk = "25.0.1"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true

[profile.release-with-logs]
inherits = "release"
debug-assertions = true
```

- [ ] **Step 4: Create the gitignore and README**

`soroban/.gitignore`:
```
target/
```

`soroban/README.md`:
```markdown
# Soroban contracts (Vibing Farmer → Stellar)

Cargo workspace for the on-chain layer. Runs under WSL (cargo/stellar-cli are not on the PowerShell path).

## Build
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"

## Test
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

## Deploy + seed (testnet)
See ../scripts/soroban/deploy-seed.sh. Network passphrase: "Test SDF Network ; September 2015".
```

- [ ] **Step 5: Create a minimal agent_account crate that compiles**

`soroban/contracts/agent_account/Cargo.toml`:
```toml
[package]
name = "agent_account"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

`soroban/contracts/agent_account/src/lib.rs`:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    pub fn version(_env: Env) -> u32 {
        1
    }
}
```

- [ ] **Step 6: Verify the workspace builds**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"
```
Expected: builds `agent_account.wasm` under `target/wasm32*/release/`. Then `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"` → `0 tests, ok`.

- [ ] **Step 7: Commit**

```bash
rtk git add soroban/ && rtk git commit -m "feat: scaffold soroban cargo workspace"
```

---

### Task 1: Validate signer backend + pin the SDK auth surface (decision gate)

This is the spec §9 "is this still the current best primitive?" gate. No production code — it locks two facts the rest of the plan assumes: (1) hand-rolled `__check_auth` vs OZ Smart Accounts, (2) the exact `CustomAccountInterface` signature in the pinned SDK.

**Files:**
- Create: `soroban/contracts/agent_account/src/account.rs` (probe only this task)
- Modify: `soroban/contracts/agent_account/src/lib.rs`

- [ ] **Step 1: Record the signer-backend decision**

Decision (default, per spec ADR "Permission model" fallback): **hand-rolled `__check_auth`**. Rationale to write into `docs/soroban-interfaces.md` later: OZ Stellar Smart Accounts module testnet-readiness for spend-limit + scope policies is unvalidated (spec §9 risk) and adds an external dependency on the critical auth path; hand-rolled is self-contained and audited via our own tests. Revisit OZ when 1b/1c land if it de-risks. **No action needed to proceed — this step just confirms the path.**

- [ ] **Step 2: Write a compile-only probe of the auth trait**

Append to `soroban/contracts/agent_account/src/lib.rs`:
```rust
mod account;
```

Create `soroban/contracts/agent_account/src/account.rs`:
```rust
use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, BytesN, Env, Vec};

use crate::AgentAccount;

// Probe: confirm the CustomAccountInterface signature compiles against the pinned SDK.
// Signature/Error are placeholders for this probe ONLY; Task 2 replaces them.
#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>;
    type Error = soroban_sdk::Error;

    #[allow(non_snake_case)]
    fn __check_auth(
        _env: Env,
        _signature_payload: Hash<32>,
        _signatures: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}
```

- [ ] **Step 3: Compile the probe**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo build -p agent_account"
```
Expected: **PASS.** If it fails on the trait shape, the SDK signature has drifted — read the compiler error, fetch the current `account` example (`https://github.com/stellar/soroban-examples/tree/main/account`) or `soroban-sdk` docs for `CustomAccountInterface`, and correct the signature here. **Every later task reuses this exact `__check_auth` shape — fix it once, here.**

- [ ] **Step 4: Commit the validated shape**

```bash
rtk git add soroban/ && rtk git commit -m "chore: validate soroban custom-account auth signature"
```

---

### Task 2: Agent account — scope types + constructor

**Files:**
- Create: `soroban/contracts/agent_account/src/types.rs`
- Modify: `soroban/contracts/agent_account/src/lib.rs`
- Test: `soroban/contracts/agent_account/src/test.rs`

- [ ] **Step 1: Write the failing test for construction + scope read**

Create `soroban/contracts/agent_account/src/test.rs`:
```rust
#![cfg(test)]
use crate::{AgentAccount, AgentAccountClient};
use crate::types::AgentScope;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};

fn scope(env: &Env, owner: &Address, vault: &Address, token: &Address) -> AgentScope {
    AgentScope {
        owner: owner.clone(),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: 1_000_000_000, // 1,000 units @ 6dp
        period_duration: 86_400,       // 1 day
        spent_in_period: 0,
        period_start: 0,
        expiry: 4_000_000_000,         // far future
        revoked: false,
    }
}

#[test]
fn test_constructor_stores_scope_and_key() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    let s = scope(&env, &owner, &vault, &token);

    let id = env.register(AgentAccount, (owner.clone(), pubkey.clone(), s.clone()));
    let client = AgentAccountClient::new(&env, &id);

    let got = client.scope_of();
    assert_eq!(got.vault, vault);
    assert_eq!(got.cap_per_period, 1_000_000_000);
    assert_eq!(got.revoked, false);
    assert_eq!(client.signer(), pubkey);
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account test_constructor_stores_scope_and_key"
```
Expected: FAIL — `AgentScope` / `scope_of` / `signer` not found.

- [ ] **Step 3: Define the scope types**

Create `soroban/contracts/agent_account/src/types.rs`:
```rust
use soroban_sdk::{contracterror, contracttype, Address};

/// Capped, expiring per-agent scope. Mirrors the EVM `AgentScope` struct.
/// Amounts are i128 (Soroban native signed 128-bit); durations/timestamps are
/// ledger-clock seconds (u64).
#[contracttype]
#[derive(Clone)]
pub struct AgentScope {
    pub owner: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub period_duration: u64,
    pub spent_in_period: i128,
    pub period_start: u64,
    pub expiry: u64,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Signer, // ed25519 session public key (BytesN<32>)
    Scope,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    AlreadyInit = 1,
    NotInit = 2,
    Revoked = 3,
    Expired = 4,
    CapExceeded = 5,
    VaultMismatch = 6,
    FnNotAllowed = 7,
    BadSignature = 8,
    UnexpectedContexts = 9,
    InvalidAmount = 10,
}
```

- [ ] **Step 4: Implement the constructor + read views**

Replace `soroban/contracts/agent_account/src/lib.rs` with:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

mod account;
pub mod types;
mod test;

use types::{AgentScope, DataKey};

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    /// Deployed once per worker agent. `owner` = the human EOA that granted the
    /// scope; `signer` = the ephemeral ed25519 session pubkey the worker signs with.
    pub fn __constructor(env: Env, owner: Address, signer: BytesN<32>, scope: AgentScope) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Scope, &scope);
    }

    pub fn scope_of(env: Env) -> AgentScope {
        env.storage().instance().get(&DataKey::Scope).unwrap()
    }

    pub fn signer(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Signer).unwrap()
    }

    pub fn version(_env: Env) -> u32 {
        1
    }
}
```

- [ ] **Step 5: Replace the Task-1 probe with the real (still stub) trait impl**

Replace `soroban/contracts/agent_account/src/account.rs` with:
```rust
use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, BytesN, Env, Vec};

use crate::types::AccountError;
use crate::AgentAccount;

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>; // single ed25519 signature over the payload
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        _env: Env,
        _signature_payload: Hash<32>,
        _signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        Ok(()) // real enforcement lands in Task 3 + Task 4
    }
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account test_constructor_stores_scope_and_key"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add soroban/ && rtk git commit -m "feat: agent account scope types + constructor"
```

---

### Task 3: Agent account — signature verification in `__check_auth`

**Files:**
- Modify: `soroban/contracts/agent_account/src/account.rs`
- Test: `soroban/contracts/agent_account/src/test.rs`

- [ ] **Step 1: Write the failing signature test**

Append to `soroban/contracts/agent_account/src/test.rs`:
```rust
use soroban_sdk::testutils::BytesN as _;

#[test]
fn test_check_auth_rejects_bad_signature() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    // Random pubkey we do NOT hold the secret for → any signature must fail.
    let pubkey = BytesN::from_array(&env, &[9u8; 32]);
    let s = scope(&env, &owner, &vault, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s));

    let payload = BytesN::random(&env);
    let junk_sig = BytesN::from_array(&env, &[0u8; 64]);

    // __check_auth is invoked via try_ with empty contexts; signature check fails first.
    let res = env.as_contract(&id, || {
        // direct invocation helper exposed by the generated client below
        crate::AgentAccount::__check_auth(
            env.clone(),
            soroban_sdk::crypto::Hash::from_bytes(payload.clone()),
            junk_sig,
            soroban_sdk::Vec::new(&env),
        )
    });
    assert!(res.is_err());
}
```
> Note: `Hash::from_bytes` is used in tests to fabricate a payload. If the pinned SDK names this differently, the Task-1 compile gate plus this test surface it — adjust to the SDK's `Hash<32>` test constructor.

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account test_check_auth_rejects_bad_signature"
```
Expected: FAIL — stub returns `Ok(())`.

- [ ] **Step 3: Implement ed25519 verification**

Replace the body of `__check_auth` in `soroban/contracts/agent_account/src/account.rs` (keep imports; add `Bytes`):
```rust
use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, Bytes, BytesN, Env, Vec};

use crate::types::{AccountError, DataKey};
use crate::AgentAccount;

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>;
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let pubkey: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Signer)
            .ok_or(AccountError::NotInit)?;

        // ed25519_verify panics on a bad signature; that panic is the rejection.
        let payload: Bytes = signature_payload.to_bytes();
        env.crypto().ed25519_verify(&pubkey, &payload, &signature);

        Ok(())
    }
}
```
> `Hash<32>::to_bytes()` yields the `Bytes` message. If the pinned SDK exposes the conversion as `.into()` instead, use `let payload: Bytes = signature_payload.clone().into();` — the Task-1 compile gate tells you which. `ed25519_verify` panics (does not return `Result`) on mismatch; the panic aborts the auth, which is the desired reject. The test asserts `is_err()` because `try_*`/`as_contract` surfaces the trap as an error.

- [ ] **Step 4: Run the test to confirm it passes**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account test_check_auth_rejects_bad_signature"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add soroban/ && rtk git commit -m "feat: ed25519 signature check in agent account __check_auth"
```

---

### Task 4: Agent account — scope enforcement (vault/fn/expiry/revoked/cap)

This is the heart of the permission model. It enforces, **for every authorization context**, that the agent is only authorizing a `deposit` on its scoped vault, within cap, before expiry, while not revoked — and tracks `spent_in_period` with a rolling reset.

**Inter-layer convention (pinned here, implemented by 1c):** the vault deposit entrypoint is `deposit(from: Address, amount: i128) -> i128` with fn-name symbol `deposit`. The agent account reads `amount` from `args[1]` of the matched context. Task 5 records this in `docs/soroban-interfaces.md`.

**Files:**
- Modify: `soroban/contracts/agent_account/src/account.rs`
- Test: `soroban/contracts/agent_account/src/test.rs`

- [ ] **Step 1: Write failing tests for each scope rule**

Append to `soroban/contracts/agent_account/src/test.rs`:
```rust
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::{symbol_short, IntoVal, Val};

// Build a deposit auth context for `vault` spending `amount`.
fn deposit_ctx(env: &Env, vault: &Address, agent: &Address, amount: i128) -> Vec<Context> {
    let args: soroban_sdk::Vec<Val> =
        (agent.clone(), amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: vault.clone(),
            fn_name: symbol_short!("deposit"),
            args,
        })],
    )
}

// Helper that signs the payload with a known keypair so the sig check passes,
// letting tests target scope logic. Uses ed25519 test signer from testutils.
fn signed_check(
    env: &Env,
    id: &Address,
    secret: &[u8; 32],
    contexts: Vec<Context>,
) -> Result<Result<(), crate::types::AccountError>, soroban_sdk::InvokeError> {
    use soroban_sdk::testutils::ed25519;
    let payload = BytesN::random(env);
    let sig = ed25519::sign(env, secret, &payload.clone().into());
    env.as_contract(id, || {
        crate::AgentAccount::try_check_auth_for_test(
            env.clone(),
            soroban_sdk::crypto::Hash::from_bytes(payload),
            sig,
            contexts,
        )
    })
}
```
> The exact ed25519 test-signing helper name varies by SDK; if `testutils::ed25519::sign` is absent, generate the keypair with the `ed25519-dalek` dev-dependency and pass the raw 64-byte signature. The point of these tests is the scope branches, not crypto — keep auth mocked-valid. Add a thin `pub fn check_auth_for_test` wrapper on `AgentAccount` that calls the same internal `enforce_scope` so tests don't fight the `__check_auth` trait dispatch.

Add the rule tests:
```rust
#[test]
fn test_scope_rejects_wrong_vault() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let wrong_vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(AgentAccount, (owner, pubkey, scope(&env, &Address::generate(&env), &vault, &token)));
    let agent = Address::generate(&env);
    let ctx = deposit_ctx(&env, &wrong_vault, &agent, 10);
    // enforce_scope is the unit under test (auth-independent):
    let res = env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx));
    assert_eq!(res, Err(crate::types::AccountError::VaultMismatch));
}

#[test]
fn test_scope_rejects_when_revoked() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let mut s = scope(&env, &Address::generate(&env), &vault, &token);
    s.revoked = true;
    let id = env.register(AgentAccount, (owner, pubkey, s));
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 10);
    let res = env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx));
    assert_eq!(res, Err(crate::types::AccountError::Revoked));
}

#[test]
fn test_scope_rejects_when_expired() {
    let env = Env::default();
    env.ledger().set_timestamp(5_000_000_000); // past the far-future expiry
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(AgentAccount, (owner, pubkey, scope(&env, &Address::generate(&env), &vault, &token)));
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 10);
    let res = env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx));
    assert_eq!(res, Err(crate::types::AccountError::Expired));
}

#[test]
fn test_scope_rejects_over_cap() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(AgentAccount, (owner, pubkey, scope(&env, &Address::generate(&env), &vault, &token)));
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 2_000_000_000); // > 1,000,000,000 cap
    let res = env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx));
    assert_eq!(res, Err(crate::types::AccountError::CapExceeded));
}

#[test]
fn test_scope_accumulates_and_resets_period() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(AgentAccount, (owner, pubkey, scope(&env, &Address::generate(&env), &vault, &token)));

    // First spend of 600 units (cap is 1,000) → ok, spent=600.
    let ctx1 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert!(env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx1)).is_ok());

    // Second spend of 600 in same period → would total 1,200 > cap → reject.
    let ctx2 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert_eq!(
        env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx2)),
        Err(crate::types::AccountError::CapExceeded)
    );

    // Advance past period_duration (86,400s) → period resets, 600 ok again.
    env.ledger().set_timestamp(1000 + 86_401);
    let ctx3 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert!(env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx3)).is_ok());
}
```

- [ ] **Step 2: Run them to confirm they fail**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account test_scope_"
```
Expected: FAIL — `enforce_scope_for_test` not found.

- [ ] **Step 3: Implement scope enforcement**

Rewrite `soroban/contracts/agent_account/src/account.rs`:
```rust
use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, symbol_short, Bytes, BytesN, Env, Symbol, Vec};

use crate::types::{AccountError, AgentScope, DataKey};
use crate::AgentAccount;

const DEPOSIT_FN: Symbol = symbol_short!("deposit");
const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

/// Enforce the scope for one authorization context set, mutating spent_in_period.
/// Pure of signature concerns — called by __check_auth after the sig passes, and
/// directly by the test shim.
fn enforce(env: &Env, contexts: &Vec<Context>) -> Result<(), AccountError> {
    let mut scope: AgentScope = env
        .storage()
        .instance()
        .get(&DataKey::Scope)
        .ok_or(AccountError::NotInit)?;

    if scope.revoked {
        return Err(AccountError::Revoked);
    }
    let now = env.ledger().timestamp();
    if now >= scope.expiry {
        return Err(AccountError::Expired);
    }

    // Rolling period reset.
    if now >= scope.period_start.saturating_add(scope.period_duration) {
        scope.period_start = now;
        scope.spent_in_period = 0;
    }

    // Validate every context; reject anything not a scoped deposit.
    for ctx in contexts.iter() {
        let cc = match ctx {
            Context::Contract(cc) => cc,
            _ => return Err(AccountError::UnexpectedContexts),
        };
        if cc.contract != scope.vault {
            return Err(AccountError::VaultMismatch);
        }
        if cc.fn_name != DEPOSIT_FN {
            return Err(AccountError::FnNotAllowed);
        }
        // Pinned convention: deposit(from: Address, amount: i128); amount is args[1].
        let amount: i128 = cc
            .args
            .get(1)
            .ok_or(AccountError::UnexpectedContexts)?
            .try_into_val(env)
            .map_err(|_| AccountError::InvalidAmount)?;
        if amount <= 0 {
            return Err(AccountError::InvalidAmount);
        }
        let new_spent = scope
            .spent_in_period
            .checked_add(amount)
            .ok_or(AccountError::CapExceeded)?;
        if new_spent > scope.cap_per_period {
            return Err(AccountError::CapExceeded);
        }
        scope.spent_in_period = new_spent;
    }

    env.storage().instance().set(&DataKey::Scope, &scope);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>;
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let pubkey: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Signer)
            .ok_or(AccountError::NotInit)?;
        let payload: Bytes = signature_payload.to_bytes();
        env.crypto().ed25519_verify(&pubkey, &payload, &signature);
        enforce(&env, &auth_contexts)
    }
}

// Test-only shim so unit tests can exercise scope logic without crafting valid
// ed25519 signatures. Compiled only under cfg(test).
#[cfg(test)]
impl AgentAccount {
    pub fn enforce_scope_for_test(env: Env, contexts: Vec<Context>) -> Result<(), AccountError> {
        enforce(&env, &contexts)
    }
}
```
> `try_into_val` is the `Val`→`i128` conversion; if the pinned SDK names it `try_from_val`/`TryFromVal`, adjust per the compile error. `ContractContext` field names (`contract`, `fn_name`, `args`) match the SDK auth module — the Task-1 gate already proved these compile.

- [ ] **Step 4: Run the tests to confirm they pass**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account"
```
Expected: all `test_scope_*` + earlier tests PASS.

- [ ] **Step 5: Add a fuzz target for the cap accounting**

Create `soroban/contracts/agent_account/src/test.rs` addition (property test, no nightly needed):
```rust
#[test]
fn test_cap_never_exceeded_property() {
    // Sequence of deposits within one period must never let cumulative spend
    // pass the cap, regardless of split.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(AgentAccount, (owner, pubkey, scope(&env, &Address::generate(&env), &vault, &token)));
    let cap = 1_000_000_000i128;
    let mut accepted = 0i128;
    for chunk in [300_000_000i128, 300_000_000, 300_000_000, 300_000_000] {
        let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), chunk);
        if env.as_contract(&id, || crate::AgentAccount::enforce_scope_for_test(env.clone(), ctx)).is_ok() {
            accepted += chunk;
        }
    }
    assert!(accepted <= cap, "accepted {} exceeded cap {}", accepted, cap);
}
```

- [ ] **Step 6: Run + commit**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account"
```
Expected: PASS. Then:
```bash
rtk git add soroban/ && rtk git commit -m "feat: agent account scope enforcement with rolling cap"
```

---

### Task 5: Thin Registry contract — audit/revoke/graph metadata

The registry is owner-facing bookkeeping for indexers + the force-graph monitor + a revoke switch the account reads. The account remains the cryptographic authority; the registry is the queryable mirror.

**Files:**
- Create: `soroban/contracts/registry/Cargo.toml`
- Create: `soroban/contracts/registry/src/lib.rs`
- Create: `soroban/contracts/registry/src/types.rs`
- Create: `soroban/contracts/registry/src/registry.rs`
- Create: `soroban/contracts/registry/src/test.rs`

- [ ] **Step 1: Write the failing registry test**

Create `soroban/contracts/registry/src/test.rs`:
```rust
#![cfg(test)]
use crate::{Registry, RegistryClient};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Env};

#[test]
fn test_authorize_then_query_then_revoke() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(Registry, (admin.clone(),));
    let client = RegistryClient::new(&env, &id);

    let owner = Address::generate(&env);
    let agent = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);

    client.authorize(&owner, &agent, &vault, &token, &1_000_000_000i128, &86_400u64, &4_000_000_000u64);

    let rec = client.record_of(&agent);
    assert_eq!(rec.owner, owner);
    assert_eq!(rec.vault, vault);
    assert_eq!(rec.revoked, false);
    assert_eq!(client.is_revoked(&agent), false);

    client.revoke(&owner, &agent);
    assert_eq!(client.is_revoked(&agent), true);

    // Two events emitted: authorize, revoke.
    assert_eq!(env.events().all().len(), 2);
}

#[test]
fn test_revoke_requires_owner() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Registry, (admin,));
    let client = RegistryClient::new(&env, &id);
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let agent = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);

    env.mock_all_auths();
    client.authorize(&owner, &agent, &vault, &token, &10i128, &10u64, &4_000_000_000u64);

    // Stranger tries to revoke with only their own auth mocked → must fail.
    env.set_auths(&[]);
    let res = client.try_revoke(&stranger, &agent);
    assert!(res.is_err());
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p registry"
```
Expected: FAIL — crate/types not defined.

- [ ] **Step 3: Create the registry crate manifest**

`soroban/contracts/registry/Cargo.toml`:
```toml
[package]
name = "registry"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

- [ ] **Step 4: Define registry types + events**

`soroban/contracts/registry/src/types.rs`:
```rust
use soroban_sdk::{contracterror, contractevent, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub struct AgentRecord {
    pub owner: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub period_duration: u64,
    pub expiry: u64,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Record(Address), // keyed by agent address
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    NotFound = 1,
    NotOwner = 2,
}

#[contractevent(topics = ["agent_authorized"])]
pub struct AgentAuthorized {
    pub owner: Address,
    pub agent: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub expiry: u64,
}

#[contractevent(topics = ["agent_revoked"])]
pub struct AgentRevoked {
    pub owner: Address,
    pub agent: Address,
}
```

- [ ] **Step 5: Implement the registry logic**

`soroban/contracts/registry/src/registry.rs`:
```rust
use soroban_sdk::{Address, Env};

use crate::types::{AgentAuthorized, AgentRecord, AgentRevoked, DataKey, RegistryError};
use crate::Registry;

const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

impl Registry {
    pub(crate) fn authorize_impl(
        env: &Env,
        owner: Address,
        agent: Address,
        vault: Address,
        token: Address,
        cap_per_period: i128,
        period_duration: u64,
        expiry: u64,
    ) {
        owner.require_auth();
        let rec = AgentRecord {
            owner: owner.clone(),
            vault: vault.clone(),
            token: token.clone(),
            cap_per_period,
            period_duration,
            expiry,
            revoked: false,
        };
        env.storage().persistent().set(&DataKey::Record(agent.clone()), &rec);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Record(agent.clone()), TTL_THRESHOLD, TTL_EXTEND);
        AgentAuthorized { owner, agent, vault, token, cap_per_period, expiry }.publish(env);
    }

    pub(crate) fn revoke_impl(env: &Env, owner: Address, agent: Address) -> Result<(), RegistryError> {
        owner.require_auth();
        let mut rec: AgentRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Record(agent.clone()))
            .ok_or(RegistryError::NotFound)?;
        if rec.owner != owner {
            return Err(RegistryError::NotOwner);
        }
        rec.revoked = true;
        env.storage().persistent().set(&DataKey::Record(agent.clone()), &rec);
        AgentRevoked { owner, agent }.publish(env);
        Ok(())
    }
}
```

`soroban/contracts/registry/src/lib.rs`:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

pub mod types;
mod registry;
mod test;

use types::{AgentRecord, DataKey, RegistryError};

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn authorize(
        env: Env,
        owner: Address,
        agent: Address,
        vault: Address,
        token: Address,
        cap_per_period: i128,
        period_duration: u64,
        expiry: u64,
    ) {
        Self::authorize_impl(&env, owner, agent, vault, token, cap_per_period, period_duration, expiry);
    }

    pub fn revoke(env: Env, owner: Address, agent: Address) -> Result<(), RegistryError> {
        Self::revoke_impl(&env, owner, agent)
    }

    pub fn record_of(env: Env, agent: Address) -> AgentRecord {
        env.storage().persistent().get(&DataKey::Record(agent)).unwrap()
    }

    pub fn is_revoked(env: Env, agent: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Record(agent))
            .map(|r: AgentRecord| r.revoked)
            .unwrap_or(true) // unknown agent = treated as revoked (fail-closed)
    }
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p registry"
```
Expected: PASS. If `set_auths(&[])` / `try_revoke` naming differs in the pinned SDK testutils, adjust to the SDK's negative-auth pattern (the soroban testing skill documents `mock_auths` with a specific address as the alternative).

- [ ] **Step 7: Commit**

```bash
rtk git add soroban/ && rtk git commit -m "feat: thin agent registry with authorize/revoke/query + events"
```

---

### Task 6: Pin the inter-layer interface doc (consumed by 1b/1c/2/3/4)

The spec §7 says sub-project 1 publishes the contract between layers. This task writes it down so the relay, frontend, and vault plans build against a fixed surface.

**Files:**
- Create: `docs/soroban-interfaces.md`

- [ ] **Step 1: Write the interface doc**

Create `docs/soroban-interfaces.md`:
```markdown
# Soroban inter-layer interfaces (pinned by sub-project 1a)

> Consumed by 1b (token), 1c (vault), 2 (relay), 3 (frontend), 4 (orchestrator).
> Changing anything here is a breaking change across layers.

## Agent account (`agent_account`)
- Constructor: `__constructor(owner: Address, signer: BytesN<32>, scope: AgentScope)`
- `scope_of() -> AgentScope`
- `signer() -> BytesN<32>`
- Implements `CustomAccountInterface::__check_auth(payload, signature: BytesN<64>, contexts)`:
  ed25519 over payload + scope enforcement.

### AgentScope
`{ owner, vault, token, cap_per_period: i128, period_duration: u64,
   spent_in_period: i128, period_start: u64, expiry: u64, revoked: bool }`

### Enforcement contract (what __check_auth allows)
For EVERY auth context the agent signs:
- context MUST be `Context::Contract`
- `contract == scope.vault`
- `fn_name == "deposit"`
- amount = `args[1]` (i128) ; `0 < amount`, cumulative `spent_in_period + amount <= cap_per_period`
- `now < expiry`, `!revoked`
- period rolls when `now >= period_start + period_duration`

## Vault deposit (implemented by 1c — pinned signature)
`deposit(from: Address, amount: i128) -> i128 (shares)`
- fn-name symbol: `deposit`
- `amount` is the 2nd arg (index 1). 1c MUST keep this ordering or 1a cap accounting breaks.

## Registry (`registry`)
- `__constructor(admin: Address)`
- `authorize(owner, agent, vault, token, cap_per_period: i128, period_duration: u64, expiry: u64)` — owner-auth
- `revoke(owner, agent)` — owner-auth, owner must match record
- `record_of(agent) -> AgentRecord`
- `is_revoked(agent) -> bool` (unknown agent ⇒ true, fail-closed)
- Events: `agent_authorized`, `agent_revoked` (force-graph monitor subscribes via RPC getEvents)

## Signer-backend decision (Task 1)
Hand-rolled `__check_auth` chosen over OZ Smart Accounts module (testnet-readiness
unvalidated, spec §9). Revisit when 1b/1c land. Registry + AgentScope stable either way.
```

- [ ] **Step 2: Commit**

```bash
rtk git add docs/soroban-interfaces.md && rtk git commit -m "docs: pin soroban inter-layer interfaces for sub-projects 2/3/4"
```

---

### Task 7: Deploy + seed script → `deployments/stellar-testnet.json`

Mirrors the existing `deployments/base-sepolia.json` workflow so config regeneration after a testnet reset is one command (spec §8: testnet resets ~quarterly).

**Files:**
- Create: `scripts/soroban/deploy-seed.sh`
- Create: `deployments/stellar-testnet.json` (template; script overwrites)

- [ ] **Step 1: Create the deployment-id template**

`deployments/stellar-testnet.json`:
```json
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "",
  "agentAccountWasmHash": "",
  "demoAgentAccount": ""
}
```

- [ ] **Step 2: Write the deploy+seed script**

`scripts/soroban/deploy-seed.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
# Run from WSL: bash scripts/soroban/deploy-seed.sh
# Requires: stellar-cli, a funded testnet identity named "vf-deployer".
NET=testnet
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOROBAN="$ROOT/soroban"
OUT="$ROOT/deployments/stellar-testnet.json"

stellar keys address vf-deployer >/dev/null 2>&1 || \
  stellar keys generate --global vf-deployer --network "$NET" --fund
ADMIN=$(stellar keys address vf-deployer)

( cd "$SOROBAN" && stellar contract build )
WASM_DIR="$SOROBAN/target/wasm32-unknown-unknown/release"
[ -f "$WASM_DIR/registry.wasm" ] || WASM_DIR="$SOROBAN/target/wasm32v1-none/release"

REGISTRY=$(stellar contract deploy \
  --wasm "$WASM_DIR/registry.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN")

ACCT_HASH=$(stellar contract upload \
  --wasm "$WASM_DIR/agent_account.wasm" \
  --source vf-deployer --network "$NET")

# Seed one demo agent account (owner=admin, dummy signer, far-future expiry).
VAULT="$ADMIN"  # placeholder until 1c vault exists; replace post-1c
TOKEN="$ADMIN"
DEMO_AGENT=$(stellar contract deploy \
  --wasm "$WASM_DIR/agent_account.wasm" \
  --source vf-deployer --network "$NET" \
  -- --owner "$ADMIN" \
     --signer "0000000000000000000000000000000000000000000000000000000000000000" \
     --scope "{\"owner\":\"$ADMIN\",\"vault\":\"$VAULT\",\"token\":\"$TOKEN\",\"cap_per_period\":\"1000000000\",\"period_duration\":86400,\"spent_in_period\":\"0\",\"period_start\":0,\"expiry\":4000000000,\"revoked\":false}")

cat > "$OUT" <<JSON
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "$REGISTRY",
  "agentAccountWasmHash": "$ACCT_HASH",
  "demoAgentAccount": "$DEMO_AGENT"
}
JSON
echo "Wrote $OUT"
```
> The `--scope` JSON arg format follows the CLI's struct-as-JSON convention (soroban skill pitfall #15). If the CLI rejects the inline JSON, switch to `--scope-file scope.json`. i128 fields are passed as quoted strings.

- [ ] **Step 3: Dry-run the build path locally (no deploy)**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls target/*/release/*.wasm"
```
Expected: both `registry.wasm` and `agent_account.wasm` listed. (Actual testnet deploy needs a funded key and is run manually by the user — do not auto-run the deploy in CI.)

- [ ] **Step 4: Commit**

```bash
rtk git add scripts/soroban/ deployments/stellar-testnet.json && rtk git commit -m "feat: soroban testnet deploy+seed script"
```

---

### Task 8: Full suite + size + static analysis gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace test suite**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```
Expected: all tests in `agent_account` + `registry` PASS.

- [ ] **Step 2: Confirm both contracts are under the 64KB WASM limit**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls -la target/*/release/*.wasm"
```
Expected: each `.wasm` well under 65536 bytes.

- [ ] **Step 3: Run Scout static analysis**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo install --locked cargo-scout-audit 2>/dev/null; cargo scout-audit"
```
Expected: no critical/high findings. Triage any `overflow-check`/`unsafe-unwrap`/`set-contract-storage` hits — the `.unwrap()` in `record_of`/`scope_of` view fns is acceptable (read-only, caller-controlled), but document it.

- [ ] **Step 4: Final commit if anything changed**

```bash
rtk git add -A && rtk git commit -m "test: soroban 1a suite green + scout clean"
```

---

## Self-Review

**1. Spec coverage (component 1a):**
- Custom account `__check_auth` replacing AgentRegistry+EIP-712 → Tasks 2–4. ✅
- OZ Smart Accounts vs hand-rolled decision → Task 1 (hand-rolled, documented). ✅
- Capped/expiring scope (vault+asset, cap-per-period, expiry, revoked) → Task 4 + `AgentScope`. ✅
- Thin registry for audit/revoke/graph → Task 5. ✅
- Scope schema + deposit signature + event topics pinned as inter-layer contract (spec §7) → Task 6. ✅
- Testnet config regeneration like base-sepolia.json (spec §8) → Task 7. ✅
- TTL/rent on persistent data (spec §8) → `extend_ttl` in Task 4 (account) + Task 5 (registry). ✅
- Out of 1a scope (correctly deferred): RWA token 1b, FOBXX vault 1c, guardrail 1d. Stated in scope boundary.

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to". Every code step shows full code. The two SDK-version caveats (`Hash<32>` → `Bytes` conversion; `try_into_val` naming; ed25519 test-signer helper) are explicit fallback instructions tied to the Task-1 compile gate, not placeholders.

**3. Type consistency:** `AgentScope` fields identical across `types.rs`, tests, `enforce`, and the interface doc. `DEPOSIT_FN`/`"deposit"` symbol consistent between Task 4 enforcement and Task 6 pinned vault signature. Registry `AgentRecord` fields consistent between `types.rs`, logic, and tests. `is_revoked` fail-closed semantics stated in both code and interface doc.

**Known residual risk (flagged, not a gap):** exact `soroban-sdk` 25.x names for `Hash<32>` byte conversion, `Val`→`i128` conversion, and the ed25519 test-signing helper. Mitigation: Task 1 compiles the trait shape first; every code step is followed by a compile/test run that surfaces drift immediately; fallbacks are given inline. This is the spec §9 "verify against live docs at impl time" discipline operationalized as compile gates.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-18-soroban-1a-agent-accounts-registry.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here: Rust/Soroban is new to this repo, and per-task review catches SDK-version drift early.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

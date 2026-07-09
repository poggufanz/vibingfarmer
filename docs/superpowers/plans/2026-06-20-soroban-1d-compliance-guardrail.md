# Soroban Sub-Project 1d — Compliance Guardrail (agent allocation / exposure caps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Local-only doc.** `docs/superpowers/` is gitignored per project rule — do **not** commit this plan.
> **Source spec:** `docs/superpowers/specs/2026-06-20-soroban-1d-compliance-guardrail-design.md` (read all of it: §2 scope C, §2.1 NAV knob, §3 topology, §4 interface + `consume`/`release` logic, §5 vault wiring, §6 drift ceiling, §7 errors, §8 testing). Master spec context: `docs/superpowers/specs/2026-06-18-stellar-soroban-rwafi-migration-design.md` guardrail #4 (lines 105/130/161/179/299).
> **Depends on:** **1a** registry (`record_of`/`AgentRecord`, deployed `CAEHOZGU…NZOQ`, untouched) and **1c** vault (`rwa_vault`, deployed `CBLSGDBY…74ND`, **redeployed** here with the guardrail address). Distinct from 1b T-REX transfer compliance.

**Goal:** Ship a singleton `guardrail` contract on Soroban testnet that enforces three on-chain Aladdin caps on every agent vault deposit — per-agent per-period **spend** cap (from the registry), per-owner×vault absolute **exposure** cap, and per-owner value-weighted **%-allocation** cap (NAV-valued) — reverting any out-of-policy deposit *before* the mint; and wire `rwa_vault` to call it (`consume` on deposit, `release` on redeem). This builds master-spec guardrail #4 and satisfies the acceptance bar: *the guardrail provably reverts an out-of-policy agent trade.*

**Architecture:** New singleton contract `guardrail` in the existing `soroban/` workspace. It reads agent scope from the deployed registry (1a) via `RegistryClient::record_of`, holds the live spend/exposure/position/total-value accounting + an admin-set per-vault NAV knob, and exposes `consume` (deposit gate, three caps, mutates accounting, reverts out-of-policy) and `release` (redeem path, decrements, no checks). Both are **invoker-auth** (`vault.require_auth()`) — only the real vault, calling for itself, can drive them. The vault (1c) is redeployed with a `guardrail: Address` constructor param; `deposit` calls `consume` before the token pull, `redeem` calls `release` after the burn. Spend is keyed by **agent**; exposure/total-value/position by **owner** (the cross-vault portfolio entity). Every check is O(1) — the cross-vault total is maintained incrementally, never recomputed by iteration.

**Tech Stack:** Rust `#![no_std]`, `soroban-sdk = "26.1.0"` (workspace pin), `soroban_sdk::testutils` for unit/integration tests, `registry` crate as a path dependency (for `RegistryClient` + `AgentRecord`), `stellar-cli`, `cargo test`, Soroban testnet (`Test SDF Network ; September 2015`). Toolchain runs under **WSL** (`wsl -e bash -c "cd /mnt/c/... && <cmd>"`) — cargo/stellar-cli are not on the PowerShell path. WASM target is **`wasm32v1-none`** (the 1a/1b/1c builds use `target/wasm32v1-none/release`).

## Global Constraints

- `soroban-sdk = "26.1.0"` (workspace pin; do not bump — would force re-running 1a/1b/1c suites).
- OZ crates pinned `= "0.7.2"` already in `[workspace.dependencies]`; the `guardrail` crate does **not** depend on any OZ crate (it needs only `soroban-sdk` + `registry`). Keep it lean.
- WASM target `wasm32v1-none`; each contract WASM must stay **< 65536 bytes** (`guardrail` is small; the redeployed `rwa_vault` grows by one cross-contract client — re-check it stays under).
- TTL: the guardrail manages its OWN persistent keys (`Policy`/`Spend`/`Position`/`TotalValue`/`Nav`) and instance storage — it must `extend_ttl` on instance and on every persistent key it writes (mirror the 1c `storage.rs` TTL helpers). RWA accounting must not be archived.
- All amounts are 7-dp `i128` (match `mRWA`). NAV default = `10_000_000` (`1e7` = $1.00 at 7 decimals).
- Vault deposit signature stays **pinned by 1a**: `deposit(from: Address, amount: i128) -> i128`, fn-symbol `deposit`, `amount` = args[1]. The guardrail wiring adds an internal sub-call only; it does **not** change the deposit signature.
- `consume`/`release` are **invoker-auth only** (`vault.require_auth()`) — no `from`/agent auth, so an agent `from` authorizes exactly `deposit@vault` (1a-compatible auth tree, per the 1c auth-tree note).
- Network passphrase: `Test SDF Network ; September 2015`. RPC: `https://soroban-testnet.stellar.org`.
- `docs/superpowers/` is gitignored — never commit this plan.

## Scope boundary (read this)

This plan is component **1d only**: the on-chain compliance guardrail (Aladdin caps) + its wiring into the 1c vault, producing an independently testable, deployable contract on testnet. It does **NOT** build the gasless relay (2), the frontend (3), or the off-chain Aladdin engine / autonomous orchestration (4). The off-chain engine *computes* allocations; the guardrail only *enforces* the on-chain ceiling. The de-peg `set_nav` knob is admin-triggered (a controllable demo lever, §2.1), not a live oracle.

**Registry is untouched.** 1a is deployed and immutable here. The guardrail reads it via `RegistryClient`; it never writes to it.

## Planning decisions (spec gaps resolved while writing this plan)

1. **Sole-asset bootstrap exemption (alloc check).** The spec's running-sum %-allocation check (§4.3 step 7) `new_pos_val * 10000 <= max_pct_bps * new_total` makes the **first** deposit into an empty portfolio always 100% of the portfolio — so any `max_pct_bps < 10000` would revert the very first deposit and the portfolio could never bootstrap (the orchestrator deposits into N vaults as N sequential transactions; the first always trips). Resolution: **skip the alloc check when this deposit is the owner's sole asset** — i.e. when `new_pos_val == new_total` (all portfolio value sits in this one position). A single-asset portfolio is trivially 100%; the %-cap can only meaningfully bind once a second vault holds value. The check engages automatically as soon as `new_total > new_pos_val`. This is the minimum change that keeps the cap faithful while letting the product make its first deposit. Carried in code as a `// ponytail:` comment.

2. **De-peg integration scenario direction.** With the running-sum total (§6: `set_nav` does not retro-revalue committed holdings), the demonstrable de-peg is an **upward** NAV move on the target vault: `consume` revalues the *entire* position at the current NAV (`new_pos = pos + amount`, `new_pos_val = new_pos * nav`) while the running total only partly reflects the bump, so the next deposit into that vault trips `AllocCapExceeded`. The integration test (Task 5) uses `set_nav(vault, 2e7)` to flip an in-policy deposit to out-of-policy. This is the faithful behavior of the locked running-sum model and still tells the "NAV broke off $1.00 → crypto boundary reverts the trade" story.

---

## File Structure

One new crate `guardrail` added to the `soroban/` workspace (manifest globs `members = ["contracts/*"]`). The `rwa_vault` crate (1c) is modified (constructor + deposit/redeem + tests). 1a/1b crates are untouched.

```
soroban/
├── Cargo.toml                          # untouched
├── contracts/
│   ├── registry/                       # 1a — untouched (path-dep of guardrail)
│   ├── … (1b T-REX crates)             # untouched
│   ├── rwa_vault/                      # 1c — MODIFIED (guardrail wiring + tests)
│   │   ├── Cargo.toml                  # MODIFY: +guardrail dep, +registry dev-dep
│   │   └── src/
│   │       ├── lib.rs                  # MODIFY: constructor +guardrail param, guardrail() view
│   │       ├── types.rs                # MODIFY: +DataKey::Guardrail
│   │       ├── storage.rs              # MODIFY: +get_guardrail/set_guardrail
│   │       ├── vault.rs                # MODIFY: deposit→consume, redeem→release
│   │       ├── test.rs                 # REPLACE: enroll depositors as scoped agents
│   │       └── integration_test.rs     # MODIFY: deploy guardrail+registry, enroll alice; +Task 5 tests
│   └── guardrail/                      # NEW
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                  # contract struct, __constructor, entrypoints, views
│           ├── types.rs               # Policy, SpendState, DataKey, GuardrailError
│           ├── storage.rs             # typed get/set accessors + TTL helpers
│           ├── guardrail.rs           # set_policy / set_nav / consume / release logic
│           └── test.rs                # unit tests (real registry, generated agents)
deployments/
└── stellar-testnet.json                # MODIFY: add guardrail id; refresh vault id (redeploy)
scripts/soroban/
└── deploy-seed.sh                      # MODIFY: deploy guardrail, redeploy vault w/ guardrail, set_policy
docs/
└── soroban-interfaces.md               # MODIFY: append the guardrail section (consumed by 2/3/4)
```

Responsibility split mirrors 1a/1c: `types.rs` = all `#[contracttype]`/`#[contracterror]` (no logic); `storage.rs` = typed accessors + TTL; `guardrail.rs` = the cap logic; `lib.rs` = contract entry + constructor + entrypoint shims + read views. Each file stays well under 800 lines.

---

### Task 0: Cross-crate client probe (decision gate)

The one unproven primitive for 1d: can a **new** workspace crate import the deployed registry's generated `RegistryClient`, call `record_of(&agent)`, and read `AgentRecord` fields (`owner`, `vault`, `revoked`, `expiry`, `cap_per_period`, `period_duration`) — and does `guardrail → registry` (lib path-dep) build clean with no dependency cycle? Confirm before building everything on it. No production logic (throwaway crate, deleted in Step 3).

**Files:**
- Create (throwaway): `soroban/contracts/_gprobe/{Cargo.toml, src/lib.rs}`

**Interfaces:**
- Produces: confirmation that `registry::RegistryClient::new(e, &addr).record_of(&agent)` resolves cross-crate and its returned `AgentRecord` exposes the named fields by direct access — the exact surface Tasks 1–2 build on.

- [ ] **Step 1: Create the probe crate**

`soroban/contracts/_gprobe/Cargo.toml`:
```toml
[package]
name = "gprobe"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
registry = { path = "../registry" }
```

`soroban/contracts/_gprobe/src/lib.rs`:
```rust
#![no_std]
// Probe: confirm the registry generated client + AgentRecord field surface resolves
// from a sibling crate, and that ledger timestamp reads work for the expiry/period checks.
use soroban_sdk::{Address, Env};
use registry::RegistryClient;

pub fn _surface(e: &Env, registry: Address, agent: Address, vault: Address) -> bool {
    let rec = RegistryClient::new(e, &registry).record_of(&agent);
    let now = e.ledger().timestamp();
    // touch every field consume() will read:
    !rec.revoked
        && now < rec.expiry
        && rec.vault == vault
        && rec.owner != agent
        && rec.cap_per_period >= 0
        && rec.period_duration > 0
}
```

- [ ] **Step 2: Build the probe + confirm 1a/1c still build**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo build -p gprobe && cargo build -p registry -p rwa_vault"
```
Expected: **PASS** — `RegistryClient`, `record_of`, the `AgentRecord` field access, and `e.ledger().timestamp()` all resolve; registry/vault unaffected. If a field name or the client path drifted, read the error and fix — **Tasks 1–2 reuse this exact surface** (single fix-point discipline, same as 1c Task 0). If the build reports a dependency cycle, stop: it means `registry` somehow depends back on `gprobe` (it must not) — the only allowed edge is `guardrail → registry`.

- [ ] **Step 3: Remove the probe**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && rm -rf contracts/_gprobe"
```
(No commit — throwaway.)

---

### Task 1: Scaffold the `guardrail` crate — types, storage, constructor, `set_nav`, `set_policy`, views

Stand up the crate with its storage schema, constructor (admin + registry addr), the admin NAV knob, the owner-gated policy setter, and the read views. No `consume`/`release` yet (Tasks 2–3). Deliverable: "crate builds + constructor stores config + NAV defaults to 1e7 and is admin-gated + `set_policy` is owner-gated and owner-mismatch-rejected."

**Files:**
- Create: `soroban/contracts/guardrail/{Cargo.toml, src/lib.rs, src/types.rs, src/storage.rs, src/guardrail.rs, src/test.rs}`

**Interfaces:**
- Consumes: `registry::{Registry, RegistryClient}` + `AgentRecord` (1a, via path-dep).
- Produces: `Guardrail` with `__constructor(admin: Address, registry: Address)`; `set_nav(vault: Address, nav: i128)` (admin-auth); `set_policy(owner: Address, agent: Address, max_exposure: i128, max_pct_bps: u32)` (owner-auth, owner==record owner); views `nav_of(vault) -> i128`, `policy_of(agent) -> Policy`, `spend_of(agent) -> SpendState`, `total_value_of(agent) -> i128`, `position_of(agent, vault) -> i128`; types `Policy { max_exposure: i128, max_pct_bps: u32 }`, `SpendState { spent_in_period: i128, period_start: u64 }`, `GuardrailError`. Consumed by Tasks 2–6.

- [ ] **Step 1: Create the crate manifest**

`soroban/contracts/guardrail/Cargo.toml`:
```toml
[package]
name = "guardrail"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
registry = { path = "../registry" }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

- [ ] **Step 2: Write the failing scaffold tests**

Create `soroban/contracts/guardrail/src/test.rs`:
```rust
#![cfg(test)]
use crate::{Guardrail, GuardrailClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

const U7: i128 = 10_000_000;
const DEFAULT_NAV: i128 = 10_000_000;

pub(crate) struct Ctx {
    pub guard: GuardrailClient<'static>,
    pub reg: registry::RegistryClient<'static>,
    pub admin: Address,
    pub owner: Address,
    pub agent: Address,
    pub vault: Address,
    pub token: Address,
}

// Deploys a real registry + the guardrail, authorizes `agent` to `vault` with the given
// per-period spend cap. Caller sets a policy afterward as the test needs.
pub(crate) fn setup_with_cap(env: &Env, cap_per_period: i128, period_duration: u64, expiry: u64) -> Ctx {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let agent = Address::generate(env);
    let vault = Address::generate(env);
    let token = Address::generate(env);

    let reg_id = env.register(registry::Registry, (admin.clone(),));
    let reg = registry::RegistryClient::new(env, &reg_id);
    reg.authorize(&owner, &agent, &vault, &token, &cap_per_period, &period_duration, &expiry);

    let guard_id = env.register(Guardrail, (admin.clone(), reg_id.clone()));
    let guard = GuardrailClient::new(env, &guard_id);
    Ctx { guard, reg, admin, owner, agent, vault, token }
}

// Convenience: permissive scope (caps never bind) for tests that exercise a single dimension.
pub(crate) fn setup(env: &Env) -> Ctx {
    setup_with_cap(env, 1_000_000 * U7, 86_400, 4_000_000_000)
}

#[test]
fn test_nav_defaults_then_set_by_admin() {
    let env = Env::default();
    let c = setup(&env);
    assert_eq!(c.guard.nav_of(&c.vault), DEFAULT_NAV); // unset → 1e7
    c.guard.set_nav(&c.vault, &(2 * DEFAULT_NAV));
    assert_eq!(c.guard.nav_of(&c.vault), 2 * DEFAULT_NAV);
}

#[test]
fn test_set_nav_rejects_non_positive() {
    let env = Env::default();
    let c = setup(&env);
    assert!(c.guard.try_set_nav(&c.vault, &0i128).is_err());
    assert!(c.guard.try_set_nav(&c.vault, &(-1i128)).is_err());
}

#[test]
fn test_set_nav_is_admin_gated() {
    let env = Env::default();
    let c = setup(&env);
    env.set_auths(&[]); // no signatures → admin.require_auth() must fail
    assert!(c.guard.try_set_nav(&c.vault, &(2 * DEFAULT_NAV)).is_err());
}

#[test]
fn test_set_policy_owner_gated_and_owner_match() {
    let env = Env::default();
    let c = setup(&env);
    // owner of the agent's record may set the policy
    c.guard.set_policy(&c.owner, &c.agent, &(100 * U7), &5_000u32);
    let p = c.guard.policy_of(&c.agent);
    assert_eq!(p.max_exposure, 100 * U7);
    assert_eq!(p.max_pct_bps, 5_000);
    // a non-owner address is rejected even with auth mocked (owner != record owner)
    let stranger = Address::generate(&env);
    assert!(c.guard.try_set_policy(&stranger, &c.agent, &(100 * U7), &5_000u32).is_err());
}

#[test]
fn test_set_policy_rejects_bad_bps_and_exposure() {
    let env = Env::default();
    let c = setup(&env);
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &(100 * U7), &0u32).is_err());     // bps 0
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &(100 * U7), &10_001u32).is_err()); // bps > 100%
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &0i128, &5_000u32).is_err());        // exposure 0
}
```

- [ ] **Step 3: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail"
```
Expected: FAIL — `Guardrail` not defined.

- [ ] **Step 4: Define the types**

Create `soroban/contracts/guardrail/src/types.rs`:
```rust
use soroban_sdk::{contracterror, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub struct Policy {
    pub max_exposure: i128, // absolute per-(owner,vault) position ceiling, units
    pub max_pct_bps: u32,   // max value-share of any single vault, basis points (<=10000)
}

#[contracttype]
#[derive(Clone)]
pub struct SpendState {
    pub spent_in_period: i128,
    pub period_start: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,                      // set_nav authority (instance)
    Registry,                   // registry contract address (instance)
    Policy(Address),            // agent -> Policy            (persistent)
    Spend(Address),             // agent -> SpendState        (persistent)
    TotalValue(Address),        // owner -> i128 running portfolio value (persistent)
    Position(Address, Address), // (owner, vault) -> i128 units held (persistent)
    Nav(Address),               // vault -> i128 admin-set NAV (persistent)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GuardrailError {
    InvalidAmount = 1,
    Revoked = 2,
    Expired = 3,
    WrongVault = 4,
    PolicyNotSet = 5,
    SpendCapExceeded = 6,
    ExposureCapExceeded = 7,
    AllocCapExceeded = 8,
    MathOverflow = 9,
    NotOwner = 10,
}
```

- [ ] **Step 5: Define the storage accessors + TTL helpers**

Create `soroban/contracts/guardrail/src/storage.rs`:
```rust
use soroban_sdk::{Address, Env};

use crate::types::{DataKey, Policy, SpendState};

pub const DEFAULT_NAV: i128 = 10_000_000; // $1.00 at 7 decimals (stable-NAV money-market default)

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

pub fn extend_instance(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}
fn extend_persistent(e: &Env, key: &DataKey) {
    e.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

pub fn set_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}
pub fn get_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_registry(e: &Env, registry: &Address) {
    e.storage().instance().set(&DataKey::Registry, registry);
}
pub fn get_registry(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Registry).unwrap()
}

pub fn set_policy(e: &Env, agent: &Address, policy: &Policy) {
    let key = DataKey::Policy(agent.clone());
    e.storage().persistent().set(&key, policy);
    extend_persistent(e, &key);
}
pub fn get_policy(e: &Env, agent: &Address) -> Option<Policy> {
    e.storage().persistent().get(&DataKey::Policy(agent.clone()))
}

pub fn set_spend(e: &Env, agent: &Address, spend: &SpendState) {
    let key = DataKey::Spend(agent.clone());
    e.storage().persistent().set(&key, spend);
    extend_persistent(e, &key);
}
pub fn get_spend(e: &Env, agent: &Address) -> SpendState {
    e.storage()
        .persistent()
        .get(&DataKey::Spend(agent.clone()))
        .unwrap_or(SpendState { spent_in_period: 0, period_start: 0 })
}

pub fn set_position(e: &Env, owner: &Address, vault: &Address, v: i128) {
    let key = DataKey::Position(owner.clone(), vault.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_position(e: &Env, owner: &Address, vault: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Position(owner.clone(), vault.clone()))
        .unwrap_or(0)
}

pub fn set_total_value(e: &Env, owner: &Address, v: i128) {
    let key = DataKey::TotalValue(owner.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_total_value(e: &Env, owner: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::TotalValue(owner.clone()))
        .unwrap_or(0)
}

pub fn set_nav(e: &Env, vault: &Address, nav: i128) {
    let key = DataKey::Nav(vault.clone());
    e.storage().persistent().set(&key, &nav);
    extend_persistent(e, &key);
}
pub fn get_nav(e: &Env, vault: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Nav(vault.clone()))
        .unwrap_or(DEFAULT_NAV)
}
```

- [ ] **Step 6: Stub `guardrail.rs` with `set_nav` + `set_policy` (consume/release land in Tasks 2–3)**

Create `soroban/contracts/guardrail/src/guardrail.rs`:
```rust
use soroban_sdk::{Address, Env};
use registry::RegistryClient;

use crate::storage;
use crate::types::{GuardrailError, Policy};

/// Admin-set per-vault NAV knob (the de-peg lever, §2.1). Admin-auth, positive only.
pub fn set_nav(e: &Env, vault: Address, nav: i128) -> Result<(), GuardrailError> {
    storage::get_admin(e).require_auth();
    if nav <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }
    storage::set_nav(e, &vault, nav);
    storage::extend_instance(e);
    Ok(())
}

/// Owner sets each worker agent's Aladdin limits. Owner-auth + owner must equal the
/// agent's record owner in the registry.
pub fn set_policy(
    e: &Env,
    owner: Address,
    agent: Address,
    max_exposure: i128,
    max_pct_bps: u32,
) -> Result<(), GuardrailError> {
    owner.require_auth();
    if max_exposure <= 0 || max_pct_bps == 0 || max_pct_bps > 10_000 {
        return Err(GuardrailError::InvalidAmount);
    }
    let rec_owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
    if rec_owner != owner {
        return Err(GuardrailError::NotOwner);
    }
    storage::set_policy(e, &agent, &Policy { max_exposure, max_pct_bps });
    storage::extend_instance(e);
    Ok(())
}
```

- [ ] **Step 7: Implement the contract entry, constructor, entrypoint shims, views**

Create `soroban/contracts/guardrail/src/lib.rs`:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};
use registry::RegistryClient;

pub mod types;
pub mod storage;
mod guardrail;
mod test;

use types::{GuardrailError, Policy, SpendState};

#[contract]
pub struct Guardrail;

#[contractimpl]
impl Guardrail {
    /// admin = set_nav authority (protocol/issuer); registry = deployed 1a registry address.
    pub fn __constructor(e: &Env, admin: Address, registry: Address) {
        storage::set_admin(e, &admin);
        storage::set_registry(e, &registry);
        storage::extend_instance(e);
    }

    pub fn set_nav(e: &Env, vault: Address, nav: i128) -> Result<(), GuardrailError> {
        guardrail::set_nav(e, vault, nav)
    }

    pub fn set_policy(
        e: &Env,
        owner: Address,
        agent: Address,
        max_exposure: i128,
        max_pct_bps: u32,
    ) -> Result<(), GuardrailError> {
        guardrail::set_policy(e, owner, agent, max_exposure, max_pct_bps)
    }

    // consume + release land in Tasks 2–3.

    // ----- read views -----
    pub fn admin(e: &Env) -> Address {
        storage::get_admin(e)
    }
    pub fn registry(e: &Env) -> Address {
        storage::get_registry(e)
    }
    pub fn nav_of(e: &Env, vault: Address) -> i128 {
        storage::get_nav(e, &vault)
    }
    pub fn policy_of(e: &Env, agent: Address) -> Policy {
        storage::get_policy(e, &agent).unwrap()
    }
    pub fn spend_of(e: &Env, agent: Address) -> SpendState {
        storage::get_spend(e, &agent)
    }
    pub fn total_value_of(e: &Env, agent: Address) -> i128 {
        let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
        storage::get_total_value(e, &owner)
    }
    pub fn position_of(e: &Env, agent: Address, vault: Address) -> i128 {
        let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
        storage::get_position(e, &owner, &vault)
    }
}
```

- [ ] **Step 8: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail"
```
Expected: the 5 Task-1 tests PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add soroban/contracts/guardrail && rtk git commit -m "feat: scaffold compliance guardrail (types, storage, constructor, set_nav, set_policy)"
```

---

### Task 2: `consume` — the three Aladdin caps (spend / exposure / %-allocation)

The headline gate. On each agent deposit, enforce: per-agent per-period spend ≤ registry `cap_per_period`; per-owner×vault position ≤ `max_exposure`; per-owner value-share of the vault ≤ `max_pct_bps` (NAV-valued, sole-asset-exempt). Reverts out-of-policy; commits accounting on success. O(1), no loops, invoker-auth.

**Files:**
- Modify: `soroban/contracts/guardrail/src/guardrail.rs`
- Modify: `soroban/contracts/guardrail/src/lib.rs` (expose `consume`)
- Modify: `soroban/contracts/guardrail/src/test.rs`

**Interfaces:**
- Consumes: `storage::*`, `types::*`, `RegistryClient` (Task 1).
- Produces: `consume(agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError>` (invoker-auth). Consumed by Tasks 4–6.

- [ ] **Step 1: Write the failing `consume` tests**

Append to `soroban/contracts/guardrail/src/test.rs`:
```rust
use soroban_sdk::testutils::Ledger as _;

// ---- spend cap (per-agent, units) ----
#[test]
fn test_spend_cap_passes_at_limit_reverts_over() {
    let env = Env::default();
    let c = setup_with_cap(&env, 100 * U7, 86_400, 4_000_000_000); // cap = 100
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32); // exposure/alloc unbound
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // == cap → ok
    assert_eq!(c.guard.spend_of(&c.agent).spent_in_period, 100 * U7);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // 100 + 1 > cap
}

#[test]
fn test_spend_period_rolls_after_duration() {
    let env = Env::default();
    let c = setup_with_cap(&env, 100 * U7, 100, 4_000_000_000); // period = 100s
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // fills the period
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // still in-period → over cap
    env.ledger().with_mut(|l| l.timestamp += 101); // elapse the period
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // resets → ok again
    assert_eq!(c.guard.spend_of(&c.agent).spent_in_period, 100 * U7);
}

// ---- exposure cap (per-owner x vault, units) ----
#[test]
fn test_exposure_cap_passes_at_limit_reverts_over() {
    let env = Env::default();
    let c = setup(&env); // huge spend cap
    c.guard.set_policy(&c.owner, &c.agent, &(100 * U7), &10_000u32); // max_exposure = 100
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // pos 0→100 == cap → ok
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // 100 + 1 > exposure
}

// ---- %-allocation cap (per-owner, value-weighted) ----
// Two agents, same owner, two vaults. 50% cap. First deposit is sole-asset (exempt),
// the second binds the cap.
#[test]
fn test_alloc_cap_binds_across_two_vaults() {
    let env = Env::default();
    let c = setup(&env); // agent→vaultA already authorized; huge spend cap
    // a second agent for the same owner, scoped to a different vault:
    let agent_b = Address::generate(&env);
    let vault_b = Address::generate(&env);
    c.reg.authorize(&c.owner, &agent_b, &vault_b, &c.token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &5_000u32);  // 50%
    c.guard.set_policy(&c.owner, &agent_b, &(1_000_000 * U7), &5_000u32);

    // sole asset → exempt even though it is 100% of the portfolio:
    c.guard.consume(&c.agent, &c.vault, &(100 * U7));
    // vault_b now 50% exactly → ok:
    c.guard.consume(&agent_b, &vault_b, &(100 * U7));
    assert_eq!(c.guard.position_of(&agent_b, &vault_b), 100 * U7);
    // one more unit into vault_b → 100.0000001 / 200.0000001 > 50% → reverts:
    assert!(c.guard.try_consume(&agent_b, &vault_b, &1i128).is_err());
}

// ---- fail-closed gates ----
#[test]
fn test_consume_reverts_when_revoked() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.reg.revoke(&c.owner, &c.agent);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // Revoked
}

#[test]
fn test_consume_reverts_when_expired() {
    let env = Env::default();
    let c = setup_with_cap(&env, 1_000_000 * U7, 86_400, 50); // expiry = ledger time 50
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    env.ledger().with_mut(|l| l.timestamp = 100); // now >= expiry
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // Expired
}

#[test]
fn test_consume_reverts_on_wrong_vault() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    let other_vault = Address::generate(&env);
    assert!(c.guard.try_consume(&c.agent, &other_vault, &(10 * U7)).is_err()); // WrongVault
}

#[test]
fn test_consume_reverts_when_policy_not_set() {
    let env = Env::default();
    let c = setup(&env); // authorized in registry but NO guardrail policy
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // PolicyNotSet
}

#[test]
fn test_consume_rejects_zero_amount() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &0i128).is_err());
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(-1i128)).is_err());
}

#[test]
fn test_consume_requires_vault_invoker_auth() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    env.set_auths(&[]); // no signatures → vault.require_auth() fails first
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err());
}

#[test]
fn test_consume_overflow_guarded() {
    let env = Env::default();
    let c = setup_with_cap(&env, i128::MAX, 86_400, 4_000_000_000);
    c.guard.set_policy(&c.owner, &c.agent, &i128::MAX, &10_000u32);
    // amount * nav (1e7) overflows i128 in the alloc valuation → MathOverflow, not a panic.
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(i128::MAX / 2)).is_err());
}
```

- [ ] **Step 2: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail test_spend_ test_exposure_ test_alloc_ test_consume_"
```
Expected: FAIL — `consume` not defined.

- [ ] **Step 3: Implement `consume` in `guardrail.rs`**

Append to `soroban/contracts/guardrail/src/guardrail.rs`:
```rust
/// Vault-only deposit gate. Enforces spend (per-agent) + exposure (per-owner,vault) +
/// %-allocation (per-owner, NAV-valued) caps; reverts out-of-policy; commits accounting.
pub fn consume(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
    vault.require_auth(); // invoker-auth: only the real vault, acting for itself
    if amount <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }

    // ---- registry scope (fail-closed: record_of panics on an unknown agent) ----
    let rec = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent);
    let owner = rec.owner;
    if rec.revoked {
        return Err(GuardrailError::Revoked);
    }
    let now = e.ledger().timestamp();
    if now >= rec.expiry {
        return Err(GuardrailError::Expired);
    }
    if rec.vault != vault {
        return Err(GuardrailError::WrongVault);
    }

    let policy = storage::get_policy(e, &agent).ok_or(GuardrailError::PolicyNotSet)?;

    // ---- (1) SPEND cap (per-agent, units) ----
    let mut spend = storage::get_spend(e, &agent);
    if now.saturating_sub(spend.period_start) >= rec.period_duration {
        spend.spent_in_period = 0;
        spend.period_start = now;
    }
    let new_spent = spend
        .spent_in_period
        .checked_add(amount)
        .ok_or(GuardrailError::MathOverflow)?;
    if new_spent > rec.cap_per_period {
        return Err(GuardrailError::SpendCapExceeded);
    }

    // ---- (2) EXPOSURE cap (per-owner x vault, units) ----
    let pos = storage::get_position(e, &owner, &vault);
    let new_pos = pos.checked_add(amount).ok_or(GuardrailError::MathOverflow)?;
    if new_pos > policy.max_exposure {
        return Err(GuardrailError::ExposureCapExceeded);
    }

    // ---- (3) %-ALLOCATION cap (per-owner, value-weighted) ----
    let nav = storage::get_nav(e, &vault);
    let amount_val = amount.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;
    let new_pos_val = new_pos.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;
    let total = storage::get_total_value(e, &owner);
    let new_total = total.checked_add(amount_val).ok_or(GuardrailError::MathOverflow)?;
    // ponytail: sole-asset exemption. A single-asset portfolio is trivially 100%, so the
    // %-cap can only bind once a 2nd vault holds value (new_total > new_pos_val). Without
    // this, any max_pct_bps < 10000 would revert the owner's very first deposit and the
    // portfolio could never bootstrap (orchestrator funds N vaults as N sequential txs).
    if new_pos_val != new_total {
        let lhs = new_pos_val.checked_mul(10_000).ok_or(GuardrailError::MathOverflow)?;
        let rhs = (policy.max_pct_bps as i128)
            .checked_mul(new_total)
            .ok_or(GuardrailError::MathOverflow)?;
        if lhs > rhs {
            return Err(GuardrailError::AllocCapExceeded);
        }
    }

    // ---- commit ----
    storage::set_position(e, &owner, &vault, new_pos);
    storage::set_total_value(e, &owner, new_total);
    spend.spent_in_period = new_spent;
    storage::set_spend(e, &agent, &spend);
    storage::extend_instance(e);
    Ok(())
}
```

- [ ] **Step 4: Expose `consume` on the contract**

Add to `soroban/contracts/guardrail/src/lib.rs` in the `impl Guardrail` block (replace the `// consume + release land in Tasks 2–3.` comment):
```rust
    pub fn consume(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
        guardrail::consume(e, agent, vault, amount)
    }

    // release lands in Task 3.
```

- [ ] **Step 5: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail"
```
Expected: all Task-1 + Task-2 tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add soroban/contracts/guardrail && rtk git commit -m "feat: guardrail consume — spend + exposure + %-alloc caps (sole-asset exempt, fail-closed)"
```

---

### Task 3: `release` — redeem-path accounting decrement

The exit path. No policy checks; decrements the owner's position + running total (saturating at 0). Invoker-auth.

**Files:**
- Modify: `soroban/contracts/guardrail/src/guardrail.rs`
- Modify: `soroban/contracts/guardrail/src/lib.rs` (expose `release`)
- Modify: `soroban/contracts/guardrail/src/test.rs`

**Interfaces:**
- Consumes: `consume` (Task 2), `storage::*`.
- Produces: `release(agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError>` (invoker-auth). Consumed by Tasks 4–6.

- [ ] **Step 1: Write the failing `release` tests**

Append to `soroban/contracts/guardrail/src/test.rs`:
```rust
#[test]
fn test_release_decrements_position_and_total() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(100 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);

    c.guard.release(&c.agent, &c.vault, &(30 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 70 * U7);
    // total_value also drops by 30 * nav → re-deposit of 30 succeeds within the same caps:
    c.guard.consume(&c.agent, &c.vault, &(30 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);
}

#[test]
fn test_release_saturates_at_zero() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(70 * U7));
    c.guard.release(&c.agent, &c.vault, &(1_000 * U7)); // over-release → floors at 0
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 0);
    assert_eq!(c.guard.total_value_of(&c.agent), 0);
}

#[test]
fn test_release_requires_vault_invoker_auth() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(50 * U7));
    env.set_auths(&[]);
    assert!(c.guard.try_release(&c.agent, &c.vault, &(10 * U7)).is_err());
}
```

- [ ] **Step 2: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail test_release_"
```
Expected: FAIL — `release` not defined.

- [ ] **Step 3: Implement `release` in `guardrail.rs`**

Append to `soroban/contracts/guardrail/src/guardrail.rs`:
```rust
/// Vault-only exit path. Decrements the owner's position + running total (saturating at 0).
/// No policy checks — redeems are always allowed.
pub fn release(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
    vault.require_auth();
    if amount <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }
    let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
    let nav = storage::get_nav(e, &vault);
    let amount_val = amount.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;

    let new_pos = (storage::get_position(e, &owner, &vault) - amount).max(0);
    let new_total = (storage::get_total_value(e, &owner) - amount_val).max(0);
    storage::set_position(e, &owner, &vault, new_pos);
    storage::set_total_value(e, &owner, new_total);
    storage::extend_instance(e);
    Ok(())
}
```

- [ ] **Step 4: Expose `release` on the contract**

In `soroban/contracts/guardrail/src/lib.rs`, replace `    // release lands in Task 3.` with:
```rust
    pub fn release(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
        guardrail::release(e, agent, vault, amount)
    }
```

- [ ] **Step 5: Run the full guardrail suite + clippy**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p guardrail && cargo clippy -p guardrail -- -D warnings"
```
Expected: all guardrail tests PASS; clippy clean.

- [ ] **Step 6: Commit**

```bash
rtk git add soroban/contracts/guardrail && rtk git commit -m "feat: guardrail release — redeem-path accounting decrement (saturating)"
```

---

### Task 4: Wire the guardrail into `rwa_vault` (deposit→consume, redeem→release)

Redeploy-ready vault: constructor gains a `guardrail: Address`; `deposit` calls `consume` before the token pull (so an over-cap deposit reverts before any mint); `redeem` calls `release` after the burn. Because enforcement is now **mandatory** on every deposit, the existing 1c vault unit tests must enroll their depositors as registry-scoped agents with a permissive guardrail policy (caps never bind → all existing assertions hold unchanged). This task rewrites `test.rs` wholesale (cleaner than ~30 scattered edits) and patches `integration_test.rs` to keep compiling + passing.

**Files:**
- Modify: `soroban/contracts/rwa_vault/Cargo.toml`
- Modify: `soroban/contracts/rwa_vault/src/types.rs`
- Modify: `soroban/contracts/rwa_vault/src/storage.rs`
- Modify: `soroban/contracts/rwa_vault/src/lib.rs`
- Modify: `soroban/contracts/rwa_vault/src/vault.rs`
- Replace: `soroban/contracts/rwa_vault/src/test.rs`
- Modify: `soroban/contracts/rwa_vault/src/integration_test.rs`

**Interfaces:**
- Consumes: `guardrail::{Guardrail, GuardrailClient}` (Tasks 1–3), `registry::{Registry, RegistryClient}` (tests).
- Produces: `RwaVault::__constructor(admin, token, guardrail, name, symbol)`, `guardrail() -> Address` view, and a `deposit`/`redeem` that enforce the guardrail. Consumed by Tasks 5–6.

- [ ] **Step 1: Add the crate deps**

In `soroban/contracts/rwa_vault/Cargo.toml`, add to `[dependencies]` (after `stellar-macros`):
```toml
guardrail = { path = "../guardrail" }
```
and add to `[dev-dependencies]` (after `ed25519-dalek`):
```toml
registry = { path = "../registry" }
guardrail = { path = "../guardrail" }
```
> `guardrail` is both a runtime dep (deposit/redeem call its client) and used in tests; `registry` is test-only (to authorize agents). Cargo allows a crate in both `[dependencies]` and `[dev-dependencies]`; the dev entry is redundant but harmless — if Cargo warns, drop the `guardrail` line from `[dev-dependencies]` and keep only `registry`.

- [ ] **Step 2: Add the `Guardrail` storage key**

In `soroban/contracts/rwa_vault/src/types.rs`, add a variant to the `DataKey` enum (after `Token,`):
```rust
    Guardrail,        // compliance guardrail contract address (1d)
```

- [ ] **Step 3: Add the guardrail storage accessors**

In `soroban/contracts/rwa_vault/src/storage.rs`, add after the `get_token` fn:
```rust
pub fn set_guardrail(e: &Env, guardrail: &Address) {
    e.storage().instance().set(&DataKey::Guardrail, guardrail);
}
pub fn get_guardrail(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Guardrail).unwrap()
}
```

- [ ] **Step 4: Update the constructor + add the `guardrail()` view**

In `soroban/contracts/rwa_vault/src/lib.rs`:

(a) extend the `use storage::{...}` import to include the new accessors:
```rust
use storage::{
    extend_instance, get_acc, get_drip_epoch, get_guardrail, get_token, get_total_principal,
    set_acc, set_drip_epoch, set_guardrail, set_token, set_total_principal,
};
```

(b) replace the `__constructor` signature + body:
```rust
    /// Deployed once. `token` = the 1b mRWA SEP-41 token; `guardrail` = the 1d compliance
    /// guardrail this vault routes every deposit/redeem through.
    pub fn __constructor(
        e: &Env,
        admin: Address,
        token: Address,
        guardrail: Address,
        name: String,
        symbol: String,
    ) {
        Base::set_metadata(e, 7, name, symbol); // 7 decimals (match mRWA)
        set_token(e, &token);
        set_guardrail(e, &guardrail);
        set_acc(e, 0);
        set_total_principal(e, 0);
        set_drip_epoch(e, 0);
        access_control::set_admin(e, &admin); // powers only_admin (pause/unpause)
        extend_instance(e);
    }
```

(c) add a view next to `token()`:
```rust
    pub fn guardrail(e: &Env) -> Address {
        get_guardrail(e)
    }
```

- [ ] **Step 5: Call `consume` in deposit + `release` in redeem**

In `soroban/contracts/rwa_vault/src/vault.rs`:

(a) add the client import at the top (after the existing `use` lines):
```rust
use guardrail::GuardrailClient;
use crate::storage::get_guardrail;
```

(b) in `deposit`, insert the guardrail call **after** `from.require_auth();` and **before** the `let token = get_token(e);` line:
```rust
    // Compliance guardrail: enforce spend/exposure/%-alloc caps BEFORE any mint. The vault
    // is the invoker, so consume's `vault.require_auth()` is auto-satisfied — no `from`
    // context is added (1a-compatible auth tree). An over-cap deposit reverts here.
    let vault_self = e.current_contract_address();
    GuardrailClient::new(e, &get_guardrail(e)).consume(&from, &vault_self, &amount);
```

(c) in `redeem`, insert the guardrail call **after** `set_total_principal(e, get_total_principal(e) - assets);` and **before** the `let token = get_token(e);` line:
```rust
    // Decrement guardrail accounting on exit (no policy check). Vault is the invoker.
    let vault_self = e.current_contract_address();
    GuardrailClient::new(e, &get_guardrail(e)).release(&from, &vault_self, &shares);
```
> Both calls use `e.current_contract_address()` as the `vault` argument — exactly what `consume`/`release` require for invoker auth and what they compare against `rec.vault`. The existing redeem already computes `let vault = e.current_contract_address();` further down for the token transfer; the new `vault_self` binding is a separate local — that is fine (or reuse it; just keep the names distinct to avoid a shadow warning).

- [ ] **Step 6: Replace `test.rs` (enroll depositors as scoped agents)**

Replace the entire contents of `soroban/contracts/rwa_vault/src/test.rs` with:
```rust
#![cfg(test)]
use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, String};

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals

pub(crate) struct Ctx {
    pub vault: RwaVaultClient<'static>,
    pub admin: Address,
    pub token: Address,
    pub reg: registry::RegistryClient<'static>,
    pub guard: guardrail::GuardrailClient<'static>,
    pub owner: Address,
}

// Deploys a mock mRWA SAC, a real registry, the guardrail, and the vault (wired to the
// guardrail). One shared owner backs every enrolled depositor.
pub(crate) fn setup(env: &Env) -> Ctx {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let reg_id = env.register(registry::Registry, (admin.clone(),));
    let reg = registry::RegistryClient::new(env, &reg_id);
    let guard_id = env.register(guardrail::Guardrail, (admin.clone(), reg_id.clone()));
    let guard = guardrail::GuardrailClient::new(env, &guard_id);

    let vault_id = env.register(
        RwaVault,
        (
            admin.clone(),
            token.clone(),
            guard_id.clone(),
            String::from_str(env, "Vibing Vault mRWA"),
            String::from_str(env, "vfmRWA"),
        ),
    );
    Ctx {
        vault: RwaVaultClient::new(env, &vault_id),
        admin,
        token,
        reg,
        guard,
        owner,
    }
}

// Enrolls `who` as a permissively-scoped agent (caps never bind: 10000 bps = no alloc
// limit, huge exposure + spend), then mints + approves so it can deposit `amount`.
fn fund_and_approve(env: &Env, ctx: &Ctx, who: &Address, amount: i128) {
    let vault_addr = ctx.vault.address.clone();
    ctx.reg.authorize(
        &ctx.owner,
        who,
        &vault_addr,
        &ctx.token,
        &(1_000_000 * U7), // cap_per_period
        &86_400u64,        // period_duration
        &4_000_000_000u64, // expiry
    );
    ctx.guard.set_policy(&ctx.owner, who, &(1_000_000 * U7), &10_000u32);
    StellarAssetClient::new(env, &ctx.token).mint(who, &amount);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(env, &ctx.token).approve(who, &vault_addr, &amount, &exp);
}

// Admin funds itself an mRWA yield treasury and approves the vault to pull it on drip.
// (drip does NOT touch the guardrail, so the admin needs no agent enrollment.)
fn fund_admin_treasury(env: &Env, ctx: &Ctx, amount: i128) {
    StellarAssetClient::new(env, &ctx.token).mint(&ctx.admin, &amount);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(env, &ctx.token).approve(&ctx.admin, &ctx.vault.address, &amount, &exp);
}

#[test]
fn test_constructor_stores_config_and_metadata() {
    let env = Env::default();
    let ctx = setup(&env);
    assert_eq!(ctx.vault.admin(), ctx.admin);
    assert_eq!(ctx.vault.token(), ctx.token);
    assert_eq!(ctx.vault.guardrail(), ctx.guard.address);
    assert_eq!(ctx.vault.decimals(), 7);
    assert_eq!(ctx.vault.total_shares(), 0);
    assert_eq!(ctx.vault.total_principal(), 0);
    assert_eq!(ctx.vault.acc_div_per_share(), 0);
    assert_eq!(ctx.vault.drip_epoch(), 0);
}

#[test]
fn test_pause_is_admin_gated() {
    let env = Env::default();
    let ctx = setup(&env);
    ctx.vault.pause(&ctx.admin);
    env.set_auths(&[]); // admin authorization absent → pause must fail
    let stranger = Address::generate(&env);
    assert!(ctx.vault.try_pause(&stranger).is_err());
}

#[test]
fn test_deposit_mints_shares_one_to_one_and_pulls_assets() {
    let env = Env::default();
    let ctx = setup(&env);
    let vault_addr = ctx.vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);

    let shares = ctx.vault.deposit(&alice, &(500 * U7));
    assert_eq!(shares, 500 * U7); // 1:1, stable NAV
    assert_eq!(ctx.vault.balance(&alice), 500 * U7);
    assert_eq!(ctx.vault.total_shares(), 500 * U7);
    assert_eq!(ctx.vault.total_principal(), 500 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 500 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 500 * U7);
    // guardrail tracked the position too:
    assert_eq!(ctx.guard.position_of(&alice, &vault_addr), 500 * U7);
}

#[test]
fn test_deposit_rejects_zero_and_negative() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    // amount <= 0 is rejected before any guardrail/registry lookup, so no enrollment needed.
    assert!(ctx.vault.try_deposit(&alice, &0i128).is_err());
    assert!(ctx.vault.try_deposit(&alice, &(-1i128)).is_err());
}

#[test]
fn test_redeem_burns_shares_returns_principal_one_to_one() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);
    ctx.vault.deposit(&alice, &(400 * U7));

    let assets = ctx.vault.redeem(&alice, &(150 * U7));
    assert_eq!(assets, 150 * U7); // 1:1
    assert_eq!(ctx.vault.balance(&alice), 250 * U7);
    assert_eq!(ctx.vault.total_principal(), 250 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 750 * U7); // 1000 - 400 + 150
    assert_eq!(ctx.guard.position_of(&alice, &ctx.vault.address), 250 * U7); // release decremented
}

#[test]
fn test_redeem_rejects_over_balance() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    assert!(ctx.vault.try_redeem(&alice, &(101 * U7)).is_err());
}

#[test]
fn test_deposit_blocked_when_paused_redeem_allowed() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    ctx.vault.pause(&ctx.admin);
    assert!(ctx.vault.try_deposit(&alice, &U7).is_err()); // deposit gated (1.0 unit)
    assert_eq!(ctx.vault.redeem(&alice, &(50 * U7)), 50 * U7); // redeem still works
}

#[test]
fn test_drip_distributes_pro_rata_across_holders() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 300 * U7);
    fund_and_approve(&env, &ctx, &bob, 100 * U7);
    ctx.vault.deposit(&alice, &(300 * U7)); // 300 shares
    ctx.vault.deposit(&bob, &(100 * U7)); // 100 shares (total 400)

    fund_admin_treasury(&env, &ctx, 40 * U7);
    ctx.vault.drip(&(40 * U7)); // 40 mRWA over 400 shares => 0.1 per share

    assert_eq!(ctx.vault.claimable(&alice), 30 * U7);
    assert_eq!(ctx.vault.claimable(&bob), 10 * U7);
    assert_eq!(ctx.vault.drip_epoch(), 1);

    let paid = ctx.vault.claim(&alice);
    assert_eq!(paid, 30 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 30 * U7);
    assert_eq!(ctx.vault.claimable(&alice), 0);
    assert_eq!(ctx.vault.claimable(&bob), 10 * U7);
}

#[test]
fn test_nav_stays_stable_after_drip() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    fund_admin_treasury(&env, &ctx, 50 * U7);
    ctx.vault.drip(&(50 * U7));
    let assets = ctx.vault.redeem(&alice, &(100 * U7));
    assert_eq!(assets, 100 * U7); // stable NAV: 1 share -> 1 asset
    assert_eq!(ctx.vault.claimable(&alice), 50 * U7); // yield is a separate claimable dividend
}

#[test]
fn test_deposit_after_drip_does_not_dilute_existing_dividend() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    fund_and_approve(&env, &ctx, &bob, 100 * U7);

    ctx.vault.deposit(&alice, &(100 * U7));
    fund_admin_treasury(&env, &ctx, 10 * U7);
    ctx.vault.drip(&(10 * U7));

    ctx.vault.deposit(&bob, &(100 * U7));
    assert_eq!(ctx.vault.claimable(&alice), 10 * U7);
    assert_eq!(ctx.vault.claimable(&bob), 0);

    fund_admin_treasury(&env, &ctx, 20 * U7);
    ctx.vault.drip(&(20 * U7));
    assert_eq!(ctx.vault.claimable(&alice), 20 * U7);
    assert_eq!(ctx.vault.claimable(&bob), 10 * U7);
}

#[test]
fn test_drip_with_no_shares_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    fund_admin_treasury(&env, &ctx, 10 * U7);
    assert!(ctx.vault.try_drip(&(10 * U7)).is_err()); // no shares => NoShares
}

#[test]
fn test_claim_nothing_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    assert!(ctx.vault.try_claim(&alice).is_err()); // NothingToClaim
}
```

- [ ] **Step 7: Patch `integration_test.rs` so it compiles + passes**

The existing integration tests register the vault with 4 args and use a plain `alice` as depositor. Update them to (a) deploy a registry + guardrail, (b) enroll `alice` (permissively), (c) pass the guardrail to the vault constructor. In `soroban/contracts/rwa_vault/src/integration_test.rs`:

(a) add a helper after `fn mint_mrwa(...)` (before the first `#[test]`):
```rust
/// Deploys a real registry + guardrail and permissively enrolls `agent` scoped to `vault`
/// (caps never bind). Returns the guardrail id to pass into the vault constructor.
fn deploy_guardrail_enrolled(env: &Env, admin: &Address, owner: &Address, agent: &Address, vault: &Address, token: &Address) -> (Address, Address) {
    let reg_id = env.register(registry::Registry, (admin.clone(),));
    registry::RegistryClient::new(env, &reg_id).authorize(
        owner, agent, vault, token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64,
    );
    let guard_id = env.register(guardrail::Guardrail, (admin.clone(), reg_id.clone()));
    guardrail::GuardrailClient::new(env, &guard_id).set_policy(owner, agent, &(1_000_000 * U7), &10_000u32);
    (guard_id, reg_id)
}
```
> The vault id is needed to enroll the agent against the right vault, but the vault id is needed to deploy the vault, which needs the guardrail id — a cycle. Break it: register the vault **first** (its address does not depend on the guardrail at deploy time — the constructor only stores it), capture `vault_id`, then enroll, then proceed. See the rewritten test below.

(b) replace the body of `test_end_to_end_deposit_drip_claim_redeem_with_real_trex_token` from the vault registration onward:
```rust
    // Register the vault with a placeholder, capture its id, enroll alice against it, then
    // the stored guardrail address is live for the deposit/redeem calls below.
    let owner = Address::generate(&env);
    // Deploy registry+guardrail first WITHOUT the vault id by enrolling after we know it.
    let reg_id = env.register(registry::Registry, (t.admin.clone(),));
    let guard_id = env.register(guardrail::Guardrail, (t.admin.clone(), reg_id.clone()));

    let vault_id = env.register(
        RwaVault,
        (
            t.admin.clone(),
            t.token.clone(),
            guard_id.clone(),
            String::from_str(&env, "Vibing Vault mRWA"),
            String::from_str(&env, "vfmRWA"),
        ),
    );
    // Now that we know vault_id, scope alice to it and police her permissively.
    registry::RegistryClient::new(&env, &reg_id).authorize(
        &owner, &alice, &vault_id, &t.token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64,
    );
    guardrail::GuardrailClient::new(&env, &guard_id).set_policy(&owner, &alice, &(1_000_000 * U7), &10_000u32);

    kyc_verify(&env, &t, &vault_id);

    let vault = RwaVaultClient::new(&env, &vault_id);
    let token = TokenClient::new(&env, &t.token);
    // ... (the remaining deposit/drip/claim/redeem assertions are unchanged) ...
```
> Keep everything below `let token = TokenClient::new(...)` exactly as it was. The only change is: registry+guardrail deployed, vault constructor takes `guard_id`, alice authorized+policed against `vault_id`. Remove the `deploy_guardrail_enrolled` helper if you inline as above (it is offered for the second test; use whichever reads cleaner — do not leave an unused fn, clippy will warn).

(c) in `test_deposit_reverts_when_vault_is_not_a_verified_holder`, the vault must still be guardrail-wired and alice enrolled (so the deposit reverts at the **KYC token gate**, not at the guardrail). Apply the same registry+guardrail+enroll+5-arg-constructor change before `let vault = RwaVaultClient::new(...)`. The `assert!(vault.try_deposit(...).is_err())` stays — alice passes `consume` (enrolled, in-policy) then reverts at the unverified-vault token transfer.

- [ ] **Step 8: Run the full vault suite (unit + integration) + clippy**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault && cargo clippy -p rwa_vault -- -D warnings"
```
Expected: every Task-1c test (now guardrail-enrolled) + both integration tests PASS; clippy clean. If `record_of` panics in a deposit test, the depositor was not enrolled — confirm `fund_and_approve` ran for it.

- [ ] **Step 9: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "feat: wire rwa_vault deposit/redeem through the compliance guardrail (consume/release)"
```

---

### Task 5: Full-stack integration — guardrail provably reverts an out-of-policy trade

The acceptance bar (master spec line 299). Extend the real-T-REX integration test with three new cases against the live registry + guardrail + vault + mRWA stack: (1) a deposit within all three caps succeeds end-to-end; (2) each cap dimension reverts an over-cap deposit; (3) the de-peg scenario — a deposit that passes at `nav = 1e7` reverts after `set_nav` shifts the %-allocation.

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/integration_test.rs`

**Interfaces:**
- Consumes: `build_trex`/`kyc_verify`/`mint_mrwa` (existing), `registry`/`guardrail` clients (Task 4).
- Produces: the headline guardrail-enforcement proof (test evidence only).

- [ ] **Step 1: Write the failing guardrail-enforcement tests**

Append to `soroban/contracts/rwa_vault/src/integration_test.rs`:
```rust
use soroban_sdk::testutils::Ledger as _;

// Deploys registry+guardrail, the KYC-verified vault, and an agent scoped to it. Returns
// everything the cap tests need. `cap`/`max_exposure`/`max_pct_bps` parameterize the policy.
struct Wired {
    vault: RwaVaultClient<'static>,
    guard: guardrail::GuardrailClient<'static>,
    agent: Address,
    owner: Address,
    vault_id: Address,
}
fn wire_full(env: &Env, t: &Trex, agent: &Address, cap: i128, max_exposure: i128, max_pct_bps: u32) -> Wired {
    let owner = Address::generate(env);
    let reg_id = env.register(registry::Registry, (t.admin.clone(),));
    let guard_id = env.register(guardrail::Guardrail, (t.admin.clone(), reg_id.clone()));
    let vault_id = env.register(
        RwaVault,
        (
            t.admin.clone(),
            t.token.clone(),
            guard_id.clone(),
            String::from_str(env, "Vibing Vault mRWA"),
            String::from_str(env, "vfmRWA"),
        ),
    );
    kyc_verify(env, t, &vault_id);
    registry::RegistryClient::new(env, &reg_id).authorize(
        &owner, agent, &vault_id, &t.token, &cap, &86_400u64, &4_000_000_000u64,
    );
    guardrail::GuardrailClient::new(env, &guard_id).set_policy(&owner, agent, &max_exposure, &max_pct_bps);
    Wired {
        vault: RwaVaultClient::new(env, &vault_id),
        guard: guardrail::GuardrailClient::new(env, &guard_id),
        agent: agent.clone(),
        owner,
        vault_id,
    }
}

#[test]
fn test_guardrail_within_caps_deposit_succeeds_end_to_end() {
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);
    let w = wire_full(&env, &t, &alice, 1_000 * U7, 1_000 * U7, 10_000); // permissive

    mint_mrwa(&env, &t, &alice, 1_000 * U7);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(&env, &t.token).approve(&alice, &w.vault_id, &(1_000 * U7), &exp);

    assert_eq!(w.vault.deposit(&alice, &(500 * U7)), 500 * U7);
    assert_eq!(w.vault.total_principal(), 500 * U7);
    assert_eq!(w.guard.position_of(&alice, &w.vault_id), 500 * U7);
    let _ = w.owner;
}

#[test]
fn test_guardrail_reverts_over_spend_cap() {
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);
    let w = wire_full(&env, &t, &alice, 100 * U7, 1_000 * U7, 10_000); // spend cap = 100

    mint_mrwa(&env, &t, &alice, 1_000 * U7);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(&env, &t.token).approve(&alice, &w.vault_id, &(1_000 * U7), &exp);

    assert_eq!(w.vault.deposit(&alice, &(100 * U7)), 100 * U7); // at the cap
    assert!(w.vault.try_deposit(&alice, &U7).is_err()); // over spend cap → revert, no mint
    assert_eq!(w.vault.total_principal(), 100 * U7); // unchanged by the reverted deposit
}

#[test]
fn test_guardrail_reverts_over_exposure_cap() {
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);
    let w = wire_full(&env, &t, &alice, 1_000 * U7, 100 * U7, 10_000); // exposure cap = 100

    mint_mrwa(&env, &t, &alice, 1_000 * U7);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(&env, &t.token).approve(&alice, &w.vault_id, &(1_000 * U7), &exp);

    assert_eq!(w.vault.deposit(&alice, &(100 * U7)), 100 * U7);
    assert!(w.vault.try_deposit(&alice, &U7).is_err()); // over exposure cap → revert
}

#[test]
fn test_guardrail_de_peg_set_nav_reverts_now_out_of_policy_deposit() {
    // Two vaults, one owner, 60% cap. Establish a 50/50 portfolio, then an upward NAV move
    // on vault A revalues A's whole position over the cap → the next deposit into A reverts.
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env); // agent for vault A
    let bravo = Address::generate(&env); // agent for vault B
    kyc_verify(&env, &t, &alice);
    kyc_verify(&env, &t, &bravo);

    // Shared owner + registry + guardrail; two KYC-verified vaults A and B.
    let owner = Address::generate(&env);
    let reg_id = env.register(registry::Registry, (t.admin.clone(),));
    let guard_id = env.register(guardrail::Guardrail, (t.admin.clone(), reg_id.clone()));
    let mk_vault = |env: &Env| {
        let id = env.register(
            RwaVault,
            (
                t.admin.clone(),
                t.token.clone(),
                guard_id.clone(),
                String::from_str(env, "Vibing Vault mRWA"),
                String::from_str(env, "vfmRWA"),
            ),
        );
        kyc_verify(env, &t, &id);
        id
    };
    let vault_a = mk_vault(&env);
    let vault_b = mk_vault(&env);

    let reg = registry::RegistryClient::new(&env, &reg_id);
    let guard = guardrail::GuardrailClient::new(&env, &guard_id);
    reg.authorize(&owner, &alice, &vault_a, &t.token, &(10_000 * U7), &86_400u64, &4_000_000_000u64);
    reg.authorize(&owner, &bravo, &vault_b, &t.token, &(10_000 * U7), &86_400u64, &4_000_000_000u64);
    guard.set_policy(&owner, &alice, &(10_000 * U7), &6_000u32); // 60%
    guard.set_policy(&owner, &bravo, &(10_000 * U7), &6_000u32);

    // Fund + approve both agents for both vaults.
    mint_mrwa(&env, &t, &alice, 10_000 * U7);
    mint_mrwa(&env, &t, &bravo, 10_000 * U7);
    let exp = env.ledger().sequence() + 100_000;
    let token = TokenClient::new(&env, &t.token);
    token.approve(&alice, &vault_a, &(10_000 * U7), &exp);
    token.approve(&bravo, &vault_b, &(10_000 * U7), &exp);

    let va = RwaVaultClient::new(&env, &vault_a);
    let vb = RwaVaultClient::new(&env, &vault_b);

    // Establish 100 in A (sole-asset, exempt) and 100 in B (50% — in policy).
    va.deposit(&alice, &(100 * U7));
    vb.deposit(&bravo, &(100 * U7));

    // At nav 1e7 everywhere, a further 20 into A → A = 120/220 ≈ 54.5% < 60% → would pass:
    // prove it by depositing then we keep going via the de-peg instead. Don't commit it here.

    // DE-PEG: admin doubles vault A's NAV. A's full 100-unit position now revalues at 2e7,
    // while the running total only partly reflects it → the next deposit into A trips 60%.
    guard.set_nav(&vault_a, &(2 * U7)); // 2e7 = $2.00 (NAV broke off $1.00)
    assert!(va.try_deposit(&alice, &(1 * U7)).is_err()); // AllocCapExceeded → reverts the trade
}
```
> The de-peg test deposits no further into A before `set_nav`, so the established portfolio is A=100, B=100 (50/50 at 1e7). After `set_nav(A, 2e7)`: a 1-unit deposit into A gives `new_pos_A = 101`, `new_pos_val_A = 101 * 2e7`; the running total is `100*1e7 (A, committed at old nav) + 100*1e7 (B) + 1*2e7 (this deposit)`. `new_pos_val_A * 10000 (= 101*2e7*1e4)` vs `6000 * new_total (= 6000 * (200*1e7 + 2e7))` → `2.02e13` vs `1.212e13` → exceeds → `AllocCapExceeded`. If you change the numbers, recompute both sides.

- [ ] **Step 2: Run them to confirm they fail (then pass after Task 4 is in)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_guardrail_"
```
Expected: PASS — Task 4 already implements `consume`/`release` and the vault wiring, so these new tests exercise the live path. (If you are running this task before Task 4's code is merged, they fail to compile — Tasks 4 and 5 ship together; commit Task 4 first.)

- [ ] **Step 3: Run the entire workspace suite + clippy + size check**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test && cargo clippy --workspace -- -D warnings"
```
Expected: ALL crates' tests PASS (1a + 1b + 1c-now-guarded + 1d); clippy clean across the workspace.

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls -l target/wasm32v1-none/release/guardrail.wasm target/wasm32v1-none/release/rwa_vault.wasm"
```
Expected: both WASMs build and are **< 65536 bytes**. (`guardrail` is tiny; `rwa_vault` grew by one client — confirm it still fits.)

- [ ] **Step 4: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "test: full-stack guardrail enforcement — within-caps pass, each cap reverts, de-peg reverts"
```

---

### Task 6: Deploy — guardrail live, vault redeployed, demo policy set, scripts + manifests updated

Deploy the guardrail (admin + the existing registry addr), **redeploy** the vault with the guardrail address (re-running the 1c KYC dance for the new vault id), set a demo policy, and update `deploy-seed.sh` + `stellar-testnet.json` + `soroban-interfaces.md`. Deploy is run by a human in WSL with the funded `vf-deployer` identity.

**Files:**
- Modify: `scripts/soroban/deploy-seed.sh`
- Modify: `deployments/stellar-testnet.json` (rewritten by the script)
- Modify: `docs/soroban-interfaces.md`

**Interfaces:**
- Consumes: the built `guardrail.wasm` + `rwa_vault.wasm` (Task 5), the deployed registry id from `stellar-testnet.json`.
- Produces: a live guardrail + guardrail-wired vault on testnet; the canonical interface doc for sub-projects 2/3/4.

- [ ] **Step 1: Add the guardrail deploy + vault constructor arg to `deploy-seed.sh`**

In `scripts/soroban/deploy-seed.sh`, insert a guardrail deploy **before** the `# ---- 1c: RWA vault` block (after the 1b token bind, around line 54), so the guardrail address exists when the vault is deployed:
```bash
# ---- 1d: compliance guardrail (Aladdin caps) ----
# Singleton policy + accounting layer over the deployed 1a registry. Admin = deployer
# (the set_nav / de-peg authority). Reads agent scope from the existing registry.
GUARDRAIL=$(stellar contract deploy --wasm "$WASM_DIR/guardrail.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --registry "$REGISTRY")
```

In the vault deploy command (currently lines 90–93), add the `--guardrail` arg:
```bash
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" --guardrail "$GUARDRAIL" \
     --name "Vibing Vault mRWA" --symbol "vfmRWA")
```

- [ ] **Step 2: Set the demo agent's guardrail policy in the script**

After the vault is registered in the IRS + allowlist (after line 106, before the JSON write), add:
```bash
# ---- 1d demo policy: police the existing 1a demo agent for the guardrail ----
# set_policy is owner-gated (owner == the agent's registry-record owner). The 1a deploy
# authorized DEMO_AGENT with ADMIN (vf-deployer) as owner, so ADMIN can set the policy.
# Permissive demo limits: 100k-unit exposure, 50% max per-vault allocation.
#
# NOTE (verify before a LIVE agent deposit, owned by sub-projects 2/4): the demo agent's
# registry record still points at the OLD (1c) vault. set_policy only checks the OWNER, so
# it succeeds regardless — but `consume` checks `rec.vault == vault`, so a live deposit
# through the NEW vault also needs the demo agent RE-AUTHORIZED in the registry to the new
# VAULT address (owner-signed). That re-auth is a 2/4 concern; 1d's proof is the integration
# test. If you want a live demo now, uncomment the re-authorize line below.
# stellar contract invoke --id "$REGISTRY" --source vf-deployer --network "$NET" \
#   -- authorize --owner "$ADMIN" --agent "$DEMO_AGENT" --vault "$VAULT" --token "$TOKEN" \
#      --cap_per_period 1000000000000 --period_duration 86400 --expiry 4000000000
stellar contract invoke --id "$GUARDRAIL" --source vf-deployer --network "$NET" \
  -- set_policy --owner "$ADMIN" --agent "$DEMO_AGENT" \
     --max_exposure 1000000000000 --max_pct_bps 5000
```
> `1000000000000` = `100_000 * 1e7` (100k units at 7 dp). Adjust to taste for the demo; these are deployment knobs, not contract logic.

- [ ] **Step 3: Add the guardrail id to the manifest writer**

In the `python3 <<'PY'` block, add `GUARDRAIL` to the env passthrough line (with the others, ~line 108):
```bash
REGISTRY="$REGISTRY" ACCT_HASH="$ACCT_HASH" DEMO_AGENT="$DEMO_AGENT" \
GUARDRAIL="$GUARDRAIL" \
CTI="$CTI" CLAIM_ISSUER="$CLAIM_ISSUER" IRS="$IRS" VERIFIER="$VERIFIER" \
COMPLIANCE="$COMPLIANCE" ALLOW_MOD="$ALLOW_MOD" TOKEN="$TOKEN" \
VAULT="$VAULT" VAULT_IDENTITY="$VAULT_IDENTITY" OUT="$OUT" \
python3 <<'PY'
```
and add a top-level `guardrail` key in the `out` dict (after `"demoAgentAccount"`):
```python
  "guardrail": os.environ["GUARDRAIL"],
```

- [ ] **Step 4: Run the deploy (WSL, funded `vf-deployer`)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && bash scripts/soroban/deploy-seed.sh"
```
Expected: prints `Wrote .../deployments/stellar-testnet.json`. The script reuses the live 1a registry + 1b stack, deploys the guardrail, redeploys + re-KYCs the vault wired to the guardrail, and sets the demo policy. If `set_policy` reverts with `NotOwner`, the 1a demo agent's record owner is **not** `vf-deployer` — read the actual owner from the 1a deploy and pass it as `--owner` (this is the one deploy-time assumption to verify).

- [ ] **Step 5: Verify the on-chain wiring**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && \
  V=\$(python3 -c \"import json;d=json.load(open('deployments/stellar-testnet.json'));print(d['rwa']['vault'])\") && \
  G=\$(python3 -c \"import json;print(json.load(open('deployments/stellar-testnet.json'))['guardrail'])\") && \
  stellar contract invoke --id \$V --source vf-deployer --network testnet -- guardrail && \
  stellar contract invoke --id \$G --source vf-deployer --network testnet -- nav_of --vault \$V"
```
Expected: the vault's `guardrail` returns the deployed guardrail id `G`; `nav_of` returns `10000000` (default $1.00). This proves the redeployed vault points at the live guardrail.

- [ ] **Step 6: Append the guardrail section to `soroban-interfaces.md`**

Add to `docs/soroban-interfaces.md` (consumed by sub-projects 2/3/4):
```markdown
## Compliance Guardrail (1d) — `guardrail`

Singleton Aladdin-cap enforcer over the 1a registry. Deployed addr in
`deployments/stellar-testnet.json` → `guardrail`. The 1c vault is redeployed with this
address and routes every deposit/redeem through it.

### Entrypoints
- `__constructor(admin: Address, registry: Address)` — admin = set_nav authority; registry = 1a registry addr.
- `set_nav(vault: Address, nav: i128)` — admin-auth. Per-vault NAV (7-dp; default 1e7 = $1.00). The de-peg lever.
- `set_policy(owner, agent, max_exposure: i128, max_pct_bps: u32)` — owner-auth; owner must equal the agent's registry-record owner. `max_pct_bps` ≤ 10000.
- `consume(agent, vault, amount: i128)` — VAULT-ONLY (invoker auth). Enforces spend (per-agent, from registry `cap_per_period`) + exposure (per-owner×vault `max_exposure`) + %-allocation (per-owner, NAV-valued `max_pct_bps`). Reverts out-of-policy BEFORE the mint. Called by `rwa_vault.deposit`.
- `release(agent, vault, amount: i128)` — VAULT-ONLY. Decrements accounting on redeem (no checks). Called by `rwa_vault.redeem`.
- Views: `policy_of(agent)`, `spend_of(agent)`, `total_value_of(agent)`, `position_of(agent, vault)`, `nav_of(vault)`, `admin()`, `registry()`.

### Errors
`InvalidAmount, Revoked, Expired, WrongVault, PolicyNotSet, SpendCapExceeded, ExposureCapExceeded, AllocCapExceeded, MathOverflow, NotOwner`.

### Keying + known simplification
Spend keyed by agent (per-worker rate); exposure/total-value/position keyed by owner (cross-vault portfolio). `total_value` is a running weighted sum: `set_nav` does not retro-revalue holders (no agent iteration) — exact under stable NAV, bounded drift on a mid-life NAV change. The first deposit into an owner's empty portfolio is exempt from the %-alloc check (a sole asset is trivially 100%); the cap binds once a 2nd vault holds value. For sub-projects 2/4: an agent deposit needs the agent (a) authorized in the 1a registry scoped to the CURRENT vault address and (b) policed via `set_policy`; `consume` is invoker-auth, so the agent's signature covers only `deposit@vault`.
```

- [ ] **Step 7: Commit**

```bash
rtk git add scripts/soroban/deploy-seed.sh deployments/stellar-testnet.json docs/soroban-interfaces.md && rtk git commit -m "feat: deploy guardrail + redeploy guarded vault to testnet; interfaces + seed script"
```

---

## Self-Review

**Spec coverage (§-by-§):**
- §2 scope C — three caps: spend (Task 2 step 3, registry `cap_per_period`), exposure (`max_exposure`), %-alloc (`max_pct_bps`). ✓
- §2.1 NAV knob — `set_nav` (Task 1), default 1e7 (`storage::DEFAULT_NAV`/`get_nav`), de-peg demo (Task 5). ✓
- §3 topology — singleton `guardrail`, registry untouched, vault redeployed (Tasks 1/4/6). ✓
- §4.1 state — every `DataKey` (Admin/Registry/Policy/Spend/TotalValue/Position/Nav) in `types.rs`. ✓
- §4.2 entrypoints — `__constructor`/`set_policy`/`set_nav`/`consume`/`release` + all 5 views. ✓
- §4.3 consume logic — steps 1–8 map line-for-line (Task 2 step 3), plus the documented sole-asset exemption. ✓
- §4.4 release logic — Task 3 step 3 (vault auth, derive owner, saturating decrement). ✓
- §5 vault wiring — constructor `guardrail` param, deposit→consume before mint, redeem→release, no double-auth (Task 4 steps 4–5). ✓
- §6 drift ceiling — `// ponytail:` comment on the running-sum exemption (Task 2). ✓
- §7 errors — all 9 spec errors + `NotOwner` in `GuardrailError`. ✓
- §8 testing — every listed unit case (Tasks 1–3) + integration cases incl. de-peg (Task 5). Gates: `cargo test` / `clippy -D warnings` / wasm < 64KB (Task 5 step 3). ✓
- §9 deploy — build, deploy guardrail, redeploy vault, set_policy demo agent, deploy-seed.sh + manifest + re-KYC (Task 6). ✓

**Placeholder scan:** no TBD/TODO/"handle errors"/"similar to" — every code step shows complete code; every command shows expected output. The only deliberately-deferred items are flagged with rationale (demo-agent registry re-scope = 2/4 concern; deploy owner verification). ✓

**Type consistency:** `consume`/`release` signatures `(agent, vault, amount: i128)` identical across guardrail impl (Tasks 2–3), vault calls (Task 4), and tests. `Policy { max_exposure: i128, max_pct_bps: u32 }` and `SpendState { spent_in_period: i128, period_start: u64 }` consistent in types/storage/tests. `RegistryClient::record_of(&agent).owner/.vault/.revoked/.expiry/.cap_per_period/.period_duration` matches the real `AgentRecord` (registry/src/types.rs). Vault constructor 5-arg order `(admin, token, guardrail, name, symbol)` consistent in lib.rs, every `env.register`, and the `--guardrail` deploy flag. ✓

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-20-soroban-1d-compliance-guardrail.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**

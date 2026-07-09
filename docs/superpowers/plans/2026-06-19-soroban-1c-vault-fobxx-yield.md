# Soroban Sub-Project 1c — FOBXX-Faithful RWA Vault (SEP-56 vault + stable-NAV daily-dividend yield) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Local-only doc.** `docs/superpowers/` is gitignored per project rule — do **not** commit this plan.
> **Source spec:** `docs/superpowers/specs/2026-06-18-stellar-soroban-rwafi-migration-design.md` (sub-project 1, component 1c). Read §5 component 3 (vault / RWA-Fi core), the **"Vault standard"** + **"Yield mechanism (LOCKED 2026-06-18)"** ADR rows in §6, **§6.1 (yield-model decision — (b) FOBXX-faithful, with the four "Impl consequences for sub-project 1c" bullets)**, §8 (testnet/TTL), §9 (risks — mock yield source, SAC↔vault interop) before starting.
> **Depends on:** sub-project **1a** (agent accounts + thin registry — pins the vault `deposit` signature, built + testnet-deployed) and **1b** (KYC-gated mRWA T-REX token — built + testnet-deployed; OZ crates already in the `soroban/` workspace). 1c adds one new crate to the same workspace and does **not** modify 1a or 1b code.

**Goal:** Ship a mock, FOBXX/BENJI-faithful, yield-bearing RWA vault (`rwa_vault`) on Soroban testnet: depositors put in `mRWA` (the 1b token) and receive a 1:1 non-transferable vault position at a **stable $1.00 NAV**; yield is realized **FOBXX-style as a daily dividend** — newly funded `mRWA` units distributed **pro-rata** via an O(1) cumulative-dividend-index, claimed on interaction. The vault holds the `deposit(from, amount)` entrypoint the 1a agent account is scoped to authorize, and is itself a KYC-verified `mRWA` holder so the T-REX transfer gate does not block it.

**Architecture:** The vault is **its own contract** in the `soroban/` workspace. It uses the **audited OZ `fungible::Base`** primitive for the position-token ledger (per-holder share balance + total supply + 7-dp metadata) and **hand-rolls only the deposit/redeem + dividend logic** that model (b) requires. The deliberate deviation from the spec's "OZ ERC-4626 vault module" is forced by the **LOCKED** yield model: ERC-4626 accounting *is* share-price growth (model **(a)**, the spec's explicitly-rejected option), which is incompatible with a stable-NAV daily-dividend (model **(b)**). So shares stay 1:1 with deposited principal (NAV ≈ $1.00), and yield rides a **cumulative-dividend-per-share index** (the MasterChef/Synthetix accumulator pattern — O(1) per holder, no iteration, settle-on-interaction) — exactly the "cumulative-dividend-index" §6.1 mandates. All `mRWA` movements go through the confirmed `soroban_sdk::token::TokenClient` (SEP-41). The vault pulls deposits via `transfer_from` (deliberate — see the **Agent-deposit auth-tree consequence** note) and pays dividends/redemptions via `transfer` from its own address (contract self-auth).

**Tech Stack:** Rust `#![no_std]`, `soroban-sdk = "26.1.0"` (workspace pin), **OpenZeppelin Stellar Contracts `0.7.2`** (`stellar-tokens` for `fungible::Base`, `stellar-access` for `AccessControl`, `stellar-contract-utils` for `Pausable`, `stellar-macros` — all already in the workspace from 1b), `soroban_sdk::token::TokenClient` + testutils Stellar Asset Contract for token mocking, `stellar-cli`, `cargo test` + soroban testutils, Soroban testnet (`Test SDF Network ; September 2015`). Toolchain runs under **WSL** (`wsl -e bash -c "cd /mnt/c/... && <cmd>"`) — cargo/stellar-cli are not on the PowerShell path. WASM target is **`wasm32v1-none`** (the 1a/1b builds use `target/wasm32v1-none/release`).

## Global Constraints

- `soroban-sdk = "26.1.0"` (workspace pin; do not bump without re-running the full 1a + 1b suite).
- OZ crates pinned `= "0.7.2"` (already in `[workspace.dependencies]` from 1b). Do not re-add or change versions.
- WASM target `wasm32v1-none`; each contract WASM must stay **< 65536 bytes**.
- TTL: OZ manages temporary + persistent storage TTL for its own items, but **NOT instance** storage, and **NOT our own per-holder persistent keys** — the vault must `extend_ttl` on instance storage and on every `RewardDebt`/`Pending` persistent key it touches (spec §8 rent/archival; RWA position data must not be archived).
- Vault-share decimals = **7** (match `mRWA`; Stellar-native convention). Symbol `vfmRWA`, name `Vibing Vault mRWA`.
- **Yield model is LOCKED to (b)**: stable $1.00 NAV (shares 1:1 with principal) + daily dividend (newly funded `mRWA` units distributed pro-rata). Do **not** implement share-price growth (model (a)) — it is the rejected option.
- Dividend distribution = **claim-on-interaction** via a cumulative-dividend-per-share index (O(1) per holder). No per-holder push loops (unbounded-iteration ban, §6.1).
- The vault MUST be a KYC-verified `mRWA` holder (1b T-REX consequence) or `deposit`/`drip`/`redeem`/`claim` revert at the token move. Registered at deploy time (Task 5) and proved in the integration test (Task 4).
- Vault deposit signature is **pinned by 1a and load-bearing**: `deposit(from: Address, amount: i128) -> i128`, fn-name symbol `deposit`, `amount` is the 2nd arg (index 1). Changing it breaks 1a's agent cap accounting.
- Network passphrase: `Test SDF Network ; September 2015`. RPC: `https://soroban-testnet.stellar.org`.
- `docs/superpowers/` is gitignored — never commit this plan.

## Scope boundary (read this)

This plan is component **1c only**: the FOBXX-faithful vault + yield. It produces an independently testable, deployable vault on testnet. It does **NOT** build the agent allocation/exposure guardrail (1d — Aladdin caps, **distinct** from both the vault and the 1b T-REX transfer compliance), the gasless relay (2), the frontend (3), or the Aladdin/orchestrator yield-orchestration (4). The dividend **drip is admin-triggered** (mock yield source per §9); the autonomous yield cadence/orchestration is sub-project 4.

**Agent-deposit auth-tree consequence (flagged for 2/4, NOT solved here):** 1a's `__check_auth` permits a single `deposit@vault` context. If the vault pulled deposits with `token.transfer(from, vault, amount)` and `from` were a 1a agent account, the nested `from.require_auth()` inside `transfer` would add a `transfer@token` context that 1a rejects. 1c therefore pulls with `token.transfer_from(spender = vault, from, to = vault, amount)` — `transfer_from` requires only the **spender** (vault, self-authorized) auth, adding **no** `from` context, so an agent `from` authorizes exactly `deposit@vault` (1a-compatible). The remaining question — *who grants the allowance the vault spends* (the agent cannot self-`approve` under 1a; the spec's "approve once" implies the **owner** grants it) — is an auth-tree assembly decision owned by sub-projects **2 (relay)** and **4 (orchestrator)**. 1c's own tests use a plain verified holder as `from` (with an allowance set), which fully exercises the vault mechanics.

---

## File Structure

One new crate added to the existing `soroban/` workspace (manifest already globs `members = ["contracts/*"]`). 1a + 1b crates are untouched.

```
soroban/
├── Cargo.toml                          # untouched (OZ deps already present from 1b)
├── contracts/
│   ├── agent_account/                  # 1a — untouched
│   ├── registry/                       # 1a — untouched
│   ├── claim_topics_and_issuers/       # 1b — untouched (dev-dep of 1c integration test)
│   ├── claim_issuer/                   # 1b — untouched (dev-dep)
│   ├── identity/                       # 1b — untouched (dev-dep)
│   ├── identity_registry_storage/      # 1b — untouched (dev-dep)
│   ├── identity_verifier/              # 1b — untouched (dev-dep)
│   ├── compliance/                     # 1b — untouched (dev-dep)
│   ├── compliance_allow/               # 1b — untouched (dev-dep)
│   ├── rwa_token/                      # 1b — untouched (dev-dep)
│   └── rwa_vault/                      # NEW — the FOBXX-faithful vault
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                  # contract struct, __constructor, read views, Pausable/AccessControl
│           ├── types.rs               # DataKey, VaultError, events
│           ├── storage.rs             # typed get/set accessors + TTL helpers
│           ├── vault.rs               # deposit/redeem/drip/claim/claimable + settle (the model-(b) core)
│           ├── test.rs                # unit tests (mock token = testutils SAC)
│           └── integration_test.rs    # full-stack T-REX integration (vault as verified holder)
deployments/
└── stellar-testnet.json                # MODIFY: add the 1c vault ids
scripts/soroban/
└── deploy-seed.sh                      # MODIFY: append the vault deploy + verified-holder registration
docs/
└── soroban-interfaces.md               # MODIFY: append the RWA vault section (consumed by 2/3/4)
```

Responsibility split mirrors 1a: `types.rs` = all `#[contracttype]`/`#[contracterror]`/`#[contractevent]` (no logic); `storage.rs` = typed storage accessors + TTL; `vault.rs` = the deposit/redeem/dividend logic; `lib.rs` = contract entry + constructor + read views + pausable/access wiring. Each file stays well under 800 lines.

**Mock-token note (concrete, not a placeholder):** unit tests (Task 1–3) use the soroban-sdk **testutils Stellar Asset Contract** (`env.register_stellar_asset_contract_v2(admin)` → real SEP-41 token, no KYC) driven by `StellarAssetClient` (mint) + `TokenClient` (transfer/approve/balance). This isolates vault mechanics from the KYC stack. The **real 1b T-REX `mRWA` token** is wired in the Task-4 integration test (no mocks), where the vault-as-verified-holder requirement is proved.

---

### Task 0: Validate the share primitive + lock the model-(b) design decision (decision gate)

The spec §9 "is this still the current best primitive?" gate, operationalized for 1c. The spec ADR names "OZ vault module (SEP-56 / ERC-4626)" but the **LOCKED** yield model (b) is stable-NAV + dividend, which ERC-4626's share-growth accounting cannot represent. This task confirms the audited `fungible::Base` surface compiles in the workspace, inspects whether OZ ships a separable vault module, and records the binding decision. No production logic.

**Files:**
- Create (throwaway, deleted in Step 5): `soroban/contracts/_vprobe/{Cargo.toml, src/lib.rs}`

**Interfaces:**
- Produces: a recorded decision (build shares on `fungible::Base` + cumulative-dividend-index; ERC-4626 vault rejected for model (b)) consumed by Tasks 1–4, and confirmation that `Base::mint`/`Base::burn`/`Base::balance`/`Base::total_supply`/`Base::set_metadata` resolve against `stellar-tokens 0.7.2` (or the corrected paths if they differ).

- [ ] **Step 1: Confirm the OZ + token-client surfaces resolve, and look for a vault module**

Create `soroban/contracts/_vprobe/Cargo.toml`:
```toml
[package]
name = "vault_probe"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
stellar-tokens = { workspace = true }
stellar-access = { workspace = true }
stellar-contract-utils = { workspace = true }
stellar-macros = { workspace = true }
```
Create `soroban/contracts/_vprobe/src/lib.rs`:
```rust
#![no_std]
// Probe: confirm the fungible Base ledger surface + the SEP-41 token client + the
// pausable/access surfaces resolve against the workspace SDK/OZ pins.
use soroban_sdk::token::TokenClient;       // SEP-41 client (transfer/transfer_from/balance/approve)
use stellar_tokens::fungible::Base;        // audited fungible ledger we use for shares
use stellar_access::access_control::AccessControl;
use stellar_contract_utils::pausable::Pausable;

pub fn _types_resolve() {
    let _ = core::marker::PhantomData::<(Base,)>;
    let _ = core::any::type_name::<TokenClient>();
}
```

- [ ] **Step 2: Build the probe + confirm 1a/1b still build**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo build -p vault_probe && cargo build -p rwa_token -p agent_account -p registry"
```
Expected: **PASS** — `Base`, `TokenClient`, `AccessControl`, `Pausable` resolve, and 1a/1b are unaffected. If `Base` or a path drifted in `0.7.2`, read the error and fix the import paths here — **every later task reuses these exact paths** (this is the same single-fix-point discipline as 1a Task 1 / 1b Task 0).

- [ ] **Step 3: Confirm the Base mint/burn/supply helper names**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo doc -p stellar-tokens --no-deps 2>/dev/null; grep -rn 'pub fn mint\|pub fn burn\|pub fn total_supply\|pub fn set_metadata\|pub fn balance' ~/.cargo/registry/src/*/stellar-tokens-0.7.2/src/fungible/ 2>/dev/null | head -40"
```
Expected: the grep lists the `Base` (or `Base`-adjacent `mintable`/`burnable`) function signatures. **Record the exact paths** for: mint, burn, balance, total_supply, set_metadata, decimals, name, symbol. Tasks 1–3 write `Base::mint`/`Base::burn`/etc.; if the audited source puts mint/burn in `stellar_tokens::fungible::{mintable, burnable}` or behind a low-level `Base::update(from, to, amount)`, substitute that exact path everywhere this plan writes `Base::mint`/`Base::burn`. (The OZ fungible example token is the ground truth — `https://github.com/OpenZeppelin/stellar-contracts/tree/main/examples/fungible-token/src`.)

- [ ] **Step 4: Record the binding design decision**

Write this decision into `docs/soroban-interfaces.md` later (Task 6); confirm it now so Tasks 1–4 proceed on a fixed footing:

> **1c vault primitive (decided Task 0):** Yield model **(b)** is LOCKED (stable $1.00 NAV + daily dividend). ERC-4626 / the OZ "vault module" implements model **(a)** (share-price growth) — the spec's explicitly-rejected option — so it is the wrong primitive for 1c. Decision: build the position ledger on the audited **OZ `fungible::Base`** (per-holder balance + total supply + metadata) and hand-roll deposit/redeem (1:1, stable NAV) + a **cumulative-dividend-per-share index** (audited accumulator pattern, O(1) per holder) for yield. This honors the ADR's intent ("reuse the audited primitive") for the ledger while faithfully implementing the LOCKED dividend model. If OZ later ships a vault whose `total_assets` is overridable to principal-only (decoupling share price from the dividend pool), the engineer MAY move deposit/redeem onto it — the dividend-index logic is required either way.

**No action needed to proceed — this step confirms the path.**

- [ ] **Step 5: Remove the probe**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && rm -rf contracts/_vprobe"
```
(No commit — the probe is throwaway and the design decision is committed with Task 6's interface doc. Nothing else changed.)

---

### Task 1: Scaffold the vault crate — types, storage, constructor, read views, pausable

Stand up the `rwa_vault` crate with its storage schema, constructor, the non-transferable position-ledger read surface, and pausable/access wiring. No deposit/yield logic yet (Tasks 2–3). Grouped because these are the contract's skeleton and individually trivial; the deliverable is "crate builds + constructor stores config + metadata is 7-dp + pause is admin-gated."

**Files:**
- Create: `soroban/contracts/rwa_vault/{Cargo.toml, src/lib.rs, src/types.rs, src/storage.rs, src/vault.rs, src/test.rs}`

**Interfaces:**
- Consumes: nothing from earlier 1c tasks.
- Produces: `RwaVault` with `__constructor(admin: Address, token: Address, name: String, symbol: String)`, read views `admin() -> Address`, `token() -> Address`, `decimals() -> u32` (=7), `balance(id: Address) -> i128` (shares), `total_shares() -> i128`, `total_principal() -> i128`, `acc_div_per_share() -> i128`, `drip_epoch() -> u64`, and `Pausable` (`pause`/`unpause`, admin-gated). Consumed by Tasks 2–6.

- [ ] **Step 1: Create the crate manifest**

`soroban/contracts/rwa_vault/Cargo.toml`:
```toml
[package]
name = "rwa_vault"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
stellar-tokens = { workspace = true }
stellar-access = { workspace = true }
stellar-contract-utils = { workspace = true }
stellar-macros = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

- [ ] **Step 2: Write the failing scaffold tests**

Create `soroban/contracts/rwa_vault/src/test.rs`:
```rust
#![cfg(test)]
use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

// Registers the vault against a throwaway testutils Stellar Asset Contract (real SEP-41,
// no KYC) used as the mock mRWA token. Returns (client, admin, token_addr).
pub(crate) fn setup(env: &Env) -> (RwaVaultClient<'static>, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let id = env.register(
        RwaVault,
        (
            admin.clone(),
            token.clone(),
            String::from_str(env, "Vibing Vault mRWA"),
            String::from_str(env, "vfmRWA"),
        ),
    );
    (RwaVaultClient::new(env, &id), admin, token)
}

#[test]
fn test_constructor_stores_config_and_metadata() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    assert_eq!(vault.admin(), admin);
    assert_eq!(vault.token(), token);
    assert_eq!(vault.decimals(), 7);
    assert_eq!(vault.total_shares(), 0);
    assert_eq!(vault.total_principal(), 0);
    assert_eq!(vault.acc_div_per_share(), 0);
    assert_eq!(vault.drip_epoch(), 0);
}

#[test]
fn test_pause_is_admin_gated() {
    let env = Env::default();
    let (vault, admin, _token) = setup(&env);
    // Admin can pause (mock_all_auths covers admin auth).
    vault.pause(&admin);
    // A stranger cannot.
    let stranger = Address::generate(&env);
    assert!(vault.try_pause(&stranger).is_err());
}
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"
```
Expected: FAIL — `RwaVault` not defined.

- [ ] **Step 4: Define the types**

Create `soroban/contracts/rwa_vault/src/types.rs`:
```rust
use soroban_sdk::{contracterror, contractevent, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,            // mRWA token address (SEP-41)
    AccDivPerShare,   // cumulative dividend per share, scaled by SCALE (i128)
    TotalPrincipal,   // sum of deposited assets backing shares 1:1 (i128)
    DripEpoch,        // monotonically increasing dividend epoch (u64)
    RewardDebt(Address), // per-holder accounted dividend baseline (i128)
    Pending(Address),    // per-holder settled-but-unclaimed dividend (i128)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInit = 1,
    InvalidAmount = 2,
    NoShares = 3,            // drip with zero total supply
    InsufficientShares = 4,  // redeem more than held
    MathOverflow = 5,
    NothingToClaim = 6,
}

#[contractevent(topics = ["vault_deposit"])]
pub struct Deposit {
    pub holder: Address,
    pub amount: i128, // assets in
    pub shares: i128, // shares minted (== amount, stable NAV)
}

#[contractevent(topics = ["vault_redeem"])]
pub struct Redeem {
    pub holder: Address,
    pub shares: i128,
    pub assets: i128, // == shares, stable NAV
}

#[contractevent(topics = ["vault_drip"])]
pub struct Drip {
    pub epoch: u64,
    pub amount: i128,            // dividend funded this epoch
    pub acc_div_per_share: i128, // new cumulative index
    pub total_shares: i128,
}

#[contractevent(topics = ["vault_claim"])]
pub struct Claim {
    pub holder: Address,
    pub amount: i128, // mRWA dividend paid out
}
```

- [ ] **Step 5: Define the storage accessors + TTL helpers**

Create `soroban/contracts/rwa_vault/src/storage.rs`:
```rust
use soroban_sdk::{Address, Env};

use crate::types::DataKey;

// Fixed-point scale for the cumulative dividend index. 1e12 keeps precision for
// 7-dp amounts while staying far inside i128 (shares*acc < ~1e28 << i128::MAX).
pub const SCALE: i128 = 1_000_000_000_000;

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

pub fn set_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::Token, token);
}
pub fn get_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Token).unwrap()
}

pub fn set_acc(e: &Env, acc: i128) {
    e.storage().instance().set(&DataKey::AccDivPerShare, &acc);
}
pub fn get_acc(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::AccDivPerShare).unwrap_or(0)
}

pub fn set_total_principal(e: &Env, v: i128) {
    e.storage().instance().set(&DataKey::TotalPrincipal, &v);
}
pub fn get_total_principal(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::TotalPrincipal).unwrap_or(0)
}

pub fn set_drip_epoch(e: &Env, v: u64) {
    e.storage().instance().set(&DataKey::DripEpoch, &v);
}
pub fn get_drip_epoch(e: &Env) -> u64 {
    e.storage().instance().get(&DataKey::DripEpoch).unwrap_or(0)
}

pub fn set_reward_debt(e: &Env, holder: &Address, v: i128) {
    let key = DataKey::RewardDebt(holder.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_reward_debt(e: &Env, holder: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::RewardDebt(holder.clone()))
        .unwrap_or(0)
}

pub fn set_pending(e: &Env, holder: &Address, v: i128) {
    let key = DataKey::Pending(holder.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_pending(e: &Env, holder: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Pending(holder.clone()))
        .unwrap_or(0)
}
```

- [ ] **Step 6: Stub `vault.rs` (filled in Tasks 2–3)**

Create `soroban/contracts/rwa_vault/src/vault.rs`:
```rust
// Deposit / redeem / drip / claim land in Task 2 and Task 3.
// This file is intentionally minimal in Task 1 so the crate compiles.
```

- [ ] **Step 7: Implement the contract entry, constructor, read views, pausable**

Create `soroban/contracts/rwa_vault/src/lib.rs`:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::only_admin;
use stellar_tokens::fungible::Base;

pub mod types;
pub mod storage;
mod vault;
mod test;
mod integration_test;

use storage::{
    extend_instance, get_acc, get_admin, get_drip_epoch, get_token, get_total_principal,
    set_acc, set_admin, set_drip_epoch, set_token, set_total_principal,
};

#[contract]
pub struct RwaVault;

#[contractimpl]
impl RwaVault {
    /// Deployed once. `token` = the 1b mRWA SEP-41 token this vault accepts.
    pub fn __constructor(e: &Env, admin: Address, token: Address, name: String, symbol: String) {
        Base::set_metadata(e, 7, name, symbol); // 7 decimals (match mRWA)
        set_admin(e, &admin);
        set_token(e, &token);
        set_acc(e, 0);
        set_total_principal(e, 0);
        set_drip_epoch(e, 0);
        access_control::set_admin(e, &admin); // powers only_admin (pause/unpause)
        extend_instance(e);
    }

    // ----- read views -----
    pub fn admin(e: &Env) -> Address {
        get_admin(e)
    }
    pub fn token(e: &Env) -> Address {
        get_token(e)
    }
    pub fn decimals(_e: &Env) -> u32 {
        7
    }
    /// Vault-share balance (non-transferable position) of `id`.
    pub fn balance(e: &Env, id: Address) -> i128 {
        Base::balance(e, &id)
    }
    pub fn total_shares(e: &Env) -> i128 {
        Base::total_supply(e)
    }
    pub fn total_principal(e: &Env) -> i128 {
        get_total_principal(e)
    }
    pub fn acc_div_per_share(e: &Env) -> i128 {
        get_acc(e)
    }
    pub fn drip_epoch(e: &Env) -> u64 {
        get_drip_epoch(e)
    }
}

#[contractimpl(contracttrait)]
impl Pausable for RwaVault {
    #[only_admin]
    fn pause(e: &Env, _caller: Address) {
        pausable::pause(e);
    }
    #[only_admin]
    fn unpause(e: &Env, _caller: Address) {
        pausable::unpause(e);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for RwaVault {}
```
> Ground truth for the `Base::set_metadata` / `Base::balance` / `Base::total_supply` names and the `Pausable`/`AccessControl` wiring is the 1b `rwa_token` contract (`soroban/contracts/rwa_token/src/contract.rs`) plus the OZ fungible example — they use the identical pattern. The compile step surfaces any `0.7.2` drift; fix against the Task-0 recorded paths. **Note** the deliberate non-transferability: the vault exposes `balance`/`total_shares` reads but **no** `transfer`/`approve` — positions move only via `deposit`/`redeem`, which keeps the O(1) dividend index sound (settle-on-transfer hooks are intentionally avoided).

- [ ] **Step 8: Stub `integration_test.rs` (filled in Task 4)**

Create `soroban/contracts/rwa_vault/src/integration_test.rs`:
```rust
#![cfg(test)]
// Full-stack T-REX integration lands in Task 4.
```

- [ ] **Step 9: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"
```
Expected: `test_constructor_stores_config_and_metadata` + `test_pause_is_admin_gated` PASS.

- [ ] **Step 10: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "feat: scaffold FOBXX-faithful rwa_vault (types, storage, constructor, pausable)"
```

---

### Task 2: Deposit + redeem — 1:1 principal, stable $1.00 NAV

The deposit/redeem core. Shares mint/burn 1:1 with principal (NAV ≈ $1.00 — the FOBXX-faithful invariant). Deposit pulls `mRWA` via `transfer_from` (the 1a-compatible pull, per the auth-tree note); redeem returns principal via `transfer` from the vault's own address. Deposit is pause-gated; redeem is **not** (holders can always exit).

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/vault.rs`
- Modify: `soroban/contracts/rwa_vault/src/lib.rs` (expose `deposit`/`redeem`)
- Modify: `soroban/contracts/rwa_vault/src/test.rs`

**Interfaces:**
- Consumes: `storage::*`, `types::*` (Task 1).
- Produces: `deposit(from: Address, amount: i128) -> i128` (fn-symbol `deposit`, amount = args[1] — **1a pin**) and `redeem(from: Address, shares: i128) -> i128`. Consumed by Tasks 3–6.

- [ ] **Step 1: Write the failing deposit/redeem tests**

Append to `soroban/contracts/rwa_vault/src/test.rs`:
```rust
use soroban_sdk::token::{StellarAssetClient, TokenClient};

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals

fn fund_and_approve(env: &Env, token: &Address, admin: &Address, who: &Address, vault: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(who, &amount);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(env, token).approve(who, vault, &amount, &exp);
    let _ = admin; // admin is the SAC issuer; kept for signature symmetry
}

#[test]
fn test_deposit_mints_shares_one_to_one_and_pulls_assets() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(1_000 * U7));

    let shares = vault.deposit(&alice, &(500 * U7));
    assert_eq!(shares, 500 * U7);                       // 1:1, stable NAV
    assert_eq!(vault.balance(&alice), 500 * U7);
    assert_eq!(vault.total_shares(), 500 * U7);
    assert_eq!(vault.total_principal(), 500 * U7);
    assert_eq!(TokenClient::new(&env, &token).balance(&vault_addr), 500 * U7);
    assert_eq!(TokenClient::new(&env, &token).balance(&alice), 500 * U7);
}

#[test]
fn test_deposit_rejects_zero_and_negative() {
    let env = Env::default();
    let (vault, _admin, _token) = setup(&env);
    let alice = Address::generate(&env);
    assert!(vault.try_deposit(&alice, &0i128).is_err());
    assert!(vault.try_deposit(&alice, &(-1i128)).is_err());
}

#[test]
fn test_redeem_burns_shares_returns_principal_one_to_one() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(1_000 * U7));
    vault.deposit(&alice, &(400 * U7));

    let assets = vault.redeem(&alice, &(150 * U7));
    assert_eq!(assets, 150 * U7);                       // 1:1
    assert_eq!(vault.balance(&alice), 250 * U7);
    assert_eq!(vault.total_principal(), 250 * U7);
    assert_eq!(TokenClient::new(&env, &token).balance(&alice), 750 * U7); // 1000 - 400 + 150
}

#[test]
fn test_redeem_rejects_over_balance() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(100 * U7));
    vault.deposit(&alice, &(100 * U7));
    assert!(vault.try_redeem(&alice, &(101 * U7)).is_err());
}

#[test]
fn test_deposit_blocked_when_paused_redeem_allowed() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(100 * U7));
    vault.deposit(&alice, &(100 * U7));
    vault.pause(&admin);
    assert!(vault.try_deposit(&alice, &(1 * U7)).is_err()); // deposit gated
    assert_eq!(vault.redeem(&alice, &(50 * U7)), 50 * U7);  // redeem still works
}
```
> `vault.address` is the `Address` field the generated `RwaVaultClient` exposes for the deployed contract id; if the generated accessor is `vault.address` vs a method, the compile step shows it — use the SDK's form (the 1a/1b tests reference the registered id directly via the returned `id`; here the client carries it).

- [ ] **Step 2: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_deposit_ test_redeem_"
```
Expected: FAIL — `deposit`/`redeem` not defined.

- [ ] **Step 3: Implement deposit/redeem in `vault.rs`**

Replace `soroban/contracts/rwa_vault/src/vault.rs`:
```rust
use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, Env};
use stellar_contract_utils::pausable::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{
    extend_instance, get_token, get_total_principal, set_total_principal, SCALE,
};
use crate::types::{Deposit, Redeem, VaultError};

// Re-export of the dividend settle helper (Task 3 fills the body).
use crate::vault::dividend::{settle, sync_debt};

pub mod dividend; // Task 3

/// deposit(from, amount) -> shares. Pinned by 1a: fn-symbol `deposit`, amount = args[1].
/// Stable NAV → shares == amount. Pulls mRWA via transfer_from (vault = spender) so an
/// agent `from` authorizes only the `deposit@vault` context (see plan auth-tree note).
#[when_not_paused]
pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    from.require_auth();

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer_from(&vault, &from, &vault, &amount);

    settle(e, &from); // bank any prior dividend at the old balance
    Base::mint(e, &from, amount); // shares == amount (1:1)
    set_total_principal(e, get_total_principal(e) + amount);
    sync_debt(e, &from); // reset reward debt to the new balance

    extend_instance(e);
    Deposit { holder: from, amount, shares: amount }.publish(e);
    Ok(amount)
}

/// redeem(from, shares) -> assets. Not pause-gated (holders can always exit).
/// Stable NAV → assets == shares. Pays principal via transfer from the vault's own
/// address (contract self-auth); `from` must be a verified mRWA holder to receive.
pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, VaultError> {
    if shares <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    from.require_auth();

    let bal = Base::balance(e, &from);
    if bal < shares {
        return Err(VaultError::InsufficientShares);
    }

    settle(e, &from);
    Base::burn(e, &from, shares);
    let assets = shares; // 1:1
    set_total_principal(e, get_total_principal(e) - assets);
    sync_debt(e, &from);

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&vault, &from, &assets);

    extend_instance(e);
    Redeem { holder: from, shares, assets }.publish(e);
    Ok(assets)
}

// SCALE is referenced by the dividend module; keep the import live.
const _: i128 = SCALE;
```
> `#[when_not_paused]` is the OZ pausable guard macro (`stellar_contract_utils::pausable`); if `0.7.2` names it differently, the 1b token / OZ pausable example is ground truth — substitute the exact macro. `Base::mint`/`Base::burn` per the Task-0 recorded paths (fall back to `Base::update`/`mintable`/`burnable` if needed). `transfer_from(spender = vault, from, to = vault)` consumes `allowance[from][vault]` and requires only the vault's (self) auth — no `from` context is added for the transfer.

- [ ] **Step 4: Create the dividend module skeleton (real body in Task 3)**

Create `soroban/contracts/rwa_vault/src/vault/dividend.rs`:
```rust
use soroban_sdk::{Address, Env};
use stellar_tokens::fungible::Base;

use crate::storage::{get_acc, get_reward_debt, set_reward_debt, SCALE};

/// reward_debt = current_share_balance * acc / SCALE. Called after any balance change.
pub fn sync_debt(e: &Env, holder: &Address) {
    let bal = Base::balance(e, holder);
    let acc = get_acc(e);
    let debt = bal.checked_mul(acc).expect("debt overflow") / SCALE;
    set_reward_debt(e, holder, debt);
}

/// Bank the holder's accrued dividend (at the current balance) into Pending, then
/// realign reward_debt. Must be called BEFORE a balance change. Task 3 expands this
/// with the Pending accumulation; the deposit/redeem path above already calls it.
pub fn settle(e: &Env, holder: &Address) {
    // Task 3 fills the Pending banking. For Task 2 (no drips yet) acc == 0, so
    // settle is a no-op beyond keeping reward_debt consistent.
    let _ = get_reward_debt(e, holder);
    sync_debt(e, holder);
}
```
> `vault.rs` declares `pub mod dividend;`, so this file lives at `src/vault/dividend.rs` (Rust resolves `mod dividend;` inside `vault.rs` to `vault/dividend.rs`). Task 3 replaces `settle` with the full accumulator logic.

- [ ] **Step 5: Expose deposit/redeem on the contract**

Add to the `#[contractimpl] impl RwaVault` block in `soroban/contracts/rwa_vault/src/lib.rs` (after the read views):
```rust
    /// deposit(from, amount) -> shares minted. fn-symbol `deposit`, amount = args[1] (1a pin).
    pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, types::VaultError> {
        vault::deposit(e, from, amount)
    }

    /// redeem(from, shares) -> assets returned (1:1, stable NAV).
    pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, types::VaultError> {
        vault::redeem(e, from, shares)
    }
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"
```
Expected: all Task-1 + Task-2 tests PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "feat: vault deposit/redeem at stable 1:1 NAV (transfer_from pull, pause-gated deposit)"
```

---

### Task 3: FOBXX-faithful yield — cumulative-dividend-index (drip / claim / claimable)

The headline yield mechanic and the §6.1 LOCKED model (b). An admin **drip** (mock yield source) funds `mRWA` into the vault and bumps a **cumulative-dividend-per-share** index; holders accrue pro-rata and **claim on interaction**. O(1) per holder, no iteration. Proves the spec success criterion "Yield accrues and distributes pro-rata."

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/vault/dividend.rs`
- Modify: `soroban/contracts/rwa_vault/src/vault.rs` (add `drip`/`claim`/`claimable`)
- Modify: `soroban/contracts/rwa_vault/src/lib.rs` (expose them)
- Modify: `soroban/contracts/rwa_vault/src/test.rs`

**Interfaces:**
- Consumes: deposit/redeem (Task 2), storage (Task 1).
- Produces: `drip(amount: i128)` (admin-auth), `claim(holder: Address) -> i128` (permissionless, pays the holder), `claimable(holder: Address) -> i128` (view). Consumed by Tasks 4–6.

- [ ] **Step 1: Write the failing yield tests**

Append to `soroban/contracts/rwa_vault/src/test.rs`:
```rust
// Admin funds itself an mRWA yield treasury and approves the vault to pull it on drip.
fn fund_admin_treasury(env: &Env, token: &Address, admin: &Address, vault: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(admin, &amount);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(env, token).approve(admin, vault, &amount, &exp);
}

#[test]
fn test_drip_distributes_pro_rata_across_holders() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(300 * U7));
    fund_and_approve(&env, &token, &admin, &bob, &vault_addr, &(100 * U7));
    vault.deposit(&alice, &(300 * U7)); // 300 shares
    vault.deposit(&bob, &(100 * U7));   // 100 shares  (total 400)

    fund_admin_treasury(&env, &token, &admin, &vault_addr, &(40 * U7));
    vault.drip(&(40 * U7)); // 40 mRWA over 400 shares => 0.1 per share

    assert_eq!(vault.claimable(&alice), 30 * U7); // 300 * 0.1
    assert_eq!(vault.claimable(&bob), 10 * U7);   // 100 * 0.1
    assert_eq!(vault.drip_epoch(), 1);

    let paid = vault.claim(&alice);
    assert_eq!(paid, 30 * U7);
    assert_eq!(TokenClient::new(&env, &token).balance(&alice), 30 * U7); // dividend in mRWA units
    assert_eq!(vault.claimable(&alice), 0);
    assert_eq!(vault.claimable(&bob), 10 * U7); // bob untouched
}

#[test]
fn test_nav_stays_stable_after_drip() {
    // Shares are 1:1 with principal regardless of drips → NAV ≈ $1.00 (model (b)).
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(100 * U7));
    vault.deposit(&alice, &(100 * U7));
    fund_admin_treasury(&env, &token, &admin, &vault_addr, &(50 * U7));
    vault.drip(&(50 * U7));
    // Redeeming all shares returns exactly the principal (not principal + yield):
    let assets = vault.redeem(&alice, &(100 * U7));
    assert_eq!(assets, 100 * U7);            // stable NAV: 1 share -> 1 asset
    assert_eq!(vault.claimable(&alice), 50 * U7); // yield is a separate claimable dividend
}

#[test]
fn test_deposit_after_drip_does_not_dilute_existing_dividend() {
    // settle-on-interaction: a late depositor must not retroactively claim past drips.
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, &(100 * U7));
    fund_and_approve(&env, &token, &admin, &bob, &vault_addr, &(100 * U7));

    vault.deposit(&alice, &(100 * U7)); // 100 shares, only holder
    fund_admin_treasury(&env, &token, &admin, &vault_addr, &(10 * U7));
    vault.drip(&(10 * U7));             // alice entitled to all 10

    vault.deposit(&bob, &(100 * U7));   // bob joins AFTER the drip
    assert_eq!(vault.claimable(&alice), 10 * U7); // alice keeps the full 10
    assert_eq!(vault.claimable(&bob), 0);         // bob gets nothing from the past drip

    fund_admin_treasury(&env, &token, &admin, &vault_addr, &(20 * U7));
    vault.drip(&(20 * U7));             // 20 over 200 shares => 0.1 each
    assert_eq!(vault.claimable(&alice), 20 * U7); // 10 + 10
    assert_eq!(vault.claimable(&bob), 10 * U7);   // 0 + 10
}

#[test]
fn test_drip_with_no_shares_rejected() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    fund_admin_treasury(&env, &token, &admin, &vault_addr, &(10 * U7));
    assert!(vault.try_drip(&(10 * U7)).is_err()); // no shares => NoShares
}

#[test]
fn test_claim_nothing_rejected() {
    let env = Env::default();
    let (vault, _admin, _token) = setup(&env);
    let alice = Address::generate(&env);
    assert!(vault.try_claim(&alice).is_err()); // NothingToClaim
}
```

- [ ] **Step 2: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_drip_ test_nav_ test_deposit_after_ test_claim_"
```
Expected: FAIL — `drip`/`claim`/`claimable` not defined.

- [ ] **Step 3: Implement the full settle accumulator**

Replace `soroban/contracts/rwa_vault/src/vault/dividend.rs`:
```rust
use soroban_sdk::{Address, Env};
use stellar_tokens::fungible::Base;

use crate::storage::{get_acc, get_pending, get_reward_debt, set_pending, set_reward_debt, SCALE};

/// accumulated = share_balance * acc / SCALE  (total dividend this holder is entitled to
/// across all drips at the current balance).
fn accumulated(e: &Env, holder: &Address) -> i128 {
    let bal = Base::balance(e, holder);
    let acc = get_acc(e);
    bal.checked_mul(acc).expect("accumulated overflow") / SCALE
}

/// reward_debt = accumulated at the current balance. Call AFTER a balance change.
pub fn sync_debt(e: &Env, holder: &Address) {
    let debt = accumulated(e, holder);
    set_reward_debt(e, holder, debt);
}

/// Bank the holder's unaccounted gain (accumulated - reward_debt, computed at the
/// CURRENT balance) into Pending, then realign reward_debt. Call BEFORE a balance change.
pub fn settle(e: &Env, holder: &Address) {
    let acc_now = accumulated(e, holder);
    let debt = get_reward_debt(e, holder);
    let gain = acc_now - debt; // >= 0 (acc only grows; balance constant since last sync)
    if gain > 0 {
        let pend = get_pending(e, holder).checked_add(gain).expect("pending overflow");
        set_pending(e, holder, pend);
    }
    set_reward_debt(e, holder, acc_now);
}

/// View: settled Pending + unaccounted gain at the current balance.
pub fn claimable(e: &Env, holder: &Address) -> i128 {
    let acc_now = accumulated(e, holder);
    let debt = get_reward_debt(e, holder);
    get_pending(e, holder) + (acc_now - debt)
}
```

- [ ] **Step 4: Implement drip/claim/claimable in `vault.rs`**

Append to `soroban/contracts/rwa_vault/src/vault.rs`:
```rust
use crate::storage::{get_acc, get_admin, get_drip_epoch, set_acc, set_drip_epoch};
use crate::types::{Claim, Drip};

/// Admin-triggered mock yield source. Pulls `amount` mRWA from the admin treasury into
/// the vault and bumps the cumulative dividend index. Faithful equivalent: the issuer
/// minting daily dividend units (§6.1). Pause-gated.
#[when_not_paused]
pub fn drip(e: &Env, amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    let admin = get_admin(e);
    admin.require_auth();

    let supply = Base::total_supply(e);
    if supply <= 0 {
        return Err(VaultError::NoShares);
    }

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&admin, &vault, &amount); // treasury -> vault

    let add = amount.checked_mul(SCALE).ok_or(VaultError::MathOverflow)? / supply;
    let acc = get_acc(e).checked_add(add).ok_or(VaultError::MathOverflow)?;
    set_acc(e, acc);
    let epoch = get_drip_epoch(e) + 1;
    set_drip_epoch(e, epoch);

    extend_instance(e);
    Drip { epoch, amount, acc_div_per_share: acc, total_shares: supply }.publish(e);
    Ok(())
}

/// Permissionless claim that always pays the holder. Settles, zeroes Pending, transfers
/// the mRWA dividend out (holder must be a verified mRWA holder to receive). Not pause-gated.
pub fn claim(e: &Env, holder: Address) -> Result<i128, VaultError> {
    settle(e, &holder);
    let amount = crate::storage::get_pending(e, &holder);
    if amount <= 0 {
        return Err(VaultError::NothingToClaim);
    }
    crate::storage::set_pending(e, &holder, 0);

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&vault, &holder, &amount);

    extend_instance(e);
    Claim { holder, amount }.publish(e);
    Ok(amount)
}

pub fn claimable(e: &Env, holder: Address) -> i128 {
    dividend::claimable(e, &holder)
}
```

- [ ] **Step 5: Expose drip/claim/claimable on the contract**

Add to the `#[contractimpl] impl RwaVault` block in `lib.rs`:
```rust
    /// Admin-only mock yield source: fund + distribute a dividend pro-rata (FOBXX-faithful).
    pub fn drip(e: &Env, amount: i128) -> Result<(), types::VaultError> {
        vault::drip(e, amount)
    }

    /// Permissionless: pay `holder` their accrued mRWA dividend. Returns amount paid.
    pub fn claim(e: &Env, holder: Address) -> Result<i128, types::VaultError> {
        vault::claim(e, holder)
    }

    /// View: mRWA dividend currently claimable by `holder`.
    pub fn claimable(e: &Env, holder: Address) -> i128 {
        vault::claimable(e, holder)
    }
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"
```
Expected: all Task-1/2/3 tests PASS — especially `test_drip_distributes_pro_rata_across_holders`, `test_nav_stays_stable_after_drip`, and `test_deposit_after_drip_does_not_dilute_existing_dividend` (the settle-on-interaction proof).

- [ ] **Step 7: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "feat: FOBXX-faithful yield via cumulative-dividend-index (drip/claim/claimable)"
```

---

### Task 4: Full-stack T-REX integration test (headline)

Wires the real 1b `mRWA` T-REX token (no mocks) and proves: (1) the vault works end-to-end with a KYC-gated token (deposit → drip → claim → redeem), and (2) the **load-bearing T-REX consequence** — a vault that is **not** a verified `mRWA` holder cannot receive deposits. Mirrors the 1b Task-5 integration approach, reusing the audited claim-signing helpers.

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/integration_test.rs`
- Modify: `soroban/contracts/rwa_vault/Cargo.toml` (dev-deps: the 1b crates by path + `ed25519-dalek`)

**Interfaces:**
- Consumes: every 1b contract crate (`rwa_token`, `identity*`, `claim*`, `compliance*`) + `ed25519-dalek` to sign KYC claims like the OZ `sign-claim` tool.

- [ ] **Step 1: Add the 1b crates as dev-dependencies**

Append to `soroban/contracts/rwa_vault/Cargo.toml`:
```toml
[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
rwa_token = { path = "../rwa_token" }
claim_topics_and_issuers = { path = "../claim_topics_and_issuers" }
claim_issuer = { path = "../claim_issuer" }
identity = { path = "../identity" }
identity_registry_storage = { path = "../identity_registry_storage" }
identity_verifier = { path = "../identity_verifier" }
compliance = { path = "../compliance" }
compliance_allow = { path = "../compliance_allow" }
ed25519-dalek = "2.1.1"
```

- [ ] **Step 2: Write the end-to-end integration test**

Replace `soroban/contracts/rwa_vault/src/integration_test.rs`:
```rust
#![cfg(test)]
use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env, String};

// Builds the full 1b T-REX stack, KYC-verifies `account` (registers identity + signs a
// topic-1 claim from the trusted issuer). Mirrors examples/rwa/token/src/test.rs +
// soroban/contracts/rwa_token/src/integration_test.rs for the Ed25519 claim plumbing —
// COPY those audited helpers (`profiles_id`, `add_signed_kyc_claim`) here; do not hand-roll.
struct Trex {
    token: Address,
    admin: Address,
    irs: Address,
    cti: Address,
    issuer: Address,
    issuer_secret: [u8; 32],
}

fn build_trex(env: &Env) -> Trex {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let cti = env.register(claim_topics_and_issuers::ClaimTopicsAndIssuersContract, (admin.clone(), admin.clone()));
    // issuer_secret is the trusted KYC-backend key (ADR-B1 test double); derive the
    // claim_issuer contract + register it as trusted for topic 1, exactly as 1b does.
    let (issuer, issuer_secret) = crate::integration_test::register_trusted_issuer(env, &cti, &admin);
    let irs = env.register(identity_registry_storage::IdentityRegistryStorageContract, (admin.clone(), admin.clone()));
    let verifier = env.register(identity_verifier::IdentityVerifierContract, (admin.clone(), admin.clone(), irs.clone(), cti.clone()));
    let compliance = env.register(compliance::ComplianceContract, (admin.clone(), admin.clone()));
    let token = env.register(rwa_token::MockRwaToken, (
        String::from_str(env, "Mock RWA"),
        String::from_str(env, "mRWA"),
        admin.clone(), admin.clone(), compliance.clone(), verifier.clone(),
    ));
    // Bind the token to IRS + compliance (1b: required before any mint/transfer, else #363).
    crate::integration_test::bind_token(env, &irs, &compliance, &token, &admin);
    let cti_c = claim_topics_and_issuers::ClaimTopicsAndIssuersContractClient::new(env, &cti);
    cti_c.add_claim_topic(&1u32, &admin);
    Trex { token, admin, irs, cti, issuer, issuer_secret }
}

// Registers `account` as a verified mRWA holder: deploy its identity, add_identity in IRS
// (>=1 country profile), store a signed topic-1 claim. `account` may be a wallet OR a
// contract (e.g. the vault). COPY the audited body from 1b's integration_test helpers.
fn kyc_verify(env: &Env, t: &Trex, account: &Address) {
    let identity = env.register(identity::IdentityContract, (t.admin.clone(),));
    let irs_c = identity_registry_storage::IdentityRegistryStorageContractClient::new(env, &t.irs);
    irs_c.add_identity(account, &identity, &crate::integration_test::profiles_id(env), &t.admin);
    crate::integration_test::add_signed_kyc_claim(env, &identity, &t.issuer, &t.issuer_secret, 1);
    let _ = (&t.cti,); // CTI already trusts the issuer for topic 1
}

fn mint_mrwa(env: &Env, t: &Trex, to: &Address, amount: i128) {
    rwa_token::MockRwaTokenClient::new(env, &t.token).mint(to, &amount, &t.admin);
}

const U7: i128 = 10_000_000;

#[test]
fn test_end_to_end_deposit_drip_claim_redeem_with_real_trex_token() {
    let env = Env::default();
    let t = build_trex(&env);

    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);

    // Deploy the vault, THEN KYC-verify the vault address (load-bearing consequence).
    let vault_id = env.register(RwaVault, (
        t.admin.clone(), t.token.clone(),
        String::from_str(&env, "Vibing Vault mRWA"),
        String::from_str(&env, "vfmRWA"),
    ));
    kyc_verify(&env, &t, &vault_id);

    let vault = RwaVaultClient::new(&env, &vault_id);
    let token = soroban_sdk::token::TokenClient::new(&env, &t.token);

    // Fund + approve alice; deposit.
    mint_mrwa(&env, &t, &alice, &(1_000 * U7));
    let exp = env.ledger().sequence() + 100_000;
    token.approve(&alice, &vault_id, &(1_000 * U7), &exp);
    assert_eq!(vault.deposit(&alice, &(500 * U7)), 500 * U7);
    assert_eq!(vault.total_principal(), 500 * U7);

    // Drip from the admin treasury (admin must be a verified holder too).
    kyc_verify(&env, &t, &t.admin);
    mint_mrwa(&env, &t, &t.admin, &(50 * U7));
    token.approve(&t.admin, &vault_id, &(50 * U7), &exp);
    vault.drip(&(50 * U7)); // 50 over 500 shares => 0.1/share

    assert_eq!(vault.claimable(&alice), 50 * U7);
    assert_eq!(vault.claim(&alice), 50 * U7);
    assert_eq!(token.balance(&alice), 550 * U7); // 1000 - 500 deposited + 50 dividend

    // Redeem principal 1:1 (stable NAV).
    assert_eq!(vault.redeem(&alice, &(500 * U7)), 500 * U7);
    assert_eq!(token.balance(&alice), 1_050 * U7); // principal back; net +50 yield
}

#[test]
fn test_deposit_reverts_when_vault_is_not_a_verified_holder() {
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);

    // Vault deployed but NOT KYC-verified → token transfer to it must fail the T-REX gate.
    let vault_id = env.register(RwaVault, (
        t.admin.clone(), t.token.clone(),
        String::from_str(&env, "Vibing Vault mRWA"),
        String::from_str(&env, "vfmRWA"),
    ));
    let vault = RwaVaultClient::new(&env, &vault_id);
    let token = soroban_sdk::token::TokenClient::new(&env, &t.token);
    mint_mrwa(&env, &t, &alice, &(100 * U7));
    let exp = env.ledger().sequence() + 100_000;
    token.approve(&alice, &vault_id, &(100 * U7), &exp);

    assert!(vault.try_deposit(&alice, &(100 * U7)).is_err()); // vault not verified => reverts
}
```
> The helpers `register_trusted_issuer`, `bind_token`, `profiles_id`, and `add_signed_kyc_claim` are **not invented here** — copy them verbatim from the audited `0.7.2` plumbing in `soroban/contracts/rwa_token/src/integration_test.rs` (built in 1b Task 5) and the OZ example at `https://github.com/OpenZeppelin/stellar-contracts/blob/main/examples/rwa/token/src/test.rs`. They already implement the exact claim-signing flow (Ed25519 over `0x01 || network_id || issuer.to_xdr || identity.to_xdr || topic || nonce || claim_data`). Defining thin wrappers in this module that delegate to the 1b crate's test helpers (or re-pasting them) keeps the crypto audited rather than hand-rolled.

- [ ] **Step 3: Run the integration test**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault integration"
```
Expected: PASS — full deposit/drip/claim/redeem cycle works against the real T-REX token; an unverified vault is rejected at deposit. If a 1b helper API differs, the 1b integration_test file is the ground truth (it compiled green in 1b Task 5).

- [ ] **Step 4: Commit**

```bash
rtk git add soroban/contracts/rwa_vault && rtk git commit -m "test: full T-REX vault integration (deposit/drip/claim/redeem + verified-holder gate)"
```

---

### Task 5: Deploy + seed the vault → `deployments/stellar-testnet.json`

Extends the 1a/1b `scripts/soroban/deploy-seed.sh` with the vault deploy + the load-bearing verified-holder registration, so a testnet reset stays one command (spec §8). Build path stays `wasm32v1-none`.

**Files:**
- Modify: `scripts/soroban/deploy-seed.sh`
- Modify: `deployments/stellar-testnet.json`

- [ ] **Step 1: Extend the deploy-id template**

Add the `vault` block to the `rwa` object in `deployments/stellar-testnet.json` (keep all 1a + 1b keys):
```json
  "rwa": {
    "claimTopicsAndIssuers": "",
    "claimIssuer": "",
    "identityRegistryStorage": "",
    "identityVerifier": "",
    "compliance": "",
    "complianceAllowModule": "",
    "token": "",
    "decimals": 7,
    "vault": "",
    "vaultIdentity": "",
    "vaultShareSymbol": "vfmRWA"
  }
```

- [ ] **Step 2: Append the vault deploy + verified-holder registration to the script**

Append to `scripts/soroban/deploy-seed.sh` (after the 1b block; reuse `vf-deployer`/`$ADMIN`/`$NET`/`$WASM_DIR`/`$TOKEN`/`$IRS`/`$ALLOW_MOD`/`$CLAIM_ISSUER` set by the 1b block):
```bash
# ---- 1c: RWA vault (FOBXX-faithful, stable-NAV daily-dividend) ----
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" \
     --name "Vibing Vault mRWA" --symbol "vfmRWA")

# Load-bearing T-REX consequence: the vault must be a verified mRWA holder or
# deposit/drip/redeem/claim revert at the token move. Register its identity + IRS entry
# + whitelist it in the compliance module.
VAULT_IDENTITY=$(stellar contract deploy --wasm "$WASM_DIR/identity.wasm" \
  --source vf-deployer --network "$NET" -- --owner "$ADMIN")
stellar contract invoke --id "$IRS" --source vf-deployer --network "$NET" \
  -- add_identity --account "$VAULT" --identity "$VAULT_IDENTITY" \
     --initial_profiles '[{"country":360}]' --operator "$ADMIN"
stellar contract invoke --id "$ALLOW_MOD" --source vf-deployer --network "$NET" \
  -- allow_account --account "$VAULT" --operator "$ADMIN"

# The topic-1 KYC claim for the vault identity must be signed by the trusted claim-issuer
# key (off-chain Ed25519) and stored in $VAULT_IDENTITY. This is the SAME off-chain signing
# step 1b deferred for per-investor claims (see docs/soroban-kyc-seam.md). Use the OZ
# sign-claim helper with the issuer secret, then:
#   stellar contract invoke --id "$VAULT_IDENTITY" --source vf-deployer --network "$NET" \
#     -- add_claim --topic 1 --issuer "$CLAIM_ISSUER" --signature <sig> --data <data>
# The Rust integration test (Task 4) is the authoritative proof of the on-chain path.

cat > "$OUT" <<JSON
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "$REGISTRY",
  "agentAccountWasmHash": "$ACCT_HASH",
  "demoAgentAccount": "$DEMO_AGENT",
  "rwa": {
    "claimTopicsAndIssuers": "$CTI",
    "claimIssuer": "$CLAIM_ISSUER",
    "identityRegistryStorage": "$IRS",
    "identityVerifier": "$VERIFIER",
    "compliance": "$COMPLIANCE",
    "complianceAllowModule": "$ALLOW_MOD",
    "token": "$TOKEN",
    "decimals": 7,
    "vault": "$VAULT",
    "vaultIdentity": "$VAULT_IDENTITY",
    "vaultShareSymbol": "vfmRWA"
  }
}
JSON
echo "Wrote $OUT"
```
> Confirm exact `--initial_profiles` JSON + `add_claim` arg names against `stellar contract info --id <c>` if any invoke rejects (the 1b deploy already pins the IRS `add_identity`/profile shape — match it). Per-holder (user/agent) KYC registration is demo-runtime (frontend, sub-project 3), not part of the contract-id seed.

- [ ] **Step 3: Dry-run the build path (no deploy)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls target/wasm32v1-none/release/rwa_vault.wasm"
```
Expected: `rwa_vault.wasm` present alongside the 1a/1b wasms. (Actual testnet deploy needs the funded `vf-deployer` key + the off-chain claim signing and is run manually by the user — do not auto-run deploy.)

- [ ] **Step 4: Commit**

```bash
rtk git add scripts/soroban/deploy-seed.sh deployments/stellar-testnet.json && rtk git commit -m "feat: deploy+register FOBXX vault as verified holder in stellar-testnet config"
```

---

### Task 6: Pin the vault interface for 2/3/4

Spec §7: sub-project 1 publishes the inter-layer contract. 1a/1b wrote `docs/soroban-interfaces.md`; 1c appends the vault surface + the model-(b) yield contract + the agent-deposit auth-tree consequence.

**Files:**
- Modify: `docs/soroban-interfaces.md`

- [ ] **Step 1: Append the RWA vault section**

Add to `docs/soroban-interfaces.md`:
```markdown
## RWA vault (`rwa_vault`, struct `RwaVault`) — pinned by sub-project 1c

- Model: **FOBXX-faithful (spec §6.1 (b), LOCKED)** — stable $1.00 NAV (shares 1:1 with
  principal) + daily dividend (new mRWA units distributed pro-rata). NOT ERC-4626
  share-growth. Position ledger built on OZ `fungible::Base`; yield on a cumulative-
  dividend-per-share index (O(1) per holder, claim-on-interaction).
- Share token: decimals **7**, symbol `vfmRWA`, **non-transferable** (no transfer/approve
  exposed — positions move only via deposit/redeem; keeps the dividend index sound).
- Constructor: `__constructor(admin: Address, token: Address, name: String, symbol: String)`
  where `token` = the 1b mRWA SEP-41 token.
- `deposit(from: Address, amount: i128) -> i128` (shares) — **1a-pinned** fn-symbol
  `deposit`, amount = args[1]. Pause-gated. 1:1 shares. Pulls mRWA via
  `transfer_from(spender = vault, from, to = vault, amount)` (consumes `allowance[from][vault]`).
- `redeem(from: Address, shares: i128) -> i128` (assets) — NOT pause-gated. 1:1 principal.
- `drip(amount: i128)` — admin-only mock yield source; pulls mRWA from the admin treasury
  and bumps the dividend index. Pause-gated. (Autonomous cadence = sub-project 4.)
- `claim(holder: Address) -> i128` — permissionless; pays the holder their accrued mRWA
  dividend. NOT pause-gated.
- `claimable(holder: Address) -> i128` — view.
- Reads: `admin`, `token`, `decimals`(=7), `balance(id)`, `total_shares`, `total_principal`,
  `acc_div_per_share`, `drip_epoch`.
- Events: `vault_deposit`, `vault_redeem`, `vault_drip`, `vault_claim` (force-graph monitor
  subscribes via RPC getEvents).

### CONSEQUENCE — vault is a verified mRWA holder (load-bearing)
The vault holds/moves mRWA, so it MUST be a KYC-verified identity (IRS + topic-1 claim
from a trusted issuer) or whitelisted by a compliance module — registered at deploy time
(Task 5). Otherwise deposit/drip/redeem/claim revert at the token transfer. Holders
(users/agents) and the admin treasury must likewise be verified mRWA holders.

### Agent-deposit auth-tree consequence (for 2/4 — NOT solved in 1c)
1a's `__check_auth` permits a single `deposit@vault` context. The vault deliberately pulls
via `transfer_from` (vault = spender, self-authorized) so a 1a agent `from` authorizes ONLY
`deposit@vault` — no nested `transfer@token` context (which `token.transfer(from,..)` would
add and 1a would reject). The open question — who grants `allowance[*][vault]` (the agent
cannot self-`approve` under 1a; the spec's "approve once" implies the OWNER grants it, and
the beneficial holder/shares question follows) — is an auth-tree assembly decision owned by
sub-project **2 (relay)** + **4 (orchestrator)**. 1c tests use a plain verified holder as
`from` with a pre-set allowance.

### Yield vs principal vs agent caps vs T-REX (do not conflate)
- Vault **principal** (1:1 shares, stable NAV) and vault **dividend** (cumulative index)
  are vault-internal accounting only.
- The **agent allocation/exposure caps** (Aladdin limits) are sub-project **1d** — distinct.
- The **T-REX transfer compliance** (who may hold/transfer mRWA) is sub-project **1b** —
  distinct; the vault is a holder subject to it (see consequence above).
```

- [ ] **Step 2: Commit**

```bash
rtk git add docs/soroban-interfaces.md && rtk git commit -m "docs: pin RWA vault interface + model-(b) yield + agent-deposit auth-tree consequence"
```

---

### Task 7: Full suite + WASM size + static analysis gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace test suite**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```
Expected: all 1a + 1b + 1c tests PASS.

- [ ] **Step 2: Confirm every contract WASM is under 64KB**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls -la target/wasm32v1-none/release/rwa_vault.wasm"
```
Expected: `rwa_vault.wasm` < 65536 bytes (it is far lighter than the T-REX token — fungible ledger + arithmetic only). If it exceeds, confirm the release profile (`opt-level="z"`, `lto=true`, `panic="abort"`, `strip="symbols"`) is inherited from the workspace.

- [ ] **Step 3: Run Scout static analysis**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo install --locked cargo-scout-audit 2>/dev/null; cargo scout-audit"
```
Expected: no critical/high findings in `rwa_vault`. Triage any `overflow-check`/`unsafe-unwrap`/`divide-before-multiply` hits: the dividend index multiplies before dividing (`amount * SCALE / supply`, `bal * acc / SCALE`) by design (precision) and uses `checked_mul`/`checked_add` — confirm Scout sees the checked path. The `.unwrap()` in the read views (`get_admin`/`get_token`) is acceptable (read-only, post-construction). (If `cargo-scout-audit` was blocked in 1a/1b, fall back to `cargo clippy --workspace -- -D warnings`.)

- [ ] **Step 4: Final commit if anything changed**

```bash
rtk git add -A && rtk git commit -m "test: soroban 1c suite green + size + scout gate"
```

---

## Self-Review

**1. Spec coverage (component 1c):**
- Vault / RWA-Fi core: deposits mRWA, mints shares, distributes pro-rata on yield, holds the agent `deposit` entrypoint (spec §5 component 3) → Tasks 1–3 + the 1a-pinned `deposit(from, amount)`. ✅
- "Vault standard = SEP-56/OZ vault module" ADR vs **LOCKED yield (b)** tension → Task 0 decision gate (build on audited `fungible::Base` + cumulative-dividend-index; ERC-4626 share-growth = rejected model (a)), recorded in the interface doc. ✅
- §6.1 impl consequence "built on the OZ vaults primitive for deposit/redeem/accounting, accrual is dividend-based not share-price-based; NAV stable; yield = newly funded units pro-rata" → Task 2 (1:1 stable NAV) + Task 3 (drip funds units, index distributes), `test_nav_stays_stable_after_drip`. ✅
- §6.1 "dividend distribution mechanism: admin/oracle drip on a cadence; lean claim-on-interaction" → Task 3 `drip` (admin) + `claim`/`claimable` (claim-on-interaction). Drip trigger decided = admin-call (mock yield source); autonomous cadence deferred to 4. ✅
- §6.1 "cumulative-dividend-index (O(1) per holder, no iteration) over per-holder push" → Task 3 `dividend.rs` accumulator; `test_deposit_after_drip_does_not_dilute_existing_dividend` proves settle-on-interaction. ✅
- §6.1 + §8 "per-holder dividend accounting (last-claimed / cumulative-per-unit index) must extend_ttl" → `RewardDebt`/`Pending` persistent keys with `extend_persistent` on every write; instance TTL on every op (Global Constraints + storage.rs). ✅
- §6.1 "distinct from agent guardrail (1d) and T-REX transfer compliance (1b)" → interface doc "do not conflate" section; 1d/1b explicitly out of 1c scope. ✅
- 1b T-REX consequence "vault must be a verified mRWA holder" → Task 4 (`test_deposit_reverts_when_vault_is_not_a_verified_holder` + verified happy path) + Task 5 (deploy registers it). ✅
- 1a pin "`deposit(from, amount) -> i128`, amount = args[1]" honored exactly → Task 2 + interface doc; `transfer_from` chosen to keep an agent `from` authorizing only `deposit@vault`. ✅
- Spec success criterion "Yield accrues and distributes pro-rata (test)" → `test_drip_distributes_pro_rata_across_holders`. ✅
- Testnet config regeneration like 1a/1b (spec §8) → Task 5 (deploy-seed extension, `wasm32v1-none`, vault verified-holder registration). ✅
- §9 "SAC ↔ vault interop — confirm authorize flow before transfer" → Task 4 uses the real T-REX token end-to-end (the strongest interop proof); unit tests use the testutils SAC. ✅
- Inter-layer interface published (spec §7) → Task 6. ✅
- Out-of-1c scope correctly deferred: agent caps 1d, relay 2, frontend 3, Aladdin/orchestration 4 (incl. autonomous drip cadence + agent allowance/auth-tree). Stated in Scope boundary + the auth-tree consequence note.

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". Every code step shows full code. The integration-test crypto helpers (`register_trusted_issuer`, `bind_token`, `profiles_id`, `add_signed_kyc_claim`) are explicitly "copy from the audited 1b `rwa_token/src/integration_test.rs` / OZ example" (a concrete artifact that compiled green in 1b Task 5), not invented — the deliberate, safe choice for audited claim-signing, tied to a compile/test gate. Residual OZ/SDK drift (exact `Base::mint`/`burn`/`set_metadata` paths, `when_not_paused` macro name, `RwaVaultClient` id accessor) is handled the 1a/1b way: Task 0 records the exact paths, and every code step is followed by a compile/test run with the OZ example / 1b code named as ground truth. The deploy-script off-chain claim signing is the same documented deferral 1b made for per-investor claims, with the Rust integration test as the authoritative on-chain proof.

**3. Type consistency:** `deposit(from: Address, amount: i128) -> i128` identical across `vault.rs`, `lib.rs`, tests, interface doc, and the 1a pin (amount = args[1]). `redeem(from, shares) -> i128`, `drip(amount)`, `claim(holder) -> i128`, `claimable(holder) -> i128` consistent across `vault.rs`/`lib.rs`/tests/interface doc. `DataKey` variants (`Admin`, `Token`, `AccDivPerShare`, `TotalPrincipal`, `DripEpoch`, `RewardDebt(Address)`, `Pending(Address)`) used identically in `types.rs` + `storage.rs`. `SCALE = 1e12` defined once in `storage.rs`, referenced in `vault.rs`/`dividend.rs`. Decimals = 7 consistent across constructor, `decimals()`, tests, deploy JSON, interface doc. Event structs (`Deposit`/`Redeem`/`Drip`/`Claim`) field names consistent between `types.rs` and the `.publish` call sites. `settle`/`sync_debt`/`accumulated`/`claimable` consistent between `dividend.rs` and `vault.rs`.

**Known residual risk (flagged, not a gap):** (a) exact OZ `0.7.2` fungible API names for `Base::mint`/`burn`/`set_metadata` and the `when_not_paused` macro — mitigated by Task 0 (grep the audited source + record paths) + per-task compile/test + named ground-truth files. (b) the model-(b)-vs-ERC-4626 decision deviates from the spec's literal "OZ vault module" wording — resolved decisively in Task 0 with the LOCK as justification and an upgrade path if OZ later ships an overridable-`total_assets` vault. (c) the agent-deposit auth tree (who grants the vault's allowance) is correctly deferred to 2/4 — 1c proves the vault mechanics with a plain verified `from`, and uses `transfer_from` specifically to keep the future agent integration 1a-compatible.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-soroban-1c-vault-fobxx-yield.md` (local-only; `docs/superpowers/` is gitignored). Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Strong fit: the yield accumulator (Task 3) and the full-stack T-REX integration (Task 4) benefit from per-task compile/test review to catch OZ-`0.7.2` API drift and dividend-math edge cases early.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch execution with checkpoints.

Which approach?

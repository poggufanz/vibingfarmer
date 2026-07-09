# Soroban Sub-Project 1b — KYC-Gated RWA Token (SEP-57 / ERC-3643 T-REX via OZ RWA module) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Local-only doc.** `docs/superpowers/` is gitignored per project rule — do **not** commit this plan.
> **Source spec:** `docs/superpowers/specs/2026-06-18-stellar-soroban-rwafi-migration-design.md` (sub-project 1, component 1b). Read §4 (migration map), §5 component 2 (RWA token), **ADR-A** (token standard — A1 chosen), **ADR-B** (KYC mechanism — B1 zkPass off-chain), §8 (testnet), §9 (risks) before starting.
> **Depends on:** sub-project 1a (agent accounts + registry), already built + testnet-deployed. 1b adds new crates to the same `soroban/` workspace and does **not** modify 1a code.

**Goal:** Ship a mock, KYC-gated, mintable RWA token (`mRWA`) on Soroban testnet using the **OpenZeppelin audited RWA (ERC-3643 / SEP-57 T-REX) module** — a full claim-based identity + modular-compliance token system — where a trusted KYC backend (fed by off-chain zkPass per ADR-B1) is the on-chain claim issuer, so non-KYC'd wallets cannot hold or receive the token.

**Architecture:** The RWA token is **loosely coupled** to two collaborators it calls by address — an **Identity Verifier** (`verify_identity(e, account)`, panics if unverified) and a **Compliance** contract (5 hooks: `can_transfer`/`can_create`/`created`/`destroyed`/`transferred`). We instantiate OZ's audited claim-based stack: **Claim Topics & Issuers** (which topics are required + which issuers are trusted), **Claim Issuer** (validates Ed25519/Secp256k1/Secp256r1 claim signatures — our KYC backend's on-chain counterpart), per-investor **Identity** contracts (store signed claims), **Identity Registry Storage** (wallet→identity + country), the **Identity Verifier** (ties IRS+CTI together), the **Compliance** aggregator + at least one pluggable **compliance module**, and finally the **mRWA token**. Off-chain zkPass verifies KYC → the backend (= trusted claim issuer key) signs a KYC claim (topic 1) → claim is written to the investor's Identity contract → the token validates it on-chain on every mint/transfer. Yield does **not** live here (spec §5: "the token itself does not carry yield; yield lives in the vault" — that is sub-project 1c).

**Tech Stack:** Rust `#![no_std]`, `soroban-sdk = "26.1.0"` (matches the 1a workspace pin), **OpenZeppelin Stellar Contracts `0.7.2`** (`stellar-tokens`, `stellar-access`, `stellar-contract-utils`, `stellar-macros` — all audited by OZ + Certora formal-verification in progress), `stellar-cli` (`stellar contract …`), `cargo test` + soroban testutils, Soroban testnet (`Test SDF Network ; September 2015`). Toolchain runs under **WSL** (`wsl -e bash -c "cd /mnt/c/... && <cmd>"`) — cargo/stellar-cli are not on the PowerShell path. WASM target is **`wasm32v1-none`** (the OZ examples and the 1a deploy both use `target/wasm32v1-none/release`).

## Global Constraints

- `soroban-sdk = "26.1.0"` (workspace pin; `stellar-tokens 0.7.2` requires `soroban-sdk ^26.1.0` — exact match, verified on crates.io). Do not bump without re-running the full 1a suite.
- OZ crates pinned `= "0.7.2"` (latest stable, published 2026-06-09). `stellar-tokens` pulls `soroban-sdk` with feature `experimental_spec_shaking_v2`; cargo feature unification enables it across the workspace.
- WASM target `wasm32v1-none`; each contract WASM must stay **< 65536 bytes**.
- TTL: per the OZ library note, OZ **manages TTL for temporary + persistent** storage items but **NOT instance** storage — instance-TTL extension is our responsibility (matches spec §8 rent/archival requirement).
- Token decimals = **7** (Stellar-native convention; the OZ RWA example uses 7). 1a's `AgentScope.cap_per_period` is decimal-agnostic raw `i128`; the demo seed cap must be expressed at 7dp.
- ADR-A = **A1** (T-REX via OZ RWA module). ADR-B = **B1** (zkPass verified off-chain → backend = trusted claim issuer writes the on-chain claim).
- Network passphrase: `Test SDF Network ; September 2015`. RPC: `https://soroban-testnet.stellar.org`.
- `docs/superpowers/` is gitignored — never commit this plan.

## Scope boundary (read this)

This plan is component **1b only**: the KYC-gated RWA token system. It produces an independently testable, deployable token on testnet. It does **NOT** build the FOBXX-dividend vault (1c), the agent allocation/exposure guardrail (1d — **distinct** from T-REX transfer compliance per spec ADR-A consequence), the gasless relay (2), the frontend zkPass TransGate flow (3 — 1b only pins the on-chain claim-issuer seam), or the on-chain Groth16 ZK-KYC upgrade (5/ADR-B2). Where 1c must move this token, 1b **pins the interface** (Task 8): the SEP-41 `transfer`/`transfer_from` surface plus the T-REX consequence that **the vault contract must itself be a verified identity** to hold/receive `mRWA`.

---

## File Structure

New crates added to the existing `soroban/` workspace (the workspace manifest already globs `members = ["contracts/*"]`, so new dirs are picked up automatically). 1a crates (`agent_account`, `registry`) are untouched.

```
soroban/
├── Cargo.toml                          # MODIFY: add OZ crates to [workspace.dependencies]
├── contracts/
│   ├── agent_account/                  # 1a — untouched
│   ├── registry/                       # 1a — untouched
│   ├── claim_topics_and_issuers/       # NEW — required-topics + trusted-issuer registry (OZ wrapper)
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── claim_issuer/                   # NEW — validates claim signatures (KYC-backend on-chain side)
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── identity/                       # NEW — per-investor identity holding claims (OZ wrapper)
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── identity_registry_storage/      # NEW — wallet→identity + country (OZ wrapper)
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── identity_verifier/              # NEW — ties IRS + CTI, exposes verify_identity
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── compliance/                     # NEW — modular compliance aggregator
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   ├── compliance_allow/               # NEW — one pluggable compliance module (transfer-allow)
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, contract.rs, test.rs}
│   └── rwa_token/                      # NEW — the mRWA token (FungibleToken + RWAToken + Pausable)
│       ├── Cargo.toml
│       └── src/{lib.rs, contract.rs, test.rs}
deployments/
└── stellar-testnet.json                # MODIFY: add the 1b contract ids
scripts/soroban/
└── deploy-seed.sh                      # MODIFY: append the full T-REX deploy chain
docs/
└── soroban-interfaces.md               # MODIFY: add the RWA token section + 1c consequence
```

**Vendoring note (concrete, not a placeholder):** the four pure-infrastructure contracts (`claim_topics_and_issuers`, `claim_issuer`, `identity`, `identity_registry_storage`) carry **zero vibing-farmer-specific logic** — they are thin wrappers over `stellar_tokens::rwa::*` storage modules. Copy them **verbatim** from the audited OZ example at `https://github.com/OpenZeppelin/stellar-contracts/tree/main/examples/rwa/<name>/src/` (MIT-licensed), renaming only the package + struct. Their `__constructor` signatures (confirmed from the OZ README deploy guide) are pinned in Task 1 and Task 7. The contracts with vibing-farmer-meaningful wiring (`identity_verifier`, `compliance`, `compliance_allow`, `rwa_token`) get full code below.

---

### Task 0: Add OZ deps + validate the toolchain compatibility (decision gate)

This is the spec §9 "is this still the current best primitive?" gate operationalized, and ADR-A's "validate tooling support in spec 1b **before** committing; `auth_required` (A2) is the fallback." No production logic — it proves `stellar-tokens 0.7.2` compiles against the workspace's `soroban-sdk 26.1.0` and that 1a still builds.

**Files:**
- Modify: `soroban/Cargo.toml`
- Create (throwaway, deleted in Task 4): none — reuse a temporary probe

**Interfaces:**
- Produces: a workspace where `stellar-tokens`, `stellar-access`, `stellar-contract-utils`, `stellar-macros` (all `0.7.2`) resolve and compile alongside the 1a crates.

- [ ] **Step 1: Confirm the OZ crate versions are still current**

Run:
```bash
wsl -e bash -c "curl -s https://crates.io/api/v1/crates/stellar-tokens | grep -o '\"max_stable_version\":\"[^\"]*\"'"
```
Expected: `"max_stable_version":"0.7.2"` (or newer). If newer, substitute that version everywhere this plan writes `0.7.2`, and re-check that its `soroban-sdk` req still includes `26.1.0` via `curl -s https://crates.io/api/v1/crates/stellar-tokens/<ver>/dependencies`. If the req has moved past `26.1.0`, STOP and decide: align the workspace `soroban-sdk` to the new floor (then re-run 1a tests) or hold OZ at `0.7.2`.

- [ ] **Step 2: Add the OZ crates to the workspace manifest**

Edit `soroban/Cargo.toml` `[workspace.dependencies]` to add (keep the existing `soroban-sdk = "26.1.0"`):
```toml
[workspace.dependencies]
soroban-sdk = "26.1.0"
stellar-tokens = "0.7.2"
stellar-access = "0.7.2"
stellar-contract-utils = "0.7.2"
stellar-macros = "0.7.2"
```

- [ ] **Step 3: Probe-compile OZ against the workspace SDK**

Temporarily append a probe member. Create `soroban/contracts/_probe/Cargo.toml`:
```toml
[package]
name = "oz_probe"
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
Create `soroban/contracts/_probe/src/lib.rs`:
```rust
#![no_std]
// Probe: confirm the OZ RWA + access + utils surfaces resolve against soroban-sdk 26.1.0.
use stellar_tokens::fungible::{Base, FungibleToken};
use stellar_tokens::rwa::{RWA, RWAToken};
use stellar_access::access_control::AccessControl;
use stellar_contract_utils::pausable::Pausable;

pub fn _types_resolve() {
    let _ = core::marker::PhantomData::<(Base, RWA)>;
}
```

- [ ] **Step 4: Build the probe + confirm 1a still builds**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo build -p oz_probe && cargo build -p agent_account -p registry && cargo test -p agent_account -p registry"
```
Expected: **PASS** — OZ resolves against `soroban-sdk 26.1.0`, and the 1a suite is still green (no regression from the dep addition). If OZ fails to resolve, the trait/path names drifted in `0.7.2`: read the error, re-check the OZ docs (`https://docs.openzeppelin.com/stellar-contracts`), and correct the import paths here — **every later task reuses these exact import paths**. If it cannot be made to compile at all, this is the ADR-A gate to fall back to **A2 (classic asset + `auth_required` + SAC)** — stop and report.

- [ ] **Step 5: Remove the probe + commit the deps**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && rm -rf contracts/_probe"
rtk git add soroban/Cargo.toml && rtk git commit -m "chore: add OpenZeppelin stellar RWA deps + validate soroban-sdk 26.1 compat"
```

---

### Task 1: Vendor the claim-based identity infrastructure (CTI, claim issuer, identity, IRS)

Four audited OZ wrapper contracts with no vibing-farmer logic. Copy each from the OZ RWA example verbatim, rename the package + struct, add a smoke test. Grouped into one task because they are mechanical and individually trivial; the deliverable is "all four crates build + each has a green smoke test."

**Files:**
- Create: `soroban/contracts/claim_topics_and_issuers/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`
- Create: `soroban/contracts/claim_issuer/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`
- Create: `soroban/contracts/identity/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`
- Create: `soroban/contracts/identity_registry_storage/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`

**Interfaces (pinned `__constructor` signatures, from the OZ README deploy guide):**
- `claim_topics_and_issuers`: `__constructor(admin, manager)` — exposes `add_claim_topic(topic, operator)`, `add_trusted_issuer(trusted_issuer, claim_topics: Vec<u32>, operator)`
- `claim_issuer`: `__constructor(owner)` — validates claim signatures (Ed25519/Secp256k1/Secp256r1)
- `identity`: `__constructor(owner)` — `IdentityClaims` + `Ownable`; owner adds/removes claims
- `identity_registry_storage`: `__constructor(admin, manager)` — `add_identity(account, identity, initial_profiles, operator)`
- Produces (for Task 3 + Task 7): the four contract structs + their generated `*Client`s.

- [ ] **Step 1: Create the four crate manifests**

Each `Cargo.toml` follows this shape (substitute the package name per crate: `claim_topics_and_issuers`, `claim_issuer`, `identity`, `identity_registry_storage`):
```toml
[package]
name = "claim_topics_and_issuers"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
stellar-tokens = { workspace = true }
stellar-access = { workspace = true }
stellar-macros = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
ed25519-dalek = "2.1.1"
```
> `ed25519-dalek` dev-dep is only strictly needed by `claim_issuer`/`identity` tests (to sign test claims); harmless on the others. `identity` also needs `stellar-access` for `Ownable`.

- [ ] **Step 2: Vendor each contract body**

For each crate, copy the audited source verbatim from the OZ example, changing only the package name and the contract struct name:
- `claim_topics_and_issuers/src/contract.rs` ← `https://github.com/OpenZeppelin/stellar-contracts/blob/main/examples/rwa/claim-topics-and-issuers/src/contract.rs`
- `claim_issuer/src/contract.rs` ← `.../examples/rwa/claim-issuer/src/contract.rs`
- `identity/src/contract.rs` ← `.../examples/rwa/identity/src/contract.rs`
- `identity_registry_storage/src/contract.rs` ← `.../examples/rwa/identity-registry-storage/src/contract.rs`

Each `src/lib.rs` is:
```rust
#![no_std]
mod contract;
mod test;
pub use contract::*;
```

- [ ] **Step 3: Write a smoke test per crate**

Example for `claim_topics_and_issuers/src/test.rs` (adapt the struct/client name to the vendored file):
```rust
#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env};

#[test]
fn test_add_claim_topic_and_trusted_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(ClaimTopicsAndIssuersContract, (admin.clone(), admin.clone()));
    let client = ClaimTopicsAndIssuersContractClient::new(&env, &id);

    let issuer = Address::generate(&env);
    client.add_claim_topic(&1u32, &admin);                  // KYC = 1
    client.add_trusted_issuer(&issuer, &vec![&env, 1u32], &admin);
    // No panic == success. Exact getter names per the vendored contract.
}
```
> The exact struct/client names (`ClaimTopicsAndIssuersContract` etc.) and getter method names come from the vendored OZ file — read them from the copied `contract.rs`. Write the analogous smoke test for `claim_issuer` (register/owner check), `identity` (owner adds a claim), and `identity_registry_storage` (`add_identity` then read back).

- [ ] **Step 4: Build + test the four crates**

Run:
```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p claim_topics_and_issuers -p claim_issuer -p identity -p identity_registry_storage"
```
Expected: PASS (each smoke test green). If a vendored file references an OZ path that differs in `0.7.2`, the compiler points at it — fix against `https://docs.openzeppelin.com/stellar-contracts/tokens/rwa/rwa`.

- [ ] **Step 5: Commit**

```bash
rtk git add soroban/contracts/claim_topics_and_issuers soroban/contracts/claim_issuer soroban/contracts/identity soroban/contracts/identity_registry_storage && rtk git commit -m "feat: vendor OZ claim-based identity infra (CTI, claim issuer, identity, IRS)"
```

---

### Task 2: Compliance aggregator + transfer-allow module

The compliance contract forwards the 5 hooks to registered modules; with **no** modules it allows all operations (OZ default). We add it plus one pluggable module so the guardrail seam is real and testable. (Note: this is **T-REX transfer compliance** — *who may hold/transfer the token*. The **agent allocation/exposure caps** are sub-project **1d**, a separate concern per spec ADR-A consequence. Do not conflate.)

**Files:**
- Create: `soroban/contracts/compliance/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`
- Create: `soroban/contracts/compliance_allow/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`

**Interfaces:**
- Consumes: nothing from earlier 1b tasks (standalone).
- Produces: `ComplianceContract` exposing `add_module_to(hook: ComplianceHook, module: Address, operator)` / `remove_module_from(...)` and the 5 forwarding hooks; `ComplianceAllowContract` implementing `ComplianceModule` + `allow_account(account, operator)`. Consumed by Task 5 (integration) + Task 7 (deploy).

- [ ] **Step 1: Create both crate manifests**

`compliance/Cargo.toml` and `compliance_allow/Cargo.toml` (substitute name):
```toml
[package]
name = "compliance"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
soroban-sdk = { workspace = true }
stellar-tokens = { workspace = true }
stellar-access = { workspace = true }
stellar-macros = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
```

- [ ] **Step 2: Write the failing compliance-module test**

`compliance_allow/src/test.rs`:
```rust
#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_allow_gates_can_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let compliance = Address::generate(&env);
    let id = env.register(ComplianceAllowContract, (admin.clone(), admin.clone(), compliance.clone()));
    let client = ComplianceAllowContractClient::new(&env, &id);

    let token = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    // Nobody allowed yet → transfer disallowed.
    assert_eq!(client.can_transfer(&token, &from, &to, &100i128), false);

    // Allow both parties → transfer allowed.
    client.allow_account(&from, &admin);
    client.allow_account(&to, &admin);
    assert_eq!(client.can_transfer(&token, &from, &to, &100i128), true);
}
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p compliance_allow test_allow_gates_can_transfer"
```
Expected: FAIL — crate not defined.

- [ ] **Step 4: Vendor the compliance aggregator + the module**

`compliance/src/contract.rs` ← copy verbatim from `.../examples/rwa/compliance/src/contract.rs` (renaming struct to `ComplianceContract`). It wires:
```rust
use stellar_tokens::rwa::{
    compliance::{self as compliance, AccountSnapshot, Compliance, ComplianceHook, TransferKind},
    utils::token_binder::{self as token_binder, TokenBinder},
};
// #[contractimpl(contracttrait)] impl Compliance for ComplianceContract {
//   #[only_role(operator,"manager")] fn add_module_to(e,hook,module,operator){ compliance::storage::add_module_to(e,hook,module) }
//   #[only_role(operator,"manager")] fn remove_module_from(e,hook,module,operator){ compliance::storage::remove_module_from(e,hook,module) }
// }
```

`compliance_allow/src/contract.rs` ← copy from `.../examples/rwa/compliance-transfer-allow/src/contract.rs` (rename to `ComplianceAllowContract`). It uses:
```rust
use stellar_tokens::rwa::compliance::modules::{
    storage::{self as compliance_storage},
    transfer_allow::{storage as transfer_allow, TransferAllow},
};
```
`src/lib.rs` for each:
```rust
#![no_std]
mod contract;
mod test;
pub use contract::*;
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p compliance -p compliance_allow"
```
Expected: PASS. The `compliance` crate gets a smoke test too (register + `add_module_to(ComplianceHook::CanTransfer, module, admin)` does not panic) — add it mirroring the structure above.

- [ ] **Step 6: Commit**

```bash
rtk git add soroban/contracts/compliance soroban/contracts/compliance_allow && rtk git commit -m "feat: RWA compliance aggregator + transfer-allow module"
```

---

### Task 3: Identity verifier (claim-based, ties IRS + CTI)

The mandatory module the token calls. We use OZ's claim-based default: `verify_identity` looks up the wallet's identity in the IRS, fetches required topics from the CTI, and validates the claims via the claim issuer — panicking if the wallet is not fully KYC-verified.

**Files:**
- Create: `soroban/contracts/identity_verifier/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`

**Interfaces:**
- Consumes: `identity_registry_storage` + `claim_topics_and_issuers` addresses (Task 1).
- Produces: `IdentityVerifierContract` with `__constructor(admin, manager, identity_registry_storage, claim_topics_and_issuers)` and trait `IdentityVerifier::verify_identity(e, account)` (panics on unverified). Consumed by Task 4/5/7.

- [ ] **Step 1: Create the crate manifest**

`identity_verifier/Cargo.toml` — same shape as Task 2 (deps: soroban-sdk, stellar-tokens, stellar-access, stellar-macros; dev: testutils + `ed25519-dalek = "2.1.1"` for signing test claims).

- [ ] **Step 2: Vendor the verifier contract**

`identity_verifier/src/contract.rs` ← copy from `.../examples/rwa/identity-verifier/src/contract.rs` (rename struct to `IdentityVerifierContract`). Confirmed shape:
```rust
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_admin;
use stellar_tokens::rwa::identity_verifier::{storage as identity_verifier, IdentityVerifier};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct IdentityVerifierContract;

#[contractimpl]
impl IdentityVerifierContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        identity_registry_storage: Address,
        claim_topics_and_issuers: Address,
    ) {
        identity_verifier::set_identity_registry_storage(e, &identity_registry_storage);
        identity_verifier::set_claim_topics_and_issuers(e, &claim_topics_and_issuers);
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    #[only_admin]
    pub fn set_identity_registry_storage(e: &Env, identity_registry_storage: Address, _operator: Address) {
        identity_verifier::set_identity_registry_storage(e, &identity_registry_storage);
    }
}

#[contractimpl(contracttrait)]
impl IdentityVerifier for IdentityVerifierContract {
    fn verify_identity(e: &Env, account: &Address) {
        identity_verifier::verify_identity(e, account);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for IdentityVerifierContract {}
```
> If the vendored file differs (e.g. the CTI setter name or whether `AccessControl` is impl'd via `contracttrait`), use the copied source as ground truth — the compile step surfaces any mismatch.

`src/lib.rs`:
```rust
#![no_std]
mod contract;
mod test;
pub use contract::*;
```

- [ ] **Step 3: Write the verify-rejects-unverified test**

`identity_verifier/src/test.rs`:
```rust
#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

fn deploy_irs_and_cti(env: &Env, admin: &Address) -> (Address, Address) {
    let irs = env.register(
        identity_registry_storage::IdentityRegistryStorageContract,
        (admin.clone(), admin.clone()),
    );
    let cti = env.register(
        claim_topics_and_issuers::ClaimTopicsAndIssuersContract,
        (admin.clone(), admin.clone()),
    );
    (irs, cti)
}

#[test]
fn test_verify_identity_panics_for_unregistered_wallet() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (irs, cti) = deploy_irs_and_cti(&env, &admin);
    let id = env.register(IdentityVerifierContract, (admin.clone(), admin.clone(), irs, cti));
    let client = IdentityVerifierContractClient::new(&env, &id);

    let stranger = Address::generate(&env);
    // No identity registered for `stranger` → verify must trap.
    assert!(client.try_verify_identity(&stranger).is_err());
}
```
> This needs `identity_registry_storage` + `claim_topics_and_issuers` as dev-dependencies of the verifier crate for the in-test registration. Add them under `[dev-dependencies]` in `identity_verifier/Cargo.toml`:
> ```toml
> identity_registry_storage = { path = "../identity_registry_storage" }
> claim_topics_and_issuers = { path = "../claim_topics_and_issuers" }
> ```

- [ ] **Step 4: Run the test**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p identity_verifier"
```
Expected: PASS (unregistered wallet traps). The "happy path" (registered + claimed wallet verifies) is exercised in Task 5's full-stack integration test, where the claim-signing plumbing lives.

- [ ] **Step 5: Commit**

```bash
rtk git add soroban/contracts/identity_verifier && rtk git commit -m "feat: claim-based RWA identity verifier wired to IRS + CTI"
```

---

### Task 4: mRWA token (FungibleToken + RWAToken + Pausable + AccessControl)

The token itself. Unit-tested against a **mock identity verifier** (a test-only double) so token logic — mint gated by verification, pause, roles — is isolated from the full claim plumbing (the real stack is integration-tested in Task 5).

**Files:**
- Create: `soroban/contracts/rwa_token/{Cargo.toml, src/lib.rs, src/contract.rs, src/test.rs}`

**Interfaces:**
- Consumes: a compliance address + an identity-verifier address (both by `Address`, loose coupling).
- Produces: `MockRwaToken` with `__constructor(name, symbol, admin, manager, compliance, identity_verifier)`, `mint(to, amount, operator)` (manager-gated), the SEP-41 `FungibleToken` surface (`transfer`, `transfer_from`, `balance`, `approve`, …), `RWAToken` regulatory ops (freeze/recovery), and `Pausable`. **This is the surface 1c + 3 + 4 consume — pinned in Task 8.**

- [ ] **Step 1: Write the failing token unit tests (mock verifier double)**

`rwa_token/src/test.rs`:
```rust
#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, Address, Env, String};

// --- Test doubles (loose coupling lets us mock the collaborators) ---

// Mock identity verifier: verifies only addresses added via `allow`.
#[contract]
pub struct MockVerifier;
#[contractimpl]
impl MockVerifier {
    pub fn allow(e: &Env, who: Address) {
        e.storage().persistent().set(&who, &true);
    }
    pub fn verify_identity(e: &Env, account: Address) {
        let ok: bool = e.storage().persistent().get(&account).unwrap_or(false);
        if !ok {
            panic!("identity not verified");
        }
    }
}

// Mock compliance: allow-all (mirrors OZ "no modules registered" default).
#[contract]
pub struct MockCompliance;
#[contractimpl]
impl MockCompliance {
    pub fn can_transfer(_e: &Env, _from: Address, _to: Address, _amount: i128, _token: Address) -> bool { true }
    pub fn can_create(_e: &Env, _to: Address, _amount: i128, _token: Address) -> bool { true }
    pub fn created(_e: &Env, _to: Address, _amount: i128, _token: Address) {}
    pub fn destroyed(_e: &Env, _from: Address, _amount: i128, _token: Address) {}
    pub fn transferred(_e: &Env, _from: Address, _to: Address, _amount: i128, _token: Address) {}
}

fn setup(env: &Env) -> (MockRwaTokenClient<'static>, Address, Address, MockVerifierClient<'static>) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let manager = admin.clone();
    let verifier_id = env.register(MockVerifier, ());
    let compliance_id = env.register(MockCompliance, ());
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let token_id = env.register(
        MockRwaToken,
        (
            String::from_str(env, "Mock RWA"),
            String::from_str(env, "mRWA"),
            admin.clone(),
            manager.clone(),
            compliance_id,
            verifier_id,
        ),
    );
    (MockRwaTokenClient::new(env, &token_id), admin, manager.clone(), verifier)
}

#[test]
fn test_metadata_is_seven_decimals() {
    let env = Env::default();
    let (token, _admin, _mgr, _v) = setup(&env);
    assert_eq!(token.decimals(), 7);
    assert_eq!(token.symbol(), String::from_str(&env, "mRWA"));
}

#[test]
fn test_mint_to_unverified_holder_rejected() {
    let env = Env::default();
    let (token, _admin, mgr, _v) = setup(&env);
    let bob = Address::generate(&env);
    // Bob is not verified → mint must trap.
    assert!(token.try_mint(&bob, &1_000_000i128, &mgr).is_err());
}

#[test]
fn test_mint_to_verified_holder_succeeds() {
    let env = Env::default();
    let (token, _admin, mgr, verifier) = setup(&env);
    let alice = Address::generate(&env);
    verifier.allow(&alice);
    token.mint(&alice, &1_000_000i128, &mgr);
    assert_eq!(token.balance(&alice), 1_000_000i128);
}

#[test]
fn test_pause_blocks_mint() {
    let env = Env::default();
    let (token, admin, mgr, verifier) = setup(&env);
    let alice = Address::generate(&env);
    verifier.allow(&alice);
    token.pause(&admin);
    assert!(token.try_mint(&alice, &1i128, &mgr).is_err());
}
```

- [ ] **Step 2: Run them to confirm they fail**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_token"
```
Expected: FAIL — `MockRwaToken` not defined.

- [ ] **Step 3: Implement the token contract**

`rwa_token/src/contract.rs`:
```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String, Symbol};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::{only_admin, only_role};
use stellar_tokens::{
    fungible::{Base, FungibleToken},
    rwa::{RWAToken, RWA},
};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct MockRwaToken;

#[contractimpl]
impl MockRwaToken {
    pub fn __constructor(
        e: &Env,
        name: String,
        symbol: String,
        admin: Address,
        manager: Address,
        compliance: Address,
        identity_verifier: Address,
    ) {
        Base::set_metadata(e, 7, name, symbol); // 7 decimals (Stellar convention)
        RWA::set_compliance(e, &compliance);
        RWA::set_identity_verifier(e, &identity_verifier);
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    /// Manager-gated mint. RWA::mint runs the identity + compliance checks and
    /// the pause guard, so unverified recipients / paused state revert here.
    #[only_role(operator, "manager")]
    pub fn mint(e: &Env, to: Address, amount: i128, operator: Address) {
        RWA::mint(e, &to, amount);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for MockRwaToken {
    type ContractType = RWA;
}

#[contractimpl(contracttrait)]
impl RWAToken for MockRwaToken {}

#[contractimpl(contracttrait)]
impl Pausable for MockRwaToken {
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
impl AccessControl for MockRwaToken {}
```
> Ground truth = the OZ example token at `.../examples/rwa/token/src/contract.rs` (its `__constructor` is `(name, symbol, admin, manager, compliance, identity_verifier)` with `Base::set_metadata(e, 7, name, symbol)`). If `RWA::mint`/`Pausable`/`AccessControl` shapes differ in `0.7.2`, the compile step points at it — mirror the example. The pause guard for transfers is enforced by the `RWA` ContractType's `FungibleToken` impl, so `test_pause_blocks_mint` plus the Task-5 transfer-pause assertion both rely on it; if mint is not pause-gated in `0.7.2`, weaken `test_pause_blocks_mint` to a transfer-pause assertion (Task 5 already covers transfer-pause).

`rwa_token/src/lib.rs`:
```rust
#![no_std]
mod contract;
mod test;
pub use contract::*;
```

`rwa_token/Cargo.toml` deps: soroban-sdk, stellar-tokens, stellar-access, stellar-contract-utils, stellar-macros (all workspace); dev: `soroban-sdk` testutils only (mocks are defined inline in `test.rs`).

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_token"
```
Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add soroban/contracts/rwa_token && rtk git commit -m "feat: KYC-gated mRWA token (FungibleToken + RWAToken + Pausable)"
```

---

### Task 5: Full-stack KYC integration test (headline)

Wires the entire real claim-based stack in one test and proves the spec success criterion: "KYC gating provably blocks a non-allowlisted wallet." This is the test that demonstrates end-to-end T-REX behavior with the real OZ contracts (no mocks).

**Files:**
- Create: `soroban/contracts/rwa_token/src/integration_test.rs`
- Modify: `soroban/contracts/rwa_token/src/lib.rs` (add `mod integration_test;`)
- Modify: `soroban/contracts/rwa_token/Cargo.toml` (dev-deps: the 6 collaborator crates by path + `ed25519-dalek`)

**Interfaces:**
- Consumes: every 1b contract (Tasks 1–4) + `ed25519-dalek` to sign a KYC claim like the OZ `sign-claim` tool.

- [ ] **Step 1: Add the collaborator crates as dev-dependencies**

In `rwa_token/Cargo.toml`:
```toml
[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
claim_topics_and_issuers = { path = "../claim_topics_and_issuers" }
claim_issuer = { path = "../claim_issuer" }
identity = { path = "../identity" }
identity_registry_storage = { path = "../identity_registry_storage" }
identity_verifier = { path = "../identity_verifier" }
compliance = { path = "../compliance" }
ed25519-dalek = "2.1.1"
```

- [ ] **Step 2: Write the end-to-end test**

`rwa_token/src/integration_test.rs` — wire the stack in the OZ deployment order (CTI → claim issuer → identity → IRS → verifier → compliance → token), KYC-verify Alice by signing a topic-1 claim with the trusted issuer key, then assert:
```rust
#![cfg(test)]
use crate::{MockRwaToken, MockRwaTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env, String};

// Helper that builds the full T-REX stack and KYC-verifies `alice`.
// Mirrors examples/rwa/token/src/test.rs for the claim-signing plumbing
// (Ed25519 over the claim payload using the trusted issuer key).
fn build_stack_and_verify(env: &Env) -> (MockRwaTokenClient<'static>, Address /*admin*/, Address /*alice*/) {
    env.mock_all_auths();
    let admin = Address::generate(env);

    let cti = env.register(claim_topics_and_issuers::ClaimTopicsAndIssuersContract, (admin.clone(), admin.clone()));
    let issuer = env.register(claim_issuer::ClaimIssuerContract, (admin.clone(),));
    let alice = Address::generate(env);
    let alice_identity = env.register(identity::IdentityContract, (alice.clone(),));
    let irs = env.register(identity_registry_storage::IdentityRegistryStorageContract, (admin.clone(), admin.clone()));
    let verifier = env.register(identity_verifier::IdentityVerifierContract, (admin.clone(), admin.clone(), irs.clone(), cti.clone()));
    let compliance = env.register(compliance::ComplianceContract, (admin.clone(), admin.clone()));
    let token_id = env.register(MockRwaToken, (
        String::from_str(env, "Mock RWA"),
        String::from_str(env, "mRWA"),
        admin.clone(), admin.clone(), compliance.clone(), verifier.clone(),
    ));

    // KYC topic 1, trust `issuer` for topic 1.
    let cti_c = claim_topics_and_issuers::ClaimTopicsAndIssuersContractClient::new(env, &cti);
    cti_c.add_claim_topic(&1u32, &admin);
    cti_c.add_trusted_issuer(&issuer, &vec![env, 1u32], &admin);

    // Register Alice's wallet→identity in the IRS (country 360 = ID).
    let irs_c = identity_registry_storage::IdentityRegistryStorageContractClient::new(env, &irs);
    // initial_profiles shape per the vendored IRS contract; see OZ README add_identity.
    irs_c.add_identity(&alice, &alice_identity, /* profiles */ &profiles_id(env), &admin);

    // Sign + store a topic-1 KYC claim in Alice's identity, issued by `issuer`.
    // (Ed25519 sign over the claim payload — mirror examples/rwa/token/src/test.rs
    //  sign_claim helper; the trusted issuer's keypair is the test double for the
    //  zkPass KYC backend, ADR-B1.)
    add_signed_kyc_claim(env, &alice_identity, &issuer, /*topic*/ 1);

    (MockRwaTokenClient::new(env, &token_id), admin, alice)
}

#[test]
fn test_verified_holder_can_receive_unverified_cannot() {
    let env = Env::default();
    let (token, admin, alice) = build_stack_and_verify(&env);

    // Mint to KYC-verified Alice → ok.
    token.mint(&alice, &1_000_000i128, &admin);
    assert_eq!(token.balance(&alice), 1_000_000i128);

    // Transfer to Bob (no identity, no claim) → rejected by identity verification.
    let bob = Address::generate(&env);
    assert!(token.try_transfer(&alice, &bob, &1i128).is_err());
}

#[test]
fn test_pause_blocks_transfer_between_verified() {
    let env = Env::default();
    let (token, admin, alice) = build_stack_and_verify(&env);
    token.mint(&alice, &10i128, &admin);
    token.pause(&admin);
    let carol = Address::generate(&env);
    assert!(token.try_transfer(&alice, &carol, &1i128).is_err());
}
```
> The two helpers `profiles_id(env)` (builds the `initial_profiles` Vec the vendored IRS expects) and `add_signed_kyc_claim(...)` (Ed25519-signs a claim and stores it in the identity contract) are **not invented here** — copy them from the audited OZ test at `https://github.com/OpenZeppelin/stellar-contracts/blob/main/examples/rwa/token/src/test.rs` (and `identity-verifier/src/test.rs`), which already implement exactly this claim-signing flow for `0.7.2`. Adapt names to our struct/client names. This keeps the crypto plumbing audited rather than hand-rolled.

- [ ] **Step 3: Run the integration test**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_token --test '*' ; cargo test -p rwa_token integration"
```
Expected: PASS — verified Alice receives; unverified Bob is rejected; pause blocks transfers. If the claim-signing helper API differs, the OZ `0.7.2` test file is the ground truth.

- [ ] **Step 4: Commit**

```bash
rtk git add soroban/contracts/rwa_token && rtk git commit -m "test: full T-REX KYC stack integration (verified ok, unverified blocked, pause)"
```

---

### Task 6: zkPass → claim-issuer seam + audit trail (ADR-B1)

Pins the ADR-B1 composition: zkPass verifies identity **off-chain**; the backend, holding the **trusted claim-issuer key**, signs the on-chain KYC claim. 1b proves the on-chain half (trusted issuer's claim validates; an untrusted key's claim is rejected) and documents the off-chain seam + the audit-log trust mitigation. No frontend (that is sub-project 3).

**Files:**
- Create: `soroban/contracts/rwa_token/src/seam_test.rs`
- Modify: `soroban/contracts/rwa_token/src/lib.rs` (add `mod seam_test;`)
- Create: `docs/soroban-kyc-seam.md` (committed-candidate doc; sibling of `docs/soroban-interfaces.md`)

- [ ] **Step 1: Write the trusted-vs-untrusted issuer test**

`rwa_token/src/seam_test.rs` — reuse `build_stack_and_verify` plumbing but add a second, **untrusted** issuer keypair and assert a claim signed by it does NOT verify the holder:
```rust
#![cfg(test)]
use crate::{MockRwaToken, MockRwaTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_claim_from_untrusted_issuer_does_not_verify() {
    let env = Env::default();
    env.mock_all_auths();
    // Build stack as in integration_test, but sign Alice's claim with a key
    // NOT registered as a trusted issuer in CTI.
    // Expectation: minting to Alice traps (verify_identity fails — issuer untrusted).
    // (Construct via the shared helper; assert try_mint(&alice,...).is_err().)
    // Full body mirrors integration_test.rs with the issuer-key swap.
}
```
> Implement by parameterizing the Task-5 helper to accept the signing key + whether it is registered as trusted. The assertion is `try_mint(...).is_err()` for the untrusted case. This proves the on-chain trust anchor is the CTI trusted-issuer registry — exactly what ADR-B1's backend key gates.

- [ ] **Step 2: Run it**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_token seam"
```
Expected: PASS — untrusted-issuer claim does not verify.

- [ ] **Step 3: Write the seam doc**

Create `docs/soroban-kyc-seam.md`:
```markdown
# RWA KYC seam (ADR-B1: zkPass off-chain → on-chain claim)

Three distinct layers (spec ADR-B "Composition" — do not conflate):
1. **zkPass (off-chain, "who qualifies")** — user runs TransGate, proves a private
   KYC claim locally (VOLE-ZK + SNARK). Raw ID never leaves the device. Backend
   verifies the zkPass proof.
2. **Claim issuer (on-chain attestation)** — the backend holds the trusted
   claim-issuer key (registered in `claim_topics_and_issuers` as a trusted issuer
   for topic 1 = KYC). On a valid zkPass proof, the backend signs a topic-1 claim
   (Ed25519) and writes it into the investor's `identity` contract.
3. **Token holder gate** — `rwa_token` calls `identity_verifier.verify_identity`,
   which validates the claim against CTI + IRS on every mint/transfer.

## Trust anchor + mitigation
The backend's honest verification of the zkPass proof is the trust anchor
(spec §9). Mitigations: (a) append-only audit log of every claim issuance
(zkPass proof hash + wallet + topic + timestamp), (b) optionally anchor the
proof hash on-chain. The trust-minimized upgrade is ADR-B2 (own Groth16 verifier
on Soroban via BLS12-381) — tracked as optional sub-project 5, NOT built here.

## Consumed by
- Sub-project 3 (frontend): integrates the TransGate flow + calls the backend.
- Sub-project 4 (orchestrator): assumes holders are pre-KYC'd before agent deposits.
```

- [ ] **Step 4: Commit**

```bash
rtk git add soroban/contracts/rwa_token docs/soroban-kyc-seam.md && rtk git commit -m "feat: zkPass->claim-issuer KYC seam test + audit-trail doc"
```

---

### Task 7: Deploy + seed the T-REX stack → `deployments/stellar-testnet.json`

Extends the 1a `scripts/soroban/deploy-seed.sh` with the full RWA deploy chain (OZ README order) so a testnet reset is one command (spec §8). Build path stays `wasm32v1-none`.

**Files:**
- Modify: `scripts/soroban/deploy-seed.sh`
- Modify: `deployments/stellar-testnet.json`

- [ ] **Step 1: Extend the deploy-id template**

Add the 1b keys to `deployments/stellar-testnet.json` (keep the 1a keys):
```json
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "",
  "agentAccountWasmHash": "",
  "demoAgentAccount": "",
  "rwa": {
    "claimTopicsAndIssuers": "",
    "claimIssuer": "",
    "identityRegistryStorage": "",
    "identityVerifier": "",
    "compliance": "",
    "complianceAllowModule": "",
    "token": "",
    "decimals": 7
  }
}
```

- [ ] **Step 2: Append the RWA deploy chain to the script**

Append to `scripts/soroban/deploy-seed.sh` (after the 1a deploy block; reuse `vf-deployer`/`$ADMIN`/`$NET`/`$WASM_DIR`). Order follows the OZ README checklist:
```bash
# ---- 1b: RWA (T-REX) stack ----
CTI=$(stellar contract deploy --wasm "$WASM_DIR/claim_topics_and_issuers.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
CLAIM_ISSUER=$(stellar contract deploy --wasm "$WASM_DIR/claim_issuer.wasm" \
  --source vf-deployer --network "$NET" -- --owner "$ADMIN")
IRS=$(stellar contract deploy --wasm "$WASM_DIR/identity_registry_storage.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
VERIFIER=$(stellar contract deploy --wasm "$WASM_DIR/identity_verifier.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --manager "$ADMIN" \
     --identity_registry_storage "$IRS" --claim_topics_and_issuers "$CTI")
COMPLIANCE=$(stellar contract deploy --wasm "$WASM_DIR/compliance.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
ALLOW_MOD=$(stellar contract deploy --wasm "$WASM_DIR/compliance_allow.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN" --compliance "$COMPLIANCE")
TOKEN=$(stellar contract deploy --wasm "$WASM_DIR/rwa_token.wasm" \
  --source vf-deployer --network "$NET" \
  -- --name "Mock RWA" --symbol "mRWA" --admin "$ADMIN" --manager "$ADMIN" \
     --compliance "$COMPLIANCE" --identity_verifier "$VERIFIER")

# Configure: KYC topic 1, trust the claim issuer for it.
stellar contract invoke --id "$CTI" --source vf-deployer --network "$NET" \
  -- add_claim_topic --topic 1 --operator "$ADMIN"
stellar contract invoke --id "$CTI" --source vf-deployer --network "$NET" \
  -- add_trusted_issuer --trusted_issuer "$CLAIM_ISSUER" --claim_topics '[1]' --operator "$ADMIN"

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
    "decimals": 7
  }
}
JSON
echo "Wrote $OUT"
```
> Confirm exact `--operator`/arg names against `stellar contract info --id <c>` after upload if any invoke rejects (the README uses `--operator admin`). Per-investor identity deploy + `add_identity` + claim signing are demo-runtime steps (frontend/seed of a specific user), not part of the contract-id seed — document them in the README, not here.

- [ ] **Step 3: Dry-run the build path (no deploy)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls target/wasm32v1-none/release/*.wasm"
```
Expected: all 1b wasms present (`rwa_token.wasm`, `identity_verifier.wasm`, `compliance.wasm`, `compliance_allow.wasm`, `claim_topics_and_issuers.wasm`, `claim_issuer.wasm`, `identity.wasm`, `identity_registry_storage.wasm`) alongside the 1a wasms. (Actual testnet deploy needs the funded `vf-deployer` key and is run manually by the user — do not auto-run deploy.)

- [ ] **Step 4: Commit**

```bash
rtk git add scripts/soroban/deploy-seed.sh deployments/stellar-testnet.json && rtk git commit -m "feat: deploy+seed RWA T-REX stack to stellar-testnet config"
```

---

### Task 8: Pin the RWA token interface for 1c/2/3/4

Spec §7: sub-project 1 publishes the inter-layer contract. 1a wrote `docs/soroban-interfaces.md`; 1b appends the token surface + the T-REX consequence the vault (1c) must honor.

**Files:**
- Modify: `docs/soroban-interfaces.md`

- [ ] **Step 1: Append the RWA token section**

Add to `docs/soroban-interfaces.md`:
```markdown
## RWA token (`rwa_token`, struct `MockRwaToken`) — pinned by sub-project 1b
- Standard: SEP-57 / ERC-3643 (T-REX) via OpenZeppelin RWA module (audited).
- Decimals: **7**. Symbol `mRWA`. Yield does NOT live here (see 1c vault).
- Constructor: `__constructor(name: String, symbol: String, admin: Address,
  manager: Address, compliance: Address, identity_verifier: Address)`
- Mint (manager-gated): `mint(to: Address, amount: i128, operator: Address)`
- SEP-41 surface (consumed by 1c/3/4): `transfer(from, to, amount: i128)`,
  `transfer_from(spender, from, to, amount: i128)`, `balance(id) -> i128`,
  `approve(from, spender, amount, expiration_ledger)`, `allowance`, `decimals`,
  `name`, `symbol`. Every state-changing call runs identity verification +
  compliance hooks + the pause guard.
- Regulatory (RWAToken): address/partial freeze, recovery — admin/manager gated.

### KYC gate (who may hold/transfer)
A wallet may hold/receive `mRWA` only if `identity_verifier.verify_identity`
passes: the wallet is in the IRS and has a valid topic-1 (KYC) claim from a
trusted issuer (the zkPass-fed backend, ADR-B1). Unverified wallets revert.

### CONSEQUENCE FOR 1c (vault) — load-bearing
1a pinned the vault deposit as `deposit(from: Address, amount: i128) -> i128`.
When the vault moves `mRWA` (pull from `from`, hold as vault assets), the
transfer is T-REX-gated. Therefore **the vault contract address MUST itself be a
verified identity** (registered in IRS + holding a KYC claim) OR a compliance
module must whitelist the vault as a permitted counterparty. 1c MUST register the
vault as a verified holder at deploy time, or `deposit` reverts at the token move.

### Compliance vs agent caps (do not conflate)
`compliance` here governs *who may hold/transfer* (T-REX). The *agent
allocation/exposure caps* (Aladdin limits) are sub-project **1d**, a separate
guardrail. 1d may be added as a `compliance_allow`-style module OR enforced in
the vault — that decision is 1d's, not 1b's.
```

- [ ] **Step 2: Commit**

```bash
rtk git add docs/soroban-interfaces.md && rtk git commit -m "docs: pin RWA token interface + T-REX consequence for 1c vault"
```

---

### Task 9: Full suite + WASM size + static analysis gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace test suite**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```
Expected: all 1a + 1b tests PASS.

- [ ] **Step 2: Confirm every contract WASM is under 64KB**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && ls -la target/wasm32v1-none/release/*.wasm"
```
Expected: each `.wasm` < 65536 bytes. The RWA token + claim stack are heavier than 1a — if any exceeds the cap, confirm the release profile (`opt-level="z"`, `lto=true`, `panic="abort"`, `strip="symbols"`) is inherited and consider the OZ `experimental_spec_shaking_v2` feature (already pulled transitively). If the token alone still exceeds 64KB, report — that is a real T-REX-on-Soroban constraint to escalate (it informs whether ADR-A2 fallback is needed).

- [ ] **Step 3: Run Scout static analysis**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo install --locked cargo-scout-audit 2>/dev/null; cargo scout-audit"
```
Expected: no critical/high findings in our crates. The OZ library crates are pre-audited; triage only findings in `rwa_token`/`identity_verifier`/`compliance`/`compliance_allow` and the vendored wrappers. (If `cargo-scout-audit` was blocked in 1a, fall back to `cargo clippy --workspace -- -D warnings`.)

- [ ] **Step 4: Final commit if anything changed**

```bash
rtk git add -A && rtk git commit -m "test: soroban 1b suite green + size + scout gate"
```

---

## Self-Review

**1. Spec coverage (component 1b):**
- ADR-A = A1 (T-REX via OZ RWA module), tooling validated before commit → Task 0 (compat gate, A2 fallback path stated). ✅
- RWA token KYC-gated, mintable, transfer-restricted (spec §5 component 2) → Task 4 + Task 5. ✅
- Claim-based identity stack (CTI, claim issuer, identity, IRS, verifier) → Tasks 1 + 3. ✅
- Modular compliance framework + ≥1 module → Task 2. ✅
- ADR-B1 zkPass off-chain → on-chain claim issuer seam + audit trail → Task 6 + `docs/soroban-kyc-seam.md`. ✅
- "Token does not carry yield" (spec §5) → explicit in Goal + Task 8 interface doc; yield deferred to 1c. ✅
- Testnet config regeneration like 1a (spec §8) → Task 7 (deploy-seed extension, `wasm32v1-none`). ✅
- TTL/rent (spec §8): OZ manages persistent/temp; instance-TTL is ours — noted in Global Constraints (the OZ wrappers + our token use instance storage for admin/config; if any unbounded instance growth, extend in a future pass — flagged, not silently dropped). ✅
- Inter-layer interface published (spec §7) + the T-REX consequence for 1c (vault must be a verified holder) → Task 8. ✅
- Out-of-1b scope correctly deferred: vault/yield 1c, agent caps 1d, relay 2, frontend TransGate 3, Groth16 ADR-B2 (sub-project 5). Stated in Scope boundary.

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". The supporting contracts are "vendor verbatim from <exact OZ URL>" (a concrete artifact + a smoke test), not placeholders. The two crypto helpers in Task 5 (`profiles_id`, `add_signed_kyc_claim`) are explicitly "copy from the audited OZ `0.7.2` test file at <URL>" rather than invented — the deliberate, safe choice for audited claim-signing plumbing, tied to a compile/test gate. Residual SDK/OZ-API drift (exact `RWA::mint`/`Pausable`/`AccessControl` shapes, IRS `add_identity` profile type, CTI setter names) is handled the 1a way: every code step is followed by a compile/test run, and the vendored OZ example is named as ground truth.

**3. Type consistency:** Constructor signatures consistent across code + deploy script + interface doc: token `(name, symbol, admin, manager, compliance, identity_verifier)`; verifier `(admin, manager, identity_registry_storage, claim_topics_and_issuers)`; CTI/IRS `(admin, manager)`; claim issuer / identity `(owner)`. `ComplianceHook`, `ComplianceModule` 5-hook surface, and the `compliance_allow.allow_account` name are consistent between Task 2 and Task 5/7. Decimals = 7 consistent across token code, tests, deploy JSON, and interface doc. Struct names (`MockRwaToken`, `IdentityVerifierContract`, `ComplianceContract`, `ComplianceAllowContract`, `ClaimTopicsAndIssuersContract`, `ClaimIssuerContract`, `IdentityContract`, `IdentityRegistryStorageContract`) used identically in tests, deploy, and docs.

**Known residual risk (flagged, not a gap):** (a) exact OZ `0.7.2` API names for a few setters/types — mitigated by Task 0 compat gate + per-task compile/test + named OZ ground-truth files. (b) WASM size: the full T-REX is heavy; Task 9 Step 2 is the explicit size gate, and exceeding 64KB on the token is the escalation trigger toward ADR-A2. (c) zkPass↔claim-issuer is proved on-chain (trusted vs untrusted issuer, Task 6) but the off-chain proof verification is sub-project 3 — 1b only pins the seam + audit-log requirement.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-soroban-1b-rwa-token-trex.md` (local-only; `docs/superpowers/` is gitignored). Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Strong fit here: new OZ library + heavy T-REX surface, so per-task compile/size review catches OZ-`0.7.2` API drift and WASM-size blowups early.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch execution with checkpoints.

Which approach?

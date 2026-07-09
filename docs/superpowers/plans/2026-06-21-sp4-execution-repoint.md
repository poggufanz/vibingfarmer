# SP4 Execution Re-point (EVM → Stellar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-point the agent execution path (`orchestrator.js` / `worker.js` / `app.jsx` / `wallet.js`) from the EVM stack (ethers / viem / 1Shot / AgentRegistry+Depositor) onto the already-built Soroban chain layer (`frontend/src/stellar/*`), so an autonomous agent deposit is authorized **on-chain by the agent's ephemeral ed25519 session key** via `AgentAccount.__check_auth` — keeping the "the chain enforces each agent's cap/expiry/revoke per deposit" claim literally true.

**Architecture (Option A — agent is the on-chain holder, decided 2026-06-21):**
- The on-chain agent is a Soroban **custom account** (`agent_account`, sub-project 1a). Its `__check_auth` ed25519-verifies the session-key signature and enforces scope (one `deposit@vault` context, amount ≤ remaining `cap_per_period`, `now < expiry`, `!revoked`). This is the differentiator and stays untouched: the session key remains **deposit-only**.
- `vault.deposit(from, amount)` (deployed 1c) does `from.require_auth()` → `transfer_from(spender=vault, from, vault)` → **mints shares to `from`**. So `from` MUST be the agent for on-chain enforcement to apply, which means the agent must (a) hold the asset and (b) have a pre-set `allowance[agent][vault]`. The agent cannot `approve` under its own deposit-only `__check_auth`.
- **Resolution:** redeploy a new `agent_account` wasm that (1) **self-approves the vault in its constructor** via `authorize_as_current_contract` (invoker-contract auth — bypasses `__check_auth`, sets `allowance[agent][vault] = cap`), and (2) exposes an **owner-gated `owner_withdraw(to)`** that redeems all shares + claims dividend + sweeps the asset back to the owner (again via `authorize_as_current_contract`, gated by `owner.require_auth()`). The session key never gains `approve`/`redeem`/`transfer` power; the exit is an owner action.
- Funding: at "approve once" the user funds each ephemeral agent address (one batched tx) and signs `registry.authorize` per agent. The autonomous deposit is then relayer-fee-bumped (gasless), authorized only by the session key.

This plan is **Phase 1 only**: the `agent_account` contract change + redeploy. It produces working, independently testable software (an agent account that can be funded, deposit autonomously, and be swept by its owner) and is the hard blocker every later phase needs deployed first. **Phases 2 (frontend Stellar deposit auth-tree) and 3 (re-point orchestrator/worker/app/wallet) are scoped at the end as their own follow-on plans** — do not start them here.

**Tech Stack:** Rust, `soroban-sdk = "26.1.0"`, `stellar-tokens = "0.7.2"`, `stellar-access = "0.7.2"`, `stellar-cli` (testnet deploy). Foundry/forge are EVM — not used here. All Soroban commands run in **WSL** (`wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && …"`).

## Global Constraints

- **Domain:** DeFi yield farming only. No RWA / KYC / compliance framing (that layer was dropped 2026-06-20).
- **Decimals = 7** everywhere. Amounts are `i128` base units (1 VFUSD = `10_000_000`).
- **The session key stays deposit-only.** Do NOT widen `__check_auth` to allow `approve`/`redeem`/`transfer`. The new powers (self-approve, sweep) use `authorize_as_current_contract` (invoker-contract auth) or `owner.require_auth()` — never the ed25519 `__check_auth` path.
- **Deployed Stellar testnet addresses** (from `deployments/stellar-testnet.json`, mirrored in `frontend/src/stellar/config.js`): vault `CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5`, registry `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ`, token (SAC VFUSD) `CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4`. The vault + registry + token are NOT changed by this plan — only `agent_account` is rebuilt and the **demo agent** redeployed.
- **No over-claiming.** Honest claim after this lands: "the agent custom account's `__check_auth` enforces the deposit cap/expiry/revoke on-chain per deposit; the ephemeral ed25519 session key authorizes deposits; the user can revoke any time and sweep funds out via `owner_withdraw`." Do NOT claim "fully trustless" or "non-custodial agent" — the owner funds the agent and can always sweep, which is the trust model.
- **Pin-at-impl, prove by test.** `authorize_as_current_contract` + `InvokerContractAuthEntry` / `SubContractInvocation` / `ContractContext` are written below to the soroban-sdk 26.x `auth` module shape. If a name/path differs on the pinned crate, fix it against `soroban_sdk::auth` docs for 26.1.0 — `cargo build` fails fast and the TDD tests are the behavioral proof. Never leave a guessed call unproven.
- **`#![no_std]`, checked arithmetic, typed `DataKey`, TTL extension on state writes** — house Soroban discipline (see existing `vault.rs` / `account.rs`).
- **Test bar:** `cargo test` from `soroban/`, all green; wasm < 64KB; `cargo clippy -- -D warnings` clean.

---

## File Structure

| File | Responsibility |
|---|---|
| `soroban/contracts/agent_account/src/lib.rs` (modify) | Add the self-approve call to `__constructor`; add the `owner_withdraw` entrypoint. `scope_of`/`signer`/`version` unchanged. |
| `soroban/contracts/agent_account/src/account.rs` (unchanged) | `__check_auth` stays deposit-only. Do not touch. |
| `soroban/contracts/agent_account/src/types.rs` (modify) | Add `AccountError` variants used by `owner_withdraw` (e.g. `NotOwner`, `NothingToWithdraw`). |
| `soroban/contracts/agent_account/src/vault_client.rs` (create) | Local `#[contractclient]` interface for the vault's `deposit`/`redeem`/`claim`/`balance` — avoids importing the vault wasm at build time (the 1d runtime path-dep / `__constructor` wasm link-collision lesson). |
| `soroban/contracts/agent_account/src/test.rs` (modify) | Add: constructor sets `allowance[agent][vault] == cap`; an end-to-end deposit-then-`owner_withdraw` sweep; `owner_withdraw` rejects a non-owner; the session key still cannot `approve`/`redeem` (negative). |
| `deployments/stellar-testnet.json` (modify) | Record the redeployed demo-agent address + the new `agent_account` wasm hash. |
| `frontend/src/stellar/config.js` (modify) | Sync `SOROBAN_DEMO_AGENT` to the redeployed address. |

---

## Task 1: Local vault client interface (no wasm import)

**Files:**
- Create: `soroban/contracts/agent_account/src/vault_client.rs`
- Modify: `soroban/contracts/agent_account/src/lib.rs` (add `mod vault_client;`)

**Interfaces:**
- Produces: a `VaultClient` generated by `#[contractclient]` exposing `deposit(from, amount) -> i128`, `redeem(from, shares) -> i128`, `claim(holder) -> i128`, `balance(id) -> i128`. Consumed by Task 3 (`owner_withdraw`).
- Rationale: importing the vault wasm into a sibling contract caused a `__constructor` link collision in sub-project 1d. A hand-written `#[contractclient]` trait gives the typed client with no build-time wasm dependency.

- [ ] **Step 1: Write the failing test**

Append to `soroban/contracts/agent_account/src/test.rs`:

```rust
#[test]
fn vault_client_iface_compiles_and_calls() {
    // Arrange: register the real vault wasm under test and a SAC token.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = env.register(
        rwa_vault::WASM,
        (admin.clone(), token.clone(), String::from_str(&env, "Vault"), String::from_str(&env, "vfVLT")),
    );
    // Act: call deposit through OUR local client (proves the iface matches the deployed vault).
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    let holder = Address::generate(&env);
    token_admin.mint(&holder, &100_000_000);
    soroban_sdk::token::TokenClient::new(&env, &token).approve(&holder, &vault, &100_000_000, &1_000_000);
    let shares = crate::vault_client::VaultClient::new(&env, &vault).deposit(&holder, &50_000_000);
    // Assert
    assert_eq!(shares, 50_000_000); // 1:1 stable NAV
    assert_eq!(crate::vault_client::VaultClient::new(&env, &vault).balance(&holder), 50_000_000);
}
```

> Add to `soroban/contracts/agent_account/Cargo.toml` `[dev-dependencies]` a path dep on the vault crate for `rwa_vault::WASM` in tests only:
> ```toml
> [dev-dependencies]
> rwa_vault = { path = "../rwa_vault" }
> ```
> **Pin-at-impl:** confirm the vault crate exposes a `WASM` const under `testutils` (it does via `#[contractimpl]`); if the crate name differs, match `soroban/contracts/rwa_vault/Cargo.toml` `[package].name`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account vault_client_iface -- --nocapture"`
Expected: FAIL — `cannot find module vault_client` / `VaultClient not found`.

- [ ] **Step 3: Write the minimal implementation**

Create `soroban/contracts/agent_account/src/vault_client.rs`:

```rust
// Local typed client for the deployed rwa_vault. Hand-written so we do NOT import the
// vault wasm at build time (a sibling-wasm import collided on __constructor in sub-project
// 1d). Signatures are copied verbatim from docs/soroban-interfaces.md — keep them in sync.
use soroban_sdk::{contractclient, Address, Env};

#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn deposit(env: Env, from: Address, amount: i128) -> i128;
    fn redeem(env: Env, from: Address, shares: i128) -> i128;
    fn claim(env: Env, holder: Address) -> i128;
    fn balance(env: Env, id: Address) -> i128;
}
```

Add to `soroban/contracts/agent_account/src/lib.rs` (with the other `mod` lines near the top):

```rust
pub mod vault_client;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account vault_client_iface -- --nocapture"`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && git add soroban/contracts/agent_account/src/vault_client.rs soroban/contracts/agent_account/src/lib.rs soroban/contracts/agent_account/src/test.rs soroban/contracts/agent_account/Cargo.toml && git commit -m 'feat(agent): local vault client interface (no wasm import)'"
```

---

## Task 2: Constructor self-approve — set `allowance[agent][vault] = cap`

**Files:**
- Modify: `soroban/contracts/agent_account/src/lib.rs` (`__constructor`)
- Modify: `soroban/contracts/agent_account/src/test.rs`

**Interfaces:**
- Consumes: `AgentScope { owner, vault, token, cap_per_period, period_duration, spent_in_period, period_start, expiry, revoked }` (already in `types.rs`); `soroban_sdk::token::TokenClient::approve(from, spender, amount, expiration_ledger)`.
- Produces: after deploy, `token.allowance(agent, vault) == scope.cap_per_period`, valid until a far-future ledger — so the deployed `vault.deposit` `transfer_from(spender=vault, from=agent)` succeeds without any session-key `approve`.

- [ ] **Step 1: Write the failing test**

Append to `soroban/contracts/agent_account/src/test.rs`:

```rust
#[test]
fn constructor_self_approves_vault_for_cap() {
    // Arrange
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = Address::generate(&env); // any address; approve does not call it
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let cap: i128 = 100_000_000;
    let scope = crate::types::AgentScope {
        owner: owner.clone(),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    // Act: deploy the agent with the constructor.
    let agent = env.register(crate::AgentAccount, (owner.clone(), signer, scope));
    // Assert: the agent pre-approved the vault to pull `cap` of the token.
    let allowance = soroban_sdk::token::TokenClient::new(&env, &token).allowance(&agent, &vault);
    assert_eq!(allowance, cap);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account constructor_self_approves -- --nocapture"`
Expected: FAIL — `assertion failed: left == right` (allowance is 0; constructor does not approve yet).

- [ ] **Step 3: Write the minimal implementation**

Edit `soroban/contracts/agent_account/src/lib.rs`. Update the imports and `__constructor`:

```rust
#![no_std]
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contractimpl, vec, Address, BytesN, Env, IntoVal, Symbol};

mod account;
pub mod types;
pub mod vault_client;
mod test;

use types::{AgentScope, DataKey};

// Allowance lives this many ledgers (~30 days at 5s) — long enough to outlast any session scope.
const APPROVE_TTL_LEDGERS: u32 = 518_400;

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    /// Deployed once per worker agent. `owner` = the human EOA that granted the scope;
    /// `signer` = the ephemeral ed25519 session pubkey the worker signs with. The constructor
    /// also self-approves the vault to pull up to `cap_per_period` of the asset, so the
    /// deployed vault's `transfer_from(spender=vault, from=agent)` works without the
    /// (deposit-only) session key ever signing an `approve`.
    pub fn __constructor(env: Env, owner: Address, signer: BytesN<32>, scope: AgentScope) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Scope, &scope);

        // Invoker-contract auth: authorize THIS contract's own sub-invocation of token.approve.
        // Bypasses __check_auth (that path is reserved for the session key + deposit only).
        let current = env.current_contract_address();
        let expiration_ledger = env.ledger().sequence() + APPROVE_TTL_LEDGERS;
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: scope.token.clone(),
                    fn_name: Symbol::new(&env, "approve"),
                    args: (
                        current.clone(),
                        scope.vault.clone(),
                        scope.cap_per_period,
                        expiration_ledger,
                    )
                        .into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        TokenClient::new(&env, &scope.token).approve(
            &current,
            &scope.vault,
            &scope.cap_per_period,
            &expiration_ledger,
        );
    }

    pub fn scope_of(env: Env) -> AgentScope {
        env.storage().instance().get(&DataKey::Scope).unwrap()
    }

    pub fn signer(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Signer).unwrap()
    }

    pub fn version(_env: Env) -> u32 {
        2
    }
}
```

> **Pin-at-impl:** `soroban_sdk::auth::{InvokerContractAuthEntry, SubContractInvocation, ContractContext}` and `env.authorize_as_current_contract(Vec<InvokerContractAuthEntry>)` are the soroban-sdk auth-module names. If `cargo build` reports a path/name mismatch on 26.1.0, correct against `soroban_sdk::auth` for the pinned version — the call shape (one `Contract` entry whose `context` matches the `approve` sub-call) is the invariant.

- [ ] **Step 4: Run the test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account constructor_self_approves -- --nocapture"`
Expected: PASS.

- [ ] **Step 5: Confirm `__check_auth` is untouched and still deposit-only**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account"`
Expected: PASS — every existing `account.rs` scope test (deposit allowed; non-deposit fn rejected; cap/expiry/revoke) stays green.

- [ ] **Step 6: Commit**

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && git add soroban/contracts/agent_account/src/lib.rs soroban/contracts/agent_account/src/test.rs && git commit -m 'feat(agent): constructor self-approves vault for cap (invoker-contract auth)'"
```

---

## Task 3: `owner_withdraw` — owner-gated exit sweep

**Files:**
- Modify: `soroban/contracts/agent_account/src/lib.rs` (add `owner_withdraw`)
- Modify: `soroban/contracts/agent_account/src/types.rs` (add error variants)
- Modify: `soroban/contracts/agent_account/src/test.rs`

**Interfaces:**
- Consumes: `VaultClient` (Task 1); `TokenClient`; `DataKey::Owner` / `DataKey::Scope`.
- Produces: `owner_withdraw(to: Address) -> i128` — `owner.require_auth()`-gated; redeems all the agent's vault shares + claims any dividend + transfers the agent's whole asset balance to `to`; returns the asset amount swept. This is how the user exits, since `vault.deposit` minted shares to the agent and the deposit-only session key can never redeem.

- [ ] **Step 1: Write the failing test**

Append to `soroban/contracts/agent_account/src/test.rs`:

```rust
#[test]
fn owner_withdraw_sweeps_principal_back_to_owner() {
    // Arrange: token + vault + agent (constructor pre-approves the vault).
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    let vault = env.register(
        rwa_vault::WASM,
        (admin.clone(), token.clone(), String::from_str(&env, "Vault"), String::from_str(&env, "vfVLT")),
    );
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let cap: i128 = 100_000_000;
    let scope = crate::types::AgentScope {
        owner: owner.clone(), vault: vault.clone(), token: token.clone(),
        cap_per_period: cap, period_duration: 3600, spent_in_period: 0,
        period_start: 0, expiry: env.ledger().timestamp() + 3600, revoked: false,
    };
    let agent = env.register(crate::AgentAccount, (owner.clone(), signer, scope));

    // Fund the agent and deposit (mock_all_auths stands in for the session-key path here;
    // the real session-key auth tree is Phase 2). Shares mint to the agent.
    token_admin.mint(&agent, &60_000_000);
    crate::vault_client::VaultClient::new(&env, &vault).deposit(&agent, &50_000_000);
    assert_eq!(crate::vault_client::VaultClient::new(&env, &vault).balance(&agent), 50_000_000);

    // Act: owner sweeps everything back.
    let swept = crate::AgentAccountClient::new(&env, &agent).owner_withdraw(&owner);

    // Assert: agent emptied, owner holds principal (50m redeemed + 10m never deposited).
    assert_eq!(crate::vault_client::VaultClient::new(&env, &vault).balance(&agent), 0);
    assert_eq!(token_client.balance(&agent), 0);
    assert_eq!(token_client.balance(&owner), 60_000_000);
    assert_eq!(swept, 60_000_000);
}

#[test]
fn owner_withdraw_rejects_non_owner() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let scope = crate::types::AgentScope {
        owner: owner.clone(), vault, token, cap_per_period: 1, period_duration: 3600,
        spent_in_period: 0, period_start: 0, expiry: env.ledger().timestamp() + 3600, revoked: false,
    };
    let agent = env.register(crate::AgentAccount, (owner.clone(), signer, scope));
    // Only the stranger authorizes — owner.require_auth() must fail.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &stranger,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &agent, fn_name: "owner_withdraw",
            args: (stranger.clone(),).into_val(&env), sub_invokes: &[],
        },
    }]);
    let res = crate::AgentAccountClient::new(&env, &agent).try_owner_withdraw(&stranger);
    assert!(res.is_err());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account owner_withdraw -- --nocapture"`
Expected: FAIL — `no method named owner_withdraw / try_owner_withdraw`.

- [ ] **Step 3: Write the minimal implementation**

Add error variants in `soroban/contracts/agent_account/src/types.rs` (extend the existing `AccountError` enum; keep existing discriminants, append new ones):

```rust
    // appended to AccountError (do not renumber existing variants)
    NotOwner = 20,
    NothingToWithdraw = 21,
```

Add the entrypoint to `soroban/contracts/agent_account/src/lib.rs` inside `impl AgentAccount` (after `scope_of`), plus the needed imports (`types::AccountError`, `vault_client::VaultClient`):

```rust
    /// Owner-gated exit. Redeems all of the agent's vault shares, claims any accrued dividend,
    /// and transfers the agent's whole asset balance to `to`. Authorized by the OWNER (not the
    /// session key) and by THIS contract as invoker for its own redeem/transfer sub-calls.
    /// Returns the asset amount swept to `to`.
    pub fn owner_withdraw(env: Env, to: Address) -> Result<i128, AccountError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AccountError::NotInit)?;
        owner.require_auth();

        let scope: AgentScope = env
            .storage()
            .instance()
            .get(&DataKey::Scope)
            .ok_or(AccountError::NotInit)?;
        let current = env.current_contract_address();
        let vault = scope.vault.clone();
        let token = scope.token.clone();
        let vault_client = VaultClient::new(&env, &vault);
        let token_client = TokenClient::new(&env, &token);

        // 1. Redeem all shares (vault.redeem calls from.require_auth() on the agent → invoker auth).
        let shares = vault_client.balance(&current);
        if shares > 0 {
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: vault.clone(),
                        fn_name: Symbol::new(&env, "redeem"),
                        args: (current.clone(), shares).into_val(&env),
                    },
                    sub_invocations: vec![&env],
                }),
            ]);
            vault_client.redeem(&current, &shares);
        }

        // 2. Claim any dividend (permissionless — no agent auth needed; pays the agent's balance).
        vault_client.claim(&current);

        // 3. Sweep the agent's whole asset balance to `to` (token.transfer needs agent auth → invoker auth).
        let bal = token_client.balance(&current);
        if bal <= 0 {
            return Err(AccountError::NothingToWithdraw);
        }
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (current.clone(), to.clone(), bal).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        token_client.transfer(&current, &to, &bal);

        env.storage().instance().extend_ttl(17_280, 518_400);
        Ok(bal)
    }
```

> **Pin-at-impl:** `claim` may return `NothingToClaim` (a `VaultError`) when there is no dividend. Use `vault_client.try_claim(&current).ok();` if a hard panic on an empty claim would abort the sweep — confirm the vault's `claim` error behavior in `rwa_vault/src/vault.rs` and switch to `try_claim` if needed. The sweep of shares + principal must never be blocked by a zero dividend.

- [ ] **Step 4: Run the test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account owner_withdraw -- --nocapture"`
Expected: PASS (2 tests). If `owner_withdraw_sweeps` traps on `claim`, apply the `try_claim` pin-at-impl note and re-run.

- [ ] **Step 5: Full suite + clippy + size**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account && cargo clippy -p agent_account -- -D warnings && stellar contract build && ls -la target/wasm32v1-none/release/agent_account.wasm"
```
Expected: all tests PASS, clippy clean, wasm built and < 64KB.

- [ ] **Step 6: Commit**

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && git add soroban/contracts/agent_account/src/lib.rs soroban/contracts/agent_account/src/types.rs soroban/contracts/agent_account/src/test.rs && git commit -m 'feat(agent): owner_withdraw exit sweep (redeem + claim + transfer via invoker auth)'"
```

---

## Task 4: Negative guard — session key still cannot approve/redeem

**Files:**
- Modify: `soroban/contracts/agent_account/src/test.rs`

**Interfaces:**
- Consumes: the existing `enforce_scope_for_test` shim in `account.rs` (deposit-only). Produces nothing — this locks the security invariant that the new powers did NOT leak into the session-key path.

- [ ] **Step 1: Write the test (it should pass immediately — proves the invariant held)**

Append to `soroban/contracts/agent_account/src/test.rs`:

```rust
#[test]
fn session_key_path_still_rejects_non_deposit_contexts() {
    use soroban_sdk::auth::{Context, ContractContext};
    let env = Env::default();
    let owner = Address::generate(&env);
    let token = Address::generate(&env);
    let vault = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let scope = crate::types::AgentScope {
        owner, vault: vault.clone(), token: token.clone(), cap_per_period: 1_000,
        period_duration: 3600, spent_in_period: 0, period_start: 0,
        expiry: env.ledger().timestamp() + 3600, revoked: false,
    };
    let agent = env.register(crate::AgentAccount, (Address::generate(&env), signer, scope));

    // An `approve@token` context must be rejected by the deposit-only enforcer.
    let approve_ctx = Context::Contract(ContractContext {
        contract: token,
        fn_name: Symbol::new(&env, "approve"),
        args: (1i128,).into_val(&env),
    });
    let res = env.as_contract(&agent, || {
        crate::AgentAccount::enforce_scope_for_test(env.clone(), vec![&env, approve_ctx])
    });
    assert!(res.is_err()); // FnNotAllowed — the session key never gained approve power
}
```

- [ ] **Step 2: Run it**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p agent_account session_key_path_still_rejects -- --nocapture"`
Expected: PASS — confirms `__check_auth` stayed deposit-only after the change.

> **Pin-at-impl:** if `enforce_scope_for_test`'s signature differs from `(Env, Vec<Context>)`, match the shim in `account.rs`. The assertion (a non-`deposit` fn context is rejected) is the invariant.

- [ ] **Step 3: Commit**

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && git add soroban/contracts/agent_account/src/test.rs && git commit -m 'test(agent): lock session-key path stays deposit-only after self-approve/withdraw'"
```

---

## Task 5: Redeploy the demo agent + sync addresses

**Files:**
- Modify: `deployments/stellar-testnet.json`
- Modify: `frontend/src/stellar/config.js`

**Interfaces:**
- Produces: a freshly deployed `agent_account` (v2) contract on testnet whose constructor sets the vault allowance, recorded in both the deployments file and `config.js` (`SOROBAN_DEMO_AGENT`). Phase 2/3 read this address.

- [ ] **Step 1: Build the optimized wasm**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"`
Expected: `target/wasm32v1-none/release/agent_account.wasm` written, < 64KB.

- [ ] **Step 2: Upload the wasm (record the hash)**

Run:
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract upload --wasm target/wasm32v1-none/release/agent_account.wasm --source demo --network testnet"
```
Expected: prints a 64-hex wasm hash. Record it.

> **Pin-at-impl:** identity is `demo` per the existing deploy scripts (`scripts/deploy-seed.sh`); if a different funded identity is configured, use that. stellar-cli is v27 (see memory notes); `--global` was dropped from `keys generate` in newer CLIs but `upload`/`deploy` are unaffected.

- [ ] **Step 3: Deploy a demo agent with constructor args**

The constructor is `(owner: Address, signer: BytesN<32>, scope: AgentScope)`. Use the demo owner address, a demo ed25519 pubkey (32 bytes hex), and a scope pointing at the deployed vault + token. `AgentScope` is a struct → pass as JSON.

```bash
wsl -e bash -lc 'cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && \
OWNER=$(stellar keys address demo) && \
stellar contract deploy --wasm-hash <WASM_HASH_FROM_STEP_2> --source demo --network testnet -- \
  --owner "$OWNER" \
  --signer <DEMO_SIGNER_32BYTE_HEX> \
  --scope '"'"'{"owner":"'"$OWNER"'","vault":"CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5","token":"CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4","cap_per_period":"100000000","period_duration":3600,"spent_in_period":"0","period_start":0,"expiry":4000000000,"revoked":false}'"'"' '
```
Expected: prints the new agent contract address `C…`.

> **Pin-at-impl:** `AgentScope` JSON field encoding — `i128` fields (`cap_per_period`, `spent_in_period`) are strings, `u64` fields (`period_duration`, `period_start`, `expiry`) are numbers, `bool` is `true/false`. This is the same untyped-Val→ScVal serde path proven in the sub-project 1c deploy (snake_case field names, see memory `soroban-1c-testnet-deploy-blocked`). If the CLI rejects the struct, verify field names against `types.rs` `AgentScope` and i128/u64 string-vs-number per that note.

- [ ] **Step 4: Verify the allowance was set on-chain**

Run:
```bash
wsl -e bash -lc 'cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && \
stellar contract invoke --id CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4 --source demo --network testnet -- \
  allowance --from <NEW_AGENT_ADDR> --spender CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
```
Expected: `"100000000"` — the constructor self-approve landed on live testnet (closes the loop the unit test mocks).

- [ ] **Step 5: Record addresses**

Update `deployments/stellar-testnet.json`: set the demo agent address + the new `agent_account` wasm hash (match the existing JSON shape). Update `frontend/src/stellar/config.js`:

```js
// Pre-seeded demo agent custom account (1a, v2 — constructor self-approves the vault).
export const SOROBAN_DEMO_AGENT = '<NEW_AGENT_ADDR>'
```

- [ ] **Step 6: Commit**

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && git add deployments/stellar-testnet.json frontend/src/stellar/config.js && git commit -m 'chore(agent): redeploy v2 agent_account (self-approve) + sync addresses'"
```

---

## Self-Review (Phase 1)

**Coverage of the Phase-1 goal:** the deployed-contract bind (agent can't `approve`, shares lock at the agent) is resolved by (Task 2) constructor self-approve and (Task 3) `owner_withdraw`. The differentiator is preserved — (Task 4) proves the session-key `__check_auth` is still deposit-only. (Task 1) gives a wasm-import-free vault client so the agent can redeem/claim without the 1d link-collision. (Task 5) lands it on testnet and proves the allowance on-chain.

**Placeholder scan:** every code step has complete Rust; every run step has an exact WSL command + expected output. The four genuine drift risks (`authorize_as_current_contract` path, `claim` empty-dividend behavior, `enforce_scope_for_test` signature, `AgentScope` CLI JSON encoding) are flagged as pin-at-impl with the exact thing to check and a fast proof, not left as TODO.

**Type consistency:** `VaultClient` methods (`deposit`/`redeem`/`claim`/`balance`) match `docs/soroban-interfaces.md` and are used identically in Tasks 1 and 3. `AgentScope` fields used in tests/deploy match `types.rs`. `owner_withdraw(to) -> Result<i128, AccountError>` is the same in impl, test, and the Phase-3 consumer below.

---

## Phases 2 & 3 — scoped, NOT in this plan (follow-on plans)

These complete the re-point. Each is its own writing-plans document with full TDD steps; the facts below are the verified seams so the next plan starts cold-cheap. **Do not implement them from this section.**

### Phase 2 — Frontend Stellar deposit auth-tree (the hard primitive SP3 deferred)
**New:** `frontend/src/stellar/agentDeposit.js` (+ test). **Goal:** build + session-key-sign the `vault.deposit(agent, amount)` authorization so the relayer can fee-bump it gaslessly.
- Build the invoke with `buildInvokeTx({ source: relayer, contract: SOROBAN_VAULT_ADDRESS, method: 'deposit', args: [{addr: agentAddr}, {i128: amount}] })` (already in `stellar/client.js`).
- The `deposit` sub-invocation requires the **agent**'s auth via `SorobanCredentials::Address`. Sign it with `authorizeEntry(entry, signer, validUntilLedger, networkPassphrase)` from `@stellar/stellar-sdk`, where the `signer` callback returns the **raw 64-byte ed25519 signature** the custom account's `__check_auth` expects (`sessionKey.sign(preimage)` from `stellar/sessionKey.js`, which already returns `BytesN<64>`-shaped bytes).
  - **Pin-at-impl:** verify `authorizeEntry`'s signer-callback return shape for a *custom account* on stellar-sdk's pinned version — for an Ed25519 classic signer it returns `{ signature, publicKey }`, but a custom account consumes a bare signature scval. Prove against a live testnet deposit in a Node smoke script (mirror `scripts/stellar-relay-smoke.mjs`), since unit tests mock the RPC.
- Submit via `submitViaRelay({ xdr })` (already shipped in `stellar/relay.js`).
- Pre-flight balance: `readContract({ contract: SOROBAN_TOKEN_ADDRESS, method: 'balance', args: [{addr: agentAddr}] })` — replaces `readUsdcBalance`.

### Phase 3 — Re-point orchestrator / worker / app / wallet (EVM → Stellar)
The exact EVM call sites to replace (verified this session):
- `worker.js` — replace whole EVM body: `setupKey()` (ethers + keyVault) → `newSessionKey()` (`stellar/sessionKey.js`); drop `relayRedeem` (no ERC-7715 fund step — the agent is pre-funded + pre-approved by Phase 1); replace `signAtSubmitSite`+`relayDepositHeld` with Phase-2 `agentDeposit`; `readShares()` → `readContract(vault,'balance',[agentAddr])`; `verifyDepositMined` polls the same.
- `orchestrator.js` — `worker.setupKey()` stays (now ed25519); replace `batchCalls([buildAuthorizeSessionKeyCall…])` (EIP-5792) with N user-signed `registry.authorize(...)` + agent-account deploys + agent funding, submitted via `walletKit.signTxXdr` + `submitUserTx`; `readUsdcBalance` → Stellar token balance read; drop `redelegation.js` (ERC-7710, EVM-only).
- `app.jsx` — `startExecution` builds the `OrchestratorAgent`; replace `permissionContext` (ERC-7715) wiring with the connected Stellar wallet address from `walletKit.getUserAddress()`; the `confirmPermission`→`execute` seam from the risk-council pipeline points `execute` at the re-pointed worker path.
- `wallet.js` — the connected-app screens import this EVM module; Phase 3 either swaps imports to `stellar/walletKit.js` or makes `wallet.js` re-export the Stellar connector. (Full EVM removal is the separate SP6 decommission plan, already drafted at `docs/superpowers/plans/2026-06-21-evm-decommission.md` — gated until this re-point lands.)
- Wire `owner_withdraw` (Task 3) into the existing redeem/exit UI (replaces `redeemFromVaultOnChain`).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-sp4-execution-repoint.md` (Phase 1 fully detailed; Phases 2–3 scoped as follow-on plans).

Two execution options:
1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute Phase-1 tasks in this session with checkpoints.

Note: every task runs `forge`-free Soroban tooling in WSL; the executor needs a funded testnet `demo` identity for Task 5.

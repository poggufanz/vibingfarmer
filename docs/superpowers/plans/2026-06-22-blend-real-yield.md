# Blend Real-Yield Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vault's mock `drip()` yield with real lending yield from Blend Capital (Soroban) — deposits are supplied into a Blend pool, accrued borrower interest is harvested and distributed as the existing pro-rata dividend.

**Architecture:** Keep the vault's stable-NAV shares + masterchef dividend index untouched. Add an optional Blend pool wiring: `deposit` supplies idle USDC into Blend, `redeem` withdraws from Blend, and a new `harvest()` (replacing `drip()` as the yield source) withdraws everything from Blend, measures `interest = vault_balance − total_principal`, re-supplies principal, and bumps the dividend index with the interest. Blend is reached through a **local `#[contractclient]` interface** (NOT the `blend-contract-sdk` crate — version clash, see below). `drip()` is retained as an offline-demo fallback. If no pool is set, the vault behaves exactly as today.

**Tech Stack:** Rust, soroban-sdk 26.1.0, stellar-tokens 0.7.2, Blend Protocol v2 (Soroban). Tests use a self-written mock Blend pool contract (the real `blend-contract-sdk` testutils are unusable — they pin soroban-sdk 25.0.1).

**Verified facts (2026-06-22):**
- `blend-contract-sdk` 2.25.0 → requires `soroban-sdk = 25.0.1`. Project is on `soroban-sdk 26.1.0`. **Do NOT add the crate** — single-soroban-sdk-version rule makes it a hard conflict. Cross-contract calls are ABI/XDR-level, so a local `#[contractclient]` at SDK 26 works fine.
- Testnet (network passphrase `Test SDF Network ; September 2015`):
  - USDC token: `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`
  - Blend lending pool V2 (id `TestnetV2`): `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`
  - poolFactoryV2: `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`
  - backstopV2: `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA`

**Build/test commands (WSL only):**
- Test: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"`
- Clippy: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy --all-targets -- -D warnings"`
- Build wasm: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"`

---

## File Structure

- `soroban/contracts/rwa_vault/src/blend.rs` — **new**. Local `#[contractclient]` Blend pool interface (`Request`, `RequestType` constants, `Positions`, `BlendPoolClient`) + thin `supply`/`withdraw` helpers the vault calls.
- `soroban/contracts/rwa_vault/src/storage.rs` — **modify**. Add `Pool` getter/setter (optional pool address).
- `soroban/contracts/rwa_vault/src/types.rs` — **modify**. Add `DataKey::Pool`, `VaultError::PoolNotSet`/`PoolAlreadySet`, `Harvest` event.
- `soroban/contracts/rwa_vault/src/vault.rs` — **modify**. `deposit`/`redeem` route through Blend when a pool is set; add `harvest()`.
- `soroban/contracts/rwa_vault/src/lib.rs` — **modify**. Expose `set_pool`, `pool`, `harvest`; register `mod blend`.
- `soroban/contracts/rwa_vault/src/test.rs` — **modify**. Add a mock Blend pool contract + Blend-path tests.
- `soroban/deploy-seed.sh` — **modify** (Task 8). Wire the testnet pool after deploy.

---

## Task 0: Pin the Blend ABI in a local client module

**Files:**
- Create: `soroban/contracts/rwa_vault/src/blend.rs`
- Modify: `soroban/contracts/rwa_vault/src/lib.rs:10` (add `mod blend;`)

- [ ] **Step 1: Create the Blend client interface**

Create `soroban/contracts/rwa_vault/src/blend.rs`:

```rust
//! Local, version-independent view of the Blend v2 pool contract.
//! We do NOT depend on `blend-contract-sdk` (it pins soroban-sdk 25.0.1; we are on 26.1.0).
//! Cross-contract calls are ABI/XDR-level, so this hand-written client interoperates with
//! the real Blend pool as long as the symbol + arg layout match (verified in Task 7 smoke).
use soroban_sdk::{contractclient, contracttype, Address, Env, Map, Vec};

// Blend v2 request_type discriminants (plain supply-to-earn; collateral/borrow unused).
pub const SUPPLY: u32 = 0;
pub const WITHDRAW: u32 = 1;

/// One action submitted to a Blend pool. `address` is the underlying asset (e.g. USDC).
#[contracttype]
#[derive(Clone)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

/// Blend's per-user position bundle. The vault ignores the contents; the type only needs
/// to decode without error. Keyed by reserve index.
#[contracttype]
#[derive(Clone)]
pub struct Positions {
    pub liabilities: Map<u32, i128>,
    pub collateral: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    /// Pulls tokens from `from` via a pre-approved allowance (`from` must `approve` the pool
    /// first). `spender`/`to` are the pool's accounting/recipient address — the vault passes
    /// its own address for all three.
    fn submit_with_allowance(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
}
```

- [ ] **Step 2: Register the module**

In `soroban/contracts/rwa_vault/src/lib.rs`, add after line 10 (`mod vault;`):

```rust
mod blend;
```

- [ ] **Step 3: Verify it compiles**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo build -p rwa_vault"`
Expected: builds clean (no usages yet → may warn `unused`; acceptable until Task 3).

- [ ] **Step 4: Commit**

```bash
git add soroban/contracts/rwa_vault/src/blend.rs soroban/contracts/rwa_vault/src/lib.rs
git commit -m "feat(vault): add local Blend pool client interface"
```

---

## Task 1: Add optional pool address storage

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/types.rs:9-15` (DataKey), `:20-27` (VaultError)
- Modify: `soroban/contracts/rwa_vault/src/storage.rs`
- Test: `soroban/contracts/rwa_vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

Add to `soroban/contracts/rwa_vault/src/test.rs` (after the constructor test):

```rust
#[test]
fn test_pool_unset_by_default_then_set_once() {
    let env = Env::default();
    let ctx = setup(&env);
    assert_eq!(ctx.vault.pool(), None);

    let pool = Address::generate(&env);
    ctx.vault.set_pool(&ctx.admin, &pool);
    assert_eq!(ctx.vault.pool(), Some(pool.clone()));

    // second set must fail (one-time wiring)
    let pool2 = Address::generate(&env);
    assert!(ctx.vault.try_set_pool(&ctx.admin, &pool2).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_pool_unset_by_default_then_set_once"`
Expected: FAIL — `no method named pool`/`set_pool`.

- [ ] **Step 3: Add the DataKey, errors, and storage accessors**

In `soroban/contracts/rwa_vault/src/types.rs`, add to the `DataKey` enum (after `Pending(Address),`):

```rust
    Pool, // optional Blend lending pool address (yield source)
```

Add to the `VaultError` enum (after `NothingToClaim = 6,`):

```rust
    PoolNotSet = 7,      // harvest/Blend op attempted with no pool wired
    PoolAlreadySet = 8,  // set_pool called twice
```

In `soroban/contracts/rwa_vault/src/storage.rs`, add at the end:

```rust
pub fn set_pool(e: &Env, pool: &Address) {
    e.storage().instance().set(&DataKey::Pool, pool);
}
pub fn get_pool(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::Pool)
}
```

- [ ] **Step 4: Add the contract methods**

In `soroban/contracts/rwa_vault/src/lib.rs`, update the storage import line (line 13-16) to include `get_pool, set_pool` and add `Option` to the soroban_sdk import on line 2.

Line 2 becomes:
```rust
use soroban_sdk::{contract, contractimpl, Address, Env, String, Symbol, Vec};
```
(unchanged — `Option` is core, no import needed.)

Add these methods inside `impl RwaVault` (after `pub fn drip_epoch`):

```rust
    pub fn pool(e: &Env) -> Option<Address> {
        storage::get_pool(e)
    }

    /// One-time admin wiring of the Blend lending pool. Once set, deposits supply into it.
    pub fn set_pool(e: &Env, caller: Address, pool: Address) -> Result<(), types::VaultError> {
        let admin = access_control::get_admin(e).unwrap();
        if admin != caller {
            return Err(types::VaultError::PoolNotSet); // not admin
        }
        caller.require_auth();
        if storage::get_pool(e).is_some() {
            return Err(types::VaultError::PoolAlreadySet);
        }
        storage::set_pool(e, &pool);
        extend_instance(e);
        Ok(())
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_pool_unset_by_default_then_set_once"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add soroban/contracts/rwa_vault/src/types.rs soroban/contracts/rwa_vault/src/storage.rs soroban/contracts/rwa_vault/src/lib.rs soroban/contracts/rwa_vault/src/test.rs
git commit -m "feat(vault): add one-time Blend pool wiring (set_pool/pool)"
```

---

## Task 2: Mock Blend pool contract for tests

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/test.rs` (top, after imports)

- [ ] **Step 1: Write the mock pool contract**

Add to `soroban/contracts/rwa_vault/src/test.rs` after the existing `use` lines (before `const U7`):

```rust
use crate::blend::{Positions, Request, SUPPLY, WITHDRAW};
use soroban_sdk::{contract, contractimpl, Map};

// Minimal in-test stand-in for a Blend v2 pool. Tracks each supplier's underlying balance
// and moves the real SAC token. `accrue` simulates borrower interest by crediting a
// supplier (the test must also mint the matching tokens into the pool).
#[contract]
pub struct MockBlendPool;

#[contractimpl]
impl MockBlendPool {
    pub fn __constructor(e: &Env, token: Address) {
        e.storage().instance().set(&MOCK_TOKEN, &token);
    }

    pub fn submit_with_allowance(
        e: &Env,
        from: Address,
        _spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        let token: Address = e.storage().instance().get(&MOCK_TOKEN).unwrap();
        let pool = e.current_contract_address();
        for req in requests.iter() {
            if req.request_type == SUPPLY {
                TokenClient::new(e, &token).transfer_from(&pool, &from, &pool, &req.amount);
                let bal = mock_supplied(e, &from) + req.amount;
                e.storage().persistent().set(&MockKey::Supplied(from.clone()), &bal);
            } else if req.request_type == WITHDRAW {
                let held = mock_supplied(e, &from);
                let amt = if req.amount > held { held } else { req.amount };
                TokenClient::new(e, &token).transfer(&pool, &to, &amt);
                e.storage().persistent().set(&MockKey::Supplied(from.clone()), &(held - amt));
            }
        }
        Positions {
            liabilities: Map::new(e),
            collateral: Map::new(e),
            supply: Map::new(e),
        }
    }

    /// Test-only: simulate accrued interest for `who`. Caller must have minted `extra`
    /// tokens into this pool's balance beforehand.
    pub fn accrue(e: &Env, who: Address, extra: i128) {
        let bal = mock_supplied(e, &who) + extra;
        e.storage().persistent().set(&MockKey::Supplied(who), &bal);
    }

    pub fn supplied(e: &Env, who: Address) -> i128 {
        mock_supplied(e, &who)
    }
}

const MOCK_TOKEN: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MTOKEN");

#[soroban_sdk::contracttype]
enum MockKey {
    Supplied(Address),
}

fn mock_supplied(e: &Env, who: &Address) -> i128 {
    e.storage().persistent().get(&MockKey::Supplied(who.clone())).unwrap_or(0)
}
```

- [ ] **Step 2: Add a helper to register the mock pool + wire it**

Add to `soroban/contracts/rwa_vault/src/test.rs` (after `fund_admin_treasury`):

```rust
// Registers a mock Blend pool on the same SAC asset and wires it into the vault.
fn with_blend_pool(env: &Env, ctx: &Ctx) -> MockBlendPoolClient<'static> {
    let pool_id = env.register(MockBlendPool, (ctx.token.clone(),));
    ctx.vault.set_pool(&ctx.admin, &pool_id);
    MockBlendPoolClient::new(env, &pool_id)
}
```

- [ ] **Step 3: Verify it compiles**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_pool_unset_by_default_then_set_once"`
Expected: PASS (existing test still green; mock compiles, `with_blend_pool` unused-warns until Task 3).

- [ ] **Step 4: Commit**

```bash
git add soroban/contracts/rwa_vault/src/test.rs
git commit -m "test(vault): add mock Blend pool contract + wiring helper"
```

---

## Task 3: deposit supplies into Blend when a pool is set

**Files:**
- Create helpers in: `soroban/contracts/rwa_vault/src/blend.rs`
- Modify: `soroban/contracts/rwa_vault/src/vault.rs:17-36` (deposit)
- Test: `soroban/contracts/rwa_vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

Add to `soroban/contracts/rwa_vault/src/test.rs`:

```rust
#[test]
fn test_deposit_supplies_into_blend_when_pool_set() {
    let env = Env::default();
    let ctx = setup(&env);
    let pool = with_blend_pool(&env, &ctx);
    let vault_addr = ctx.vault.address.clone();

    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);
    ctx.vault.deposit(&alice, &(500 * U7));

    // Shares minted 1:1, but the USDC now lives in Blend, not idle in the vault.
    assert_eq!(ctx.vault.balance(&alice), 500 * U7);
    assert_eq!(ctx.vault.total_principal(), 500 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
    assert_eq!(pool.supplied(&vault_addr), 500 * U7);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_deposit_supplies_into_blend_when_pool_set"`
Expected: FAIL — vault balance is `500*U7`, pool.supplied is `0` (deposit keeps funds idle).

- [ ] **Step 3: Add Blend supply/withdraw helpers**

Append to `soroban/contracts/rwa_vault/src/blend.rs`:

```rust
use soroban_sdk::{vec, token::TokenClient};

const APPROVE_TTL: u32 = 100; // ledgers the pool allowance stays live (consumed same tx)

/// Vault supplies `amount` of `token` into the Blend `pool`. Approves the pool to pull
/// from the vault, then submits a SUPPLY request. Vault is from/spender/to.
pub fn supply(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let vault = e.current_contract_address();
    let exp = e.ledger().sequence() + APPROVE_TTL;
    TokenClient::new(e, token).approve(&vault, pool, &amount, &exp);
    let reqs = vec![
        e,
        Request { request_type: SUPPLY, address: token.clone(), amount },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&vault, &vault, &vault, &reqs);
}

/// Vault withdraws `amount` of `token` from the Blend `pool` back to itself.
/// Blend caps the withdrawal at the vault's available position.
pub fn withdraw(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let vault = e.current_contract_address();
    let reqs = vec![
        e,
        Request { request_type: WITHDRAW, address: token.clone(), amount },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&vault, &vault, &vault, &reqs);
}
```

- [ ] **Step 4: Route deposit through Blend**

In `soroban/contracts/rwa_vault/src/vault.rs`, update the `use` at the top of the file to add the pool getter — change line 6 to:

```rust
use crate::storage::{extend_instance, get_pool, get_token, get_total_principal, set_total_principal, SCALE};
```

In `deposit`, replace the line `set_total_principal(e, get_total_principal(e) + amount);` (line 30) — keep it, and immediately after the existing `TokenClient::new(e, &token).transfer_from(...)` (line 26), add the Blend supply. The function body becomes:

```rust
    from.require_auth();

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer_from(&vault, &from, &vault, &amount);

    // Park principal in Blend to earn real yield (if wired). Otherwise it sits idle (legacy).
    if let Some(pool) = get_pool(e) {
        crate::blend::supply(e, &pool, &token, amount);
    }

    settle(e, &from); // bank any prior dividend at the old balance
    Base::mint(e, &from, amount); // shares == amount (1:1)
    set_total_principal(e, get_total_principal(e) + amount);
    sync_debt(e, &from); // reset reward debt to the new balance

    extend_instance(e);
    Deposit { holder: from, amount, shares: amount }.publish(e);
    Ok(amount)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"`
Expected: PASS for the new test AND all legacy deposit tests (no pool set → idle path unchanged).

- [ ] **Step 6: Commit**

```bash
git add soroban/contracts/rwa_vault/src/blend.rs soroban/contracts/rwa_vault/src/vault.rs soroban/contracts/rwa_vault/src/test.rs
git commit -m "feat(vault): supply deposits into Blend pool when wired"
```

---

## Task 4: redeem withdraws from Blend when a pool is set

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/vault.rs:41-66` (redeem)
- Test: `soroban/contracts/rwa_vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

Add to `soroban/contracts/rwa_vault/src/test.rs`:

```rust
#[test]
fn test_redeem_withdraws_from_blend() {
    let env = Env::default();
    let ctx = setup(&env);
    let pool = with_blend_pool(&env, &ctx);
    let vault_addr = ctx.vault.address.clone();

    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);
    ctx.vault.deposit(&alice, &(500 * U7));

    let assets = ctx.vault.redeem(&alice, &(200 * U7));
    assert_eq!(assets, 200 * U7);
    assert_eq!(ctx.vault.balance(&alice), 300 * U7);
    assert_eq!(ctx.vault.total_principal(), 300 * U7);
    // Alice got her 200 back; the rest stays in Blend, none idle in the vault.
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 700 * U7);
    assert_eq!(pool.supplied(&vault_addr), 300 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_redeem_withdraws_from_blend"`
Expected: FAIL — redeem tries to `transfer` from the vault but the vault holds 0 (funds are in Blend) → token error/panic.

- [ ] **Step 3: Route redeem through Blend**

In `soroban/contracts/rwa_vault/src/vault.rs`, in `redeem`, just before the final asset transfer block (lines 59-61: `let token = get_token(e); let vault = ...; TokenClient::new(e, &token).transfer(&vault, &from, &assets);`), pull the assets out of Blend first. Replace that block with:

```rust
    let token = get_token(e);
    let vault = e.current_contract_address();
    // Pull the redeemed assets out of Blend back into the vault before paying out.
    // ponytail: assumes pool liquidity is available; if Blend is at 100% utilization the
    // withdraw under-fills and the transfer below traps — acceptable for testnet/demo,
    // production would queue a partial redemption.
    if let Some(pool) = get_pool(e) {
        crate::blend::withdraw(e, &pool, &token, assets);
    }
    TokenClient::new(e, &token).transfer(&vault, &from, &assets);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"`
Expected: PASS for the new test and all legacy redeem tests.

- [ ] **Step 5: Commit**

```bash
git add soroban/contracts/rwa_vault/src/vault.rs soroban/contracts/rwa_vault/src/test.rs
git commit -m "feat(vault): withdraw from Blend pool on redeem"
```

---

## Task 5: harvest() — real yield distribution

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/types.rs` (add `Harvest` event)
- Modify: `soroban/contracts/rwa_vault/src/vault.rs` (add `harvest`)
- Modify: `soroban/contracts/rwa_vault/src/lib.rs` (expose `harvest`)
- Test: `soroban/contracts/rwa_vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

Add to `soroban/contracts/rwa_vault/src/test.rs`:

```rust
#[test]
fn test_harvest_distributes_blend_interest_as_dividend() {
    let env = Env::default();
    let ctx = setup(&env);
    let pool = with_blend_pool(&env, &ctx);
    let vault_addr = ctx.vault.address.clone();

    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);
    ctx.vault.deposit(&alice, &(500 * U7)); // principal now in Blend

    // Simulate 50 units of borrower interest accruing to the vault's Blend position.
    // The pool must actually hold those tokens to pay them out.
    StellarAssetClient::new(&env, &ctx.token).mint(&pool.address, &(50 * U7));
    pool.accrue(&vault_addr, &(50 * U7));

    let harvested = ctx.vault.harvest();
    assert_eq!(harvested, 50 * U7); // only the interest, not principal

    // Principal is back in Blend; interest sits idle in the vault awaiting claims.
    assert_eq!(pool.supplied(&vault_addr), 500 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 50 * U7);
    assert_eq!(ctx.vault.total_principal(), 500 * U7);

    // Alice can now claim the full interest (sole holder).
    assert_eq!(ctx.vault.claimable(&alice), 50 * U7);
    let paid = ctx.vault.claim(&alice);
    assert_eq!(paid, 50 * U7);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 550 * U7);
}

#[test]
fn test_harvest_requires_pool() {
    let env = Env::default();
    let ctx = setup(&env);
    assert!(ctx.vault.try_harvest().is_err()); // PoolNotSet
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_harvest"`
Expected: FAIL — `no method named harvest`.

- [ ] **Step 3: Add the Harvest event**

In `soroban/contracts/rwa_vault/src/types.rs`, add after the `Drip` event:

```rust
#[contractevent(topics = ["vault_harvest"])]
pub struct Harvest {
    pub epoch: u64,
    pub interest: i128,          // real yield distributed this harvest
    pub acc_div_per_share: i128, // new cumulative index
    pub total_shares: i128,
}
```

- [ ] **Step 4: Implement harvest**

In `soroban/contracts/rwa_vault/src/vault.rs`, add after the `drip` function. Note it reuses the existing `get_acc/set_acc`, `get_drip_epoch/set_drip_epoch`, `SCALE`, `get_total_principal` imports already in the file (drip uses them):

```rust
use crate::types::Harvest;

/// Permissionless real-yield harvest. Withdraws the vault's entire Blend position, measures
/// `interest = vault_balance − total_principal`, re-supplies the principal, and bumps the
/// dividend index with the interest (which stays idle in the vault for `claim`).
/// ponytail: withdraw-all + re-supply is 2 pool calls per harvest (gas) and reads interest
/// from the realized balance delta instead of Blend's bToken exchange-rate — robust and
/// exact for demo; a production build would read the reserve b_rate to avoid the round-trip.
#[when_not_paused]
pub fn harvest(e: &Env) -> Result<i128, VaultError> {
    let pool = get_pool(e).ok_or(VaultError::PoolNotSet)?;
    let supply = Base::total_supply(e);
    if supply <= 0 {
        return Err(VaultError::NoShares);
    }

    let token = get_token(e);
    let vault = e.current_contract_address();
    let principal = get_total_principal(e);

    // Pull everything out of Blend. i128::MAX → Blend caps at the full position.
    let before = TokenClient::new(e, &token).balance(&vault);
    crate::blend::withdraw(e, &pool, &token, i128::MAX);
    let after = TokenClient::new(e, &token).balance(&vault);
    let pulled = after - before;

    let interest = pulled - principal;
    if interest <= 0 {
        // Nothing earned yet — put principal back and report zero.
        crate::blend::supply(e, &pool, &token, pulled);
        return Ok(0);
    }

    // Re-supply principal; keep `interest` idle in the vault for claims.
    crate::blend::supply(e, &pool, &token, principal);

    let add = interest.checked_mul(SCALE).ok_or(VaultError::MathOverflow)? / supply;
    let acc = get_acc(e).checked_add(add).ok_or(VaultError::MathOverflow)?;
    set_acc(e, acc);
    let epoch = get_drip_epoch(e) + 1;
    set_drip_epoch(e, epoch);

    extend_instance(e);
    Harvest { epoch, interest, acc_div_per_share: acc, total_shares: supply }.publish(e);
    Ok(interest)
}
```

- [ ] **Step 5: Expose harvest in the contract surface**

In `soroban/contracts/rwa_vault/src/lib.rs`, add inside `impl RwaVault` (after the `drip` method):

```rust
    /// Permissionless real-yield harvest from the wired Blend pool. Returns interest distributed.
    pub fn harvest(e: &Env) -> Result<i128, types::VaultError> {
        vault::harvest(e)
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault"`
Expected: PASS — both new harvest tests and the full existing suite.

- [ ] **Step 7: Commit**

```bash
git add soroban/contracts/rwa_vault/src/types.rs soroban/contracts/rwa_vault/src/vault.rs soroban/contracts/rwa_vault/src/lib.rs soroban/contracts/rwa_vault/src/test.rs
git commit -m "feat(vault): harvest real Blend interest as dividend"
```

---

## Task 6: End-to-end multi-holder yield test

**Files:**
- Test: `soroban/contracts/rwa_vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

Add to `soroban/contracts/rwa_vault/src/test.rs`:

```rust
#[test]
fn test_blend_yield_splits_pro_rata_across_holders() {
    let env = Env::default();
    let ctx = setup(&env);
    let pool = with_blend_pool(&env, &ctx);
    let vault_addr = ctx.vault.address.clone();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 1_000 * U7);
    fund_and_approve(&env, &ctx, &bob, 1_000 * U7);

    ctx.vault.deposit(&alice, &(300 * U7)); // 75%
    ctx.vault.deposit(&bob, &(100 * U7));   // 25%

    // 80 units interest on 400 principal.
    StellarAssetClient::new(&env, &ctx.token).mint(&pool.address, &(80 * U7));
    pool.accrue(&vault_addr, &(80 * U7));
    ctx.vault.harvest();

    assert_eq!(ctx.vault.claimable(&alice), 60 * U7); // 75% of 80
    assert_eq!(ctx.vault.claimable(&bob), 20 * U7);   // 25% of 80
    assert_eq!(pool.supplied(&vault_addr), 400 * U7); // principal intact in Blend
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault test_blend_yield_splits_pro_rata_across_holders"`
Expected: PASS (logic already built in Tasks 3-5; this is a regression guard for pro-rata split).

- [ ] **Step 3: Run the full suite + clippy**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test -p rwa_vault && cargo clippy --all-targets -- -D warnings"`
Expected: all tests PASS, clippy clean.

- [ ] **Step 4: Commit**

```bash
git add soroban/contracts/rwa_vault/src/test.rs
git commit -m "test(vault): pro-rata Blend yield split across holders"
```

---

## Task 7: Testnet smoke verification (manual, against real Blend)

**Files:**
- None (manual verification — confirms the local client ABI matches real Blend v2).

- [ ] **Step 1: Build the wasm**

Run: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"`
Expected: `rwa_vault.wasm` produced under `target/wasm32v1-none/release/`.

- [ ] **Step 2: Confirm the real Blend `submit_with_allowance` signature**

Fetch the v2 pool interface and confirm symbol + arg order match `blend.rs`:
Run: `wsl -e bash -lc "curl -s https://raw.githubusercontent.com/blend-capital/blend-contracts-v2/main/pool/src/contract.rs | grep -nA6 'fn submit_with_allowance\|pub struct Request\|pub struct Positions'"`
Expected: `submit_with_allowance(from, spender, to, requests: Vec<Request>)`, `Request { request_type, address, amount }`, `Positions { liabilities, collateral, supply }`. If field order/names differ, update `soroban/contracts/rwa_vault/src/blend.rs` to match exactly, re-run Task 0 Step 3 + the full test suite, then continue.

- [ ] **Step 3: Deploy + wire against testnet and run one live cycle**

Using the verified addresses (USDC `CAQCFVLOBK5...AVSRCJU`, pool `CCEBVDYM32Y...PQ44HGF`), deploy the vault with the USDC token, then exercise the path with the Stellar CLI (substitute `$VAULT` with the deployed id and `$SRC` with a funded testnet identity holding testnet USDC):

```bash
wsl -e bash -lc '
cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban
NET="--network testnet --source $SRC"
stellar contract invoke $NET --id $VAULT -- set_pool --caller $SRC --pool CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
stellar contract invoke $NET --id $VAULT -- deposit --from $SRC --amount 100000000
stellar contract invoke $NET --id $VAULT -- pool
'
```
Expected: `set_pool` succeeds; `deposit` succeeds and the USDC lands in the Blend pool (no panic = the ABI matches). A failed cross-contract decode here means `blend.rs` types are wrong — fix and repeat Step 2.

- [ ] **Step 4: Record the outcome**

Note in the commit message whether the live deposit succeeded. Do NOT block the merge on `harvest` showing nonzero interest (testnet pools accrue slowly); the supply/withdraw round-trip succeeding is the smoke-pass bar.

- [ ] **Step 5: Commit (docs/notes only if changed)**

```bash
git add -A
git commit -m "chore(vault): verify Blend ABI + testnet supply smoke"
```

---

## Task 8: Wire the pool in deploy-seed + frontend config

**Files:**
- Modify: `soroban/deploy-seed.sh`
- Modify: `deployments/stellar-testnet.json`
- Modify: `frontend/src/config.js` (add pool address; no behavior change required)

- [ ] **Step 1: Add the pool wiring to deploy-seed**

In `soroban/deploy-seed.sh`, after the vault deploy + constructor step, add a `set_pool` invoke against the testnet Blend pool. Locate the line that deploys/constructs the vault and append:

```bash
echo "Wiring Blend lending pool into vault..."
stellar contract invoke \
  --network testnet --source "$ADMIN_IDENTITY" \
  --id "$VAULT_ID" -- \
  set_pool --caller "$ADMIN_ADDRESS" \
  --pool CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
```
(Use the script's existing variable names for the admin identity/address and `$VAULT_ID`; grep the file for the constructor invoke to match them.)

- [ ] **Step 2: Record the pool in deployments JSON**

In `deployments/stellar-testnet.json`, add a `blendPool` field alongside the existing vault/token entries:

```json
  "blendPool": "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
```

- [ ] **Step 3: Surface the pool in frontend config**

In `frontend/src/config.js`, add the pool address to the Stellar address block (next to the vault/token addresses) so the UI/docs can reference the live yield source:

```js
export const BLEND_POOL_ADDRESS = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
```

- [ ] **Step 4: Verify frontend still builds/tests green**

Run: `cd frontend && npm test && npm run build`
Expected: existing suite PASS, build green (this is an additive constant; nothing consumes it yet).

- [ ] **Step 5: Commit**

```bash
git add soroban/deploy-seed.sh deployments/stellar-testnet.json frontend/src/config.js
git commit -m "chore: wire Blend testnet pool in deploy-seed + config"
```

---

## Self-Review

**Spec coverage:**
- Replace mock yield with real Blend yield → Task 5 (`harvest`), Tasks 3-4 (supply/withdraw plumbing). ✅
- Keep deposit-only, single-asset, no IL → no swap/pair logic added; only supply/withdraw of the one asset. ✅
- No `blend-contract-sdk` dependency (version clash) → Task 0 local `#[contractclient]`. ✅
- Real integration test without testutils → Task 2 mock pool + Tasks 3-6 tests. ✅
- `drip()` retained as fallback → untouched in `vault.rs`/`lib.rs`; deposit/redeem keep the no-pool legacy path. ✅
- Testnet ABI match risk → Task 7 Step 2 verifies against real source. ✅
- Deploy/config wiring → Task 8. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 7/8 reference existing script variables by instruction to grep — concrete, not placeholder (the surrounding script is pre-existing and not reproduced here to avoid drift).

**Type consistency:** `Request{request_type,address,amount}`, `SUPPLY=0`/`WITHDRAW=1`, `BlendPoolClient`, `submit_with_allowance(from,spender,to,requests)`, `Positions{liabilities,collateral,supply}` used identically in `blend.rs` (Task 0), helpers (Task 3), and mock (Task 2). `get_pool`/`set_pool`, `VaultError::PoolNotSet/PoolAlreadySet`, `Harvest` event, `harvest()` consistent across tasks. `MockBlendPoolClient` is the soroban-generated client for the Task 2 mock, used in Tasks 3-6.

**Known ceiling (named in code):** `harvest` reads interest from the realized withdraw-all balance delta (2 pool calls/harvest) rather than Blend's bToken exchange rate; `redeem` assumes pool liquidity is available. Both flagged with `ponytail:` comments and acceptable for the demo/testnet target; production upgrade paths noted inline.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-blend-real-yield.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

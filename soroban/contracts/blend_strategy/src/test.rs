#![cfg(test)]
use crate::{BlendStrategy, BlendStrategyClient};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, Address, Env, Map, Vec};

use crate::blend::{Positions, Request, SUPPLY, WITHDRAW};

// Minimal in-test stand-in for a Blend v2 pool. Tracks each supplier's underlying balance
// and moves the real SAC token 1:1 (mirrors rwa_vault/src/test.rs's MockBlendPool).
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
                e.storage()
                    .persistent()
                    .set(&MockKey::Supplied(from.clone()), &bal);
                // Task 4: `credit_yield` has no `who` — remember the (sole) supplier so it
                // knows whose position to credit.
                e.storage().instance().set(&MOCK_SUPPLIER, &from);
            } else if req.request_type == WITHDRAW {
                let held = mock_supplied(e, &from);
                let amt = if req.amount > held { held } else { req.amount };
                TokenClient::new(e, &token).transfer(&pool, &to, &amt);
                e.storage()
                    .persistent()
                    .set(&MockKey::Supplied(from.clone()), &(held - amt));
            }
        }
        Positions {
            liabilities: Map::new(e),
            collateral: Map::new(e),
            supply: Map::new(e),
        }
    }

    /// Test-only: simulate Blend interest accruing to the sole supplier's position. Mints
    /// `amount` extra tokens into the pool's own balance (so a subsequent withdraw-all can
    /// actually pay it out) and credits the last-seen supplier's tracked position.
    pub fn credit_yield(e: &Env, amount: i128) {
        let token: Address = e.storage().instance().get(&MOCK_TOKEN).unwrap();
        let pool = e.current_contract_address();
        StellarAssetClient::new(e, &token).mint(&pool, &amount);

        let supplier: Address = e.storage().instance().get(&MOCK_SUPPLIER).unwrap();
        let bal = mock_supplied(e, &supplier) + amount;
        e.storage()
            .persistent()
            .set(&MockKey::Supplied(supplier), &bal);
    }

    /// Test-only: simulate a Blend pool shortfall (socialized bad debt) — the inverse of
    /// `credit_yield`. Reduces the sole supplier's tracked position by `amount` without
    /// moving any tokens, so a subsequent withdraw-all pays out less than was supplied.
    pub fn haircut_position(e: &Env, amount: i128) {
        let supplier: Address = e.storage().instance().get(&MOCK_SUPPLIER).unwrap();
        let bal = mock_supplied(e, &supplier) - amount;
        e.storage()
            .persistent()
            .set(&MockKey::Supplied(supplier), &bal);
    }
}

const MOCK_TOKEN: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MTOKEN");
const MOCK_SUPPLIER: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MSUPPL");

#[soroban_sdk::contracttype]
enum MockKey {
    Supplied(Address),
}

fn mock_supplied(e: &Env, who: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&MockKey::Supplied(who.clone()))
        .unwrap_or(0)
}

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals

pub(crate) struct Ctx {
    pub strategy: BlendStrategyClient<'static>,
    pub vault: Address,
    pub token: Address,
    pub pool: Address,
}

// Deploys a mock SAC token, a mock Blend pool wired to it, and the strategy wired to both.
// `vault` is a plain generated address standing in for the real vault (Task 7 wires it for
// real); mints it 1000 USDC and approves the strategy to pull on deposit, matching the
// "vault approves strategy before deposit" contract noted in the task brief.
fn setup(e: &Env) -> Ctx {
    // `_allowing_non_root_auth`: `credit_yield` (Task 4) mints via `StellarAssetClient` from
    // *inside* the mock pool contract, so the SAC's admin auth is nested one level below the
    // pool's own top-level invocation — plain `mock_all_auths` rejects that as "not tied to
    // the root contract invocation".
    e.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let pool = e.register(MockBlendPool, (token.clone(),));

    let vault = Address::generate(e);
    let blnd = Address::generate(e);
    let router = Address::generate(e);

    let strategy_id = e.register(
        BlendStrategy,
        (
            vault.clone(),
            pool.clone(),
            token.clone(),
            blnd,
            router,
            7u32,
        ),
    );

    StellarAssetClient::new(e, &token).mint(&vault, &(1_000 * U7));
    let exp = e.ledger().sequence() + 100_000;
    TokenClient::new(e, &token).approve(&vault, &strategy_id, &(1_000 * U7), &exp);

    Ctx {
        strategy: BlendStrategyClient::new(e, &strategy_id),
        vault,
        token,
        pool,
    }
}

#[test]
fn deposit_pulls_from_vault_and_supplies_pool() {
    let e = Env::default();
    let ctx = setup(&e);

    ctx.strategy.deposit(&(100 * U7));

    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.pool),
        100 * U7
    );
    assert_eq!(ctx.strategy.balance(), 100 * U7);
}

#[test]
fn withdraw_returns_actual_and_decrements_principal() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let got = ctx.strategy.withdraw(&(40 * U7));

    assert_eq!(got, 40 * U7);
    assert_eq!(ctx.strategy.balance(), 60 * U7);
    // vault: 1000 - 100 (deposit) + 40 (withdraw) = 940
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        940 * U7
    );
}

#[test]
fn withdraw_max_drains() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let got = ctx.strategy.withdraw(&i128::MAX);

    assert_eq!(got, 100 * U7);
    assert_eq!(ctx.strategy.balance(), 0);
}

#[test]
fn deposit_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    // Strip the blanket auth mock: deposit's `vault.require_auth()` now has no matching
    // authorization entry for the stored vault address, so the call must fail closed.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_deposit(&(10 * U7)).is_err());
}

#[test]
fn withdraw_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    // Same auth gate as deposit — withdraw's `vault.require_auth()` must also fail closed
    // once the blanket auth mock is stripped.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_withdraw(&(10 * U7)).is_err());
}

#[test]
fn harvest_realizes_interest_and_forwards_to_vault() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.credit_yield(&(7 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 7 * U7);
    // vault: 1000 - 100 (deposit) + 7 (harvested interest) = 907
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        907 * U7
    );
    // Principal re-supplied in full — book balance unchanged by harvest.
    assert_eq!(ctx.strategy.balance(), 100 * U7);
}

#[test]
fn harvest_zero_interest_returns_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    assert_eq!(ctx.strategy.balance(), 100 * U7);
    // vault: 1000 - 100 (deposit), untouched by a zero-gain harvest.
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7
    );
}

#[test]
fn harvest_marks_down_principal_on_shortfall() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    // Pool lost 10 to socialized bad debt — withdraw-all now returns only 90 of the 100
    // book principal.
    pool.haircut_position(&(10 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    // No gain to forward — vault balance untouched by a shortfall harvest.
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7
    );
    // Marked down to what was actually recovered (90), not still overstating 100.
    assert_eq!(ctx.strategy.balance(), 90 * U7);
}

#[test]
fn harvest_zero_principal_returns_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    // No deposit — principal is 0, harvest should short-circuit before touching Blend.

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    assert_eq!(ctx.strategy.balance(), 0);
    // Early-return path never reaches `.publish()` — no event side effects.
    assert_eq!(e.events().all().events().len(), 0);
}

#[test]
fn harvest_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    // Same auth gate as deposit/withdraw — harvest's `vault.require_auth()` must also fail
    // closed once the blanket auth mock is stripped.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_harvest(&0).is_err());
}

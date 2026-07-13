#![cfg(test)]
use crate::types::{Compound, LifeboatEngaged, LifeboatResumed, Rebalance, VaultError};
use crate::vault::DEAD_SHARES;
use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env, Event, String, Vec};

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals (1 USDC)

// A minimal strategy contract implementing the locked `StrategyIface` (deposit/withdraw/
// balance/harvest) over a plain token balance — no Blend, so vault tests stay single-crate.
// `balance()` reports a separately-tracked `Principal`, not the live token balance, so tests
// can deliberately desync the two (mirroring blend_strategy's book-vs-live-NAV split) to
// exercise `ensure_idle`'s insolvency path.
mod mock_strategy {
    use soroban_sdk::token::TokenClient;
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    #[derive(Clone)]
    enum DataKey {
        Vault,
        Token,
        Principal,
        HarvestGain, // Task 8: configurable harvest() payout, set via `set_harvest_gain`
        Bricked,     // Task 10: once true, `withdraw` unconditionally traps
        HarvestBricked, // Task R1: once true, `harvest` unconditionally traps
        DepositBricked, // Task R1: once true, `deposit` unconditionally traps
        BalanceBricked, // hardening: once true, `balance` unconditionally traps
        ReportExtra, // hardening: `withdraw` over-reports its return by this much
    }

    #[contract]
    pub struct MockStrategy;

    #[contractimpl]
    impl MockStrategy {
        pub fn __constructor(e: Env, vault: Address, token: Address) {
            e.storage().instance().set(&DataKey::Vault, &vault);
            e.storage().instance().set(&DataKey::Token, &token);
            e.storage().instance().set(&DataKey::Principal, &0i128);
        }

        pub fn deposit(e: Env, amount: i128) {
            let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
            vault.require_auth();
            // Mirrors the real blend_strategy guard (StrategyError::InvalidAmount) — the
            // vault must never route a non-positive deposit into a strategy.
            if amount <= 0 {
                panic!("mock strategy: non-positive deposit");
            }
            let bricked: bool = e
                .storage()
                .instance()
                .get(&DataKey::DepositBricked)
                .unwrap_or(false);
            if bricked {
                panic!("mock strategy: deposit bricked");
            }
            let token: Address = e.storage().instance().get(&DataKey::Token).unwrap();
            let me = e.current_contract_address();
            TokenClient::new(&e, &token).transfer_from(&me, &vault, &me, &amount);
            let principal: i128 = e.storage().instance().get(&DataKey::Principal).unwrap_or(0);
            e.storage()
                .instance()
                .set(&DataKey::Principal, &(principal + amount));
        }

        /// `i128::MAX` (or any amount exceeding actual holdings) drains everything held,
        /// mirroring the real strategy's cap-at-live-position behavior. Traps unconditionally
        /// once `set_bricked(true)` has been called — simulating a strategy whose underlying
        /// protocol position can no longer be exited (Task 10: `redeem_always_works`).
        pub fn withdraw(e: Env, amount: i128) -> i128 {
            let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
            vault.require_auth();
            let bricked: bool = e
                .storage()
                .instance()
                .get(&DataKey::Bricked)
                .unwrap_or(false);
            if bricked {
                panic!("mock strategy: bricked");
            }
            let token: Address = e.storage().instance().get(&DataKey::Token).unwrap();
            let me = e.current_contract_address();
            let tk = TokenClient::new(&e, &token);
            let held = tk.balance(&me);
            let out = if amount > held { held } else { amount };
            if out > 0 {
                tk.transfer(&me, &vault, &out);
            }
            let principal: i128 = e.storage().instance().get(&DataKey::Principal).unwrap_or(0);
            let new_principal = if out >= principal { 0 } else { principal - out };
            e.storage()
                .instance()
                .set(&DataKey::Principal, &new_principal);
            // Hardening hook: over-report by ReportExtra (honest transfer, lying return).
            let extra: i128 = e
                .storage()
                .instance()
                .get(&DataKey::ReportExtra)
                .unwrap_or(0);
            out + extra
        }

        pub fn balance(e: Env) -> i128 {
            let bricked: bool = e
                .storage()
                .instance()
                .get(&DataKey::BalanceBricked)
                .unwrap_or(false);
            if bricked {
                panic!("mock strategy: balance bricked");
            }
            e.storage().instance().get(&DataKey::Principal).unwrap_or(0)
        }

        /// Test-configurable harvest: transfers the amount set by `set_harvest_gain` to the
        /// vault and returns it, mirroring the real strategy — realized gain moves out,
        /// book `Principal` (the deposited amount) is untouched. Resets the configured gain
        /// to 0 so a second `harvest()` without reconfiguring yields nothing (mirrors real
        /// interest being consumed once realized).
        pub fn harvest(e: Env, _min_out: i128) -> i128 {
            let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
            vault.require_auth();
            let bricked: bool = e
                .storage()
                .instance()
                .get(&DataKey::HarvestBricked)
                .unwrap_or(false);
            if bricked {
                panic!("mock strategy: harvest bricked");
            }
            let gain: i128 = e
                .storage()
                .instance()
                .get(&DataKey::HarvestGain)
                .unwrap_or(0);
            if gain > 0 {
                let token: Address = e.storage().instance().get(&DataKey::Token).unwrap();
                let me = e.current_contract_address();
                TokenClient::new(&e, &token).transfer(&me, &vault, &gain);
                e.storage().instance().set(&DataKey::HarvestGain, &0i128);
            }
            gain
        }

        /// Test-only hook: force `balance()` (book principal) to diverge from the strategy's
        /// actual token holdings, simulating a socialized-loss / broken-strategy scenario.
        pub fn set_principal(e: Env, v: i128) {
            e.storage().instance().set(&DataKey::Principal, &v);
        }

        /// Test-only hook: configure the gain the next `harvest()` call realizes and
        /// transfers to the vault. The caller must separately fund this contract's token
        /// balance with at least `v` extra (beyond its principal) — see `fund_strategy_gain`.
        pub fn set_harvest_gain(e: Env, v: i128) {
            e.storage().instance().set(&DataKey::HarvestGain, &v);
        }

        /// Test-only hook: once set to `true`, every subsequent `withdraw` call traps —
        /// simulating a strategy whose underlying protocol position is permanently stuck
        /// (Task 10: `redeem_always_works`).
        pub fn set_bricked(e: Env, v: bool) {
            e.storage().instance().set(&DataKey::Bricked, &v);
        }

        /// Test-only hook: once set to `true`, every subsequent `harvest` call traps —
        /// simulating a strategy whose harvest path is broken (Task R1: `compound` must
        /// isolate this fault, realizing every OTHER strategy's gain regardless).
        pub fn set_harvest_bricked(e: Env, v: bool) {
            e.storage().instance().set(&DataKey::HarvestBricked, &v);
        }

        /// Test-only hook: once set to `true`, every subsequent `deposit` call traps —
        /// simulating a strategy whose deposit path is broken (Task R1: `compound`'s idle
        /// sweep must isolate this fault, leaving the cut idle rather than losing it).
        pub fn set_deposit_bricked(e: Env, v: bool) {
            e.storage().instance().set(&DataKey::DepositBricked, &v);
        }

        /// Test-only hook: once set to `true`, every subsequent `balance` call traps —
        /// simulating a strategy whose read path is broken (quarantine must remove it
        /// without ever calling it).
        pub fn set_balance_bricked(e: Env, v: bool) {
            e.storage().instance().set(&DataKey::BalanceBricked, &v);
        }

        /// Test-only hook: every subsequent `withdraw` OVER-REPORTS by `v` — it transfers
        /// the honest amount but returns amount + v, simulating a strategy lying about
        /// what it returned (delta accounting must catch this).
        pub fn set_withdraw_report_extra(e: Env, v: i128) {
            e.storage().instance().set(&DataKey::ReportExtra, &v);
        }
    }
}

// A hostile strategy whose `deposit` "succeeds" but returns a WRONG TYPE (i128 instead of
// void) and pulls nothing. Through the vault's typed client this decodes as outer-Ok /
// inner-Err — the exact shape a naive `.is_ok()` check wrongly counts as success.
mod wrong_ret_strategy {
    use soroban_sdk::{contract, contractimpl, contracttype, Env};

    #[contracttype]
    #[derive(Clone)]
    enum DataKey {
        Principal,
    }

    #[contract]
    pub struct WrongRetStrategy;

    #[contractimpl]
    impl WrongRetStrategy {
        pub fn deposit(_e: Env, _amount: i128) -> i128 {
            7 // wrong type for StrategyIface::deposit (void) — and pulls nothing
        }
        pub fn withdraw(_e: Env, _amount: i128) -> i128 {
            0
        }
        pub fn balance(e: Env) -> i128 {
            e.storage().instance().get(&DataKey::Principal).unwrap_or(0)
        }
        pub fn harvest(_e: Env, _min_out: i128) -> i128 {
            0
        }
        pub fn set_principal(e: Env, v: i128) {
            e.storage().instance().set(&DataKey::Principal, &v);
        }
    }
}
use mock_strategy::MockStrategyClient;

pub(crate) struct Ctx {
    pub vault: RwaVaultClient<'static>,
    pub admin: Address,
    pub token: Address,
}

// Deploys a plain SAC asset and the yield vault wired to it. No KYC, no compliance —
// any address can deposit (plain DeFi yield farming). The vault is a share-ledger priced
// by exchange rate: price_per_share = total_assets / total_supply.
pub(crate) fn setup(env: &Env) -> Ctx {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let vault_id = env.register(
        RwaVault,
        (
            admin.clone(),
            token.clone(),
            String::from_str(env, "Vibing Vault"),
            String::from_str(env, "vfVLT"),
        ),
    );
    Ctx {
        vault: RwaVaultClient::new(env, &vault_id),
        admin,
        token,
    }
}

// Mints `amount` of the asset to `who` and approves the vault to pull it on deposit.
fn fund_and_approve(env: &Env, ctx: &Ctx, who: &Address, amount: i128) {
    let vault_addr = ctx.vault.address.clone();
    StellarAssetClient::new(env, &ctx.token).mint(who, &amount);
    let exp = env.ledger().sequence() + 100_000;
    TokenClient::new(env, &ctx.token).approve(who, &vault_addr, &amount, &exp);
}

// Simulates a compound gain by donating `amount` USDC straight into the vault's balance.
// No strategies needed — total_assets is the vault's idle token balance this task.
fn donate(env: &Env, ctx: &Ctx, amount: i128) {
    let donor = Address::generate(env);
    StellarAssetClient::new(env, &ctx.token).mint(&donor, &amount);
    TokenClient::new(env, &ctx.token).transfer(&donor, &ctx.vault.address, &amount);
}

// Deploys a `MockStrategy` wired to `ctx`'s vault + token.
fn deploy_mock_strategy(env: &Env, ctx: &Ctx) -> Address {
    env.register(
        mock_strategy::MockStrategy,
        (ctx.vault.address.clone(), ctx.token.clone()),
    )
}

// Mints `amount` of the vault's asset directly to a strategy's address (simulating assets
// already parked there — bypasses the strategy's own `deposit`, which is Task 8's concern)
// and sets its book `Principal` to match, so `balance()` reports `amount`.
fn fund_strategy(env: &Env, ctx: &Ctx, strategy: &Address, amount: i128) {
    StellarAssetClient::new(env, &ctx.token).mint(strategy, &amount);
    MockStrategyClient::new(env, strategy).set_principal(&amount);
}

// Funds `amount` of "harvest gain" tokens directly to `strategy` (extra, beyond its
// Principal-tracked funds) and configures its next `harvest()` call to realize exactly
// `amount` — mirrors a real strategy's yield accruing in the underlying position ahead of
// a keeper's `compound` call.
fn fund_strategy_gain(env: &Env, ctx: &Ctx, strategy: &Address, amount: i128) {
    StellarAssetClient::new(env, &ctx.token).mint(strategy, &amount);
    MockStrategyClient::new(env, strategy).set_harvest_gain(&amount);
}

#[test]
fn test_constructor_stores_config_and_metadata() {
    let env = Env::default();
    let ctx = setup(&env);
    assert_eq!(ctx.vault.admin(), ctx.admin);
    assert_eq!(ctx.vault.token(), ctx.token);
    assert_eq!(ctx.vault.decimals(), 7);
    assert_eq!(ctx.vault.total_shares(), 0);
    assert_eq!(ctx.vault.total_assets(), 0);
    // Empty vault prices a share at exactly 1.0 (PPS_SCALE).
    assert_eq!(ctx.vault.price_per_share(), U7);
}

#[test]
fn first_deposit_mints_dead_shares_to_vault() {
    let env = Env::default();
    let ctx = setup(&env);
    let vault_addr = ctx.vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);

    let shares = ctx.vault.deposit(&alice, &(100 * U7));

    // Depositor receives amount - DEAD_SHARES; the vault itself holds the dead shares.
    assert_eq!(shares, 100 * U7 - DEAD_SHARES);
    assert_eq!(ctx.vault.balance(&alice), 100 * U7 - DEAD_SHARES);
    assert_eq!(ctx.vault.balance(&vault_addr), DEAD_SHARES);
    assert_eq!(ctx.vault.total_shares(), 100 * U7);
    // Assets park idle in the vault (no pool/strategy yet).
    assert_eq!(ctx.vault.total_assets(), 100 * U7);
    assert_eq!(
        TokenClient::new(&env, &ctx.token).balance(&vault_addr),
        100 * U7
    );
    // Price still 1.0 right after the first deposit.
    assert_eq!(ctx.vault.price_per_share(), U7);
}

#[test]
fn first_deposit_below_minimum_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, U7); // fund enough so transfer_from succeeds

    // 0.5 USDC < 1 USDC minimum first deposit → clean FirstDepositTooSmall, tx reverts.
    assert_eq!(
        ctx.vault.try_deposit(&alice, &(U7 / 2)),
        Err(Ok(VaultError::FirstDepositTooSmall))
    );
    // No shares minted, nothing pulled (revert rolled back the transfer_from).
    assert_eq!(ctx.vault.total_shares(), 0);
    assert_eq!(ctx.vault.total_assets(), 0);
}

#[test]
fn share_price_rises_after_donated_gain() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // supply = 100*U7
    assert_eq!(ctx.vault.price_per_share(), U7); // 1.0

    // Donate 10 USDC directly (simulates a compound gain raising total_assets).
    donate(&env, &ctx, 10 * U7);
    assert_eq!(ctx.vault.total_assets(), 110 * U7);
    // 110 * PPS_SCALE / 100 = 1.1 * 1e7
    assert_eq!(ctx.vault.price_per_share(), 11_000_000);

    // Second depositor of 100 USDC mints FEWER shares: amount * supply / assets_before.
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &bob, 100 * U7);
    let bob_shares = ctx.vault.deposit(&bob, &(100 * U7));
    // 100*U7 * (100*U7) / (110*U7) = 1e18 / 1.1e9 = 909_090_909
    assert_eq!(bob_shares, (100 * U7) * (100 * U7) / (110 * U7));
    assert_eq!(bob_shares, 909_090_909);
    assert!(bob_shares < 100 * U7); // fewer shares than a 1:1 deposit
}

#[test]
fn redeem_pays_pro_rata_assets() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    let alice_shares = ctx.vault.deposit(&alice, &(100 * U7)); // 100*U7 - DEAD_SHARES

    // A compound gain donated to the vault lifts every share's value.
    donate(&env, &ctx, 10 * U7);

    // Redeem all of Alice's shares → she gets back MORE than her 100 USDC deposit.
    let assets = ctx.vault.redeem(&alice, &alice_shares);
    let expected = alice_shares * (110 * U7) / (100 * U7);
    assert_eq!(assets, expected);
    assert!(assets > 100 * U7); // realised the donated gain (minus the dead-share slice)
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), assets);

    // Dead shares remain, so total_supply never returns to zero.
    assert_eq!(ctx.vault.total_shares(), DEAD_SHARES);
}

#[test]
fn test_deposit_rejects_zero_and_negative() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    assert!(ctx.vault.try_deposit(&alice, &0i128).is_err());
    assert!(ctx.vault.try_deposit(&alice, &(-1i128)).is_err());
}

#[test]
fn test_redeem_burns_shares_returns_assets() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // alice holds 100*U7 - DEAD_SHARES

    // No gain yet → price 1.0 → 50 shares redeem for 50 assets.
    let assets = ctx.vault.redeem(&alice, &(50 * U7));
    assert_eq!(assets, 50 * U7);
    assert_eq!(ctx.vault.balance(&alice), 50 * U7 - DEAD_SHARES);
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&alice), 50 * U7);
    assert_eq!(ctx.vault.total_shares(), 50 * U7); // dead + remaining alice
}

#[test]
fn test_redeem_rejects_over_balance() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    let shares = ctx.vault.deposit(&alice, &(100 * U7));
    assert!(ctx.vault.try_redeem(&alice, &(shares + 1)).is_err()); // more than held
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
fn test_deposit_blocked_when_paused_redeem_allowed() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    ctx.vault.pause(&ctx.admin);
    assert!(ctx.vault.try_deposit(&alice, &U7).is_err()); // deposit pause-gated
    assert_eq!(ctx.vault.redeem(&alice, &(50 * U7)), 50 * U7); // redeem still works
}

// ----- Task 7: strategy registry + strategy-draining redeem -----

#[test]
fn admin_registers_strategies_max_four() {
    let env = Env::default();
    let ctx = setup(&env);
    assert_eq!(ctx.vault.strategies().len(), 0);

    for _ in 0..4 {
        let s = Address::generate(&env);
        ctx.vault.add_strategy(&s);
    }
    assert_eq!(ctx.vault.strategies().len(), 4);

    let fifth = Address::generate(&env);
    assert_eq!(
        ctx.vault.try_add_strategy(&fifth),
        Err(Ok(VaultError::TooManyStrategies))
    );
    assert_eq!(ctx.vault.strategies().len(), 4); // rejected add didn't grow the list

    // Non-admin: no admin signature present at all → auth error, not a logic error.
    env.set_auths(&[]);
    let sixth = Address::generate(&env);
    assert!(ctx.vault.try_add_strategy(&sixth).is_err());
}

#[test]
fn add_strategy_rejects_duplicate() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    fund_strategy(&env, &ctx, &strat, 10 * U7);

    assert_eq!(ctx.vault.strategies().len(), 1);
    assert_eq!(ctx.vault.total_assets(), 10 * U7);

    // Re-registering the SAME address must be rejected — otherwise `total_assets` would sum
    // the strategy's `balance()` twice (once per registry entry), inflating `price_per_share`.
    assert_eq!(
        ctx.vault.try_add_strategy(&strat),
        Err(Ok(VaultError::StrategyAlreadyRegistered))
    );

    // Rejected duplicate didn't grow the registry or change what total_assets reports.
    assert_eq!(ctx.vault.strategies().len(), 1);
    assert_eq!(ctx.vault.total_assets(), 10 * U7);
}

#[test]
fn remove_requires_empty() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    fund_strategy(&env, &ctx, &strat, 10 * U7);

    assert_eq!(
        ctx.vault.try_remove_strategy(&strat),
        Err(Ok(VaultError::StrategyNotEmpty))
    );

    MockStrategyClient::new(&env, &strat).set_principal(&0);
    ctx.vault.remove_strategy(&strat);
    assert_eq!(ctx.vault.strategies().len(), 0);

    // Removing an address that was never registered (or already removed) → StrategyNotFound.
    assert_eq!(
        ctx.vault.try_remove_strategy(&strat),
        Err(Ok(VaultError::StrategyNotFound))
    );
}

#[test]
fn remove_strategy_admin_only() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat); // balance() stays 0 — nothing funded

    env.set_auths(&[]); // no admin signature present → must fail
    assert!(ctx.vault.try_remove_strategy(&strat).is_err());
    assert_eq!(ctx.vault.strategies().len(), 1); // rejected call left the registry untouched

    env.mock_all_auths();
    ctx.vault.remove_strategy(&strat);
    assert_eq!(ctx.vault.strategies().len(), 0);
}

#[test]
fn redeem_drains_strategies_in_order() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7

    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 50 * U7);
    fund_strategy(&env, &ctx, &strat2, 40 * U7);

    // idle 10 + strat1 50 + strat2 40 = 100*U7 total_assets backing 10*U7 shares (10x price).
    assert_eq!(ctx.vault.total_assets(), 100 * U7);
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(
        TokenClient::new(&env, &ctx.token).balance(&vault_addr),
        10 * U7
    );

    // Redeem shares worth exactly 80*U7 assets at the 10x price → 8*U7 shares.
    let shares_to_redeem = 8 * U7;
    let assets = ctx.vault.redeem(&alice, &shares_to_redeem);
    assert_eq!(assets, 80 * U7);

    // Drain order: idle (10) covers none of it alone; strat1 fully drained (50); the
    // remaining shortfall (20) comes out of strat2, leaving strat2 at 40-20=20. Idle ends
    // at exactly 0 once the redeem payout goes out.
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 0);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 20 * U7);
    assert_eq!(ctx.vault.total_assets(), 20 * U7); // 100 - 80 redeemed
}

#[test]
fn set_keeper_admin_only() {
    let env = Env::default();
    let ctx = setup(&env);
    let keeper = Address::generate(&env);

    env.set_auths(&[]); // no admin signature present → must fail
    assert!(ctx.vault.try_set_keeper(&keeper).is_err());

    env.mock_all_auths();
    ctx.vault.set_keeper(&keeper);
    assert_eq!(ctx.vault.keeper(), keeper);
}

#[test]
fn set_limits_admin_only() {
    let env = Env::default();
    let ctx = setup(&env);

    env.set_auths(&[]); // no admin signature present → must fail
    assert!(ctx.vault.try_set_limits(&3600u64, &1_000u32).is_err());

    env.mock_all_auths();
    ctx.vault.set_limits(&3600u64, &1_000u32); // admin call succeeds without panicking
}

#[test]
fn deposit_rounding_to_zero_shares_reverts() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // supply = 10*U7

    // A strategy holding a wildly inflated balance makes total_assets dwarf total_supply,
    // pushing price_per_share high enough that a tiny deposit rounds down to 0 shares.
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    fund_strategy(&env, &ctx, &strat, 10 * U7 * 1_000_000);

    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &bob, U7);
    assert_eq!(
        ctx.vault.try_deposit(&bob, &1i128),
        Err(Ok(VaultError::InvalidAmount))
    );
}

#[test]
fn ensure_idle_insolvent_errors() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    let alice_shares = ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7

    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    // Phantom balance: the strategy's book `Principal` (90*U7) overstates what it actually
    // holds (5*U7) — a broken-strategy / socialized-loss scenario. total_assets() reports
    // 100*U7 but only 15*U7 physically exists between idle and the strategy.
    StellarAssetClient::new(&env, &ctx.token).mint(&strat, &(5 * U7));
    MockStrategyClient::new(&env, &strat).set_principal(&(90 * U7));

    assert_eq!(
        ctx.vault.try_redeem(&alice, &alice_shares),
        Err(Ok(VaultError::InsufficientLiquidity))
    );
}

// ----- Task 8: keeper-gated compound (harvest all + reinvest idle pro-rata) -----

#[test]
fn compound_harvests_all_and_reinvests_idle_pro_rata() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100*U7, supply = 100*U7

    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 60 * U7); // pre-harvest balance 60
    fund_strategy(&env, &ctx, &strat2, 40 * U7); // pre-harvest balance 40
    fund_strategy_gain(&env, &ctx, &strat1, 6 * U7); // harvest() yields 6
    fund_strategy_gain(&env, &ctx, &strat2, 4 * U7); // harvest() yields 4

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let min_outs = Vec::from_array(&env, [0i128, 0i128]);
    let total_gain = ctx.vault.compound(&min_outs);
    // `events().all()` reflects only the LAST contract invocation — capture immediately.
    let events = env.events().all();

    assert_eq!(total_gain, 10 * U7);
    let expected_pps = ctx.vault.price_per_share();
    let event = events.events().last().unwrap();
    let expected_event = Compound {
        total_gain: 10 * U7,
        price_per_share: expected_pps,
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);

    // idle 100 (deposit) + 10 (harvested) = 110, swept pro-rata by PRE-harvest 60:40 →
    // 66/44. The vault ends with zero idle; each strategy's book grows by its cut.
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
    assert_eq!(
        MockStrategyClient::new(&env, &strat1).balance(),
        60 * U7 + 66 * U7
    );
    assert_eq!(
        MockStrategyClient::new(&env, &strat2).balance(),
        40 * U7 + 44 * U7
    );
}

#[test]
fn compound_all_zero_balances_goes_to_first_strategy() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100*U7

    // Two freshly-registered strategies, both balance() == 0 — nothing to ratio by.
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let min_outs = Vec::from_array(&env, [0i128, 0i128]);
    let total_gain = ctx.vault.compound(&min_outs);
    assert_eq!(total_gain, 0);

    // The entire idle goes to strategies[0] only — not split, since there's no ratio.
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 100 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 0);
}

#[test]
fn compound_requires_keeper() {
    let env = Env::default();
    let ctx = setup(&env);

    // Keeper never set → clean NotKeeper, not a panic on an unwrap.
    assert_eq!(
        ctx.vault.try_compound(&Vec::new(&env)),
        Err(Ok(VaultError::NotKeeper))
    );

    // Keeper set, but no authorization at all is present for this call — `require_auth`
    // on the stored keeper address has nothing to satisfy it, so the call still fails.
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    env.set_auths(&[]);
    assert!(ctx.vault.try_compound(&Vec::new(&env)).is_err());
}

#[test]
fn compound_min_outs_length_mismatch_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    // 1 strategy registered, 2 min_outs supplied — length mismatch.
    let min_outs = Vec::from_array(&env, [0i128, 0i128]);
    assert_eq!(
        ctx.vault.try_compound(&min_outs),
        Err(Ok(VaultError::InvalidAmount))
    );
}

#[test]
fn price_per_share_increases_after_compound() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));

    let strat1 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    fund_strategy(&env, &ctx, &strat1, 50 * U7);
    fund_strategy_gain(&env, &ctx, &strat1, 5 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let pps_before = ctx.vault.price_per_share();
    let min_outs = Vec::from_array(&env, [0i128]);
    ctx.vault.compound(&min_outs);
    let pps_after = ctx.vault.price_per_share();

    assert!(pps_after > pps_before);
}

// ----- Task R1: compound fault isolation (bricked harvest/deposit) + on-chain cooldown -----

#[test]
fn compound_isolates_bricked_harvest() {
    let env = Env::default();
    let ctx = setup(&env);

    // No user deposit needed here — strategies are funded directly, and the assertion below
    // is purely about `total_gain`, not the idle-sweep math (already covered by
    // `compound_harvests_all_and_reinvests_idle_pro_rata`).
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 60 * U7);
    fund_strategy(&env, &ctx, &strat2, 40 * U7);
    fund_strategy_gain(&env, &ctx, &strat1, 6 * U7); // would realize 6 — but harvest is bricked
    fund_strategy_gain(&env, &ctx, &strat2, 4 * U7); // realizes normally
    MockStrategyClient::new(&env, &strat1).set_harvest_bricked(&true);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let min_outs = Vec::from_array(&env, [0i128, 0i128]);
    // Must NOT revert despite strat1's harvest trapping.
    let total_gain = ctx.vault.compound(&min_outs);

    // Only strat2's 4*U7 gain realized — strat1's bricked harvest contributed 0 rather than
    // reverting the whole call (and definitely not the phantom 6*U7 it never actually paid
    // out).
    assert_eq!(total_gain, 4 * U7);

    // `events().all()` reflects only the LAST contract invocation — capture immediately.
    let events = env.events().all();
    let event = events.events().last().unwrap();
    let expected_event = Compound {
        total_gain: 4 * U7,
        price_per_share: ctx.vault.price_per_share(),
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);
}

#[test]
fn compound_isolates_bricked_deposit_leaves_cut_idle() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100*U7, supply = 100*U7

    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    MockStrategyClient::new(&env, &strat).set_deposit_bricked(&true);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let assets_before = ctx.vault.total_assets();
    let min_outs = Vec::from_array(&env, [0i128]);
    // Must NOT revert despite the strategy's deposit trapping on the sweep attempt.
    let total_gain = ctx.vault.compound(&min_outs);
    assert_eq!(total_gain, 0); // strategy never held funds — nothing to harvest

    // The sweep tried to deposit the full 100*U7 idle into the bricked strategy and failed —
    // the cut stays idle instead of being lost (or double-counted via a partial transfer).
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(
        TokenClient::new(&env, &ctx.token).balance(&vault_addr),
        100 * U7
    );
    assert_eq!(MockStrategyClient::new(&env, &strat).balance(), 0);

    // total_assets is exactly what it was before — a skipped sweep only ever leaves funds in
    // a different bucket (idle vs. strategy); it can never create or destroy them.
    assert_eq!(ctx.vault.total_assets(), assets_before);
}

#[test]
fn compound_cooldown_blocks_second_call_until_disabled() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));

    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    fund_strategy(&env, &ctx, &strat, 50 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    let min_outs = Vec::from_array(&env, [0i128]);
    // First-ever compound always passes the cooldown gate — `LastCompound` is absent, not 0
    // (see storage::get_last_compound), regardless of `Env::default()`'s timestamp-0 start.
    ctx.vault.compound(&min_outs);

    // Immediate second call, same ledger timestamp — still within the default 600s cooldown.
    assert_eq!(
        ctx.vault.try_compound(&min_outs),
        Err(Ok(VaultError::CooldownActive))
    );

    // Admin disables the gate outright (cooldown 0) — the very next call now succeeds
    // immediately, no ledger-time advance needed.
    ctx.vault.set_compound_cooldown(&0u64);
    ctx.vault.compound(&min_outs); // no panic == passes
}

#[test]
fn set_compound_cooldown_admin_only() {
    let env = Env::default();
    let ctx = setup(&env);

    env.set_auths(&[]); // no admin signature present → must fail
    assert!(ctx.vault.try_set_compound_cooldown(&0u64).is_err());

    env.mock_all_auths();
    ctx.vault.set_compound_cooldown(&0u64); // admin call succeeds without panicking
}

// ----- Task 9: keeper-gated rebalance (cooldown + caps), admin emergency_withdraw/upgrade -----

#[test]
fn rebalance_moves_within_caps_and_sets_cooldown() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 100 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    // `Env::default()` starts ledger timestamp at 0, but `LastRebalance` is ALSO seeded to 0
    // by the constructor — `now < last_rebalance + cooldown_s` would read `0 < 86_400` and
    // wrongly block the very first-ever rebalance. On a real chain `now` is a huge Unix
    // timestamp so this never bites; here we bump past it to mirror realistic chain time.
    env.ledger().set_timestamp(100_000);

    // Default max_move_bps = 5000 (50%) — moving exactly 50 of 100 sits AT the cap, not over.
    ctx.vault.rebalance(&strat1, &strat2, &(50 * U7));
    // `events().all()` reflects only the LAST contract invocation — capture immediately.
    let events = env.events().all();

    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 50 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 50 * U7);

    let event = events.events().last().unwrap();
    let expected_event = Rebalance {
        from: strat1.clone(),
        to: strat2.clone(),
        amount: 50 * U7,
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);
}

#[test]
fn rebalance_zero_withdraw_skips_deposit_leg() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat2, 50 * U7);
    // strat1's book says 100*U7 but it holds NO tokens — its withdraw returns 0. The
    // rebalance must skip the deposit leg (the real strategy rejects deposit(0)) instead
    // of trapping the whole call.
    MockStrategyClient::new(&env, &strat1).set_principal(&(100 * U7));

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    env.ledger().set_timestamp(100_000);

    ctx.vault.rebalance(&strat1, &strat2, &(10 * U7));
    let events = env.events().all();

    // Nothing moved: strat2 untouched, and the event records the actual 0 moved.
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 50 * U7);
    let event = events.events().last().unwrap();
    let expected_event = Rebalance {
        from: strat1.clone(),
        to: strat2.clone(),
        amount: 0,
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);
}

#[test]
fn rebalance_cooldown_blocks_second_call() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 100 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    // Bump past the seeded-0 LastRebalance/cooldown edge (see comment in the caps test above)
    // before the very first rebalance ever made on this vault.
    env.ledger().set_timestamp(100_000);

    ctx.vault.rebalance(&strat1, &strat2, &(10 * U7)); // strat1=90, strat2=10

    // Immediate second call — still within the default 24h cooldown → blocked.
    assert_eq!(
        ctx.vault.try_rebalance(&strat2, &strat1, &(5 * U7)),
        Err(Ok(VaultError::CooldownActive))
    );
    // Rejected call left balances untouched.
    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 90 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 10 * U7);

    // Bump ledger timestamp past the cooldown window → the same move now succeeds.
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + 86_400);
    ctx.vault.rebalance(&strat2, &strat1, &(5 * U7)); // 5 == 50% of strat2's 10 — at the cap
    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 95 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 5 * U7);
}

#[test]
fn rebalance_over_cap_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    fund_strategy(&env, &ctx, &strat1, 100 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    env.ledger().set_timestamp(100_000); // past the seeded-0 LastRebalance/cooldown edge

    // Default max_move_bps = 5000 (50%) — moving 51 of 100 exceeds the cap.
    assert_eq!(
        ctx.vault.try_rebalance(&strat1, &strat2, &(51 * U7)),
        Err(Ok(VaultError::MoveTooLarge))
    );
    // Rejected move left balances untouched.
    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 100 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 0);
}

#[test]
fn rebalance_unregistered_strategy_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    fund_strategy(&env, &ctx, &strat1, 100 * U7);
    let unregistered = deploy_mock_strategy(&env, &ctx); // never registered

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    assert_eq!(
        ctx.vault.try_rebalance(&strat1, &unregistered, &(10 * U7)),
        Err(Ok(VaultError::StrategyNotFound))
    );
    assert_eq!(
        ctx.vault.try_rebalance(&unregistered, &strat1, &(10 * U7)),
        Err(Ok(VaultError::StrategyNotFound))
    );
}

#[test]
fn rebalance_to_idle_derisks() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat1);
    fund_strategy(&env, &ctx, &strat1, 100 * U7);

    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    env.ledger().set_timestamp(100_000); // past the seeded-0 LastRebalance/cooldown edge
    let vault_addr = ctx.vault.address.clone();

    // `to == vault_addr` is the de-risk-to-idle fallback: Task 1's spike proved a second
    // on-chain Blend pool isn't viable on testnet, so the live demo rebalances between
    // strategy #1 and idle instead of strategy #1 and a second strategy.
    ctx.vault.rebalance(&strat1, &vault_addr, &(40 * U7));
    let events = env.events().all();

    assert_eq!(MockStrategyClient::new(&env, &strat1).balance(), 60 * U7);
    // Funds landed idle in the vault — no redeposit into a second strategy.
    assert_eq!(
        TokenClient::new(&env, &ctx.token).balance(&vault_addr),
        40 * U7
    );

    let event = events.events().last().unwrap();
    let expected_event = Rebalance {
        from: strat1.clone(),
        to: vault_addr.clone(),
        amount: 40 * U7,
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);
}

#[test]
fn emergency_withdraw_drains_to_idle_even_when_paused() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    let alice_shares = ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100*U7

    // Fund a strategy directly (bypassing deposit's idle-park) so it holds a balance to
    // drain.
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    fund_strategy(&env, &ctx, &strat, 50 * U7);

    ctx.vault.pause(&ctx.admin);

    // emergency_withdraw is NOT pause-gated — it's the escape hatch you need WHILE paused.
    ctx.vault.emergency_withdraw(&strat);
    assert_eq!(MockStrategyClient::new(&env, &strat).balance(), 0);

    // Now empty — remove_strategy succeeds (also not pause-gated; admin-only).
    ctx.vault.remove_strategy(&strat);
    assert_eq!(ctx.vault.strategies().len(), 0);

    // redeem still works while paused (redeem was never pause-gated).
    let assets = ctx.vault.redeem(&alice, &alice_shares);
    assert!(assets > 0);
}

// ----- Task 10 (vf-autofarm §9): one bricked strategy must not lock ALL user funds -----

#[test]
fn redeem_always_works() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7 (10x price setup)

    // Register a HEALTHY strategy first, a permanently BRICKED one second — `ensure_idle`
    // drains registered strategies in list order and stops the moment idle covers the
    // redeem, so registration order decides whether a given payout ever reaches `bricked`.
    let healthy = deploy_mock_strategy(&env, &ctx);
    let bricked = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&healthy);
    ctx.vault.add_strategy(&bricked);
    fund_strategy(&env, &ctx, &healthy, 50 * U7);
    fund_strategy(&env, &ctx, &bricked, 40 * U7);
    MockStrategyClient::new(&env, &bricked).set_bricked(&true); // withdraw() now traps

    // total_assets = 10 idle + 50 healthy + 40 bricked = 100*U7 backing 10*U7 shares (10x).
    assert_eq!(ctx.vault.total_assets(), 100 * U7);

    // 1. A redeem covered by idle + the healthy strategy (40*U7 of the 100*U7 total) succeeds
    //    WITHOUT ever calling the bricked strategy's withdraw — proving a single bricked
    //    strategy does not lock every user's funds, only the slice actually parked in it.
    let assets1 = ctx.vault.redeem(&alice, &(4 * U7));
    assert_eq!(assets1, 40 * U7);
    assert_eq!(MockStrategyClient::new(&env, &healthy).balance(), 20 * U7); // 50 - 30 shortfall
    assert_eq!(MockStrategyClient::new(&env, &bricked).balance(), 40 * U7); // never touched

    // 2. Admin recovery path: even while paused, `emergency_withdraw` still drains the
    //    HEALTHY strategy's remainder to idle, and `remove_strategy` deregisters it once
    //    empty — both admin-only escape hatches, neither pause-gated. `bricked` stays
    //    registered (its balance can never reach 0 — its withdraw always traps), yet the
    //    vault remains usable.
    ctx.vault.pause(&ctx.admin);
    ctx.vault.emergency_withdraw(&healthy);
    assert_eq!(MockStrategyClient::new(&env, &healthy).balance(), 0);
    ctx.vault.remove_strategy(&healthy);
    assert_eq!(
        ctx.vault.strategies(),
        Vec::from_array(&env, [bricked.clone()])
    );

    // total_assets unchanged (20 idle + 40 bricked = 60*U7 backing the 6*U7 shares left) —
    // funds only moved custody, nothing was gained or lost.
    assert_eq!(ctx.vault.total_assets(), 60 * U7);

    // 3. A user can still redeem the full recoverable amount (idle) despite the bricked
    //    strategy remaining registered — `bricked` is the ONLY registered strategy left, so
    //    this redeem never even enters `ensure_idle`'s drain loop for it (idle alone covers
    //    the payout). redeem is never pause-gated, so this succeeds while still paused.
    let assets2 = ctx.vault.redeem(&alice, &(2 * U7));
    assert_eq!(assets2, 20 * U7);
    assert_eq!(MockStrategyClient::new(&env, &bricked).balance(), 40 * U7); // still untouched

    // 4. Only the bricked-locked slice is actually unavailable — and that failure is a clean
    //    revert (via `try_redeem`), not a corrupted or partial payout. Vault state (shares,
    //    total_assets) is untouched by the failed attempt.
    let shares_before = ctx.vault.total_shares();
    let assets_before = ctx.vault.total_assets();
    assert!(ctx.vault.try_redeem(&alice, &U7).is_err());
    assert_eq!(ctx.vault.total_shares(), shares_before);
    assert_eq!(ctx.vault.total_assets(), assets_before);
}

// ----- Fund-handling hardening: deposit divide-by-zero guard + ensure_idle skips bricked -----

#[test]
fn deposit_after_total_loss_errors_not_panics() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7

    // Sweep idle into a freshly-registered strategy via compound (mirrors the real
    // yield-farming flow) so idle becomes 0 and the strategy's book Principal becomes 10*U7.
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    ctx.vault.compound(&Vec::from_array(&env, [0i128]));
    assert_eq!(MockStrategyClient::new(&env, &strat).balance(), 10 * U7);
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);

    // Simulate a TOTAL strategy loss: the underlying position is wiped out, so the
    // strategy's own book balance() drops to 0 too — total_assets() is now 0 while
    // total_supply() (DEAD_SHARES + alice's shares) is still > 0.
    MockStrategyClient::new(&env, &strat).set_principal(&0);
    assert_eq!(ctx.vault.total_assets(), 0);
    assert!(ctx.vault.total_shares() > 0);

    // A subsequent deposit must fail CLEANLY (InvalidAmount), not panic/trap on
    // `amount * supply / assets_before` dividing by a zero `assets_before`.
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &bob, 5 * U7);
    assert_eq!(
        ctx.vault.try_deposit(&bob, &(5 * U7)),
        Err(Ok(VaultError::InvalidAmount))
    );
}

#[test]
fn redeem_skips_bricked_earlier_strategy() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7 (10x price setup)

    // BRICKED registered FIRST, healthy SECOND — ensure_idle drains registered strategies in
    // list order, so a shortfall that reaches strategy[0] must skip it, not trap the whole
    // redeem.
    let bricked = deploy_mock_strategy(&env, &ctx);
    let healthy = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&bricked);
    ctx.vault.add_strategy(&healthy);
    fund_strategy(&env, &ctx, &bricked, 40 * U7);
    fund_strategy(&env, &ctx, &healthy, 50 * U7);
    MockStrategyClient::new(&env, &bricked).set_bricked(&true); // withdraw() now traps

    // total_assets = 10 idle + 40 bricked + 50 healthy = 100*U7 backing 10*U7 shares (10x).
    assert_eq!(ctx.vault.total_assets(), 100 * U7);

    // Redeem 4*U7 shares -> 40*U7 assets: idle(10) alone doesn't cover it, so ensure_idle must
    // reach into strategy[0] (bricked) first, get a trap, skip it, and drain the shortfall
    // from strategy[1] (healthy) instead.
    let assets = ctx.vault.redeem(&alice, &(4 * U7));
    assert_eq!(assets, 40 * U7);

    // Bricked strategy was never actually touched — its balance is exactly what it was
    // funded with.
    assert_eq!(MockStrategyClient::new(&env, &bricked).balance(), 40 * U7);
    // Healthy strategy covered the full 30*U7 shortfall (needed 40 - idle 10).
    assert_eq!(MockStrategyClient::new(&env, &healthy).balance(), 20 * U7);
    let vault_addr = ctx.vault.address.clone();
    assert_eq!(TokenClient::new(&env, &ctx.token).balance(&vault_addr), 0);
}

#[test]
fn redeem_exceeding_recoverable_errors_insufficient_liquidity() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 10 * U7);
    ctx.vault.deposit(&alice, &(10 * U7)); // idle = 10*U7, supply = 10*U7 (10x price setup)

    let bricked = deploy_mock_strategy(&env, &ctx);
    let healthy = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&bricked);
    ctx.vault.add_strategy(&healthy);
    fund_strategy(&env, &ctx, &bricked, 40 * U7);
    fund_strategy(&env, &ctx, &healthy, 50 * U7);
    MockStrategyClient::new(&env, &bricked).set_bricked(&true);

    // Max recoverable = idle(10) + healthy(50) = 60*U7; bricked's 40*U7 is permanently stuck.
    // Redeem shares worth 70*U7 at the 10x price -> exceeds what's recoverable.
    let shares_before = ctx.vault.total_shares();
    let assets_before = ctx.vault.total_assets();
    assert_eq!(
        ctx.vault.try_redeem(&alice, &(7 * U7)),
        Err(Ok(VaultError::InsufficientLiquidity))
    );

    // Clean revert (not a hard panic) — vault state untouched, both strategies untouched
    // (the whole failed invocation, including healthy's real withdraw, rolls back), no
    // partial payout.
    assert_eq!(ctx.vault.total_shares(), shares_before);
    assert_eq!(ctx.vault.total_assets(), assets_before);
    assert_eq!(MockStrategyClient::new(&env, &bricked).balance(), 40 * U7);
    assert_eq!(MockStrategyClient::new(&env, &healthy).balance(), 50 * U7);
}

#[test]
fn upgrade_admin_only() {
    let env = Env::default();
    let ctx = setup(&env);
    let fake_hash = BytesN::from_array(&env, &[9u8; 32]);

    // No admin signature present at all → auth error, not a logic error. (The wasm swap
    // itself needs a real second uploaded wasm — covered by the live testnet smoke, not this
    // unit suite; here we only prove the auth gate.)
    env.set_auths(&[]);
    assert!(ctx.vault.try_upgrade(&fake_hash).is_err());
}

// ===== Lifeboat: mandate plumbing =====

#[test]
fn test_set_mandate_authority_and_grant() {
    let env = Env::default();
    let ctx = setup(&env);
    let authority = Address::generate(&env);
    ctx.vault.set_mandate_authority(&authority);

    let state = ctx.vault.lifeboat_state();
    assert_eq!(state.authority, Some(authority.clone()));
    assert_eq!(state.mandate_expiry, 0);
    assert!(!state.derisked);

    let expiry = env.ledger().timestamp() + 86_400;
    ctx.vault.set_mandate(&expiry);
    assert_eq!(ctx.vault.lifeboat_state().mandate_expiry, expiry);
}

#[test]
fn test_set_mandate_without_authority_rejected() {
    let env = Env::default();
    let ctx = setup(&env);
    let res = ctx
        .vault
        .try_set_mandate(&(env.ledger().timestamp() + 86_400));
    assert_eq!(res, Err(Ok(VaultError::AuthorityNotSet)));
}

#[test]
fn test_set_mandate_can_shorten_to_revoke() {
    let env = Env::default();
    let ctx = setup(&env);
    let authority = Address::generate(&env);
    ctx.vault.set_mandate_authority(&authority);
    ctx.vault.set_mandate(&(env.ledger().timestamp() + 86_400));
    // granting an already-past expiry is an immediate disarm — allowed (user revoke)
    ctx.vault.set_mandate(&0);
    assert_eq!(ctx.vault.lifeboat_state().mandate_expiry, 0);
}

// ===== Lifeboat: emergency_derisk / resume =====

fn arm_lifeboat(env: &Env, ctx: &Ctx) {
    let authority = Address::generate(env);
    ctx.vault.set_mandate_authority(&authority);
    ctx.vault.set_mandate(&(env.ledger().timestamp() + 86_400));
    let keeper = Address::generate(env);
    ctx.vault.set_keeper(&keeper);
}

#[test]
fn test_emergency_derisk_drains_all_strategies_and_blocks_keeper_ops() {
    let env = Env::default();
    let ctx = setup(&env);
    arm_lifeboat(&env, &ctx);
    let s1 = deploy_mock_strategy(&env, &ctx);
    let s2 = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&s1);
    ctx.vault.add_strategy(&s2);
    fund_strategy(&env, &ctx, &s1, 500 * U7);
    fund_strategy(&env, &ctx, &s2, 300 * U7);

    let drained = ctx.vault.emergency_derisk(&2u32);
    assert_eq!(drained, 800 * U7);
    assert!(ctx.vault.lifeboat_state().derisked);
    // drained funds now sit idle in the vault
    assert_eq!(
        TokenClient::new(&env, &ctx.token).balance(&ctx.vault.address),
        800 * U7
    );
    // keeper ops blocked while engaged
    assert_eq!(
        ctx.vault.try_rebalance(&s1, &s2, &1),
        Err(Ok(VaultError::LifeboatEngaged))
    );
    assert_eq!(
        ctx.vault.try_compound(&Vec::from_array(&env, [0i128, 0i128])),
        Err(Ok(VaultError::LifeboatEngaged))
    );
}

#[test]
fn test_emergency_derisk_mandate_gated_and_idempotent() {
    let env = Env::default();
    let ctx = setup(&env);
    // keeper set but NO mandate at all — fail-closed
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    assert_eq!(
        ctx.vault.try_emergency_derisk(&1u32),
        Err(Ok(VaultError::MandateExpired))
    );

    arm_lifeboat(&env, &ctx);
    assert_eq!(ctx.vault.emergency_derisk(&1u32), 0); // no strategies: drains 0, engages
    // `events().all()` reflects only the LAST contract invocation — capture immediately.
    let events = env.events().all();
    assert_eq!(events.events().len(), 1);
    let event = events.events().last().unwrap();
    let expected_event = LifeboatEngaged {
        reason_code: 1,
        drained_total: 0,
    }
    .to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);

    assert_eq!(ctx.vault.emergency_derisk(&1u32), 0); // second call: idempotent no-op
    // Idempotent retry must publish NOTHING — proof a cross-ledger retry can never
    // double-fire LifeboatEngaged.
    let retry_events = env.events().all();
    assert!(retry_events.events().is_empty());
    assert!(ctx.vault.lifeboat_state().derisked);
}

#[test]
fn test_non_keeper_cannot_derisk() {
    let env = Env::default();
    let ctx = setup(&env);
    // keeper never set — require_keeper's NotKeeper, mirrors compound/rebalance
    assert_eq!(
        ctx.vault.try_emergency_derisk(&1u32),
        Err(Ok(VaultError::NotKeeper))
    );
}

#[test]
fn test_resume_clears_flag_and_is_noop_when_not_derisked() {
    let env = Env::default();
    let ctx = setup(&env);
    arm_lifeboat(&env, &ctx);
    ctx.vault.emergency_derisk(&3u32);
    ctx.vault.resume();
    // `events().all()` reflects only the LAST contract invocation — capture immediately.
    let events = env.events().all();
    assert_eq!(events.events().len(), 1);
    let event = events.events().last().unwrap();
    let expected_event = LifeboatResumed { idle: 0 }.to_xdr(&env, &ctx.vault.address);
    assert_eq!(event, &expected_event);

    assert!(!ctx.vault.lifeboat_state().derisked);
    ctx.vault.resume(); // not derisked — no-op success
    // No-op resume must NOT re-fire LifeboatResumed.
    let retry_events = env.events().all();
    assert!(retry_events.events().is_empty());
}

#[test]
fn test_expired_mandate_blocks_resume_funds_stay_safe() {
    let env = Env::default();
    let ctx = setup(&env);
    let authority = Address::generate(&env);
    ctx.vault.set_mandate_authority(&authority);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    let now = env.ledger().timestamp();
    ctx.vault.set_mandate(&(now + 100));
    ctx.vault.emergency_derisk(&2u32);
    env.ledger().with_mut(|l| l.timestamp = now + 101); // mandate expires while ENGAGED
    assert_eq!(ctx.vault.try_resume(), Err(Ok(VaultError::MandateExpired)));
    assert!(ctx.vault.lifeboat_state().derisked); // expiry can never force funds back in
}

#[test]
fn test_derisk_survives_bricked_strategy() {
    let env = Env::default();
    let ctx = setup(&env);
    arm_lifeboat(&env, &ctx);
    let good = deploy_mock_strategy(&env, &ctx);
    let bad = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&good);
    ctx.vault.add_strategy(&bad);
    fund_strategy(&env, &ctx, &good, 100 * U7);
    fund_strategy(&env, &ctx, &bad, 50 * U7);
    MockStrategyClient::new(&env, &bad).set_bricked(&true); // withdraw now traps

    let drained = ctx.vault.emergency_derisk(&2u32);
    assert_eq!(drained, 100 * U7); // best-effort: good drained, bad no-oped
    assert!(ctx.vault.lifeboat_state().derisked); // rescue engages even with a stuck strategy
}

// ===== security hardening Task 4: strategy isolation + balance-delta accounting =====

#[test]
fn total_assets_clamps_negative_strategy_balance() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);

    // A hostile/broken strategy reporting a NEGATIVE balance must not shrink NAV.
    MockStrategyClient::new(&env, &strat).set_principal(&(-30 * U7));
    assert_eq!(ctx.vault.total_assets(), 100 * U7);
}

#[test]
fn compound_failed_slice_stays_idle_not_rolled_into_survivor() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100

    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &strat1, 50 * U7);
    fund_strategy(&env, &ctx, &strat2, 50 * U7);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    MockStrategyClient::new(&env, &strat1).set_deposit_bricked(&true);
    ctx.vault.compound(&Vec::from_array(&env, [0i128, 0i128]));

    // Slices are precomputed 50/50: strat1's failed slice STAYS IDLE — it is
    // never rolled into strat2's remainder cut.
    let vault_addr = ctx.vault.address.clone();
    let tk = TokenClient::new(&env, &ctx.token);
    assert_eq!(tk.balance(&vault_addr), 50 * U7);
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 100 * U7);
    // And the failed attempt's allowance is cleared — nothing left to pull later.
    assert_eq!(tk.allowance(&vault_addr, &strat1), 0);
}

#[test]
fn compound_wrong_type_deposit_counts_as_failure_and_clears_allowance() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // idle = 100

    // Hostile strategy whose deposit "succeeds" with a wrong-type return (outer Ok /
    // inner Err through the typed client) and pulls nothing.
    let wr = env.register(wrong_ret_strategy::WrongRetStrategy, ());
    wrong_ret_strategy::WrongRetStrategyClient::new(&env, &wr).set_principal(&(50 * U7));
    let healthy = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &healthy, 50 * U7);
    ctx.vault.add_strategy(&wr);
    ctx.vault.add_strategy(&healthy);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    ctx.vault.compound(&Vec::from_array(&env, [0i128, 0i128]));

    let vault_addr = ctx.vault.address.clone();
    let tk = TokenClient::new(&env, &ctx.token);
    // The hostile slice stayed idle and — critically — no standing allowance
    // survives for the hostile contract to pull later.
    assert_eq!(tk.balance(&vault_addr), 50 * U7);
    assert_eq!(tk.allowance(&vault_addr, &wr), 0);
    assert_eq!(MockStrategyClient::new(&env, &healthy).balance(), 100 * U7);
}

#[test]
fn compound_ignores_negative_harvest_report() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat = deploy_mock_strategy(&env, &ctx);
    ctx.vault.add_strategy(&strat);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    // Hostile harvest reports a NEGATIVE gain (no transfer happens).
    MockStrategyClient::new(&env, &strat).set_harvest_gain(&(-5 * U7));
    let total_gain = ctx.vault.compound(&Vec::from_array(&env, [0i128]));
    assert_eq!(total_gain, 0);
}

#[test]
fn rebalance_rejects_overreported_withdraw() {
    let env = Env::default();
    env.ledger().set_timestamp(100_000);
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7)); // 50 stays idle after funding strat1

    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &strat1, 50 * U7);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    // strat1 transfers honestly but LIES about the amount returned (+10).
    MockStrategyClient::new(&env, &strat1).set_withdraw_report_extra(&(10 * U7));

    // Delta accounting: observed vault delta (5) != reported (15) → fail closed,
    // instead of the deposit leg forwarding 15 (stealing 10 from idle).
    assert_eq!(
        ctx.vault.try_rebalance(&strat1, &strat2, &(5 * U7)),
        Err(Ok(VaultError::StrategyMisbehaved))
    );
    // Rolled back: nothing moved anywhere.
    assert_eq!(MockStrategyClient::new(&env, &strat2).balance(), 0);
}

#[test]
fn set_limits_rejects_bps_over_10000() {
    let env = Env::default();
    let ctx = setup(&env);
    assert_eq!(
        ctx.vault.try_set_limits(&3_600u64, &10_001u32),
        Err(Ok(VaultError::InvalidParam))
    );
    ctx.vault.set_limits(&3_600u64, &10_000u32); // boundary value is legal
}

#[test]
fn rebalance_cooldown_overflow_fails_closed() {
    let env = Env::default();
    env.ledger().set_timestamp(100_000);
    let ctx = setup(&env);
    let strat = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &strat, 50 * U7);
    ctx.vault.add_strategy(&strat);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);

    ctx.vault.set_limits(&0u64, &5_000u32);
    ctx.vault
        .rebalance(&strat, &ctx.vault.address.clone(), &(10 * U7)); // last_rebalance = 100_000

    // A cooldown whose gate timestamp overflows u64 must be a CLEAN CooldownActive
    // (fail closed), never an arithmetic trap.
    ctx.vault.set_limits(&u64::MAX, &5_000u32);
    env.ledger().set_timestamp(200_000);
    assert_eq!(
        ctx.vault
            .try_rebalance(&strat, &ctx.vault.address.clone(), &(10 * U7)),
        Err(Ok(VaultError::CooldownActive))
    );
}

#[test]
fn emergency_derisk_survives_overreporting_strategies_and_reports_observed_delta() {
    let env = Env::default();
    let ctx = setup(&env);
    let strat1 = deploy_mock_strategy(&env, &ctx);
    let strat2 = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &strat1, 50 * U7);
    fund_strategy(&env, &ctx, &strat2, 50 * U7);
    ctx.vault.add_strategy(&strat1);
    ctx.vault.add_strategy(&strat2);
    let keeper = Address::generate(&env);
    ctx.vault.set_keeper(&keeper);
    let authority = Address::generate(&env);
    ctx.vault.set_mandate_authority(&authority);
    ctx.vault.set_mandate(&1_000u64);

    // Both strategies drain honestly but report near-MAX values — summing the
    // reported values would overflow i128 and brick the rescue.
    let extra = i128::MAX - 100 * U7;
    MockStrategyClient::new(&env, &strat1).set_withdraw_report_extra(&extra);
    MockStrategyClient::new(&env, &strat2).set_withdraw_report_extra(&extra);

    let drained = ctx.vault.emergency_derisk(&1u32);
    // Observed token delta, not the strategies' lies.
    assert_eq!(drained, 100 * U7);
    assert!(ctx.vault.lifeboat_state().derisked);
}

#[test]
fn quarantine_restores_liveness_and_acknowledges_loss() {
    let env = Env::default();
    let ctx = setup(&env);
    let alice = Address::generate(&env);
    fund_and_approve(&env, &ctx, &alice, 100 * U7);
    ctx.vault.deposit(&alice, &(100 * U7));
    let strat = deploy_mock_strategy(&env, &ctx);
    fund_strategy(&env, &ctx, &strat, 50 * U7);
    ctx.vault.add_strategy(&strat);

    // The strategy's read path bricks: every NAV read (deposit/redeem/pps) now traps.
    MockStrategyClient::new(&env, &strat).set_balance_bricked(&true);
    assert!(ctx.vault.try_total_assets().is_err());
    // Normal removal is impossible — it requires a SUCCESSFUL zero-balance read.
    assert!(ctx.vault.try_remove_strategy(&strat).is_err());

    // Quarantine: rejects negative loss, then removes WITHOUT calling the strategy.
    assert_eq!(
        ctx.vault.try_quarantine_strategy(&strat, &(-1i128)),
        Err(Ok(VaultError::InvalidParam))
    );
    ctx.vault.quarantine_strategy(&strat, &(50 * U7));
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&ctx.vault.address)
            .events()
            .len(),
        1
    );
    assert_eq!(ctx.vault.strategies().len(), 0);

    // Liveness restored: NAV reads, deposits, and redeems all flow again.
    assert_eq!(ctx.vault.total_assets(), 100 * U7);
    let bob = Address::generate(&env);
    fund_and_approve(&env, &ctx, &bob, 10 * U7);
    ctx.vault.deposit(&bob, &(10 * U7));
    ctx.vault.redeem(&alice, &(5 * U7));
}

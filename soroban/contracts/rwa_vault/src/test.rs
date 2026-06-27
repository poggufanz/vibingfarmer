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
}

// Deploys a plain SAC asset and the yield vault wired to it. No KYC, no compliance —
// any address can deposit (plain DeFi yield farming).
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

// Admin funds itself a yield treasury and approves the vault to pull it on drip.
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
    assert_eq!(ctx.vault.decimals(), 7);
    assert_eq!(ctx.vault.total_shares(), 0);
    assert_eq!(ctx.vault.total_principal(), 0);
    assert_eq!(ctx.vault.acc_div_per_share(), 0);
    assert_eq!(ctx.vault.drip_epoch(), 0);
}

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
    ctx.vault.drip(&(40 * U7)); // 40 over 400 shares => 0.1 per share

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

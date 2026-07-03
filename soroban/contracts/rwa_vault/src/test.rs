#![cfg(test)]
use crate::types::VaultError;
use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, String};

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals (1 USDC)
const DEAD_SHARES: i128 = 1000;

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

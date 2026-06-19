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
    // `#[only_admin]` enforces the stored admin's `require_auth()` (the `_caller` arg is
    // cosmetic). Disable the mock and provide no signatures → pause must fail because the
    // admin authorization is absent.
    env.set_auths(&[]);
    let stranger = Address::generate(&env);
    assert!(vault.try_pause(&stranger).is_err());
}

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
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, 1_000 * U7);

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
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, 1_000 * U7);
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
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, 100 * U7);
    vault.deposit(&alice, &(100 * U7));
    assert!(vault.try_redeem(&alice, &(101 * U7)).is_err());
}

#[test]
fn test_deposit_blocked_when_paused_redeem_allowed() {
    let env = Env::default();
    let (vault, admin, token) = setup(&env);
    let vault_addr = vault.address.clone();
    let alice = Address::generate(&env);
    fund_and_approve(&env, &token, &admin, &alice, &vault_addr, 100 * U7);
    vault.deposit(&alice, &(100 * U7));
    vault.pause(&admin);
    assert!(vault.try_deposit(&alice, &(1 * U7)).is_err()); // deposit gated
    assert_eq!(vault.redeem(&alice, &(50 * U7)), 50 * U7);  // redeem still works
}

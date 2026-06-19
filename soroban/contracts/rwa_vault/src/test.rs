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

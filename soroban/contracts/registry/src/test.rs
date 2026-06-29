#![cfg(test)]
use crate::{Registry, RegistryClient};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{Address, Env};

#[test]
fn test_authorize_then_query_then_revoke() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(Registry, (admin.clone(),));
    let client = RegistryClient::new(&env, &id);

    let owner = Address::generate(&env);
    let agent = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);

    client.authorize(&owner, &agent, &vault, &token, &1_000_000_000i128, &86_400u64, &4_000_000_000u64);
    // SDK 26 `events().all()` returns only the LAST invocation's events, so assert
    // right after each emitting call: authorize emits exactly one event.
    assert_eq!(env.events().all().events().len(), 1);

    let rec = client.record_of(&agent);
    assert_eq!(rec.owner, owner);
    assert_eq!(rec.vault, vault);
    assert!(!rec.revoked);
    assert!(!client.is_revoked(&agent));

    client.revoke(&owner, &agent);
    // revoke emits exactly one event.
    assert_eq!(env.events().all().events().len(), 1);
    assert!(client.is_revoked(&agent));
}

#[test]
fn test_revoke_requires_owner() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Registry, (admin,));
    let client = RegistryClient::new(&env, &id);
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let agent = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);

    env.mock_all_auths();
    client.authorize(&owner, &agent, &vault, &token, &10i128, &10u64, &4_000_000_000u64);

    // Stranger tries to revoke with no auths set → must fail.
    env.set_auths(&[]);
    let res = client.try_revoke(&stranger, &agent);
    assert!(res.is_err());
}

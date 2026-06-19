#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env};

#[test]
fn test_bind_token_then_linked() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(IdentityRegistryContract, (admin.clone(), admin.clone()));
    let client = IdentityRegistryContractClient::new(&env, &id);

    // bind_tokens / linked_tokens mirrors the audited OZ IRS test. The full
    // add_identity flow (needs CountryData profiles) is exercised in the
    // rwa_token integration test (Task 5).
    let token = Address::generate(&env);
    client.bind_tokens(&vec![&env, token.clone()], &admin);
    assert_eq!(client.linked_tokens().len(), 1);
}

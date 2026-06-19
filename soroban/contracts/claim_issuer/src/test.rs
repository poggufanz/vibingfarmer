#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env};

#[test]
fn test_construct_and_unknown_key_not_allowed() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let id = env.register(ClaimIssuerContract, (owner.clone(),));
    let client = ClaimIssuerContractClient::new(&env, &id);

    // No key authorized yet -> not allowed (pure storage read, no cross-call).
    // The full allow_key flow needs a real CTI registry and is exercised in the
    // rwa_token integration test (Task 5).
    let registry = Address::generate(&env);
    let pk = Bytes::from_array(&env, &[7u8; 32]);
    assert!(!client.is_key_allowed(&pk, &registry, &1u32));
}

#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_construct_identity() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    // Construction with owner succeeds. `add_claim` cross-calls `is_claim_valid`
    // on a real claim issuer, so the full claim flow (signing + validation) is
    // exercised in the rwa_token integration test (Task 5).
    let _id = env.register(IdentityContract, (owner.clone(),));
}

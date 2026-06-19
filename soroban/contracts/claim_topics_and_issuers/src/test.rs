#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env};

#[test]
fn test_add_claim_topic_and_trusted_issuer() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(ClaimTopicsAndIssuersContract, (admin.clone(), admin.clone()));
    let client = ClaimTopicsAndIssuersContractClient::new(&env, &id);

    let issuer = Address::generate(&env);
    client.add_claim_topic(&1u32, &admin); // KYC = 1
    client.add_trusted_issuer(&issuer, &vec![&env, 1u32], &admin);
    // No panic == success.
}

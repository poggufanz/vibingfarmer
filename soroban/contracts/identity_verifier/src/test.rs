#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

fn deploy_irs_and_cti(env: &Env, admin: &Address) -> (Address, Address) {
    let irs = env.register(
        identity_registry_storage::IdentityRegistryContract,
        (admin.clone(), admin.clone()),
    );
    let cti = env.register(
        claim_topics_and_issuers::ClaimTopicsAndIssuersContract,
        (admin.clone(), admin.clone()),
    );
    (irs, cti)
}

#[test]
fn test_verify_identity_panics_for_unregistered_wallet() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (irs, cti) = deploy_irs_and_cti(&env, &admin);
    let id = env.register(IdentityVerifierContract, (admin.clone(), admin.clone(), irs, cti));
    let client = IdentityVerifierContractClient::new(&env, &id);

    let stranger = Address::generate(&env);
    // No identity registered for `stranger` -> verify must trap.
    assert!(client.try_verify_identity(&stranger).is_err());
}

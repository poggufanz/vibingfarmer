#![cfg(test)]
//! zkPass -> claim-issuer seam (ADR-B1).
//!
//! Proves the on-chain trust anchor is the CTI trusted-issuer registry: a claim
//! is only honored if its issuer is in CTI's trusted set for the topic. We trust
//! a placeholder issuer A plus the signing issuer B (so the claim is addable),
//! verify Alice via B, then revoke B's trust. Topic 1 still has a trusted issuer
//! (A), but Alice's claim is now from an untrusted issuer (B) -> verification
//! fails -> minting traps. This is exactly the gate ADR-B1's backend key sits
//! behind. Off-chain zkPass proof verification is sub-project 3
//! (see docs/soroban-kyc-seam.md).

extern crate std;

use crate::integration_test::sign_kyc_claim;
use crate::{MockRwaToken, MockRwaTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Bytes, Env, IntoVal, String, Val};
use stellar_tokens::rwa::identity_verification::identity_registry_storage::{
    CountryData, CountryRelation, IndividualCountryRelation,
};

#[test]
fn test_claim_from_untrusted_issuer_does_not_verify() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    // Topic-1 KYC. Trust a placeholder issuer A (keeps the topic non-empty after
    // we later revoke B) and the signing issuer B.
    let cti = env.register(
        claim_topics_and_issuers::ClaimTopicsAndIssuersContract,
        (admin.clone(), admin.clone()),
    );
    let issuer_a = Address::generate(&env); // placeholder trusted issuer (no keys)
    let issuer_b = env.register(claim_issuer::ClaimIssuerContract, (admin.clone(),));
    let cti_c = claim_topics_and_issuers::ClaimTopicsAndIssuersContractClient::new(&env, &cti);
    cti_c.add_claim_topic(&1u32, &admin);
    cti_c.add_trusted_issuer(&issuer_a, &vec![&env, 1u32], &admin);
    cti_c.add_trusted_issuer(&issuer_b, &vec![&env, 1u32], &admin);

    let irs = env.register(
        identity_registry_storage::IdentityRegistryContract,
        (admin.clone(), admin.clone()),
    );
    let verifier = env.register(
        identity_verifier::IdentityVerifierContract,
        (admin.clone(), admin.clone(), irs.clone(), cti.clone()),
    );
    let compliance = env.register(compliance::ComplianceContract, (admin.clone(), admin.clone()));
    let token_id = env.register(
        MockRwaToken,
        (
            String::from_str(&env, "Mock RWA"),
            String::from_str(&env, "mRWA"),
            admin.clone(),
            admin.clone(),
            compliance.clone(),
            verifier.clone(),
        ),
    );
    compliance::ComplianceContractClient::new(&env, &compliance).bind_token(&token_id, &admin);

    // Authorize B's Ed25519 signing key for topic 1 (B is trusted, so allowed).
    let secret = [9u8; 32];
    let pubkey = ed25519_dalek::SigningKey::from_bytes(&secret).verifying_key().to_bytes();
    claim_issuer::ClaimIssuerContractClient::new(&env, &issuer_b)
        .allow_key(&Bytes::from_array(&env, &pubkey), &cti, &1u32);

    // Register Alice + store a topic-1 claim signed by B.
    let alice = Address::generate(&env);
    let alice_identity = env.register(identity::IdentityContract, (admin.clone(),));
    let profile: Val = CountryData {
        country: CountryRelation::Individual(IndividualCountryRelation::Residence(360)),
        metadata: None,
    }
    .into_val(&env);
    identity_registry_storage::IdentityRegistryContractClient::new(&env, &irs).add_identity(
        &alice,
        &alice_identity,
        &vec![&env, profile],
        &admin,
    );
    let (sig_data, claim_data) =
        sign_kyc_claim(&env, &issuer_b, &alice_identity, &secret, 1u32, 0u32);
    identity::IdentityContractClient::new(&env, &alice_identity).add_claim(
        &1u32,
        &101u32,
        &issuer_b,
        &sig_data,
        &claim_data,
        &String::from_str(&env, "https://example.com/claim/alice-kyc"),
    );

    let token = MockRwaTokenClient::new(&env, &token_id);

    // While B is trusted, Alice's claim verifies -> mint succeeds.
    token.mint(&alice, &1_000_000i128, &admin);
    assert_eq!(token.balance(&alice), 1_000_000i128);

    // Revoke B's trust. Topic 1 still has trusted issuer A, but Alice's only claim
    // is from the now-untrusted B -> verification fails -> further mint traps.
    cti_c.remove_trusted_issuer(&issuer_b, &admin);
    assert!(token.try_mint(&alice, &1i128, &admin).is_err());
}

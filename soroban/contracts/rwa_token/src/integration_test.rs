#![cfg(test)]
//! Full-stack T-REX KYC integration test (headline).
//!
//! Wires the entire real claim-based stack (no mocks) and proves the spec
//! success criterion: KYC gating provably blocks a non-allowlisted wallet.
//! Alice is KYC-verified by signing a real topic-1 Ed25519 claim with the
//! trusted issuer key (the on-chain counterpart of the zkPass KYC backend,
//! ADR-B1); Bob has no identity/claim and is rejected.

extern crate std;

use crate::{MockRwaToken, MockRwaTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{vec, Address, Bytes, Env, IntoVal, String, Val};
use stellar_tokens::rwa::identity_verification::identity_registry_storage::{
    CountryData, CountryRelation, IndividualCountryRelation,
};

/// Builds a canonical RWA KYC claim and signs it with `secret` (Ed25519).
///
/// Mirrors `build_claim_message` in the audited claim-issuer storage module:
/// `message = 0x01 || network_id || issuer.to_xdr || identity.to_xdr ||
///            topic(u32 BE) || nonce(u32 BE) || claim_data`,
/// where `claim_data = created_at(u64 BE) || valid_until(u64 BE)` and
/// `sig_data = public_key(32) || signature(64)`. The trusted issuer's keypair is
/// the test double for the zkPass-fed KYC backend (ADR-B1). Returns
/// `(sig_data, claim_data)` for `identity.add_claim`.
pub(crate) fn sign_kyc_claim(
    env: &Env,
    claim_issuer: &Address,
    identity: &Address,
    secret: &[u8; 32],
    topic: u32,
    nonce: u32,
) -> (Bytes, Bytes) {
    use ed25519_dalek::{Signer, SigningKey};

    // claim_data = created_at(u64 BE) || valid_until(u64 BE). Test ledger ts = 0,
    // so a far-future valid_until keeps the claim unexpired.
    let created_at: u64 = 0;
    let valid_until: u64 = 4_000_000_000;
    let mut claim_data = Bytes::new(env);
    claim_data.extend_from_array(&created_at.to_be_bytes());
    claim_data.extend_from_array(&valid_until.to_be_bytes());

    // message bytes (must byte-match the on-chain build_claim_message).
    let mut message = Bytes::new(env);
    message.extend_from_array(&[0x01u8]); // CLAIM_MESSAGE_DOMAIN
    message.append(&Bytes::from_array(env, &env.ledger().network_id().to_array()));
    message.append(&claim_issuer.clone().to_xdr(env));
    message.append(&identity.clone().to_xdr(env));
    message.extend_from_array(&topic.to_be_bytes());
    message.extend_from_array(&nonce.to_be_bytes());
    message.append(&claim_data);

    let msg_vec: std::vec::Vec<u8> = message.iter().collect();
    let signing_key = SigningKey::from_bytes(secret);
    let pubkey = signing_key.verifying_key().to_bytes();
    let sig = signing_key.sign(&msg_vec).to_bytes();

    let mut sig_data = Bytes::new(env);
    sig_data.extend_from_array(&pubkey); // 32
    sig_data.extend_from_array(&sig); // 64
    (sig_data, claim_data)
}

/// Builds the full real T-REX stack and KYC-verifies `alice` with a topic-1
/// claim signed by the trusted issuer. Returns `(token, admin, alice)`.
fn build_stack_and_verify(env: &Env) -> (MockRwaTokenClient<'_>, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);

    // Trusted issuer's well-known test key (README): secret = 0x00..00.
    let secret = [0u8; 32];
    let pubkey = ed25519_dalek::SigningKey::from_bytes(&secret).verifying_key().to_bytes();

    // Deploy in OZ order: CTI -> claim issuer -> IRS -> verifier -> compliance -> token.
    let cti = env.register(
        claim_topics_and_issuers::ClaimTopicsAndIssuersContract,
        (admin.clone(), admin.clone()),
    );
    let claim_issuer_addr = env.register(claim_issuer::ClaimIssuerContract, (admin.clone(),));
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
            String::from_str(env, "Mock RWA"),
            String::from_str(env, "mRWA"),
            admin.clone(),
            admin.clone(),
            compliance.clone(),
            verifier.clone(),
        ),
    );

    // CTI: register KYC topic 1, trust the claim issuer for it.
    let cti_c = claim_topics_and_issuers::ClaimTopicsAndIssuersContractClient::new(env, &cti);
    cti_c.add_claim_topic(&1u32, &admin);
    cti_c.add_trusted_issuer(&claim_issuer_addr, &vec![env, 1u32], &admin);

    // Authorize the issuer's Ed25519 signing key for topic 1 (registry = CTI).
    let ci_c = claim_issuer::ClaimIssuerContractClient::new(env, &claim_issuer_addr);
    ci_c.allow_key(&Bytes::from_array(env, &pubkey), &cti, &1u32);

    // Bind the token to compliance (hooks require a bound token).
    compliance::ComplianceContractClient::new(env, &compliance).bind_token(&token_id, &admin);

    // Alice: wallet + identity contract; register wallet->identity in IRS.
    let alice = Address::generate(env);
    let alice_identity = env.register(identity::IdentityContract, (admin.clone(),));
    let profile: Val = CountryData {
        country: CountryRelation::Individual(IndividualCountryRelation::Residence(360)),
        metadata: None,
    }
    .into_val(env);
    identity_registry_storage::IdentityRegistryContractClient::new(env, &irs).add_identity(
        &alice,
        &alice_identity,
        &vec![env, profile],
        &admin,
    );

    // Sign + store a topic-1 KYC claim issued by the trusted issuer.
    let (sig_data, claim_data) =
        sign_kyc_claim(env, &claim_issuer_addr, &alice_identity, &secret, 1u32, 0u32);
    identity::IdentityContractClient::new(env, &alice_identity).add_claim(
        &1u32,
        &101u32,
        &claim_issuer_addr,
        &sig_data,
        &claim_data,
        &String::from_str(env, "https://example.com/claim/alice-kyc"),
    );

    (MockRwaTokenClient::new(env, &token_id), admin, alice)
}

#[test]
fn test_verified_holder_can_receive_unverified_cannot() {
    let env = Env::default();
    let (token, admin, alice) = build_stack_and_verify(&env);

    // Mint to KYC-verified Alice -> ok.
    token.mint(&alice, &1_000_000i128, &admin);
    assert_eq!(token.balance(&alice), 1_000_000i128);

    // Transfer to Bob (no identity, no claim) -> rejected by identity verification.
    let bob = Address::generate(&env);
    assert!(token.try_transfer(&alice, &bob, &1i128).is_err());
}

#[test]
fn test_pause_blocks_transfer_between_verified() {
    let env = Env::default();
    let (token, admin, alice) = build_stack_and_verify(&env);
    token.mint(&alice, &10i128, &admin);
    token.pause(&admin);
    // Alice is verified; a self-transfer isolates the pause guard from the
    // identity check (both endpoints pass verification), so the error is pause.
    assert!(token.try_transfer(&alice, &alice, &1i128).is_err());
}

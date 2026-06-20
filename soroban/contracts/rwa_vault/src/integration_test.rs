#![cfg(test)]
//! Full-stack T-REX vault integration (headline).
//!
//! Wires the real 1b `mRWA` T-REX token (no mocks) and proves:
//! (1) the vault works end-to-end with a KYC-gated token (deposit -> drip ->
//!     claim -> redeem), and
//! (2) the load-bearing T-REX consequence — a vault that is NOT a verified
//!     `mRWA` holder cannot receive deposits (the token transfer gate reverts).
//!
//! The claim-signing plumbing (`sign_kyc_claim`) is copied verbatim from the
//! audited 1b `rwa_token/src/integration_test.rs` so the Ed25519 KYC crypto
//! stays audited, not hand-rolled.

extern crate std;

use crate::{RwaVault, RwaVaultClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::TokenClient;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{vec, Address, Bytes, Env, IntoVal, String, Val};
use stellar_tokens::rwa::identity_verification::identity_registry_storage::{
    CountryData, CountryRelation, IndividualCountryRelation,
};

const U7: i128 = 10_000_000;

/// Builds a canonical RWA KYC claim and signs it with `secret` (Ed25519).
/// Copied verbatim from the audited 1b `rwa_token` integration test:
/// `message = 0x01 || network_id || issuer.to_xdr || identity.to_xdr ||
///            topic(u32 BE) || nonce(u32 BE) || claim_data`,
/// `claim_data = created_at(u64 BE) || valid_until(u64 BE)`,
/// `sig_data = public_key(32) || signature(64)`.
fn sign_kyc_claim(
    env: &Env,
    claim_issuer: &Address,
    identity: &Address,
    secret: &[u8; 32],
    topic: u32,
    nonce: u32,
) -> (Bytes, Bytes) {
    use ed25519_dalek::{Signer, SigningKey};

    let created_at: u64 = 0;
    let valid_until: u64 = 4_000_000_000;
    let mut claim_data = Bytes::new(env);
    claim_data.extend_from_array(&created_at.to_be_bytes());
    claim_data.extend_from_array(&valid_until.to_be_bytes());

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

struct Trex {
    token: Address,
    admin: Address,
    irs: Address,
    claim_issuer: Address,
    secret: [u8; 32],
}

/// Deploys the full real T-REX stack and trusts the issuer key for topic 1.
/// Deploy order mirrors 1b: CTI -> claim issuer -> IRS -> verifier -> compliance -> token.
fn build_trex(env: &Env) -> Trex {
    env.mock_all_auths();
    let admin = Address::generate(env);

    // Trusted issuer's well-known test key (secret = 0x00..00).
    let secret = [0u8; 32];
    let pubkey = ed25519_dalek::SigningKey::from_bytes(&secret).verifying_key().to_bytes();

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
    let token = env.register(
        rwa_token::MockRwaToken,
        (
            String::from_str(env, "Mock RWA"),
            String::from_str(env, "mRWA"),
            admin.clone(),
            admin.clone(),
            compliance.clone(),
            verifier.clone(),
        ),
    );

    // CTI: register KYC topic 1, trust the claim issuer for it, allow its signing key.
    let cti_c = claim_topics_and_issuers::ClaimTopicsAndIssuersContractClient::new(env, &cti);
    cti_c.add_claim_topic(&1u32, &admin);
    cti_c.add_trusted_issuer(&claim_issuer_addr, &vec![env, 1u32], &admin);
    claim_issuer::ClaimIssuerContractClient::new(env, &claim_issuer_addr).allow_key(
        &Bytes::from_array(env, &pubkey),
        &cti,
        &1u32,
    );

    // Bind the token to compliance (hooks require a bound token).
    compliance::ComplianceContractClient::new(env, &compliance).bind_token(&token, &admin);

    Trex { token, admin, irs, claim_issuer: claim_issuer_addr, secret }
}

/// Registers `account` as a verified mRWA holder: deploy its identity, add it to the IRS
/// with one country profile, sign + store a topic-1 KYC claim. `account` may be a wallet
/// OR a contract (e.g. the vault) — both are plain `Address`es.
fn kyc_verify(env: &Env, t: &Trex, account: &Address) {
    let identity = env.register(identity::IdentityContract, (t.admin.clone(),));
    let profile: Val = CountryData {
        country: CountryRelation::Individual(IndividualCountryRelation::Residence(360)),
        metadata: None,
    }
    .into_val(env);
    identity_registry_storage::IdentityRegistryContractClient::new(env, &t.irs).add_identity(
        account,
        &identity,
        &vec![env, profile],
        &t.admin,
    );
    let (sig_data, claim_data) = sign_kyc_claim(env, &t.claim_issuer, &identity, &t.secret, 1u32, 0u32);
    identity::IdentityContractClient::new(env, &identity).add_claim(
        &1u32,
        &101u32,
        &t.claim_issuer,
        &sig_data,
        &claim_data,
        &String::from_str(env, "https://example.com/claim/kyc"),
    );
}

fn mint_mrwa(env: &Env, t: &Trex, to: &Address, amount: i128) {
    rwa_token::MockRwaTokenClient::new(env, &t.token).mint(to, &amount, &t.admin);
}

#[test]
fn test_end_to_end_deposit_drip_claim_redeem_with_real_trex_token() {
    let env = Env::default();
    let t = build_trex(&env);

    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);

    // Deploy registry + guardrail, register the guarded vault, enroll alice permissively,
    // THEN KYC-verify the vault address (load-bearing consequence).
    let owner = Address::generate(&env);
    let reg_id = env.register(registry::Registry, (t.admin.clone(),));
    let guard_id = env.register(guardrail::Guardrail, (t.admin.clone(), reg_id.clone()));
    let vault_id = env.register(
        RwaVault,
        (
            t.admin.clone(),
            t.token.clone(),
            guard_id.clone(),
            String::from_str(&env, "Vibing Vault mRWA"),
            String::from_str(&env, "vfmRWA"),
        ),
    );
    // Now that we know vault_id, scope alice to it and police her permissively.
    registry::RegistryClient::new(&env, &reg_id).authorize(
        &owner, &alice, &vault_id, &t.token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64,
    );
    guardrail::GuardrailClient::new(&env, &guard_id).set_policy(&owner, &alice, &(1_000_000 * U7), &10_000u32);
    kyc_verify(&env, &t, &vault_id);

    let vault = RwaVaultClient::new(&env, &vault_id);
    let token = TokenClient::new(&env, &t.token);

    // Fund + approve alice; deposit.
    mint_mrwa(&env, &t, &alice, 1_000 * U7);
    let exp = env.ledger().sequence() + 100_000;
    token.approve(&alice, &vault_id, &(1_000 * U7), &exp);
    assert_eq!(vault.deposit(&alice, &(500 * U7)), 500 * U7);
    assert_eq!(vault.total_principal(), 500 * U7);

    // Drip from the admin treasury (admin must be a verified holder too).
    kyc_verify(&env, &t, &t.admin);
    mint_mrwa(&env, &t, &t.admin, 50 * U7);
    token.approve(&t.admin, &vault_id, &(50 * U7), &exp);
    vault.drip(&(50 * U7)); // 50 over 500 shares => 0.1/share

    assert_eq!(vault.claimable(&alice), 50 * U7);
    assert_eq!(vault.claim(&alice), 50 * U7);
    assert_eq!(token.balance(&alice), 550 * U7); // 1000 - 500 deposited + 50 dividend

    // Redeem principal 1:1 (stable NAV).
    assert_eq!(vault.redeem(&alice, &(500 * U7)), 500 * U7);
    assert_eq!(token.balance(&alice), 1_050 * U7); // principal back; net +50 yield
}

#[test]
fn test_deposit_reverts_when_vault_is_not_a_verified_holder() {
    let env = Env::default();
    let t = build_trex(&env);
    let alice = Address::generate(&env);
    kyc_verify(&env, &t, &alice);

    // Vault deployed (guardrail-wired) but NOT KYC-verified → alice passes the guardrail
    // (enrolled, in-policy) then the token transfer to the vault fails the T-REX gate.
    let owner = Address::generate(&env);
    let reg_id = env.register(registry::Registry, (t.admin.clone(),));
    let guard_id = env.register(guardrail::Guardrail, (t.admin.clone(), reg_id.clone()));
    let vault_id = env.register(
        RwaVault,
        (
            t.admin.clone(),
            t.token.clone(),
            guard_id.clone(),
            String::from_str(&env, "Vibing Vault mRWA"),
            String::from_str(&env, "vfmRWA"),
        ),
    );
    registry::RegistryClient::new(&env, &reg_id).authorize(
        &owner, &alice, &vault_id, &t.token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64,
    );
    guardrail::GuardrailClient::new(&env, &guard_id).set_policy(&owner, &alice, &(1_000_000 * U7), &10_000u32);
    let vault = RwaVaultClient::new(&env, &vault_id);
    let token = TokenClient::new(&env, &t.token);
    mint_mrwa(&env, &t, &alice, 100 * U7);
    let exp = env.ledger().sequence() + 100_000;
    token.approve(&alice, &vault_id, &(100 * U7), &exp);

    assert!(vault.try_deposit(&alice, &(100 * U7)).is_err()); // vault not verified => reverts
}

/// Off-chain claim generator (NOT part of the suite — `#[ignore]`d).
///
/// `scripts/soroban/deploy-seed.sh` runs this to mint a real Ed25519 topic-1 KYC
/// claim for the deployed vault identity, so the vault registers as a verified
/// `mRWA` holder on testnet. It reuses the audited [`sign_kyc_claim`] path
/// verbatim; the ONLY testnet-specific input is the ledger `network_id`
/// (`SHA-256` of the network passphrase), which the on-chain
/// `build_claim_message` reads from `e.ledger().network_id()`.
///
/// Run (from `soroban/`, WSL login shell):
/// ```sh
/// CLAIM_ISSUER=C... VAULT_IDENTITY=C... \
///   cargo test -p rwa_vault gen_testnet_vault_claim -- --ignored --nocapture
/// ```
/// Emits `SIGNER_PUBKEY=`, `SIGNER_SIG_DATA=`, `SIGNER_CLAIM_DATA=` (hex) lines.
#[test]
#[ignore = "off-chain claim generator; needs CLAIM_ISSUER + VAULT_IDENTITY env vars"]
fn gen_testnet_vault_claim() {
    use soroban_sdk::testutils::Ledger as _;

    let env = Env::default();

    // Testnet network id = SHA-256(passphrase). Compute it the way the host does
    // so the signed message matches on-chain verification exactly.
    let passphrase = b"Test SDF Network ; September 2015";
    let network_id = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, passphrase))
        .to_array();
    env.ledger().with_mut(|li| li.network_id = network_id);

    let issuer_str = std::env::var("CLAIM_ISSUER").expect("CLAIM_ISSUER env var required");
    let identity_str = std::env::var("VAULT_IDENTITY").expect("VAULT_IDENTITY env var required");
    let claim_issuer = Address::from_string(&String::from_str(&env, &issuer_str));
    let identity = Address::from_string(&String::from_str(&env, &identity_str));

    // Well-known test issuer key (secret = 0x00..00); matches `build_trex`'s
    // `allow_key`. Topic 1 (KYC), nonce 0 (first claim for this identity+topic).
    let secret = [0u8; 32];
    let (sig_data, claim_data) = sign_kyc_claim(&env, &claim_issuer, &identity, &secret, 1u32, 0u32);

    let to_hex = |b: &Bytes| -> std::string::String {
        let mut s = std::string::String::with_capacity((b.len() as usize) * 2);
        for byte in b.iter() {
            s.push_str(&std::format!("{byte:02x}"));
        }
        s
    };

    std::println!("SIGNER_PUBKEY={}", to_hex(&sig_data.slice(0..32)));
    std::println!("SIGNER_SIG_DATA={}", to_hex(&sig_data));
    std::println!("SIGNER_CLAIM_DATA={}", to_hex(&claim_data));
}

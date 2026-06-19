#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, Address, Env, String};

// --- Test doubles (loose coupling lets us mock the collaborators) ---

// Mock identity verifier: verifies only addresses added via `allow`.
#[contract]
pub struct MockVerifier;
#[contractimpl]
impl MockVerifier {
    pub fn allow(e: &Env, who: Address) {
        e.storage().persistent().set(&who, &true);
    }
    pub fn verify_identity(e: &Env, account: Address) {
        let ok: bool = e.storage().persistent().get(&account).unwrap_or(false);
        if !ok {
            panic!("identity not verified");
        }
    }
}

// Mock compliance: allow-all (mirrors OZ "no modules registered" default).
// Signatures must match the `Compliance` trait surface the RWA token cross-calls.
#[contract]
pub struct MockCompliance;
#[contractimpl]
impl MockCompliance {
    pub fn can_transfer(_e: &Env, _from: Address, _to: Address, _amount: i128, _token: Address) -> bool {
        true
    }
    pub fn can_create(_e: &Env, _to: Address, _amount: i128, _token: Address) -> bool {
        true
    }
    pub fn created(_e: &Env, _to: Address, _amount: i128, _token: Address) {}
    pub fn destroyed(_e: &Env, _from: Address, _amount: i128, _token: Address) {}
    pub fn transferred(_e: &Env, _from: Address, _to: Address, _amount: i128, _token: Address) {}
}

fn setup<'a>(env: &'a Env) -> (MockRwaTokenClient<'a>, Address, MockVerifierClient<'a>) {
    env.mock_all_auths();
    let admin = Address::generate(env); // admin == manager for the unit tests
    let verifier_id = env.register(MockVerifier, ());
    let compliance_id = env.register(MockCompliance, ());
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let token_id = env.register(
        MockRwaToken,
        (
            String::from_str(env, "Mock RWA"),
            String::from_str(env, "mRWA"),
            admin.clone(),
            admin.clone(),
            compliance_id,
            verifier_id,
        ),
    );
    (MockRwaTokenClient::new(env, &token_id), admin, verifier)
}

#[test]
fn test_metadata_is_seven_decimals() {
    let env = Env::default();
    let (token, _admin, _v) = setup(&env);
    assert_eq!(token.decimals(), 7);
    assert_eq!(token.symbol(), String::from_str(&env, "mRWA"));
}

#[test]
fn test_mint_to_unverified_holder_rejected() {
    let env = Env::default();
    let (token, admin, _v) = setup(&env);
    let bob = Address::generate(&env);
    // Bob is not verified -> mint must trap.
    assert!(token.try_mint(&bob, &1_000_000i128, &admin).is_err());
}

#[test]
fn test_mint_to_verified_holder_succeeds() {
    let env = Env::default();
    let (token, admin, verifier) = setup(&env);
    let alice = Address::generate(&env);
    verifier.allow(&alice);
    token.mint(&alice, &1_000_000i128, &admin);
    assert_eq!(token.balance(&alice), 1_000_000i128);
}

#[test]
fn test_pause_blocks_transfer() {
    // README guarantees pause blocks transfers (admin ops still work), so this
    // is the reliable pause assertion vs. mint-pause (plan's stated fallback).
    let env = Env::default();
    let (token, admin, verifier) = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    verifier.allow(&alice);
    verifier.allow(&bob);
    token.mint(&alice, &1_000_000i128, &admin);
    token.pause(&admin);
    assert!(token.try_transfer(&alice, &bob, &1i128).is_err());
}

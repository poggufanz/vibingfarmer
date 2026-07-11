#![cfg(test)]
use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    Address, BytesN, Env,
};

fn setup(env: &Env) -> (AttestationClient<'static>, Address) {
    let id = env.register(Attestation, ());
    let client = AttestationClient::new(env, &id);
    let attester = Address::generate(env);
    (client, attester)
}

#[test]
fn attest_increments_count_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, attester) = setup(&env);
    let h = BytesN::from_array(&env, &[7u8; 32]);

    let n1 = client.attest(&attester, &h, &symbol_short!("venice"));
    assert_eq!(n1, 1);
    // events().all() returns only the last invocation's events
    assert_eq!(env.events().all().events().len(), 1);

    let n2 = client.attest(&attester, &h, &symbol_short!("venice"));
    assert_eq!(n2, 2);
    assert_eq!(client.count_of(&attester), 2);
}

#[test]
fn count_of_is_zero_for_unknown_attester() {
    let env = Env::default();
    let (client, attester) = setup(&env);
    assert_eq!(client.count_of(&attester), 0);
}

#[test]
fn attest_rejects_without_auth() {
    let env = Env::default();
    // no mock_all_auths → require_auth has nothing to satisfy
    let (client, attester) = setup(&env);
    let h = BytesN::from_array(&env, &[1u8; 32]);
    let res = client.try_attest(&attester, &h, &symbol_short!("strat"));
    assert!(res.is_err());
}

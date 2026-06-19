#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_allow_gates_can_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let compliance = Address::generate(&env);
    let id = env.register(
        ComplianceAllowContract,
        (admin.clone(), admin.clone(), compliance.clone()),
    );
    let client = ComplianceAllowContractClient::new(&env, &id);

    let token = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    // Nobody allowed yet -> transfer disallowed. (trait sig: from, to, amount, token)
    assert!(!client.can_transfer(&from, &to, &100i128, &token));

    // Allow both parties -> transfer allowed.
    client.allow_account(&from, &admin);
    client.allow_account(&to, &admin);
    assert!(client.can_transfer(&from, &to, &100i128, &token));

    // can_create gates on the recipient only.
    assert!(client.can_create(&to, &100i128, &token));
    let stranger = Address::generate(&env);
    assert!(!client.can_create(&stranger, &100i128, &token));
}

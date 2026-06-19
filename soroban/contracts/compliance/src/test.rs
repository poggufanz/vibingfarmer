#![cfg(test)]
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};
use stellar_tokens::rwa::compliance::ComplianceHook;

#[test]
fn test_add_module_to_hook() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(ComplianceContract, (admin.clone(), admin.clone()));
    let client = ComplianceContractClient::new(&env, &id);

    let module = Address::generate(&env);
    client.add_module_to(&ComplianceHook::CanTransfer, &module, &admin);
    // No panic == success.
}

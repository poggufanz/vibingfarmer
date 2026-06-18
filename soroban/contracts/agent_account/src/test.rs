#![cfg(test)]
use crate::types::AgentScope;
use crate::{AgentAccount, AgentAccountClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};

fn scope(_env: &Env, owner: &Address, vault: &Address, token: &Address) -> AgentScope {
    AgentScope {
        owner: owner.clone(),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: 1_000_000_000, // 1,000 units @ 6dp
        period_duration: 86_400,       // 1 day
        spent_in_period: 0,
        period_start: 0,
        expiry: 4_000_000_000, // far future
        revoked: false,
    }
}

#[test]
fn test_constructor_stores_scope_and_key() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    let s = scope(&env, &owner, &vault, &token);

    let id = env.register(AgentAccount, (owner.clone(), pubkey.clone(), s.clone()));
    let client = AgentAccountClient::new(&env, &id);

    let got = client.scope_of();
    assert_eq!(got.vault, vault);
    assert_eq!(got.cap_per_period, 1_000_000_000);
    assert_eq!(got.revoked, false);
    assert_eq!(client.signer(), pubkey);
}

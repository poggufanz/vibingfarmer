#![no_std]
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

mod account;
mod test;
pub mod types;
pub mod vault_client;

use types::{AgentScope, DataKey};

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    /// Deployed once per worker agent. `owner` = the human EOA that granted the
    /// scope; `signer` = the ephemeral ed25519 session pubkey the worker signs with.
    pub fn __constructor(env: Env, owner: Address, signer: BytesN<32>, scope: AgentScope) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Scope, &scope);
    }

    pub fn scope_of(env: Env) -> AgentScope {
        env.storage().instance().get(&DataKey::Scope).unwrap()
    }

    pub fn signer(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Signer).unwrap()
    }

    pub fn version(_env: Env) -> u32 {
        1
    }
}

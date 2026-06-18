#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

pub mod types;
mod registry;
mod test;

use types::{AgentRecord, DataKey, RegistryError};

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn authorize(
        env: Env,
        owner: Address,
        agent: Address,
        vault: Address,
        token: Address,
        cap_per_period: i128,
        period_duration: u64,
        expiry: u64,
    ) {
        Self::authorize_impl(&env, owner, agent, vault, token, cap_per_period, period_duration, expiry);
    }

    pub fn revoke(env: Env, owner: Address, agent: Address) -> Result<(), RegistryError> {
        Self::revoke_impl(&env, owner, agent)
    }

    pub fn record_of(env: Env, agent: Address) -> AgentRecord {
        env.storage().persistent().get(&DataKey::Record(agent)).unwrap()
    }

    pub fn is_revoked(env: Env, agent: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Record(agent))
            .map(|r: AgentRecord| r.revoked)
            .unwrap_or(true) // unknown agent = treated as revoked (fail-closed)
    }
}

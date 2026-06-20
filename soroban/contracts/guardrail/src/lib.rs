#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};
use registry::RegistryClient;

pub mod types;
pub mod storage;
mod guardrail;
mod test;

use types::{GuardrailError, Policy, SpendState};

#[contract]
pub struct Guardrail;

#[contractimpl]
impl Guardrail {
    /// admin = set_nav authority (protocol/issuer); registry = deployed 1a registry address.
    pub fn __constructor(e: &Env, admin: Address, registry: Address) {
        storage::set_admin(e, &admin);
        storage::set_registry(e, &registry);
        storage::extend_instance(e);
    }

    pub fn set_nav(e: &Env, vault: Address, nav: i128) -> Result<(), GuardrailError> {
        guardrail::set_nav(e, vault, nav)
    }

    pub fn set_policy(
        e: &Env,
        owner: Address,
        agent: Address,
        max_exposure: i128,
        max_pct_bps: u32,
    ) -> Result<(), GuardrailError> {
        guardrail::set_policy(e, owner, agent, max_exposure, max_pct_bps)
    }

    pub fn consume(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
        guardrail::consume(e, agent, vault, amount)
    }

    // release lands in Task 3.

    // ----- read views -----
    pub fn admin(e: &Env) -> Address {
        storage::get_admin(e)
    }
    pub fn registry(e: &Env) -> Address {
        storage::get_registry(e)
    }
    pub fn nav_of(e: &Env, vault: Address) -> i128 {
        storage::get_nav(e, &vault)
    }
    pub fn policy_of(e: &Env, agent: Address) -> Policy {
        storage::get_policy(e, &agent).unwrap()
    }
    pub fn spend_of(e: &Env, agent: Address) -> SpendState {
        storage::get_spend(e, &agent)
    }
    pub fn total_value_of(e: &Env, agent: Address) -> i128 {
        let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
        storage::get_total_value(e, &owner)
    }
    pub fn position_of(e: &Env, agent: Address, vault: Address) -> i128 {
        let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
        storage::get_position(e, &owner, &vault)
    }
}

#![no_std]
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    pub fn version(_env: Env) -> u32 {
        1
    }
}

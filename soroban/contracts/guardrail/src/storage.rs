use soroban_sdk::{Address, Env};

use crate::types::{DataKey, Policy, SpendState};

pub const DEFAULT_NAV: i128 = 10_000_000; // $1.00 at 7 decimals (stable-NAV money-market default)

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

pub fn extend_instance(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}
fn extend_persistent(e: &Env, key: &DataKey) {
    e.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

pub fn set_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}
pub fn get_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_registry(e: &Env, registry: &Address) {
    e.storage().instance().set(&DataKey::Registry, registry);
}
pub fn get_registry(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Registry).unwrap()
}

pub fn set_policy(e: &Env, agent: &Address, policy: &Policy) {
    let key = DataKey::Policy(agent.clone());
    e.storage().persistent().set(&key, policy);
    extend_persistent(e, &key);
}
pub fn get_policy(e: &Env, agent: &Address) -> Option<Policy> {
    e.storage().persistent().get(&DataKey::Policy(agent.clone()))
}

pub fn set_spend(e: &Env, agent: &Address, spend: &SpendState) {
    let key = DataKey::Spend(agent.clone());
    e.storage().persistent().set(&key, spend);
    extend_persistent(e, &key);
}
pub fn get_spend(e: &Env, agent: &Address) -> SpendState {
    e.storage()
        .persistent()
        .get(&DataKey::Spend(agent.clone()))
        .unwrap_or(SpendState { spent_in_period: 0, period_start: 0 })
}

pub fn set_position(e: &Env, owner: &Address, vault: &Address, v: i128) {
    let key = DataKey::Position(owner.clone(), vault.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_position(e: &Env, owner: &Address, vault: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Position(owner.clone(), vault.clone()))
        .unwrap_or(0)
}

pub fn set_total_value(e: &Env, owner: &Address, v: i128) {
    let key = DataKey::TotalValue(owner.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_total_value(e: &Env, owner: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::TotalValue(owner.clone()))
        .unwrap_or(0)
}

pub fn set_nav(e: &Env, vault: &Address, nav: i128) {
    let key = DataKey::Nav(vault.clone());
    e.storage().persistent().set(&key, &nav);
    extend_persistent(e, &key);
}
pub fn get_nav(e: &Env, vault: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Nav(vault.clone()))
        .unwrap_or(DEFAULT_NAV)
}

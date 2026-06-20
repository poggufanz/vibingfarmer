use soroban_sdk::{Address, Env};

use crate::types::DataKey;

// Fixed-point scale for the cumulative dividend index. 1e12 keeps precision for
// 7-dp amounts while staying far inside i128 (shares*acc < ~1e28 << i128::MAX).
pub const SCALE: i128 = 1_000_000_000_000;

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

pub fn extend_instance(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

fn extend_persistent(e: &Env, key: &DataKey) {
    e.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

pub fn set_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::Token, token);
}
pub fn get_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Token).unwrap()
}

pub fn set_acc(e: &Env, acc: i128) {
    e.storage().instance().set(&DataKey::AccDivPerShare, &acc);
}
pub fn get_acc(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::AccDivPerShare).unwrap_or(0)
}

pub fn set_total_principal(e: &Env, v: i128) {
    e.storage().instance().set(&DataKey::TotalPrincipal, &v);
}
pub fn get_total_principal(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::TotalPrincipal).unwrap_or(0)
}

pub fn set_drip_epoch(e: &Env, v: u64) {
    e.storage().instance().set(&DataKey::DripEpoch, &v);
}
pub fn get_drip_epoch(e: &Env) -> u64 {
    e.storage().instance().get(&DataKey::DripEpoch).unwrap_or(0)
}

pub fn set_reward_debt(e: &Env, holder: &Address, v: i128) {
    let key = DataKey::RewardDebt(holder.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_reward_debt(e: &Env, holder: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::RewardDebt(holder.clone()))
        .unwrap_or(0)
}

pub fn set_pending(e: &Env, holder: &Address, v: i128) {
    let key = DataKey::Pending(holder.clone());
    e.storage().persistent().set(&key, &v);
    extend_persistent(e, &key);
}
pub fn get_pending(e: &Env, holder: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Pending(holder.clone()))
        .unwrap_or(0)
}

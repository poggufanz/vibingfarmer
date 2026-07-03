use soroban_sdk::{Address, Env};

use crate::types::DataKey;

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

pub fn extend_instance(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

pub fn set_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::Token, token);
}
pub fn get_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Token).unwrap()
}

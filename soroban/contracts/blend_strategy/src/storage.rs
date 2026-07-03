use crate::types::DataKey;
use soroban_sdk::{Address, Env};

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

pub fn extend_instance(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

pub fn set_vault(e: &Env, vault: &Address) {
    e.storage().instance().set(&DataKey::Vault, vault);
}
pub fn get_vault(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Vault).unwrap()
}

pub fn set_pool(e: &Env, pool: &Address) {
    e.storage().instance().set(&DataKey::Pool, pool);
}
pub fn get_pool(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Pool).unwrap()
}

pub fn set_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::Token, token);
}
pub fn get_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Token).unwrap()
}

pub fn set_blnd(e: &Env, blnd: &Address) {
    e.storage().instance().set(&DataKey::Blnd, blnd);
}
/// Read by `harvest`'s BLND claim + swap path.
pub fn get_blnd(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Blnd).unwrap()
}

pub fn set_router(e: &Env, router: &Address) {
    e.storage().instance().set(&DataKey::Router, router);
}
/// Read by `harvest` to route BLND -> Token swaps through Soroswap.
pub fn get_router(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Router).unwrap()
}

pub fn set_reserve_token_id(e: &Env, id: u32) {
    e.storage().instance().set(&DataKey::ReserveTokenId, &id);
}
/// Read by `harvest` and passed to the pool's `claim` as the reserve index to claim for.
pub fn get_reserve_token_id(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::ReserveTokenId)
        .unwrap()
}

pub fn set_principal(e: &Env, v: i128) {
    e.storage().instance().set(&DataKey::Principal, &v);
}
pub fn get_principal(e: &Env) -> i128 {
    e.storage().instance().get(&DataKey::Principal).unwrap_or(0)
}

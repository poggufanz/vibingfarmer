use soroban_sdk::{Address, Env, Vec};

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

/// Registered strategy contracts, drained in order on redeem. Empty until `add_strategy`
/// is first called — no explicit default is stored, so reads before that fall back here.
pub fn get_strategies(e: &Env) -> Vec<Address> {
    e.storage()
        .instance()
        .get(&DataKey::Strategies)
        .unwrap_or(Vec::new(e))
}
pub fn set_strategies(e: &Env, list: &Vec<Address>) {
    e.storage().instance().set(&DataKey::Strategies, list);
}

/// Read by `compound`/`rebalance` (Task 8/9) to gate keeper-only calls. `None` until
/// `set_keeper` is first called — `require_keeper` (Task 8) treats that as `NotKeeper`
/// rather than unwrapping and panicking.
pub fn get_keeper(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::Keeper)
}
pub fn set_keeper(e: &Env, keeper: &Address) {
    e.storage().instance().set(&DataKey::Keeper, keeper);
}

/// Read by `rebalance`'s cooldown gate (Task 9). Constructor seeds this to 0, so the very
/// first rebalance ever called always passes the cooldown check regardless of ledger time.
pub fn set_last_rebalance(e: &Env, ts: u64) {
    e.storage().instance().set(&DataKey::LastRebalance, &ts);
}
pub fn get_last_rebalance(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::LastRebalance)
        .unwrap_or(0)
}

pub fn set_cooldown_s(e: &Env, v: u64) {
    e.storage().instance().set(&DataKey::CooldownS, &v);
}
/// Read by `rebalance`'s cooldown gate (Task 9). Constructor seeds this via `set_limits`'s
/// default (`DEFAULT_COOLDOWN_S`), so this only falls back to 0 pre-constructor.
pub fn get_cooldown_s(e: &Env) -> u64 {
    e.storage().instance().get(&DataKey::CooldownS).unwrap_or(0)
}
pub fn set_max_move_bps(e: &Env, v: u32) {
    e.storage().instance().set(&DataKey::MaxMoveBps, &v);
}
/// Read by `rebalance`'s per-move cap (Task 9). Constructor seeds this via `set_limits`'s
/// default (`DEFAULT_MAX_MOVE_BPS`).
pub fn get_max_move_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::MaxMoveBps)
        .unwrap_or(0)
}

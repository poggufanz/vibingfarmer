use soroban_sdk::{Address, Env, Vec};

use crate::types::{DataKey, PendingUpgrade};

const TTL_THRESHOLD: u32 = 17_280; // ~1 day @ 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

/// Fallback for `get_compound_cooldown_s` (Task R1) when `CompoundCooldownS` was never
/// explicitly set via `set_compound_cooldown`. Matches the off-chain keeper's ~15 min cron
/// interval, so the gate is a no-op for normal keeper operation with no deploy-time change
/// required. Deliberately read as a getter fallback rather than seeded by the constructor —
/// a wasm-upgraded, already-deployed vault never re-runs `__constructor`, so seeding there
/// would leave old vaults' storage without the key and this default would never apply to them.
pub const DEFAULT_COMPOUND_COOLDOWN_S: u64 = 600;

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

/// Read by `compound`'s cooldown gate (Task R1). `None` means "never compounded" — NOT the
/// same as 0, so the very first compound ever called always passes the gate regardless of
/// ledger time, mirroring how `get_keeper` (Option) lets `require_keeper` distinguish "never
/// set" from a real value rather than defaulting to something that could wrongly pass/fail.
pub fn get_last_compound(e: &Env) -> Option<u64> {
    e.storage().instance().get(&DataKey::LastCompound)
}
pub fn set_last_compound(e: &Env, ts: u64) {
    e.storage().instance().set(&DataKey::LastCompound, &ts);
}

/// Admin-only in practice — set exclusively via `vault::set_compound_cooldown`.
pub fn set_compound_cooldown_s(e: &Env, v: u64) {
    e.storage().instance().set(&DataKey::CompoundCooldownS, &v);
}
/// Read by `compound`'s cooldown gate (Task R1). Falls back to `DEFAULT_COMPOUND_COOLDOWN_S`
/// when `set_compound_cooldown` has never been called — covers both a fresh vault and an
/// already-deployed vault immediately after a wasm upgrade (see the constant's own doc).
pub fn get_compound_cooldown_s(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::CompoundCooldownS)
        .unwrap_or(DEFAULT_COMPOUND_COOLDOWN_S)
}

pub fn get_mandate_authority(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::MandateAuthority)
}
pub fn set_mandate_authority(e: &Env, a: &Address) {
    e.storage().instance().set(&DataKey::MandateAuthority, a);
}

/// Absent = 0 = never granted = always expired (fail-closed): the keeper cannot act
/// until the mandate authority explicitly grants a future expiry.
pub fn get_mandate_expiry(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::MandateExpiry)
        .unwrap_or(0)
}
pub fn set_mandate_expiry(e: &Env, ts: u64) {
    e.storage().instance().set(&DataKey::MandateExpiry, &ts);
}

pub fn get_derisked(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Derisked)
        .unwrap_or(false)
}
pub fn set_derisked(e: &Env, v: bool) {
    e.storage().instance().set(&DataKey::Derisked, &v);
}

pub fn get_pending_upgrade(e: &Env) -> Option<PendingUpgrade> {
    e.storage().instance().get(&DataKey::PendingUpgrade)
}
pub fn set_pending_upgrade(e: &Env, p: &PendingUpgrade) {
    e.storage().instance().set(&DataKey::PendingUpgrade, p);
}
pub fn remove_pending_upgrade(e: &Env) {
    e.storage().instance().remove(&DataKey::PendingUpgrade);
}

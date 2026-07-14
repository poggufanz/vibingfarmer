#![no_std]
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::only_admin;
use stellar_tokens::fungible::Base;

pub mod storage;
mod test;
pub mod types;
mod vault;
// The `StrategyIface` trait exists only to generate `StrategyClient` (used across
// `vault::total_assets`/`ensure_idle`/`compound`); the trait itself is never implemented or
// named as a bound — silence the dead-code lint on the whole module rather than the locked
// trait body.
#[allow(dead_code)]
mod strategy_client;

use storage::{
    extend_instance, get_token, set_cooldown_s, set_last_rebalance, set_max_move_bps, set_token,
};

/// Rebalance cooldown default (Task 9 enforces it): 24h between rebalances.
const DEFAULT_COOLDOWN_S: u64 = 86_400;
/// Rebalance per-move cap default (Task 9 enforces it): 50% of `total_assets` per call.
const DEFAULT_MAX_MOVE_BPS: u32 = 5_000;

#[contract]
pub struct RwaVault;

#[contractimpl]
impl RwaVault {
    /// Deployed once. `token` = the yield-farming asset (SEP-41 token / SAC) this vault
    /// accepts for deposits and pays out on redeem. The vault is a share-ledger priced by
    /// exchange rate: `price_per_share = total_assets / total_supply`.
    pub fn __constructor(e: &Env, admin: Address, token: Address, name: String, symbol: String) {
        Base::set_metadata(e, 7, name, symbol); // 7 decimals (match the asset)
        set_token(e, &token);
        access_control::set_admin(e, &admin); // powers only_admin (pause/unpause)
        set_cooldown_s(e, DEFAULT_COOLDOWN_S);
        set_max_move_bps(e, DEFAULT_MAX_MOVE_BPS);
        set_last_rebalance(e, 0);
        extend_instance(e);
    }

    // ----- read views -----
    pub fn admin(e: &Env) -> Address {
        access_control::get_admin(e).unwrap()
    }
    pub fn token(e: &Env) -> Address {
        get_token(e)
    }
    pub fn decimals(_e: &Env) -> u32 {
        7
    }
    /// Vault-share balance (non-transferable position) of `id`.
    pub fn balance(e: &Env, id: Address) -> i128 {
        Base::balance(e, &id)
    }
    pub fn total_shares(e: &Env) -> i128 {
        Base::total_supply(e)
    }

    /// Total assets backing every share. This task: idle USDC only (Task 7 adds the sum of
    /// strategy balances).
    pub fn total_assets(e: &Env) -> i128 {
        vault::total_assets(e)
    }

    /// Exchange rate: assets per share scaled by `PPS_SCALE` (7dp). `1e7` == 1.0. Compound
    /// gains (Task 8) raise `total_assets`, so each share prices higher over time.
    pub fn price_per_share(e: &Env) -> i128 {
        vault::price_per_share(e)
    }

    // ----- deposit / redeem -----
    /// deposit(from, amount) -> shares minted. fn-symbol `deposit`, amount = args[1] (1a pin).
    pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, types::VaultError> {
        vault::deposit(e, from, amount)
    }

    /// redeem(from, shares) -> assets returned pro-rata at the current exchange rate.
    pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, types::VaultError> {
        vault::redeem(e, from, shares)
    }

    // ----- strategy registry (Task 7) -----
    /// Registered strategy addresses, in drain order.
    pub fn strategies(e: &Env) -> Vec<Address> {
        vault::strategies(e)
    }
    /// Admin-only. Registers a strategy; rejects a 5th (`TooManyStrategies`).
    pub fn add_strategy(e: &Env, strategy: Address) -> Result<(), types::VaultError> {
        vault::add_strategy(e, strategy)
    }
    /// Admin-only. Deregisters a strategy once a SUCCESSFUL balance read returns 0.
    pub fn remove_strategy(e: &Env, strategy: Address) -> Result<(), types::VaultError> {
        vault::remove_strategy(e, strategy)
    }
    /// Admin-only incident hatch. Removes a strategy WITHOUT calling it (for bricked
    /// `balance()`/`withdraw`), acknowledging `acknowledged_loss` (nonnegative) as the NAV
    /// write-off. Restores deposit/redeem/price liveness immediately.
    pub fn quarantine_strategy(
        e: &Env,
        strategy: Address,
        acknowledged_loss: i128,
    ) -> Result<(), types::VaultError> {
        vault::quarantine_strategy(e, strategy, acknowledged_loss)
    }
    /// Admin-only. Sets the keeper permitted to call `compound`/`rebalance` (Task 8/9).
    pub fn set_keeper(e: &Env, keeper: Address) {
        vault::set_keeper_addr(e, keeper)
    }
    /// The address currently permitted to call `compound`/`rebalance` (Task 8/9).
    pub fn keeper(e: &Env) -> Address {
        vault::keeper(e)
    }
    /// Admin-only. Sets the rebalance cooldown (seconds) and per-move cap (bps ≤ 10_000),
    /// both enforced starting Task 9.
    pub fn set_limits(
        e: &Env,
        cooldown_s: u64,
        max_move_bps: u32,
    ) -> Result<(), types::VaultError> {
        vault::set_limits(e, cooldown_s, max_move_bps)
    }
    /// Admin-only. Sets the min seconds between `compound` calls (Task R1). Kept separate
    /// from `set_limits` (rebalance-only) — see `vault::set_compound_cooldown`.
    pub fn set_compound_cooldown(e: &Env, cooldown_s: u64) {
        vault::set_compound_cooldown(e, cooldown_s)
    }
    /// Admin-only. Sets the address allowed to grant/renew the lifeboat mandate.
    pub fn set_mandate_authority(e: &Env, authority: Address) {
        vault::set_mandate_authority(e, authority)
    }
    /// Authority-signed. Grants/renews the time-boxed lifeboat mandate.
    pub fn set_mandate(e: &Env, expiry: u64) -> Result<(), types::VaultError> {
        vault::set_mandate(e, expiry)
    }
    /// Current lifeboat state: derisked flag, mandate expiry, and authority address.
    pub fn lifeboat_state(e: &Env) -> types::LifeboatState {
        vault::lifeboat_state(e)
    }
    /// Keeper-only, mandate-gated. Drains every strategy best-effort and engages the
    /// Derisked flag, blocking compound/rebalance until `resume`. Idempotent.
    pub fn emergency_derisk(e: &Env, reason_code: u32) -> Result<i128, types::VaultError> {
        vault::emergency_derisk(e, reason_code)
    }
    /// Keeper-only, mandate-gated. Clears the Derisked flag once the rescue is over.
    pub fn resume(e: &Env) -> Result<(), types::VaultError> {
        vault::resume(e)
    }

    // ----- keeper ops (Task 8) -----
    /// Keeper-only, cooldown-gated (Task R1) and per-strategy fault-isolated. Harvests every
    /// registered strategy's realized gain into idle, then sweeps all idle back into
    /// strategies pro-rata. `min_outs` is indexed by `strategies()` order; its length must
    /// match. Returns the total gain realized.
    pub fn compound(e: &Env, min_outs: Vec<i128>) -> Result<i128, types::VaultError> {
        vault::compound(e, min_outs)
    }

    // ----- keeper ops (Task 9) -----
    /// Keeper-only. Moves `amount` from strategy `from` into `to` — `to` may be another
    /// registered strategy, or this vault's own address (de-risk-to-idle fallback). Gated by
    /// a cooldown and a per-move cap (both set via `set_limits`).
    pub fn rebalance(
        e: &Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), types::VaultError> {
        vault::rebalance(e, from, to, amount)
    }

    // ----- admin escape hatches (Task 9) -----
    /// Admin-only, NOT pause-gated. Drains `strategy` fully back to vault idle.
    pub fn emergency_withdraw(e: &Env, strategy: Address) {
        vault::emergency_withdraw(e, strategy)
    }
    /// Admin-only. Swaps the contract's wasm.
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        vault::upgrade(e, new_wasm_hash)
    }
}

#[contractimpl(contracttrait)]
impl Pausable for RwaVault {
    #[only_admin]
    fn pause(e: &Env, _caller: Address) {
        pausable::pause(e);
    }
    #[only_admin]
    fn unpause(e: &Env, _caller: Address) {
        pausable::unpause(e);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for RwaVault {}

use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, Env, Vec};
use stellar_access::access_control;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{
    extend_instance, get_keeper, get_strategies, get_token, set_cooldown_s, set_keeper,
    set_max_move_bps, set_strategies,
};
use crate::strategy_client::StrategyClient;
use crate::types::{Deposit, Redeem, VaultError};

/// Shares minted to the vault itself on the first deposit and locked forever. Guards against
/// the classic ERC-4626 inflation / first-depositor donation attack: an attacker can no
/// longer own 100% of a 1-share supply and round every later depositor's shares to zero.
pub(crate) const DEAD_SHARES: i128 = 1000;
/// Minimum first deposit (1 USDC at 7dp). Keeps DEAD_SHARES an immaterial slice and makes
/// the initial price-per-share meaningful.
const MIN_FIRST_DEPOSIT: i128 = 1_0000000;
/// Fixed-point scale for `price_per_share` (7dp): 1e7 == 1.0 asset per share.
pub const PPS_SCALE: i128 = 1_0000000;
/// Registry cap — `add_strategy` rejects a 5th entry with `TooManyStrategies`.
const MAX_STRATEGIES: u32 = 4;

fn require_admin(e: &Env) {
    access_control::get_admin(e).unwrap().require_auth();
}

/// Total assets backing every share: idle USDC held by the vault plus every registered
/// strategy's reported `balance()`.
pub fn total_assets(e: &Env) -> i128 {
    let token = get_token(e);
    let me = e.current_contract_address();
    let mut total = TokenClient::new(e, &token).balance(&me);
    for s in get_strategies(e).iter() {
        total += StrategyClient::new(e, &s).balance();
    }
    total
}

/// Registered strategy addresses, in the order `add_strategy` inserted them (the same order
/// `ensure_idle` drains them on redeem).
pub fn strategies(e: &Env) -> Vec<Address> {
    get_strategies(e)
}

/// Admin-only. Appends `strategy` to the registry; rejects a 5th entry and rejects
/// re-registering an address already present (a duplicate entry would make `total_assets`
/// sum that strategy's `balance()` twice, inflating `price_per_share`).
pub fn add_strategy(e: &Env, strategy: Address) -> Result<(), VaultError> {
    require_admin(e);
    let mut list = get_strategies(e);
    if list.first_index_of(&strategy).is_some() {
        return Err(VaultError::StrategyAlreadyRegistered);
    }
    if list.len() >= MAX_STRATEGIES {
        return Err(VaultError::TooManyStrategies);
    }
    list.push_back(strategy);
    set_strategies(e, &list);
    extend_instance(e);
    Ok(())
}

/// Admin-only. Removes `strategy` from the registry — only once its `balance()` is fully
/// drained to 0, so a removal can never strand assets outside `total_assets`' view.
pub fn remove_strategy(e: &Env, strategy: Address) -> Result<(), VaultError> {
    require_admin(e);
    let mut list = get_strategies(e);
    let idx = list
        .first_index_of(&strategy)
        .ok_or(VaultError::StrategyNotFound)?;
    if StrategyClient::new(e, &strategy).balance() != 0 {
        return Err(VaultError::StrategyNotEmpty);
    }
    list.remove(idx);
    set_strategies(e, &list);
    extend_instance(e);
    Ok(())
}

/// Admin-only. Sets the address permitted to call `compound`/`rebalance` (Task 8/9).
pub fn set_keeper_addr(e: &Env, keeper: Address) {
    require_admin(e);
    set_keeper(e, &keeper);
    extend_instance(e);
}

/// The address currently permitted to call `compound`/`rebalance` (Task 8/9). Panics if
/// `set_keeper` has never been called.
pub fn keeper(e: &Env) -> Address {
    get_keeper(e)
}

/// Admin-only. Sets the rebalance cooldown (seconds) and per-move cap (bps of
/// `total_assets`), both enforced starting Task 9.
pub fn set_limits(e: &Env, cooldown_s: u64, max_move_bps: u32) {
    require_admin(e);
    set_cooldown_s(e, cooldown_s);
    set_max_move_bps(e, max_move_bps);
    extend_instance(e);
}

/// Exchange rate: assets per share scaled by `PPS_SCALE` (7dp). An empty vault prices a
/// share at exactly 1.0 so the first deposit mints shares 1:1 with assets.
pub fn price_per_share(e: &Env) -> i128 {
    let supply = Base::total_supply(e);
    if supply == 0 {
        PPS_SCALE
    } else {
        total_assets(e) * PPS_SCALE / supply
    }
}

/// deposit(from, amount) -> shares minted at the current exchange rate. Pinned by 1a:
/// fn-symbol `deposit`, amount = args[1]. Pulls the asset via `transfer_from` (vault =
/// spender) so an agent `from` authorizes only the `deposit@vault` context. Assets park
/// idle in the vault (no pool/strategy call until Task 7). Pause-gated.
#[when_not_paused]
pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    from.require_auth();

    let supply = Base::total_supply(e);
    // Capture assets BEFORE pulling `amount` in — the share ratio prices against the
    // pre-deposit total.
    let assets_before = total_assets(e);

    let token = get_token(e);
    let me = e.current_contract_address();
    TokenClient::new(e, &token).transfer_from(&me, &from, &me, &amount);

    let shares = if supply == 0 {
        if amount < MIN_FIRST_DEPOSIT {
            return Err(VaultError::FirstDepositTooSmall);
        }
        // Inflation-attack guard: carve DEAD_SHARES out of the first deposit and mint them
        // to the vault itself where they stay locked forever.
        Base::mint(e, &me, DEAD_SHARES);
        amount - DEAD_SHARES
    } else {
        amount.checked_mul(supply).ok_or(VaultError::MathOverflow)? / assets_before
    };
    if shares <= 0 {
        return Err(VaultError::InvalidAmount);
    }

    Base::mint(e, &from, shares);
    extend_instance(e);
    Deposit {
        holder: from,
        amount,
        shares,
    }
    .publish(e);
    Ok(shares)
}

/// redeem(from, shares) -> assets paid at the current exchange rate. Not pause-gated
/// (holders can always exit). Pro-rata: assets = shares * total_assets / total_supply.
pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, VaultError> {
    if shares <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    if Base::balance(e, &from) < shares {
        return Err(VaultError::InsufficientShares);
    }

    let assets = shares
        .checked_mul(total_assets(e))
        .ok_or(VaultError::MathOverflow)?
        / Base::total_supply(e);
    // Strategies can lose value (a bad-debt / socialized-loss strategy prices below par),
    // pushing price_per_share under 1.0 — guard against burning shares for a 0 payout.
    if assets <= 0 {
        return Err(VaultError::InvalidAmount);
    }

    // `Base::burn` enforces `from.require_auth()` itself — do NOT auth `from` again above, or
    // the same address is authorized twice in one tree → Error(Auth, ExistingValue).
    Base::burn(e, &from, shares);
    ensure_idle(e, assets)?;

    let token = get_token(e);
    let me = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&me, &from, &assets);

    extend_instance(e);
    Redeem {
        holder: from,
        shares,
        assets,
    }
    .publish(e);
    Ok(assets)
}

/// Ensure the vault holds at least `needed` idle assets to cover a redeem payout, draining
/// registered strategies in order (only as much as each shortfall requires) until it does.
/// A strategy's `balance()` can overstate what it can actually return (a broken/insolvent
/// strategy) — if idle still falls short after draining every strategy, error out rather
/// than under-pay silently.
fn ensure_idle(e: &Env, needed: i128) -> Result<(), VaultError> {
    let token = get_token(e);
    let me = e.current_contract_address();
    let tk = TokenClient::new(e, &token);
    for s in get_strategies(e).iter() {
        if tk.balance(&me) >= needed {
            break;
        }
        let shortfall = needed - tk.balance(&me);
        StrategyClient::new(e, &s).withdraw(&shortfall);
    }
    if tk.balance(&me) < needed {
        return Err(VaultError::InsufficientLiquidity);
    }
    Ok(())
}

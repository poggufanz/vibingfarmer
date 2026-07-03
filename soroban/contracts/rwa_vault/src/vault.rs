use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, BytesN, Env, Vec};
use stellar_access::access_control;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{
    extend_instance, get_compound_cooldown_s, get_cooldown_s, get_keeper, get_last_compound,
    get_last_rebalance, get_max_move_bps, get_strategies, get_token, set_compound_cooldown_s,
    set_cooldown_s, set_keeper, set_last_compound, set_last_rebalance, set_max_move_bps,
    set_strategies,
};
use crate::strategy_client::StrategyClient;
use crate::types::{Compound, Deposit, Rebalance, Redeem, VaultError};

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
/// `set_keeper` has never been called — `compound`'s own `require_keeper` gate is the
/// non-panicking existence check used on the hot path.
pub fn keeper(e: &Env) -> Address {
    get_keeper(e).unwrap()
}

/// Keeper-only gate for `compound`/`rebalance` (Task 8/9). Returns `NotKeeper` cleanly
/// (never panics) when no keeper has ever been set. Otherwise requires the STORED keeper
/// address's own authorization — `require_auth` is invoked on the exact address read from
/// storage, so only that address's signature can satisfy it; there is no separate "caller"
/// parameter to compare against.
fn require_keeper(e: &Env) -> Result<(), VaultError> {
    let keeper = get_keeper(e).ok_or(VaultError::NotKeeper)?;
    keeper.require_auth();
    Ok(())
}

/// Admin-only. Sets the rebalance cooldown (seconds) and per-move cap (bps of
/// `total_assets`), both enforced starting Task 9.
pub fn set_limits(e: &Env, cooldown_s: u64, max_move_bps: u32) {
    require_admin(e);
    set_cooldown_s(e, cooldown_s);
    set_max_move_bps(e, max_move_bps);
    extend_instance(e);
}

/// Admin-only. Sets the min seconds between `compound` calls (Task R1), enforced by
/// `compound` below. A separate fn rather than an added parameter on `set_limits` — that
/// signature is already called by the deploy script and by existing tests, so changing its
/// arity would break both. Setting `0` disables the gate outright: `now < last + 0` can never
/// hold once `last` is in the past (and `now` only ever moves forward).
pub fn set_compound_cooldown(e: &Env, cooldown_s: u64) {
    require_admin(e);
    set_compound_cooldown_s(e, cooldown_s);
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
        // A total strategy loss can leave `total_assets() == 0` while `total_supply() > 0`
        // (DEAD_SHARES are never burned) — guard the division below the same way `redeem`
        // already guards its own division, so a subsequent deposit errors cleanly instead of
        // an i128 divide-by-zero trap permanently bricking deposits.
        if assets_before <= 0 {
            return Err(VaultError::InvalidAmount);
        }
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
///
/// Uses `try_withdraw` (not a hard call) so a single BRICKED strategy (one whose `withdraw`
/// reverts — e.g. its underlying pool is frozen) can never take down the whole redeem: its
/// failure is caught and the loop moves on to the next registered strategy. The terminal
/// idle-shortfall check below still catches a redeem that genuinely can't be covered even
/// after skipping every unreachable strategy, returning a clean `InsufficientLiquidity`
/// instead of propagating the bricked strategy's revert.
fn ensure_idle(e: &Env, needed: i128) -> Result<(), VaultError> {
    let token = get_token(e);
    let me = e.current_contract_address();
    let tk = TokenClient::new(e, &token);
    for s in get_strategies(e).iter() {
        if tk.balance(&me) >= needed {
            break;
        }
        let shortfall = needed - tk.balance(&me);
        if StrategyClient::new(e, &s).try_withdraw(&shortfall).is_err() {
            continue;
        }
    }
    if tk.balance(&me) < needed {
        return Err(VaultError::InsufficientLiquidity);
    }
    Ok(())
}

/// Keeper-only, cooldown-gated (Task R1 — `CompoundCooldownS`, default
/// `DEFAULT_COMPOUND_COOLDOWN_S` when never set; see `storage::get_compound_cooldown_s`).
/// Harvests every registered strategy's realized gain into vault idle, then sweeps ALL idle
/// (pre-existing user deposits + this call's harvested gains) back into strategies pro-rata
/// by PRE-harvest balances. `total_assets` grows by `total_gain` while `total_supply` is
/// unchanged, so `price_per_share` rises — this is how yield reaches every shareholder
/// without a separate claim step. Called by the off-chain keeper every ~15 min.
///
/// Both the harvest loop and the idle sweep below use `try_`-prefixed strategy calls
/// (Task R1), the same fault-isolation strategy `ensure_idle` already applies to `withdraw`:
/// a single BRICKED strategy (harvest or deposit reverting) must never block every OTHER
/// strategy's gain or the rest of the sweep — see each loop's own comment for exactly how it
/// degrades on failure.
pub fn compound(e: &Env, min_outs: Vec<i128>) -> Result<i128, VaultError> {
    require_keeper(e)?;
    let now = e.ledger().timestamp();
    // `None` means "never compounded" — deliberately NOT seeded like `LastRebalance` (whose
    // sentinel-0 seeding happens once, in the constructor, which never re-runs on a wasm
    // upgrade). Falling back to "gate passes" on `None` means an already-deployed vault's
    // very first post-upgrade compound is never wrongly blocked by an absent timestamp.
    if let Some(last) = get_last_compound(e) {
        if now < last + get_compound_cooldown_s(e) {
            return Err(VaultError::CooldownActive);
        }
    }
    let strategies = get_strategies(e);
    if min_outs.len() != strategies.len() {
        return Err(VaultError::InvalidAmount);
    }
    let mut total_gain = 0i128;
    // Captured BEFORE harvesting — the sweep below must split idle by what each strategy
    // held going in, not by post-harvest balances (harvest doesn't change `balance()`,
    // but capturing first keeps the pro-rata split unambiguous either way). Built via a
    // loop rather than `.collect()` — `soroban_sdk::Vec` has no `FromIterator` impl (it
    // needs an `Env` to allocate, unlike `std::vec::Vec`).
    let mut balances: Vec<i128> = Vec::new(e);
    for s in strategies.iter() {
        balances.push_back(StrategyClient::new(e, &s).balance());
    }
    // Uses `try_harvest` (not a hard call) — a single BRICKED strategy (one whose `harvest`
    // reverts) must never stop every OTHER strategy's realized gain from reaching
    // shareholders. On ANY error (either Result layer — a trap/revert, or a value that fails
    // to decode) that strategy simply contributes 0 gain this round and the loop moves on;
    // the keeper retries it on the next compound.
    for (i, s) in strategies.iter().enumerate() {
        let min_out = min_outs.get(i as u32).unwrap();
        if let Ok(Ok(gain)) = StrategyClient::new(e, &s).try_harvest(&min_out) {
            total_gain += gain;
        }
    }

    // Sweep idle into strategies pro-rata by pre-harvest balances (all zero → strategies[0]
    // takes everything — there's no ratio to split by yet).
    let token = get_token(e);
    let me = e.current_contract_address();
    let idle = TokenClient::new(e, &token).balance(&me);
    if idle > 0 && !strategies.is_empty() {
        let total_bal: i128 = balances.iter().sum();
        let exp = e.ledger().sequence() + 100;
        if total_bal == 0 {
            let s0 = strategies.get(0).unwrap();
            TokenClient::new(e, &token).approve(&me, &s0, &idle, &exp);
            // `try_deposit`: a BRICKED strategies[0] just leaves `idle` parked in the vault
            // instead of reverting the whole compound — the next call retries the sweep.
            let _ = StrategyClient::new(e, &s0).try_deposit(&idle);
        } else {
            // LAST strategy gets the remainder rather than its own `idle * bal / total`
            // share, so integer-division dust is swept in rather than left idle.
            let mut left = idle;
            for (i, s) in strategies.iter().enumerate() {
                let cut = if i as u32 == strategies.len() - 1 {
                    left
                } else {
                    idle * balances.get(i as u32).unwrap() / total_bal
                };
                if cut > 0 {
                    TokenClient::new(e, &token).approve(&me, &s, &cut, &exp);
                    // `try_deposit`: only subtract `cut` from `left` on success — a failed
                    // deposit (bricked strategy) leaves that slice idle instead of the vault
                    // losing track of it. If the LAST strategy is the one that fails, `left`
                    // (the remainder it would have absorbed) simply stays idle too — the
                    // dust-sweep invariant degrades to "leave it idle," never to a lost cut.
                    if StrategyClient::new(e, &s).try_deposit(&cut).is_ok() {
                        left -= cut;
                    }
                }
            }
        }
    }

    let pps = price_per_share(e);
    Compound {
        total_gain,
        price_per_share: pps,
    }
    .publish(e);
    set_last_compound(e, now);
    extend_instance(e);
    Ok(total_gain)
}

/// Keeper-only. Moves `amount` out of registered strategy `from` and into `to` — where `to`
/// is either another registered strategy, or this vault's own address as a de-risk-to-idle
/// pseudo-target (Task 1's spike proved a second on-chain Blend pool isn't viable on
/// testnet, so the live demo rebalances between strategy #1 and idle rather than between two
/// strategies). When `to` is the vault itself, the approve+deposit leg is skipped — `from`'s
/// `withdraw` already transferred the funds to the vault, which IS idle.
///
/// Gated by a cooldown (`cooldown_s` seconds since `last_rebalance`) and a per-move cap
/// (`max_move_bps` of `from`'s CURRENT balance, re-read fresh every call so the cap always
/// reflects the strategy's live size rather than a stale snapshot).
pub fn rebalance(e: &Env, from: Address, to: Address, amount: i128) -> Result<(), VaultError> {
    require_keeper(e)?;
    let strategies = get_strategies(e);
    let me = e.current_contract_address();
    if !strategies.contains(&from) || (!strategies.contains(&to) && to != me) {
        return Err(VaultError::StrategyNotFound);
    }
    let now = e.ledger().timestamp();
    if now < get_last_rebalance(e) + get_cooldown_s(e) {
        return Err(VaultError::CooldownActive);
    }
    let from_bal = StrategyClient::new(e, &from).balance();
    if amount <= 0 || amount > from_bal * i128::from(get_max_move_bps(e)) / 10_000 {
        return Err(VaultError::MoveTooLarge);
    }
    let got = StrategyClient::new(e, &from).withdraw(&amount);
    // `got` can legitimately be 0 (strategy had nothing recoverable despite its book
    // balance); the real strategy's `deposit` rejects non-positive amounts, so a zero
    // move must skip the deposit leg instead of trapping the whole rebalance.
    if to != me && got > 0 {
        let token = get_token(e);
        let exp = e.ledger().sequence() + 100;
        TokenClient::new(e, &token).approve(&me, &to, &got, &exp);
        StrategyClient::new(e, &to).deposit(&got);
    }
    set_last_rebalance(e, now);
    Rebalance {
        from,
        to,
        amount: got,
    }
    .publish(e);
    extend_instance(e);
    Ok(())
}

/// Admin-only escape hatch. NOT pause-gated — this is exactly the tool an admin needs when a
/// strategy is misbehaving badly enough to pause the vault. Drains `strategy` fully back to
/// vault idle via `withdraw(i128::MAX)`, the same MAX-drain convention `ensure_idle` and
/// `harvest` already rely on to mean "everything the strategy actually holds." Uses
/// `try_withdraw` (best-effort) rather than a hard call — draining a HEALTHY strategy still
/// works exactly as before, but calling this on an already-bricked strategy (whose `withdraw`
/// reverts) simply no-ops instead of reverting the admin's call.
pub fn emergency_withdraw(e: &Env, strategy: Address) {
    require_admin(e);
    let _ = StrategyClient::new(e, &strategy).try_withdraw(&i128::MAX);
    extend_instance(e);
}

/// Admin-only. Swaps the contract's wasm to `new_wasm_hash` — the upgrade escape hatch.
/// Only the auth gate is unit-tested here; a real wasm swap needs a second uploaded wasm and
/// is covered by the live testnet smoke instead (Task 16).
pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
    require_admin(e);
    e.deployer().update_current_contract_wasm(new_wasm_hash);
}

use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, BytesN, Env, Vec};
use stellar_access::access_control;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{
    extend_instance, get_compound_cooldown_s, get_cooldown_s, get_derisked, get_keeper,
    get_last_compound, get_last_rebalance, get_mandate_authority, get_mandate_expiry,
    get_max_move_bps, get_pending_upgrade, get_strategies, get_token, remove_pending_upgrade,
    set_compound_cooldown_s, set_cooldown_s, set_derisked, set_keeper, set_last_compound,
    set_last_rebalance, set_mandate_expiry, set_max_move_bps, set_pending_upgrade, set_strategies,
};
use crate::strategy_client::StrategyClient;
use crate::types::{
    Compound, Deposit, LifeboatEngaged, LifeboatResumed, LifeboatState, MandateSet,
    PendingUpgrade, Rebalance, Redeem, StrategyQuarantined, UpgradeExecuted, UpgradeScheduled,
    VaultError,
};

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
        // Untrusted report: a negative balance must not shrink NAV (clamp to 0), and an
        // inflated one must not trap the sum (saturate — downstream share math then fails
        // closed with clean InvalidAmount/MathOverflow errors instead of an i128 trap).
        let b = StrategyClient::new(e, &s).balance().max(0);
        total = total.saturating_add(b);
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
    // A SUCCESSFUL zero-balance read is required — a trapping/misdecoding balance()
    // fails removal cleanly (use `quarantine_strategy` for a bricked strategy).
    if !matches!(
        StrategyClient::new(e, &strategy).try_balance(),
        Ok(Ok(0))
    ) {
        return Err(VaultError::StrategyNotEmpty);
    }
    list.remove(idx);
    set_strategies(e, &list);
    extend_instance(e);
    Ok(())
}

/// Admin-only incident hatch. Removes `strategy` from the registry WITHOUT ever calling it —
/// the tool for a strategy whose `balance()`/`withdraw` traps and would otherwise brick every
/// NAV read (deposit, redeem, price_per_share). `acknowledged_loss` is the admin-acknowledged
/// NAV write-off, must be nonnegative, and is emitted for incident accounting. User exits stay
/// functional immediately after.
pub fn quarantine_strategy(
    e: &Env,
    strategy: Address,
    acknowledged_loss: i128,
) -> Result<(), VaultError> {
    require_admin(e);
    if acknowledged_loss < 0 {
        return Err(VaultError::InvalidParam);
    }
    let mut list = get_strategies(e);
    let idx = list
        .first_index_of(&strategy)
        .ok_or(VaultError::StrategyNotFound)?;
    list.remove(idx);
    set_strategies(e, &list);
    StrategyQuarantined {
        strategy,
        acknowledged_loss,
    }
    .publish(e);
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
pub fn set_limits(e: &Env, cooldown_s: u64, max_move_bps: u32) -> Result<(), VaultError> {
    require_admin(e);
    if max_move_bps > 10_000 {
        return Err(VaultError::InvalidParam);
    }
    set_cooldown_s(e, cooldown_s);
    set_max_move_bps(e, max_move_bps);
    extend_instance(e);
    Ok(())
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
        // `total_assets` saturates a hostile/inflated strategy report to i128::MAX; a raw
        // `* PPS_SCALE` would then trap under overflow-checks, and since `compound` reads
        // this for its event, a single lying strategy would panic every compound (defeating
        // its per-strategy fault isolation) and brick this view. Saturate instead — a view
        // must never trap; deposit/redeem stay fail-closed via their own checked_mul.
        total_assets(e).saturating_mul(PPS_SCALE) / supply
    }
}

/// The currently scheduled upgrade, if any — lets the radar/UI surface a pending bytecode
/// swap and its eta so holders can redeem out before it executes.
pub fn pending_upgrade(e: &Env) -> Option<PendingUpgrade> {
    get_pending_upgrade(e)
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
    if get_derisked(e) {
        return Err(VaultError::LifeboatEngaged);
    }
    require_keeper(e)?;
    let now = e.ledger().timestamp();
    // `None` means "never compounded" — deliberately NOT seeded like `LastRebalance` (whose
    // sentinel-0 seeding happens once, in the constructor, which never re-runs on a wasm
    // upgrade). Falling back to "gate passes" on `None` means an already-deployed vault's
    // very first post-upgrade compound is never wrongly blocked by an absent timestamp.
    if let Some(last) = get_last_compound(e) {
        // Overflowing gate timestamp = "never passes" (fail closed), not a trap.
        match last.checked_add(get_compound_cooldown_s(e)) {
            Some(gate) if now >= gate => {}
            _ => return Err(VaultError::CooldownActive),
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
            // Untrusted report: ignore negative "gains"; saturate the (event-only) sum.
            if gain > 0 {
                total_gain = total_gain.saturating_add(gain);
            }
        }
    }

    // Sweep idle into strategies pro-rata by pre-harvest balances (all zero → strategies[0]
    // takes everything — there's no ratio to split by yet). Slices are PRECOMPUTED from the
    // intended split: a slice whose deposit fails (trap, wrong-type return, dishonest pull)
    // simply stays idle — it is never rolled into another strategy's cut, and success is
    // judged by observed token movement, never the strategy's return value.
    let token = get_token(e);
    let me = e.current_contract_address();
    let tk = TokenClient::new(e, &token);
    let idle = tk.balance(&me);
    if idle > 0 && !strategies.is_empty() {
        let mut total_bal = 0i128;
        for b in balances.iter() {
            total_bal = total_bal.saturating_add(b.max(0));
        }
        let n = strategies.len();
        let mut cuts: Vec<i128> = Vec::new(e);
        if total_bal == 0 {
            for i in 0..n {
                cuts.push_back(if i == 0 { idle } else { 0 });
            }
        } else {
            // LAST slice takes the remainder so integer-division dust is swept in.
            let mut assigned = 0i128;
            for (i, b) in balances.iter().enumerate() {
                let cut = if i as u32 == n - 1 {
                    idle - assigned
                } else {
                    idle.checked_mul(b.max(0))
                        .ok_or(VaultError::MathOverflow)?
                        / total_bal
                };
                assigned += cut;
                cuts.push_back(cut);
            }
        }
        let exp = e.ledger().sequence() + 100;
        for (i, s) in strategies.iter().enumerate() {
            let cut = cuts.get(i as u32).unwrap();
            if cut <= 0 {
                continue;
            }
            tk.approve(&me, &s, &cut, &exp);
            let _ = StrategyClient::new(e, &s).try_deposit(&cut);
            // Clear the transient allowance after EVERY attempt — a failed, dishonest,
            // or partial pull must never leave a standing allowance behind.
            tk.approve(&me, &s, &0, &exp);
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
    if get_derisked(e) {
        return Err(VaultError::LifeboatEngaged);
    }
    require_keeper(e)?;
    let strategies = get_strategies(e);
    let me = e.current_contract_address();
    if !strategies.contains(&from) || (!strategies.contains(&to) && to != me) {
        return Err(VaultError::StrategyNotFound);
    }
    let now = e.ledger().timestamp();
    // Overflowing gate timestamp = "never passes" (fail closed), not a trap.
    match get_last_rebalance(e).checked_add(get_cooldown_s(e)) {
        Some(gate) if now >= gate => {}
        _ => return Err(VaultError::CooldownActive),
    }
    let from_bal = StrategyClient::new(e, &from).balance();
    let cap = from_bal
        .max(0)
        .checked_mul(i128::from(get_max_move_bps(e)))
        .ok_or(VaultError::MoveTooLarge)?
        / 10_000;
    if amount <= 0 || amount > cap {
        return Err(VaultError::MoveTooLarge);
    }
    let token = get_token(e);
    let tk = TokenClient::new(e, &token);
    let before = tk.balance(&me);
    let got = StrategyClient::new(e, &from).withdraw(&amount);
    // Observed truth: the vault must have RECEIVED delta ∈ [0, amount]; the strategy's
    // reported value is only a consistency check — disagreement fails closed. `delta`
    // can legitimately be 0 (nothing recoverable despite the book balance); a zero move
    // skips the deposit leg instead of trapping the whole rebalance.
    let delta = tk.balance(&me) - before;
    if delta < 0 || delta > amount || got != delta {
        return Err(VaultError::StrategyMisbehaved);
    }
    if to != me && delta > 0 {
        let exp = e.ledger().sequence() + 100;
        tk.approve(&me, &to, &delta, &exp);
        StrategyClient::new(e, &to).deposit(&delta);
        // Deposit is a hard call (registered strategy), but never leave a standing
        // allowance behind a dishonest partial pull.
        tk.approve(&me, &to, &0, &exp);
    }
    set_last_rebalance(e, now);
    Rebalance {
        from,
        to,
        amount: delta,
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

/// Minimum delay between announcing an upgrade and executing it. Compile-time constant, never
/// a setter: a settable delay is a bypass (set 0, then upgrade). Changing it is itself a
/// timelocked upgrade. 3 days — see design §3c.
pub(crate) const TIMELOCK_DELAY_S: u64 = 259_200;

/// Admin-only. Announces an upgrade to `new_wasm_hash`, to become executable after
/// `TIMELOCK_DELAY_S`. Overwriting an existing schedule resets the full delay. Emits
/// `UpgradeScheduled` so holders can redeem out before `execute_upgrade`.
pub fn schedule_upgrade(e: &Env, new_wasm_hash: BytesN<32>) -> Result<(), VaultError> {
    require_admin(e);
    let eta = e
        .ledger()
        .timestamp()
        .checked_add(TIMELOCK_DELAY_S)
        .ok_or(VaultError::MathOverflow)?;
    set_pending_upgrade(e, &PendingUpgrade { wasm_hash: new_wasm_hash.clone(), eta });
    UpgradeScheduled { wasm_hash: new_wasm_hash, eta }.publish(e);
    extend_instance(e);
    Ok(())
}

/// Admin-only. Executes a previously scheduled upgrade once its timelock has elapsed.
pub fn execute_upgrade(e: &Env) -> Result<(), VaultError> {
    require_admin(e);
    let p = get_pending_upgrade(e).ok_or(VaultError::NoPendingUpgrade)?;
    if e.ledger().timestamp() < p.eta {
        return Err(VaultError::TimelockNotElapsed);
    }
    // Clear BEFORE the swap: on success pending is gone (no re-fire); if the swap traps
    // (unknown/never-uploaded hash) the whole tx reverts, so pending survives — atomic either way.
    remove_pending_upgrade(e);
    // NOTE: update_current_contract_wasm does NOT re-run __constructor and preserves all
    // instance storage. A future wasm that changes an existing #[contracttype]'s shape traps
    // on first read of the old value and needs a migrate() + schema_version bump (spec §3d).
    // This change adds only append-only keys, so no migration is required.
    e.deployer().update_current_contract_wasm(p.wasm_hash.clone());
    UpgradeExecuted { wasm_hash: p.wasm_hash }.publish(e);
    Ok(())
}

/// Admin-only. Sets the address allowed to grant/renew the lifeboat mandate. Exists so the
/// demo user's wallet signs grants in-app while the vault admin (vf-deployer) stays CLI-only.
pub fn set_mandate_authority(e: &Env, authority: Address) {
    require_admin(e);
    crate::storage::set_mandate_authority(e, &authority);
    extend_instance(e);
}

/// Authority-signed. Grants/renews the time-boxed mandate; a past expiry is an immediate
/// disarm (user revoke). Fail-closed: without a live mandate the keeper cannot act.
pub fn set_mandate(e: &Env, expiry: u64) -> Result<(), VaultError> {
    let authority = get_mandate_authority(e).ok_or(VaultError::AuthorityNotSet)?;
    authority.require_auth();
    set_mandate_expiry(e, expiry);
    MandateSet { authority, expiry }.publish(e);
    extend_instance(e);
    Ok(())
}

pub fn lifeboat_state(e: &Env) -> LifeboatState {
    LifeboatState {
        derisked: get_derisked(e),
        mandate_expiry: get_mandate_expiry(e),
        authority: get_mandate_authority(e),
    }
}

fn require_mandate(e: &Env) -> Result<(), VaultError> {
    if e.ledger().timestamp() >= get_mandate_expiry(e) {
        return Err(VaultError::MandateExpired);
    }
    Ok(())
}

/// THE lifeboat. Keeper-called under a live user mandate. Drains every strategy best-effort
/// (`try_withdraw(i128::MAX)` — the same MAX-drain + best-effort convention as
/// `emergency_withdraw`: a bricked strategy no-ops instead of failing the rescue), engages the
/// Derisked flag (blocks compound/rebalance), and reports what moved. Idempotent: already-
/// derisked returns Ok(0) so a cross-ledger retry can never double-fire. Deliberately NOT bound
/// by the rebalance cooldown / max_move_bps — this is the emergency path those limits exist to
/// protect in normal operation.
pub fn emergency_derisk(e: &Env, reason_code: u32) -> Result<i128, VaultError> {
    require_keeper(e)?;
    if get_derisked(e) {
        return Ok(0);
    }
    require_mandate(e)?;
    // Engage the flag BEFORE any strategy interaction (defense in depth — rollback keeps
    // atomicity, but no callback may ever observe "rescuing yet not derisked").
    set_derisked(e, true);
    let tk = TokenClient::new(e, &get_token(e));
    let me = e.current_contract_address();
    let before = tk.balance(&me);
    for strategy in get_strategies(e).iter() {
        let _ = StrategyClient::new(e, &strategy).try_withdraw(&i128::MAX);
    }
    // Observed token delta — never the strategies' untrusted reports (whose sum a
    // hostile strategy could overflow to brick the rescue).
    let drained_total = (tk.balance(&me) - before).max(0);
    LifeboatEngaged {
        reason_code,
        drained_total,
    }
    .publish(e);
    extend_instance(e);
    Ok(drained_total)
}

/// Clears Derisked after all-clear. Mandate-gated like derisk: an expired mandate can never
/// force funds back into a risky pool — funds stay idle (safe posture) until re-granted.
/// Re-entry itself is the existing `compound()` sweeping idle; no new supply path.
pub fn resume(e: &Env) -> Result<(), VaultError> {
    require_keeper(e)?;
    if !get_derisked(e) {
        return Ok(());
    }
    require_mandate(e)?;
    set_derisked(e, false);
    let idle = TokenClient::new(e, &get_token(e)).balance(&e.current_contract_address());
    LifeboatResumed { idle }.publish(e);
    extend_instance(e);
    Ok(())
}

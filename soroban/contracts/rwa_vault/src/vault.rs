use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{extend_instance, get_token};
use crate::types::{Deposit, Redeem, VaultError};

/// Shares minted to the vault itself on the first deposit and locked forever. Guards against
/// the classic ERC-4626 inflation / first-depositor donation attack: an attacker can no
/// longer own 100% of a 1-share supply and round every later depositor's shares to zero.
const DEAD_SHARES: i128 = 1000;
/// Minimum first deposit (1 USDC at 7dp). Keeps DEAD_SHARES an immaterial slice and makes
/// the initial price-per-share meaningful.
const MIN_FIRST_DEPOSIT: i128 = 1_0000000;
/// Fixed-point scale for `price_per_share` (7dp): 1e7 == 1.0 asset per share.
pub const PPS_SCALE: i128 = 1_0000000;

/// Total assets backing every share. This task: idle USDC held by the vault only.
/// Task 7 sums the strategy-registry balances here once the router lands.
pub fn total_assets(e: &Env) -> i128 {
    let token = get_token(e);
    let me = e.current_contract_address();
    TokenClient::new(e, &token).balance(&me)
    // Task 7: + sum(StrategyClient::new(e, &s).balance()) over the strategy registry
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

/// Ensure the vault can cover a `assets` payout. This task deposits park idle, so the idle
/// balance always covers a pro-rata redemption. Task 7 replaces this with in-order draining
/// of the strategy registry back into idle before paying out.
fn ensure_idle(e: &Env, assets: i128) -> Result<(), VaultError> {
    let token = get_token(e);
    let me = e.current_contract_address();
    if TokenClient::new(e, &token).balance(&me) < assets {
        return Err(VaultError::InsufficientLiquidity);
    }
    Ok(())
}

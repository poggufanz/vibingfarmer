use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{extend_instance, get_token, get_total_principal, set_total_principal, SCALE};
use crate::types::{Deposit, Redeem, VaultError};

// Re-export of the dividend settle helpers (Task 3 fills the bodies).
use crate::vault::dividend::{settle, sync_debt};

pub mod dividend; // Task 3

/// deposit(from, amount) -> shares. Pinned by 1a: fn-symbol `deposit`, amount = args[1].
/// Stable NAV → shares == amount. Pulls mRWA via transfer_from (vault = spender) so an
/// agent `from` authorizes only the `deposit@vault` context (see plan auth-tree note).
#[when_not_paused]
pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    from.require_auth();

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer_from(&vault, &from, &vault, &amount);

    settle(e, &from); // bank any prior dividend at the old balance
    Base::mint(e, &from, amount); // shares == amount (1:1)
    set_total_principal(e, get_total_principal(e) + amount);
    sync_debt(e, &from); // reset reward debt to the new balance

    extend_instance(e);
    Deposit { holder: from, amount, shares: amount }.publish(e);
    Ok(amount)
}

/// redeem(from, shares) -> assets. Not pause-gated (holders can always exit).
/// Stable NAV → assets == shares. Pays principal via transfer from the vault's own
/// address (contract self-auth); `from` must be a verified mRWA holder to receive.
pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, VaultError> {
    if shares <= 0 {
        return Err(VaultError::InvalidAmount);
    }

    let bal = Base::balance(e, &from);
    if bal < shares {
        return Err(VaultError::InsufficientShares);
    }

    settle(e, &from);
    // `Base::burn` enforces `from.require_auth()` itself — do NOT call it again above, or the
    // same address is authorized twice in one tree → Error(Auth, ExistingValue).
    Base::burn(e, &from, shares);
    let assets = shares; // 1:1
    set_total_principal(e, get_total_principal(e) - assets);
    sync_debt(e, &from);

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&vault, &from, &assets);

    extend_instance(e);
    Redeem { holder: from, shares, assets }.publish(e);
    Ok(assets)
}

// SCALE is referenced by the dividend module; keep the import live.
const _: i128 = SCALE;

use soroban_sdk::token::TokenClient;
use soroban_sdk::{Address, Env};
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::Base;

use crate::storage::{extend_instance, get_token, get_total_principal, set_total_principal, SCALE};
use crate::storage::get_guardrail;
use crate::types::{Deposit, Redeem, VaultError};
use crate::guardrail_iface::GuardrailClient;

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

    // Compliance guardrail: enforce spend/exposure/%-alloc caps BEFORE any mint. The vault
    // is the invoker, so consume's `vault.require_auth()` is auto-satisfied — no `from`
    // context is added (1a-compatible auth tree). An over-cap deposit reverts here.
    let vault_self = e.current_contract_address();
    GuardrailClient::new(e, &get_guardrail(e)).consume(&from, &vault_self, &amount);

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

    // Decrement guardrail accounting on exit (no policy check). Vault is the invoker.
    let vault_self = e.current_contract_address();
    GuardrailClient::new(e, &get_guardrail(e)).release(&from, &vault_self, &shares);

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&vault, &from, &assets);

    extend_instance(e);
    Redeem { holder: from, shares, assets }.publish(e);
    Ok(assets)
}

use crate::storage::{get_acc, get_drip_epoch, set_acc, set_drip_epoch};
use crate::types::{Claim, Drip};
use stellar_access::access_control;

/// Admin-triggered mock yield source. Pulls `amount` mRWA from the admin treasury into
/// the vault and bumps the cumulative dividend index. Faithful equivalent: the issuer
/// minting daily dividend units (§6.1). Pause-gated.
#[when_not_paused]
pub fn drip(e: &Env, amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    // Admin lives in OZ access-control storage (see types.rs note). Its `require_auth`
    // gates the drip; the treasury `transfer(from = admin)` below auths admin again, but at
    // a distinct (cross-contract) tree node, so no ExistingValue conflict.
    let admin = access_control::get_admin(e).expect("admin not set");
    admin.require_auth();

    let supply = Base::total_supply(e);
    if supply <= 0 {
        return Err(VaultError::NoShares);
    }

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&admin, &vault, &amount); // treasury -> vault

    let add = amount.checked_mul(SCALE).ok_or(VaultError::MathOverflow)? / supply;
    let acc = get_acc(e).checked_add(add).ok_or(VaultError::MathOverflow)?;
    set_acc(e, acc);
    let epoch = get_drip_epoch(e) + 1;
    set_drip_epoch(e, epoch);

    extend_instance(e);
    Drip { epoch, amount, acc_div_per_share: acc, total_shares: supply }.publish(e);
    Ok(())
}

/// Permissionless claim that always pays the holder. Settles, zeroes Pending, transfers
/// the mRWA dividend out (holder must be a verified mRWA holder to receive). Not pause-gated.
pub fn claim(e: &Env, holder: Address) -> Result<i128, VaultError> {
    settle(e, &holder);
    let amount = crate::storage::get_pending(e, &holder);
    if amount <= 0 {
        return Err(VaultError::NothingToClaim);
    }
    crate::storage::set_pending(e, &holder, 0);

    let token = get_token(e);
    let vault = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&vault, &holder, &amount);

    extend_instance(e);
    Claim { holder, amount }.publish(e);
    Ok(amount)
}

pub fn claimable(e: &Env, holder: Address) -> i128 {
    dividend::claimable(e, &holder)
}

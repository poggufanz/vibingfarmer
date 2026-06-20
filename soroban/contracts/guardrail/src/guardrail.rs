use soroban_sdk::{Address, Env};
use registry::RegistryClient;

use crate::storage;
use crate::types::{GuardrailError, Policy};

/// Admin-set per-vault NAV knob (the de-peg lever, §2.1). Admin-auth, positive only.
pub fn set_nav(e: &Env, vault: Address, nav: i128) -> Result<(), GuardrailError> {
    storage::get_admin(e).require_auth();
    if nav <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }
    storage::set_nav(e, &vault, nav);
    storage::extend_instance(e);
    Ok(())
}

/// Owner sets each worker agent's Aladdin limits. Owner-auth + owner must equal the
/// agent's record owner in the registry.
pub fn set_policy(
    e: &Env,
    owner: Address,
    agent: Address,
    max_exposure: i128,
    max_pct_bps: u32,
) -> Result<(), GuardrailError> {
    owner.require_auth();
    if max_exposure <= 0 || max_pct_bps == 0 || max_pct_bps > 10_000 {
        return Err(GuardrailError::InvalidAmount);
    }
    let rec_owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
    if rec_owner != owner {
        return Err(GuardrailError::NotOwner);
    }
    storage::set_policy(e, &agent, &Policy { max_exposure, max_pct_bps });
    storage::extend_instance(e);
    Ok(())
}

/// Vault-only deposit gate. Enforces spend (per-agent) + exposure (per-owner,vault) +
/// %-allocation (per-owner, NAV-valued) caps; reverts out-of-policy; commits accounting.
pub fn consume(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
    vault.require_auth(); // invoker-auth: only the real vault, acting for itself
    if amount <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }

    // ---- registry scope (fail-closed: record_of panics on an unknown agent) ----
    let rec = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent);
    let owner = rec.owner;
    if rec.revoked {
        return Err(GuardrailError::Revoked);
    }
    let now = e.ledger().timestamp();
    if now >= rec.expiry {
        return Err(GuardrailError::Expired);
    }
    if rec.vault != vault {
        return Err(GuardrailError::WrongVault);
    }

    let policy = storage::get_policy(e, &agent).ok_or(GuardrailError::PolicyNotSet)?;

    // ---- (1) SPEND cap (per-agent, units) ----
    let mut spend = storage::get_spend(e, &agent);
    if now.saturating_sub(spend.period_start) >= rec.period_duration {
        spend.spent_in_period = 0;
        spend.period_start = now;
    }
    let new_spent = spend
        .spent_in_period
        .checked_add(amount)
        .ok_or(GuardrailError::MathOverflow)?;
    if new_spent > rec.cap_per_period {
        return Err(GuardrailError::SpendCapExceeded);
    }

    // ---- (2) EXPOSURE cap (per-owner x vault, units) ----
    let pos = storage::get_position(e, &owner, &vault);
    let new_pos = pos.checked_add(amount).ok_or(GuardrailError::MathOverflow)?;
    if new_pos > policy.max_exposure {
        return Err(GuardrailError::ExposureCapExceeded);
    }

    // ---- (3) %-ALLOCATION cap (per-owner, value-weighted) ----
    let nav = storage::get_nav(e, &vault);
    let amount_val = amount.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;
    let new_pos_val = new_pos.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;
    let total = storage::get_total_value(e, &owner);
    let new_total = total.checked_add(amount_val).ok_or(GuardrailError::MathOverflow)?;
    // ponytail: sole-asset exemption. A single-asset portfolio is trivially 100%, so the
    // %-cap can only bind once a 2nd vault holds value (new_total > new_pos_val). Without
    // this, any max_pct_bps < 10000 would revert the owner's very first deposit and the
    // portfolio could never bootstrap (orchestrator funds N vaults as N sequential txs).
    if new_pos_val != new_total {
        let lhs = new_pos_val.checked_mul(10_000).ok_or(GuardrailError::MathOverflow)?;
        let rhs = (policy.max_pct_bps as i128)
            .checked_mul(new_total)
            .ok_or(GuardrailError::MathOverflow)?;
        if lhs > rhs {
            return Err(GuardrailError::AllocCapExceeded);
        }
    }

    // ---- commit ----
    storage::set_position(e, &owner, &vault, new_pos);
    storage::set_total_value(e, &owner, new_total);
    spend.spent_in_period = new_spent;
    storage::set_spend(e, &agent, &spend);
    storage::extend_instance(e);
    Ok(())
}

/// Vault-only exit path. Decrements the owner's position + running total (saturating at 0).
/// No policy checks — redeems are always allowed.
pub fn release(e: &Env, agent: Address, vault: Address, amount: i128) -> Result<(), GuardrailError> {
    vault.require_auth();
    if amount <= 0 {
        return Err(GuardrailError::InvalidAmount);
    }
    let owner = RegistryClient::new(e, &storage::get_registry(e)).record_of(&agent).owner;
    let nav = storage::get_nav(e, &vault);
    let amount_val = amount.checked_mul(nav).ok_or(GuardrailError::MathOverflow)?;

    let new_pos = (storage::get_position(e, &owner, &vault) - amount).max(0);
    let new_total = (storage::get_total_value(e, &owner) - amount_val).max(0);
    storage::set_position(e, &owner, &vault, new_pos);
    storage::set_total_value(e, &owner, new_total);
    storage::extend_instance(e);
    Ok(())
}

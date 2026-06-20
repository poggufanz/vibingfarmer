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

//! RWA transfer-allow compliance module.
//!
//! A pluggable [`ComplianceModule`] (audited trait from `stellar_tokens`) that
//! gates `can_transfer` / `can_create` on a manager-maintained allowlist. It is
//! deliberately minimal: it demonstrates the modular-compliance seam is real and
//! testable. NOTE: this is T-REX *transfer compliance* (who may hold/transfer the
//! token), distinct from agent allocation/exposure caps (sub-project 1d).
//!
//! There is no OZ example for this module in `v0.7.2`; it is hand-written against
//! the audited `ComplianceModule` trait + `compliance::modules::storage` helpers.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;
use stellar_tokens::rwa::compliance::modules::{storage as module_storage, ComplianceModule};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contracttype]
#[derive(Clone)]
pub enum AllowKey {
    /// Allowlist flag for an account.
    Allowed(Address),
}

#[contract]
pub struct ComplianceAllowContract;

#[contractimpl]
impl ComplianceAllowContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address, compliance: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
        // One-time bind to the governing compliance contract.
        module_storage::set_compliance_address(e, &compliance);
    }

    /// Manager-gated: add an account to the transfer allowlist.
    #[only_role(operator, "manager")]
    pub fn allow_account(e: &Env, account: Address, operator: Address) {
        e.storage().persistent().set(&AllowKey::Allowed(account), &true);
    }

    /// Manager-gated: remove an account from the transfer allowlist.
    #[only_role(operator, "manager")]
    pub fn disallow_account(e: &Env, account: Address, operator: Address) {
        e.storage().persistent().set(&AllowKey::Allowed(account), &false);
    }

    pub fn is_allowed(e: &Env, account: Address) -> bool {
        e.storage().persistent().get(&AllowKey::Allowed(account)).unwrap_or(false)
    }
}

#[contractimpl(contracttrait)]
impl ComplianceModule for ComplianceAllowContract {
    // Notification hooks: read-only allowlist, nothing to record.
    fn on_transfer(_e: &Env, _from: Address, _to: Address, _amount: i128, _token: Address) {}
    fn on_created(_e: &Env, _to: Address, _amount: i128, _token: Address) {}
    fn on_destroyed(_e: &Env, _from: Address, _amount: i128, _token: Address) {}

    fn can_transfer(e: &Env, from: Address, to: Address, _amount: i128, _token: Address) -> bool {
        Self::is_allowed(e, from) && Self::is_allowed(e, to)
    }

    fn can_create(e: &Env, to: Address, _amount: i128, _token: Address) -> bool {
        Self::is_allowed(e, to)
    }

    fn name(e: &Env) -> String {
        module_storage::module_name(e, "transfer_allow")
    }

    fn get_compliance_address(e: &Env) -> Address {
        module_storage::get_compliance_address(e)
    }

    fn set_compliance_address(e: &Env, compliance: Address) {
        // One-time; bound in the constructor, so this is a no-op-after-init guard.
        module_storage::set_compliance_address(e, &compliance);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for ComplianceAllowContract {}

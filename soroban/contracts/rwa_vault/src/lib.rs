#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::only_admin;
use stellar_tokens::fungible::Base;

pub mod types;
pub mod storage;
mod vault;
mod test;

use storage::{
    extend_instance, get_acc, get_drip_epoch, get_token, get_total_principal,
    set_acc, set_drip_epoch, set_token, set_total_principal,
};

#[contract]
pub struct RwaVault;

#[contractimpl]
impl RwaVault {
    /// Deployed once. `token` = the yield-farming asset (SEP-41 token / SAC) this vault
    /// accepts for deposits and pays dividends in.
    pub fn __constructor(
        e: &Env,
        admin: Address,
        token: Address,
        name: String,
        symbol: String,
    ) {
        Base::set_metadata(e, 7, name, symbol); // 7 decimals (match the asset)
        set_token(e, &token);
        set_acc(e, 0);
        set_total_principal(e, 0);
        set_drip_epoch(e, 0);
        access_control::set_admin(e, &admin); // powers only_admin (pause/unpause)
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
    pub fn total_principal(e: &Env) -> i128 {
        get_total_principal(e)
    }
    pub fn acc_div_per_share(e: &Env) -> i128 {
        get_acc(e)
    }
    pub fn drip_epoch(e: &Env) -> u64 {
        get_drip_epoch(e)
    }

    // ----- deposit / redeem -----
    /// deposit(from, amount) -> shares minted. fn-symbol `deposit`, amount = args[1] (1a pin).
    pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, types::VaultError> {
        vault::deposit(e, from, amount)
    }

    /// redeem(from, shares) -> assets returned (1:1, stable NAV).
    pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, types::VaultError> {
        vault::redeem(e, from, shares)
    }

    // ----- FOBXX-faithful yield -----
    /// Admin-only mock yield source: fund + distribute a dividend pro-rata (FOBXX-faithful).
    pub fn drip(e: &Env, amount: i128) -> Result<(), types::VaultError> {
        vault::drip(e, amount)
    }

    /// Permissionless: pay `holder` their accrued asset dividend. Returns amount paid.
    pub fn claim(e: &Env, holder: Address) -> Result<i128, types::VaultError> {
        vault::claim(e, holder)
    }

    /// View: asset dividend currently claimable by `holder`.
    pub fn claimable(e: &Env, holder: Address) -> i128 {
        vault::claimable(e, holder)
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

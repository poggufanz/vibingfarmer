#![no_std]
mod blend;
mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env};

#[contract]
pub struct BlendStrategy;

#[contractimpl]
impl BlendStrategy {
    /// Deployed once per (vault, pool) pair. `blnd`/`router`/`reserve_token_id` are wired
    /// now but only consumed by `harvest` in Task 4/5.
    pub fn __constructor(
        e: Env,
        vault: Address,
        pool: Address,
        token: Address,
        blnd: Address,
        router: Address,
        reserve_token_id: u32,
    ) {
        storage::set_vault(&e, &vault);
        storage::set_pool(&e, &pool);
        storage::set_token(&e, &token);
        storage::set_blnd(&e, &blnd);
        storage::set_router(&e, &router);
        storage::set_reserve_token_id(&e, reserve_token_id);
        storage::set_principal(&e, 0);
        storage::extend_instance(&e);
    }

    /// Pulls `amount` of the strategy's token from the vault and supplies it to Blend.
    /// only-vault: the vault contract invoking us auths its own address (invoker auth).
    pub fn deposit(e: Env, amount: i128) {
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        TokenClient::new(&e, &token).transfer_from(&me, &vault, &me, &amount);

        blend::supply(&e, &storage::get_pool(&e), &token, amount);
        storage::set_principal(&e, storage::get_principal(&e) + amount);
        storage::extend_instance(&e);
    }

    /// Withdraws up to `amount` from Blend back to the vault. `i128::MAX` drains the full
    /// position. Returns the amount actually pulled (Blend caps at the live position).
    pub fn withdraw(e: Env, amount: i128) -> i128 {
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        let token_client = TokenClient::new(&e, &token);

        let before = token_client.balance(&me);
        blend::withdraw(&e, &storage::get_pool(&e), &token, amount);
        let got = token_client.balance(&me) - before;
        token_client.transfer(&me, &vault, &got);

        let principal = storage::get_principal(&e);
        storage::set_principal(&e, if got >= principal { 0 } else { principal - got });
        storage::extend_instance(&e);
        got
    }

    /// Book principal (not live bToken NAV) — interest realizes at harvest (Task 4/5).
    pub fn balance(e: Env) -> i128 {
        storage::get_principal(&e)
    }
}

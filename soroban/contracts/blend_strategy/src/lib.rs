#![no_std]
mod blend;
mod soroswap;
mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, token::TokenClient, vec, Address, Env};

#[contract]
pub struct BlendStrategy;

const SWAP_APPROVE_TTL: u32 = 100; // ledgers the router allowance stays live (consumed same tx)
const SWAP_DEADLINE_SECS: u64 = 300; // seconds until the swap quote expires

#[contractimpl]
impl BlendStrategy {
    /// Deployed once per (vault, pool) pair. `blnd`/`router`/`reserve_token_id` feed
    /// `harvest`'s BLND emissions claim + Soroswap swap.
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

    /// Withdraws the entire Blend position, claims any pending BLND emissions (best-effort —
    /// testnet pools may have emissions off), swaps the full BLND balance to the underlying
    /// token via Soroswap when `min_out > 0` (`0` = hold BLND on the strategy instead),
    /// re-supplies the book principal, and forwards whatever remains (Blend interest + swap
    /// proceeds) to the vault.
    pub fn harvest(e: Env, min_out: i128) -> i128 {
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        let principal = storage::get_principal(&e);
        if principal == 0 {
            return 0;
        }

        let tk = TokenClient::new(&e, &token);
        let before = tk.balance(&me);
        blend::withdraw(&e, &storage::get_pool(&e), &token, i128::MAX);
        let pulled = tk.balance(&me) - before;

        // Claim BLND emissions — best-effort. Testnet pools may have emissions disabled, in
        // which case the pool traps and `try_claim` swallows it so interest-only harvest
        // proceeds normally (see `harvest_survives_no_emissions`).
        let pool_client = blend::BlendPoolClient::new(&e, &storage::get_pool(&e));
        let ids = vec![&e, storage::get_reserve_token_id(&e)];
        let _ = pool_client.try_claim(&me, &ids, &me);
        let blnd = storage::get_blnd(&e);
        let blnd_client = TokenClient::new(&e, &blnd);
        let blnd_claimed = blnd_client.balance(&me);

        // Swap the full BLND balance to the underlying token when the caller opts in via
        // `min_out > 0` (`0` means hold BLND on the strategy instead). Unlike the claim, the
        // swap is NOT best-effort — a slippage revert must abort the whole harvest so a bad
        // swap can never land partially.
        let mut swapped = 0i128;
        if blnd_claimed > 0 && min_out > 0 {
            let router = storage::get_router(&e);
            let exp = e.ledger().sequence() + SWAP_APPROVE_TTL;
            blnd_client.approve(&me, &router, &blnd_claimed, &exp);
            let path = vec![&e, blnd.clone(), token.clone()];
            let deadline = e.ledger().timestamp() + SWAP_DEADLINE_SECS;
            let amounts = soroswap::SoroswapRouterClient::new(&e, &router)
                .swap_exact_tokens_for_tokens(&blnd_claimed, &min_out, &path, &me, &deadline);
            swapped = amounts.get(amounts.len() - 1).unwrap_or(0);
        }

        let resupply = principal.min(pulled);
        blend::supply(&e, &storage::get_pool(&e), &token, resupply);
        if pulled < principal {
            // Pool shortfall (socialized bad debt): Blend returned less than book principal.
            // Mark the book down to what was actually recovered and re-supplied so `balance()`
            // stops overstating the position — otherwise Task 6-8 share pricing would inflate
            // `price_per_share` off a phantom balance.
            storage::set_principal(&e, pulled);
        }

        let usdc_out = tk.balance(&me) - before; // Blend interest + swap proceeds combined
        let interest = usdc_out - swapped;
        if usdc_out > 0 {
            tk.transfer(&me, &vault, &usdc_out);
        }
        let blnd_held = blnd_client.balance(&me);

        types::StrategyHarvest {
            interest,
            blnd_claimed,
            blnd_swapped: swapped,
            usdc_out,
            blnd_held,
        }
        .publish(&e);
        storage::extend_instance(&e);
        usdc_out
    }
}

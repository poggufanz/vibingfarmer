#![no_std]
mod blend;
mod soroswap;
mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, token::TokenClient, vec, Address, Env};
use types::StrategyError;

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
    pub fn deposit(e: Env, amount: i128) -> Result<(), StrategyError> {
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        TokenClient::new(&e, &token).transfer_from(&me, &vault, &me, &amount);

        blend::supply(&e, &storage::get_pool(&e), &token, amount);
        storage::set_principal(&e, storage::get_principal(&e) + amount);
        storage::extend_instance(&e);
        Ok(())
    }

    /// Withdraws up to `amount` from Blend back to the vault. A caller `amount` of
    /// `i128::MAX` still means "drain everything" — but the request actually sent to Blend
    /// is always FINITE, capped at the live position value, because with `b_rate < 1e12`
    /// (socialized bad debt) the pool's to-bToken fixed-point math overflows on a MAX
    /// request. Returns the amount actually received (observed token delta).
    pub fn withdraw(e: Env, amount: i128) -> Result<i128, StrategyError> {
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let pool = storage::get_pool(&e);
        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        let token_client = TokenClient::new(&e, &token);

        // Live position from the pool's own books — nothing recoverable means a clean 0,
        // and the pool is never called (a zeroed b_rate must not trap the exit path).
        let (b_tokens, b_rate) = blend::live_position(&e, &pool, &token)?;
        let live = blend::to_underlying_floor(&e, b_tokens, b_rate)?;
        if live <= 0 {
            storage::extend_instance(&e);
            return Ok(0);
        }
        let request = amount.min(live);

        let before = token_client.balance(&me);
        blend::withdraw(&e, &pool, &token, request);
        let got = token_client.balance(&me) - before;
        if got < 0 {
            return Err(StrategyError::InvalidReserveData);
        }
        if got > 0 {
            token_client.transfer(&me, &vault, &got);
        }

        let principal = storage::get_principal(&e);
        storage::set_principal(&e, if got >= principal { 0 } else { principal - got });
        storage::extend_instance(&e);
        Ok(got)
    }

    /// LIVE underlying NAV from the pool's own books: floor(b_tokens * b_rate / 1e12).
    /// Yield raises it before any harvest; socialized bad debt lowers it. Fail-closed on
    /// malformed reserve data (negative values / fixed-point overflow).
    pub fn balance(e: Env) -> Result<i128, StrategyError> {
        let pool = storage::get_pool(&e);
        let token = storage::get_token(&e);
        let (b_tokens, b_rate) = blend::live_position(&e, &pool, &token)?;
        blend::to_underlying_floor(&e, b_tokens, b_rate)
    }

    /// Withdraws the entire Blend position, claims any pending BLND emissions (best-effort —
    /// testnet pools may have emissions off), swaps the full BLND balance to the underlying
    /// token via Soroswap when `min_out > 0` (`0` = hold BLND on the strategy instead),
    /// re-supplies the book principal, and forwards whatever remains (Blend interest + swap
    /// proceeds) to the vault. When `principal == 0` (rebalance-to-idle or emergency_withdraw
    /// drained the position), the withdraw-all and claim legs are skipped — but the swap+forward
    /// leg still runs if BLND was left on the strategy by an earlier `min_out == 0` harvest, so
    /// that held BLND doesn't get stranded forever.
    pub fn harvest(e: Env, min_out: i128) -> Result<i128, StrategyError> {
        let vault = storage::get_vault(&e);
        vault.require_auth();

        let pool = storage::get_pool(&e);
        let token = storage::get_token(&e);
        let me = e.current_contract_address();
        let principal = storage::get_principal(&e);

        let blnd = storage::get_blnd(&e);
        let blnd_client = TokenClient::new(&e, &blnd);
        // Position existence comes from the LIVE Blend position map, never book principal —
        // residual yield left after a principal-sized withdrawal must still be harvested.
        let (b_tokens, b_rate) = blend::live_position(&e, &pool, &token)?;
        let has_position = b_tokens > 0;
        if !has_position && blnd_client.balance(&me) == 0 {
            // Truly nothing to do: no live Blend position and no held BLND.
            return Ok(0);
        }

        let tk = TokenClient::new(&e, &token);
        let before = tk.balance(&me);

        let (pulled, blnd_claimed) = if has_position {
            // FINITE full drain: ceil of the live position value covers the whole position
            // (Blend caps at the position) — no i128::MAX sentinel ever reaches the pool.
            let drain = blend::to_underlying_ceil(&e, b_tokens, b_rate)?;
            if drain > 0 {
                blend::withdraw(&e, &pool, &token, drain);
            }
            let pulled = tk.balance(&me) - before;
            if pulled < 0 {
                return Err(StrategyError::InvalidReserveData);
            }

            // Claim BLND emissions — best-effort. Testnet pools may have emissions disabled, in
            // which case the pool traps and `try_claim` swallows it so interest-only harvest
            // proceeds normally (see `harvest_survives_no_emissions`). Snapshot the pre-claim
            // balance so the event can report THIS round's claim delta, not the full (possibly
            // carried-over from a prior `min_out == 0` harvest) balance.
            let blnd_before = blnd_client.balance(&me);
            let pool_client = blend::BlendPoolClient::new(&e, &pool);
            let ids = vec![&e, storage::get_reserve_token_id(&e)];
            let _ = pool_client.try_claim(&me, &ids, &me);
            let claimed = blnd_client.balance(&me) - blnd_before; // this round's claim delta

            (pulled, claimed)
        } else {
            // No live Blend position to drain or claim against — only the swap leg below
            // (against whatever BLND is already held) applies this round.
            (0, 0)
        };
        let blnd_bal = blnd_client.balance(&me);

        // Swap the full BLND balance (this round's claim plus any held-over balance from a
        // prior `min_out == 0` harvest) to the underlying token when the caller opts in via
        // `min_out > 0` (`0` means hold BLND on the strategy instead). Unlike the claim, the
        // swap is NOT best-effort — a slippage revert must abort the whole harvest so a bad
        // swap can never land partially.
        let mut swapped = 0i128;
        if blnd_bal > 0 && min_out > 0 {
            let router = storage::get_router(&e);
            let exp = e.ledger().sequence() + SWAP_APPROVE_TTL;
            blnd_client.approve(&me, &router, &blnd_bal, &exp);
            let path = vec![&e, blnd.clone(), token.clone()];
            let deadline = e.ledger().timestamp() + SWAP_DEADLINE_SECS;
            let amounts = soroswap::SoroswapRouterClient::new(&e, &router)
                .swap_exact_tokens_for_tokens(&blnd_bal, &min_out, &path, &me, &deadline);
            swapped = amounts.get(amounts.len().saturating_sub(1)).unwrap_or(0);
        }

        if has_position && pulled > 0 {
            // Re-supply only the intended BOOK amount — anything above it is realized
            // yield headed for the vault; anything below marks the book down.
            let resupply = principal.min(pulled);
            if resupply > 0 {
                blend::supply(&e, &pool, &token, resupply);
            }
            if pulled < principal {
                // Pool shortfall (socialized bad debt): Blend returned less than book principal.
                // Mark the book down to what was actually recovered and re-supplied so the
                // book never overstates the position.
                storage::set_principal(&e, pulled);
            }
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
        Ok(usdc_out)
    }
}

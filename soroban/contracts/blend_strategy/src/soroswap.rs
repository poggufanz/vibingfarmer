//! Local, version-independent view of the Soroswap router contract (same rationale as
//! `blend.rs`: a hand-written ABI/XDR-level client so we don't pin a Soroswap SDK crate that
//! may lag or lead our soroban-sdk version). Verified live at deploy time — the real router is
//! `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` (task-1 spike).
use soroban_sdk::{contractclient, Address, Env, Vec};

// The trait exists only to generate `SoroswapRouterClient`; the trait name itself is never
// referenced, so silence the dead-code lint on it.
#[allow(dead_code)]
#[contractclient(name = "SoroswapRouterClient")]
pub trait SoroswapRouter {
    /// Swaps the exact `amount_in` of `path[0]` for at least `amount_out_min` of `path[last]`,
    /// crediting `to`. Reverts (slippage) if the trade would pay out less than `amount_out_min`.
    /// Returns the per-hop amounts along `path`; the caller reads the last entry as the
    /// received output.
    fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}

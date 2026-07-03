use soroban_sdk::{contractevent, contracttype};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Vault,          // vault contract — the only authorized deposit/withdraw caller
    Pool,           // Blend v2 lending pool address
    Token,          // underlying asset this strategy holds (e.g. USDC / SAC)
    Blnd,           // BLND reward token — claimed and swapped by harvest
    Router,         // Soroswap router — swaps claimed BLND into the underlying token
    ReserveTokenId, // Blend reserve index for this asset (u32) — passed to claim
    Principal,      // book principal deposited into Blend (i128)
}

/// Emitted by `harvest`. `blnd_claimed`/`blnd_swapped`/`blnd_held` are 0 and
/// `interest == usdc_out` whenever the claim yields nothing (emissions off) or `min_out == 0`
/// (BLND held instead of swapped) — see `harvest_survives_no_emissions` and
/// `harvest_holds_blnd_when_min_out_zero`.
#[contractevent(topics = ["strategy_harvest"])]
pub struct StrategyHarvest {
    pub interest: i128, // realized Blend interest forwarded to the vault (excludes swap)
    pub blnd_claimed: i128, // BLND balance held after this harvest's claim
    pub blnd_swapped: i128, // underlying-token proceeds from swapping the claimed BLND
    pub usdc_out: i128, // total underlying token sent to the vault this harvest
    pub blnd_held: i128, // BLND left on the strategy after (claimed but not swapped)
}

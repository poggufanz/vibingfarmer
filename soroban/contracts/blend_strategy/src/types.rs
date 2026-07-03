use soroban_sdk::{contractevent, contracttype};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Vault,          // vault contract — the only authorized deposit/withdraw caller
    Pool,           // Blend v2 lending pool address
    Token,          // underlying asset this strategy holds (e.g. USDC / SAC)
    Blnd,           // BLND reward token — consumed by harvest (Task 4/5)
    Router,         // BLND -> Token swap router — consumed by harvest (Task 4/5)
    ReserveTokenId, // Blend reserve index for this asset (u32) — consumed by harvest (Task 4/5)
    Principal,      // book principal deposited into Blend (i128)
}

/// Emitted by `harvest`. Task 4 only realizes Blend interest — `blnd_claimed`/`blnd_swapped`/
/// `blnd_held` stay 0 and `interest == usdc_out` until Task 5 wires the BLND claim + swap.
#[contractevent(topics = ["strategy_harvest"])]
pub struct StrategyHarvest {
    pub interest: i128,     // realized Blend interest forwarded to the vault
    pub blnd_claimed: i128, // BLND emissions claimed this harvest (Task 5)
    pub blnd_swapped: i128, // BLND amount routed through the swap (Task 5)
    pub usdc_out: i128,     // total USDC sent to the vault this harvest
    pub blnd_held: i128,    // BLND left on the strategy when min_out == 0 (Task 5)
}

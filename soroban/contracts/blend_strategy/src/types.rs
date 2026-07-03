use soroban_sdk::contracttype;

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

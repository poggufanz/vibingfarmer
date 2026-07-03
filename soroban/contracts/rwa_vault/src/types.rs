use soroban_sdk::{contracterror, contractevent, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // NOTE: no `Admin` key here — the admin lives in OZ access-control storage
    // (`AccessControlStorageKey::Admin`). A `DataKey::Admin` unit variant would encode to
    // the identical `Vec[Symbol("Admin")]` storage key and collide (→ AdminAlreadySet).
    Token, // yield-farming asset token address (SEP-41 / SAC)
           // Task 7 adds the strategy registry keys (Strategies, Keeper, LastRebalance,
           // CooldownS, MaxMoveBps) here when the router lands — deferred to keep this
           // task's clippy gate clean (no never-constructed variants).
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInit = 1,
    InvalidAmount = 2,
    InsufficientShares = 4, // redeem more shares than held
    MathOverflow = 5,
    // Strategy-router errors (10-15) and the Compound/Rebalance events are added by
    // Tasks 7-9 as they are constructed — front-loading unused variants here would trip
    // the `-D warnings` clippy gate, so they are deferred to the tasks that use them.
    FirstDepositTooSmall = 16, // first deposit below MIN_FIRST_DEPOSIT (inflation guard)
    InsufficientLiquidity = 17, // redeem cannot be covered by idle assets (idle-only this task)
}

#[contractevent(topics = ["vault_deposit"])]
pub struct Deposit {
    pub holder: Address,
    pub amount: i128, // assets pulled in
    pub shares: i128, // shares minted at the current exchange rate
}

#[contractevent(topics = ["vault_redeem"])]
pub struct Redeem {
    pub holder: Address,
    pub shares: i128, // shares burned
    pub assets: i128, // assets paid out at the current exchange rate
}

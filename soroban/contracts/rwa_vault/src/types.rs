use soroban_sdk::{contracterror, contractevent, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // NOTE: no `Admin` key here — the admin lives in OZ access-control storage
    // (`AccessControlStorageKey::Admin`). A `DataKey::Admin` unit variant would encode to
    // the identical `Vec[Symbol("Admin")]` storage key and collide (→ AdminAlreadySet).
    Token,         // yield-farming asset token address (SEP-41 / SAC)
    Strategies,    // Vec<Address> — registered strategies, drained in order on redeem
    Keeper,        // address allowed to call compound/rebalance (Task 8/9)
    LastRebalance, // ledger timestamp of the last rebalance; constructor seeds it to 0
    CooldownS,     // min seconds between rebalances (enforced starting Task 9)
    MaxMoveBps,    // max bps of total_assets movable per rebalance (enforced starting Task 9)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInit = 1,
    InvalidAmount = 2,
    InsufficientShares = 4, // redeem more shares than held
    MathOverflow = 5,
    StrategyNotFound = 10,  // remove_strategy: address isn't in the registry
    TooManyStrategies = 11, // add_strategy: registry already holds MAX_STRATEGIES (4)
    StrategyNotEmpty = 12,  // remove_strategy: strategy.balance() != 0
    NotKeeper = 13,         // compound/rebalance: caller isn't the registered keeper (or none set)
    // CooldownActive=14, MoveTooLarge=15 (Task 9) — deferred until that task constructs
    // them, to keep this task's `-D warnings` clippy gate clean.
    FirstDepositTooSmall = 16, // first deposit below MIN_FIRST_DEPOSIT (inflation guard)
    InsufficientLiquidity = 17, // redeem cannot be covered even after draining strategies
    StrategyAlreadyRegistered = 18, // add_strategy: address is already in the registry
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

#[contractevent(topics = ["vault_compound"])]
pub struct Compound {
    pub total_gain: i128,      // USDC gain realized across every strategy this call
    pub price_per_share: i128, // exchange rate immediately after the sweep (7dp, PPS_SCALE)
}

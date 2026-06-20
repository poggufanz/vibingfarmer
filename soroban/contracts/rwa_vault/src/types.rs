use soroban_sdk::{contracterror, contractevent, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // NOTE: no `Admin` key here — the admin lives in OZ access-control storage
    // (`AccessControlStorageKey::Admin`). A `DataKey::Admin` unit variant would encode to
    // the identical `Vec[Symbol("Admin")]` storage key and collide (→ AdminAlreadySet).
    Token,            // yield-farming asset token address (SEP-41 / SAC)
    AccDivPerShare,   // cumulative dividend per share, scaled by SCALE (i128)
    TotalPrincipal,   // sum of deposited assets backing shares 1:1 (i128)
    DripEpoch,        // monotonically increasing dividend epoch (u64)
    RewardDebt(Address), // per-holder accounted dividend baseline (i128)
    Pending(Address),    // per-holder settled-but-unclaimed dividend (i128)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInit = 1,
    InvalidAmount = 2,
    NoShares = 3,            // drip with zero total supply
    InsufficientShares = 4,  // redeem more than held
    MathOverflow = 5,
    NothingToClaim = 6,
}

#[contractevent(topics = ["vault_deposit"])]
pub struct Deposit {
    pub holder: Address,
    pub amount: i128, // assets in
    pub shares: i128, // shares minted (== amount, stable NAV)
}

#[contractevent(topics = ["vault_redeem"])]
pub struct Redeem {
    pub holder: Address,
    pub shares: i128,
    pub assets: i128, // == shares, stable NAV
}

#[contractevent(topics = ["vault_drip"])]
pub struct Drip {
    pub epoch: u64,
    pub amount: i128,            // dividend funded this epoch
    pub acc_div_per_share: i128, // new cumulative index
    pub total_shares: i128,
}

#[contractevent(topics = ["vault_claim"])]
pub struct Claim {
    pub holder: Address,
    pub amount: i128, // asset dividend paid out
}

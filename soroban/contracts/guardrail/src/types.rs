use soroban_sdk::{contracterror, contracttype, Address};

#[contracttype]
#[derive(Clone)]
pub struct Policy {
    pub max_exposure: i128, // absolute per-(owner,vault) position ceiling, units
    pub max_pct_bps: u32,   // max value-share of any single vault, basis points (<=10000)
}

#[contracttype]
#[derive(Clone)]
pub struct SpendState {
    pub spent_in_period: i128,
    pub period_start: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,                      // set_nav authority (instance)
    Registry,                   // registry contract address (instance)
    Policy(Address),            // agent -> Policy            (persistent)
    Spend(Address),             // agent -> SpendState        (persistent)
    TotalValue(Address),        // owner -> i128 running portfolio value (persistent)
    Position(Address, Address), // (owner, vault) -> i128 units held (persistent)
    Nav(Address),               // vault -> i128 admin-set NAV (persistent)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GuardrailError {
    InvalidAmount = 1,
    Revoked = 2,
    Expired = 3,
    WrongVault = 4,
    PolicyNotSet = 5,
    SpendCapExceeded = 6,
    ExposureCapExceeded = 7,
    AllocCapExceeded = 8,
    MathOverflow = 9,
    NotOwner = 10,
}

use soroban_sdk::{contracterror, contracttype, Address};

/// Capped, expiring per-agent scope. Mirrors the EVM `AgentScope` struct.
/// Amounts are i128 (Soroban native signed 128-bit); durations/timestamps are
/// ledger-clock seconds (u64).
#[contracttype]
#[derive(Clone)]
pub struct AgentScope {
    pub owner: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub period_duration: u64,
    pub spent_in_period: i128,
    pub period_start: u64,
    pub expiry: u64,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Signer, // ed25519 session public key (BytesN<32>)
    Scope,
    ExitSigner, // ed25519 exit session public key (BytesN<32>)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    AlreadyInit = 1,
    NotInit = 2,
    Revoked = 3,
    Expired = 4,
    CapExceeded = 5,
    VaultMismatch = 6,
    FnNotAllowed = 7,
    BadSignature = 8,
    UnexpectedContexts = 9,
    InvalidAmount = 10,
    // owner_withdraw (Task 3) — appended; existing discriminants unchanged.
    NotOwner = 20,
    NothingToWithdraw = 21,
}

use soroban_sdk::{contracterror, contracttype, Address, BytesN};

/// Capped, expiring per-agent scope (v3). `target` = vault (kind 0 / Deposit)
/// atau TokenMessengerMinter (kind 1 / Bridge). `mint_recipient` +
/// `destination_domain` hanya bermakna untuk Bridge; nol untuk Deposit.
#[contracttype]
#[derive(Clone)]
pub struct AgentScope {
    pub owner: Address,
    pub target: Address,
    pub token: Address,
    pub kind: u32,
    pub mint_recipient: BytesN<32>,
    pub destination_domain: u32,
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
    // funding_router that factory-deployed this agent (Address). Set only when the
    // constructor received Some(router); absent for legacy direct deploys.
    Router,
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
    // v3 bridge scope — appended.
    BridgeArgMismatch = 22,
    KindInvalid = 23,
}

use soroban_sdk::{contracterror, contracttype, Address, BytesN};

/// Generation this crate currently builds. Bumped from 3 to 4 by the addition of
/// `AgentScope.per_execution_max` (a single-execution cap enforced by `__check_auth`,
/// independent of and additional to the existing period/cumulative cap). Exposed via
/// `AgentAccount::version()` so an on-chain probe (and the frontend agent-creator manifest)
/// can tell generation 4 apart from the earlier fresh-only generations without guessing from a
/// wasm hash.
pub const AGENT_ACCOUNT_GENERATION: u32 = 4;

/// Capped, expiring per-agent scope (v4). `target` = vault (kind 0 / Deposit)
/// atau TokenMessengerMinter (kind 1 / Bridge). `mint_recipient` +
/// `destination_domain` hanya bermakna untuk Bridge; nol untuk Deposit.
/// `per_execution_max` (v4, additive) bounds any SINGLE deposit/burn amount independently of
/// `cap_per_period`'s rolling cumulative bound — `__check_auth` rejects one execution above it
/// even when the cumulative period cap still has headroom.
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
    pub per_execution_max: i128,
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
    // v4 per-execution cap — appended, existing discriminants unchanged.
    /// A single deposit/burn `amount` exceeds `scope.per_execution_max`, even though the
    /// rolling `cap_per_period` cumulative bound still had headroom.
    PerExecutionMaxExceeded = 24,
}

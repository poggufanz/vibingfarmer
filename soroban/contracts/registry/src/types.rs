use soroban_sdk::{contracterror, contractevent, contracttype, Address};

/// Wire-compatible mirror of `agent_account::types::AgentScope` — an identical
/// field list encodes identically (contracttype maps key by field name). Read
/// via `AgentClient.scope_of()`; never accepted from a caller.
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
pub struct AgentRecord {
    pub owner: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub period_duration: u64,
    pub expiry: u64,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Record(Address), // keyed by agent address
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    NotFound = 1,
    NotOwner = 2,
    /// An existing record's owner can never be replaced.
    OwnerMismatch = 3,
}

#[contractevent(topics = ["agent_authorized"])]
pub struct AgentAuthorized {
    pub owner: Address,
    pub agent: Address,
    pub vault: Address,
    pub token: Address,
    pub cap_per_period: i128,
    pub expiry: u64,
}

#[contractevent(topics = ["agent_revoked"])]
pub struct AgentRevoked {
    pub owner: Address,
    pub agent: Address,
}

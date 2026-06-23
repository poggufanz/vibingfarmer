use soroban_sdk::{contracterror, contractevent, contracttype, Address};

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

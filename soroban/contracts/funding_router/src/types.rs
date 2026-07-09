use soroban_sdk::{contracterror, contracttype, Address, BytesN};

/// Wire-compatible mirror of `agent_account::types::AgentScope`.
///
/// `#[contracttype]` structs encode as maps keyed by field name, so an
/// identical field list encodes identically on the wire. Mirroring (instead of
/// a crate dep on `agent_account`) avoids the sibling `__constructor` wasm
/// link collision and keeps this factory decoupled from the agent crate — the
/// agent code it deploys is pinned by wasm hash, not by Rust linkage.
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

/// Per-agent init parameters supplied by the client in `grant`.
/// `salt` is client-supplied random per agent so re-grants never collide with
/// previously deployed addresses.
#[contracttype]
#[derive(Clone)]
pub struct AgentInit {
    pub signer: BytesN<32>,
    pub salt: BytesN<32>,
    pub cap: i128,
    pub vault: Address,
    pub period_duration: u64,
    pub expiry: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: hash of the agent_account wasm this factory deploys. Pinned
    /// at construction, immutable (no admin, no upgrade).
    AgentWasmHash,
    /// Instance: the sole funding token (SEP-41) this router approves/pulls.
    Token,
    /// Persistent: factory-deployed agent -> granting owner. Only addresses
    /// present here are ever fundable via `pull`.
    Deployed(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    /// `pull` for an address this factory never deployed (fake-agent guard).
    UnknownAgent = 1,
    /// Non-positive budget/cap/amount.
    InvalidAmount = 2,
    /// Instance config missing — unreachable after the constructor ran.
    NotInit = 3,
}

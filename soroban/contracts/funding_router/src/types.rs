use soroban_sdk::{contracterror, contracttype, Address, BytesN};

/// Wire-compatible mirror of `agent_account::types::AgentScope` (v3).
///
/// `#[contracttype]` structs encode as maps keyed by field name, so an
/// identical field list encodes identically on the wire. Mirroring (instead of
/// a crate dep on `agent_account`) avoids the sibling `__constructor` wasm
/// link collision and keeps this factory decoupled from the agent crate — the
/// agent code it deploys is pinned by wasm hash, not by Rust linkage.
/// `target` = vault (kind 0 / Deposit) or TokenMessengerMinter (kind 1 /
/// Bridge). `mint_recipient` + `destination_domain` only meaningful for
/// Bridge; zero for Deposit.
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

/// One token's budget in a multi-token `grant`. The router approves the
/// router to spend up to `budget` of `token` until the grant's
/// `expiry_ledger` — one SEP-41 `approve` per budget entry.
#[contracttype]
#[derive(Clone)]
pub struct TokenBudget {
    pub budget: i128,
    pub token: Address,
}

/// Per-agent init parameters supplied by the client in `grant`.
/// `salt` is client-supplied random per agent so re-grants never collide with
/// previously deployed addresses. `token` must appear in the grant's
/// `budgets`. `kind` 0 = Deposit (`target` = vault), 1 = Bridge (`target` =
/// TokenMessengerMinter, `mint_recipient` + `destination_domain` required).
#[contracttype]
#[derive(Clone)]
pub struct AgentInit {
    pub signer: BytesN<32>,
    pub salt: BytesN<32>,
    pub cap: i128,
    pub token: Address,
    pub target: Address,
    pub kind: u32,
    pub mint_recipient: BytesN<32>,
    pub destination_domain: u32,
    pub period_duration: u64,
    pub expiry: u64,
}

/// Recorded per factory-deployed agent: the granting owner and the token
/// `pull` must move for this specific agent (agents in the same grant may
/// carry different tokens).
#[contracttype]
#[derive(Clone)]
pub struct DeployedInfo {
    pub owner: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: hash of the agent_account wasm this factory deploys. Pinned
    /// at construction, immutable (no admin, no upgrade).
    AgentWasmHash,
    /// Persistent: factory-deployed agent -> DeployedInfo. Only addresses
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
    /// `grant` with no agents: an allowance nothing can ever pull.
    EmptyAgents = 4,
    /// Allowance `expiry_ledger` at/before the current ledger, or an agent
    /// scope `expiry` at/before the current timestamp — dead on arrival.
    InvalidExpiry = 5,
    /// Zero `period_duration` — the rolling cap window must be positive.
    InvalidPeriod = 6,
    // v2 multi-token grant — appended, existing discriminants unchanged.
    /// `AgentInit.kind` > 1, or `kind == 1` (Bridge) with a zero
    /// `mint_recipient` or zero `destination_domain`.
    InvalidKind = 7,
    /// An `AgentInit.token` not covered by any entry in `budgets`.
    TokenNotBudgeted = 8,
    /// `grant` with no budgets: nothing would ever be approved.
    EmptyBudgets = 9,
    /// Two `budgets` entries name the same token.
    DuplicateBudgetToken = 10,
}

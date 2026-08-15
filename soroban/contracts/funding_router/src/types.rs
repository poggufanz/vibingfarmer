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
/// v4 (Task 4): mirrors `agent_account::types::AgentScope`'s added `per_execution_max` — the
/// field list must stay identical or `pull_v3`'s cross-contract `scope_of()` read (via
/// `AgentScopeClient`, defined in lib.rs) decodes the wrong shape.
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

/// Router V3 (Task 4): a bounded, REUSABLE permission — unlike `grant`/`pull` (a straight SEP-41
/// allowance pass-through with no router-side bookkeeping), the router itself tracks cumulative
/// spend against `mandate_ceiling` so ONE owner signature can authorize MANY `pull_v3` calls over
/// the permission's life, each individually capped at `per_run_max`. `scope_id` fingerprints the
/// immutable (target, token, kind, mint_recipient, destination_domain) tuple shared by every
/// agent `grant_v3` links to this permission — `pull_v3` recomputes it from the pulling agent's
/// LIVE `scope_of()` and rejects any drift. Separate storage/events from V2 — a V2 `Deployed`
/// receipt is never reinterpreted as a V3 permission.
#[contracttype]
#[derive(Clone)]
pub struct PermissionGrantV3 {
    pub permission_id: BytesN<32>,
    pub scope_id: BytesN<32>,
    pub owner: Address,
    pub token: Address,
    pub mandate_ceiling: i128,
    pub confirmed_spent: i128,
    pub per_run_max: i128,
    pub live_until_ledger: u32,
    pub revoked: bool,
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
    // --- v3 (Task 4): separate namespace from the v2 keys above — a V2 `Deployed` receipt is
    // NEVER reinterpreted as a V3 permission/linkage record, and vice versa.
    /// Persistent: permission_id -> PermissionGrantV3. The bounded, reusable grant record.
    PermissionV3(BytesN<32>),
    /// Persistent: agent -> permission_id. Set ONCE at `grant_v3`, never mutated afterward — the
    /// "immutable agent linkage" `pull_v3` checks every call.
    LinkedAgentV3(Address),
    /// Persistent: sha256(permission_id, execution_id) -> true. Replay guard — every `pull_v3`
    /// checks this is absent before executing and sets it before the SEP-41 transfer_from, so a
    /// duplicate execution_id (from the SAME permission) can never be pulled twice.
    ExecutionUsedV3(BytesN<32>),
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
    // --- v3 (Task 4): bounded reusable grant — appended, existing discriminants unchanged. ---
    /// `grant_v3`'s `per_run_max` exceeds `mandate_ceiling` — a single run could never fit
    /// within the lifetime ceiling it was supposedly planned against.
    CeilingBelowPlanned = 11,
    /// `pull_v3`/`permission_grant`/`revoke_v3` named a `permission_id` this router never
    /// granted.
    UnknownPermissionV3 = 12,
    /// The permission is revoked (`revoke_v3` was called, or a stricter future admin path).
    RevokedV3 = 13,
    /// The current ledger sequence is at/past `live_until_ledger`.
    ExpiredV3 = 14,
    /// The linked agent's LIVE `scope_of()` no longer fingerprints to the permission's recorded
    /// `scope_id` — target/token/kind/mint_recipient/destination_domain must never drift.
    ScopeMismatchV3 = 15,
    /// `pull_v3`'s `amount` exceeds `per_run_max`.
    PerRunExceededV3 = 16,
    /// `confirmed_spent + amount` would exceed `mandate_ceiling`.
    CeilingExceededV3 = 17,
    /// `execution_id` was already used for this `permission_id` (replay).
    DuplicateExecutionV3 = 18,
}

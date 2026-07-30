//! FundingRouter — one-popup grant factory + funding gate (zero custody).
//!
//! The owner's single `grant` auth entry covers a nested SEP-41
//! `token.approve(owner, router, budget, expiry_ledger)` sub-invocation per
//! budgeted token (v2: multi-token), so budget + expiry enforcement is native
//! token allowance — the router never holds funds. Agents are deployed BY
//! this factory (pinned wasm hash) and recorded `agent -> (owner, token)`;
//! only factory-deployed agents are ever fundable, which defeats the
//! fake-agent-claiming-a-victim-owner attack. Revoke is simply
//! `token.approve(owner, router, 0, ...)` — no router fn needed. No admin.
//! No upgrade.
#![no_std]
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, panic_with_error, token, Address,
    Bytes, BytesN, Env, Vec,
};

mod test;
pub mod types;

use types::{
    AgentInit, AgentScope, DataKey, DeployedInfo, PermissionGrantV3, RouterError, TokenBudget,
};

/// Minimal client for a deployed agent_account's read-only scope getter — hand-written (same
/// reasoning as `types::AgentScope`'s mirror comment) rather than a crate dep on `agent_account`.
/// `pull_v3` uses this to re-fingerprint the linked agent's LIVE scope against the permission's
/// recorded `scope_id`.
#[contractclient(name = "AgentScopeClient")]
pub trait AgentScopeSource {
    fn scope_of(env: Env) -> AgentScope;
}

const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

/// One budget entry approved during a `grant`: allowance for `token` (re)set
/// to `budget` until `expiry_ledger`. Published once per `budgets` entry.
#[contractevent]
pub struct Grant {
    #[topic]
    pub owner: Address,
    pub token: Address,
    pub budget: i128,
    pub expiry_ledger: u32,
    pub agents: u32,
}

/// One agent_account deployed by the factory during `grant`.
#[contractevent]
pub struct Deployed {
    #[topic]
    pub owner: Address,
    #[topic]
    pub agent: Address,
    pub cap: i128,
}

/// One funding pull executed: `amount` moved owner -> agent.
#[contractevent]
pub struct Pulled {
    #[topic]
    pub owner: Address,
    #[topic]
    pub agent: Address,
    pub amount: i128,
}

/// V3 (Task 4): one bounded, reusable permission created. Separate topic/shape from `Grant` —
/// never conflated with a V2 receipt.
#[contractevent]
pub struct GrantedV3 {
    #[topic]
    pub owner: Address,
    #[topic]
    pub permission_id: BytesN<32>,
    pub token: Address,
    pub mandate_ceiling: i128,
    pub per_run_max: i128,
    pub live_until_ledger: u32,
    pub agents: u32,
}

/// V3 (Task 4): one `pull_v3` execution. Separate topic/shape from `Pulled`.
#[contractevent]
pub struct PulledV3 {
    #[topic]
    pub owner: Address,
    #[topic]
    pub permission_id: BytesN<32>,
    pub agent: Address,
    pub execution_id: BytesN<32>,
    pub amount: i128,
}

#[contract]
pub struct FundingRouter;

#[contractimpl]
impl FundingRouter {
    /// Pins the agent wasm hash forever. Immutable — there is no admin and no
    /// upgrade path. Funding tokens are no longer pinned instance-wide (v2):
    /// each `grant` names its own tokens via `budgets`.
    pub fn __constructor(env: Env, agent_wasm_hash: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::AgentWasmHash, &agent_wasm_hash);
    }

    /// The ONE popup. Under the owner's single auth entry this (1) approves
    /// the router to spend up to `budget` until `expiry_ledger` for EVERY
    /// token in `budgets` (one nested `token.approve` per entry — SEP-41
    /// allowance IS the budget/expiry enforcement), and (2) deploys one
    /// agent_account per `AgentInit` with the pinned wasm hash, recording
    /// `agent -> (owner, token)`. Every agent's `token` must appear in
    /// `budgets`. Returns the deployed agent addresses in input order. A
    /// later `grant` REPLACES each named token's allowance (re-grant) — salts
    /// must be fresh per agent.
    pub fn grant(
        env: Env,
        owner: Address,
        budgets: Vec<TokenBudget>,
        expiry_ledger: u32,
        agents: Vec<AgentInit>,
    ) -> Vec<Address> {
        owner.require_auth();
        if budgets.is_empty() {
            panic_with_error!(&env, RouterError::EmptyBudgets);
        }
        if agents.is_empty() {
            panic_with_error!(&env, RouterError::EmptyAgents);
        }
        if expiry_ledger <= env.ledger().sequence() {
            panic_with_error!(&env, RouterError::InvalidExpiry);
        }
        let now = env.ledger().timestamp();
        // Validate EVERY budget and EVERY init before any approval or deploy
        // — a bad entry must leave zero side effects behind.
        for (i, b) in budgets.iter().enumerate() {
            if b.budget <= 0 {
                panic_with_error!(&env, RouterError::InvalidAmount);
            }
            for j in 0..i {
                if budgets.get(j as u32).unwrap().token == b.token {
                    panic_with_error!(&env, RouterError::DuplicateBudgetToken);
                }
            }
        }
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        for init in agents.iter() {
            if init.cap <= 0 {
                panic_with_error!(&env, RouterError::InvalidAmount);
            }
            if init.period_duration == 0 {
                panic_with_error!(&env, RouterError::InvalidPeriod);
            }
            if init.expiry <= now {
                panic_with_error!(&env, RouterError::InvalidExpiry);
            }
            if init.kind > 1 {
                panic_with_error!(&env, RouterError::InvalidKind);
            }
            if init.kind == 1 && (init.mint_recipient == zero || init.destination_domain == 0) {
                panic_with_error!(&env, RouterError::InvalidKind);
            }
            let mut found = false;
            for b in budgets.iter() {
                if b.token == init.token {
                    found = true;
                }
            }
            if !found {
                panic_with_error!(&env, RouterError::TokenNotBudgeted);
            }
        }
        let wasm_hash = read_wasm_hash(&env);
        let router = env.current_contract_address();

        // Nested under the owner's grant auth entry — the popup's auth tree
        // must cover each of these sub-invocations (router.grant ->
        // token.approve, once per budgeted token).
        for b in budgets.iter() {
            token::Client::new(&env, &b.token).approve(
                &owner,
                &router,
                &b.budget,
                &expiry_ledger,
            );
            Grant {
                owner: owner.clone(),
                token: b.token.clone(),
                budget: b.budget,
                expiry_ledger,
                agents: agents.len(),
            }
            .publish(&env);
        }

        let mut deployed: Vec<Address> = Vec::new(&env);
        for init in agents.iter() {
            let scope = AgentScope {
                owner: owner.clone(),
                target: init.target,
                token: init.token.clone(),
                kind: init.kind,
                mint_recipient: init.mint_recipient.clone(),
                destination_domain: init.destination_domain,
                cap_per_period: init.cap,
                period_duration: init.period_duration,
                spent_in_period: 0,
                period_start: now,
                expiry: init.expiry,
                revoked: false,
                // v2/`grant` stays byte-compatible and untouched in behavior (Task 4): unrestricted
                // relative to cap_per_period, which is already the hardest ceiling any single
                // execution could need — this new v4 field is a strict no-op restriction here.
                per_execution_max: i128::MAX,
            };
            // Factory deploy: deployer address = this contract, so no extra
            // auth is required. The agent's own constructor self-approves
            // token -> target via invoker auth, and pins THIS router (4th
            // ctor arg) so its session key may later authorize `pull` on it.
            // Salt is owner-bound (domain tag + router + owner + raw salt) so
            // another owner can never squat a predictable salt namespace.
            let salt = derive_salt(&env, &router, &owner, &init.salt);
            let agent = env.deployer().with_current_contract(salt).deploy_v2(
                wasm_hash.clone(),
                (owner.clone(), init.signer, scope, Some(router.clone())),
            );
            let key = DataKey::Deployed(agent.clone());
            env.storage().persistent().set(
                &key,
                &DeployedInfo {
                    owner: owner.clone(),
                    token: init.token.clone(),
                },
            );
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
            Deployed {
                owner: owner.clone(),
                agent: agent.clone(),
                cap: init.cap,
            }
            .publish(&env);
            deployed.push_back(agent);
        }
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        deployed
    }

    /// Funding gate. Only an agent this factory deployed can pull, only with
    /// its own auth (session key; relayed, zero popups), only from the owner
    /// recorded at deploy time — never from a caller-supplied address — and
    /// only in that agent's own token (recorded at deploy time; agents from
    /// the same grant may carry different tokens). Token allowance enforces
    /// budget + expiry; the router holds nothing.
    pub fn pull(env: Env, agent: Address, amount: i128) {
        agent.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, RouterError::InvalidAmount);
        }
        let key = DataKey::Deployed(agent.clone());
        let info: DeployedInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RouterError::UnknownAgent));
        // Router is the direct invoker => the spender's (router's) auth on
        // transfer_from is implicit invoker auth. Funds move owner -> agent.
        token::Client::new(&env, &info.token).transfer_from(
            &env.current_contract_address(),
            &info.owner,
            &agent,
            &amount,
        );
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        Pulled {
            owner: info.owner,
            agent,
            amount,
        }
        .publish(&env);
    }

    /// Owner recorded for a factory-deployed agent, `None` for anything else.
    pub fn owner_of(env: Env, agent: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Deployed(agent))
            .map(|info: DeployedInfo| info.owner)
    }

    /// The pinned agent wasm hash.
    pub fn config(env: Env) -> BytesN<32> {
        read_wasm_hash(&env)
    }

    // ─────────────────────────── V3: bounded, reusable grant (Task 4) ───────────────────────────

    /// Creates ONE bounded, reusable `PermissionGrantV3` for `owner`/`token` and deploys one V4
    /// agent_account (same pinned wasm hash as `grant`) per `AgentInit`, each IMMUTABLY linked to
    /// the returned `permission_id`. Every `init.token` must equal `token` (one token per
    /// permission — simpler than V2's multi-budget `grant`) and every agent must share the same
    /// (target, kind, mint_recipient, destination_domain) — the permission has exactly one scope
    /// fingerprint (`scope_id`). `mandate_ceiling` is split evenly across the deployed agents'
    /// `per_execution_max` (floor division: the aggregate allocation can never round ABOVE
    /// `mandate_ceiling`; any remainder is simply left unallocated). Nested under the owner's
    /// single auth entry: one SEP-41 `approve(owner, router, mandate_ceiling,
    /// live_until_ledger)` covers every future `pull_v3` transfer_from — the router still holds
    /// nothing (zero custody, same as `grant`).
    pub fn grant_v3(
        env: Env,
        owner: Address,
        token: Address,
        mandate_ceiling: i128,
        per_run_max: i128,
        live_until_ledger: u32,
        agents: Vec<AgentInit>,
    ) -> (BytesN<32>, Vec<Address>) {
        owner.require_auth();
        if agents.is_empty() {
            panic_with_error!(&env, RouterError::EmptyAgents);
        }
        if mandate_ceiling <= 0 || per_run_max <= 0 {
            panic_with_error!(&env, RouterError::InvalidAmount);
        }
        if per_run_max > mandate_ceiling {
            panic_with_error!(&env, RouterError::CeilingBelowPlanned);
        }
        if live_until_ledger <= env.ledger().sequence() {
            panic_with_error!(&env, RouterError::InvalidExpiry);
        }
        let now = env.ledger().timestamp();
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let first = agents.get(0).unwrap();
        let scope_id = derive_scope_id(
            &env,
            &first.target,
            &token,
            first.kind,
            &first.mint_recipient,
            first.destination_domain,
        );
        // Validate EVERY init before any approval or deploy — a bad entry must leave zero side
        // effects behind (same discipline as `grant`).
        for init in agents.iter() {
            if init.token != token {
                panic_with_error!(&env, RouterError::TokenNotBudgeted);
            }
            if init.cap <= 0 {
                panic_with_error!(&env, RouterError::InvalidAmount);
            }
            if init.period_duration == 0 {
                panic_with_error!(&env, RouterError::InvalidPeriod);
            }
            if init.expiry <= now {
                panic_with_error!(&env, RouterError::InvalidExpiry);
            }
            if init.kind > 1 {
                panic_with_error!(&env, RouterError::InvalidKind);
            }
            if init.kind == 1 && (init.mint_recipient == zero || init.destination_domain == 0) {
                panic_with_error!(&env, RouterError::InvalidKind);
            }
            let this_scope_id = derive_scope_id(
                &env,
                &init.target,
                &token,
                init.kind,
                &init.mint_recipient,
                init.destination_domain,
            );
            if this_scope_id != scope_id {
                panic_with_error!(&env, RouterError::ScopeMismatchV3);
            }
        }

        let wasm_hash = read_wasm_hash(&env);
        let router = env.current_contract_address();

        token::Client::new(&env, &token).approve(
            &owner,
            &router,
            &mandate_ceiling,
            &live_until_ledger,
        );

        // Deterministic even split — floor division so the aggregate per-agent allocation can
        // never round ABOVE mandate_ceiling; any remainder is simply never allocated to anyone.
        let n = agents.len() as i128;
        let per_agent_max = mandate_ceiling / n;

        let permission_id = derive_permission_id(&env, &router, &owner, &agents);

        let mut deployed: Vec<Address> = Vec::new(&env);
        for init in agents.iter() {
            let scope = AgentScope {
                owner: owner.clone(),
                target: init.target.clone(),
                token: token.clone(),
                kind: init.kind,
                mint_recipient: init.mint_recipient.clone(),
                destination_domain: init.destination_domain,
                cap_per_period: init.cap,
                period_duration: init.period_duration,
                spent_in_period: 0,
                period_start: now,
                expiry: init.expiry,
                revoked: false,
                per_execution_max: per_agent_max,
            };
            let salt = derive_salt(&env, &router, &owner, &init.salt);
            let agent = env.deployer().with_current_contract(salt).deploy_v2(
                wasm_hash.clone(),
                (owner.clone(), init.signer, scope, Some(router.clone())),
            );
            let link_key = DataKey::LinkedAgentV3(agent.clone());
            env.storage().persistent().set(&link_key, &permission_id);
            env.storage()
                .persistent()
                .extend_ttl(&link_key, TTL_THRESHOLD, TTL_EXTEND);
            deployed.push_back(agent);
        }

        let grant = PermissionGrantV3 {
            permission_id: permission_id.clone(),
            scope_id,
            owner: owner.clone(),
            token: token.clone(),
            mandate_ceiling,
            confirmed_spent: 0,
            per_run_max,
            live_until_ledger,
            revoked: false,
        };
        let perm_key = DataKey::PermissionV3(permission_id.clone());
        env.storage().persistent().set(&perm_key, &grant);
        env.storage()
            .persistent()
            .extend_ttl(&perm_key, TTL_THRESHOLD, TTL_EXTEND);

        GrantedV3 {
            owner,
            permission_id: permission_id.clone(),
            token,
            mandate_ceiling,
            per_run_max,
            live_until_ledger,
            agents: deployed.len(),
        }
        .publish(&env);

        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        (permission_id, deployed)
    }

    /// Verifies, in order: the permission exists and is neither revoked nor past
    /// `live_until_ledger`; `execution_id` has never been used before for THIS permission
    /// (replay guard); `agent` is the one immutably linked to `permission_id` at `grant_v3`
    /// time; the agent's LIVE `scope_of()` still fingerprints to the permission's recorded
    /// `scope_id`; `amount` is positive, within `per_run_max`, and within the remaining
    /// `mandate_ceiling - confirmed_spent` headroom. Only then does it mark the execution used,
    /// advance `confirmed_spent`, and call SEP-41 `transfer_from` — all in the SAME invocation,
    /// so a failed transfer traps and rolls back the spend/replay writes too (Soroban's
    /// per-invocation storage writes are all-or-nothing).
    pub fn pull_v3(env: Env, permission_id: BytesN<32>, execution_id: BytesN<32>, agent: Address, amount: i128) {
        agent.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, RouterError::InvalidAmount);
        }
        let perm_key = DataKey::PermissionV3(permission_id.clone());
        let mut grant: PermissionGrantV3 = env
            .storage()
            .persistent()
            .get(&perm_key)
            .unwrap_or_else(|| panic_with_error!(&env, RouterError::UnknownPermissionV3));
        if grant.revoked {
            panic_with_error!(&env, RouterError::RevokedV3);
        }
        if env.ledger().sequence() >= grant.live_until_ledger {
            panic_with_error!(&env, RouterError::ExpiredV3);
        }
        let linked: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::LinkedAgentV3(agent.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, RouterError::UnknownAgent));
        if linked != permission_id {
            panic_with_error!(&env, RouterError::UnknownAgent);
        }
        let exec_key = DataKey::ExecutionUsedV3(derive_execution_key(
            &env,
            &permission_id,
            &execution_id,
        ));
        if env.storage().persistent().has(&exec_key) {
            panic_with_error!(&env, RouterError::DuplicateExecutionV3);
        }
        if amount > grant.per_run_max {
            panic_with_error!(&env, RouterError::PerRunExceededV3);
        }
        let new_spent = match grant.confirmed_spent.checked_add(amount) {
            Some(v) => v,
            None => panic_with_error!(&env, RouterError::CeilingExceededV3),
        };
        if new_spent > grant.mandate_ceiling {
            panic_with_error!(&env, RouterError::CeilingExceededV3);
        }
        // Immutable-scope re-check: the agent's live on-chain scope must still fingerprint to
        // what grant_v3 recorded.
        let live = AgentScopeClient::new(&env, &agent).scope_of();
        let live_scope_id = derive_scope_id(
            &env,
            &live.target,
            &live.token,
            live.kind,
            &live.mint_recipient,
            live.destination_domain,
        );
        if live_scope_id != grant.scope_id {
            panic_with_error!(&env, RouterError::ScopeMismatchV3);
        }

        env.storage().persistent().set(&exec_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&exec_key, TTL_THRESHOLD, TTL_EXTEND);
        grant.confirmed_spent = new_spent;
        env.storage().persistent().set(&perm_key, &grant);
        env.storage()
            .persistent()
            .extend_ttl(&perm_key, TTL_THRESHOLD, TTL_EXTEND);

        // Same invocation as the bookkeeping writes above — a failed transfer_from traps and
        // rolls both of them back too.
        token::Client::new(&env, &grant.token).transfer_from(
            &env.current_contract_address(),
            &grant.owner,
            &agent,
            &amount,
        );

        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        PulledV3 {
            owner: grant.owner,
            permission_id,
            agent,
            execution_id,
            amount,
        }
        .publish(&env);
    }

    /// Raw stored permission record, or `None` for an unknown `permission_id` — never fabricated.
    pub fn permission_grant(env: Env, permission_id: BytesN<32>) -> Option<PermissionGrantV3> {
        env.storage().persistent().get(&DataKey::PermissionV3(permission_id))
    }

    /// Exact remaining spendable headroom (`mandate_ceiling - confirmed_spent`) for a known
    /// permission; `0` for an unknown `permission_id` — never a guessed/fabricated budget.
    /// Whether the permission is currently pullable at all (revoked/expired) is a separate
    /// question a caller answers via `permission_grant` itself.
    pub fn remaining_budget(env: Env, permission_id: BytesN<32>) -> i128 {
        env.storage()
            .persistent()
            .get::<_, PermissionGrantV3>(&DataKey::PermissionV3(permission_id))
            .map(|g| g.mandate_ceiling - g.confirmed_spent)
            .unwrap_or(0)
    }

    /// Owner kill switch for a V3 permission (idempotent). Blocks every future `pull_v3` under
    /// it; does NOT touch the linked agents' own on-chain scopes (those still answer to their
    /// own owner-gated `revoke`/`owner_withdraw`).
    pub fn revoke_v3(env: Env, permission_id: BytesN<32>) {
        let key = DataKey::PermissionV3(permission_id);
        let mut grant: PermissionGrantV3 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RouterError::UnknownPermissionV3));
        grant.owner.require_auth();
        if !grant.revoked {
            grant.revoked = true;
            env.storage().persistent().set(&key, &grant);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        }
    }
}

/// Owner-bound deployment salt: sha256(domain tag ‖ router XDR ‖ owner XDR ‖ raw salt).
/// Deterministic per (router, owner, raw salt); different owners can never collide.
fn derive_salt(env: &Env, router: &Address, owner: &Address, raw: &BytesN<32>) -> BytesN<32> {
    let mut pre = Bytes::from_slice(env, b"vibing-farmer/agent-salt/v1");
    pre.append(&router.clone().to_xdr(env));
    pre.append(&owner.clone().to_xdr(env));
    pre.append(&Bytes::from_array(env, &raw.to_array()));
    env.crypto().sha256(&pre).into()
}

fn read_wasm_hash(env: &Env) -> BytesN<32> {
    env.storage()
        .instance()
        .get(&DataKey::AgentWasmHash)
        .unwrap_or_else(|| panic_with_error!(env, RouterError::NotInit))
}

/// V3 (Task 4): fingerprints the immutable scope tuple every agent under one permission must
/// share — sha256(domain tag ‖ target XDR ‖ token XDR ‖ kind ‖ mint_recipient ‖
/// destination_domain). Recorded once at `grant_v3` (`PermissionGrantV3.scope_id`) and
/// recomputed identically at `pull_v3` from the pulling agent's LIVE `scope_of()` — any drift
/// in target/token/kind/mint_recipient/destination_domain rejects the pull.
fn derive_scope_id(
    env: &Env,
    target: &Address,
    token: &Address,
    kind: u32,
    mint_recipient: &BytesN<32>,
    destination_domain: u32,
) -> BytesN<32> {
    let mut pre = Bytes::from_slice(env, b"vibing-farmer/scope-id/v3");
    pre.append(&target.clone().to_xdr(env));
    pre.append(&token.clone().to_xdr(env));
    pre.append(&Bytes::from_array(env, &kind.to_be_bytes()));
    pre.append(&Bytes::from_array(env, &mint_recipient.to_array()));
    pre.append(&Bytes::from_array(env, &destination_domain.to_be_bytes()));
    env.crypto().sha256(&pre).into()
}

/// V3 (Task 4): a unique replay-guard key per (permission_id, execution_id) pair — a duplicate
/// execution_id under a DIFFERENT permission_id is a different key (no cross-permission
/// collision), only a repeat under the SAME permission_id collides.
fn derive_execution_key(env: &Env, permission_id: &BytesN<32>, execution_id: &BytesN<32>) -> BytesN<32> {
    let mut pre = Bytes::from_slice(env, b"vibing-farmer/execution-v3");
    pre.append(&Bytes::from_array(env, &permission_id.to_array()));
    pre.append(&Bytes::from_array(env, &execution_id.to_array()));
    env.crypto().sha256(&pre).into()
}

/// V3 (Task 4): derives a fresh permission_id deterministically from (router, owner, every
/// agent's raw salt) — same domain-separation discipline as `derive_salt`. A literal repeat call
/// with identical owner+salts would already fail earlier at `deploy_v2` (address collision, see
/// `same_owner_same_raw_salt_stays_deterministic`), so no extra collision guard is needed here.
fn derive_permission_id(env: &Env, router: &Address, owner: &Address, agents: &Vec<AgentInit>) -> BytesN<32> {
    let mut pre = Bytes::from_slice(env, b"vibing-farmer/permission-id/v3");
    pre.append(&router.clone().to_xdr(env));
    pre.append(&owner.clone().to_xdr(env));
    for init in agents.iter() {
        pre.append(&Bytes::from_array(env, &init.salt.to_array()));
    }
    env.crypto().sha256(&pre).into()
}

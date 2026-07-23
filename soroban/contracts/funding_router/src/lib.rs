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
    contract, contractevent, contractimpl, panic_with_error, token, Address, Bytes, BytesN, Env,
    Vec,
};

mod test;
pub mod types;

use types::{AgentInit, AgentScope, DataKey, DeployedInfo, RouterError, TokenBudget};

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

#![no_std]
use soroban_sdk::{contract, contractclient, contractimpl, Address, Env};

mod registry;
mod test;
pub mod types;

use types::{AgentRecord, AgentScope, DataKey, RegistryError};

/// Minimal client for a deployed agent_account — the ONLY authoritative source
/// of scope data. The mirrored `AgentScope` encodes identically on the wire
/// (contracttype maps are keyed by field name).
#[contractclient(name = "AgentClient")]
pub trait AgentScopeSource {
    fn scope_of(env: Env) -> AgentScope;
}

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Metadata record derived from the agent contract itself. The caller
    /// supplies ONLY the agent address; every stored field is read from
    /// `agent.scope_of()` and the DERIVED owner must authorize. An existing
    /// record can never switch owner. Registry data is metadata for indexers —
    /// AgentAccount state remains the authorization boundary.
    pub fn authorize(env: Env, agent: Address) -> Result<(), RegistryError> {
        Self::authorize_impl(&env, agent)
    }

    /// Metadata mirror of a revocation. Does NOT disable the agent —
    /// `AgentAccount.revoke()` is the enforcing kill switch.
    pub fn revoke(env: Env, owner: Address, agent: Address) -> Result<(), RegistryError> {
        Self::revoke_impl(&env, owner, agent)
    }

    pub fn record_of(env: Env, agent: Address) -> AgentRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Record(agent))
            .unwrap()
    }

    pub fn is_revoked(env: Env, agent: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Record(agent))
            .map(|r: AgentRecord| r.revoked)
            .unwrap_or(true) // unknown agent = treated as revoked (fail-closed)
    }

    /// Metadata liveness view: false for unknown records, for records whose stored `revoked`
    /// snapshot is set, and for records past their expiry (checked live against the ledger
    /// clock). NOTE: `revoked` is an authorize-time SNAPSHOT — this mirror is not re-synced
    /// when an owner later calls `agent_account.revoke()`, so a consumer needing authoritative
    /// liveness must read the agent's own `scope_of().revoked`. Fail-closed for unknown/expired.
    pub fn is_active(env: Env, agent: Address) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, AgentRecord>(&DataKey::Record(agent))
        {
            Some(r) => !r.revoked && env.ledger().timestamp() < r.expiry,
            None => false,
        }
    }
}

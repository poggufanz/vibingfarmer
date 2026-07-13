use soroban_sdk::{Address, Env};

use crate::types::{AgentAuthorized, AgentRecord, AgentRevoked, DataKey, RegistryError};
use crate::{AgentClient, Registry};

const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

impl Registry {
    pub(crate) fn authorize_impl(env: &Env, agent: Address) -> Result<(), RegistryError> {
        // Authoritative fields come from the agent contract itself; the caller
        // supplies nothing but the address.
        let scope = AgentClient::new(env, &agent).scope_of();
        scope.owner.require_auth();

        let key = DataKey::Record(agent.clone());
        if let Some(existing) = env.storage().persistent().get::<_, AgentRecord>(&key) {
            if existing.owner != scope.owner {
                return Err(RegistryError::OwnerMismatch);
            }
        }

        let rec = AgentRecord {
            owner: scope.owner.clone(),
            vault: scope.vault.clone(),
            token: scope.token.clone(),
            cap_per_period: scope.cap_per_period,
            period_duration: scope.period_duration,
            expiry: scope.expiry,
            revoked: scope.revoked,
        };
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        AgentAuthorized {
            owner: rec.owner.clone(),
            agent,
            vault: rec.vault.clone(),
            token: rec.token.clone(),
            cap_per_period: rec.cap_per_period,
            expiry: rec.expiry,
        }
        .publish(env);
        Ok(())
    }

    pub(crate) fn revoke_impl(
        env: &Env,
        owner: Address,
        agent: Address,
    ) -> Result<(), RegistryError> {
        owner.require_auth();
        let mut rec: AgentRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Record(agent.clone()))
            .ok_or(RegistryError::NotFound)?;
        if rec.owner != owner {
            return Err(RegistryError::NotOwner);
        }
        rec.revoked = true;
        env.storage()
            .persistent()
            .set(&DataKey::Record(agent.clone()), &rec);
        AgentRevoked { owner, agent }.publish(env);
        Ok(())
    }
}

use soroban_sdk::{Address, Env};

use crate::types::{AgentAuthorized, AgentRecord, AgentRevoked, DataKey, RegistryError};
use crate::Registry;

const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

impl Registry {
    #[allow(clippy::too_many_arguments)] // EIP-712 scope grant legitimately needs every field
    pub(crate) fn authorize_impl(
        env: &Env,
        owner: Address,
        agent: Address,
        vault: Address,
        token: Address,
        cap_per_period: i128,
        period_duration: u64,
        expiry: u64,
    ) {
        owner.require_auth();
        let rec = AgentRecord {
            owner: owner.clone(),
            vault: vault.clone(),
            token: token.clone(),
            cap_per_period,
            period_duration,
            expiry,
            revoked: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Record(agent.clone()), &rec);
        env.storage().persistent().extend_ttl(
            &DataKey::Record(agent.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        AgentAuthorized {
            owner,
            agent,
            vault,
            token,
            cap_per_period,
            expiry,
        }
        .publish(env);
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

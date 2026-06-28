#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, Symbol,
};

mod test;

const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Counter(Address),
}

#[contractevent(topics = ["strategy_attested"])]
pub struct StrategyAttested {
    pub attester: Address,
    pub strategy_hash: BytesN<32>,
    pub ledger: u32,
    pub label: Symbol,
}

#[contract]
pub struct Attestation;

#[contractimpl]
impl Attestation {
    /// Record a strategy hash on-chain for `attester`. Bumps the attester's
    /// counter, emits StrategyAttested, returns the new count. Leaf call —
    /// no cross-contract invocation, no admin.
    pub fn attest(
        env: Env,
        attester: Address,
        strategy_hash: BytesN<32>,
        label: Symbol,
    ) -> u32 {
        attester.require_auth();

        let key = DataKey::Counter(attester.clone());
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0) + 1;
        env.storage().persistent().set(&key, &count);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        StrategyAttested {
            attester,
            strategy_hash,
            ledger: env.ledger().sequence(),
            label,
        }
        .publish(&env);

        count
    }

    /// How many attestations `attester` has recorded. 0 if none.
    pub fn count_of(env: Env, attester: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Counter(attester))
            .unwrap_or(0)
    }
}

#![cfg(test)]
use crate::types::AgentScope;
use crate::{Registry, RegistryClient};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

// Test-double agent: exposes the same `scope_of` the real agent_account wasm
// exports (crate dep is impossible — sibling `__constructor` link collision).
// `set_scope` exists ONLY here, to simulate a hostile source feeding the
// registry a different owner for an already-recorded agent.
#[contract]
pub struct MockAgent;

#[contractimpl]
impl MockAgent {
    pub fn __constructor(env: Env, scope: AgentScope) {
        env.storage().instance().set(&symbol_short!("scope"), &scope);
    }
    pub fn scope_of(env: Env) -> AgentScope {
        env.storage().instance().get(&symbol_short!("scope")).unwrap()
    }
    pub fn set_scope(env: Env, scope: AgentScope) {
        env.storage().instance().set(&symbol_short!("scope"), &scope);
    }
}

fn scope(env: &Env, owner: &Address) -> AgentScope {
    AgentScope {
        owner: owner.clone(),
        vault: Address::generate(env),
        token: Address::generate(env),
        cap_per_period: 1_000_000_000,
        period_duration: 86_400,
        spent_in_period: 0,
        period_start: 0,
        expiry: 4_000_000_000,
        revoked: false,
    }
}

struct Setup {
    env: Env,
    registry: RegistryClient<'static>,
    owner: Address,
    agent: Address,
    agent_scope: AgentScope,
}

fn setup() -> Setup {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Registry, (admin,));
    let registry = RegistryClient::new(&env, &id);
    let owner = Address::generate(&env);
    let agent_scope = scope(&env, &owner);
    let agent = env.register(MockAgent, (agent_scope.clone(),));
    Setup {
        env,
        registry,
        owner,
        agent,
        agent_scope,
    }
}

#[test]
fn authorize_derives_record_from_agent_scope() {
    let s = setup();
    s.env.mock_all_auths();

    s.registry.authorize(&s.agent);
    // authorize emits exactly one event (SDK 26 events().all() = last invocation only).
    assert_eq!(s.env.events().all().events().len(), 1);

    // Every stored field equals the agent contract's own scope — no caller input.
    let rec = s.registry.record_of(&s.agent);
    assert_eq!(rec.owner, s.agent_scope.owner);
    assert_eq!(rec.vault, s.agent_scope.vault);
    assert_eq!(rec.token, s.agent_scope.token);
    assert_eq!(rec.cap_per_period, s.agent_scope.cap_per_period);
    assert_eq!(rec.period_duration, s.agent_scope.period_duration);
    assert_eq!(rec.expiry, s.agent_scope.expiry);
    assert!(!rec.revoked);
    assert!(!s.registry.is_revoked(&s.agent));
    assert!(s.registry.is_active(&s.agent));
}

#[test]
fn authorize_requires_the_derived_owner_auth() {
    let s = setup();
    // Nobody signs — the DERIVED owner's require_auth must fail; no record lands.
    s.env.set_auths(&[]);
    assert!(s.registry.try_authorize(&s.agent).is_err());
    assert!(s.registry.is_revoked(&s.agent)); // unknown stays fail-closed
    assert!(!s.registry.is_active(&s.agent));
}

#[test]
fn authorize_rejects_owner_swap_for_existing_record() {
    let s = setup();
    s.env.mock_all_auths();
    s.registry.authorize(&s.agent);

    // Attacker rewires the scope source to claim a different owner and
    // re-authorizes (fully authed) — the existing record must not flip owner.
    let attacker = Address::generate(&s.env);
    let mut hostile = s.agent_scope.clone();
    hostile.owner = attacker.clone();
    MockAgentClient::new(&s.env, &s.agent).set_scope(&hostile);

    assert!(s.registry.try_authorize(&s.agent).is_err());
    assert_eq!(s.registry.record_of(&s.agent).owner, s.owner);
}

#[test]
fn is_active_is_fail_closed_and_tracks_revoke_and_expiry() {
    let s = setup();
    s.env.mock_all_auths();

    // Unknown agent: inactive + revoked (fail-closed).
    let unknown = Address::generate(&s.env);
    assert!(!s.registry.is_active(&unknown));
    assert!(s.registry.is_revoked(&unknown));

    s.registry.authorize(&s.agent);
    assert!(s.registry.is_active(&s.agent));

    // Metadata revoke kills liveness…
    s.registry.revoke(&s.owner, &s.agent);
    assert!(!s.registry.is_active(&s.agent));
    assert!(s.registry.is_revoked(&s.agent));
    // …but is METADATA ONLY: the agent contract's own scope is untouched.
    assert!(!MockAgentClient::new(&s.env, &s.agent).scope_of().revoked);
}

#[test]
fn is_active_false_after_expiry() {
    let s = setup();
    s.env.mock_all_auths();
    s.registry.authorize(&s.agent);
    assert!(s.registry.is_active(&s.agent));

    s.env.ledger().set_timestamp(4_000_000_000); // == expiry: dead
    assert!(!s.registry.is_active(&s.agent));
}

#[test]
fn revoke_requires_owner() {
    let s = setup();
    s.env.mock_all_auths();
    s.registry.authorize(&s.agent);

    // Stranger tries to revoke with no auths set → must fail.
    let stranger = Address::generate(&s.env);
    s.env.set_auths(&[]);
    assert!(s.registry.try_revoke(&stranger, &s.agent).is_err());
}

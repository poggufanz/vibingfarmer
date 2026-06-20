#![cfg(test)]
use crate::{Guardrail, GuardrailClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

const U7: i128 = 10_000_000;
const DEFAULT_NAV: i128 = 10_000_000;

pub(crate) struct Ctx {
    pub guard: GuardrailClient<'static>,
    pub reg: registry::RegistryClient<'static>,
    pub admin: Address,
    pub owner: Address,
    pub agent: Address,
    pub vault: Address,
    pub token: Address,
}

// Deploys a real registry + the guardrail, authorizes `agent` to `vault` with the given
// per-period spend cap. Caller sets a policy afterward as the test needs.
pub(crate) fn setup_with_cap(env: &Env, cap_per_period: i128, period_duration: u64, expiry: u64) -> Ctx {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let agent = Address::generate(env);
    let vault = Address::generate(env);
    let token = Address::generate(env);

    let reg_id = env.register(registry::Registry, (admin.clone(),));
    let reg = registry::RegistryClient::new(env, &reg_id);
    reg.authorize(&owner, &agent, &vault, &token, &cap_per_period, &period_duration, &expiry);

    let guard_id = env.register(Guardrail, (admin.clone(), reg_id.clone()));
    let guard = GuardrailClient::new(env, &guard_id);
    Ctx { guard, reg, admin, owner, agent, vault, token }
}

// Convenience: permissive scope (caps never bind) for tests that exercise a single dimension.
pub(crate) fn setup(env: &Env) -> Ctx {
    setup_with_cap(env, 1_000_000 * U7, 86_400, 4_000_000_000)
}

#[test]
fn test_nav_defaults_then_set_by_admin() {
    let env = Env::default();
    let c = setup(&env);
    assert_eq!(c.guard.nav_of(&c.vault), DEFAULT_NAV); // unset → 1e7
    c.guard.set_nav(&c.vault, &(2 * DEFAULT_NAV));
    assert_eq!(c.guard.nav_of(&c.vault), 2 * DEFAULT_NAV);
}

#[test]
fn test_set_nav_rejects_non_positive() {
    let env = Env::default();
    let c = setup(&env);
    assert!(c.guard.try_set_nav(&c.vault, &0i128).is_err());
    assert!(c.guard.try_set_nav(&c.vault, &(-1i128)).is_err());
}

#[test]
fn test_set_nav_is_admin_gated() {
    let env = Env::default();
    let c = setup(&env);
    env.set_auths(&[]); // no signatures → admin.require_auth() must fail
    assert!(c.guard.try_set_nav(&c.vault, &(2 * DEFAULT_NAV)).is_err());
}

#[test]
fn test_set_policy_owner_gated_and_owner_match() {
    let env = Env::default();
    let c = setup(&env);
    // owner of the agent's record may set the policy
    c.guard.set_policy(&c.owner, &c.agent, &(100 * U7), &5_000u32);
    let p = c.guard.policy_of(&c.agent);
    assert_eq!(p.max_exposure, 100 * U7);
    assert_eq!(p.max_pct_bps, 5_000);
    // a non-owner address is rejected even with auth mocked (owner != record owner)
    let stranger = Address::generate(&env);
    assert!(c.guard.try_set_policy(&stranger, &c.agent, &(100 * U7), &5_000u32).is_err());
}

#[test]
fn test_set_policy_rejects_bad_bps_and_exposure() {
    let env = Env::default();
    let c = setup(&env);
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &(100 * U7), &0u32).is_err());     // bps 0
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &(100 * U7), &10_001u32).is_err()); // bps > 100%
    assert!(c.guard.try_set_policy(&c.owner, &c.agent, &0i128, &5_000u32).is_err());        // exposure 0
}

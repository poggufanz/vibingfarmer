#![cfg(test)]
use crate::{Guardrail, GuardrailClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

const U7: i128 = 10_000_000;
const DEFAULT_NAV: i128 = 10_000_000;

pub(crate) struct Ctx {
    pub guard: GuardrailClient<'static>,
    pub reg: registry::RegistryClient<'static>,
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
    let _ = admin; // admin only needed to register the contracts above
    Ctx { guard, reg, owner, agent, vault, token }
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

use soroban_sdk::testutils::Ledger as _;

// ---- spend cap (per-agent, units) ----
#[test]
fn test_spend_cap_passes_at_limit_reverts_over() {
    let env = Env::default();
    let c = setup_with_cap(&env, 100 * U7, 86_400, 4_000_000_000); // cap = 100
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32); // exposure/alloc unbound
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // == cap → ok
    assert_eq!(c.guard.spend_of(&c.agent).spent_in_period, 100 * U7);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // 100 + 1 > cap
}

#[test]
fn test_spend_period_rolls_after_duration() {
    let env = Env::default();
    let c = setup_with_cap(&env, 100 * U7, 100, 4_000_000_000); // period = 100s
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // fills the period
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // still in-period → over cap
    env.ledger().with_mut(|l| l.timestamp += 101); // elapse the period
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // resets → ok again
    assert_eq!(c.guard.spend_of(&c.agent).spent_in_period, 100 * U7);
}

// ---- exposure cap (per-owner x vault, units) ----
#[test]
fn test_exposure_cap_passes_at_limit_reverts_over() {
    let env = Env::default();
    let c = setup(&env); // huge spend cap
    c.guard.set_policy(&c.owner, &c.agent, &(100 * U7), &10_000u32); // max_exposure = 100
    c.guard.consume(&c.agent, &c.vault, &(100 * U7)); // pos 0→100 == cap → ok
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &U7).is_err()); // 100 + 1 > exposure
}

// ---- %-allocation cap (per-owner, value-weighted) ----
// Two agents, same owner, two vaults. 50% cap. First deposit is sole-asset (exempt),
// the second binds the cap.
#[test]
fn test_alloc_cap_binds_across_two_vaults() {
    let env = Env::default();
    let c = setup(&env); // agent→vaultA already authorized; huge spend cap
    // a second agent for the same owner, scoped to a different vault:
    let agent_b = Address::generate(&env);
    let vault_b = Address::generate(&env);
    c.reg.authorize(&c.owner, &agent_b, &vault_b, &c.token, &(1_000_000 * U7), &86_400u64, &4_000_000_000u64);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &5_000u32);  // 50%
    c.guard.set_policy(&c.owner, &agent_b, &(1_000_000 * U7), &5_000u32);

    // sole asset → exempt even though it is 100% of the portfolio:
    c.guard.consume(&c.agent, &c.vault, &(100 * U7));
    // vault_b now 50% exactly → ok:
    c.guard.consume(&agent_b, &vault_b, &(100 * U7));
    assert_eq!(c.guard.position_of(&agent_b, &vault_b), 100 * U7);
    // one more unit into vault_b → 100.0000001 / 200.0000001 > 50% → reverts:
    assert!(c.guard.try_consume(&agent_b, &vault_b, &1i128).is_err());
}

// ---- fail-closed gates ----
#[test]
fn test_consume_reverts_when_revoked() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.reg.revoke(&c.owner, &c.agent);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // Revoked
}

#[test]
fn test_consume_reverts_when_expired() {
    let env = Env::default();
    let c = setup_with_cap(&env, 1_000_000 * U7, 86_400, 50); // expiry = ledger time 50
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    env.ledger().with_mut(|l| l.timestamp = 100); // now >= expiry
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // Expired
}

#[test]
fn test_consume_reverts_on_wrong_vault() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    let other_vault = Address::generate(&env);
    assert!(c.guard.try_consume(&c.agent, &other_vault, &(10 * U7)).is_err()); // WrongVault
}

#[test]
fn test_consume_reverts_when_policy_not_set() {
    let env = Env::default();
    let c = setup(&env); // authorized in registry but NO guardrail policy
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err()); // PolicyNotSet
}

#[test]
fn test_consume_rejects_zero_amount() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    assert!(c.guard.try_consume(&c.agent, &c.vault, &0i128).is_err());
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(-1i128)).is_err());
}

#[test]
fn test_consume_requires_vault_invoker_auth() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    env.set_auths(&[]); // no signatures → vault.require_auth() fails first
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(10 * U7)).is_err());
}

#[test]
fn test_consume_overflow_guarded() {
    let env = Env::default();
    let c = setup_with_cap(&env, i128::MAX, 86_400, 4_000_000_000);
    c.guard.set_policy(&c.owner, &c.agent, &i128::MAX, &10_000u32);
    // amount * nav (1e7) overflows i128 in the alloc valuation → MathOverflow, not a panic.
    assert!(c.guard.try_consume(&c.agent, &c.vault, &(i128::MAX / 2)).is_err());
}

#[test]
fn test_release_decrements_position_and_total() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(100 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);

    c.guard.release(&c.agent, &c.vault, &(30 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 70 * U7);
    // total_value also drops by 30 * nav → re-deposit of 30 succeeds within the same caps:
    c.guard.consume(&c.agent, &c.vault, &(30 * U7));
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 100 * U7);
}

#[test]
fn test_release_saturates_at_zero() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(70 * U7));
    c.guard.release(&c.agent, &c.vault, &(1_000 * U7)); // over-release → floors at 0
    assert_eq!(c.guard.position_of(&c.agent, &c.vault), 0);
    assert_eq!(c.guard.total_value_of(&c.agent), 0);
}

#[test]
fn test_release_requires_vault_invoker_auth() {
    let env = Env::default();
    let c = setup(&env);
    c.guard.set_policy(&c.owner, &c.agent, &(1_000_000 * U7), &10_000u32);
    c.guard.consume(&c.agent, &c.vault, &(50 * U7));
    env.set_auths(&[]);
    assert!(c.guard.try_release(&c.agent, &c.vault, &(10 * U7)).is_err());
}

#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{vec, Address, BytesN, Env, IntoVal};

use crate::types::{AgentInit, AgentScope};
use crate::{FundingRouter, FundingRouterClient};

// The REAL agent_account wasm (built by `stellar contract build`), imported as
// wasm bytes — not as a crate dep — to avoid the sibling `__constructor` link
// collision and to prove the factory deploys the actual production artifact.
mod agentwasm {
    // The generated bindings for agent_account's CustomAccountInterface
    // (__check_auth) reference `Context` unqualified.
    use soroban_sdk::auth::Context;

    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/agent_account.wasm"
    );
}

struct Setup {
    env: Env,
    token: Address,
    router: Address,
    wasm_hash: BytesN<32>,
    vault: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let wasm_hash = env.deployer().upload_contract_wasm(agentwasm::WASM);
    let router = env.register(FundingRouter, (wasm_hash.clone(), token.clone()));
    let vault = Address::generate(&env);
    Setup {
        env,
        token,
        router,
        wasm_hash,
        vault,
    }
}

/// One AgentInit with a deterministic signer/salt derived from `seed`.
fn agent_init(env: &Env, vault: &Address, seed: u8, cap: i128) -> AgentInit {
    AgentInit {
        signer: BytesN::from_array(env, &[seed; 32]),
        salt: BytesN::from_array(env, &[seed.wrapping_add(100); 32]),
        cap,
        vault: vault.clone(),
        period_duration: 3_600,
        expiry: env.ledger().timestamp() + 86_400,
    }
}

fn mint(s: &Setup, to: &Address, amount: i128) {
    StellarAssetClient::new(&s.env, &s.token).mint(to, &amount);
}

// --- 1. grant deploys N agents, records owners, allowance == budget ---
#[test]
fn grant_deploys_agents_records_owner_and_approves_budget() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![
        &s.env,
        agent_init(&s.env, &s.vault, 1, 40_000_000),
        agent_init(&s.env, &s.vault, 2, 60_000_000),
        agent_init(&s.env, &s.vault, 3, 25_000_000),
    ];

    let agents = client.grant(&owner, &100_000_000, &1_000, &inits);

    assert_eq!(agents.len(), 3);
    for (i, agent) in agents.iter().enumerate() {
        assert_eq!(client.owner_of(&agent), Some(owner.clone()));
        // The REAL agent wasm was deployed with our constructor args.
        let ac = agentwasm::Client::new(&s.env, &agent);
        assert_eq!(ac.signer(), inits.get(i as u32).unwrap().signer);
        let scope = ac.scope_of();
        assert_eq!(scope.owner, owner);
        assert_eq!(scope.cap_per_period, inits.get(i as u32).unwrap().cap);
    }
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.allowance(&owner, &s.router), 100_000_000);
    assert_eq!(t.balance(&s.router), 0); // zero custody
    assert_eq!(client.config(), (s.wasm_hash.clone(), s.token.clone()));
    assert_eq!(client.owner_of(&Address::generate(&s.env)), None);
}

// --- 2. pull by a factory-deployed agent moves owner -> agent within allowance ---
#[test]
fn pull_moves_funds_owner_to_agent_within_allowance() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let agents = client.grant(
        &owner,
        &100_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );
    let agent = agents.get(0).unwrap();

    client.pull(&agent, &30_000_000);

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 30_000_000);
    assert_eq!(t.balance(&owner), 470_000_000);
    assert_eq!(t.allowance(&owner, &s.router), 70_000_000); // allowance consumed
    assert_eq!(t.balance(&s.router), 0);
}

// --- 3. fake agent (not factory-deployed) can never pull — the attack from the plan ---
#[test]
fn pull_rejects_agent_not_deployed_by_factory() {
    let s = setup();
    s.env.mock_all_auths();
    let victim = Address::generate(&s.env);
    mint(&s, &victim, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    // Victim has a real grant outstanding (allowance exists to steal from).
    client.grant(
        &victim,
        &100_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );

    // Attacker deploys the SAME agent code OUTSIDE the factory, claiming the
    // victim as owner in its scope — and even claiming the REAL router as its
    // deployer (4th ctor arg). Neither helps: `pull` gates on the router's own
    // Deployed map, which only the factory writes.
    let scope = AgentScope {
        owner: victim.clone(),
        vault: s.vault.clone(),
        token: s.token.clone(),
        cap_per_period: 100_000_000,
        period_duration: 3_600,
        spent_in_period: 0,
        period_start: 0,
        expiry: s.env.ledger().timestamp() + 86_400,
        revoked: false,
    };
    let fake = s.env.register(
        agentwasm::WASM,
        (
            victim.clone(),
            BytesN::from_array(&s.env, &[9u8; 32]),
            scope,
            Some(s.router.clone()),
        ),
    );

    // Even fully authorized (mock_all_auths), the router refuses: the fake
    // agent is not in the Deployed map. Storage gate, not auth gate.
    assert!(client.try_pull(&fake, &1_000_000).is_err());
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&fake), 0);
    assert_eq!(client.owner_of(&fake), None);
}

// --- 4. pull beyond remaining allowance fails at the token level ---
#[test]
fn pull_beyond_allowance_fails_at_token_level() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let agents = client.grant(
        &owner,
        &50_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );
    let agent = agents.get(0).unwrap();

    client.pull(&agent, &40_000_000); // within budget
    assert!(client.try_pull(&agent, &20_000_000).is_err()); // 40 + 20 > 50

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 40_000_000); // failed pull moved nothing
    assert_eq!(t.allowance(&owner, &s.router), 10_000_000);
}

// --- 5. allowance expiry: past expiry_ledger the budget is dead ---
#[test]
fn pull_after_expiry_ledger_fails() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().with_mut(|li| li.sequence_number = 100);
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let agents = client.grant(
        &owner,
        &100_000_000,
        &300, // allowance dies at ledger 300
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );
    let agent = agents.get(0).unwrap();
    client.pull(&agent, &10_000_000); // live before expiry

    s.env.ledger().with_mut(|li| li.sequence_number = 500);

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.allowance(&owner, &s.router), 0); // expired
    assert!(client.try_pull(&agent, &10_000_000).is_err());
    assert_eq!(t.balance(&agent), 10_000_000); // unchanged
}

// --- 6. re-grant REPLACES the allowance (and can deploy more agents, fresh salts) ---
#[test]
fn regrant_replaces_allowance() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let first = client.grant(
        &owner,
        &100_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );

    let second = client.grant(
        &owner,
        &40_000_000,
        &2_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 2, 40_000_000)],
    );

    // Replaced, not summed.
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.allowance(&owner, &s.router), 40_000_000);
    // Both generations of agents stay registered to the owner.
    assert_eq!(client.owner_of(&first.get(0).unwrap()), Some(owner.clone()));
    assert_eq!(client.owner_of(&second.get(0).unwrap()), Some(owner));
}

// --- 7. zero custody: the router never holds tokens at any step ---
#[test]
fn router_never_holds_tokens() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&s.router), 0);

    let agents = client.grant(
        &owner,
        &100_000_000,
        &1_000,
        &vec![
            &s.env,
            agent_init(&s.env, &s.vault, 1, 50_000_000),
            agent_init(&s.env, &s.vault, 2, 50_000_000),
        ],
    );
    assert_eq!(t.balance(&s.router), 0);

    client.pull(&agents.get(0).unwrap(), &50_000_000);
    assert_eq!(t.balance(&s.router), 0);
    client.pull(&agents.get(1).unwrap(), &50_000_000);
    assert_eq!(t.balance(&s.router), 0);

    // Everything the owner spent sits in the agents, nothing in the router.
    assert_eq!(t.balance(&owner), 400_000_000);
}

// --- security: REAL auth. One owner entry whose tree covers the nested approve ---
#[test]
fn grant_auth_tree_covers_nested_approve_single_entry() {
    let s = setup();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;

    // Exactly ONE auth entry for the owner — router.grant with the nested
    // token.approve as a sub-invocation. This is the "one popup" auth tree.
    s.env.mock_auths(&[MockAuth {
        address: &owner,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), budget, expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "approve",
                args: (owner.clone(), s.router.clone(), budget, expiry).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);

    let agents = client.grant(&owner, &budget, &expiry, &inits);

    assert_eq!(agents.len(), 1);
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.allowance(&owner, &s.router), budget);
}

// --- security: REAL auth. grant without the owner's signature is rejected ---
#[test]
fn grant_without_owner_auth_fails() {
    let s = setup();
    let owner = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;

    // Only the stranger authorizes — owner.require_auth() must fail.
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), budget, expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "approve",
                args: (owner.clone(), s.router.clone(), budget, expiry).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);

    assert!(client.try_grant(&owner, &budget, &expiry, &inits).is_err());
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        0
    );
}

// --- security: REAL auth. An owner entry that omits the nested approve is not enough ---
#[test]
fn grant_fails_if_entry_omits_nested_approve() {
    let s = setup();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;

    // Owner signs grant but the entry does NOT cover token.approve — the
    // nested call must then fail its own require_auth. Proves the approve is
    // genuinely auth-gated under the same tree the popup signs.
    s.env.mock_auths(&[MockAuth {
        address: &owner,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), budget, expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    assert!(client.try_grant(&owner, &budget, &expiry, &inits).is_err());
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        0
    );
}

// --- security: REAL auth. pull demands the agent's own authorization ---
#[test]
fn pull_requires_agent_auth() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let agents = client.grant(
        &owner,
        &100_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );
    let agent = agents.get(0).unwrap();
    let t = TokenClient::new(&s.env, &s.token);

    // (1) Nobody authorizes -> rejected.
    s.env.mock_auths(&[]);
    assert!(client.try_pull(&agent, &1_000_000).is_err());

    // (2) A stranger authorizes instead of the agent -> rejected.
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "pull",
            args: (agent.clone(), 1_000_000i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_pull(&agent, &1_000_000).is_err());
    assert_eq!(t.balance(&agent), 0);

    // (3) The agent itself authorizes -> funds move.
    s.env.mock_auths(&[MockAuth {
        address: &agent,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "pull",
            args: (agent.clone(), 1_000_000i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    client.pull(&agent, &1_000_000);
    assert_eq!(t.balance(&agent), 1_000_000);
}

// --- one-popup e2e: grant wires THIS router into the agent, whose session-key auth
// (enforce() pull@router rule, exercised in agent_account's suite) lets it fund itself.
// Here: grant with the REAL rebuilt wasm -> the agent records the router -> the agent
// authorizes `pull` -> funds move owner -> agent. ---
#[test]
fn grant_wires_router_into_agent_and_agent_authed_pull_funds_it() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);

    let agents = client.grant(
        &owner,
        &100_000_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)],
    );
    let agent = agents.get(0).unwrap();

    // The deployed agent (REAL wasm) recorded THIS router as its deployer —
    // its __check_auth therefore accepts a session-key-signed pull@router.
    let ac = agentwasm::Client::new(&s.env, &agent);
    assert_eq!(ac.router(), Some(s.router.clone()));

    // The agent (and only the agent) authorizes the pull; funds move owner -> agent.
    s.env.mock_auths(&[MockAuth {
        address: &agent,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "pull",
            args: (agent.clone(), 25_000_000i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    client.pull(&agent, &25_000_000);

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 25_000_000);
    assert_eq!(t.balance(&owner), 475_000_000);
    assert_eq!(t.balance(&s.router), 0); // still zero custody
}

// --- grant validation: garbage inits are rejected BEFORE approval/deployment ---

#[test]
fn grant_rejects_empty_agent_list() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let empty: soroban_sdk::Vec<AgentInit> = vec![&s.env];

    assert!(client.try_grant(&owner, &1_000, &1_000, &empty).is_err());
    // Rejected before the nested approve — no allowance side effect survives.
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        0
    );
}

#[test]
fn grant_rejects_expired_allowance_ledger() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().with_mut(|li| li.sequence_number = 500);
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, agent_init(&s.env, &s.vault, 1, 1_000)];

    // An allowance that dies at/before the current ledger could never be pulled.
    assert!(client.try_grant(&owner, &1_000, &500, &inits).is_err());
    assert!(client.try_grant(&owner, &1_000, &100, &inits).is_err());
}

#[test]
fn grant_rejects_zero_period_duration() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let mut bad = agent_init(&s.env, &s.vault, 1, 1_000);
    bad.period_duration = 0;

    assert!(client
        .try_grant(&owner, &1_000, &1_000, &vec![&s.env, bad])
        .is_err());
}

#[test]
fn grant_rejects_past_agent_expiry() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(1_000_000);
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);

    let mut at_now = agent_init(&s.env, &s.vault, 1, 1_000);
    at_now.expiry = 1_000_000; // == now: already dead
    assert!(client
        .try_grant(&owner, &1_000, &2_000_000, &vec![&s.env, at_now])
        .is_err());

    let mut past = agent_init(&s.env, &s.vault, 2, 1_000);
    past.expiry = 999_999; // < now
    assert!(client
        .try_grant(&owner, &1_000, &2_000_000, &vec![&s.env, past])
        .is_err());
}

// --- owner-bound deployment salt: no cross-owner salt squatting ---

#[test]
fn same_raw_salt_from_two_owners_yields_distinct_agents() {
    let s = setup();
    s.env.mock_all_auths();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);

    // Identical raw salt (seed 1) from two different owners. Pre-hardening the
    // second deploy would collide on the same derived address and trap.
    let a = client.grant(
        &alice,
        &1_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 1_000)],
    );
    let b = client.grant(
        &bob,
        &1_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 1_000)],
    );

    assert_ne!(a.get(0).unwrap(), b.get(0).unwrap());
    assert_eq!(client.owner_of(&a.get(0).unwrap()), Some(alice));
    assert_eq!(client.owner_of(&b.get(0).unwrap()), Some(bob));
}

#[test]
fn same_owner_same_raw_salt_stays_deterministic() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);

    client.grant(
        &owner,
        &1_000,
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.vault, 1, 1_000)],
    );
    // Same owner + same raw salt derives the SAME address — the second deploy
    // collides and fails, proving the derivation is deterministic per owner.
    assert!(client
        .try_grant(
            &owner,
            &1_000,
            &1_000,
            &vec![&s.env, agent_init(&s.env, &s.vault, 1, 1_000)],
        )
        .is_err());
}

// --- input validation: non-positive amounts are rejected everywhere ---
#[test]
fn rejects_non_positive_amounts() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, agent_init(&s.env, &s.vault, 1, 100_000_000)];

    assert!(client.try_grant(&owner, &0, &1_000, &inits).is_err());
    assert!(client.try_grant(&owner, &-1, &1_000, &inits).is_err());
    // cap <= 0 in an AgentInit is rejected too.
    let bad = vec![&s.env, agent_init(&s.env, &s.vault, 2, 0)];
    assert!(client.try_grant(&owner, &1_000, &1_000, &bad).is_err());

    let agents = client.grant(&owner, &100_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    assert!(client.try_pull(&agent, &0).is_err());
    assert!(client.try_pull(&agent, &-5).is_err());
}

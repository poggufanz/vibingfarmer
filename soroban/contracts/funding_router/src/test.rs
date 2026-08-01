#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::xdr::WriteXdr;
use soroban_sdk::{vec, xdr, Address, Bytes, BytesN, Env, Error, IntoVal, Vec};

use crate::types::{AgentInit, AgentScope, DataKey, PermissionGrantV3, RouterError, TokenBudget};
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
    let router = env.register(FundingRouter, (wasm_hash.clone(),));
    let vault = Address::generate(&env);
    Setup {
        env,
        token,
        router,
        wasm_hash,
        vault,
    }
}

/// One deposit-kind (kind 0) `AgentInit` with a deterministic signer/salt
/// derived from `seed`. `token` must be present in the grant's `budgets`.
/// Bridge-kind (kind 1) tests start from this and overwrite `kind`,
/// `mint_recipient`, `destination_domain`.
fn agent_init(env: &Env, token: &Address, target: &Address, seed: u8, cap: i128) -> AgentInit {
    AgentInit {
        signer: BytesN::from_array(env, &[seed; 32]),
        salt: BytesN::from_array(env, &[seed.wrapping_add(100); 32]),
        cap,
        token: token.clone(),
        target: target.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(env, &[0u8; 32]),
        destination_domain: 0,
        period_duration: 3_600,
        expiry: env.ledger().timestamp() + 86_400,
    }
}

/// A single-entry `budgets` vec covering `token` for `amount`.
fn budgets(env: &Env, token: &Address, amount: i128) -> Vec<TokenBudget> {
    vec![
        env,
        TokenBudget {
            budget: amount,
            token: token.clone(),
        },
    ]
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
        agent_init(&s.env, &s.token, &s.vault, 1, 40_000_000),
        agent_init(&s.env, &s.token, &s.vault, 2, 60_000_000),
        agent_init(&s.env, &s.token, &s.vault, 3, 25_000_000),
    ];

    let agents = client.grant(
        &owner,
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &inits,
    );

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
    assert_eq!(client.config(), s.wasm_hash.clone());
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
    );

    // Attacker deploys the SAME agent code OUTSIDE the factory, claiming the
    // victim as owner in its scope — and even claiming the REAL router as its
    // deployer (4th ctor arg). Neither helps: `pull` gates on the router's own
    // Deployed map, which only the factory writes.
    let scope = AgentScope {
        owner: victim.clone(),
        target: s.vault.clone(),
        token: s.token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&s.env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: 100_000_000,
        period_duration: 3_600,
        spent_in_period: 0,
        period_start: 0,
        expiry: s.env.ledger().timestamp() + 86_400,
        revoked: false,
        per_execution_max: 100_000_000,
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
        &budgets(&s.env, &s.token, 50_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
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
        &budgets(&s.env, &s.token, 100_000_000),
        &300, // allowance dies at ledger 300
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
    );

    let second = client.grant(
        &owner,
        &budgets(&s.env, &s.token, 40_000_000),
        &2_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 2, 40_000_000)],
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![
            &s.env,
            agent_init(&s.env, &s.token, &s.vault, 1, 50_000_000),
            agent_init(&s.env, &s.token, &s.vault, 2, 50_000_000),
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
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;
    let grant_budgets = budgets(&s.env, &s.token, budget);

    // Exactly ONE auth entry for the owner — router.grant with the nested
    // token.approve as a sub-invocation. This is the "one popup" auth tree.
    s.env.mock_auths(&[MockAuth {
        address: &owner,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), grant_budgets.clone(), expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "approve",
                args: (owner.clone(), s.router.clone(), budget, expiry).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);

    let agents = client.grant(&owner, &grant_budgets, &expiry, &inits);

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
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;
    let grant_budgets = budgets(&s.env, &s.token, budget);

    // Only the stranger authorizes — owner.require_auth() must fail.
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), grant_budgets.clone(), expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "approve",
                args: (owner.clone(), s.router.clone(), budget, expiry).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);

    assert!(client
        .try_grant(&owner, &grant_budgets, &expiry, &inits)
        .is_err());
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
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let budget = 100_000_000i128;
    let expiry = 1_000u32;
    let grant_budgets = budgets(&s.env, &s.token, budget);

    // Owner signs grant but the entry does NOT cover token.approve — the
    // nested call must then fail its own require_auth. Proves the approve is
    // genuinely auth-gated under the same tree the popup signs.
    s.env.mock_auths(&[MockAuth {
        address: &owner,
        invoke: &MockAuthInvoke {
            contract: &s.router,
            fn_name: "grant",
            args: (owner.clone(), grant_budgets.clone(), expiry, inits.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    assert!(client
        .try_grant(&owner, &grant_budgets, &expiry, &inits)
        .is_err());
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
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
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
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
    let empty: Vec<AgentInit> = vec![&s.env];

    assert!(client
        .try_grant(&owner, &budgets(&s.env, &s.token, 1_000), &1_000, &empty)
        .is_err());
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
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)];
    let grant_budgets = budgets(&s.env, &s.token, 1_000);

    // An allowance that dies at/before the current ledger could never be pulled.
    assert!(client
        .try_grant(&owner, &grant_budgets, &500, &inits)
        .is_err());
    assert!(client
        .try_grant(&owner, &grant_budgets, &100, &inits)
        .is_err());
}

#[test]
fn grant_rejects_zero_period_duration() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let mut bad = agent_init(&s.env, &s.token, &s.vault, 1, 1_000);
    bad.period_duration = 0;

    assert!(client
        .try_grant(
            &owner,
            &budgets(&s.env, &s.token, 1_000),
            &1_000,
            &vec![&s.env, bad]
        )
        .is_err());
}

#[test]
fn grant_rejects_past_agent_expiry() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().set_timestamp(1_000_000);
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let grant_budgets = budgets(&s.env, &s.token, 1_000);

    let mut at_now = agent_init(&s.env, &s.token, &s.vault, 1, 1_000);
    at_now.expiry = 1_000_000; // == now: already dead
    assert!(client
        .try_grant(&owner, &grant_budgets, &2_000_000, &vec![&s.env, at_now])
        .is_err());

    let mut past = agent_init(&s.env, &s.token, &s.vault, 2, 1_000);
    past.expiry = 999_999; // < now
    assert!(client
        .try_grant(&owner, &grant_budgets, &2_000_000, &vec![&s.env, past])
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
        &budgets(&s.env, &s.token, 1_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)],
    );
    let b = client.grant(
        &bob,
        &budgets(&s.env, &s.token, 1_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)],
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
        &budgets(&s.env, &s.token, 1_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)],
    );
    // Same owner + same raw salt derives the SAME address — the second deploy
    // collides and fails, proving the derivation is deterministic per owner.
    assert!(client
        .try_grant(
            &owner,
            &budgets(&s.env, &s.token, 1_000),
            &1_000,
            &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)],
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
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];

    assert!(client
        .try_grant(&owner, &budgets(&s.env, &s.token, 0), &1_000, &inits)
        .is_err());
    assert!(client
        .try_grant(&owner, &budgets(&s.env, &s.token, -1), &1_000, &inits)
        .is_err());
    // cap <= 0 in an AgentInit is rejected too.
    let bad = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 2, 0)];
    assert!(client
        .try_grant(&owner, &budgets(&s.env, &s.token, 1_000), &1_000, &bad)
        .is_err());

    let agents = client.grant(
        &owner,
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &inits,
    );
    let agent = agents.get(0).unwrap();
    assert!(client.try_pull(&agent, &0).is_err());
    assert!(client.try_pull(&agent, &-5).is_err());
}

// --- v2: multi-token budgets + bridge-kind agents ---

// --- new: one grant, two tokens, one deposit agent + one bridge agent ---
#[test]
fn grant_multi_token_approves_each_and_deploys_bridge_agent() {
    let s = setup();
    s.env.mock_all_auths();
    let circle_admin = Address::generate(&s.env);
    let circle_token = s
        .env
        .register_stellar_asset_contract_v2(circle_admin)
        .address();
    let messenger = Address::generate(&s.env); // dummy TokenMessengerMinter target
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);

    let grant_budgets = vec![
        &s.env,
        TokenBudget {
            budget: 1_000,
            token: s.token.clone(),
        },
        TokenBudget {
            budget: 300,
            token: circle_token.clone(),
        },
    ];
    let deposit_init = agent_init(&s.env, &s.token, &s.vault, 1, 1_000);
    let mut bridge_init = agent_init(&s.env, &circle_token, &messenger, 2, 300);
    bridge_init.kind = 1;
    bridge_init.mint_recipient = BytesN::from_array(&s.env, &[7u8; 32]);
    bridge_init.destination_domain = 6;
    let inits = vec![&s.env, deposit_init, bridge_init];

    let agents = client.grant(&owner, &grant_budgets, &1_000, &inits);

    assert_eq!(agents.len(), 2);
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        1_000
    );
    assert_eq!(
        TokenClient::new(&s.env, &circle_token).allowance(&owner, &s.router),
        300
    );

    let bridge_agent = agents.get(1).unwrap();
    let ac = agentwasm::Client::new(&s.env, &bridge_agent);
    let scope = ac.scope_of();
    assert_eq!(scope.kind, 1);
    assert_eq!(scope.target, messenger);
    assert_eq!(scope.mint_recipient, BytesN::from_array(&s.env, &[7u8; 32]));
}

// --- new: an agent's token must be covered by some budget entry ---
#[test]
fn grant_rejects_agent_token_missing_from_budgets() {
    let s = setup();
    s.env.mock_all_auths();
    let other_admin = Address::generate(&s.env);
    let other_token = s
        .env
        .register_stellar_asset_contract_v2(other_admin)
        .address();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    // Budget only covers s.token; the agent wants other_token.
    let inits = vec![&s.env, agent_init(&s.env, &other_token, &s.vault, 1, 1_000)];

    assert!(client
        .try_grant(&owner, &budgets(&s.env, &s.token, 1_000), &1_000, &inits)
        .is_err());
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        0
    );
}

// --- new: bridge-kind (kind 1) agents need a real mint_recipient AND destination_domain ---
#[test]
fn grant_rejects_bridge_without_recipient_or_domain() {
    let s = setup();
    s.env.mock_all_auths();
    let messenger = Address::generate(&s.env);
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let grant_budgets = budgets(&s.env, &s.token, 1_000);

    // Zero mint_recipient (destination_domain set).
    let mut no_recipient = agent_init(&s.env, &s.token, &messenger, 1, 1_000);
    no_recipient.kind = 1;
    no_recipient.destination_domain = 6;
    assert!(client
        .try_grant(&owner, &grant_budgets, &1_000, &vec![&s.env, no_recipient])
        .is_err());

    // Zero destination_domain (mint_recipient set).
    let mut no_domain = agent_init(&s.env, &s.token, &messenger, 2, 1_000);
    no_domain.kind = 1;
    no_domain.mint_recipient = BytesN::from_array(&s.env, &[7u8; 32]);
    assert!(client
        .try_grant(&owner, &grant_budgets, &1_000, &vec![&s.env, no_domain])
        .is_err());
}

// --- new: two budget entries naming the same token are rejected ---
#[test]
fn grant_rejects_duplicate_budget_token() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let dup_budgets = vec![
        &s.env,
        TokenBudget {
            budget: 1_000,
            token: s.token.clone(),
        },
        TokenBudget {
            budget: 500,
            token: s.token.clone(),
        },
    ];
    let inits = vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 1_000)];

    assert!(client
        .try_grant(&owner, &dup_budgets, &1_000, &inits)
        .is_err());
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        0
    );
}

// --- new: pull moves the SPECIFIC agent's own token, other agents' tokens untouched ---
#[test]
fn pull_uses_per_agent_token() {
    let s = setup();
    s.env.mock_all_auths();
    let circle_admin = Address::generate(&s.env);
    let circle_token = s
        .env
        .register_stellar_asset_contract_v2(circle_admin)
        .address();
    let messenger = Address::generate(&s.env);
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    StellarAssetClient::new(&s.env, &circle_token).mint(&owner, &500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);

    let grant_budgets = vec![
        &s.env,
        TokenBudget {
            budget: 100_000_000,
            token: s.token.clone(),
        },
        TokenBudget {
            budget: 100_000_000,
            token: circle_token.clone(),
        },
    ];
    let deposit_init = agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000);
    let mut bridge_init = agent_init(&s.env, &circle_token, &messenger, 2, 100_000_000);
    bridge_init.kind = 1;
    bridge_init.mint_recipient = BytesN::from_array(&s.env, &[7u8; 32]);
    bridge_init.destination_domain = 6;
    let inits = vec![&s.env, deposit_init, bridge_init];

    let agents = client.grant(&owner, &grant_budgets, &1_000, &inits);
    let bridge_agent = agents.get(1).unwrap();

    client.pull(&bridge_agent, &30_000_000);

    let t_farm = TokenClient::new(&s.env, &s.token);
    let t_circle = TokenClient::new(&s.env, &circle_token);
    assert_eq!(t_circle.balance(&bridge_agent), 30_000_000);
    assert_eq!(t_circle.allowance(&owner, &s.router), 70_000_000);
    assert_eq!(t_farm.balance(&bridge_agent), 0); // untouched — deposit agent's token
    assert_eq!(t_farm.allowance(&owner, &s.router), 100_000_000); // untouched
}

// --- v3 (Task 4): grant()-deployed (V2) agents stay byte-compatible/untouched — unrestricted
// per_execution_max relative to cap_per_period, which was already the hardest single-execution
// ceiling any V2 agent could need. ---
#[test]
fn grant_deploys_v2_agents_with_unrestricted_per_execution_max() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let agents = client.grant(
        &owner,
        &budgets(&s.env, &s.token, 100_000_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 1, 100_000_000)],
    );
    let ac = agentwasm::Client::new(&s.env, &agents.get(0).unwrap());
    assert_eq!(ac.scope_of().per_execution_max, i128::MAX);
}

// ─────────────────────────── V3: bounded, reusable grant (Task 4) ───────────────────────────

/// One `AgentInit` sharing a common (target, kind, mint_recipient, destination_domain) — every
/// agent under one V3 permission must share the same scope fingerprint.
fn v3_init(env: &Env, token: &Address, target: &Address, seed: u8, cap: i128) -> AgentInit {
    agent_init(env, token, target, seed, cap)
}

fn signed_pull_v3_auth(
    env: &Env,
    router: &Address,
    agent: &Address,
    permission_id: &BytesN<32>,
    execution_id: &BytesN<32>,
    amount: i128,
    signature: [u8; 64],
) -> xdr::SorobanAuthorizationEntry {
    let invoke = MockAuthInvoke {
        contract: router,
        fn_name: "pull_v3",
        args: (
            permission_id.clone(),
            execution_id.clone(),
            agent.clone(),
            amount,
        )
            .into_val(env),
        sub_invokes: &[],
    };
    let mut entry: xdr::SorobanAuthorizationEntry = MockAuth {
        address: agent,
        invoke: &invoke,
    }
    .into();
    let xdr::SorobanCredentials::Address(credentials) = &mut entry.credentials else {
        unreachable!()
    };
    credentials.nonce = 777;
    credentials.signature_expiration_ledger = 1_000_000;
    credentials.signature = xdr::ScVal::Bytes(xdr::ScBytes(
        signature.as_slice().try_into().unwrap(),
    ));
    entry
}

fn pull_v3_auth_payload(env: &Env, entry: &xdr::SorobanAuthorizationEntry) -> [u8; 32] {
    let xdr::SorobanCredentials::Address(credentials) = &entry.credentials else {
        unreachable!()
    };
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(
        xdr::HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash([9u8; 32]),
            invocation: entry.root_invocation.clone(),
            nonce: credentials.nonce,
            signature_expiration_ledger: credentials.signature_expiration_ledger,
        },
    );
    let bytes = preimage.to_xdr(xdr::Limits::none()).unwrap();
    env.crypto()
        .sha256(&Bytes::from_slice(env, bytes.as_slice()))
        .to_array()
}

#[test]
fn grant_v3_creates_bounded_reusable_permission_and_links_agents() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];

    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &500_000_000, &200_000_000, &1_000, &inits);

    assert_eq!(agents.len(), 1);
    let grant = client.permission_grant(&permission_id).unwrap();
    assert_eq!(grant.owner, owner);
    assert_eq!(grant.token, s.token);
    assert_eq!(grant.mandate_ceiling, 500_000_000);
    assert_eq!(grant.confirmed_spent, 0);
    assert_eq!(grant.per_run_max, 200_000_000);
    assert_eq!(grant.live_until_ledger, 1_000);
    assert!(!grant.revoked);
    assert_eq!(client.remaining_budget(&permission_id), 500_000_000);

    // The deployed agent got the whole ceiling as its per_execution_max (only one agent).
    let ac = agentwasm::Client::new(&s.env, &agents.get(0).unwrap());
    assert_eq!(ac.scope_of().per_execution_max, 500_000_000);
    // Approve nested under the owner's single auth entry — one SEP-41 allowance for the whole
    // permission's lifetime.
    assert_eq!(
        TokenClient::new(&s.env, &s.token).allowance(&owner, &s.router),
        500_000_000
    );
}

#[test]
fn grant_v3_splits_ceiling_across_agents_without_rounding_above_total() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![
        &s.env,
        v3_init(&s.env, &s.token, &s.vault, 1, 1_000),
        v3_init(&s.env, &s.token, &s.vault, 2, 1_000),
        v3_init(&s.env, &s.token, &s.vault, 3, 1_000),
    ];

    // 100 / 3 = 33.33 — floor division means each agent gets 33, and the aggregate (99) never
    // rounds ABOVE the 100 ceiling; the remainder (1) is simply unallocated.
    let (_permission_id, agents) = client.grant_v3(&owner, &s.token, &100, &100, &1_000, &inits);

    let mut total = 0i128;
    for agent in agents.iter() {
        let per_execution_max = agentwasm::Client::new(&s.env, &agent).scope_of().per_execution_max;
        assert_eq!(per_execution_max, 33);
        total += per_execution_max;
    }
    assert!(total <= 100);
}

// Split from a single combined test: the "ceiling <= 0" and "per_run_max <= 0" cases must each
// choose the OTHER value so `per_run_max > mandate_ceiling` (the separate "ceiling below
// planned" guard) can never independently catch them too — otherwise the assertion holds even
// with the non-positive-amount check deleted, which is exactly what the earlier version of this
// test missed (review finding: 2 of its 4 sub-cases were masked by the ordering guard).
#[test]
fn grant_v3_rejects_non_positive_mandate_ceiling() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 1_000)];

    // per_run_max <= mandate_ceiling in both cases (both strictly negative, run_max the MORE
    // negative one) so `per_run_max > mandate_ceiling` is false and cannot mask this check.
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &-100, &-150, &1_000, &inits),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &-50, &-9_999, &1_000, &inits),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
}

#[test]
fn grant_v3_rejects_non_positive_per_run_max() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 1_000)];

    // mandate_ceiling stays comfortably positive (1_000) so `per_run_max > mandate_ceiling` is
    // false for both non-positive run_max values and cannot mask this check either.
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &1_000, &0, &1_000, &inits),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &1_000, &-1, &1_000, &inits),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
}

#[test]
fn grant_v3_rejects_ceiling_below_planned() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 1_000)];

    // per_run_max (600) bigger than mandate_ceiling (500) — a single run could never fit within
    // the lifetime ceiling it was planned against. Both values are positive, so the non-positive
    // check above can never independently catch this case.
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &500, &600, &1_000, &inits),
        Err(Ok(Error::from(RouterError::CeilingBelowPlanned)))
    );
}

#[test]
fn grant_v3_rejects_expired_live_until_ledger() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().with_mut(|li| li.sequence_number = 500);
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 1_000)];

    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &1_000, &500, &500, &inits),
        Err(Ok(Error::from(RouterError::InvalidExpiry)))
    );
    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &1_000, &500, &100, &inits),
        Err(Ok(Error::from(RouterError::InvalidExpiry)))
    );
}

// --- Finding 3 (review round 1): real, non-corrupted "wrong token"/"wrong scope" coverage ---

#[test]
fn grant_v3_rejects_agent_token_mismatch() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let other_admin = Address::generate(&s.env);
    let other_token = s
        .env
        .register_stellar_asset_contract_v2(other_admin)
        .address();
    let client = FundingRouterClient::new(&s.env, &s.router);
    // The permission's token is s.token, but this AgentInit names a DIFFERENT token.
    let inits = vec![&s.env, v3_init(&s.env, &other_token, &s.vault, 1, 1_000)];

    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &1_000, &500, &1_000, &inits),
        Err(Ok(Error::from(RouterError::TokenNotBudgeted)))
    );
}

#[test]
fn grant_v3_rejects_agents_with_divergent_scope() {
    // A REAL (non-corrupted) way to hit ScopeMismatchV3: two agents in the SAME grant_v3 call
    // whose (target, kind, mint_recipient, destination_domain) differ — every agent under one
    // permission must share one scope fingerprint. Caught at GRANT time, before any deploy.
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let other_target = Address::generate(&s.env); // a genuinely different vault/target
    let client = FundingRouterClient::new(&s.env, &s.router);
    let first = v3_init(&s.env, &s.token, &s.vault, 1, 1_000);
    let mut second = v3_init(&s.env, &s.token, &s.vault, 2, 1_000);
    second.target = other_target;

    assert_eq!(
        client.try_grant_v3(&owner, &s.token, &2_000, &1_000, &1_000, &vec![&s.env, first, second]),
        Err(Ok(Error::from(RouterError::ScopeMismatchV3)))
    );
}

#[test]
fn pull_v3_moves_funds_and_tracks_confirmed_spent() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[1u8; 32]);

    client.pull_v3(&permission_id, &execution_id, &agent, &120_000_000);

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 120_000_000);
    assert_eq!(t.balance(&owner), 380_000_000);
    assert_eq!(client.permission_grant(&permission_id).unwrap().confirmed_spent, 120_000_000);
    assert_eq!(client.remaining_budget(&permission_id), 180_000_000);
}

#[test]
fn pull_v3_uses_the_deployed_agent_accounts_real_custom_auth() {
    let s = setup();
    s.env.ledger().set_network_id([9u8; 32]);
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let mut init = v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000);
    init.signer = BytesN::from_array(
        &s.env,
        &[
            0x19, 0x7f, 0x6b, 0x23, 0xe1, 0x6c, 0x85, 0x32, 0xc6, 0xab, 0xc8, 0x38, 0xfa,
            0xcd, 0x5e, 0xa7, 0x89, 0xbe, 0x0c, 0x76, 0xb2, 0x92, 0x03, 0x34, 0x03, 0x9b,
            0xfa, 0x8b, 0x3d, 0x36, 0x8d, 0x61,
        ],
    );
    let (permission_id, agents) = client.grant_v3(
        &owner,
        &s.token,
        &300_000_000,
        &200_000_000,
        &1_000,
        &vec![&s.env, init],
    );
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[0x44u8; 32]);
    let auth = signed_pull_v3_auth(
        &s.env,
        &s.router,
        &agent,
        &permission_id,
        &execution_id,
        120_000_000,
        [
            199, 6, 121, 41, 99, 180, 109, 194, 3, 62, 46, 67, 91, 169, 89, 78, 94, 97,
            76, 100, 211, 107, 17, 197, 12, 200, 129, 78, 173, 183, 115, 19, 11, 168,
            222, 223, 142, 85, 104, 84, 234, 11, 40, 59, 112, 247, 4, 22, 120, 100, 223,
            139, 100, 80, 59, 56, 165, 26, 134, 220, 32, 209, 237, 5,
        ],
    );
    assert_eq!(
        pull_v3_auth_payload(&s.env, &auth),
        [
            238, 28, 120, 189, 67, 214, 39, 122, 52, 120, 242, 239, 145, 61, 148, 154,
            243, 177, 132, 195, 29, 9, 240, 40, 102, 196, 199, 255, 219, 39, 209, 116,
        ]
    );

    // Arrangement used mocked owner/admin auth. The action below explicitly disables all mocks:
    // the deployed AgentAccount WASM must verify this ed25519 signature and accept pull_v3.
    s.env.set_auths(&[auth]);
    client.pull_v3(&permission_id, &execution_id, &agent, &120_000_000);

    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 120_000_000);
}

#[test]
fn pull_v3_rejects_unlinked_agent() {
    // The REAL (non-corrupted) "wrong agent" attack shape: two genuine permissions, and a pull
    // naming an agent that legitimately belongs to the OTHER one.
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits_a = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_a, _) = client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits_a);
    let inits_b = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 2, 100_000_000)];
    let (_permission_b, agents_b) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits_b);
    let execution_id = BytesN::from_array(&s.env, &[2u8; 32]);

    // A totally unknown address.
    assert_eq!(
        client.try_pull_v3(&permission_a, &execution_id, &Address::generate(&s.env), &1_000),
        Err(Ok(Error::from(RouterError::UnknownAgent)))
    );
    // An agent that IS linked — but to a DIFFERENT permission.
    assert_eq!(
        client.try_pull_v3(&permission_a, &execution_id, &agents_b.get(0).unwrap(), &1_000),
        Err(Ok(Error::from(RouterError::UnknownAgent)))
    );
}

#[test]
fn pull_v3_rejects_scope_drift_from_recorded_fingerprint() {
    // Defense-in-depth only: agent_account has no mutator for target/token/kind, and grant_v3
    // itself validates every agent's scope fingerprint before deploy, so this path is NOT
    // reachable through any real external call today — only by corrupting the router's OWN
    // stored record, as done here. Kept to prove the re-check itself is wired correctly; see
    // `grant_v3_rejects_agents_with_divergent_scope` for the real, non-corrupted "wrong scope"
    // attack shape (Finding 3, review round 1).
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[3u8; 32]);

    s.env.as_contract(&s.router, || {
        let key = DataKey::PermissionV3(permission_id.clone());
        let mut grant: PermissionGrantV3 = s.env.storage().persistent().get(&key).unwrap();
        grant.scope_id = BytesN::from_array(&s.env, &[0xEE; 32]);
        s.env.storage().persistent().set(&key, &grant);
    });

    assert_eq!(
        client.try_pull_v3(&permission_id, &execution_id, &agent, &1_000),
        Err(Ok(Error::from(RouterError::ScopeMismatchV3)))
    );
    // Nothing moved.
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 0);
}

#[test]
fn pull_v3_rejects_amount_above_per_run_max() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &150_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[4u8; 32]);

    // 200,000,000 is comfortably under the 300,000,000 mandate_ceiling but strictly above the
    // 150,000,000 per_run_max.
    assert_eq!(
        client.try_pull_v3(&permission_id, &execution_id, &agent, &200_000_000),
        Err(Ok(Error::from(RouterError::PerRunExceededV3)))
    );
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 0);
    assert_eq!(client.permission_grant(&permission_id).unwrap().confirmed_spent, 0);
}

#[test]
fn pull_v3_rejects_cumulative_overflow_across_two_pulls() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 300_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();

    // Review finding 1 (round 1): grant_v3 only ever approves an allowance == mandate_ceiling, so
    // the ORIGINAL version of this test could never tell "the router's own cumulative check
    // fired" apart from "the SEP-41 allowance ran out" — both would reject the second pull. Make
    // the allowance STRICTLY LARGER than the ceiling so the allowance can never be the blocker;
    // only `confirmed_spent + amount > mandate_ceiling` can.
    TokenClient::new(&s.env, &s.token).approve(&owner, &s.router, &1_000_000_000, &1_000);

    // Two individually-valid (<= per_run_max) pulls whose SUM (350,000,000) exceeds the
    // 300,000,000 mandate_ceiling — no sequence of otherwise-valid pulls can ever overspend it.
    client.pull_v3(&permission_id, &BytesN::from_array(&s.env, &[5u8; 32]), &agent, &180_000_000);
    let res = client.try_pull_v3(
        &permission_id,
        &BytesN::from_array(&s.env, &[6u8; 32]),
        &agent,
        &170_000_000,
    );
    assert_eq!(res, Err(Ok(Error::from(RouterError::CeilingExceededV3))));

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 180_000_000); // only the first pull moved anything
    // Allowance has ample headroom left — proves it was never what stopped the second pull.
    assert_eq!(t.allowance(&owner, &s.router), 1_000_000_000 - 180_000_000);
    assert_eq!(client.permission_grant(&permission_id).unwrap().confirmed_spent, 180_000_000);
}

#[test]
fn pull_v3_rejects_revoked_permission() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();

    client.revoke_v3(&permission_id);
    assert!(client.permission_grant(&permission_id).unwrap().revoked);

    assert_eq!(
        client.try_pull_v3(&permission_id, &BytesN::from_array(&s.env, &[7u8; 32]), &agent, &1_000),
        Err(Ok(Error::from(RouterError::RevokedV3)))
    );
    // Idempotent.
    client.revoke_v3(&permission_id);
    assert!(client.permission_grant(&permission_id).unwrap().revoked);
}

#[test]
fn pull_v3_rejects_after_live_until_ledger() {
    let s = setup();
    s.env.mock_all_auths();
    s.env.ledger().with_mut(|li| li.sequence_number = 100);
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &300, &inits);
    let agent = agents.get(0).unwrap();
    client.pull_v3(&permission_id, &BytesN::from_array(&s.env, &[8u8; 32]), &agent, &10_000_000); // live before expiry

    s.env.ledger().with_mut(|li| li.sequence_number = 500);

    assert_eq!(
        client.try_pull_v3(&permission_id, &BytesN::from_array(&s.env, &[9u8; 32]), &agent, &10_000_000),
        Err(Ok(Error::from(RouterError::ExpiredV3)))
    );
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 10_000_000); // unchanged
}

#[test]
fn pull_v3_rejects_duplicate_execution_id() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 300_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[10u8; 32]);

    client.pull_v3(&permission_id, &execution_id, &agent, &50_000_000);
    // Same execution_id again — even though there is still ceiling headroom.
    assert_eq!(
        client.try_pull_v3(&permission_id, &execution_id, &agent, &50_000_000),
        Err(Ok(Error::from(RouterError::DuplicateExecutionV3)))
    );

    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&agent), 50_000_000); // second pull moved nothing
    assert_eq!(client.permission_grant(&permission_id).unwrap().confirmed_spent, 50_000_000);
}

#[test]
fn pull_v3_rejects_non_positive_amount() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();

    assert_eq!(
        client.try_pull_v3(&permission_id, &BytesN::from_array(&s.env, &[11u8; 32]), &agent, &0),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
    assert_eq!(
        client.try_pull_v3(&permission_id, &BytesN::from_array(&s.env, &[12u8; 32]), &agent, &-5),
        Err(Ok(Error::from(RouterError::InvalidAmount)))
    );
}

#[test]
fn pull_v3_failed_transfer_does_not_advance_spend_or_mark_execution_used() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    mint(&s, &owner, 500_000_000);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 300_000_000)];
    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &300_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();
    let execution_id = BytesN::from_array(&s.env, &[13u8; 32]);

    // Router-side bookkeeping (mandate_ceiling/per_run_max) would happily allow this pull, but
    // the owner separately zeroed the UNDERLYING SEP-41 allowance the transfer_from actually
    // needs — the transfer traps, and the whole invocation (including the spend/replay writes
    // pull_v3 made before calling transfer_from) rolls back with it.
    TokenClient::new(&s.env, &s.token).approve(&owner, &s.router, &0, &1_000);

    assert!(client
        .try_pull_v3(&permission_id, &execution_id, &agent, &50_000_000)
        .is_err());

    assert_eq!(client.permission_grant(&permission_id).unwrap().confirmed_spent, 0);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 0);
    // The execution_id was NOT consumed — a legitimate retry (once the allowance is restored)
    // must still be able to use it.
    TokenClient::new(&s.env, &s.token).approve(&owner, &s.router, &300_000_000, &1_000);
    client.pull_v3(&permission_id, &execution_id, &agent, &50_000_000);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&agent), 50_000_000);
}

// --- new: `linked_permission` is a public read of the SAME LinkedAgentV3 record `pull_v3`
// itself checks — proves an agent's permission link from public state instead of a local cache. ---
#[test]
fn linked_permission_reflects_v3_agent_link_and_none_otherwise() {
    let s = setup();
    s.env.mock_all_auths();
    let owner = Address::generate(&s.env);
    let client = FundingRouterClient::new(&s.env, &s.router);
    let inits = vec![&s.env, v3_init(&s.env, &s.token, &s.vault, 1, 100_000_000)];

    let (permission_id, agents) =
        client.grant_v3(&owner, &s.token, &500_000_000, &200_000_000, &1_000, &inits);
    let agent = agents.get(0).unwrap();

    assert_eq!(client.linked_permission(&agent), Some(permission_id));
    // An address nobody ever deployed via grant_v3 has no link.
    assert_eq!(client.linked_permission(&Address::generate(&s.env)), None);
    // A V2 grant()-deployed agent lives in a separate namespace — no V3 link either.
    let v2_agents = client.grant(
        &owner,
        &budgets(&s.env, &s.token, 1_000),
        &1_000,
        &vec![&s.env, agent_init(&s.env, &s.token, &s.vault, 2, 1_000)],
    );
    assert_eq!(client.linked_permission(&v2_agents.get(0).unwrap()), None);
}

// ─────────────────────────── Pinned cross-layer vector for `derive_scope_id` ───────────────────────────
//
// CROSS-LAYER CONTRACT: the two byte vectors asserted below are consumed byte-for-byte by the
// JavaScript mirror in `frontend/src/strategy/permissionGrantV3.js`. That file hand-reproduces
// `derive_scope_id`'s exact preimage (domain tag || target XDR || token XDR || kind as a
// big-endian u32 || mint_recipient (32 raw bytes) || destination_domain as a big-endian u32,
// then sha256) so the browser can independently recompute a permission's scope_id and compare it
// against on-chain state, instead of trusting its own local cache. If EITHER assertion below ever
// changes for the SAME inputs — a different hash, a reordered preimage, a changed domain tag —
// the JS mirror is broken and MUST be updated to match it. This Rust function is the single
// source of truth for the algorithm; the JS is a hand-written port of it, never the reverse.
//
// `target`/`token` are built via `Address::from_str` from FIXED, hardcoded strkeys — never
// `Address::generate`, which draws from the test env's PRNG and would make this vector unstable
// across runs (a pinned vector that moves between runs is worthless). This calls the
// crate-private `derive_scope_id` directly rather than going through `grant_v3` — test.rs is a
// child module of the crate root so private items are visible to it (`crate::types::{..}` above
// already relies on the same visibility), and the hash depends only on its own inputs: no token
// or vault contract needs to actually exist on-chain for this.
#[test]
fn scope_id_matches_pinned_cross_layer_vector() {
    let env = Env::default();

    // Fixed target/token: synthetic 32-byte payloads (raw bytes 0xA0..0xBF and 0xB0..0xCF
    // respectively) encoded as Stellar contract strkeys — NOT any real deployed contract, just a
    // stable, reproducible pair of 32-byte identities for the hash to consume.
    let target = Address::from_str(&env, "CCQKDIVDUSS2NJ5IVGVKXLFNV2X3BMNSWO2LLNVXXC43VO54XW7L65UW");
    let token = Address::from_str(&env, "CCYLDMVTWS23NN5YXG5LXPF5X274BQOCYPCMLRWHZDE4VS6MZXHM6QJS");

    // Vector 1: kind = 0 (deposit) — zero mint_recipient/destination_domain, the values every
    // deposit-kind AgentInit carries (those two fields are semantically unused for kind 0, but
    // still part of the hashed preimage either way).
    let zero = BytesN::from_array(&env, &[0u8; 32]);
    let scope1 = crate::derive_scope_id(&env, &target, &token, 0, &zero, 0);
    assert_eq!(
        scope1.to_array(),
        [
            0x77, 0x5a, 0xd5, 0xa5, 0xc5, 0xf2, 0xec, 0x63, 0x82, 0x44, 0x76, 0x26, 0x69, 0x4b,
            0x4c, 0xa7, 0x5b, 0x25, 0xa2, 0x3d, 0x46, 0x6c, 0xfa, 0x3f, 0xda, 0x50, 0x55, 0x96,
            0x86, 0x1d, 0x32, 0x02,
        ]
    );

    // Vector 2: kind = 1 (bridge) — non-zero mint_recipient AND non-zero destination_domain, so
    // both bridge-only fields are actually exercised in the preimage (`grant_v3` itself rejects
    // kind == 1 with either one left at zero, so a real bridge permission always looks like this).
    let mint_recipient = BytesN::from_array(&env, &[0xCDu8; 32]);
    let scope2 = crate::derive_scope_id(&env, &target, &token, 1, &mint_recipient, 6);
    assert_eq!(
        scope2.to_array(),
        [
            0x94, 0xe4, 0x2b, 0x09, 0xc5, 0x13, 0xc8, 0x5d, 0x1d, 0x60, 0x63, 0x38, 0x77, 0xef,
            0xac, 0x27, 0x5f, 0x52, 0x8c, 0x31, 0x41, 0xa4, 0x27, 0x43, 0xd7, 0x03, 0x15, 0x23,
            0xf0, 0x49, 0x91, 0xd3,
        ]
    );
}

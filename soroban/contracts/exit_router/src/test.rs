#![cfg(test)]
use crate::{AgentClient, ExitRouter, ExitRouterClient};
use agent_account::types::AgentScope;
use agent_account::AgentAccount;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, Address, BytesN, Env, IntoVal, String, Vec};

// autofarm_vault carves this out of the first-ever deposit as an inflation-attack guard
// (autofarm_vault::vault::DEAD_SHARES — `pub(crate)`, so it is mirrored here like agent_account's
// tests do). Only the vault's FIRST deposit pays it.
const VAULT_DEAD_SHARES: i128 = 1000;

struct Fixture {
    env: Env,
    owner: Address,
    token: Address,
    vault: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let vault = env.register(
        autofarm_vault::AutofarmVault,
        (
            admin,
            token.clone(),
            String::from_str(&env, "Vault"),
            String::from_str(&env, "vfVLT"),
        ),
    );
    Fixture {
        env,
        owner,
        token,
        vault,
    }
}

/// Register an agent owned by `owner`, mint it `funded`, and deposit `deposited` into the vault.
/// Returns the agent address. Uses mock_all_auths for the ARRANGE only — every test re-arms the
/// auth mocks before the act, so nothing here can mask what `sweep` itself needs authorized.
fn agent_with(f: &Fixture, owner: &Address, seed: u8, funded: i128, deposited: i128) -> Address {
    f.env.mock_all_auths();
    let scope = AgentScope {
        owner: owner.clone(),
        vault: f.vault.clone(),
        token: f.token.clone(),
        cap_per_period: 1_000_000_000,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: f.env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = f.env.register(
        AgentAccount,
        (
            owner.clone(),
            BytesN::from_array(&f.env, &[seed; 32]),
            scope,
            None::<Address>,
        ),
    );
    if funded > 0 {
        soroban_sdk::token::StellarAssetClient::new(&f.env, &f.token).mint(&agent, &funded);
    }
    if deposited > 0 {
        agent_account::vault_client::VaultClient::new(&f.env, &f.vault)
            .deposit(&agent, &deposited);
    }
    agent
}

/// The whole point of this contract: ONE owner authorization, rooted at `sweep`, with a child node
/// per agent — no separate entry (and so, in the browser, no separate wallet popup) per agent.
/// If this ever needs more than one MockAuth entry, the one-popup exit is broken.
#[test]
fn one_owner_auth_sweeps_every_agent() {
    let f = setup();
    let router = f.env.register(ExitRouter, ());
    let a1 = agent_with(&f, &f.owner, 1, 60_000_000, 50_000_000);
    let a2 = agent_with(&f, &f.owner, 2, 30_000_000, 20_000_000);
    let token_client = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
    let agents: Vec<Address> = vec![&f.env, a1.clone(), a2.clone()];

    f.env.set_auths(&[]); // drop the arrange-time mock_all_auths — sweep must stand on its own
    f.env.mock_auths(&[MockAuth {
        address: &f.owner,
        invoke: &MockAuthInvoke {
            contract: &router,
            fn_name: "sweep",
            args: (f.owner.clone(), agents.clone(), f.owner.clone()).into_val(&f.env),
            sub_invokes: &[
                MockAuthInvoke {
                    contract: &a1,
                    fn_name: "owner_withdraw",
                    args: (f.owner.clone(),).into_val(&f.env),
                    sub_invokes: &[],
                },
                MockAuthInvoke {
                    contract: &a2,
                    fn_name: "owner_withdraw",
                    args: (f.owner.clone(),).into_val(&f.env),
                    sub_invokes: &[],
                },
            ],
        },
    }]);

    let swept = ExitRouterClient::new(&f.env, &router).sweep(&f.owner, &agents, &f.owner);

    // a1 paid the vault's first-deposit dead-shares dust; a2 redeems at par.
    assert_eq!(swept, vec![&f.env, 60_000_000 - VAULT_DEAD_SHARES, 30_000_000]);
    assert_eq!(token_client.balance(&a1), 0);
    assert_eq!(token_client.balance(&a2), 0);
    assert_eq!(
        token_client.balance(&f.owner),
        90_000_000 - VAULT_DEAD_SHARES
    );
}

/// One dead agent must not strand the others' funds — the whole reason each call is a `try_`.
#[test]
fn a_failing_agent_does_not_abort_the_sweep() {
    let f = setup();
    let router = f.env.register(ExitRouter, ());
    let funded = agent_with(&f, &f.owner, 1, 40_000_000, 10_000_000);
    let empty = agent_with(&f, &f.owner, 2, 0, 0); // owner_withdraw errors NothingToWithdraw
    let stranger = Address::generate(&f.env);
    let theirs = agent_with(&f, &stranger, 3, 25_000_000, 0); // not ours — must refuse

    f.env.mock_all_auths(); // the owner authorizes everything it is asked to; the agents still gate
    let agents: Vec<Address> = vec![&f.env, funded.clone(), empty.clone(), theirs.clone()];
    let swept = ExitRouterClient::new(&f.env, &router).sweep(&f.owner, &agents, &f.owner);

    assert_eq!(
        swept,
        vec![&f.env, 40_000_000 - VAULT_DEAD_SHARES, 0, 0],
        "a failed agent reports 0, never blocks its neighbours"
    );
    let token_client = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
    assert_eq!(token_client.balance(&f.owner), 40_000_000 - VAULT_DEAD_SHARES);
    // The stranger's agent kept every cent: agent_account checks its OWN stored owner, so
    // exit_router grants no authority over an agent the caller does not own.
    assert_eq!(token_client.balance(&theirs), 25_000_000);
}

/// A sweep that moved nothing must FAIL, not return zeros. Callers zero the position on resolve,
/// so an empty success is how a withdraw that moved no USDC reports "done".
#[test]
fn a_sweep_that_moves_nothing_errors() {
    let f = setup();
    let router = f.env.register(ExitRouter, ());
    let empty = agent_with(&f, &f.owner, 1, 0, 0);
    f.env.mock_all_auths();

    let res = ExitRouterClient::new(&f.env, &router)
        .try_sweep(&f.owner, &vec![&f.env, empty], &f.owner);
    assert_eq!(res, Err(Ok(crate::ExitError::NothingSwept)));
}

#[test]
fn an_empty_agent_list_errors() {
    let f = setup();
    let router = f.env.register(ExitRouter, ());
    f.env.mock_all_auths();

    let res = ExitRouterClient::new(&f.env, &router).try_sweep(
        &f.owner,
        &Vec::<Address>::new(&f.env),
        &f.owner,
    );
    assert_eq!(res, Err(Ok(crate::ExitError::EmptyAgents)));
}

/// Without the owner's authorization there is no sweep — the router itself is not an authority.
#[test]
fn sweep_without_owner_auth_fails() {
    let f = setup();
    let router = f.env.register(ExitRouter, ());
    let a1 = agent_with(&f, &f.owner, 1, 10_000_000, 0);
    let stranger = Address::generate(&f.env);
    let agents: Vec<Address> = vec![&f.env, a1];

    f.env.set_auths(&[]);
    f.env.mock_auths(&[MockAuth {
        address: &stranger, // the stranger authorizes; the owner does not
        invoke: &MockAuthInvoke {
            contract: &router,
            fn_name: "sweep",
            args: (f.owner.clone(), agents.clone(), stranger.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let res = ExitRouterClient::new(&f.env, &router).try_sweep(&f.owner, &agents, &stranger);
    assert!(res.is_err());
}

/// The client trait is a hand-copy of agent_account's public ABI — if that signature ever drifts,
/// every sweep silently becomes a no-op (try_ swallows the mismatch). Pin it.
#[test]
fn agent_client_matches_the_deployed_agent_abi() {
    let f = setup();
    let agent = agent_with(&f, &f.owner, 1, 5_000_000, 0);
    f.env.mock_all_auths();

    assert_eq!(
        AgentClient::new(&f.env, &agent).owner_withdraw(&f.owner),
        5_000_000
    );
}

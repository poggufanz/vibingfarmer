#![cfg(test)]
use crate::types::AgentScope;
use crate::{AgentAccount, AgentAccountClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};

fn scope(_env: &Env, owner: &Address, vault: &Address, token: &Address) -> AgentScope {
    AgentScope {
        owner: owner.clone(),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: 1_000_000_000, // 1,000 units @ 6dp
        period_duration: 86_400,       // 1 day
        spent_in_period: 0,
        period_start: 0,
        expiry: 4_000_000_000, // far future
        revoked: false,
    }
}

// A real Stellar Asset Contract token. Registration runs the agent constructor's
// self-approve (Task 2), which cross-calls `token.approve` — so the scope's token must
// be a live SAC, not a bare generated address, or the constructor traps (MissingValue).
fn sac_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    env.register_stellar_asset_contract_v2(admin).address()
}

#[test]
fn test_constructor_stores_scope_and_key() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    let s = scope(&env, &owner, &vault, &token);

    let id = env.register(AgentAccount, (owner.clone(), pubkey.clone(), s.clone()));
    let client = AgentAccountClient::new(&env, &id);

    let got = client.scope_of();
    assert_eq!(got.vault, vault);
    assert_eq!(got.cap_per_period, 1_000_000_000);
    assert_eq!(got.revoked, false);
    assert_eq!(client.signer(), pubkey);
}

// --- Task 3: signature verification ---
use crate::types::AccountError;
use soroban_sdk::auth::Context;
use soroban_sdk::testutils::BytesN as _;
use soroban_sdk::{IntoVal, Vec};

#[test]
fn test_check_auth_rejects_bad_signature() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    // Random pubkey we do NOT hold the secret for → any signature must fail.
    let pubkey = BytesN::from_array(&env, &[9u8; 32]);
    let s = scope(&env, &owner, &vault, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s));

    // `__` fns are not exposed on the client; the SDK testutils entrypoint for
    // exercising a custom account is `try_invoke_contract_check_auth`. It takes
    // the payload as BytesN<32> (the host wraps it into Hash<32>) and the
    // signature as a Val. A junk signature over a random payload must reject.
    let payload = BytesN::random(&env);
    let junk_sig = BytesN::from_array(&env, &[0u8; 64]);
    let contexts: Vec<Context> = Vec::new(&env);
    let res = env.try_invoke_contract_check_auth::<AccountError>(
        &id,
        &payload,
        junk_sig.into_val(&env),
        &contexts,
    );
    assert!(res.is_err());
}

// --- Task 4: scope enforcement ---
use soroban_sdk::auth::ContractContext;
use soroban_sdk::{symbol_short, Val};

// Build a deposit auth context for `vault` spending `amount`.
fn deposit_ctx(env: &Env, vault: &Address, agent: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<Val> = (agent.clone(), amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: vault.clone(),
            fn_name: symbol_short!("deposit"),
            args,
        })],
    )
}

#[test]
fn test_scope_rejects_wrong_vault() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let wrong_vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner,
            pubkey,
            scope(&env, &Address::generate(&env), &vault, &token),
        ),
    );
    let agent = Address::generate(&env);
    let ctx = deposit_ctx(&env, &wrong_vault, &agent, 10);
    // enforce_scope is the unit under test (auth-independent):
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::VaultMismatch));
}

#[test]
fn test_scope_rejects_when_revoked() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let mut s = scope(&env, &Address::generate(&env), &vault, &token);
    s.revoked = true;
    let id = env.register(AgentAccount, (owner, pubkey, s));
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 10);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::Revoked));
}

#[test]
fn test_scope_rejects_when_expired() {
    let env = Env::default();
    env.ledger().set_timestamp(5_000_000_000); // past the far-future expiry
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner,
            pubkey,
            scope(&env, &Address::generate(&env), &vault, &token),
        ),
    );
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 10);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::Expired));
}

#[test]
fn test_scope_rejects_over_cap() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner,
            pubkey,
            scope(&env, &Address::generate(&env), &vault, &token),
        ),
    );
    let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), 2_000_000_000); // > 1,000,000,000 cap
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::CapExceeded));
}

#[test]
fn test_scope_accumulates_and_resets_period() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner,
            pubkey,
            scope(&env, &Address::generate(&env), &vault, &token),
        ),
    );

    // First spend of 600 units (cap is 1,000) → ok, spent=600.
    let ctx1 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert!(env
        .as_contract(&id, || AgentAccount::enforce_scope_for_test(
            env.clone(),
            ctx1
        ))
        .is_ok());

    // Second spend of 600 in same period → would total 1,200 > cap → reject.
    let ctx2 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert_eq!(
        env.as_contract(&id, || AgentAccount::enforce_scope_for_test(
            env.clone(),
            ctx2
        )),
        Err(AccountError::CapExceeded)
    );

    // Advance past period_duration (86,400s) → period resets, 600 ok again.
    env.ledger().set_timestamp(1000 + 86_401);
    let ctx3 = deposit_ctx(&env, &vault, &Address::generate(&env), 600_000_000);
    assert!(env
        .as_contract(&id, || AgentAccount::enforce_scope_for_test(
            env.clone(),
            ctx3
        ))
        .is_ok());
}

// --- Task 1: local vault client interface (no wasm import) ---
#[test]
fn vault_client_iface_compiles_and_calls() {
    // Arrange: register the real vault (via its struct type — rwa_vault exposes no WASM
    // const, and a dev-dep struct registration keeps cross-contract calls working in the
    // test env while avoiding the 1d build-time wasm link collision) and a SAC token.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = env.register(
        rwa_vault::RwaVault,
        (
            admin.clone(),
            token.clone(),
            soroban_sdk::String::from_str(&env, "Vault"),
            soroban_sdk::String::from_str(&env, "vfVLT"),
        ),
    );
    // Act: call deposit through OUR local client (proves the iface matches the deployed vault).
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    let holder = Address::generate(&env);
    token_admin.mint(&holder, &100_000_000);
    soroban_sdk::token::TokenClient::new(&env, &token).approve(
        &holder,
        &vault,
        &100_000_000,
        &1_000_000,
    );
    let shares = crate::vault_client::VaultClient::new(&env, &vault).deposit(&holder, &50_000_000);
    // Assert
    assert_eq!(shares, 50_000_000); // 1:1 stable NAV
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&holder),
        50_000_000
    );
}

#[test]
fn test_cap_never_exceeded_property() {
    // Sequence of deposits within one period must never let cumulative spend
    // pass the cap, regardless of split.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner,
            pubkey,
            scope(&env, &Address::generate(&env), &vault, &token),
        ),
    );
    let cap = 1_000_000_000i128;
    let mut accepted = 0i128;
    for chunk in [300_000_000i128, 300_000_000, 300_000_000, 300_000_000] {
        let ctx = deposit_ctx(&env, &vault, &Address::generate(&env), chunk);
        if env
            .as_contract(&id, || {
                AgentAccount::enforce_scope_for_test(env.clone(), ctx)
            })
            .is_ok()
        {
            accepted += chunk;
        }
    }
    assert!(
        accepted <= cap,
        "accepted {} exceeded cap {}",
        accepted,
        cap
    );
}

// --- Task 2: constructor self-approves the vault for cap ---
#[test]
fn constructor_self_approves_vault_for_cap() {
    // Arrange
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = Address::generate(&env); // any address; approve does not call it
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let cap: i128 = 100_000_000;
    let s = AgentScope {
        owner: owner.clone(),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    // Act: deploy the agent with the constructor.
    let agent = env.register(AgentAccount, (owner.clone(), signer, s));
    // Assert: the agent pre-approved the vault to pull `cap` of the token.
    let allowance = soroban_sdk::token::TokenClient::new(&env, &token).allowance(&agent, &vault);
    assert_eq!(allowance, cap);
}

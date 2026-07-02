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
    assert!(!got.revoked);
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

// --- Task 3: owner_withdraw exit sweep ---
#[test]
fn owner_withdraw_sweeps_principal_back_to_owner() {
    // Arrange: token + vault + agent (constructor pre-approves the vault).
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    let vault = env.register(
        rwa_vault::RwaVault,
        (
            admin.clone(),
            token.clone(),
            soroban_sdk::String::from_str(&env, "Vault"),
            soroban_sdk::String::from_str(&env, "vfVLT"),
        ),
    );
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
    let agent = env.register(AgentAccount, (owner.clone(), signer, s));

    // Fund the agent and deposit (mock_all_auths stands in for the session-key path here;
    // the real session-key auth tree is Phase 2). Shares mint to the agent.
    token_admin.mint(&agent, &60_000_000);
    crate::vault_client::VaultClient::new(&env, &vault).deposit(&agent, &50_000_000);
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&agent),
        50_000_000
    );

    // Act: owner sweeps everything back.
    let swept = AgentAccountClient::new(&env, &agent).owner_withdraw(&owner);

    // Assert: agent emptied, owner holds principal (50m redeemed + 10m never deposited).
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&agent),
        0
    );
    assert_eq!(token_client.balance(&agent), 0);
    assert_eq!(token_client.balance(&owner), 60_000_000);
    assert_eq!(swept, 60_000_000);
}

#[test]
fn owner_withdraw_rejects_non_owner() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let s = AgentScope {
        owner: owner.clone(),
        vault,
        token,
        cap_per_period: 1,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (owner.clone(), signer, s));
    // Only the stranger authorizes — owner.require_auth() must fail.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &stranger,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &agent,
            fn_name: "owner_withdraw",
            args: (stranger.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = AgentAccountClient::new(&env, &agent).try_owner_withdraw(&stranger);
    assert!(res.is_err());
}

// --- Task 4: the session-key (__check_auth) path stays deposit-only after Tasks 2/3 ---
#[test]
fn session_key_path_still_rejects_non_deposit_contexts() {
    let env = Env::default();
    let token = sac_token(&env);
    let vault = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let s = AgentScope {
        owner: Address::generate(&env),
        vault: vault.clone(),
        token: token.clone(),
        cap_per_period: 1_000,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (Address::generate(&env), signer, s));

    // An `approve@token` context must be rejected by the deposit-only enforcer — the session
    // key never gained approve power (the self-approve / withdraw use invoker / owner auth).
    let approve_ctx = Context::Contract(ContractContext {
        contract: token,
        fn_name: symbol_short!("approve"),
        args: (1i128,).into_val(&env),
    });
    let res = env.as_contract(&agent, || {
        AgentAccount::enforce_scope_for_test(env.clone(), Vec::from_array(&env, [approve_ctx]))
    });
    assert!(res.is_err()); // rejected — only deposit@vault is allowed for the session key
}

#[test]
fn test_set_and_get_exit_signer_owner_only() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    let exit_pubkey = BytesN::from_array(&env, &[8u8; 32]);
    let s = scope(&env, &owner, &vault, &token);
    let id = env.register(AgentAccount, (owner.clone(), pubkey, s));
    let client = AgentAccountClient::new(&env, &id);

    // Initial check: exit_signer is not set.
    assert!(client.try_exit_signer().is_err());

    // Call set_exit_signer with owner auth.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &owner,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &id,
            fn_name: "set_exit_signer",
            args: (exit_pubkey.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_exit_signer(&exit_pubkey);
    assert_eq!(client.exit_signer(), exit_pubkey);

    // Call set_exit_signer as non-owner (stranger) should fail.
    let stranger = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &stranger,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &id,
            fn_name: "set_exit_signer",
            args: (exit_pubkey.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_exit_signer(&exit_pubkey).is_err());
}

fn redeem_ctx(env: &Env, vault: &Address, agent: &Address, shares: i128) -> Vec<Context> {
    let args: Vec<Val> = (agent.clone(), shares).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: vault.clone(),
            fn_name: soroban_sdk::Symbol::new(env, "redeem"),
            args,
        })],
    )
}

fn transfer_ctx(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<Val> = (from.clone(), to.clone(), amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: soroban_sdk::Symbol::new(env, "transfer"),
            args,
        })],
    )
}

#[test]
fn test_exit_scope_enforcement() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = scope(&env, &owner, &vault, &token);
    let id = env.register(AgentAccount, (owner.clone(), pubkey, s));

    // 1. Valid redeem context (vault.redeem(agent_account, shares)) should pass.
    let ctx1 = redeem_ctx(&env, &vault, &id, 100);
    let res1 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx1)
    });
    assert!(res1.is_ok());

    // 2. Valid transfer context (token.transfer(agent_account, owner, amount)) should pass.
    let ctx2 = transfer_ctx(&env, &token, &id, &owner, 100);
    let res2 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx2)
    });
    assert!(res2.is_ok());

    // 3. Redeem context with wrong from (not agent account itself) should reject.
    let ctx3 = redeem_ctx(&env, &vault, &Address::generate(&env), 100);
    let res3 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx3)
    });
    assert_eq!(res3, Err(AccountError::NotOwner));

    // 4. Transfer context with wrong to (not owner) should reject.
    let stranger = Address::generate(&env);
    let ctx4 = transfer_ctx(&env, &token, &id, &stranger, 100);
    let res4 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx4)
    });
    assert_eq!(res4, Err(AccountError::NotOwner));

    // 5. Context with wrong contract (not vault or token) should reject.
    let wrong_contract = Address::generate(&env);
    let ctx5 = redeem_ctx(&env, &wrong_contract, &id, 100);
    let res5 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx5)
    });
    assert_eq!(res5, Err(AccountError::VaultMismatch));

    // 6. Context with wrong fn_name on vault (e.g. deposit instead of redeem) should reject.
    let deposit_args: Vec<Val> = (id.clone(), 100i128).into_val(&env);
    let ctx6 = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: vault.clone(),
            fn_name: soroban_sdk::Symbol::new(&env, "deposit"),
            args: deposit_args,
        })],
    );
    let res6 = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx6)
    });
    assert_eq!(res6, Err(AccountError::FnNotAllowed));
}

#![cfg(test)]
use crate::types::AgentScope;
use crate::{AgentAccount, AgentAccountClient};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};

fn scope(env: &Env, owner: &Address, vault: &Address, token: &Address) -> AgentScope {
    AgentScope {
        owner: owner.clone(),
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(env, &[0u8; 32]),
        destination_domain: 0,
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

    let id = env.register(
        AgentAccount,
        (owner.clone(), pubkey.clone(), s.clone(), None::<Address>),
    );
    let client = AgentAccountClient::new(&env, &id);

    let got = client.scope_of();
    assert_eq!(got.target, vault);
    assert_eq!(got.cap_per_period, 1_000_000_000);
    assert!(!got.revoked);
    assert_eq!(client.signer(), pubkey);
    // Legacy direct deploy: no funding router stored.
    assert_eq!(client.router(), None);
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
    let id = env.register(AgentAccount, (owner, pubkey, s, None::<Address>));

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
            None::<Address>,
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
    let id = env.register(AgentAccount, (owner, pubkey, s, None::<Address>));
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
            None::<Address>,
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
            None::<Address>,
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
            None::<Address>,
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

// autofarm_vault mints this many shares to ITSELF (locked forever) on a vault's first-ever
// deposit — an inflation-attack guard (autofarm_vault::vault::DEAD_SHARES, `pub(crate)` so not
// importable from here). Every fresh-vault first deposit in this file's tests must dock its
// expected share count by this amount.
const VAULT_DEAD_SHARES: i128 = 1000;

// --- Task 1: local vault client interface (no wasm import) ---
#[test]
fn vault_client_iface_compiles_and_calls() {
    // Arrange: register the real vault (via its struct type — autofarm_vault exposes no WASM
    // const, and a dev-dep struct registration keeps cross-contract calls working in the
    // test env while avoiding the 1d build-time wasm link collision) and a SAC token.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let vault = env.register(
        autofarm_vault::AutofarmVault,
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
    // Assert: this is the vault's first-ever deposit, so DEAD_SHARES is carved out and locked
    // in the vault itself — the holder mints amount - DEAD_SHARES, not a flat 1:1.
    assert_eq!(shares, 50_000_000 - VAULT_DEAD_SHARES);
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&holder),
        50_000_000 - VAULT_DEAD_SHARES
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
            None::<Address>,
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
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    // Act: deploy the agent with the constructor.
    let agent = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));
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
        autofarm_vault::AutofarmVault,
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
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));

    // Fund the agent and deposit (mock_all_auths stands in for the session-key path here;
    // the real session-key auth tree is Phase 2). Shares mint to the agent — this is the
    // vault's first-ever deposit, so DEAD_SHARES is carved out and locked in the vault itself.
    token_admin.mint(&agent, &60_000_000);
    crate::vault_client::VaultClient::new(&env, &vault).deposit(&agent, &50_000_000);
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&agent),
        50_000_000 - VAULT_DEAD_SHARES
    );

    // Act: owner sweeps everything back.
    let swept = AgentAccountClient::new(&env, &agent).owner_withdraw(&owner);

    // Assert: agent emptied, owner holds principal (50m redeemed at par minus the
    // DEAD_SHARES dust permanently locked in the vault, + 10m never deposited). Exit is
    // redeem-only now (no dividend claim) — nothing else contributes to the swept total.
    assert_eq!(
        crate::vault_client::VaultClient::new(&env, &vault).balance(&agent),
        0
    );
    assert_eq!(token_client.balance(&agent), 0);
    assert_eq!(token_client.balance(&owner), 60_000_000 - VAULT_DEAD_SHARES);
    assert_eq!(swept, 60_000_000 - VAULT_DEAD_SHARES);
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
        target: vault,
        token,
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: 1,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));
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
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: 1_000,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(
        AgentAccount,
        (Address::generate(&env), signer, s, None::<Address>),
    );

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
    let id = env.register(AgentAccount, (owner.clone(), pubkey, s, None::<Address>));
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

fn transfer_ctx(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Vec<Context> {
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
    let id = env.register(AgentAccount, (owner.clone(), pubkey, s, None::<Address>));

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

// --- owner revoke kill switch (security hardening Task 3) ---

#[test]
fn owner_revoke_flips_scope_clears_allowance_blocks_sessions_and_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = sac.address();
    let vault = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let cap: i128 = 100_000_000;
    let s = AgentScope {
        owner: owner.clone(),
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));
    let client = AgentAccountClient::new(&env, &agent);
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    // Constructor self-approved the vault for the cap.
    assert_eq!(token_client.allowance(&agent, &vault), cap);

    client.revoke();

    // Exactly one agent_revoked event from the agent itself (asserted first —
    // SDK 26 events().all() only holds the LAST invocation's events; the SAC's
    // own approve event lives on the token contract, filtered out here).
    assert_eq!(
        env.events().all().filter_by_contract(&agent).events().len(),
        1
    );
    // Scope flipped, allowance dead.
    assert!(client.scope_of().revoked);
    assert_eq!(token_client.allowance(&agent, &vault), 0);

    // The session-key deposit path fails closed from now on.
    let ctx = deposit_ctx(&env, &vault, &agent, 10);
    let res = env.as_contract(&agent, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::Revoked));

    // Idempotent: a second revoke succeeds and changes nothing.
    client.revoke();
    assert!(client.scope_of().revoked);
    assert_eq!(token_client.allowance(&agent, &vault), 0);
}

#[test]
fn stranger_cannot_revoke() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    let s = scope(&env, &owner, &vault, &token);
    let agent = env.register(AgentAccount, (owner.clone(), pubkey, s, None::<Address>));
    let client = AgentAccountClient::new(&env, &agent);

    // Only the stranger authorizes — owner.require_auth() must fail and the scope stays live.
    let stranger = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &stranger,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &agent,
            fn_name: "revoke",
            args: soroban_sdk::vec![&env],
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_revoke().is_err());
    assert!(!client.scope_of().revoked);
}

#[test]
fn owner_withdraw_clears_vault_allowance() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    let vault = env.register(
        autofarm_vault::AutofarmVault,
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
        target: vault.clone(),
        token: token.clone(),
        kind: 0,
        mint_recipient: BytesN::from_array(&env, &[0u8; 32]),
        destination_domain: 0,
        cap_per_period: cap,
        period_duration: 3600,
        spent_in_period: 0,
        period_start: 0,
        expiry: env.ledger().timestamp() + 3600,
        revoked: false,
    };
    let agent = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));
    token_admin.mint(&agent, &60_000_000);
    crate::vault_client::VaultClient::new(&env, &vault).deposit(&agent, &50_000_000);
    // Deposit consumed 50m of the 100m constructor allowance — 50m still standing.
    assert_eq!(token_client.allowance(&agent, &vault), cap - 50_000_000);

    let client = AgentAccountClient::new(&env, &agent);
    client.owner_withdraw(&owner);

    // Exit also kills the standing vault allowance — nothing left to pull from a dead agent.
    assert_eq!(token_client.allowance(&agent, &vault), 0);
    // Exit is terminal: scope is revoked, so the session key can no longer authorize a
    // funding pull into the swept-empty agent (enforce gates on this flag).
    assert!(client.scope_of().revoked);
    let ctx = deposit_ctx(&env, &vault, &agent, 10);
    let res = env.as_contract(&agent, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::Revoked));
}

// --- one-popup grant: the session key may fund itself via the DEPLOYING router only ---

// Build a `pull(agent, amount)` auth context on `router`.
fn pull_ctx(env: &Env, router: &Address, agent: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<Val> = (agent.clone(), amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: router.clone(),
            fn_name: symbol_short!("pull"),
            args,
        })],
    )
}

#[test]
fn session_key_accepts_pull_on_deploying_router_without_spending_cap() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let router = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner.clone(),
            pubkey,
            scope(&env, &owner, &vault, &token),
            Some(router.clone()),
        ),
    );
    // Constructor stored the deploying router.
    assert_eq!(
        AgentAccountClient::new(&env, &id).router(),
        Some(router.clone())
    );

    // pull@router is accepted for the session key…
    let ctx = pull_ctx(&env, &router, &id, 500_000_000);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert!(res.is_ok());

    // …and did NOT count toward spent_in_period: a FULL-cap deposit still fits after it
    // (cap accounting stays deposit-only; funding is bounded by the token allowance).
    let dep = deposit_ctx(&env, &vault, &id, 1_000_000_000);
    let res2 = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), dep)
    });
    assert!(res2.is_ok());
}

#[test]
fn session_key_rejects_pull_when_router_not_set() {
    // Legacy direct deploy (router = None): a pull context is just a foreign contract.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let router = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner.clone(),
            pubkey,
            scope(&env, &owner, &vault, &token),
            None::<Address>,
        ),
    );
    let ctx = pull_ctx(&env, &router, &id, 1_000_000);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::VaultMismatch));
}

#[test]
fn session_key_rejects_pull_on_other_contract() {
    // Router IS set, but the pull targets some OTHER contract — refused.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let router = Address::generate(&env);
    let other = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner.clone(),
            pubkey,
            scope(&env, &owner, &vault, &token),
            Some(router),
        ),
    );
    let ctx = pull_ctx(&env, &other, &id, 1_000_000);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::VaultMismatch));
}

#[test]
fn session_key_rejects_non_pull_fn_on_router() {
    // Router IS set; any fn other than `pull` on it stays forbidden.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let router = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let id = env.register(
        AgentAccount,
        (
            owner.clone(),
            pubkey,
            scope(&env, &owner, &vault, &token),
            Some(router.clone()),
        ),
    );
    let args: Vec<Val> = (id.clone(), 1_000_000i128).into_val(&env);
    let ctx = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: router,
            fn_name: symbol_short!("transfer"),
            args,
        })],
    );
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::FnNotAllowed));
}

#[test]
fn session_key_pull_still_gated_by_revoked_and_expiry() {
    // Revoked scope: pull@router refused before any context matching.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let router = Address::generate(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let mut s = scope(&env, &owner, &vault, &token);
    s.revoked = true;
    let id = env.register(
        AgentAccount,
        (owner.clone(), pubkey.clone(), s, Some(router.clone())),
    );
    let ctx = pull_ctx(&env, &router, &id, 1_000_000);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::Revoked));

    // Expired scope: same refusal.
    let env2 = Env::default();
    env2.ledger().set_timestamp(5_000_000_000); // past the far-future expiry
    let owner2 = Address::generate(&env2);
    let vault2 = Address::generate(&env2);
    let token2 = sac_token(&env2);
    let router2 = Address::generate(&env2);
    let pubkey2 = BytesN::from_array(&env2, &[1u8; 32]);
    let id2 = env2.register(
        AgentAccount,
        (
            owner2.clone(),
            pubkey2,
            scope(&env2, &owner2, &vault2, &token2),
            Some(router2.clone()),
        ),
    );
    let ctx2 = pull_ctx(&env2, &router2, &id2, 1_000_000);
    let res2 = env2.as_contract(&id2, || {
        AgentAccount::enforce_scope_for_test(env2.clone(), ctx2)
    });
    assert_eq!(res2, Err(AccountError::Expired));
}

// --- Task 1 (v3): owner_withdraw on a Bridge-kind scope skips the vault redeem ---

#[test]
fn test_owner_withdraw_bridge_skips_redeem_and_sweeps() {
    // scope kind=1, target = a dummy address that is NOT a vault (stand-in for
    // TokenMessengerMinter), token = a real SAC. Mint token to the agent, call
    // owner_withdraw(to=owner) → balance moves to owner. No redeem call happens
    // (would panic if `target` were treated as a vault).
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let token = sac_token(&env);
    let messenger = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[7u8; 32]);
    let mut s = scope(&env, &owner, &messenger, &token);
    s.kind = 1;
    let id = env.register(AgentAccount, (owner.clone(), signer, s, None::<Address>));
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&id, &500i128);
    let client = AgentAccountClient::new(&env, &id);
    assert_eq!(client.owner_withdraw(&owner), 500i128);
    assert_eq!(
        soroban_sdk::token::TokenClient::new(&env, &token).balance(&owner),
        500i128
    );
}

// --- Task 2 (v3): enforce() bridge branch (kind=1, session-key deposit_for_burn) ---

// A kind=1 (Bridge) scope on top of the kind=0 `scope()` base: destination_domain and
// mint_recipient are only meaningful for Bridge, so they get real (nonzero) values here.
fn bridge_scope(env: &Env, owner: &Address, messenger: &Address, token: &Address) -> AgentScope {
    let mut s = scope(env, owner, messenger, token);
    s.kind = 1;
    s.destination_domain = 6;
    s.mint_recipient = BytesN::from_array(env, &[7u8; 32]);
    s
}

// Build a `deposit_for_burn` auth context on `scope.target`, arg order:
// (from, amount, destination_domain, mint_recipient, burn_token, destination_caller,
//  max_fee, min_finality_threshold) — pinned to the live burn signature. `agent` fills
// `from`; the last three (dest_caller/max_fee/min_finality) are always the pinned values
// (zero/zero/2000) here — tests that need those wrong build the Context by hand.
fn burn_ctx(env: &Env, agent: &Address, scope: &AgentScope, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: scope.target.clone(),
        fn_name: soroban_sdk::Symbol::new(env, "deposit_for_burn"),
        args: soroban_sdk::vec![
            env,
            agent.into_val(env),
            amount.into_val(env),
            scope.destination_domain.into_val(env),
            scope.mint_recipient.into_val(env),
            scope.token.into_val(env),
            BytesN::<32>::from_array(env, &[0u8; 32]).into_val(env),
            0i128.into_val(env),
            2000u32.into_val(env),
        ],
    })
}

#[test]
fn bridge_allows_valid_burn_and_counts_cap() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let ctx = burn_ctx(&env, &id, &s, 500_000_000); // half of the 1,000,000,000 cap
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert!(res.is_ok());
    assert_eq!(
        AgentAccountClient::new(&env, &id).scope_of().spent_in_period,
        500_000_000
    );
}

#[test]
fn bridge_rejects_wrong_mint_recipient() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let mut wrong = s;
    wrong.mint_recipient = BytesN::from_array(&env, &[9u8; 32]);
    let ctx = burn_ctx(&env, &id, &wrong, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::BridgeArgMismatch));
}

#[test]
fn bridge_rejects_wrong_domain() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let mut wrong = s;
    wrong.destination_domain = 99;
    let ctx = burn_ctx(&env, &id, &wrong, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::BridgeArgMismatch));
}

#[test]
fn bridge_rejects_wrong_token() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let mut wrong = s;
    wrong.token = Address::generate(&env);
    let ctx = burn_ctx(&env, &id, &wrong, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::BridgeArgMismatch));
}

#[test]
fn bridge_rejects_nonzero_dest_caller() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    // burn_ctx always pins dest_caller to zero — build the context by hand to set it
    // to something nonzero.
    let ctx = Context::Contract(ContractContext {
        contract: s.target.clone(),
        fn_name: soroban_sdk::Symbol::new(&env, "deposit_for_burn"),
        args: soroban_sdk::vec![
            &env,
            id.into_val(&env),
            100i128.into_val(&env),
            s.destination_domain.into_val(&env),
            s.mint_recipient.into_val(&env),
            s.token.into_val(&env),
            BytesN::<32>::from_array(&env, &[1u8; 32]).into_val(&env), // nonzero dest_caller
            0i128.into_val(&env),
            2000u32.into_val(&env),
        ],
    });
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::BridgeArgMismatch));
}

#[test]
fn bridge_rejects_nonzero_max_fee_or_fast_finality() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));
    let zero = BytesN::<32>::from_array(&env, &[0u8; 32]);

    // Nonzero max_fee (args[6]) — the burn must be free, per the pinned convention.
    let ctx_fee = Context::Contract(ContractContext {
        contract: s.target.clone(),
        fn_name: soroban_sdk::Symbol::new(&env, "deposit_for_burn"),
        args: soroban_sdk::vec![
            &env,
            id.into_val(&env),
            100i128.into_val(&env),
            s.destination_domain.into_val(&env),
            s.mint_recipient.into_val(&env),
            s.token.into_val(&env),
            zero.clone().into_val(&env),
            1i128.into_val(&env), // nonzero max_fee
            2000u32.into_val(&env),
        ],
    });
    assert_eq!(
        env.as_contract(&id, || AgentAccount::enforce_scope_for_test(
            env.clone(),
            soroban_sdk::vec![&env, ctx_fee]
        )),
        Err(AccountError::BridgeArgMismatch)
    );

    // Fast (non-standard) finality threshold (args[7]) — only the pinned 2000 is allowed.
    let ctx_finality = Context::Contract(ContractContext {
        contract: s.target.clone(),
        fn_name: soroban_sdk::Symbol::new(&env, "deposit_for_burn"),
        args: soroban_sdk::vec![
            &env,
            id.into_val(&env),
            100i128.into_val(&env),
            s.destination_domain.into_val(&env),
            s.mint_recipient.into_val(&env),
            s.token.into_val(&env),
            zero.into_val(&env),
            0i128.into_val(&env),
            1000u32.into_val(&env), // fast finality, not the pinned 2000
        ],
    });
    assert_eq!(
        env.as_contract(&id, || AgentAccount::enforce_scope_for_test(
            env.clone(),
            soroban_sdk::vec![&env, ctx_finality]
        )),
        Err(AccountError::BridgeArgMismatch)
    );
}

#[test]
fn bridge_rejects_from_not_self() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    // args[0] (`from`) is some other address, not the agent contract itself.
    let ctx = burn_ctx(&env, &Address::generate(&env), &s, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::BridgeArgMismatch));
}

#[test]
fn bridge_cap_exceeded() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let ctx = burn_ctx(&env, &id, &s, 2_000_000_000); // > 1,000,000,000 cap
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::CapExceeded));
}

#[test]
fn bridge_rejects_vault_deposit_context() {
    // A kind=1 (Bridge) scope must not accept the kind=0 `deposit` function, even
    // though the contract address (`target`) matches.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = bridge_scope(&env, &owner, &messenger, &token);
    let id = env.register(AgentAccount, (owner, pubkey, s, None::<Address>));

    let ctx = deposit_ctx(&env, &messenger, &id, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::FnNotAllowed));
}

#[test]
fn deposit_kind_rejects_burn_context() {
    // A kind=0 (Deposit) scope must not accept `deposit_for_burn`, even though the
    // contract address (`target`) matches.
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let vault = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let s = scope(&env, &owner, &vault, &token); // kind=0
    let id = env.register(AgentAccount, (owner, pubkey, s.clone(), None::<Address>));

    let ctx = burn_ctx(&env, &id, &s, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_scope_for_test(env.clone(), soroban_sdk::vec![&env, ctx])
    });
    assert_eq!(res, Err(AccountError::FnNotAllowed));
}

// --- Task 1 review gap: enforce_exit's redeem branch is gated on scope.kind == 0 ---

#[test]
fn exit_signer_redeem_context_on_bridge_kind_is_rejected() {
    // A kind=1 (Bridge) scope has no vault to redeem from. enforce_exit only special-cases
    // redeem for kind==0; here contract == scope.target but kind != 0, so the redeem branch
    // doesn't match, contract != scope.token either, and it falls through to the final
    // catch-all: VaultMismatch (current logic — not a dedicated bridge error).
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let owner = Address::generate(&env);
    let messenger = Address::generate(&env);
    let token = sac_token(&env);
    let pubkey = BytesN::from_array(&env, &[1u8; 32]);
    let mut s = scope(&env, &owner, &messenger, &token);
    s.kind = 1;
    let id = env.register(AgentAccount, (owner, pubkey, s, None::<Address>));

    let ctx = redeem_ctx(&env, &messenger, &id, 100);
    let res = env.as_contract(&id, || {
        AgentAccount::enforce_exit_scope_for_test(env.clone(), ctx)
    });
    assert_eq!(res, Err(AccountError::VaultMismatch));
}

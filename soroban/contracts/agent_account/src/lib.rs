#![no_std]
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contractevent, contractimpl, vec, Address, BytesN, Env, IntoVal, Symbol};

mod account;
mod test;
pub mod types;
pub mod vault_client;

use types::{AccountError, AgentScope, DataKey};
use vault_client::VaultClient;

// Allowance lives this many ledgers (~30 days at 5s) — long enough to outlast any session scope.
const APPROVE_TTL_LEDGERS: u32 = 518_400;

/// The owner disabled this agent: session authorization is dead and the vault
/// allowance is cleared. Same topic/shape as the Registry's metadata event so
/// existing indexers/subscriptions decode both sources identically.
#[contractevent(topics = ["agent_revoked"])]
pub struct AgentRevoked {
    pub owner: Address,
    pub agent: Address,
}

#[contract]
pub struct AgentAccount;

/// Ledgers the constructor's vault allowance must live so it always outlasts the scope.
/// Covers `scope_expiry - now` at ~5s/ledger plus a ~1-day buffer, floored at the 30-day
/// default. Prevents the "allowance dies but __check_auth still authorizes → deposits brick"
/// trap for long scopes. Capped at the network's max entry TTL — a scope longer than that
/// cannot be covered by any allowance (hard ledger-storage limit; see SECURITY.md).
fn allowance_ttl_ledgers(env: &Env, scope_expiry: u64) -> u32 {
    const LEDGER_SECS: u64 = 5;
    const BUFFER_LEDGERS: u64 = 17_280; // ~1 day
    let now = env.ledger().timestamp();
    let remaining = scope_expiry.saturating_sub(now);
    let needed = u32::try_from(remaining / LEDGER_SECS + BUFFER_LEDGERS).unwrap_or(u32::MAX);
    needed
        .max(APPROVE_TTL_LEDGERS)
        .min(env.storage().max_ttl())
}

/// Zero out the constructor's standing token allowance to the vault, using the
/// same invoker-contract auth path the constructor used to create it.
fn clear_vault_allowance(env: &Env, scope: &AgentScope) {
    let current = env.current_contract_address();
    // Amount 0 = delete the allowance entry; SEP-41 ignores the ledger bound for 0.
    let expiration_ledger = env.ledger().sequence();
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: scope.token.clone(),
                fn_name: Symbol::new(env, "approve"),
                args: (
                    current.clone(),
                    scope.vault.clone(),
                    0i128,
                    expiration_ledger,
                )
                    .into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
    TokenClient::new(env, &scope.token).approve(&current, &scope.vault, &0, &expiration_ledger);
}

#[contractimpl]
impl AgentAccount {
    /// Deployed once per worker agent. `owner` = the human EOA that granted the
    /// scope; `signer` = the ephemeral ed25519 session pubkey the worker signs with.
    /// `router` = the funding_router factory that deployed this agent (`None` for
    /// legacy direct deploys). When set, the session key may additionally authorize
    /// `pull` on that router — funding is bounded by the owner's SEP-41 allowance to
    /// the router at the token level, never by (nor counted against) the deposit cap.
    /// The constructor also self-approves the vault to pull up to `cap_per_period` of
    /// the asset, so the deployed vault's `transfer_from(spender=vault, from=agent)`
    /// works without the (deposit-only) session key ever signing an `approve`.
    pub fn __constructor(
        env: Env,
        owner: Address,
        signer: BytesN<32>,
        scope: AgentScope,
        router: Option<Address>,
    ) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Scope, &scope);
        if let Some(ref r) = router {
            env.storage().instance().set(&DataKey::Router, r);
        }

        // Invoker-contract auth: authorize THIS contract's own sub-invocation of token.approve.
        // Bypasses __check_auth (that path is reserved for the session key + deposit only).
        let current = env.current_contract_address();
        // The vault allowance must OUTLAST the scope, or deposits would brick after ~30 days
        // while __check_auth still authorizes them. Cover the scope's lifetime (≈5s/ledger)
        // plus a 1-day buffer, floored at the default 30-day TTL for legacy/short scopes.
        let expiration_ledger =
            env.ledger().sequence() + allowance_ttl_ledgers(&env, scope.expiry);
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: scope.token.clone(),
                    fn_name: Symbol::new(&env, "approve"),
                    args: (
                        current.clone(),
                        scope.vault.clone(),
                        scope.cap_per_period,
                        expiration_ledger,
                    )
                        .into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        TokenClient::new(&env, &scope.token).approve(
            &current,
            &scope.vault,
            &scope.cap_per_period,
            &expiration_ledger,
        );
    }

    pub fn scope_of(env: Env) -> AgentScope {
        env.storage().instance().get(&DataKey::Scope).unwrap()
    }

    /// Owner-gated exit. Redeems all of the agent's vault shares and transfers the agent's
    /// whole asset balance to `to`. Authorized by the OWNER (not the session key) and by THIS
    /// contract as invoker for its own redeem/transfer sub-calls. Returns the asset amount
    /// swept to `to`.
    pub fn owner_withdraw(env: Env, to: Address) -> Result<i128, AccountError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AccountError::NotInit)?;
        owner.require_auth();

        let mut scope: AgentScope = env
            .storage()
            .instance()
            .get(&DataKey::Scope)
            .ok_or(AccountError::NotInit)?;
        // Exit is terminal: flip `revoked` so the session key can no longer authorize a
        // funding `pull` into the swept-empty agent (enforce() gates on this flag). Without
        // it, a later relayed pull would strand fresh owner funds in a dead agent whose vault
        // allowance we clear below — a half-alive state.
        if !scope.revoked {
            scope.revoked = true;
            env.storage().instance().set(&DataKey::Scope, &scope);
        }
        let current = env.current_contract_address();
        let vault = scope.vault.clone();
        let token = scope.token.clone();
        let vault_client = VaultClient::new(&env, &vault);
        let token_client = TokenClient::new(&env, &token);

        // 1. Redeem all shares (vault.redeem calls from.require_auth() on the agent → invoker auth).
        let shares = vault_client.balance(&current);
        if shares > 0 {
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: vault.clone(),
                        fn_name: Symbol::new(&env, "redeem"),
                        args: (current.clone(), shares).into_val(&env),
                    },
                    sub_invocations: vec![&env],
                }),
            ]);
            vault_client.redeem(&current, &shares);
        }

        // 2. Sweep the agent's whole asset balance to `to` (token.transfer needs agent auth → invoker).
        let bal = token_client.balance(&current);
        if bal <= 0 {
            return Err(AccountError::NothingToWithdraw);
        }
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (current.clone(), to.clone(), bal).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        token_client.transfer(&current, &to, &bal);

        // 3. Exit also kills the standing vault allowance — a swept agent must
        // leave nothing the vault could still pull.
        clear_vault_allowance(&env, &scope);

        env.storage().instance().extend_ttl(17_280, 518_400);
        Ok(bal)
    }

    /// Owner kill switch. Idempotent: sets `scope.revoked` (the exact flag
    /// `__check_auth` fails closed on), clears the vault token allowance the
    /// constructor granted, and emits `agent_revoked`. After this no session or
    /// exit signature can authorize anything and the vault can pull nothing.
    pub fn revoke(env: Env) -> Result<(), AccountError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AccountError::NotInit)?;
        owner.require_auth();

        let mut scope: AgentScope = env
            .storage()
            .instance()
            .get(&DataKey::Scope)
            .ok_or(AccountError::NotInit)?;
        if !scope.revoked {
            scope.revoked = true;
            env.storage().instance().set(&DataKey::Scope, &scope);
        }
        clear_vault_allowance(&env, &scope);

        AgentRevoked {
            owner,
            agent: env.current_contract_address(),
        }
        .publish(&env);
        env.storage().instance().extend_ttl(17_280, 518_400);
        Ok(())
    }

    pub fn set_exit_signer(env: Env, exit_signer: BytesN<32>) -> Result<(), AccountError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AccountError::NotInit)?;
        owner.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ExitSigner, &exit_signer);
        Ok(())
    }

    pub fn exit_signer(env: Env) -> Result<BytesN<32>, AccountError> {
        env.storage()
            .instance()
            .get(&DataKey::ExitSigner)
            .ok_or(AccountError::NotInit)
    }

    pub fn signer(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Signer).unwrap()
    }

    /// The funding_router that deployed this agent, `None` for legacy direct deploys.
    pub fn router(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Router)
    }

    pub fn version(_env: Env) -> u32 {
        2
    }
}

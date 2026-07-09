#![no_std]
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contractimpl, vec, Address, BytesN, Env, IntoVal, Symbol};

mod account;
mod test;
pub mod types;
pub mod vault_client;

use types::{AccountError, AgentScope, DataKey};
use vault_client::VaultClient;

// Allowance lives this many ledgers (~30 days at 5s) — long enough to outlast any session scope.
const APPROVE_TTL_LEDGERS: u32 = 518_400;

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    /// Deployed once per worker agent. `owner` = the human EOA that granted the
    /// scope; `signer` = the ephemeral ed25519 session pubkey the worker signs with.
    /// The constructor also self-approves the vault to pull up to `cap_per_period` of
    /// the asset, so the deployed vault's `transfer_from(spender=vault, from=agent)`
    /// works without the (deposit-only) session key ever signing an `approve`.
    pub fn __constructor(env: Env, owner: Address, signer: BytesN<32>, scope: AgentScope) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Signer, &signer);
        env.storage().instance().set(&DataKey::Scope, &scope);

        // Invoker-contract auth: authorize THIS contract's own sub-invocation of token.approve.
        // Bypasses __check_auth (that path is reserved for the session key + deposit only).
        let current = env.current_contract_address();
        let expiration_ledger = env.ledger().sequence() + APPROVE_TTL_LEDGERS;
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

        let scope: AgentScope = env
            .storage()
            .instance()
            .get(&DataKey::Scope)
            .ok_or(AccountError::NotInit)?;
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

        env.storage().instance().extend_ttl(17_280, 518_400);
        Ok(bal)
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

    pub fn version(_env: Env) -> u32 {
        2
    }
}

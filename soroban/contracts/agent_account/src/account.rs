use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{contractimpl, symbol_short, Bytes, BytesN, Env, Symbol, TryIntoVal, Vec};

use crate::types::{AccountError, AgentScope, DataKey};
use crate::{AgentAccount, AgentAccountArgs, AgentAccountClient};

const DEPOSIT_FN: Symbol = symbol_short!("deposit");
const TTL_THRESHOLD: u32 = 17_280; // ~1 day at 5s ledgers
const TTL_EXTEND: u32 = 518_400; // ~30 days

/// Enforce the scope for one authorization context set, mutating spent_in_period.
/// Pure of signature concerns — called by __check_auth after the sig passes, and
/// directly by the test shim.
fn enforce(env: &Env, contexts: &Vec<Context>) -> Result<(), AccountError> {
    let mut scope: AgentScope = env
        .storage()
        .instance()
        .get(&DataKey::Scope)
        .ok_or(AccountError::NotInit)?;

    if scope.revoked {
        return Err(AccountError::Revoked);
    }
    let now = env.ledger().timestamp();
    if now >= scope.expiry {
        return Err(AccountError::Expired);
    }

    // Rolling period reset.
    if now >= scope.period_start.saturating_add(scope.period_duration) {
        scope.period_start = now;
        scope.spent_in_period = 0;
    }

    // Validate every context; reject anything not a scoped deposit.
    for ctx in contexts.iter() {
        let cc = match ctx {
            Context::Contract(cc) => cc,
            _ => return Err(AccountError::UnexpectedContexts),
        };
        if cc.contract != scope.vault {
            return Err(AccountError::VaultMismatch);
        }
        if cc.fn_name != DEPOSIT_FN {
            return Err(AccountError::FnNotAllowed);
        }
        // Pinned convention: deposit(from: Address, amount: i128); amount is args[1].
        let amount: i128 = cc
            .args
            .get(1)
            .ok_or(AccountError::UnexpectedContexts)?
            .try_into_val(env)
            .map_err(|_| AccountError::InvalidAmount)?;
        if amount <= 0 {
            return Err(AccountError::InvalidAmount);
        }
        let new_spent = scope
            .spent_in_period
            .checked_add(amount)
            .ok_or(AccountError::CapExceeded)?;
        if new_spent > scope.cap_per_period {
            return Err(AccountError::CapExceeded);
        }
        scope.spent_in_period = new_spent;
    }

    env.storage().instance().set(&DataKey::Scope, &scope);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
    Ok(())
}

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = BytesN<64>;
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let pubkey: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Signer)
            .ok_or(AccountError::NotInit)?;
        let payload: Bytes = signature_payload.into();
        env.crypto().ed25519_verify(&pubkey, &payload, &signature);
        enforce(&env, &auth_contexts)
    }
}

// Test-only shim so unit tests can exercise scope logic without crafting valid
// ed25519 signatures. Compiled only under cfg(test).
#[cfg(test)]
impl AgentAccount {
    pub fn enforce_scope_for_test(env: Env, contexts: Vec<Context>) -> Result<(), AccountError> {
        enforce(&env, &contexts)
    }
}

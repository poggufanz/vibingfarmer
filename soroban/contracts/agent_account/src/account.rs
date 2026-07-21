use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{
    contractimpl, symbol_short, Address, Bytes, BytesN, Env, Symbol, TryIntoVal, Vec,
};

use crate::types::{AccountError, AgentScope, DataKey};
use crate::{AgentAccount, AgentAccountArgs, AgentAccountClient};

const DEPOSIT_FN: Symbol = symbol_short!("deposit");
const PULL_FN: Symbol = symbol_short!("pull");
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

    // funding_router that deployed this agent — absent for legacy direct deploys.
    let router: Option<Address> = env.storage().instance().get(&DataKey::Router);

    // Validate every context; reject anything not a scoped deposit or a funding
    // `pull` on the deploying router.
    for ctx in contexts.iter() {
        let cc = match ctx {
            Context::Contract(cc) => cc,
            _ => return Err(AccountError::UnexpectedContexts),
        };
        // Funding pull on the router that deployed this agent: allowed, and NOT
        // counted toward spent_in_period — cap accounting stays deposit-only;
        // funding is bounded by the owner's SEP-41 allowance at the token level.
        if let Some(ref r) = router {
            if cc.contract == *r {
                if cc.fn_name != PULL_FN {
                    return Err(AccountError::FnNotAllowed);
                }
                continue;
            }
        }
        if cc.contract != scope.target {
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

fn enforce_exit(env: &Env, contexts: &Vec<Context>) -> Result<(), AccountError> {
    let scope: AgentScope = env
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

    let current = env.current_contract_address();

    for ctx in contexts.iter() {
        let cc = match ctx {
            Context::Contract(cc) => cc,
            _ => return Err(AccountError::UnexpectedContexts),
        };
        if cc.contract == scope.target && scope.kind == 0 {
            if cc.fn_name != Symbol::new(env, "redeem") {
                return Err(AccountError::FnNotAllowed);
            }
            let from: Address = cc
                .args
                .get(0)
                .ok_or(AccountError::UnexpectedContexts)?
                .try_into_val(env)
                .map_err(|_| AccountError::UnexpectedContexts)?;
            if from != current {
                return Err(AccountError::NotOwner);
            }
        } else if cc.contract == scope.token {
            if cc.fn_name != Symbol::new(env, "transfer") {
                return Err(AccountError::FnNotAllowed);
            }
            let from: Address = cc
                .args
                .get(0)
                .ok_or(AccountError::UnexpectedContexts)?
                .try_into_val(env)
                .map_err(|_| AccountError::UnexpectedContexts)?;
            let to: Address = cc
                .args
                .get(1)
                .ok_or(AccountError::UnexpectedContexts)?
                .try_into_val(env)
                .map_err(|_| AccountError::UnexpectedContexts)?;
            if from != current {
                return Err(AccountError::NotOwner);
            }
            if to != scope.owner {
                return Err(AccountError::NotOwner);
            }
        } else {
            return Err(AccountError::VaultMismatch);
        }
    }
    Ok(())
}

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Signature = Bytes;
    type Error = AccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: Bytes,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        let payload: Bytes = signature_payload.into();

        if signature.len() == 64 {
            let pubkey: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::Signer)
                .ok_or(AccountError::NotInit)?;
            let sig_bytes: BytesN<64> = signature
                .try_into()
                .map_err(|_| AccountError::BadSignature)?;
            env.crypto().ed25519_verify(&pubkey, &payload, &sig_bytes);
            enforce(&env, &auth_contexts)
        } else if signature.len() == 65 {
            let tag: u8 = signature.get(0).ok_or(AccountError::BadSignature)?;
            let sig_bytes: BytesN<64> = signature
                .slice(1..65)
                .try_into()
                .map_err(|_| AccountError::BadSignature)?;

            if tag == 0 {
                let pubkey: BytesN<32> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Signer)
                    .ok_or(AccountError::NotInit)?;
                env.crypto().ed25519_verify(&pubkey, &payload, &sig_bytes);
                enforce(&env, &auth_contexts)
            } else if tag == 1 {
                let pubkey: BytesN<32> = env
                    .storage()
                    .instance()
                    .get(&DataKey::ExitSigner)
                    .ok_or(AccountError::NotInit)?;
                env.crypto().ed25519_verify(&pubkey, &payload, &sig_bytes);
                enforce_exit(&env, &auth_contexts)
            } else {
                Err(AccountError::BadSignature)
            }
        } else {
            Err(AccountError::BadSignature)
        }
    }
}

// Test-only shim so unit tests can exercise scope logic without crafting valid
// ed25519 signatures. Compiled only under cfg(test).
#[cfg(test)]
impl AgentAccount {
    pub fn enforce_scope_for_test(env: Env, contexts: Vec<Context>) -> Result<(), AccountError> {
        enforce(&env, &contexts)
    }
    pub fn enforce_exit_scope_for_test(
        env: Env,
        contexts: Vec<Context>,
    ) -> Result<(), AccountError> {
        enforce_exit(&env, &contexts)
    }
}

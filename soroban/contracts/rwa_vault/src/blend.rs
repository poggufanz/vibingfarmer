//! Local, version-independent view of the Blend v2 pool contract.
//! We do NOT depend on `blend-contract-sdk` (it pins soroban-sdk 25.0.1; we are on 26.1.0).
//! Cross-contract calls are ABI/XDR-level, so this hand-written client interoperates with
//! the real Blend pool as long as the symbol + arg layout match (verified in Task 7 smoke).
use soroban_sdk::{contractclient, contracttype, Address, Env, Map, Vec};

// Blend v2 request_type discriminants (plain supply-to-earn; collateral/borrow unused).
pub const SUPPLY: u32 = 0;
pub const WITHDRAW: u32 = 1;

/// One action submitted to a Blend pool. `address` is the underlying asset (e.g. USDC).
#[contracttype]
#[derive(Clone)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

/// Blend's per-user position bundle. The vault ignores the contents; the type only needs
/// to decode without error. Keyed by reserve index.
#[contracttype]
#[derive(Clone)]
pub struct Positions {
    pub liabilities: Map<u32, i128>,
    pub collateral: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

// The trait exists only to generate `BlendPoolClient` (used by `supply`/`withdraw`); the
// trait name itself is never referenced, so silence the dead-code lint on it.
#[allow(dead_code)]
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    /// Pulls tokens from `from` via a pre-approved allowance (`from` must `approve` the pool
    /// first). `spender`/`to` are the pool's accounting/recipient address — the vault passes
    /// its own address for all three.
    fn submit_with_allowance(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
}

use soroban_sdk::{token::TokenClient, vec};

const APPROVE_TTL: u32 = 100; // ledgers the pool allowance stays live (consumed same tx)

/// Vault supplies `amount` of `token` into the Blend `pool`. Approves the pool to pull
/// from the vault, then submits a SUPPLY request. Vault is from/spender/to.
pub fn supply(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let vault = e.current_contract_address();
    let exp = e.ledger().sequence() + APPROVE_TTL;
    TokenClient::new(e, token).approve(&vault, pool, &amount, &exp);
    let reqs = vec![
        e,
        Request { request_type: SUPPLY, address: token.clone(), amount },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&vault, &vault, &vault, &reqs);
}

/// Vault withdraws `amount` of `token` from the Blend `pool` back to itself.
/// Blend caps the withdrawal at the vault's available position.
pub fn withdraw(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let vault = e.current_contract_address();
    let reqs = vec![
        e,
        Request { request_type: WITHDRAW, address: token.clone(), amount },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&vault, &vault, &vault, &reqs);
}

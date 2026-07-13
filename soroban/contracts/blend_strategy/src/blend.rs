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

/// Blend's per-user position bundle, keyed by reserve index. `supply` holds bTokens.
#[contracttype]
#[derive(Clone)]
pub struct Positions {
    pub liabilities: Map<u32, i128>,
    pub collateral: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

/// Blend v2 fixed-point scale for `b_rate`/`d_rate` (the pool's SCALAR_12).
pub const SCALAR_12: i128 = 1_000_000_000_000;

/// Exact mirror of Blend v2 `ReserveConfig` (pool/src/storage.rs) — field list must match
/// for the map-keyed contracttype decode to succeed.
#[contracttype]
#[derive(Clone)]
pub struct ReserveConfig {
    pub index: u32,
    pub decimals: u32,
    pub c_factor: u32,
    pub l_factor: u32,
    pub util: u32,
    pub max_util: u32,
    pub r_base: u32,
    pub r_one: u32,
    pub r_two: u32,
    pub r_three: u32,
    pub reactivity: u32,
    pub supply_cap: i128,
    pub enabled: bool,
}

/// Exact mirror of Blend v2 `ReserveData` (pool/src/storage.rs). `b_rate` converts bTokens
/// to underlying at SCALAR_12 fixed point.
#[contracttype]
#[derive(Clone)]
pub struct ReserveData {
    pub d_rate: i128,
    pub b_rate: i128,
    pub ir_mod: i128,
    pub b_supply: i128,
    pub d_supply: i128,
    pub backstop_credit: i128,
    pub last_time: u64,
}

/// Exact mirror of Blend v2 `Reserve` (pool/src/pool/reserve.rs) — `get_reserve`'s return.
#[contracttype]
#[derive(Clone)]
pub struct Reserve {
    pub asset: Address,
    pub config: ReserveConfig,
    pub data: ReserveData,
    pub scalar: i128,
}

// The trait exists only to generate `BlendPoolClient` (used by `supply`/`withdraw`/`claim`);
// the trait name itself is never referenced, so silence the dead-code lint on it.
#[allow(dead_code)]
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    /// Pulls tokens from `from` via a pre-approved allowance (`from` must `approve` the pool
    /// first). `spender`/`to` are the pool's accounting/recipient address — the strategy
    /// passes its own address for all three.
    fn submit_with_allowance(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;

    /// Claims pending BLND emissions for `from`'s positions in the given reserves, crediting
    /// `to`. Returns the amount claimed. Testnet pools may have emissions disabled, in which
    /// case this traps — `harvest` wraps the call in `try_claim` so that's best-effort.
    fn claim(e: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;

    /// Live per-user positions (bTokens keyed by reserve index).
    fn get_positions(e: Env, address: Address) -> Positions;

    /// Live reserve state for `asset` — `data.b_rate` is the bToken → underlying rate.
    fn get_reserve(e: Env, asset: Address) -> Reserve;
}

use crate::types::StrategyError;
use stellar_contract_utils::math::i128_fixed_point;

/// The strategy's live (b_tokens, b_rate) for `token`'s reserve, read from the pool's own
/// books. Fail-closed: a negative position or rate is malformed reserve data.
pub fn live_position(e: &Env, pool: &Address, token: &Address) -> Result<(i128, i128), StrategyError> {
    let me = e.current_contract_address();
    let client = BlendPoolClient::new(e, pool);
    let reserve = client.get_reserve(token);
    let positions = client.get_positions(&me);
    let b_tokens = positions.supply.get(reserve.config.index).unwrap_or(0);
    let b_rate = reserve.data.b_rate;
    if b_tokens < 0 || b_rate < 0 {
        return Err(StrategyError::InvalidReserveData);
    }
    Ok((b_tokens, b_rate))
}

/// floor(b_tokens * b_rate / SCALAR_12) — live underlying NAV. Overflow-safe (I256 inside);
/// an impossible fixed-point result is malformed reserve data, never a trap.
pub fn to_underlying_floor(e: &Env, b_tokens: i128, b_rate: i128) -> Result<i128, StrategyError> {
    i128_fixed_point::checked_mul_div_floor(e, &b_tokens, &b_rate, &SCALAR_12)
        .ok_or(StrategyError::InvalidReserveData)
}

/// ceil variant — used to size a FULL-DRAIN withdrawal request so conservative rounding
/// covers the whole position (Blend caps at the live position anyway).
pub fn to_underlying_ceil(e: &Env, b_tokens: i128, b_rate: i128) -> Result<i128, StrategyError> {
    i128_fixed_point::checked_mul_div_ceil(e, &b_tokens, &b_rate, &SCALAR_12)
        .ok_or(StrategyError::InvalidReserveData)
}

use soroban_sdk::{token::TokenClient, vec};

const APPROVE_TTL: u32 = 100; // ledgers the pool allowance stays live (consumed same tx)

/// Strategy supplies `amount` of `token` into the Blend `pool`. Approves the pool to pull
/// from itself, then submits a SUPPLY request. The strategy is from/spender/to.
pub fn supply(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let me = e.current_contract_address();
    let exp = e.ledger().sequence() + APPROVE_TTL;
    TokenClient::new(e, token).approve(&me, pool, &amount, &exp);
    let reqs = vec![
        e,
        Request {
            request_type: SUPPLY,
            address: token.clone(),
            amount,
        },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&me, &me, &me, &reqs);
}

/// Strategy withdraws `amount` of `token` from the Blend `pool` back to itself.
/// Blend caps the withdrawal at the strategy's available position.
pub fn withdraw(e: &Env, pool: &Address, token: &Address, amount: i128) {
    let me = e.current_contract_address();
    let reqs = vec![
        e,
        Request {
            request_type: WITHDRAW,
            address: token.clone(),
            amount,
        },
    ];
    BlendPoolClient::new(e, pool).submit_with_allowance(&me, &me, &me, &reqs);
}

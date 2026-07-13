#![cfg(test)]
use crate::types::{StrategyError, StrategyHarvest};
use crate::{BlendStrategy, BlendStrategyClient};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, Address, Env, Event, Map, Vec};

use crate::blend::{
    Positions, Request, Reserve, ReserveConfig, ReserveData, SCALAR_12, SUPPLY, WITHDRAW,
};

// Faithful in-test stand-in for a Blend v2 pool: positions are tracked in bTOKENS and the
// reserve carries a settable `b_rate` (SCALAR_12 fixed point), exactly like the real pool.
// `credit_yield`/`haircut_position` move the rate (how yield/bad debt actually manifest);
// the WITHDRAW leg converts an underlying request to bTokens with ceil rounding — which
// OVERFLOWS on an i128::MAX request just like the real pool's to_b_token math (the bug the
// hardened strategy must never trigger).
#[contract]
pub struct MockBlendPool;

#[contractimpl]
impl MockBlendPool {
    pub fn __constructor(e: &Env, token: Address, reserve_index: u32) {
        e.storage().instance().set(&MOCK_TOKEN, &token);
        e.storage().instance().set(&MOCK_INDEX, &reserve_index);
        e.storage().instance().set(&MOCK_BRATE, &SCALAR_12);
    }

    pub fn submit_with_allowance(
        e: &Env,
        from: Address,
        _spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        let token: Address = e.storage().instance().get(&MOCK_TOKEN).unwrap();
        let pool = e.current_contract_address();
        let rate: i128 = e.storage().instance().get(&MOCK_BRATE).unwrap();
        for req in requests.iter() {
            if req.request_type == SUPPLY {
                TokenClient::new(e, &token).transfer_from(&pool, &from, &pool, &req.amount);
                // ceil so the round-trip value math in tests stays exact.
                let minted = (req.amount * SCALAR_12 + rate - 1) / rate;
                let b = mock_btokens(e, &from) + minted;
                e.storage()
                    .persistent()
                    .set(&MockKey::BTokens(from.clone()), &b);
                e.storage().instance().set(&MOCK_SUPPLIER, &from);
            } else if req.request_type == WITHDRAW {
                if rate <= 0 {
                    panic!("mock pool: zero b_rate");
                }
                // Real Blend converts the underlying request to bTokens — an i128::MAX
                // request overflows here exactly like the real pool's fixed-point math.
                let want_b = (req
                    .amount
                    .checked_mul(SCALAR_12)
                    .expect("mock pool: b_token math overflow")
                    + rate
                    - 1)
                    / rate;
                let held = mock_btokens(e, &from);
                let burn = if want_b > held { held } else { want_b };
                let out = burn * rate / SCALAR_12;
                if out > 0 {
                    TokenClient::new(e, &token).transfer(&pool, &to, &out);
                }
                e.storage()
                    .persistent()
                    .set(&MockKey::BTokens(from.clone()), &(held - burn));
            }
        }
        Positions {
            liabilities: Map::new(e),
            collateral: Map::new(e),
            supply: Map::new(e),
        }
    }

    pub fn get_positions(e: &Env, address: Address) -> Positions {
        let index: u32 = e.storage().instance().get(&MOCK_INDEX).unwrap();
        let mut supply = Map::new(e);
        let b = mock_btokens(e, &address);
        if b != 0 {
            supply.set(index, b);
        }
        Positions {
            liabilities: Map::new(e),
            collateral: Map::new(e),
            supply,
        }
    }

    pub fn get_reserve(e: &Env, asset: Address) -> Reserve {
        let index: u32 = e.storage().instance().get(&MOCK_INDEX).unwrap();
        let rate: i128 = e.storage().instance().get(&MOCK_BRATE).unwrap();
        Reserve {
            asset,
            config: ReserveConfig {
                index,
                decimals: 7,
                c_factor: 0,
                l_factor: 0,
                util: 0,
                max_util: 0,
                r_base: 0,
                r_one: 0,
                r_two: 0,
                r_three: 0,
                reactivity: 0,
                supply_cap: 0,
                enabled: true,
            },
            data: ReserveData {
                d_rate: SCALAR_12,
                b_rate: rate,
                ir_mod: 0,
                b_supply: 0,
                d_supply: 0,
                backstop_credit: 0,
                last_time: 0,
            },
            scalar: 10_000_000,
        }
    }

    /// Test-only: force the reserve's b_rate (hostile/edge reserve data).
    pub fn set_b_rate(e: &Env, v: i128) {
        e.storage().instance().set(&MOCK_BRATE, &v);
    }

    /// Test-only: force a raw bToken position (hostile/edge position data).
    pub fn set_position(e: &Env, who: Address, b_tokens: i128) {
        e.storage().persistent().set(&MockKey::BTokens(who), &b_tokens);
    }

    /// Test-only: simulate Blend interest accruing — mints `amount` into the pool and
    /// RAISES b_rate so the sole supplier's live position value grows by `amount`.
    pub fn credit_yield(e: &Env, amount: i128) {
        let token: Address = e.storage().instance().get(&MOCK_TOKEN).unwrap();
        let pool = e.current_contract_address();
        StellarAssetClient::new(e, &token).mint(&pool, &amount);

        let supplier: Address = e.storage().instance().get(&MOCK_SUPPLIER).unwrap();
        let b = mock_btokens(e, &supplier);
        let rate: i128 = e.storage().instance().get(&MOCK_BRATE).unwrap();
        let value = b * rate / SCALAR_12;
        let new_rate = (value + amount) * SCALAR_12 / b;
        e.storage().instance().set(&MOCK_BRATE, &new_rate);
    }

    /// Test-only: simulate socialized bad debt — LOWERS b_rate so the sole supplier's live
    /// position value shrinks by `amount` (no tokens move; `b_rate` drops below par).
    pub fn haircut_position(e: &Env, amount: i128) {
        let supplier: Address = e.storage().instance().get(&MOCK_SUPPLIER).unwrap();
        let b = mock_btokens(e, &supplier);
        let rate: i128 = e.storage().instance().get(&MOCK_BRATE).unwrap();
        let value = b * rate / SCALAR_12;
        let new_rate = (value - amount) * SCALAR_12 / b;
        e.storage().instance().set(&MOCK_BRATE, &new_rate);
    }

    /// Test-only: turn on BLND emissions. Subsequent `claim` calls mint `amount` mock-BLND to
    /// the caller instead of trapping. Mirrors the real testnet pool's emissions-off default
    /// (task-1 spike) — tests that never call this exercise the trap-and-swallow path that
    /// `harvest`'s `try_claim` relies on.
    pub fn enable_emissions(e: &Env, blnd: Address, amount: i128) {
        e.storage().instance().set(&MOCK_EMIT_BLND, &blnd);
        e.storage().instance().set(&MOCK_EMIT_AMOUNT, &amount);
        e.storage().instance().set(&MOCK_EMIT_ON, &true);
    }

    /// Mirrors Blend v2's `claim`. Mints the configured emission amount to `to` when emissions
    /// are enabled; traps otherwise — the real testnet pool's behavior when emissions are off.
    pub fn claim(e: &Env, _from: Address, _reserve_token_ids: Vec<u32>, to: Address) -> i128 {
        let on: bool = e.storage().instance().get(&MOCK_EMIT_ON).unwrap_or(false);
        if !on {
            panic!("mock pool: emissions disabled");
        }
        let blnd: Address = e.storage().instance().get(&MOCK_EMIT_BLND).unwrap();
        let amount: i128 = e.storage().instance().get(&MOCK_EMIT_AMOUNT).unwrap();
        StellarAssetClient::new(e, &blnd).mint(&to, &amount);
        amount
    }
}

const MOCK_TOKEN: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MTOKEN");
const MOCK_SUPPLIER: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MSUPPL");
const MOCK_INDEX: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MINDEX");
const MOCK_BRATE: soroban_sdk::Symbol = soroban_sdk::symbol_short!("MBRATE");
const MOCK_EMIT_ON: soroban_sdk::Symbol = soroban_sdk::symbol_short!("EMITON");
const MOCK_EMIT_BLND: soroban_sdk::Symbol = soroban_sdk::symbol_short!("EMITBL");
const MOCK_EMIT_AMOUNT: soroban_sdk::Symbol = soroban_sdk::symbol_short!("EMITAMT");

#[soroban_sdk::contracttype]
enum MockKey {
    BTokens(Address),
}

fn mock_btokens(e: &Env, who: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&MockKey::BTokens(who.clone()))
        .unwrap_or(0)
}

// Minimal in-test stand-in for a Soroswap router. Uses a fixed BLND -> token rate by default;
// `set_next_output` overrides the next swap's output regardless of that rate, which is how the
// slippage-revert test forces a payout below `amount_out_min` deterministically (mirrors how
// the real router reverts when a trade would pay out less than the caller's floor).
#[contract]
pub struct MockSoroswapRouter;

#[contractimpl]
impl MockSoroswapRouter {
    pub fn __constructor(e: &Env, blnd: Address, token: Address, rate_num: i128, rate_den: i128) {
        e.storage().instance().set(&ROUTER_BLND, &blnd);
        e.storage().instance().set(&ROUTER_TOKEN, &token);
        e.storage().instance().set(&ROUTER_RATE_NUM, &rate_num);
        e.storage().instance().set(&ROUTER_RATE_DEN, &rate_den);
    }

    /// Test-only: force the next swap's output regardless of the configured rate.
    pub fn set_next_output(e: &Env, amount: i128) {
        e.storage().instance().set(&ROUTER_OVERRIDE, &amount);
    }

    pub fn swap_exact_tokens_for_tokens(
        e: &Env,
        amount_in: i128,
        amount_out_min: i128,
        _path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        let router = e.current_contract_address();
        let override_out: Option<i128> = e.storage().instance().get(&ROUTER_OVERRIDE);
        let amount_out = match override_out {
            Some(v) => v,
            None => {
                let num: i128 = e.storage().instance().get(&ROUTER_RATE_NUM).unwrap();
                let den: i128 = e.storage().instance().get(&ROUTER_RATE_DEN).unwrap();
                amount_in * num / den
            }
        };
        if amount_out < amount_out_min {
            panic!("mock router: slippage");
        }

        let blnd: Address = e.storage().instance().get(&ROUTER_BLND).unwrap();
        let token: Address = e.storage().instance().get(&ROUTER_TOKEN).unwrap();
        TokenClient::new(e, &blnd).transfer_from(&router, &to, &router, &amount_in);
        StellarAssetClient::new(e, &token).mint(&to, &amount_out);

        let mut out = Vec::new(e);
        out.push_back(amount_in);
        out.push_back(amount_out);
        out
    }
}

const ROUTER_BLND: soroban_sdk::Symbol = soroban_sdk::symbol_short!("RBLND");
const ROUTER_TOKEN: soroban_sdk::Symbol = soroban_sdk::symbol_short!("RTOKEN");
const ROUTER_RATE_NUM: soroban_sdk::Symbol = soroban_sdk::symbol_short!("RNUM");
const ROUTER_RATE_DEN: soroban_sdk::Symbol = soroban_sdk::symbol_short!("RDEN");
const ROUTER_OVERRIDE: soroban_sdk::Symbol = soroban_sdk::symbol_short!("ROVER");

const U7: i128 = 10_000_000; // 1.0 unit at 7 decimals

pub(crate) struct Ctx {
    pub strategy: BlendStrategyClient<'static>,
    pub vault: Address,
    pub token: Address,
    pub pool: Address,
    pub blnd: Address,
    pub router: Address,
}

// Deploys a mock SAC token, a mock Blend pool wired to it, a mock BLND SAC + Soroswap router,
// and the strategy wired to all of them. `vault` is a plain generated address standing in for
// the real vault (Task 7 wires it for real); mints it 1000 USDC and approves the strategy to
// pull on deposit, matching the "vault approves strategy before deposit" contract noted in the
// task brief.
fn setup(e: &Env) -> Ctx {
    // `_allowing_non_root_auth`: `credit_yield`/`claim`/the mock router all mint via
    // `StellarAssetClient` from *inside* a nested contract call, so the SAC's admin auth is
    // nested one level below the top-level invocation — plain `mock_all_auths` rejects that as
    // "not tied to the root contract invocation".
    e.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    // Reserve index 7 — must match the strategy's constructor `reserve_token_id` below.
    let pool = e.register(MockBlendPool, (token.clone(), 7u32));

    let vault = Address::generate(e);

    let blnd_admin = Address::generate(e);
    let blnd_sac = e.register_stellar_asset_contract_v2(blnd_admin);
    let blnd = blnd_sac.address();

    // Fixed 1:10 BLND -> token rate (e.g. 50 BLND -> 5 token); individual tests override the
    // output via `set_next_output` when they need a specific number (slippage path).
    let router = e.register(
        MockSoroswapRouter,
        (blnd.clone(), token.clone(), 1i128, 10i128),
    );

    let strategy_id = e.register(
        BlendStrategy,
        (
            vault.clone(),
            pool.clone(),
            token.clone(),
            blnd.clone(),
            router.clone(),
            7u32,
        ),
    );

    StellarAssetClient::new(e, &token).mint(&vault, &(1_000 * U7));
    let exp = e.ledger().sequence() + 100_000;
    TokenClient::new(e, &token).approve(&vault, &strategy_id, &(1_000 * U7), &exp);

    Ctx {
        strategy: BlendStrategyClient::new(e, &strategy_id),
        vault,
        token,
        pool,
        blnd,
        router,
    }
}

#[test]
fn deposit_pulls_from_vault_and_supplies_pool() {
    let e = Env::default();
    let ctx = setup(&e);

    ctx.strategy.deposit(&(100 * U7));

    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.pool),
        100 * U7
    );
    assert_eq!(ctx.strategy.balance(), 100 * U7);
}

#[test]
fn withdraw_returns_actual_and_decrements_principal() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let got = ctx.strategy.withdraw(&(40 * U7));

    assert_eq!(got, 40 * U7);
    assert_eq!(ctx.strategy.balance(), 60 * U7);
    // vault: 1000 - 100 (deposit) + 40 (withdraw) = 940
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        940 * U7
    );
}

#[test]
fn withdraw_max_drains() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let got = ctx.strategy.withdraw(&i128::MAX);

    assert_eq!(got, 100 * U7);
    assert_eq!(ctx.strategy.balance(), 0);
}

#[test]
fn deposit_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    // Strip the blanket auth mock: deposit's `vault.require_auth()` now has no matching
    // authorization entry for the stored vault address, so the call must fail closed.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_deposit(&(10 * U7)).is_err());
}

#[test]
fn deposit_rejects_non_positive_amount() {
    let e = Env::default();
    let ctx = setup(&e);

    assert_eq!(
        ctx.strategy.try_deposit(&0),
        Err(Ok(StrategyError::InvalidAmount))
    );
    assert_eq!(
        ctx.strategy.try_deposit(&-1),
        Err(Ok(StrategyError::InvalidAmount))
    );
    // Neither rejected call moved any funds or touched book principal.
    assert_eq!(ctx.strategy.balance(), 0);
}

#[test]
fn withdraw_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    // Same auth gate as deposit — withdraw's `vault.require_auth()` must also fail closed
    // once the blanket auth mock is stripped.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_withdraw(&(10 * U7)).is_err());
}

#[test]
fn withdraw_rejects_non_positive_amount_but_max_still_drains() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    assert_eq!(
        ctx.strategy.try_withdraw(&0),
        Err(Ok(StrategyError::InvalidAmount))
    );
    assert_eq!(
        ctx.strategy.try_withdraw(&-1),
        Err(Ok(StrategyError::InvalidAmount))
    );
    // Book principal untouched by the rejected calls.
    assert_eq!(ctx.strategy.balance(), 100 * U7);

    // The i128::MAX drain sentinel is a large positive value — exempt from the `amount <= 0`
    // guard above — and must still fully drain the position.
    let got = ctx.strategy.withdraw(&i128::MAX);
    assert_eq!(got, 100 * U7);
    assert_eq!(ctx.strategy.balance(), 0);
}

#[test]
fn harvest_realizes_interest_and_forwards_to_vault() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.credit_yield(&(7 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 7 * U7);
    // vault: 1000 - 100 (deposit) + 7 (harvested interest) = 907
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        907 * U7
    );
    // Principal re-supplied in full — book balance unchanged by harvest.
    assert_eq!(ctx.strategy.balance(), 100 * U7);
}

#[test]
fn harvest_zero_interest_returns_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    assert_eq!(ctx.strategy.balance(), 100 * U7);
    // vault: 1000 - 100 (deposit), untouched by a zero-gain harvest.
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7
    );
}

#[test]
fn harvest_marks_down_principal_on_shortfall() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    // Pool lost 10 to socialized bad debt — withdraw-all now returns only 90 of the 100
    // book principal.
    pool.haircut_position(&(10 * U7));

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    // No gain to forward — vault balance untouched by a shortfall harvest.
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7
    );
    // Marked down to what was actually recovered (90), not still overstating 100.
    assert_eq!(ctx.strategy.balance(), 90 * U7);
}

#[test]
fn harvest_zero_principal_returns_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    // No deposit — principal is 0, harvest should short-circuit before touching Blend.

    let harvested = ctx.strategy.harvest(&0);

    assert_eq!(harvested, 0);
    assert_eq!(ctx.strategy.balance(), 0);
    // Early-return path never reaches `.publish()` — no event side effects.
    assert_eq!(e.events().all().events().len(), 0);
}

#[test]
fn harvest_rejects_non_vault_caller() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    // Same auth gate as deposit/withdraw — harvest's `vault.require_auth()` must also fail
    // closed once the blanket auth mock is stripped.
    e.set_auths(&[]);

    assert!(ctx.strategy.try_harvest(&0).is_err());
}

#[test]
fn harvest_claims_blnd_and_swaps_to_usdc() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.enable_emissions(&ctx.blnd, &(50 * U7));

    // Router's fixed 1:10 rate pays 50 BLND -> 5 token; floor comfortably under that.
    let harvested = ctx.strategy.harvest(&(4 * U7));

    assert_eq!(harvested, 5 * U7); // no Blend interest this round — pure swap proceeds
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        905 * U7 // 1000 - 100 (deposit) + 5 (swap proceeds)
    );
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        0 // fully swapped — nothing held
    );
    assert_eq!(ctx.strategy.balance(), 100 * U7); // principal re-supplied in full
}

#[test]
fn harvest_holds_blnd_when_min_out_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.enable_emissions(&ctx.blnd, &(50 * U7));

    let harvested = ctx.strategy.harvest(&0); // min_out == 0 -> hold, never swap

    assert_eq!(harvested, 0); // no interest, no swap proceeds forwarded
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        50 * U7 // claimed BLND stays on the strategy
    );
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7 // unchanged by a zero-proceeds harvest
    );
    assert_eq!(ctx.strategy.balance(), 100 * U7);
}

#[test]
fn harvest_survives_no_emissions() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.credit_yield(&(7 * U7)); // ordinary Blend interest; emissions never enabled

    // min_out > 0 but there's no BLND to swap: claim traps (emissions disabled), `try_claim`
    // swallows it, and the swap gate (`blnd_claimed > 0`) never opens.
    let harvested = ctx.strategy.harvest(&U7);

    assert_eq!(harvested, 7 * U7);
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        0
    );
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        907 * U7 // 1000 - 100 (deposit) + 7 (interest)
    );
}

#[test]
fn swap_slippage_reverts_whole_harvest() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.enable_emissions(&ctx.blnd, &(50 * U7));

    let router = MockSoroswapRouterClient::new(&e, &ctx.router);
    router.set_next_output(&U7); // force a bad quote — below any reasonable floor

    // The swap call is NOT wrapped in try_ (unlike claim) — a slippage revert must abort the
    // whole harvest, so nothing (withdraw, claim, resupply) survives partially.
    let result = ctx.strategy.try_harvest(&(2 * U7));

    assert!(result.is_err());
    assert_eq!(ctx.strategy.balance(), 100 * U7); // book principal untouched by the revert
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        900 * U7 // no partial transfer landed
    );
}

#[test]
fn harvest_blnd_claimed_reports_round_delta_not_carryover() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);

    // Round 1: 30 BLND emitted, held on the strategy (min_out == 0 -> no swap). Nothing was
    // carried over before this round, so the claim delta equals the full claimed balance.
    pool.enable_emissions(&ctx.blnd, &(30 * U7));
    let harvested1 = ctx.strategy.harvest(&0);
    // `events().all()` reflects only the LAST contract invocation — capture it immediately,
    // before any other client call (even a read-only `balance()`) becomes the new "last".
    let events1 = e.events().all();

    assert_eq!(harvested1, 0);
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        30 * U7 // held, not swapped
    );
    // `.last()` — our custom event publishes after the internal resupply/transfer calls, so it
    // sorts last among this invocation's events (published in call order).
    let event1 = events1.events().last().unwrap();
    let expected1 = StrategyHarvest {
        interest: 0,
        blnd_claimed: 30 * U7,
        blnd_swapped: 0,
        usdc_out: 0,
        blnd_held: 30 * U7,
    }
    .to_xdr(&e, &ctx.strategy.address);
    assert_eq!(event1, &expected1);

    // Round 2: a NEW 20 BLND is emitted on top of the 30 held over from round one (50 total on
    // the strategy). min_out > 0 triggers the swap, which sweeps the FULL 50 BLND balance — but
    // the event's `blnd_claimed` must report only this round's delta (20), never the
    // accumulated 50.
    pool.enable_emissions(&ctx.blnd, &(20 * U7));
    let harvested2 = ctx.strategy.harvest(&U7); // floor of 1 token, well under the 5-token payout
    let events2 = e.events().all();

    assert_eq!(harvested2, 5 * U7); // 50 BLND * 1/10 router rate
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        0 // fully swept by the swap — the whole 50, not just this round's 20
    );
    let event2 = events2.events().last().unwrap();
    let expected2 = StrategyHarvest {
        interest: 0,
        blnd_claimed: 20 * U7, // this round's delta — NOT the accumulated 50
        blnd_swapped: 5 * U7,
        usdc_out: 5 * U7,
        blnd_held: 0,
    }
    .to_xdr(&e, &ctx.strategy.address);
    assert_eq!(event2, &expected2);
}

#[test]
fn harvest_sweeps_held_blnd_after_principal_drained_to_zero() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    let pool = MockBlendPoolClient::new(&e, &ctx.pool);
    pool.enable_emissions(&ctx.blnd, &(50 * U7));

    // Round 1: min_out == 0 -> claim 50 BLND and hold it (no swap). Principal is re-supplied in
    // full, so `balance()` is untouched.
    let harvested1 = ctx.strategy.harvest(&0);
    assert_eq!(harvested1, 0);
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        50 * U7
    );
    assert_eq!(ctx.strategy.balance(), 100 * U7);

    // Drain the Blend position to 0 (e.g. rebalance-to-idle or emergency_withdraw) — the 50
    // held BLND from round 1 is untouched by this, since withdraw only moves the underlying
    // token.
    let got = ctx.strategy.withdraw(&i128::MAX);
    assert_eq!(got, 100 * U7);
    assert_eq!(ctx.strategy.balance(), 0);

    // Round 2: principal == 0 -> the withdraw-all/claim legs are skipped entirely (nothing to
    // pull or claim against), but the strategy still holds 50 BLND from round 1, so the
    // swap+forward leg runs when the caller opts in via `min_out > 0`. Router's fixed 1:10 rate
    // pays 50 BLND -> 5 token; floor comfortably under that.
    let harvested2 = ctx.strategy.harvest(&(4 * U7));
    // `events().all()` reflects only the LAST contract invocation — capture it immediately,
    // before any other client call (even a read-only `balance()`) becomes the new "last".
    let event2 = e.events().all();

    assert_eq!(harvested2, 5 * U7); // held BLND converted to USDC and forwarded as gain
    assert_eq!(ctx.strategy.balance(), 0); // still no Blend position — nothing to resupply
    assert_eq!(
        TokenClient::new(&e, &ctx.blnd).balance(&ctx.strategy.address),
        0 // fully swept — nothing held
    );
    // vault: 1000 - 100 (deposit) + 100 (drain withdraw) + 5 (swept BLND swap proceeds) = 1005
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        1005 * U7
    );

    let expected2 = StrategyHarvest {
        interest: 0,     // no live Blend position this round — nothing to realize
        blnd_claimed: 0, // no claim leg run — principal was 0
        blnd_swapped: 5 * U7,
        usdc_out: 5 * U7,
        blnd_held: 0,
    }
    .to_xdr(&e, &ctx.strategy.address);
    assert_eq!(event2.events().last().unwrap(), &expected2);
}

// ===== security hardening Task 5: live NAV + finite drain =====

#[test]
fn balance_reflects_live_yield() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    assert_eq!(ctx.strategy.balance(), 100 * U7);

    // Yield accrues in the pool (b_rate rises) — live NAV must see it WITHOUT a harvest.
    MockBlendPoolClient::new(&e, &ctx.pool).credit_yield(&(7 * U7));
    assert_eq!(ctx.strategy.balance(), 107 * U7);
}

#[test]
fn balance_reflects_bad_debt() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    // Socialized bad debt (b_rate below par) must lower NAV — book principal would lie.
    MockBlendPoolClient::new(&e, &ctx.pool).haircut_position(&(10 * U7));
    assert_eq!(ctx.strategy.balance(), 90 * U7);
}

#[test]
fn full_withdraw_succeeds_when_b_rate_below_par() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    MockBlendPoolClient::new(&e, &ctx.pool).haircut_position(&(10 * U7)); // b_rate = 0.9e12

    // The confirmed overflow: an i128::MAX underlying request trips the pool's
    // to-bToken fixed-point math when b_rate < 1e12. The hardened strategy sizes a
    // FINITE request from the live position instead.
    let got = ctx.strategy.withdraw(&i128::MAX);

    assert_eq!(got, 90 * U7);
    assert_eq!(ctx.strategy.balance(), 0);
    // vault: 1000 - 100 (deposit) + 90 (recovered) = 990
    assert_eq!(
        TokenClient::new(&e, &ctx.token).balance(&ctx.vault),
        990 * U7
    );
}

#[test]
fn zero_b_rate_reads_zero_and_drain_is_a_noop() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));

    // A zeroed rate values the position at 0 — read must be clean, and a drain must
    // NOT call the pool (whose withdraw math would divide by zero).
    MockBlendPoolClient::new(&e, &ctx.pool).set_b_rate(&0);
    assert_eq!(ctx.strategy.balance(), 0);
    assert_eq!(ctx.strategy.withdraw(&i128::MAX), 0);
}

#[test]
fn finite_withdraw_cannot_hide_residual_yield() {
    let e = Env::default();
    let ctx = setup(&e);
    ctx.strategy.deposit(&(100 * U7));
    MockBlendPoolClient::new(&e, &ctx.pool).credit_yield(&(7 * U7)); // b_rate = 1.07e12

    // Withdraw exactly the book principal: got == 100, principal -> 0, but ~7 of live
    // yield remains in the pool. Book-based balance() would report 0 — invisible dust.
    let got = ctx.strategy.withdraw(&(100 * U7));
    assert_eq!(got, 100 * U7);
    let residual = 7 * U7 - 1; // floor rounding of the leftover bTokens at 1.07e12
    assert_eq!(ctx.strategy.balance(), residual);

    // Harvest is position-aware (live map, not principal): the dust is realized and
    // forwarded to the vault, never stranded.
    let harvested = ctx.strategy.harvest(&0);
    assert_eq!(harvested, residual);
    assert_eq!(ctx.strategy.balance(), 0);
}

#[test]
fn malformed_reserve_data_fails_closed() {
    let e = Env::default();
    let ctx = setup(&e);
    let pool = MockBlendPoolClient::new(&e, &ctx.pool);

    // Negative position: clean InvalidReserveData, not garbage NAV.
    pool.set_position(&ctx.strategy.address, &-5);
    assert_eq!(
        ctx.strategy.try_balance(),
        Err(Ok(StrategyError::InvalidReserveData))
    );

    // Astronomical values whose product exceeds i128: overflow-safe math reports
    // InvalidReserveData instead of trapping.
    pool.set_position(&ctx.strategy.address, &i128::MAX);
    pool.set_b_rate(&i128::MAX);
    assert_eq!(
        ctx.strategy.try_balance(),
        Err(Ok(StrategyError::InvalidReserveData))
    );
}

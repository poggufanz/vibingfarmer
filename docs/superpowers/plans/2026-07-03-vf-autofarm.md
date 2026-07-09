# VF Autofarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-compounding, BLND reward harvesting (claim + swap→USDC), and auto-rebalancing across two Blend pools, driven by a Cloudflare Worker cron keeper.

**Architecture:** Approach B — the vault becomes a share-ledger/router with exchange-rate pricing; per-venue `blend_strategy` contracts (2 instances) hold Blend positions and implement `deposit/withdraw/balance/harvest`. A keeper Worker reads on-chain APR/emissions state every 15 min and calls keeper-gated `compound`/`rebalance`. Spec: `docs/superpowers/specs/2026-07-03-vf-autofarm-design.md`.

**Tech Stack:** Soroban Rust (soroban-sdk 26.1.0, OZ stellar-contracts as in repo), hand-written XDR-level clients (`blend.rs` pattern), Cloudflare Worker (`nodejs_compat`, `@stellar/stellar-sdk`), React/Vite frontend, vitest, vite-node smoke.

## Global Constraints

- Branch: `feature/autofarm` off `feature/api-gate`. Keep LOCAL — never push, never merge without user.
- NEVER `git add -A` / `git add .` — `planning/` and `docs/superpowers/` must stay uncommitted (repo rule; gitignore does NOT actually cover them). Stage files explicitly.
- Soroban toolchain runs **WSL only**: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && <cmd>"`. Frontend/keeper tooling runs **Windows PowerShell** (rollup win32 binary — never WSL).
- Rust gates per task: `cargo test` green AND `cargo clippy --all-targets -- -D warnings` clean. `cargo fmt` before each commit.
- Frontend gate: `npm test` green from `frontend/` (547+ tests must stay green).
- Commit style: `feat(vf-autofarm): <what>` / `test:` / `fix:` — no step numbers in messages, no attribution footer.
- Amounts: USDC/BLND 7 decimals; Blend `b_rate` is 12-decimal (`SCALAR_12 = 1e12`).
- Testnet addresses (verified 2026-07-03): BLND `CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF`, USDC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`, TestnetV2 pool `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`, poolFactoryV2 `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`, Soroswap router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`, Soroswap factory `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY`.
- Existing RPC: `https://soroban-testnet.stellar.org`; relayer secret in `frontend/.env.local` as `STELLAR_RELAYER_SECRET` (server-only).

### Plan refinements vs spec (intentional)

1. `min_compound` is enforced **off-chain by the keeper only** (on-chain check after harvest would revert real work). `set_limits` keeps `cooldown_s` + `max_move_bps` on-chain.
2. `strategy.balance()` returns **book principal** (interest realizes at harvest → price-per-share steps up on compound). No live bToken valuation — YAGNI, honest ceiling noted in code comment.
3. User `deposit` parks funds **idle in the vault**; the next keeper `compound` sweeps idle into strategies. Redeem pays idle first, then drains strategies in list order.
4. Fallback if own second pool can't accept supply (backstop/status gate, probed in Task 1): rebalance demo runs between strategy #1 and **idle** (de-risk-to-idle mode) — `rebalance` accepts the vault address itself as a pseudo-target. Only implement the fallback if Task 1 proves it necessary.

### Interfaces locked for the whole plan

```rust
// strategy contract public API (Task 3-5), consumed by vault via hand-written client:
#[contractclient(name = "StrategyClient")]
pub trait StrategyIface {
    fn deposit(e: Env, amount: i128);
    fn withdraw(e: Env, amount: i128) -> i128;   // i128::MAX = drain; returns actual
    fn balance(e: Env) -> i128;                  // book principal
    fn harvest(e: Env, min_out: i128) -> i128;   // returns USDC gain sent to vault
}
// vault keeper API (Tasks 8-9), consumed by keeper Worker:
// compound(min_outs: Vec<i128>) -> i128 (total gain)
// rebalance(from: Address, to: Address, amount: i128)
```

---

### Task 1: Spike S1+S2 — on-chain probe (emissions, swap route, second-pool viability)

**Files:**
- Create: `scripts/soroban/spike-autofarm.mjs`
- Create: `docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md` (findings ledger, uncommitted)

**Interfaces:** Produces flags recorded in the progress file: `EMISSIONS_LIVE` (bool), `USDC_RESERVE_INDEX` (u32), `SWAP_ROUTE` (`soroswap`|`none`), `OWN_POOL_VIABLE` (bool).

- [ ] **Step 1: Write the probe script** (read-only RPC; follows the style of existing `scripts/soroban/*.mjs`; uses `@stellar/stellar-sdk` from `frontend/node_modules`)

```js
// scripts/soroban/spike-autofarm.mjs — read-only spike: emissions live? swap route? own pool viable?
import { rpc, Contract, TransactionBuilder, Networks, BASE_FEE, Keypair, scValToNative, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';

const RPC = 'https://soroban-testnet.stellar.org';
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF';
const USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
const BLND = 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF';
const SOROSWAP_FACTORY = 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY';

const server = new rpc.Server(RPC);
const source = await server.getAccount(Keypair.random().publicKey()).catch(() => null);

async function simCall(contractId, method, ...args) {
  // simulate-only invocation from a dummy account (no submit, no fees)
  const acc = new (await import('@stellar/stellar-sdk')).Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5', '0');
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
  return { value: sim.result?.retval ? scValToNative(sim.result.retval) : null };
}

// 1) USDC reserve index → bToken reserve_token_id = index*2+1
const list = await simCall(POOL, 'get_reserve_list');
const idx = (list.value || []).findIndex(a => a === USDC);
console.log('USDC_RESERVE_INDEX =', idx, '→ bToken id =', idx * 2 + 1);

// 2) emissions configured for USDC supply?
const emis = await simCall(POOL, 'get_reserve_emissions', nativeToScVal(idx * 2 + 1, { type: 'u32' }));
console.log('EMISSIONS_LIVE =', !!emis.value, JSON.stringify(emis));

// 3) Soroswap BLND/USDC pair + reserves
const pair = await simCall(SOROSWAP_FACTORY, 'get_pair', Address.fromString(BLND).toScVal(), Address.fromString(USDC).toScVal());
console.log('SOROSWAP pair =', JSON.stringify(pair));
if (pair.value) {
  const reserves = await simCall(pair.value, 'get_reserves');
  console.log('SWAP_ROUTE =', reserves.value ? 'soroswap' : 'none', JSON.stringify(reserves));
} else console.log('SWAP_ROUTE = none');

// 4) own-pool viability: pool factory + status semantics — read TestnetV2 status for reference
const cfg = await simCall(POOL, 'get_config');
console.log('TestnetV2 config/status =', JSON.stringify(cfg));
```

- [ ] **Step 2: Run it** — PowerShell from `frontend/` (deps live there): `node ..\scripts\soroban\spike-autofarm.mjs`
Expected: four labeled lines. Any `simulation error` on `get_reserve_emissions` with `None` return = emissions NOT configured (that's a finding, not a failure).
- [ ] **Step 3: Second-pool viability probe.** Using stellar CLI in WSL, dry-run deploy a pool via factory (see blend-utils `deploy-pool.js` args: name, salt, oracle, backstop_take_rate, max_positions, min_collateral). If `deploy` succeeds, `queue_set_reserve`+`set_reserve` for USDC with a steep IR config, then `submit` a 1-USDC SUPPLY from a funded test key. Record `OWN_POOL_VIABLE` = whether supply succeeds at the pool's default status. Use `deployments/stellar-testnet.json` `vf-deployer`-style funded key (CLI-only, testnet-only).
- [ ] **Step 4: Write findings** to `docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md` (all four flags + addresses of anything deployed). Do NOT commit this file or the script yet — commit script only: `git add scripts/soroban/spike-autofarm.mjs && git commit -m "chore(vf-autofarm): add read-only autofarm spike probe"`

### Task 2: Spike S3 — keeper Worker runtime POC

**Files:**
- Create: `keeper/wrangler.jsonc`, `keeper/package.json`, `keeper/src/index.js`

**Interfaces:** Produces the Worker skeleton Tasks 12-13 fill in. Exports `default { async scheduled(controller, env, ctx) }`.

- [ ] **Step 1: Scaffold**

```jsonc
// keeper/wrangler.jsonc
{
  "name": "vf-keeper",
  "main": "src/index.js",
  "compatibility_date": "2025-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/15 * * * *"] },
  "vars": {
    "SOROBAN_RPC_URL": "https://soroban-testnet.stellar.org",
    "NETWORK_PASSPHRASE": "Test SDF Network ; September 2015",
    "VAULT_ADDRESS": "", "STRATEGY_1": "", "STRATEGY_2": "",
    "POOL_1": "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF", "POOL_2": "",
    "USDC": "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"
  }
  // secret: STELLAR_RELAYER_SECRET via `wrangler secret put` (user-run at deploy)
}
```

```json
// keeper/package.json
{ "name": "vf-keeper", "private": true, "type": "module",
  "scripts": { "dev": "wrangler dev --test-scheduled", "test": "vitest run" },
  "dependencies": { "@stellar/stellar-sdk": "^13.0.0" },
  "devDependencies": { "wrangler": "^4.0.0", "vitest": "^3.0.0" } }
```

```js
// keeper/src/index.js — POC: prove stellar-sdk works under workerd (read + sign, no submit yet)
import { rpc, Keypair, TransactionBuilder, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';

export default {
  async scheduled(controller, env, ctx) {
    const server = new rpc.Server(env.SOROBAN_RPC_URL);
    const health = await server.getHealth();
    const kp = env.STELLAR_RELAYER_SECRET ? Keypair.fromSecret(env.STELLAR_RELAYER_SECRET) : Keypair.random();
    // sign a throwaway tx to prove crypto path works in workerd
    const tx = new TransactionBuilder(new Account(kp.publicKey(), '0'), { fee: BASE_FEE, networkPassphrase: env.NETWORK_PASSPHRASE }).setTimeout(30).build();
    tx.sign(kp);
    console.log('keeper POC ok', { health: health.status, signed: tx.signatures.length === 1 });
  },
};
```

- [ ] **Step 2: Run locally** — PowerShell: `cd keeper; npm install; npx wrangler dev --test-scheduled` then in second terminal `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.
Expected: `keeper POC ok { health: 'healthy', signed: true }` in wrangler logs. Any nodejs_compat crash here = stop and report (spike gate).
- [ ] **Step 3: Commit** — `git add keeper/wrangler.jsonc keeper/package.json keeper/src/index.js keeper/package-lock.json && git commit -m "feat(vf-autofarm): keeper worker POC — stellar-sdk under workerd cron"`

### Task 3: `blend_strategy` scaffold — deposit/withdraw/balance

**Files:**
- Create: `soroban/contracts/blend_strategy/Cargo.toml` (copy dependency set from `soroban/contracts/rwa_vault/Cargo.toml`, crate name `blend_strategy`; add to workspace members in `soroban/Cargo.toml`)
- Create: `soroban/contracts/blend_strategy/src/lib.rs`, `src/storage.rs`, `src/blend.rs` (copy of `rwa_vault/src/blend.rs` — supply/withdraw verbatim), `src/test.rs`
- Test: `soroban/contracts/blend_strategy/src/test.rs`

**Interfaces:** Produces `deposit(amount)`, `withdraw(amount)->i128`, `balance()->i128` per the locked trait; constructor `__constructor(vault, pool, token, blnd, router, reserve_token_id: u32)`.

- [ ] **Step 1: Write failing tests.** Mock Blend pool = local `#[contract]` in test.rs implementing `submit_with_allowance` that just pulls/pushes tokens 1:1 (mirror the mock-pool pattern already used in `rwa_vault/src/test.rs` — read it first and reuse its shape):

```rust
// src/test.rs (core cases)
#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

fn setup(e: &Env) -> (Address, Address, Address, Address) { /* deploy mock token (SAC), mock pool, strategy via e.register with constructor args; mint vault 1000 USDC. Reuse rwa_vault test helpers shape. */ }

#[test]
fn deposit_pulls_from_vault_and_supplies_pool() {
    let e = Env::default(); e.mock_all_auths();
    let (strategy, vault, token, pool) = setup(&e);
    // vault approves strategy then strategy.deposit(100)
    // assert: token.balance(pool) == 100, strategy.balance() == 100
}

#[test]
fn withdraw_returns_actual_and_decrements_principal() {
    // deposit 100 → withdraw 40 → returns 40, balance()==60, vault token balance +40
}

#[test]
fn withdraw_max_drains() {
    // deposit 100 → withdraw(i128::MAX) → returns 100, balance()==0
}

#[test]
fn deposit_rejects_non_vault_caller() {
    // e.mock_auths for wrong address only → expect auth error (try_deposit is Err)
}
```

- [ ] **Step 2: Run to verify fail** — WSL: `cargo test -p blend_strategy` → FAIL (unresolved names).
- [ ] **Step 3: Implement**

```rust
// src/storage.rs
use soroban_sdk::{Address, Env};
use crate::types::DataKey;
const TTL_THRESHOLD: u32 = 17_280; const TTL_EXTEND: u32 = 518_400;
pub fn extend_instance(e: &Env) { e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND); }
// getters/setters for Vault, Pool, Token, Blnd, Router, ReserveTokenId(u32), Principal(i128)
// — same shape as rwa_vault/src/storage.rs instance-storage accessors.
```

```rust
// src/lib.rs (public surface)
#![no_std]
mod blend; mod storage; mod types;
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct BlendStrategy;

#[contractimpl]
impl BlendStrategy {
    pub fn __constructor(e: Env, vault: Address, pool: Address, token: Address, blnd: Address, router: Address, reserve_token_id: u32) { /* store all six */ }

    /// only-vault: the vault contract invoking us auths its own address (invoker auth).
    pub fn deposit(e: Env, amount: i128) {
        let vault = storage::get_vault(&e); vault.require_auth();
        let token = storage::get_token(&e); let me = e.current_contract_address();
        soroban_sdk::token::TokenClient::new(&e, &token).transfer_from(&me, &vault, &me, &amount);
        crate::blend::supply(&e, &storage::get_pool(&e), &token, amount);
        storage::set_principal(&e, storage::get_principal(&e) + amount);
        storage::extend_instance(&e);
    }

    pub fn withdraw(e: Env, amount: i128) -> i128 {
        let vault = storage::get_vault(&e); vault.require_auth();
        let token = storage::get_token(&e); let me = e.current_contract_address();
        let before = soroban_sdk::token::TokenClient::new(&e, &token).balance(&me);
        crate::blend::withdraw(&e, &storage::get_pool(&e), &token, amount);
        let got = soroban_sdk::token::TokenClient::new(&e, &token).balance(&me) - before;
        soroban_sdk::token::TokenClient::new(&e, &token).transfer(&me, &vault, &got);
        let p = storage::get_principal(&e);
        storage::set_principal(&e, if got >= p { 0 } else { p - got });
        storage::extend_instance(&e);
        got
    }

    /// ponytail: book principal, not live bToken NAV — interest realizes at harvest.
    pub fn balance(e: Env) -> i128 { storage::get_principal(&e) }
}
```

Note: strategy `deposit` uses `transfer_from(vault→strategy)` — the VAULT must `approve` the strategy before calling (vault side lands in Task 7; tests here approve manually).
- [ ] **Step 4: Run tests + clippy** — WSL: `cargo test -p blend_strategy && cargo clippy -p blend_strategy --all-targets -- -D warnings` → PASS/clean.
- [ ] **Step 5: Commit** — `git add soroban/Cargo.toml soroban/contracts/blend_strategy && git commit -m "feat(vf-autofarm): blend_strategy contract — deposit/withdraw/balance vs Blend pool"`

### Task 4: strategy `harvest` — interest realization

**Files:**
- Modify: `soroban/contracts/blend_strategy/src/lib.rs`, `src/test.rs`

**Interfaces:** Produces `harvest(min_out: i128) -> i128` (interest-only path; BLND path added Task 5). Emits `StrategyHarvest { interest, blnd_claimed, blnd_swapped, usdc_out, blnd_held }` (define event in `types.rs` now, BLND fields 0 for now).

- [ ] **Step 1: Failing tests** — extend mock pool with a `credit_yield(amount)` knob (mints extra tokens into the pool position so withdraw-all returns principal+yield; mirror how `rwa_vault` harvest tests simulate interest):

```rust
#[test]
fn harvest_realizes_interest_and_forwards_to_vault() {
    // deposit 100; pool.credit_yield(7) → harvest(0) returns 7;
    // vault token balance +7; strategy.balance() still 100 (principal re-supplied)
}
#[test]
fn harvest_zero_interest_returns_zero() { /* no yield → returns 0, principal intact, no event fields > 0 */ }
#[test]
fn harvest_rejects_non_vault() { /* auth error */ }
```

- [ ] **Step 2: Run** → FAIL. 
- [ ] **Step 3: Implement** — port the proven withdraw-all/measure/re-supply from `rwa_vault/src/vault.rs:129-163`, but the gain transfers to the vault instead of feeding a dividend index:

```rust
pub fn harvest(e: Env, min_out: i128) -> i128 {
    let vault = storage::get_vault(&e); vault.require_auth();
    let _ = min_out; // used from Task 5 (BLND swap)
    let token = storage::get_token(&e); let me = e.current_contract_address();
    let principal = storage::get_principal(&e);
    if principal == 0 { return 0; }
    let tk = soroban_sdk::token::TokenClient::new(&e, &token);
    let before = tk.balance(&me);
    crate::blend::withdraw(&e, &storage::get_pool(&e), &token, i128::MAX);
    let pulled = tk.balance(&me) - before;
    crate::blend::supply(&e, &storage::get_pool(&e), &token, principal.min(pulled));
    let gain = tk.balance(&me) - before; // whatever remains after re-supply
    if gain > 0 { tk.transfer(&me, &vault, &gain); }
    crate::types::StrategyHarvest { interest: gain, blnd_claimed: 0, blnd_swapped: 0, usdc_out: gain, blnd_held: 0 }.publish(&e);
    storage::extend_instance(&e);
    gain
}
```

- [ ] **Step 4: Test + clippy** WSL `cargo test -p blend_strategy` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): strategy harvest — realize Blend interest to vault"` (explicit paths).

### Task 5: strategy BLND claim + Soroswap swap

**Files:**
- Modify: `soroban/contracts/blend_strategy/src/blend.rs` (add `claim` to the trait), `src/lib.rs`, `src/types.rs`, `src/test.rs`
- Create: `soroban/contracts/blend_strategy/src/soroswap.rs`

**Interfaces:** Consumes locked `harvest(min_out)`. min_out semantics: `0` = do not swap (hold BLND); `>0` = swap full BLND balance with that floor.

- [ ] **Step 1: Failing tests** — mock pool gains `try_claim` support (mints mock-BLND to caller, or traps when emissions disabled); local mock router `#[contract]` with a fixed rate + configurable output:

```rust
#[test]
fn harvest_claims_blnd_and_swaps_to_usdc() {
    // emissions on: claim yields 50 BLND; router rate 50 BLND → 5 USDC; harvest(4_900_000)
    // returns interest+5_000000? (7dp) ; vault got swap proceeds; strategy BLND balance == 0
}
#[test]
fn harvest_holds_blnd_when_min_out_zero() { /* claim ok, no swap; blnd stays on strategy; event blnd_held == 50 */ }
#[test]
fn harvest_survives_no_emissions() { /* mock pool claim traps → try_claim swallowed; interest-only result */ }
#[test]
fn swap_slippage_reverts_whole_harvest() { /* router returns < min_out → tx errs (atomicity) */ }
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```rust
// src/blend.rs — extend the existing trait (claim signature verified from blend-contracts-v2 source)
#[contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit_with_allowance(e: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) -> Positions;
    fn claim(e: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;
}
```

```rust
// src/soroswap.rs — hand-written XDR-level client (same rationale as blend.rs)
use soroban_sdk::{contractclient, Address, Env, Vec};
#[allow(dead_code)]
#[contractclient(name = "SoroswapRouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(e: Env, amount_in: i128, amount_out_min: i128, path: Vec<Address>, to: Address, deadline: u64) -> Vec<i128>;
}
```

In `harvest`, between withdraw-all and re-supply:

```rust
// claim BLND emissions — best-effort (testnet emissions may be off)
let pool_client = crate::blend::BlendPoolClient::new(&e, &storage::get_pool(&e));
let ids = soroban_sdk::vec![&e, storage::get_reserve_token_id(&e)];
let _ = pool_client.try_claim(&me, &ids, &me);
let blnd = storage::get_blnd(&e);
let blnd_bal = soroban_sdk::token::TokenClient::new(&e, &blnd).balance(&me);
let mut swapped = 0i128;
if blnd_bal > 0 && min_out > 0 {
    let router = storage::get_router(&e);
    let exp = e.ledger().sequence() + 100;
    soroban_sdk::token::TokenClient::new(&e, &blnd).approve(&me, &router, &blnd_bal, &exp);
    let path = soroban_sdk::vec![&e, blnd.clone(), token.clone()];
    let amounts = crate::soroswap::SoroswapRouterClient::new(&e, &router)
        .swap_exact_tokens_for_tokens(&blnd_bal, &min_out, &path, &me, &(e.ledger().timestamp() + 300));
    swapped = amounts.get(amounts.len() - 1).unwrap_or(0);
}
```

Event fields fill accordingly (`blnd_claimed`, `blnd_swapped = swapped`, `blnd_held = remaining BLND`).
- [ ] **Step 4: Test + clippy** → PASS. 
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): strategy claims BLND emissions and swaps via Soroswap with min_out guard"`

### Task 6: vault — remove dividend machinery, exchange-rate shares

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/lib.rs`, `src/vault.rs`, `src/storage.rs`, `src/types.rs`, `src/test.rs`
- Delete: `soroban/contracts/rwa_vault/src/vault/dividend.rs`, `src/blend.rs` usage from vault (vault no longer touches pools directly — keep file until Task 7 removes last use)

**Interfaces:** Produces `deposit(from, amount)->shares`, `redeem(from, shares)->assets`, `total_assets()->i128`, `price_per_share()->i128` (7dp). Removes `drip/claim/claimable/harvest/set_pool/pool` from the public API (harvest returns in Task 8 as `compound`).

- [ ] **Step 1: Failing tests** (replace dividend-era tests; keep deposit/redeem/pause/auth tests, rewrite math):

```rust
#[test]
fn first_deposit_mints_dead_shares_to_vault() {
    // deposit 100_0000000 → depositor shares == 100_0000000 - 1000; vault holds 1000 dead shares
}
#[test]
fn first_deposit_below_minimum_rejected() { /* deposit 0_5000000 → Err(FirstDepositTooSmall) */ }
#[test]
fn share_price_rises_after_donated_gain() {
    // deposit 100; transfer 10 USDC directly to vault (simulates compound gain);
    // second depositor's 100 USDC mints fewer shares: 100 * total_shares / 110
}
#[test]
fn redeem_pays_pro_rata_assets() { /* after gain, redeem all → assets > original deposit */ }
#[test]
fn dividend_api_gone() { /* claim/drip symbols no longer exist — compile-level, just delete their tests */ }
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `types.rs`: drop `AccDivPerShare/DripEpoch/RewardDebt/Pending/Pool` keys + `Drip/Claim/Harvest` events + `NothingToClaim/NoShares/PoolNotSet/PoolAlreadySet` errors; add keys `Strategies, Keeper, LastRebalance, CooldownS, MaxMoveBps` and errors `StrategyNotFound=10, TooManyStrategies=11, StrategyNotEmpty=12, NotKeeper=13, CooldownActive=14, MoveTooLarge=15, FirstDepositTooSmall=16`. New events `Compound{total_gain,price_per_share}`, `Rebalance{from,to,amount}`. `vault.rs` core math:

```rust
const DEAD_SHARES: i128 = 1000;
const MIN_FIRST_DEPOSIT: i128 = 1_0000000; // 1 USDC, 7dp
pub const PPS_SCALE: i128 = 1_0000000;

pub fn total_assets(e: &Env) -> i128 {
    let token = get_token(e); let me = e.current_contract_address();
    let idle = TokenClient::new(e, &token).balance(&me);
    idle + get_strategies(e).iter().map(|s| StrategyClient::new(e, &s).balance()).sum::<i128>()
}

pub fn deposit(e: &Env, from: Address, amount: i128) -> Result<i128, VaultError> {
    if amount <= 0 { return Err(VaultError::InvalidAmount); }
    from.require_auth();
    let supply = Base::total_supply(e);
    let assets_before = total_assets(e);
    let token = get_token(e); let me = e.current_contract_address();
    TokenClient::new(e, &token).transfer_from(&me, &from, &me, &amount);
    let shares = if supply == 0 {
        if amount < MIN_FIRST_DEPOSIT { return Err(VaultError::FirstDepositTooSmall); }
        Base::mint(e, &me, DEAD_SHARES); // inflation-attack guard: dead shares carved from first depositor
        amount - DEAD_SHARES
    } else {
        amount.checked_mul(supply).ok_or(VaultError::MathOverflow)? / assets_before
    };
    if shares <= 0 { return Err(VaultError::InvalidAmount); }
    Base::mint(e, &from, shares);
    extend_instance(e);
    Deposit { holder: from, amount, shares }.publish(e);
    Ok(shares)
}

pub fn redeem(e: &Env, from: Address, shares: i128) -> Result<i128, VaultError> {
    if shares <= 0 { return Err(VaultError::InvalidAmount); }
    if Base::balance(e, &from) < shares { return Err(VaultError::InsufficientShares); }
    let assets = shares.checked_mul(total_assets(e)).ok_or(VaultError::MathOverflow)? / Base::total_supply(e);
    Base::burn(e, &from, shares); // burn enforces from.require_auth()
    ensure_idle(e, assets)?;      // Task 7: drains strategies in order; until then idle-only
    let token = get_token(e); let me = e.current_contract_address();
    TokenClient::new(e, &token).transfer(&me, &from, &assets);
    extend_instance(e);
    Redeem { holder: from, shares, assets }.publish(e);
    Ok(assets)
}
```

Deposits now park idle (no pool call). `lib.rs` exports updated; delete `dividend.rs`, `drip`, `claim`, `claimable`, `harvest`, `set_pool`, `settle`, `sync_debt`.
- [ ] **Step 4: Full vault suite + clippy** — WSL `cargo test -p rwa_vault` → PASS (dividend tests removed, new math tests green). Workspace won't compile yet if agent_account references `claim` — expected; fix lands Task 10. Use `-p rwa_vault -p blend_strategy` until then.
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): vault exchange-rate shares, dividend machinery removed, inflation-attack guard"`

### Task 7: vault strategy registry + routed redeem

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/lib.rs`, `src/vault.rs`, `src/storage.rs`, `src/test.rs`
- Create: `soroban/contracts/rwa_vault/src/strategy_client.rs` (the locked `StrategyClient` trait block from Global Constraints, verbatim)

**Interfaces:** Produces `add_strategy(addr)`, `remove_strategy(addr)`, `set_keeper(addr)`, `set_limits(cooldown_s: u64, max_move_bps: u32)`, `keeper()->Address`, `strategies()->Vec<Address>`; `ensure_idle` now drains strategies.

- [ ] **Step 1: Failing tests** — mock strategy `#[contract]` in test.rs implementing the four trait fns over a token balance (no Blend), so vault tests stay single-crate:

```rust
#[test]
fn admin_registers_strategies_max_four() { /* add 4 ok, 5th → TooManyStrategies; non-admin → auth err */ }
#[test]
fn remove_requires_empty() { /* strategy with balance → StrategyNotEmpty */ }
#[test]
fn redeem_drains_strategies_in_order() {
    // idle 10, strat1 50, strat2 40; redeem worth 80 → idle 0, strat1 drained 50, strat2 -20
}
#[test]
fn set_keeper_admin_only() { /* non-admin auth err; keeper() returns set address */ }
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `ensure_idle`:

```rust
fn ensure_idle(e: &Env, needed: i128) -> Result<(), VaultError> {
    let token = get_token(e); let me = e.current_contract_address();
    let tk = TokenClient::new(e, &token);
    for s in get_strategies(e).iter() {
        if tk.balance(&me) >= needed { break; }
        let shortfall = needed - tk.balance(&me);
        StrategyClient::new(e, &s).withdraw(&shortfall);
    }
    if tk.balance(&me) < needed { return Err(VaultError::MathOverflow); } // insolvency guard; unreachable in tests
    Ok(())
}
```

Registry fns: admin via `access_control::get_admin` + `require_auth` (existing pattern from `drip`). Vec cap 4. Defaults on constructor: cooldown 86_400 s, max_move 5_000 bps.
- [ ] **Step 4: Test + clippy** → PASS. 
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): vault strategy registry and strategy-draining redeem"`

### Task 8: vault `compound`

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/lib.rs`, `src/vault.rs`, `src/test.rs`

**Interfaces:** Produces `compound(min_outs: Vec<i128>) -> i128` (keeper-gated). min_outs indexed by strategies() order; length must match.

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn compound_harvests_all_and_reinvests_idle_pro_rata() {
    // strat1 bal 60 / strat2 bal 40; mock strategies yield 6 and 4 on harvest;
    // user idle deposit 100 sitting in vault. compound → gains 10 to vault,
    // idle 110 redeposited 66/44 (pro-rata 60:40); event Compound{total_gain:10,...}
}
#[test]
fn compound_all_zero_balances_goes_to_first_strategy() { /* fresh vault: idle 100 → strat1 gets 100 */ }
#[test]
fn compound_requires_keeper() { /* non-keeper → NotKeeper */ }
#[test]
fn compound_min_outs_length_mismatch_rejected() { /* → InvalidAmount */ }
#[test]
fn price_per_share_increases_after_compound() { /* pps before < after */ }
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```rust
pub fn compound(e: &Env, min_outs: Vec<i128>) -> Result<i128, VaultError> {
    require_keeper(e)?; // get_keeper(e).require_auth() + stored-address check
    let strategies = get_strategies(e);
    if min_outs.len() != strategies.len() { return Err(VaultError::InvalidAmount); }
    let mut total_gain = 0i128;
    let balances: Vec<i128> = strategies.iter().map(|s| StrategyClient::new(e, &s).balance()).collect();
    for (i, s) in strategies.iter().enumerate() {
        total_gain += StrategyClient::new(e, &s).harvest(&min_outs.get(i as u32).unwrap());
    }
    // sweep idle into strategies pro-rata by pre-harvest balances (all zero → strategies[0])
    let token = get_token(e); let me = e.current_contract_address();
    let idle = TokenClient::new(e, &token).balance(&me);
    if idle > 0 && !strategies.is_empty() {
        let total_bal: i128 = balances.iter().sum();
        let exp = e.ledger().sequence() + 100;
        if total_bal == 0 {
            let s0 = strategies.get(0).unwrap();
            TokenClient::new(e, &token).approve(&me, &s0, &idle, &exp);
            StrategyClient::new(e, &s0).deposit(&idle);
        } else {
            let mut left = idle;
            for (i, s) in strategies.iter().enumerate() {
                let cut = if i as u32 == strategies.len() - 1 { left } else { idle * balances.get(i).unwrap() / total_bal };
                if cut > 0 { TokenClient::new(e, &token).approve(&me, &s, &cut, &exp); StrategyClient::new(e, &s).deposit(&cut); left -= cut; }
            }
        }
    }
    let pps = price_per_share(e);
    Compound { total_gain, price_per_share: pps }.publish(e);
    extend_instance(e);
    Ok(total_gain)
}
```

- [ ] **Step 4: Test + clippy** → PASS. 
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): keeper-gated compound — harvest all strategies, reinvest idle"`

### Task 9: vault `rebalance` + limits + emergency + upgrade

**Files:**
- Modify: `soroban/contracts/rwa_vault/src/lib.rs`, `src/vault.rs`, `src/test.rs`

**Interfaces:** Produces `rebalance(from, to, amount)`, `emergency_withdraw(strategy)`, `upgrade(new_wasm_hash: BytesN<32>)`.

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn rebalance_moves_within_caps_and_sets_cooldown() { /* 100 in strat1, move 50 (=5000bps cap) ok; event; LastRebalance set */ }
#[test]
fn rebalance_cooldown_blocks_second_call() { /* immediate second → CooldownActive; ledger timestamp bump past cooldown → ok */ }
#[test]
fn rebalance_over_cap_rejected() { /* move 51 of 100 at 5000bps → MoveTooLarge */ }
#[test]
fn rebalance_unregistered_strategy_rejected() { /* → StrategyNotFound */ }
#[test]
fn emergency_withdraw_drains_to_idle_even_when_paused() { /* pause → emergency_withdraw ok → remove_strategy ok → redeem still works */ }
#[test]
fn upgrade_admin_only() { /* non-admin → auth err (upgrade itself only smoke-tested via auth check; wasm swap covered by live smoke) */ }
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```rust
pub fn rebalance(e: &Env, from: Address, to: Address, amount: i128) -> Result<(), VaultError> {
    require_keeper(e)?;
    let strategies = get_strategies(e);
    if !strategies.contains(&from) || !strategies.contains(&to) { return Err(VaultError::StrategyNotFound); }
    let now = e.ledger().timestamp();
    if now < get_last_rebalance(e) + get_cooldown_s(e) { return Err(VaultError::CooldownActive); }
    let from_bal = StrategyClient::new(e, &from).balance();
    if amount <= 0 || amount > from_bal * i128::from(get_max_move_bps(e)) / 10_000 { return Err(VaultError::MoveTooLarge); }
    let got = StrategyClient::new(e, &from).withdraw(&amount);
    let token = get_token(e); let me = e.current_contract_address();
    let exp = e.ledger().sequence() + 100;
    TokenClient::new(e, &token).approve(&me, &to, &got, &exp);
    StrategyClient::new(e, &to).deposit(&got);
    set_last_rebalance(e, now);
    Rebalance { from, to, amount: got }.publish(e);
    extend_instance(e);
    Ok(())
}

pub fn emergency_withdraw(e: &Env, strategy: Address) { /* admin auth; StrategyClient::withdraw(i128::MAX); NOT pause-gated */ }
pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) { /* admin auth; e.deployer().update_current_contract_wasm(new_wasm_hash) */ }
```

- [ ] **Step 4: Test + clippy** → PASS. 
- [ ] **Step 5: Commit** — `git commit -m "feat(vf-autofarm): rebalance with cooldown+caps, emergency withdraw, admin upgrade"`

### Task 10: agent_account sync + workspace green

**Files:**
- Modify: `soroban/contracts/agent_account/src/vault_client.rs` (drop `claim` from trait), `src/lib.rs` (exit path: remove try_claim block, redeem-only), `src/test.rs` (exit tests updated), plus any `PauseInvariant`/`ZeroCustody`-style tests referencing removed vault API.

**Interfaces:** Consumes Task 6-9 vault API. Produces: whole workspace compiles + passes.

- [ ] **Step 1: Update vault_client trait** to `deposit/redeem/balance` only; delete the exit `try_claim` call (`agent_account/src/lib.rs:105-107` region).
- [ ] **Step 2: Fix/rename invariant tests** — `ZeroCustody` reworded per spec §9: vault may hold idle USDC transiently; strategies hold protocol positions; no per-user claimable pots anywhere. Add `redeem_always_works` integration test: vault + 2 mock strategies, one bricked (withdraw traps) → after `emergency_withdraw` + `remove_strategy` of the healthy remainder path, full redeem succeeds for the recoverable amount.
- [ ] **Step 3: Full workspace** — WSL: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → ALL PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(vf-autofarm): agent_account exit via redeem-only; workspace green"`

### Task 11: testnet deploy — second pool, strategies, new vault

**Files:**
- Modify: `scripts/soroban/deploy-seed.sh` (or create `scripts/soroban/deploy-autofarm.sh` alongside, following its exact style)
- Modify: `deployments/stellar-testnet.json`, `frontend/src/config.js` (new addresses), `frontend/.env.local`/`.dev.vars` docs in `frontend/.env.example`

**Interfaces:** Produces live addresses: `vault` (new), `strategy1`, `strategy2`, `pool2`; consumed by keeper vars + frontend config.

- [ ] **Step 1: Build wasm** — WSL `stellar contract build` → both contracts compile to wasm32v1-none.
- [ ] **Step 2: Deploy pool 2** per Task 1 findings (factory `deploy` w/ steep IR ReserveConfig for USDC, `queue_set_reserve`+`set_reserve`). If `OWN_POOL_VIABLE=false`: skip pool 2, deploy only strategy1, and enable the de-risk-to-idle fallback (Global refinement 4) — record deviation in progress file.
- [ ] **Step 3: Deploy vault + strategies** with constructor args (vault: admin/token; strategies: vault, pool_i, USDC, BLND, router, `reserve_token_id` from Task 1). Then `add_strategy` ×2, `set_keeper(relayer G-address)`, seed demo agent (existing deploy-seed pattern: authorize agent, fund, small deposit).
- [ ] **Step 4: Verify live** — CLI reads: `strategies()`, `keeper()`, `price_per_share()`, 1-USDC deposit+redeem round-trip from deployer key.
- [ ] **Step 5: Update** `deployments/stellar-testnet.json` + `frontend/src/config.js` + keeper `wrangler.jsonc` vars. Commit script + deployments + config: `git commit -m "feat(vf-autofarm): deploy autofarm vault, strategies, second pool to testnet"`

### Task 12: keeper `decide()` — pure decision function

**Files:**
- Create: `keeper/src/decide.js`, `keeper/test/decide.test.js`

**Interfaces:** Produces `decide(state, config) -> actions[]` where `state = { strategies: [{ address, balance, supplyAprBps, pendingInterest, blndClaimable }], idle, lastRebalanceTs, nowTs, blndQuote: { usdcOutFor(blndAmount) } | null }`, `config = { minCompound: 10000000n, rebalanceBps: 50, cooldownS: 86400, slippageBps: 100 }`, actions = `{ type: 'compound', minOuts: bigint[] } | { type: 'rebalance', from, to, amount: bigint }`.

- [ ] **Step 1: Failing tests**

```js
import { describe, it, expect } from 'vitest';
import { decide } from '../src/decide.js';

const base = { idle: 0n, lastRebalanceTs: 0, nowTs: 100_000_000, blndQuote: null,
  strategies: [
    { address: 'S1', balance: 600_0000000n, supplyAprBps: 300, pendingInterest: 0n, blndClaimable: 0n },
    { address: 'S2', balance: 400_0000000n, supplyAprBps: 320, pendingInterest: 0n, blndClaimable: 0n }] };
const cfg = { minCompound: 1_0000000n, rebalanceBps: 50, cooldownS: 86400, slippageBps: 100 };

it('does nothing when below thresholds', () => expect(decide(base, cfg)).toEqual([]));
it('compounds when pending yield crosses minCompound', () => {
  const s = structuredClone(base); s.strategies[0].pendingInterest = 2_0000000n;
  expect(decide(s, cfg)).toEqual([{ type: 'compound', minOuts: [0n, 0n] }]);
});
it('compounds idle deposits even with zero pending yield', () => {
  const s = structuredClone(base); s.idle = 5_0000000n;
  expect(decide(s, cfg)[0].type).toBe('compound');
});
it('sets minOut from quote with slippage when BLND claimable and route exists', () => {
  const s = structuredClone(base); s.strategies[0].blndClaimable = 50_0000000n; s.strategies[0].pendingInterest = 2_0000000n;
  s.blndQuote = { usdcOutFor: () => 5_0000000n };
  expect(decide(s, cfg)[0].minOuts[0]).toBe(4_9500000n); // 1% slippage
});
it('minOut is 0 (hold) when no quote', () => {
  const s = structuredClone(base); s.strategies[0].blndClaimable = 50_0000000n; s.strategies[0].pendingInterest = 2_0000000n;
  expect(decide(s, cfg)[0].minOuts[0]).toBe(0n);
});
it('rebalances toward higher APR past threshold and cooldown', () => {
  const s = structuredClone(base); s.strategies[1].supplyAprBps = 400; // delta 100 > 50
  const a = decide(s, cfg).find(x => x.type === 'rebalance');
  expect(a).toEqual({ type: 'rebalance', from: 'S1', to: 'S2', amount: 100_0000000n }); // imbalance/2
});
it('respects cooldown', () => {
  const s = structuredClone(base); s.strategies[1].supplyAprBps = 400; s.lastRebalanceTs = s.nowTs - 100;
  expect(decide(s, cfg).some(x => x.type === 'rebalance')).toBe(false);
});
```

- [ ] **Step 2: Run** — PowerShell `cd keeper; npx vitest run` → FAIL.
- [ ] **Step 3: Implement** `decide.js` — pure, no I/O, BigInt arithmetic; rebalance amount `min((fromBal - toBal)/2, fromBal/2)` (on-chain cap re-checks 5000 bps).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(vf-autofarm): keeper decide() pure decision function"`

### Task 13: keeper chain I/O + scheduled handler

**Files:**
- Create: `keeper/src/chain.js`
- Modify: `keeper/src/index.js`

**Interfaces:** Consumes `decide()`. `chain.js` exports `readState(env) -> state` (simulate `get_reserve` per pool → APR bps from util+IR params; `get_user_emissions`; `balance()` per strategy; vault `last_rebalance` read; Soroswap quote via router simulation) and `submit(env, action) -> txHash` (build → simulate → assemble → sign w/ relayer keypair → send; re-fetch source account before build — txBadSeq lesson from memory).

- [ ] **Step 1: Implement `chain.js` + wire `index.js`:** scheduled handler = `readState → decide → for each action: submit; log JSON result; catch per-action, never throw out of handler`. Simulation failure on submit → log + skip (no retry loop).
- [ ] **Step 2: Local integration run** — `npx wrangler dev --test-scheduled` + curl `__scheduled` against LIVE testnet (reads real state; submits only if decide fires — fresh vault likely idle→compound). Verify: log shows state snapshot + action list; any submitted tx confirmed on RPC.
- [ ] **Step 3: Commit** — `git commit -m "feat(vf-autofarm): keeper worker reads chain state and submits compound/rebalance"`
- [ ] **Step 4 (USER-RUN, document in progress file):** `wrangler deploy` + `wrangler secret put STELLAR_RELAYER_SECRET` from `keeper/` — needs the user's Cloudflare account. Plan proceeds without it (local `--test-scheduled` suffices for verification).

### Task 14: frontend — events, alerts, settings honesty

**Files:**
- Create: `frontend/src/stellar/keeperEvents.js` (+ test `frontend/src/stellar/keeperEvents.test.js` — follow existing `frontend/src/stellar/*` test conventions)
- Modify: `frontend/src/components/AlertCard.jsx`, `frontend/src/app.jsx` (alert wiring ~lines 606-740 where `harvest_*` alerts live), `frontend/src/components/SettingsPage.jsx:497` (copy), `frontend/src/settingsStore.js`

**Interfaces:** Produces `fetchKeeperEvents(rpcUrl, vaultAddress, sinceLedger) -> [{ type: 'compound'|'rebalance', ledger, txHash, totalGain?, pricePerShare?, from?, to?, amount? }]` (poll `getEvents` for `Compound`/`Rebalance` topics). New alert types: `compound_executed`, `rebalance_executed`, `blnd_held`.

- [ ] **Step 1: Failing vitest** — `keeperEvents.test.js`: mock RPC `getEvents` response fixture → parsed array; empty result → `[]`; malformed event skipped not thrown. AlertCard: new types render with correct icon/copy (mirror existing `harvest_ready` test).
- [ ] **Step 2: Run** — PowerShell `cd frontend; npm test -- keeperEvents` → FAIL. 
- [ ] **Step 3: Implement** parser + alert wiring (poll piggybacks the existing event/polling loop in app.jsx) + Settings copy change: "Automation runs vault-wide via the keeper. This toggle controls your notifications." (`settingsStore.js` translation keys updated).
- [ ] **Step 4: Run full suite** `npm test` → green. **Step 5: Commit** — `git commit -m "feat(vf-autofarm): keeper event feed, compound/rebalance alerts, honest automation copy"`

### Task 15: frontend — keeper panel, graph nodes, share-price displays

**Files:**
- Create: `frontend/src/components/KeeperPanel.jsx` (+ `KeeperPanel.test.jsx`)
- Modify: `frontend/src/app.jsx` (mount panel; force-graph node/edge data: Keeper + Strategy nodes), `frontend/src/worker.js` + screens where shares==USDC 1:1 assumed (grep `shares` usages; use `price_per_share()` read + existing 7-dp helper)

**Interfaces:** Consumes `fetchKeeperEvents` + vault reads (`price_per_share`, `strategies`). Visuals follow DESIGN.md Acid Yield system — dark #0e0f0c, acid-lime #cfff3d, mono metadata rows.

- [ ] **Step 1: Failing tests** — KeeperPanel renders: last action row, APR per strategy, price-per-share figure; empty state "keeper has not acted yet".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (presentational; data via props from app.jsx). Graph: add `keeper` node linked to vault, `strategy-N` nodes linked to pools; `rebalance_executed` event pulses the edge (existing graph event pattern).
- [ ] **Step 4:** `npm test` green + `npm run build` clean. **Step 5: Commit** — `git commit -m "feat(vf-autofarm): keeper panel, strategy graph nodes, real share-price displays"`

### Task 16: live smoke — full loop on testnet

**Files:**
- Create: `frontend/scripts/smoke-autofarm.mjs` (vite-node style, mirrors existing smoke scripts incl. forged-Origin relay seam if relay used; direct keypair submits fine here)

**Interfaces:** Consumes deployed addresses (Task 11) + keeper decide/chain modules (imported directly for tick simulation).

- [ ] **Step 1: Write smoke:** (1) deposit 5 USDC from demo key → shares minted at pps; (2) force keeper tick (import `readState`+`decide`+`submit` from keeper src with env from deployments) → compound sweeps idle into strategies; (3) wait/advance → second tick shows harvest gain ≥ 0 (real Blend interest over short hold may be 0 — assert tx success + honest zero, per Blend-cutover memory); (4) if pool2 live: manipulate imbalance (deposit skew) → rebalance fires within caps; (5) redeem all → assets ≥ deposit - dust. Log every txHash.
- [ ] **Step 2: Run** — PowerShell `cd frontend; npx vite-node scripts/smoke-autofarm.mjs` with `--submit` semantics (real txs; sim-pass ≠ submit-works — meta-rule). Expected: ALL GREEN lines + tx hashes.
- [ ] **Step 3: Record results** in progress file. **Step 4: Commit** — `git commit -m "test(vf-autofarm): end-to-end testnet smoke — deposit, compound, rebalance, redeem"`

### Task 17: security review + final gate

- [ ] **Step 1: Dispatch security-reviewer agent** over `soroban/contracts/rwa_vault`, `soroban/contracts/blend_strategy`, `keeper/` diff vs branch point. Focus list: only-vault auth bypass, keeper-gate bypass, share-math rounding exploits (deposit/redeem donation vectors beyond dead-shares guard), min_out=0 abuse paths, cooldown bypass, approve() lifetimes, relayer secret handling.
- [ ] **Step 2: Fix all CRITICAL/HIGH** findings (TDD: regression test per fix), re-run WSL `cargo test && cargo clippy --all-targets -- -D warnings` + `cd frontend; npm test` + `cd keeper; npx vitest run` → all green.
- [ ] **Step 3: Final commit** — `git commit -m "fix(vf-autofarm): security review fixes"` (or note zero findings in progress file). Report branch state to user; merge decision is the user's (finishing-a-development-branch skill).

# VF Autofarm — Auto-Compounding, Reward Harvesting, Auto-Rebalancing

**Date:** 2026-07-03 · **Status:** Approved design, pending user spec review
**Approach:** B — strategy adapters (user-selected over in-place vault evolution)
**Target:** Full implementation (api-gate and wallet-classic branches complete); testnet-first, mainnet-ready patterns

## 1. Goal

Close the three automation gaps in the yield loop:

1. **Auto reward harvesting** — claim BLND emissions from Blend (never claimed today) in addition to USDC interest, and convert BLND→USDC via Soroswap.
2. **Auto-compounding** — reinvest all realized yield into principal automatically. Today `harvest()` parks interest as a per-holder dividend that must be claimed manually; nothing compounds.
3. **Auto-rebalancing** — move funds between two Blend pools when supply APR diverges. Today the vault knows exactly one pool (Master Strategy item F9, previously stretch).

Automation = on-chain capability (vault + strategy functions) triggered by an off-chain **keeper** (Cloudflare Worker cron). All fund-safety limits are enforced on-chain; the keeper only decides *when* to press the buttons.

## 2. Decisions log (user-confirmed)

| Question | Decision |
|---|---|
| Target/timeline | Full implementation now (both in-flight branches done) |
| Reward scope | Full loop: interest compound + BLND claim + BLND→USDC swap + compound everything |
| Automation host | Cloudflare Worker with cron trigger, reusing server-side relayer keypair |
| Contract architecture | **B — strategy adapters** (vault + per-venue strategy contracts) |

## 3. Verified research facts (2026-07-03)

From primary sources (deep-research adversarially verified + raw repo fetches):

- **Pool claim interface** (blend-contracts-v2 `pool/src/contract.rs`, read from source):
  `fn claim(e: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128` with `from.require_auth()`. bToken (supply) id = `reserve_index * 2 + 1`. Read helpers: `get_user_emissions(user, reserve_token_index) -> Option<UserEmissionData>`, `get_reserve_emissions(reserve_token_index) -> Option<ReserveEmissionData>`. `gulp_emissions()` is permissionless and cadence-gated (≥1 h apart; must run at least every 7 days).
- **Emissions model** (docs.blend.capital, high confidence): 1 BLND/sec protocol-wide, 70% backstop / 30% pools; only reward-zone pools receive pool emissions. **Implication: a self-deployed second pool gets NO emissions** — BLND claiming only ever applies to the shared TestnetV2 pool.
- **APR signal on-chain** (`pool/src/pool/reserve.rs`, read from source): `get_reserve(asset) -> Reserve { config, data: ReserveData { b_rate, d_rate, ir_mod, b_supply, d_supply, last_time, .. } }`. Supply APR is computed keeper-side from utilization + IR params; `b_rate` is 12-decimal (`SCALAR_12`).
- **Testnet addresses** (blend-utils `testnet.contracts.json`, fetched raw):
  - BLND `CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF`
  - USDC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` (identical to the vault's token — good)
  - poolFactoryV2 `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`
  - TestnetV2 pool `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` (already wired in our vault)
  - Comet BLND:USDC `CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM`
- **Soroswap testnet** (soroswap/core `public/testnet.contracts.json`, fetched raw): router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`, factory `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY`.
- **Keeper runtime** (Cloudflare docs, high confidence): cron triggers are Workers-only (not Pages); `nodejs_compat` needs `compatibility_date ≥ 2024-09-23`; `@stellar/stellar-sdk` is the correct SDK (js-soroban-client archived 2025-03-11).
- **Unresolved → spikes (§10):** whether TestnetV2 emissions are currently flowing (research contradictory); whether a BLND/USDC pair with liquidity exists on Soroswap testnet; DeFindex's current strategy trait (repo moved to defindex-io/stellar-contracts; unverified — we define our own trait, DeFindex is inspiration only).
- **Rebalance thresholds:** research area came back empty. Defaults below are Yearn-style judgment calls, all admin-configurable — not sourced facts.

## 4. Architecture

```
                        ┌───────────────────────────────┐
 user deposit/redeem ──►│  VAULT (evolved rwa_vault)    │ share ledger, exchange-rate
                        │  total_assets = idle +        │ pricing; keeper role; cooldowns
 keeper (CF Worker) ───►│  Σ strategy.balance()         │
   compound(min_out)    └────┬──────────────────┬───────┘
   rebalance(from,to,amt)    │ only-vault       │ only-vault
                        ┌────▼─────────┐   ┌────▼─────────┐
                        │ blend_strategy│   │ blend_strategy│  same contract, 2 instances
                        │ #1 TestnetV2  │   │ #2 own pool   │  (per-instance constructor args)
                        └────┬─────────┘   └────┬─────────┘
                          Blend TestnetV2      second Blend v2 pool we deploy
                          (emissions maybe)    via poolFactoryV2 (different IR
                                               config → APR divergence for demo)
```

New top-level dir `keeper/` (separate Cloudflare Worker project). Frontend reads events for surfacing.

## 5. Contract: `vault` (evolution of `soroban/contracts/rwa_vault`)

### 5.1 Share accounting: 1:1 → exchange-rate

- `deposit(from, amount)`: `shares = amount × total_shares / total_assets` (floor; first deposit `shares = amount`).
- `redeem(from, shares)`: `assets = shares × total_assets / total_shares` (floor). Pulls shortfall from strategies (drain order: strategy list order) before paying out.
- `total_assets = idle_token_balance + Σ strategy.balance()`.
- Compounding raises `total_assets` with shares unchanged → price-per-share rises → every holder compounds in one tx.
- **Inflation-attack guard:** require a minimum first deposit (e.g. 1 USDC = 1_0000000) and mint dead shares (e.g. 1000 units) to the vault itself on first deposit. Standard 4626 mitigation; unit-tested.
- **Removed:** `drip()`, `claim()`, `claimable()`, `acc_div_per_share`, pending-dividend storage, `Drip`/`Claim` events, dividend.rs. The dividend model is superseded entirely.

### 5.2 New/changed functions

| fn | auth | behavior |
|---|---|---|
| `add_strategy(addr)` | admin | append to `Vec<Address>` strategies (cap 4) |
| `remove_strategy(addr)` | admin | requires strategy balance == 0 |
| `set_keeper(addr)` | admin | keeper role storage |
| `compound(min_outs: Vec<i128>)` | keeper | for each strategy i: `strategy.harvest(min_outs[i])` → USDC lands in vault → re-deposit all idle into strategies pro-rata to current balances (all balances zero → all to strategies[0]). Emits `Compound { total_gain, per_strategy, price_per_share }`. No-gain strategies contribute 0; tx still succeeds. |
| `rebalance(from, to, amount)` | keeper | checks: both registered; `now - last_rebalance_ts ≥ cooldown`; `amount ≤ max_bps_per_move × from.balance()`. Then `from.withdraw(amount)` → `to.deposit(amount)`. Sets `last_rebalance_ts`. Emits `Rebalance { from, to, amount }`. |
| `set_limits(cooldown_s, max_move_bps, min_compound)` | admin | defaults 86400 s, 5000 bps, 1_0000000 (1 USDC) |
| `upgrade(new_wasm_hash)` | admin | `update_current_contract_wasm` — new this round; avoids future redeploy pain |
| `emergency_withdraw(strategy)` | admin | strategy.withdraw(MAX) → idle; escape hatch, works when paused |

`deposit/redeem/pause/unpause` semantics otherwise preserved (redeem never pause-gated). ReentrancyGuard + Pausable retained.

### 5.3 Errors (extend `VaultError`)
`StrategyNotFound`, `TooManyStrategies`, `StrategyNotEmpty`, `NotKeeper`, `CooldownActive`, `MoveTooLarge`, `BelowMinCompound`, `FirstDepositTooSmall`.

## 6. Contract: `blend_strategy` (new, `soroban/contracts/blend_strategy`)

One wasm, two instances. Constructor: `(vault, pool, token, blnd_token, swap_router, reserve_token_id)`.

| fn | auth | behavior |
|---|---|---|
| `deposit(amount)` | only-vault | pull `amount` USDC from vault (transfer_from w/ pre-approve, same pattern as today's blend.rs), `submit_with_allowance` SUPPLY into pool |
| `withdraw(amount) -> i128` | only-vault | WITHDRAW from pool (i128::MAX = drain), transfer proceeds to vault, return actual |
| `balance() -> i128` | view | strategy's supplied position valued in USDC (bTokens × b_rate / SCALAR_12; via pool position read) |
| `harvest(min_out) -> i128` | only-vault | 1) withdraw-all, measure interest vs recorded principal (today's proven pattern, moved here); 2) `pool.claim(strategy, [reserve_token_id], strategy)` for BLND — wrapped in `try_` (no emissions ⇒ skip); 3) if BLND balance ≥ min swap size AND `min_out > 0`: Soroswap `swap_exact_tokens_for_tokens(blnd_amount, min_out, path=[BLND,USDC], to=strategy, deadline)`; else hold BLND (honest event flag); 4) re-supply principal, transfer total gain (interest + swap proceeds) to vault, return gain. Emits `StrategyHarvest { interest, blnd_claimed, blnd_swapped, usdc_out, blnd_held }`. |

- Clients hand-written XDR-level (proven `blend.rs` pattern; SDK pin conflict unchanged): extend Blend client with `claim` + position read; new `soroswap.rs` client for the router.
- Custody: strategy holds the Blend position and transient BLND only; realized USDC always forwarded to vault same-tx. Vault holds no protocol positions.

### Degradation ladder (error handling)
1. Emissions not configured/flowing → claim skipped (`try_` swallow), interest-only compound. Honest event fields.
2. No BLND/USDC swap route or keeper passes `min_out = 0` → hold BLND in strategy, report `blnd_held`.
3. Swap slippage exceeds min_out → whole harvest tx reverts (atomic) → keeper retries next tick with fresh quote.
4. Pool at 100% utilization → withdraw under-fills → harvest reverts → keeper skips tick (same accepted testnet caveat as today's redeem).
5. Strategy bricked → admin `emergency_withdraw` + `remove_strategy`; user `redeem` unaffected for idle + healthy strategies.

## 7. Keeper (`keeper/`, new Cloudflare Worker project)

- **wrangler.jsonc:** cron `*/15 * * * *`; `compatibility_date = 2025-06-01`; `nodejs_compat`; secret `STELLAR_RELAYER_SECRET` (existing relayer keypair = keeper identity + fee payer; its G-address is `set_keeper` target); vars: RPC URL, vault/strategy/pool addresses.
- **Structure:** `keeper/src/index.js` (scheduled handler: read state → decide → submit), `keeper/src/decide.js` (**pure function**, no I/O: `decide(state, config) → actions[]` — unit-tested in vitest), `keeper/src/chain.js` (stellar-sdk reads/writes).
- **Per tick:**
  1. Read: each pool `get_reserve(USDC)` → compute supply APR; `get_user_emissions(strategy, id)`; strategy balances; vault `last_rebalance_ts`, limits.
  2. Compound when `pending_interest + est_blnd_value ≥ min_compound`. BLND min_out: quote route off-chain (router simulation), 1% slippage; quote unavailable → `min_out = 0` (= hold-BLND mode).
  3. Rebalance when `apr_delta > 50 bps` and on-chain cooldown elapsed; `amount = min(imbalance/2, max_move_bps × from.balance)`.
  4. Submit via relayer keypair (plain source account; no fee-bump needed — keeper pays own fees). Simulate first; simulation failure → log + skip tick. No retry loops.
- Thresholds are config vars; defaults are judgment calls (research gap), tune during smoke.
- Idempotency/safety rails live on-chain (keeper-gate, cooldown, caps, min_out) — a rogue/double cron can at worst compound early, never move funds outside limits.

## 8. Frontend

- **Keeper panel** (new component, Acid Yield design system per DESIGN.md): keeper status, last actions, APR per strategy, price-per-share sparkline — all from RPC events + reads. No new backend.
- **Alerts:** add `compound_executed`, `rebalance_executed`, `blnd_held` types via existing AlertCard machinery; wire from event polling.
- **Settings honesty fix:** existing `autoHarvest`/`harvestMinUsdc` copy promises automation that didn't exist. Repurpose: automation is vault-global (keeper); user toggles control notifications only. Copy updated.
- **Share price ≠ 1:1:** update `worker.js`/`app.jsx`/screens where shares==USDC assumed; real APY from price-per-share history (7-dp decimal helper per existing convention).
- **Force-graph:** Keeper node + 2 Strategy nodes with edges to pools; rebalance = animated edge event.
- `agent_account` ripple: `vault_client.rs` exit path = redeem only (dividend claim gone).

## 9. Testing

- **Rust unit** (per contract, mocks in existing `mocks/` pattern): mock pool (yield + emissions), mock router (rate + slippage knobs). Cover: exchange-rate math incl. rounding + inflation-attack case; compound with/without emissions/liquidity; rebalance limits (cooldown, caps, auth); redeem draining strategies; emergency paths; pause semantics.
- **Invariant updates:** `ZeroCustody` reworded — vault holds no protocol positions, strategies hold no idle user USDC post-tx; add `redeem_always_works` (vault solvent for total_shares at price-per-share given healthy strategies).
- **Keeper:** `decide()` pure-function vitest table tests (APR deltas, cooldowns, quote-missing → min_out 0).
- **Frontend vitest:** new alerts, keeper panel render, share-price displays.
- **Live smoke (vite-node, testnet):** full loop — deposit → keeper tick compound (real interest) → force APR divergence → rebalance → redeem with gain. Meta-rule from memory: sim pass ≠ submit works; smoke MUST run real `--submit`.

## 10. Spike gates (run before implementation tasks)

- **S1 emissions:** call `get_reserve_emissions(1)` / `get_user_emissions` on TestnetV2 on-chain. Emissions flowing? → full-loop demo. Not flowing? → claim path ships mocked-tested + honest no-op live.
- **S2 swap route:** query Soroswap testnet factory `get_pair(BLND, USDC)` + reserves. No pair/liquidity? → default hold-BLND mode; optionally seed tiny pair ourselves if we can obtain BLND (depends on S1).
- **S3 Worker POC:** minimal scheduled Worker signing + submitting one Soroban tx via stellar-sdk under nodejs_compat. Verified in docs, not by our hands.

## 11. Security requirements (security-reviewer agent pass required in plan)

Only-vault auth on strategies; keeper-gated compound/rebalance (not permissionless — min_out is keeper-supplied, permissionless would allow sandwich via min_out=0 calls); on-chain cooldown + move caps; min_out on every swap; ReentrancyGuard + Pausable retained; guardian pause unaffected; `emergency_withdraw` works while paused; relayer secret stays server-side (Worker secret, never in frontend); no new user-key custody anywhere.

## 12. Out of scope (YAGNI)

Non-Blend venues (trait ready, not built); mainnet deploy; per-user automation preferences on-chain; BLND staking/backstop participation; auto-gulp_emissions for the shared pool (permissionless, anyone runs it; keeper MAY call it opportunistically — cheap, include only if trivial); DeFindex code porting.

## 13. Rollout

1. Spikes S1-S3 → 2. contracts + unit tests → 3. deploy second pool + strategies + new vault (deploy-seed update, `deployments/stellar-testnet.json` refresh) → 4. keeper Worker + decide tests → 5. frontend → 6. live smoke → 7. security review pass.

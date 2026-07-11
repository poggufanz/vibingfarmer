# Lifeboat — Automated Emergency De-Risk for the Autofarm Vault

**Date:** 2026-07-04
**Status:** Approved by user (3 design sections approved in brainstorm session)
**Local only — never commit** (planning-files rule).

## 1. Summary

Lifeboat is a vault-level automated emergency exit: an off-chain radar in the existing
keeper watches the Blend pool every ledger and, when a danger signal fires, calls a new
keeper-callable `emergency_derisk()` on the vault that drains **all** strategies back to
idle USDC inside the vault — one transaction protecting every depositor at once,
reversible, with re-entry reusing the existing `compound` path. The keeper's authority to
do this is bounded by a **user-granted, time-boxed on-chain mandate** (e.g. 24 h); when
the mandate expires the lifeboat is disarmed until re-granted (fail-closed).

Original metaphor was "mempool radar fires the lifeboat milliseconds before the whale
hits". Deep research (2026-07-04, 70-agent verified run) killed the milliseconds framing:

- Stellar has **no pre-consensus transaction visibility** (flooding overlay, ordering at
  consensus; first observable signal is post-ledger-close, ~5–6 s cadence on Protocol 26).
  Flip side: our exit cannot be front-run either (no gas auction, deterministic ordering).
- On EVM the classic mempool radar is strategically dead too: >50 % of L1 gas is private
  orderflow; Base never had a public mempool (Flashblocks 200 ms is post-sequencing).
- The one real, verified Blend incident (2026-02-22, YieldBlox community pool, ≈$10.8 M)
  was **oracle manipulation** (USTRY $1.06 → $107) enabled by pool misconfiguration — a
  class that is (a) trivially detectable by an oracle-divergence check and (b) largely
  preventable by pre-entry screening.
- As of July 2026 **no risk-monitoring + auto-exit service is live on Stellar** — the
  "first lifeboat on Stellar" differentiation claim is reasonable (re-verify before
  publishing it).

Product copy must therefore say **"reaction radar — funds safe within ~1 ledger (~6 s) of
the danger signal appearing on-chain"**, never "milliseconds", and the threat model must
state honestly that an atomic single-ledger drain is not survivable by any reactive
system on Stellar.

## 2. Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Chain | Stellar (research verdict: EVM ms-radar mostly dead; all exit plumbing already live here) |
| 2 | Exit scope | Vault-level de-risk: drain Blend strategies → idle USDC in vault. One tx, all users, reversible. No per-user wallet exit (tier 2 = future work) |
| 3 | Autonomy | Full auto engage + auto resume, **gated by on-chain mandate with expiry** granted by the user (default 24 h). Expired mandate ⇒ keeper cannot act, must request re-grant |
| 4 | Demo attack | Real whale-simulator script on testnet (large borrow/withdraw ⇒ genuine utilization/liquidity spike), no mocked signal |
| 5 | Composition | Full C+B+D: state-threshold radar + oracle-divergence radar + F8 pre-entry screening extension |

## 3. Architecture

```
                 ┌─ RADAR (keeper process, off-chain) ────────────┐
Horizon SSE      │  Detector 1: state-threshold                    │
ledger stream ───┤    utilization spike / 1-ledger liquidity drop  │
(per close ~6 s) │  Detector 2: oracle-divergence                  │
                 │    pool oracle price vs ≥2 external references  │
                 └─────────────────┬──────────────────────────────┘
                                   │ decideLifeboat(state, config)   ← pure fn, decide.js pattern
                                   ▼
                 vault.emergency_derisk()   ← keeper-signed, relay fee-bump, in-flight lock
                   gate 1: caller == keeper
                   gate 2: now < mandate_expiry          (user grant, e.g. 24 h)
                   drain ALL strategies → idle USDC      (try_withdraw MAX, best-effort,
                                                          NO cooldown / max_move_bps)
                   set derisked flag → compound/rebalance blocked
                   publish LifeboatEngaged { reason, drained }
                                   │
                 all-clear: signals normal N consecutive ledgers
                                   ▼
                 vault.resume() → flag cleared → existing compound re-supplies idle
```

Latency budget (from research): trigger→safe ≈ 1 ledger (~6–7 s); whale-tx→safe ≈ 9–13 s
(≈2 ledgers: whale inclusion + our reaction). Each failed retry adds ~6 s.

## 4. Components

### 4.1 Vault contract (Rust, `soroban/contracts/rwa_vault`)

Existing facts the design builds on:
- `emergency_withdraw(strategy)` exists but is **admin-only** (vf-deployer, CLI-only) —
  not a legitimate automated path.
- `rebalance(from, to, amount)` is keeper-callable and supports `to = vault` (to idle),
  but is capped by `cooldown_s` + `max_move_bps` — correct for routine moves, wrong for
  emergencies.
- `compound(min_outs)` re-supplies idle to strategies — **re-entry is free** by reusing it.
- Drain convention `try_withdraw(i128::MAX)` = best-effort full drain (same as
  `emergency_withdraw`); a bricked strategy no-ops instead of reverting the whole call.

New API:

```rust
/// One-time-settable role (admin sets it) that may grant/renew the lifeboat mandate.
/// Exists so the DEMO USER's wallet can sign grants in-app; vault admin (vf-deployer)
/// stays CLI-only. Pooled-vault reality: one authority, not per-depositor voting.
pub fn set_mandate_authority(e: &Env, authority: Address);   // require_admin

/// Grant/renew the time-boxed mandate. `expiry` = unix ts; require_auth(authority).
/// Grants may shorten or extend. Publishes MandateSet { authority, expiry }.
pub fn set_mandate(e: &Env, expiry: u64) -> Result<(), VaultError>;

/// THE lifeboat. require_keeper + mandate valid (now < expiry, else MandateExpired).
/// Drains every strategy via try_withdraw(i128::MAX), records per-strategy amounts,
/// sets Derisked flag, publishes LifeboatEngaged { reason_code, drained_total }.
/// Idempotent: calling while already derisked is a no-op success (safe double-retry).
/// Deliberately NOT bound by rebalance cooldown / max_move_bps.
pub fn emergency_derisk(e: &Env, reason_code: u32) -> Result<i128, VaultError>;

/// Clears Derisked. require_keeper + mandate valid. Publishes LifeboatResumed.
/// Next compound() re-supplies idle (no new re-entry code path).
pub fn resume(e: &Env) -> Result<(), VaultError>;

/// View: (derisked: bool, mandate_expiry: u64, mandate_authority: Option<Address>).
pub fn lifeboat_state(e: &Env) -> LifeboatState;
```

Guards added to existing functions: `compound` and `rebalance` revert with
`VaultError::LifeboatEngaged` while `derisked` is set (old keeper loop cannot silently
re-supply during an incident). `deposit`/`redeem` stay open — users can always leave.

New errors: `MandateExpired`, `MandateNotSet`, `LifeboatEngaged`.
New events: `MandateSet`, `LifeboatEngaged { reason_code, drained_total }`, `LifeboatResumed`.

Reason codes (u32): `1 = UTIL_SPIKE`, `2 = LIQ_DROP`, `3 = ORACLE_DIVERGENCE`
(shared constant table mirrored in keeper JS and frontend). When multiple signals fire in
the same ledger, `decideLifeboat` reports the highest-severity one: ORACLE_DIVERGENCE >
LIQ_DROP > UTIL_SPIKE.

### 4.2 Keeper radar (JS, `keeper/src/`)

- **Stream:** Horizon SSE ledger stream (push, delivery sub-second after close;
  refuted-claim note: SSE exists — do NOT build a cron poller). Auto-reconnect;
  fallback = 2 s `getLatestLedger` polling while the stream is down.
- **Per ledger reads** (simulate reads, `chain.js` pattern): Blend pool supplied /
  borrowed / available liquidity (⇒ utilization), pool oracle price; plus external
  reference prices (config-driven list; testnet demo uses one controllable mock
  reference; mainnet target ≥2 independent refs).
- **`decideLifeboat(state, config)`** — new pure module beside `decide.js`: no I/O, no
  SDK imports, deterministic. Returns `null` | `{ type: 'derisk', reason }` |
  `{ type: 'resume' }`.
- **Submit path:** existing keeper identity + relay (fee-bump, gasless) + in-flight lock
  (exit-lock pattern) + cross-ledger retry with aggressive fee. Research gap
  acknowledged: Soroban ledger capacity / fee behavior under mass-exit panic is
  unverified ⇒ retry loop is mandatory, and the "full ledger" scenario gets a testnet
  drill.
- **All-clear:** counter of consecutive normal ledgers; resume only when **all** signals
  are below their resume thresholds for the full window.

### 4.3 Thresholds (env config, defaults)

| Signal | Engage (OR) | Resume (AND + duration) |
|---|---|---|
| Pool utilization | ≥ 95 % | < 85 % |
| 1-ledger available-liquidity drop | ≥ 30 % | — |
| Oracle divergence vs median of refs | ≥ 25 % | < 5 % |
| All-clear window | — | all normal ≥ 100 ledgers (~10 min); demo config ~10 ledgers |

Hysteresis (engage ≠ resume) prevents flapping. YieldBlox anchor: the real exploit was a
~100× price spike — a 25 % divergence threshold is nearly false-positive-free while
catching the verified attack class with huge margin.

### 4.4 F8 pre-entry screening extension (frontend)

Extend the existing fail-closed F8 gate (`riskParams` / `vaultFacts`) with the
YieldBlox-post-mortem checklist:

- `oracleType` — VWAP-style oracle **without** circuit breaker = red flag (root cause of
  the $10.8 M incident).
- `collateralLiquidityDepth` — thin collateral/USDC liquidity = manipulation surface.
- `poolClass` — community-managed vs curated (incident was isolated to a community pool;
  Blend core contracts were not at fault).
- `supplierConcentration` — whale-dominated supply = crunch risk.

Fail-closed as today: a missing fact disqualifies the pool. Facts snapshot refreshed via
the existing `refreshVaultFacts.mjs` flow.

### 4.5 Whale simulator (script, testnet)

`scripts/soroban/whale-sim.mjs` (name aligned at plan time): funds a whale identity
(existing autonomous Blend-USDC faucet), then executes a large borrow or supply-withdraw
against the testnet Blend pool so that available liquidity genuinely collapses ≥ the
engage threshold in one ledger. No mocked events — the radar sees real chain state.
Testnet-only guard (refuses non-testnet passphrase; vf-deployer stays CLI+testnet-only).

### 4.6 UI — Lifeboat panel (frontend)

- Mandate card: authority, expiry countdown, **Grant / Renew 24 h** button (wallet-signed
  `set_mandate`), state badge: `ARMED` (mandate valid) / `ENGAGED` (derisked) /
  `DISARMED` (expired/not set — red, "lifeboat cannot act").
- Event feed: `LifeboatEngaged` / `LifeboatResumed` / `MandateSet` (keeperEvents.js
  pattern).
- Force-graph: vault node flashes on engage (existing event-driven graph updates).
- Copy rule: "reaction radar — ~1 ledger (~6 s)"; never "milliseconds"; state the
  atomic-drain limitation in the info tooltip / docs.

## 5. Error handling (fail-closed everywhere)

| Failure | Behavior |
|---|---|
| Mandate expired while danger fires | Keeper cannot derisk ⇒ loud log + UI alert "MANDATE EXPIRED — lifeboat disarmed". Never silent |
| Derisk tx fails | Retry next ledger (+~6 s each), aggressive fee bump; on-chain `derisked` flag makes double-retry idempotent |
| All external oracle refs down | Detector 2 disabled + warning (min 1 live ref required); **no** false trigger from empty data; Detector 1 (pure on-chain) keeps running |
| SSE gap / missed ledger | Signals computed from absolute state; delta comparison skipped across the gap (no bogus 1-ledger drop) |
| Strategy bricked during drain | `try_withdraw` best-effort per strategy; drained amounts reported in `LifeboatEngaged` |
| compound/rebalance during incident | Revert `LifeboatEngaged` |
| Relay down | Same posture as existing exit path: retry + surfaced failure; keeper identity can also submit direct-fee as last resort (plan-time decision) |
| Mandate expires while ENGAGED | Funds stay derisked (idle = safe posture); `resume` is blocked until a new grant — expiry can never force funds back into a risky pool |

## 6. Testing

- **Rust unit** (`rwa_vault/src/test.rs` + clippy `-D warnings`): mandate gate
  (valid / expired / unset ⇒ `MandateExpired`/`MandateNotSet`), authority auth (admin sets
  authority, non-authority grant rejected), derisk drains all + sets flag + event,
  idempotent re-derisk, partial drain with bricked strategy mock, compound/rebalance
  revert while derisked, resume clears + compound re-supplies, non-keeper rejected.
- **JS unit** (vitest, keeper suite): `decideLifeboat` — each threshold edge, OR-engage,
  AND-resume + hysteresis, all-clear counter reset on any abnormal ledger, missing-data
  guards (no refs, ledger gap), config parsing.
- **Frontend unit:** F8 new facts fail-closed; Lifeboat panel states (ARMED/ENGAGED/
  DISARMED); event feed rendering.
- **Testnet smoke** (`smoke-lifeboat.mjs`, smoke-exit pattern): upgrade wasm → set
  authority + mandate → whale-sim → assert `LifeboatEngaged` + vault idle increased →
  resume → compound. Rule: live-proven or not claimed.

## 7. Demo script (~2–3 min, all-clear window shortened to ~10 ledgers)

1. Open Lifeboat panel → grant 24 h mandate (wallet sign) → `ARMED` + countdown.
2. Run whale simulator → pool liquidity genuinely collapses on testnet.
3. ≤ 1 ledger later: graph node flashes red, `LifeboatEngaged{ LIQ_DROP }` hits the feed,
   balance moves to idle — **funds safe in ~6 seconds**.
4. Signals normalize → auto `resume` + compound re-supply → back to `ARMED`.
5. Honesty shot: let the mandate expire → whale again → UI shows "MANDATE EXPIRED —
   lifeboat disarmed" (cryptographic boundary holds even against our own keeper).

## 8. Explicit non-goals (write honestly in docs)

- Nothing mempool-related — does not exist on Stellar; copy says "reaction radar".
- No protection against atomic single-ledger drains (stated in threat model).
- No tier-2 per-user exit to wallets (future work).
- No mainnet whale-concentration analysis (research gap; testnet only).
- No third-party monitoring integrations (Hypernative-class); no per-depositor mandate
  voting (single vault-level authority).

## 9. Open questions deferred to plan time

- Exact Blend pool read entrypoints for utilization/liquidity (reuse `apr.js` reads where
  possible).
- Relay allowlist addition for `emergency_derisk`/`resume`/`set_mandate` (fail-closed
  allowlist exists; must be extended deliberately).
- Whether `resume` should also be callable by mandate authority (user manual override).
- Direct-fee fallback when relay is down.

## 10. Research anchor (2026-07-04 verified run)

- Stellar: no pre-consensus visibility (flooding overlay; fetched architecture.md);
  Protocol 26, ledger close ~5–6 s; Horizon SSE streaming exists (claim "must poll"
  REFUTED); Soroban ≠ hidden public mempool (frontrun claim REFUTED).
- EVM: >50 % L1 gas private (direction solid, exact figure single-source); Base = single
  sequencer, no public mempool, Flashblocks 200 ms post-sequencing (July 2025).
- Blend: 2026-02-22 YieldBlox oracle-manipulation ≈$10.8 M; root cause pool/oracle
  misconfiguration, core contracts unaffected, isolated to one community pool.
- Prior art: no live risk-monitor+auto-exit on Stellar as of July 2026 (OctoPos claim
  refuted 3-way); Hypernative "instant unwind" = marketing (needs pre-armed playbooks —
  pattern adopted here); keeper "<seconds" claims refuted (block-bound).
- Gaps: Soroban ledger capacity under mass panic; actual whale concentration in our pool;
  Flashblocks public-access semantics.

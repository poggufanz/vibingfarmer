# Real-Yield Vault (Blend v2, single-chain) — Design Spec

> **Date:** 2026-06-27 · **Sub-project #2** of the decomposed hackathon roadmap · **Branch target:** `iq`
> **Status:** approved design, pre-plan. Supersedes/refines `docs/superpowers/plans/2026-06-22-blend-real-yield.md` (that plan becomes the implementation breakdown; this spec records the decisions).
> **One line:** replace the mock `drip()` with **real Blend v2 supply APR**, single-chain on Stellar, preserving 1:1 stable NAV + exit-anytime + the existing cumulative-dividend accounting.

---

## 1. Context & goal

Vibing Farmer's vault (`soroban/contracts/rwa_vault`, struct `RwaVault` — name is stale, contents are a plain yield vault) earns yield today via a **mock `drip()`**: an admin-only treasury `transfer(admin → vault)` that bumps the dividend index. This is GAP-2 in `docs/CURRENT-STATE.md` — yield is simulated, not real. The hackathon (APAC Stellar, submit 2026-07-15) rewards "real, not simulation" and "exit shown up front."

**Goal:** swap the mock yield *source* for a real one — **Blend Capital v2 lending supply APR** — with the smallest surgical change that keeps the existing accounting, tests, and product promises intact.

**Non-goals (this sub-project):** demo/pitch framing, the `rwa_vault`→`yield_vault` rename (belongs to sub-project #1, credibility cleanup), CCTP/dual-chain (rejected for this submission — see §3).

---

## 2. Why Blend (architecture decision)

Decision: **Option A — Blend on Stellar, single-chain.** Researched 2026-06-27 (workflow `wf_eb9ee551-8ea`, 4 threads + synthesis). Rejected alternatives:

| Option | Verdict | Reason |
|--------|---------|--------|
| **A — Blend (Stellar)** | **CHOSEN** | Real borrower-paid USDC supply APR, single-asset (no IL), 1:1 exit-anytime as one Soroban tx, ~200 LOC into existing accounting, ~3–4 days. Hits every judging criterion at once. |
| B — Aave on Base via CCTP (dual-chain) | Rejected | No Aave on **Base Sepolia** (only Base mainnet / Eth Sepolia); ~16 days; reintroduces EVM (reverses the 2026-06-21 decommission); breaks exit-anytime (async multi-step) + non-custodial (EVM relayer holds funds). |
| C — Blend + labelled CCTP "fund-to-Base" rail | Deferred | Only if A finishes green with demo budget to spare. CCTP rail must stay decoupled from yield + redeem. Out of scope now. |

**Correction logged:** CCTP V2 **is** native on Stellar (domain 27 ↔ Base domain 6, official `circlefin/stellar-cctp` Soroban contracts, live ~May 2026). Earlier assumption that Stellar wasn't a CCTP domain was wrong. It does not change the decision: **CCTP moves USDC, it does not earn** — it is a transport layer, not a yield source.

---

## 3. Requirements

**Functional**
- F-1: Vault supplies its USDC reserve to a Blend v2 pool and earns real supply APR.
- F-2: `harvest()` realizes accrued Blend interest into the existing `acc_div_per_share` dividend index — downstream claim/dividend machinery unchanged.
- F-3: `redeem()` withdraws from Blend first when idle balance is short, then pays the holder — exit stays a single Soroban tx.
- F-4: Integration is a **no-op when `pool` is unset** — legacy `drip()` path and all 308 current tests remain green.

**Non-functional**
- NF-1: 1:1 stable NAV preserved (shares == assets, both 7-dp).
- NF-2: Exit-anytime honored even under Blend pool stress (graceful degradation, not a trap).
- NF-3: No new on-chain custody surface, no second chain, no EVM.
- NF-4: Buildable under soroban-sdk 26.1.0 despite the Blend SDK pinning 25.0.1.

---

## 4. Design

### 4.1 Underlying asset migration *(load-bearing — explicitly approved)*

- Current vault underlying = **mock VFUSD** (`CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4`). Shares = `vfVLT`.
- Blend `Supply` requires the deposited asset to **BE Blend's testnet USDC** (`CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`). A mock token cannot be supplied.
- **Action:** redeploy the vault with **Blend testnet USDC** as its underlying asset. Shares (`vfVLT`) unchanged. The vault is being modified + rebuilt + redeployed anyway for `pool`/`harvest`, so the asset switch rides along at deploy time.
- **Consequences (operational, tracked in §7):** new vault address → update `deployments/stellar-testnet.json` + frontend `stellar/config.js` + re-authorize/reseed the demo agent (registry scope is per vault+token). Demo deposits then use faucet'd Blend USDC.
- Decimals align: Blend reserves are 7-dp, vault is 7-dp.

### 4.2 Contract diff (~200 LOC; no-op when `pool` unset)

Files under `soroban/contracts/rwa_vault/src/`:

- **`blend.rs` (new, ~90 LOC).** Local `#[contractclient] trait BlendPool` compiled at **SDK 26** — cross-contract calls are XDR/ABI-level, not Rust-version-bound, so this sidesteps the blend-contract-sdk 25.0.1 vs project 26.1.0 clash (same pattern used for the 1d guardrail). Wrappers:
  - `supply(e, pool, token, amount)` — self-`approve(pool, amount)` then `submit_with_allowance(from=vault, spender=vault, to=vault, [Request{request_type: 0 /*Supply*/, address: token, amount}])`.
  - `withdraw(e, pool, token, amount)` — `submit_with_allowance(... [Request{request_type: 1 /*Withdraw*/, address: token, amount}])`; `amount = i128::MAX` withdraws the full position.
  - **Auth choice:** `submit_with_allowance` (approve → pool `transfer_from`) over raw `submit` + `authorize_as_current_contract` sub-tree — simpler, fewer auth-tree footguns. Both variants call `spender.require_auth()`; the allowance path keeps the vault's authorization self-contained.
  - ABI to match exactly (verified against `blend-contracts-v2/pool`): `Request { request_type: u32, address: Address, amount: i128 }`; `submit*(e, from, spender, to, requests: Vec<Request>) -> Positions`.
- **`storage.rs` (+~5 LOC).** `set_pool` / `get_pool` for an optional `pool: Address` in instance storage (same TTL/extend cadence as `token`/`acc_div_per_share`).
- **`types.rs` (+~5 LOC).** `DataKey::Pool`; `VaultError::PoolNotSet` / `PoolAlreadySet`; `Harvest` event struct.
- **`vault.rs` (modify).**
  - `deposit()`: after `transfer_from`, if `get_pool().is_some()` → `blend::supply(USDC, amount)`.
  - `redeem()`: if vault idle balance < assets owed → `blend::withdraw(shortfall)` **first**, then the existing `transfer(vault → holder)`. If Blend can't fill (≈100% utilization) → graceful **partial + clear `VaultError`**, never a silent trap. No idle buffer by default (keep simple); a fixed buffer is the fallback only if the testnet pool proves thin in smoke testing.
  - new `harvest()` (permissionless):
    1. `interest = current bToken underlying value − total_principal` — value read via `pool.get_positions(vault)` + `pool.get_reserve(USDC).b_rate` (cheap, no withdraw-all churn).
    2. **`blend::withdraw(interest)`** — pull *only the interest delta* into the vault as idle USDC (principal stays supplied and keeps compounding). This is what makes the interest **claimable** — dividend payouts (`claim()`) pay from the vault's idle balance, so the realized yield must physically sit in the vault, exactly as `drip()`'s treasury transfer did.
    3. bump `acc_div_per_share += interest * SCALE / total_shares` **at the exact `set_acc` point `drip()` uses** (`vault.rs:76-104`); `total_principal` watermark unchanged (only interest was withdrawn).
    4. emit `Harvest`. `interest == 0` → early-return 0, no withdraw, no index bump.
- **`lib.rs` (+~8 LOC).** `mod blend;`; `pool() -> Option<Address>`; `set_pool(caller, pool)` (admin `require_auth`, set-once via `PoolAlreadySet`); `harvest() -> Result<i128>`.
- **`drip()` stays** as the no-pool fallback — nothing breaks when `pool` is unset.

### 4.3 Accounting invariant

Blend position is interest-bearing **bTokens** held inside the pool keyed by the vault address (not a transferable balance). `harvest()` is the *only* new place value enters the dividend index, and it uses the **same formula and the same `set_acc` site** as `drip()`. Therefore `settle()` / `sync_debt()` / `claim()` / `claimable()` are untouched, and the pro-rata split stays correct.

### 4.4 Harvest trigger *(default)*

Permissionless `harvest()` invoked by the existing server **fee-bump relayer** on the 60s monitor-loop cadence (`monitorLoop.js`). Keeps gas off the user, surfaces "live" yield in the graph. Alternative (on-deposit harvest) rejected as default — extra gas per deposit, no real benefit on testnet.

---

## 5. Testing strategy

- **Mock Blend pool contract** (test-only): implements `submit_with_allowance` + a test `accrue()` that simulates `b_rate` growth. Unblocks TDD despite the SDK clash blocking Blend's own `testutils`.
- TDD cases (mock pool wired via `with_blend_pool` helper):
  - `deposit_supplies_into_blend`
  - `redeem_withdraws_from_blend`
  - `redeem_partial_when_pool_illiquid` (graceful degradation, NF-2)
  - `harvest_distributes_blend_interest` (dividend index bumped, pro-rata correct)
  - `harvest_zero_interest_is_noop`
  - `harvest_requires_pool` (`PoolNotSet`)
  - `legacy_drip_path_unchanged_when_pool_unset` (F-4 regression)
- **One manual testnet smoke** before demo: supply → harvest → redeem against the live TestnetV2 pool.
- Soroban tests run under WSL only (`wsl -e bash -lc "... cargo test"`); clippy `-D warnings`.

---

## 6. Risks & mitigations

| Risk | Severity | Mitigation |
|------|:--------:|------------|
| Local `#[contractclient]` ABI drifts from real Blend v2 → silent XDR decode fail | MED | Match `Request`/`Positions`/`submit*` against `blend-contracts-v2` source; testnet smoke before merge. |
| Testnet supply APR ≈ 0 (no borrow demand) → demo number trivial | MED | Architecturally real regardless; honest label; optional **test-only** seed-borrow helper to create utilization. Demo-framing decision deferred to sub-project. |
| `redeem` traps at ≈100% Blend utilization | MED | Withdraw-first + graceful partial + clear error (NF-2); idle-buffer fallback if smoke shows thin liquidity. |
| Contract-as-spender auth tree | MED | `submit_with_allowance` (self-approve) over `authorize_as_current_contract`; budget debug time. |
| Snapshotted testnet addresses stale (5-day-old community snapshot) | LOW | **Re-verify before wiring** (§7) — pool + USDC reserve live + reserve enabled. |
| Vault asset ≠ Blend USDC | — | Resolved by §4.1 migration. |

---

## 7. Operational pre-build / cutover checklist

- [ ] Re-verify Blend testnet addresses live + USDC reserve enabled on TestnetV2 pool:
  - USDC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`
  - pool V2 `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`
  - poolFactoryV2 `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`
  - backstopV2 `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA`
- [ ] Redeploy vault with Blend USDC as underlying → new vault address.
- [ ] Update `deployments/stellar-testnet.json` (vault address, underlying token).
- [ ] Update frontend `stellar/config.js` addresses.
- [ ] Re-authorize + reseed demo agent against new vault+token (registry scope).
- [ ] Set `pool` on the vault (`set_pool`) post-deploy.

---

## 8. Out of scope

- CCTP / dual-chain (Option B/C) — deferred.
- `rwa_vault` → `yield_vault` crate rename — sub-project #1 (credibility cleanup).
- Demo/pitch framing of the APY number — demo sub-project.
- Real fee/gas realization (`gasSnapshot.js` stays mock — fine for fee-bump).

---

## 9. Sources & evidence boundaries

*(research-ops discipline — labels: [SOURCED] external docs w/ date, [LOCAL] repo code, [PRIOR] prior decision note, [INFERENCE])*

- **[SOURCED, ~Jun 2026]** Blend live mainnet+testnet: `docs.blend.capital`, `testnet.blend.capital`. `submit` signature + `RequestType` (Supply=0…Repay=5) + bTokens: `github.com/blend-capital/blend-contracts-v2/pool`. SDK clash: `blend-contract-sdk` Cargo.toml (2.25.0 → soroban-sdk 25.0.1).
- **[SOURCED, ~May 2026]** CCTP V2 native on Stellar (domain 27 ↔ Base 6): `github.com/circlefin/stellar-cctp`, `developers.stellar.org/docs/tokens/cross-chain-transfers`. Aave: Base mainnet only, no Base Sepolia (`aave.com/docs/resources/addresses`).
- **[LOCAL]** Vault internals: `rwa_vault/src/vault.rs:76-104` (drip/`set_acc`), `vault/dividend.rs` (settle/sync_debt/claimable), `storage.rs` (SCALE 1e12), `test.rs:15` ("No KYC, no compliance"). Deployed vault `CCDXZ6BU…HTN5`, VFUSD `CAJSGONI…AEB4` (`deployments/stellar-testnet.json`).
- **[PRIOR]** `memory/blend-real-yield-decision.md` (22-Jun) + `docs/superpowers/plans/2026-06-22-blend-real-yield.md` (8-task plan) — Supply=0/Withdraw=1, version clash, drip→harvest, redeem-withdraws-first all confirmed against source.

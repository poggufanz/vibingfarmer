# Blend Real-Yield Live Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the already-built Blend real-yield contract layer on the live Stellar testnet deployment — redeploy the vault on Blend testnet USDC, wire the Blend v2 pool, and prove one real supply→harvest→redeem — closing GAP-2 (F4).

**Architecture:** No new contract code — the Blend supply/withdraw/harvest path (`soroban/contracts/rwa_vault`, commits `187911f→7ad1406`) is done and tested against a mock pool. This is an **operational cutover**: re-verify Blend testnet addresses → faucet Blend USDC to the deployer → re-run `scripts/soroban/deploy-seed.sh` with `USDC_TOKEN`+`BLEND_POOL` env set (the script already gates on these) → sync `frontend/src/stellar/config.js` → run one live testnet smoke. The contract is no-op on the legacy path when `pool` is unset, so a botched cutover is recoverable by redeploying without the env vars.

**Tech Stack:** Soroban (Rust, stellar-cli) under WSL · `deployments/stellar-testnet.json` · `frontend/src/stellar/config.js` · Vitest (live testnet smoke) · Blend Capital v2 testnet pool.

## Global Constraints

- **Soroban/stellar tooling runs in WSL ONLY** — `wsl -e bash -lc "cd /mnt/c/.../soroban && ..."`, never raw PowerShell (per CLAUDE.md).
- **Network = testnet.** No mainnet, no real funds. Blend testnet USDC is faucet-only.
- **No mock token into Blend.** Blend `Supply` requires the vault underlying to BE Blend's testnet USDC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` — a VFUSD vault with `set_pool` traps on first deposit (spec §4.1).
- **`vf-deployer` identity MUST equal the existing owner** `GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS` (`demoAgentOwner`). The script auto-generates a fresh `vf-deployer` if absent → a new key diverges ownership/scoping. Gate on this before deploying.
- **`planning/` and `docs/superpowers/` are NOT actually gitignored** (they show as `??` untracked) — never `git add -A`; stage explicit paths only.
- **Commit messages: no step numbers** (e.g. no "(Task 3)") in the message text.
- **7-dp decimals** everywhere (token + vault share). Blend reserves are also 7-dp.
- Known addresses (spec §7, re-verify in Task 1):
  - Blend USDC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`
  - Blend pool V2 `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`
  - poolFactoryV2 `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`
  - backstopV2 `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA`
- Current live (pre-cutover): vault `CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5`, token VFUSD `CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4`, demo agent `CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K`.

---

### Task 1: Re-verify Blend testnet addresses live + identity gate

Spec §7 risk: the snapshotted addresses are from a 5-day-old community snapshot. Confirm the pool + USDC reserve are live and the deployer identity matches before touching anything. Pure verification — no state change.

**Files:**
- Read only: `deployments/stellar-testnet.json`

- [ ] **Step 1: Confirm `vf-deployer` identity matches the live owner**

Run (WSL):
```bash
wsl -e bash -lc "stellar keys address vf-deployer 2>/dev/null || echo MISSING"
```
Expected: prints `GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS`.
**STOP** if it prints `MISSING` or any other address — restore/import the original `vf-deployer` secret first. Do NOT let the script auto-generate a new one (it would re-authorize the demo agent under a new owner and break the live config's `demoAgentOwner`).

- [ ] **Step 2: Confirm the Blend USDC contract is live on testnet**

Run (WSL):
```bash
wsl -e bash -lc "stellar contract invoke --id CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU --source vf-deployer --network testnet -- decimals"
```
Expected: prints `7` (a live SAC/token returns its decimals). If it errors "contract not found" → the snapshot is stale; find the current Blend testnet USDC from `testnet.blend.capital` before continuing.

- [ ] **Step 3: Confirm the Blend v2 pool is live and has USDC as an enabled reserve**

Run (WSL):
```bash
wsl -e bash -lc "stellar contract invoke --id CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF --source vf-deployer --network testnet -- get_reserve --asset CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"
```
Expected: returns a reserve struct (contains `b_rate`, `config`, etc.), NOT an error. This proves the pool exists and USDC is a registered reserve. If it errors → re-source the pool address from `testnet.blend.capital`; update the addresses in `Global Constraints` and `config.js` (Task 4) before proceeding.

- [ ] **Step 4: Record findings (no commit — verification gate only)**

Note in the execution log: the live USDC address, pool address, and that decimals==7. These three values feed Tasks 2–4. No file change, no commit.

---

### Task 2: Faucet Blend testnet USDC to the deployer

The deployer is NOT the USDC issuer, so it cannot mint — it must receive faucet'd Blend USDC. The vault deposit smoke (Task 5) also needs the demo flow to hold USDC, but the *deployer* needs enough to seed the demo treasury at deploy time.

**Files:** none (on-chain + browser action)

- [ ] **Step 1: Ensure the deployer account is funded with XLM (for fees + trustline)**

Run (WSL):
```bash
wsl -e bash -lc "stellar keys fund vf-deployer --network testnet"
```
Expected: success or "account already funded". (Friendbot funds XLM only — not USDC.)

- [ ] **Step 2: Establish a trustline / contract balance for Blend USDC, then faucet it**

Blend testnet USDC is distributed via the Blend testnet app faucet. In a browser, open `https://testnet.blend.capital`, connect a wallet controlled by the `vf-deployer` secret (or its G-address `GCIOUP4U…HNS`), and use the app's **Faucet** to mint test USDC to that address. (If the token exposes a public `mint`/faucet contract function instead, invoke it: `wsl -e bash -lc "stellar contract invoke --id CAQCFVLO…RCJU --source vf-deployer --network testnet -- mint --to GCIOUP4U…HNS --amount 10000000000"` — only works if the token permits permissionless mint; otherwise use the app faucet.)

- [ ] **Step 3: Verify the deployer holds Blend USDC**

Run (WSL):
```bash
wsl -e bash -lc "stellar contract invoke --id CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU --source vf-deployer --network testnet -- balance --id GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS"
```
Expected: a balance > `0` in base units (e.g. `10000000000` = 1000 USDC at 7-dp). **STOP** if `0` — the faucet did not land; retry Step 2. No commit (off-chain prerequisite).

---

### Task 3: Cutover deploy — vault on Blend USDC + wired pool

Re-run the deploy script with the two cutover env vars set. The script already deploys a fresh vault on the external token, runs `set_pool`, re-authorizes the demo agent against the new vault+token, and writes `blendPool` into the JSON.

**Files:**
- Run: `scripts/soroban/deploy-seed.sh`
- Modify: `deployments/stellar-testnet.json` (written by the script; then patched to restore agent fields)

- [ ] **Step 1: Run the cutover deploy**

Run (WSL):
```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && USDC_TOKEN=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF bash scripts/soroban/deploy-seed.sh"
```
Expected: ends with `Wrote .../deployments/stellar-testnet.json` and `VAULT=<NEW_VAULT_ADDR> TOKEN=CAQCFVLO…RCJU`, plus the `Wiring Blend lending pool …` line. Capture `<NEW_VAULT_ADDR>` — every later step needs it.

- [ ] **Step 2: Verify the JSON reflects the new vault + token + pool**

Run:
```bash
cat deployments/stellar-testnet.json
```
Expected: `vault.address` == new vault, `vault.token` == `CAQCFVLO…RCJU`, and a new `vault.blendPool` == `CCEBVDYM…44HGF`. **Note the regression:** the script's JSON writer omits `demoAgentVersion`, `demoAgentOwner`, `demoAgentSigner` — they will be missing now.

- [ ] **Step 3: Restore the dropped demo-agent fields**

The demo agent ACCOUNT is reused (not redeployed), so its owner/signer/version are unchanged and still valid. Re-add them to `deployments/stellar-testnet.json` exactly:
```json
  "demoAgentVersion": 2,
  "demoAgentOwner": "GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS",
  "demoAgentSigner": "dd4139236bc836df336b1d6a360ad90d234613950cff078ebc03d28876c1698b",
```
Insert these three lines after `"demoAgentAccount": "..."` (matching the pre-cutover field order). Save.

- [ ] **Step 4: Confirm the pool wired on-chain**

Run (WSL):
```bash
wsl -e bash -lc "stellar contract invoke --id <NEW_VAULT_ADDR> --source vf-deployer --network testnet -- pool"
```
Expected: prints `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` (the `pool()` getter returns `Some(pool)`).

- [ ] **Step 5: Commit**

```bash
git add deployments/stellar-testnet.json
git commit -m "chore: cutover live vault to Blend USDC + wired v2 pool"
```

---

### Task 4: Sync frontend config to the new deployment

`frontend/src/stellar/config.js` is the frontend source of truth and currently points at the old VFUSD vault. Update the three addresses; `config.test.js` cross-checks them.

**Files:**
- Modify: `frontend/src/stellar/config.js:13` (`SOROBAN_VAULT_ADDRESS`), `:17` (`SOROBAN_TOKEN_ADDRESS`), `:28` (`SOROBAN_BLEND_POOL_ADDRESS`)
- Test: `frontend/src/stellar/config.test.js`

**Interfaces:**
- Consumes: `<NEW_VAULT_ADDR>` from Task 3.
- Produces: `SOROBAN_VAULT_ADDRESS`, `SOROBAN_TOKEN_ADDRESS`, `SOROBAN_BLEND_POOL_ADDRESS` consumed by `orchestrator.js`, `agentDeposit.js`, the live smoke (Task 5), and UI.

- [ ] **Step 1: Inspect what config.test.js asserts**

Run:
```bash
cd frontend && npx vitest run src/stellar/config.test.js
```
Expected: PASS against the *old* addresses (baseline). Read the test to see whether it pins literal addresses or cross-checks `deployments/stellar-testnet.json`. If it pins literals, those literals must be updated in Step 2 too.

- [ ] **Step 2: Update the three address constants**

In `frontend/src/stellar/config.js`:
- `:13` → `export const SOROBAN_VAULT_ADDRESS = '<NEW_VAULT_ADDR>'`
- `:17` → `export const SOROBAN_TOKEN_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'`
- `:28` → `export const SOROBAN_BLEND_POOL_ADDRESS = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'`
(If config.test.js pins literal addresses, update those literals identically.)

- [ ] **Step 3: Run config + full frontend suite**

Run:
```bash
cd frontend && npx vitest run
```
Expected: all green (the suite was 312 pass at HEAD; same count expected — these are constant swaps). Fix any address-literal test that still references the old vault.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/stellar/config.js
git commit -m "chore: point frontend config at Blend-USDC vault + pool"
```

---

### Task 5: Live testnet smoke — supply → harvest → redeem

Prove the real integration end-to-end against the live Blend pool. Mock-pool unit tests already pass; this is the ABI-drift / real-pool proof the spec requires (§5, §6 risk row 1). Extends the existing live deposit smoke (`a6af1b8`, loads `DEMO_AGENT_SECRET` from `.env` per `e151a32`).

**Files:**
- Test: `frontend/src/stellar/agentDeposit.test.js` (or the existing live-smoke file — locate the test tagged as the live testnet deposit) — add a gated `supply→harvest→redeem` smoke.

**Interfaces:**
- Consumes: `SOROBAN_VAULT_ADDRESS`, `SOROBAN_TOKEN_ADDRESS` (Task 4), `DEMO_AGENT_SECRET` from `frontend/.env`, `readVaultShares`/`readTokenBalance`/`runAgentDeposit` (`frontend/src/stellar/agentDeposit.js`).

- [ ] **Step 1: Locate the existing live deposit smoke**

Run:
```bash
cd frontend && grep -rl "live" src/stellar/*.test.js
```
Read the matched file to reuse its env-gating pattern (it skips unless a testnet flag + `DEMO_AGENT_SECRET` are present). The new smoke must follow the same gate so the normal `vitest run` stays offline-green.

- [ ] **Step 2: Write the failing live smoke (gated)**

Add to the located live-smoke file:
```js
// gated: only runs when RUN_LIVE_SMOKE=1 and DEMO_AGENT_SECRET present (same gate as the deposit smoke)
itLive('supplies into Blend, harvests interest, then redeems', async () => {
  const sharesBefore = await readVaultShares(DEMO_AGENT)
  // 1. deposit → vault.deposit supplies into Blend (pool wired)
  await runAgentDeposit({ amount: 100_0000000n /* 100 USDC @7dp */ })
  const sharesAfter = await readVaultShares(DEMO_AGENT)
  expect(sharesAfter).toBeGreaterThan(sharesBefore)
  // 2. harvest → permissionless; realizes interest delta into the dividend index (0 ok on a cold pool)
  const harvested = await invokeVault('harvest')
  expect(harvested).toBeGreaterThanOrEqual(0n)
  // 3. redeem → withdraws from Blend first, pays the holder; exit stays one tx
  const balBefore = await readTokenBalance(DEMO_AGENT)
  await invokeVault('redeem', { from: DEMO_AGENT, shares: sharesAfter - sharesBefore })
  const balAfter = await readTokenBalance(DEMO_AGENT)
  expect(balAfter).toBeGreaterThan(balBefore)
}, 120_000)
```
(Use the file's existing helper names for invocation; `invokeVault` here stands for whatever the smoke uses to call vault methods — reuse the deposit smoke's relay/invoke helper rather than inventing one.)

- [ ] **Step 3: Run it and watch it pass against the live pool**

Run (with the live gate enabled):
```bash
cd frontend && RUN_LIVE_SMOKE=1 npx vitest run src/stellar/<live-smoke-file>.test.js
```
Expected: PASS — shares minted on deposit, harvest returns ≥0, redeem increases the holder's USDC balance. If `redeem` throws a partial/illiquidity `VaultError`, that is the NF-2 graceful-degradation path, not a crash — note the pool is thin and continue (Task 6 addresses utilization).

- [ ] **Step 4: Confirm the default offline suite still skips the live smoke**

Run:
```bash
cd frontend && npx vitest run
```
Expected: all green, live smoke SKIPPED (gate off). Same pass count as Task 4 Step 3.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/<live-smoke-file>.test.js
git commit -m "test: live Blend supply-harvest-redeem testnet smoke"
```

---

### Task 6 (optional / honest-framing): non-zero APR for the demo

Spec §6 risk row 2: a cold testnet pool may show ~0% APR (no borrow demand) → harvest yields a trivial number. This task is OPTIONAL — the integration is architecturally real regardless. Do it only if the demo needs a visibly non-zero number AND there is budget.

**Files:** none (on-chain action) or a test-only helper if scripted.

- [ ] **Step 1: Decide framing vs seeding**

If the demo can honestly say "real mechanism, testnet supply rate (near-zero without borrow demand)" → DONE, skip the rest. Per the "prove claims in code / no over-claiming" standard, the honest label is acceptable and lower-risk.

- [ ] **Step 2 (only if seeding): create borrow utilization**

To make supply APR visible, the pool needs a borrower. Using a *second* funded testnet identity, supply collateral and borrow USDC from the same pool to push utilization > 0, then let interest accrue before the demo `harvest()`. This requires collateral the pool accepts and is testnet-only theater — keep it labelled as such. Document the borrower identity + amounts in the execution log. No production claim.

- [ ] **Step 3: Re-run harvest and confirm a non-zero delta**

Run (WSL):
```bash
wsl -e bash -lc "stellar contract invoke --id <NEW_VAULT_ADDR> --source vf-deployer --network testnet -- harvest"
```
Expected: returns interest > 0 after utilization + time. No commit (on-chain only) unless a helper script was added.

---

### Task 7: Mark GAP-2 closed in the docs

Reflect the cutover in the three living docs so the audit trail stays honest.

**Files:**
- Modify: `docs/CURRENT-STATE.md` (§1 TL;DR item 2, §6 GAP-2)
- Modify: `planning/Vibing_Farmer_Master_Strategy.md` (F4 status row)

- [ ] **Step 1: Update CURRENT-STATE GAP-2**

In `docs/CURRENT-STATE.md`, change the GAP-2 entry from "Yield is entirely mock" to: real Blend v2 supply APR live on testnet (vault redeployed on Blend USDC `CAQCFVLO…RCJU`, pool `CCEBVDYM…44HGF` wired, smoke proven on <date>); `drip()` retained as no-pool fallback. Update the §1 TL;DR item 2 accordingly. Leave the "multi-vault is advisor fiction" caveat — that is a separate, still-true framing point.

- [ ] **Step 2: Update master-strategy F4 row**

In `planning/Vibing_Farmer_Master_Strategy.md`, change the F4 Status cell from `🟡 contract done (#2); live cutover open` to `✅ done — Blend real yield live on testnet (cutover <date>)`. Update the "Sisa MVP nyata" line to drop F4.

- [ ] **Step 3: Commit (explicit paths only — these dirs are NOT gitignored)**

```bash
git add docs/CURRENT-STATE.md
git commit -m "docs: mark GAP-2 closed — Blend real yield live on testnet"
```
(Do NOT `git add` `planning/` — it is intentionally kept out of commits; the strategy-doc edit stays a local working change.)

---

## Self-Review

**Spec coverage (vs `2026-06-27-real-yield-vault-blend-design.md` §7 checklist):**
- §7 "re-verify addresses live + reserve enabled" → Task 1 ✅
- §7 "redeploy vault with Blend USDC underlying" → Task 3 Step 1 ✅
- §7 "update deployments JSON" → Task 3 Steps 2–3 ✅
- §7 "update frontend config.js" → Task 4 ✅
- §7 "re-authorize + reseed demo agent" → handled inside deploy-seed.sh (Task 3 Step 1; authorize call lines 67-69) ✅
- §7 "set_pool post-deploy" → handled by `BLEND_POOL` env in deploy-seed.sh (Task 3 Step 1; verified Task 3 Step 4) ✅
- §5 "one manual testnet smoke: supply→harvest→redeem" → Task 5 ✅
- §6 risk "testnet APR ≈ 0" → Task 6 ✅
- §6 risk "ABI drift silent decode fail" → Task 5 (real-pool smoke is the catch) ✅
- §6 risk "redeem traps at ~100% utilization" → Task 5 Step 3 notes the NF-2 partial path ✅
- Prerequisite not in §7 but required: faucet Blend USDC to deployer → Task 2 ✅
- Footgun not in §7: deploy-seed auto-generates `vf-deployer` → identity gate Task 1 Step 1 ✅
- Footgun not in §7: JSON writer drops demo-agent fields → restore Task 3 Step 3 ✅

**Placeholder scan:** Task 5 leaves `<live-smoke-file>` and the exact invoke-helper name to be resolved at execution (the file is located in Task 5 Step 1) — this is a genuine discover-then-use dependency, not a lazy placeholder; the located helper names must be substituted, not invented. All addresses, env vars, and commands are literal.

**Type consistency:** `SOROBAN_VAULT_ADDRESS`/`SOROBAN_TOKEN_ADDRESS`/`SOROBAN_BLEND_POOL_ADDRESS` (config.js) and `USDC_TOKEN`/`BLEND_POOL` (script env) are used identically across Tasks 3–5. `pool()`/`harvest()`/`set_pool`/`deposit`/`redeem` match the contract getters/methods in `rwa_vault` (spec §4.2).

**Known open dependency:** Task 2 faucet mechanism (app UI vs contract mint) cannot be fully pinned without hitting `testnet.blend.capital` live — Task 1 Step 2/3 verification de-risks it, and Task 2 gives both paths. This is the one externally-gated step.

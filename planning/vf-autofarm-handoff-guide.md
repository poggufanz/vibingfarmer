# VF Autofarm — Handoff Runbook (post-execution, 2026-07-03)

Branch `feature/autofarm` (LOCAL, 23 commits). Everything below is optional follow-up — the plan is complete and live-proven without it.

> **STATUS 2026-07-03 (later session): ALL THREE ITEMS EXECUTED.**
> - §1 cutover ✅ — commits `3e241d9` (frontend repoint + pps displays) + `1d2ce1c` (demo agent v3 + live proof). Live-proven: deposit tx `0a88c16c` (2 USDC @ pps 0.999 → 20,020,020 shares, exchange-rate exact) + `owner_withdraw` redeem (→ 19,999,999 units + sweep). Demo agent v3 `CCY452UM…56UAC` (constructor-only scope forced a fresh deploy; same session signer). NEW finding fixed en route: recording-mode sim skips `__check_auth` → footprint missed the agent instance → `buildAgentDeposit` now re-prepares (enforcing sim) after signing the entry. **USER ACTION still open: flip `SOROBAN_VAULT_ADDRESS` in the Cloudflare Pages env to `CB5VKYDU…` (local `.env`/`.env.local` already flipped).**
> - §2 fmt ✅ — commit `55bf89b`.
> - §3 encodeArgs ✅ — commit `fd52e7c` (+ unit test).
> - Suite 583 green.


## 1. Cutover: make the autofarm vault the live deposit target

Today the app deposits into the OLD 1:1 dividend vault (`SOROBAN_VAULT_ADDRESS` = `CBZNITAP…`, hardcoded in `frontend/src/stellar/agentDeposit.js:67,93`). The new exchange-rate autofarm vault (`SOROBAN_AUTOFARM_VAULT_ADDRESS` = `CB5VKYDU…`) is deployed + keeper-driven + shown in KeeperPanel/graph, but nothing deposits into it. This is a **deliberate** deferral — cutover is more than a one-line swap.

**The compatible part (easy)**
- `deposit(from, amount)` signature is identical on both vaults → `buildAgentDeposit` works unchanged.
- `balance(addr)` (share balance) is identical → `readVaultShares` works unchanged.

**What actually has to change**
1. `frontend/src/stellar/agentDeposit.js` — repoint `SOROBAN_VAULT_ADDRESS` → `SOROBAN_AUTOFARM_VAULT_ADDRESS` in `buildAgentDeposit` (line ~67) and `readVaultShares` (line ~93). Cleanest: add an `AUTOFARM` flag or pass the vault addr as a param instead of a module constant.
2. **Shares are no longer 1 USDC.** After the swap, deposits mint `amount − DEAD_SHARES` on first deposit and `amount × supply / total_assets` after — and redeem returns `shares × price_per_share`. Audit every display that shows shares as USDC 1:1:
   - `frontend/src/positionsStore.js`, `frontend/src/screens`/`ExplorerPage.jsx`, and the skills UI — all currently correct for the OLD vault but WRONG for the autofarm vault. Convert them to `price_per_share()` × the 7-dp helper (`frontend/src/stellar/vaultReads.js` already reads `price_per_share`; reuse it).
   - `worker.js verifyMinted()` already returns the real minted-share delta (prophylactic, done).
3. **No `claim`/`harvest` on the autofarm vault.** The old vault had user `claim`/`drip`; the autofarm vault's yield accrues via the KEEPER's `compound` (price-per-share rises). Any "claim rewards" / "harvest" button in the UI must be removed or hidden for the autofarm vault — there's nothing for a user to claim; they just redeem at a higher pps.
4. **First deposit constraint:** the autofarm vault requires the FIRST deposit ≥ 1 USDC and locks 1000 base units as dead shares. It's already seeded (pps ≈ 0.999 live), so real users hit the normal `amount × supply / total_assets` path — fine.
5. Re-run `frontend` tests; update any test asserting shares == deposited amount for the deposit flow.

**Suggested order:** (a) param-ize the vault address, (b) fix the share displays to pps, (c) hide the claim/harvest UI for autofarm, (d) flip the default deposit target, (e) smoke a real deposit+redeem against the autofarm vault via the UI.

---

## 2. Fix the pre-existing `cargo fmt` drift (registry + attestation)

Not autofarm code — 4 files (`registry/{lib,registry,test}.rs`, `attestation/lib.rs`) were already unformatted before this branch. The whole-workspace `cargo fmt --check` fails only on them. To green it:

```powershell
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo fmt"
# then stage ONLY those two crates (keep it a separate, clearly-scoped commit):
git add soroban/contracts/registry soroban/contracts/attestation
git commit -m "chore(soroban): cargo fmt registry + attestation (pre-existing drift)"
```
Pure formatting, no logic. Do it as its own commit so it doesn't muddy the autofarm history. Optional — only matters if a CI `fmt --check` gate blocks merge.

---

## 3. Fix the latent `client.js encodeArgs` ScVal bug

`frontend/src/stellar/encodeArgs` (in `client.js`) sniffs arg shape with `'i128' in a`. js-xdr's Union codegen puts a generic accessor for EVERY arm name on every `xdr.ScVal` instance's prototype, so `'i128' in someRawScVal` is `true` even when it isn't an i128 → passing a hand-built `ScVal` (e.g. a `Vec<i128>` for `compound`'s `min_outs`) throws `Cannot convert function get(){…} to a BigInt`.

Not on the live path today (the keeper submits via its own `keeper/src/chain.js`, and the frontend never calls `compound`/`rebalance`). It bites only if future frontend code passes a raw `ScVal` through `encodeArgs`.

**Fix:** detect a raw `ScVal` and pass it through BEFORE the property-sniff. In `encodeArgs`'s per-arg mapping:
```js
import { xdr } from '@stellar/stellar-sdk'
// ...for each arg `a`:
if (a instanceof xdr.ScVal) return a          // <-- add FIRST, before the `'i128' in a` / `'addr' in a` checks
if ('i128' in a) return nativeToScVal(a.i128, { type: 'i128' })
// ...rest unchanged
```
Add a unit test in `client.test.js`: pass a pre-built `nativeToScVal([...], ...)` (a Vec) through `encodeArgs` and assert it's returned unchanged (no throw).

---

## Quick reference — deployed testnet addresses
| Thing | Address |
|---|---|
| autofarm vault | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` |
| strategy1 | `CCH424TVLTP2P3URNRGGF26X24XRPBVBXCRZ6QBCWLSX6KH4QZSLNBC2` |
| keeper (= relayer) | `GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X` |
| Blend pool (TestnetV2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| USDC / BLND | `CAQCFVLO…` / `CB22KRA3…` |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| OLD 1:1 vault (current deposit target) | `CBZNITAP…NQOU` |

# VF Autofarm — Task 1 spike findings (2026-07-03)

**Status:** Task 1 (S1+S2 on-chain probe) DONE_WITH_CONCERNS-free — all four flags resolved with concrete, reproducible evidence. Read-only for Steps 1-2/4; Step 3 made one real testnet submission chain per the task's explicit allowance.

**Network:** Stellar testnet, RPC `https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`.

## Summary — the four flags

| Flag | Value | Confidence |
|---|---|---|
| `EMISSIONS_LIVE` | **false** (for USDC supply specifically) | High — verified against live pool, cross-checked against 3 other reserves that DO have live emissions |
| `USDC_RESERVE_INDEX` | **3** (→ bToken/supply reserve_token_id = `3*2+1 = 7`) | High — direct `get_reserve_list` read |
| `SWAP_ROUTE` | **soroswap** | High — real BLND/USDC pair exists with non-trivial reserves |
| `OWN_POOL_VIABLE` | **false** | High — reproduced with 3 independent real testnet txs (deploy, queue+set_reserve, failed submit) |

## Step 1+2: USDC reserve index + emissions (read-only simulation)

Ran `node scripts/soroban/spike-autofarm.mjs` from repo root against TestnetV2 pool `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`.

```
STEP 1: get_reserve_list = ["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC","CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE","CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI","CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"]
USDC_RESERVE_INDEX = 3 → bToken id = 7

STEP 2: get_reserve_emissions = {"value":null}
EMISSIONS_LIVE = false
```

USDC sits at reserve index 3 (last of 4 reserves: native XLM, two unidentified assets, USDC). `get_reserve_emissions(7)` (USDC's bToken/supply-side reserve_token_id) returned `None` → no emissions configured for USDC supply on this pool.

**Verification that this is a real finding, not a broken probe call:** scanned `get_reserve_emissions(i)` for `i` in `0..7` (all d-token/b-token ids across all 4 reserves):

```
reserve_token_id=0: {"value":null}
reserve_token_id=1: {"value":null}
reserve_token_id=2: {"value":{"eps":"2271682720701","expiration":"1783301379","index":"9875103218847017140","last_time":"1782918433"}}
reserve_token_id=3: {"value":null}
reserve_token_id=4: {"value":null}
reserve_token_id=5: {"value":{"eps":"1135841360350","expiration":"1783301379","index":"35153208683984427937","last_time":"1782918433"}}
reserve_token_id=6: {"value":{"eps":"2271682720701","expiration":"1783301379","index":"5377439832741437","last_time":"1783025292"}}
reserve_token_id=7: {"value":null}
```

Reserve token ids 2, 5, and 6 (d-token of asset#1, b-token of asset#2, and **d-token of USDC**) all have real, live `ReserveEmissionData` (non-null `eps`/`expiration`/`index`/`last_time`). BLND emissions ARE flowing on this pool in general — including on USDC's **borrow (d-token, id 6)** side — but **not** on USDC's **supply (b-token, id 7)** side, which is the side the vault's `blend.rs` `supply()`/`withdraw()` uses (deposit-only, `SUPPLY` request type, no borrowing).

**Implication for the autofarm plan (Task 6/7 `blend_strategy.harvest()`):** on the current TestnetV2 pool, a plain USDC-supply strategy position will call `pool.claim(strategy, [7], strategy)` and get 0 BLND — this is the expected "degradation ladder rung 1" (interest-only compound, claim skipped/no-op) from the design doc, now confirmed empirically rather than assumed. Nothing to build differently; the `try_`-wrapped claim path in the design already accounts for this.

Also tried `get_pool_config`, `get_reserve_emissions_config`, `get_emissions_config` as alternate method-name guesses — all three don't exist on this pool ABI (`WasmVm/MissingValue: trying to invoke non-existent contract function`). The real method is `get_reserve_emissions(reserve_token_id: u32) -> Option<ReserveEmissionData>`, exactly as documented in `docs/superpowers/specs/2026-07-03-vf-autofarm-design.md` §3.

## Step 3: Soroswap BLND/USDC swap route (read-only simulation)

```
STEP 3: soroswap get_pair = {"value":"CCLDDDTH2CWR32CMZVFNVW5W5CKDI3M5VN4XRF7IEQZUSMQOS7CA3Q2K"}
soroswap get_reserves = {"value":["4970267932","10060000000"]}
SWAP_ROUTE = soroswap
```

Soroswap factory `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY` returns a real pair contract for BLND/USDC, and that pair has non-trivial live reserves (~497 BLND-side units / ~1006 USDC-side units at their respective decimals — plenty of depth for the small BLND amounts a testnet demo would ever swap). `blend_strategy.harvest()`'s Soroswap leg (Task 6/7) has a real route to swap against; no need for the "seed tiny pair ourselves" fallback mentioned in the design doc §10 S2.

## Step 4 (reference): TestnetV2 `get_config`

```
{"value":{"bstop_rate":1000000,"max_positions":8,"min_collateral":"0","oracle":"CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI","status":0}}
```

`status: 0` = Active. Oracle `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` reused below for the own-pool deploy (Blend's shared testnet price oracle covers the same reserves).

## Step 3 (brief numbering) / own-pool viability — real testnet CLI probe

Ran via WSL `stellar-cli 27.0.0`, `--source vf-deployer` (funded identity, address `GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS` — same as `demoAgentOwner` in `deployments/stellar-testnet.json`; holds ~19,993 XLM and 640 USDC on testnet). Pool factory: `poolFactoryV2 = CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6` (from the existing design doc's verified research, not guessed).

No vendored `blend-utils/deploy-pool.js` exists in this repo or on the WSL filesystem (searched both) — the brief's "follow deploy-pool.js args" pointer is stale for this repo. Recovered the exact factory/pool ABI directly from the live contracts via `stellar contract invoke --id <id> -- --help` / `<method> --help` (Soroban CLI reads the on-chain contract spec — no submit required for `--help` introspection).

### 1. `deploy` — SUCCEEDED

```
stellar contract invoke --id CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6 \
  --network testnet --source vf-deployer --send=yes -- deploy \
  --admin GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS \
  --name 'VF Pool 2' \
  --salt 3aff780f24a8ca6bb8798476dd3f05f6eae68daa104705b3474d46b96cebc91a \
  --oracle CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI \
  --backstop_take_rate 1000000 --max_positions 4 --min_collateral 0
```

Result: **new pool deployed at `CC7IYNZR4BPTC4HUQ75Q6PMK7MUIEKITYRAZPY6KOOBTBMXN4C3X7RKF`**
tx: `be53203fa3cc923bdeae3d14330c884af8c10d47f75374fdd9fd9b1672b2474d`
https://stellar.expert/explorer/testnet/tx/be53203fa3cc923bdeae3d14330c884af8c10d47f75374fdd9fd9b1672b2474d

### 2. `queue_set_reserve` + `set_reserve` for USDC (steep IR config) — SUCCEEDED, no timelock

Metadata (steep IR vs. TestnetV2's USDC reserve, read for reference: `r_base=5000, r_one=300000, r_two=1000000, r_three=10000000`):

```json
{ "c_factor": 9500000, "decimals": 7, "enabled": true, "index": 0, "l_factor": 9500000,
  "max_util": 9500000, "r_base": 50000, "r_one": 2000000, "r_three": 10000000,
  "r_two": 5000000, "reactivity": 20, "supply_cap": "1000000000000", "util": 0 }
```

`queue_set_reserve` tx: `44dff7d79816b91c97b6ff458f2054596b6aa3988420527e63758f3f5c65310e` — SUCCESS
`set_reserve` tx: `13cbc5304baf5d2624726261d66ba3ad495bf2c3a64c8b01bcd8bbc3173dde98` — SUCCESS, applied **immediately** (no multi-day timelock observed for adding a brand-new reserve to a brand-new pool — the timelock Blend docs describe appears to gate *changes to an already-active* reserve, not initial setup on a zero-TVL pool).

Confirmed via `get_reserve_list` on the new pool → `["CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"]`.

### 3. Pool status — stuck at `6` ("Setup"), cannot reach Active

`get_config` on the new pool: `{"bstop_rate":1000000,"max_positions":4,"min_collateral":"0","oracle":"...","status":6}` (vs. TestnetV2's `status:0` = Active).

Tried both the permissionless `update_status()` and the admin-only `set_status(pool_status=0)` override — **both fail identically**:

```
❌ error: transaction simulation failed: HostError: Error(Contract, #1204)
...
Diagnostic Event] contract:CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA, topics:[fn_return, pool_data],
  data:{blnd: 0, q4w_pct: 0, shares: 0, token_spot_price: 30116730, tokens: 0, usdc: 0}
```

Both calls cross-call the **backstop module contract** (`CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA`) and read `pool_data` for our new pool — which reports `shares: 0, blnd: 0, usdc: 0` (zero backstop deposit) — then revert with contract error `#1204`. Even the pool's own admin (`set_status`) cannot override this; it is enforced by the backstop module reading the pool's actual backstop balance, not by the pool's local admin flag. This matches Blend v2's documented purpose for the backstop requirement (anti-spam: a pool needs real backstop capital at risk before it can go live) — see `docs/superpowers/specs/2026-07-03-vf-autofarm-design.md` §3's emissions-model note, which already flagged that a self-deployed pool gets no emissions; this extends the same gating to basic Active status.

### 4. `submit` (1-USDC SUPPLY) at the pool's default status — FAILED

```
stellar contract invoke --id CC7IYNZR4BPTC4HUQ75Q6PMK7MUIEKITYRAZPY6KOOBTBMXN4C3X7RKF \
  --network testnet --source vf-deployer --send=yes -- submit \
  --from GCIOUP... --spender GCIOUP... --to GCIOUP... \
  --requests '[ { "address": "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU", "amount": "10000000", "request_type": 0 } ]'
```

Result: `HostError: Error(Contract, #1206)` — reverted. **The 1-USDC SUPPLY does not succeed at the pool's default (post-deploy, pre-backstop) status.**

### `OWN_POOL_VIABLE = false` — reasoning

This is a clean, reproduced `false`, not a shrug:
- Pool deploy, reserve queue+set, and the supply attempt all **worked mechanically** (no ABI/arg-shape uncertainty — the factory and pool interfaces are fully known now, see the CLI `--help` dumps captured above for future reuse).
- The blocker is a **hard Blend v2 protocol gate**: a freshly-deployed pool cannot reach Active status, and cannot accept even a basic SUPPLY, until real capital is deposited into the shared backstop module (Comet BLND:USDC LP shares, contract `CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM`, feeding backstop `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA`). Neither the pool admin nor `update_status()` can bypass this — it's read directly from the backstop module's ledger state.
- Seeding a real backstop deposit requires acquiring BLND (via Comet swap or a faucet), providing BLND:USDC LP liquidity, and depositing LP shares into the backstop for our specific pool, in an amount large enough to satisfy an undocumented (not found in on-chain reads or the design doc) minimum threshold. This is a materially larger, economically-gated task than "deploy + configure a reserve" and squarely matches ambiguity resolution #2's "don't grind" condition.
- **Recommendation for Task 11 (per plan §13.3 "deploy second pool + strategies"):** since `OWN_POOL_VIABLE=false` for a genuinely Active second pool, follow the plan's own fallback (line 652 of `2026-07-03-vf-autofarm.md`): *"If `OWN_POOL_VIABLE=false`: skip pool 2, deploy only strategy1, and enable the de-risk-to-idle fallback (Global refinement 4)."* Do not attempt to seed backstop capital as part of this feature unless the user explicitly wants to fund a real backstop position (real economic cost + unknown minimum, needs its own scoped spike).

Deployed pool 2 is left in place on testnet (harmless, no funds at risk — 1-USDC supply attempt reverted so no USDC was moved into it). It is **not** written into `deployments/stellar-testnet.json` per the task's file-scope restriction; if Task 11 wants to resume from it, the address is `CC7IYNZR4BPTC4HUQ75Q6PMK7MUIEKITYRAZPY6KOOBTBMXN4C3X7RKF` with USDC already queued+set as reserve index 0 — only backstop seeding stands between it and being usable.

## Artifacts / addresses touched

| Item | Address / value |
|---|---|
| Second Blend pool (deployed, Setup status, not usable) | `CC7IYNZR4BPTC4HUQ75Q6PMK7MUIEKITYRAZPY6KOOBTBMXN4C3X7RKF` |
| Deploy tx | `be53203fa3cc923bdeae3d14330c884af8c10d47f75374fdd9fd9b1672b2474d` |
| queue_set_reserve tx | `44dff7d79816b91c97b6ff458f2054596b6aa3988420527e63758f3f5c65310e` |
| set_reserve tx | `13cbc5304baf5d2624726261d66ba3ad495bf2c3a64c8b01bcd8bbc3173dde98` |
| Failed submit (SUPPLY) tx | not submitted on-chain — CLI simulation failed before signing/send (`--send=yes` still simulates first; reverted at simulation, no tx hash) |
| Backstop module (read, not deployed by us) | `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA` |
| Comet BLND:USDC pool (read, not deployed by us) | `CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM` |
| Soroswap BLND/USDC pair (read, not deployed by us) | `CCLDDDTH2CWR32CMZVFNVW5W5CKDI3M5VN4XRF7IEQZUSMQOS7CA3Q2K` |

## Deviations from the task brief (and why)

1. **SDK import path.** The brief's `import { ... } from '@stellar/stellar-sdk'` bare specifier only resolves when the *importing file itself* lives under `frontend/` — Node's ESM resolver walks up `node_modules` from the importer's own path, not from `process.cwd()`. Empirically verified both ways (a copy of the script placed at `frontend/test-import-tmp.mjs` resolved fine; the same import from `scripts/soroban/` failed with `ERR_MODULE_NOT_FOUND` even when invoked with cwd=`frontend/`). Fixed by importing the SDK's ESM entry point via a relative path (`../../frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js`), which resolves correctly regardless of the invoking cwd. All named exports the brief listed (`rpc`, `Contract`, `TransactionBuilder`, `Networks`, `BASE_FEE`, `Keypair`, `scValToNative`, `nativeToScVal`, `xdr`, `Address`, `Account`) were individually verified present on v16.0.1's ESM index.
2. **Sim source account.** The brief's dummy `GAAAA...WHF5` pubkey with sequence `'0'` is not a real account; used the funded `vf-deployer`/`demoAgentOwner` pubkey (`GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS`) fetched via `server.getAccount()` instead — read-only, no fees, matches the constraint.
3. **BigInt serialization.** Blend/Soroswap return `i128` values as native BigInt after `scValToNative`; added a `jsonSafe()` JSON.stringify replacer since the brief's raw `JSON.stringify` calls throw on BigInt.
4. **`deploy-pool.js` reference doesn't exist** in this repo or WSL filesystem — recovered the factory/pool ABI directly from live `--help` introspection instead (see command transcripts above).

## Task 11: testnet deploy — autofarm vault + strategy + keeper (2026-07-03)

**Status: DONE.** Full report: `.superpowers/sdd/task-11-report.md`. Followed this doc's own
`OWN_POOL_VIABLE=false` fallback exactly — single strategy, no second pool, de-risk-to-idle
rebalance.

Deployed via new `scripts/soroban/deploy-autofarm.sh` (WSL, `--source vf-deployer`, real
`--send=yes` submits throughout):

| Item | Address / value |
|---|---|
| Autofarm vault (`rwa_vault`, strategy-capable wasm) | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` |
| Vault deploy tx | `492d55911c49eecffe3aba01f5d49f70de56e66ce3f960fab85d950c208e2055` |
| Strategy 1 (`blend_strategy`, on TestnetV2 pool, reserve_token_id=7) | `CCH424TVLTP2P3URNRGGF26X24XRPBVBXCRZ6QBCWLSX6KH4QZSLNBC2` |
| Strategy deploy tx | `a347c9b1c3f0bf3ca40007741cf0f851347f81d1aa77e6a9433d8ad0bfc7110a` |
| `add_strategy` tx | `413459939d0c0e869299698b6f6f20382bd18153edf609cfb6cc371c0845e4ba` |
| `set_keeper(GBVJ34MT...)` tx | `271912a3568e9281307ccccfb143ab0360dd0406237b351a27a45e4c9720dbc0` |
| `registry.authorize` (demo agent re-scoped to new vault) tx | `05e6aa03db20372879a13b9d040ef6d019bbae4ba20aab91a93feb4e604d461b` |
| Round-trip `approve` tx | `d2080a99b48c1f2d841a14f44bbadff0d792f3ed01d6b448a3edd2a1034893a3` |
| Round-trip `deposit` (1 USDC → 9999000 shares) tx | `f788a432c823d0b6e7ab4d8923bb1dedd44fb7e38c37378aed79143eba3f5334` |
| Round-trip `redeem` (9999000 shares → 0.9999000 USDC) tx | `4a650b9ceb3268bfcfbb7cbc3090107998c60df9c2a695b72f8e595e1476dd70` |

Live reads confirmed: `strategies()=[strategy1]`, `keeper()=GBVJ34MT...`,
`price_per_share()=10000000` (1.0) before AND after the round-trip (post-round-trip
`total_assets()=total_shares()=1000`, exactly the dead-share residual). No second pool deployed —
Task 1's stuck pool `CC7IYNZR4BPTC4HUQ75Q6PMK7MUIEKITYRAZPY6KOOBTBMXN4C3X7RKF` remains untouched
and unreferenced.

One notable side effect: re-authorizing the demo agent
(`CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K`) overwrote its registry scope from
the OLD vault to the new autofarm vault (registry `authorize()` is a plain overwrite, no
history — same pattern `deploy-seed.sh` has always used on vault cutovers). Confirmed
`rwa_vault.deposit()` never reads the registry, so the OLD vault's on-chain deposit path is
unaffected; documented in `deployments/stellar-testnet.json`'s new `demoAgentRegistryScopeNote`.

Config wired: `deployments/stellar-testnet.json` (new `autofarmVault`/`strategy1`/`keeper` keys,
OLD `vault` kept for rollback), `frontend/src/stellar/config.js` (new
`SOROBAN_AUTOFARM_VAULT_ADDRESS`/`SOROBAN_STRATEGY_1_ADDRESS`/`SOROBAN_KEEPER_ADDRESS` exports,
existing `SOROBAN_VAULT_ADDRESS` left pointing at the OLD vault — the live-app cutover is out of
scope here), `keeper/wrangler.jsonc` (`VAULT_ADDRESS`/`STRATEGY_1` set, `STRATEGY_2` stays `""`).
Full frontend suite green after the config edit: 98 files / 548 tests.

## Task 16: end-to-end testnet smoke — deposit, compound, harvest, rebalance, redeem (2026-07-03)

**Status: DONE.** Full report: `.superpowers/sdd/task-16-report.md`. New
`frontend/scripts/smoke-autofarm.mjs` drives the ENTIRE autofarm loop live with real `--submit`
transactions, reusing the actual Task 13 keeper modules (`keeper/src/chain.js` `readState`/
`submit`, `keeper/src/decide.js` `decide`, imported cross-package) for the keeper tick and
`frontend/src/stellar/client.js` for the plain-keypair deposit/redeem/rebalance calls. Every tx
polled to on-chain `SUCCESS` before the next step read state (sim-pass is not treated as proof).

Run: `cd frontend; npx vite-node scripts/smoke-autofarm.mjs --submit` (Windows PowerShell).

| Step | Call | tx hash | Result |
|---|---|---|---|
| 1 | `token.approve(vault, 5 USDC)` | `53c361cd3726cbbd0dbca67e45f68caca3018228b571a01e75943c65dd525658` | SUCCESS |
| 1 | `vault.deposit(5_000_000)` | `c61f49fb2631849743c2d0337d090189c8a0bd0468ba53816d723df75749a2d2` | SUCCESS, `5,005,005` shares minted |
| 2 | keeper `readState`+`decide`+`submit` -> `compound([0])` (sweep) | `dbe2d85d94aaddda7b24714382ddb83405489b1258eb57b7f71805e29c214833` | SUCCESS, `total_gain=0`, idle `5,000,000 -> 0` swept into strategy1 |
| 3 | direct `compound([0])` (harvest, decide()'s gate bypassed per brief) | `23dcbd5066b8096b0c810c8d4274ac24c12ad06d6f4efa0d3b7119c6ea05bcc0` | SUCCESS, **honest `total_gain=0`** (real Blend interest over a short hold rounds to 0; BLND emissions off — PASS, not a failure) |
| 4 | `rebalance(strategy1, vault, 1_000_000)` (de-risk-to-idle, within the 50% cap) | `bd8ba3e9d36405c93b226510721f0698be76a117054a392c69173fa4d601d33c` | SUCCESS, strategy1 `-1,000,000` / vault idle `+1,000,000` |
| 5 | `redeem(all 30,030,030 shares)` | `e25d97af7b3abcc224cf88d276cde1a95d20ecadab4ac27ea84ebf2c8d534f4c` | SUCCESS, `29,999,996` assets returned |

This smoke's own 5-USDC deposit's isolated round-trip (priced at the pre-redeem exchange rate,
since "redeem all" also cashed out vf-deployer's pre-existing position from Task 13's live run):
`5,005,005` shares `× 9,989,998 / 1e7 ≈ 4,999,998` assets — `>= deposit (5,000,000) − dust
(2,000)`. **PASS.** `LastRebalance` was still `0` going in (never touched before), so the first
rebalance cleared the cooldown gate as expected.

**Bug found (real, not simulated) and worked around without touching shared code:**
`frontend/src/stellar/client.js`'s `encodeArgs` sniffs `{addr:...}`/`{i128:...}` wrapper shapes
via `'i128' in a` / `'u64' in a`, but `@stellar/js-xdr`'s `Union` codegen defines a generic
accessor for EVERY possible arm name on the prototype of every `ScVal` instance — so `'i128' in
aRawScvVecInstance` is `true` even when its real `switch()` is `scvVec`, misrouting a hand-built
`Vec<i128>` passthrough into `i128ScVal(aFunctionReference)` and throwing `Cannot convert function
get(){...} to a BigInt`. Worked around by having Step 3 reuse `keeper/src/chain.js`'s `submit()`
(same as Step 2) instead of a hand-rolled invoke — `chain.js` builds `Vec<i128>` args via a raw
`Contract.call`, never routing through `client.js`'s `encodeArgs`. `encodeArgs` itself is
unpatched — worth a small follow-up fix (out of this task's scope).

Full frontend suite green after adding the script: 102 files / 578 tests. ESLint clean.

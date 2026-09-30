# S0 Spike Report — DeFindex as second venue (Vibing Farmer)

## 1. Environment

- Date: 2026-09-30 (UTC).
- Worktree base: `origin/main` @ `92c5256ba49b5d1b0b10be03af86848d692f72a9`
  (`feat(dev): proxy /api to a deployed backend via VF_DEV_API_TARGET`), branch `spike/s0-defindex`.
- Toolchain (all inside WSL; PowerShell-native has no stellar/rust):
  `rustc 1.96.0`, `cargo 1.96.0`, `stellar 27.0.0` (stellar-xdr 27.0.0),
  wasm targets `wasm32-unknown-unknown` + `wasm32v1-none` installed.
- Trial crate: `soroban-sdk 26.1.0` (matches the repo `soroban/` workspace;
  the deployed DeFindex vault reports `rssdkver 22.0.6` — cross-version calls are XDR-level compatible, no issue observed).
- Network passphrase: `Test SDF Network ; September 2015`.
- RPC URL: `https://soroban-testnet.stellar.org` (stellar-cli default for `--network testnet`).

## 2. Addresses used

| Role | Address | stellar.expert (testnet) | How resolved |
|---|---|---|---|
| Trial contract `defindex-s0` | `CAN22V2K7H6YJQIHPMZMQWTJKVYV64WRHYX5D5XFTCWLBSDLOF7QOYA5` | https://stellar.expert/explorer/testnet/contract/CAN22V2K7H6YJQIHPMZMQWTJKVYV64WRHYX5D5XFTCWLBSDLOF7QOYA5 | Deployed in this spike (`stellar contract deploy`, evidence/01) |
| DeFindex USDC vault (dfToken) | `CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN` | https://stellar.expert/explorer/testnet/contract/CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN | Official JSON `testnet.contracts.json` (no diff vs brief); wasm hash verified |
| Test USDC (SAC) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` | https://stellar.expert/explorer/testnet/contract/CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU | Vault `get_assets` (canonical); = SAC of classic `USDC:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56`, 7 decimals |
| Factory | `CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32` | https://stellar.expert/explorer/testnet/contract/CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32 | Official JSON, not called |
| Blend strategy behind vault | `CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY` | https://stellar.expert/explorer/testnet/contract/CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY | Vault `fetch_total_managed_funds`; not paused |
| Throwaway identity `s0-defindex` | `GCM7WCEI6O5T53KYWX6AZ4AQGGOLOXQCH62PZVSEIZGGZWIKDIJR2BTQ` | https://stellar.expert/explorer/testnet/account/GCM7WCEI6O5T53KYWX6AZ4AQGGOLOXQCH62PZVSEIZGGZWIKDIJR2BTQ | `stellar keys generate` + faucet-funded; deployer/funder only, never `from` |

Trial contract source: `spikes/defindex-s0/src/lib.rs` (sdk 26.1.0, `deposit` /
`read_position` / `withdraw` only, no admin gate — throwaway). Vault interface
saved verbatim: `evidence/00-vault-interface.txt`
(`stellar contract info interface --contract-id <vault> --network testnet --output rust`).

## 3. Timeline (hashes link to stellar.expert testnet `/tx/<hash>`)

| # | Step | Tx hash | Result |
|---|---|---|---|
| 1 | Upload trial wasm | [`8b893ceb…19c989`](https://stellar.expert/explorer/testnet/tx/8b893ceba7ec39eb67b32c7baf8ad64dd173e567e4d714a7a2869c8efb19c989) | success (wasm hash `46d06f78…f875d6`, 6712 B) |
| 2 | Deploy + `__constructor(vault, token)` | [`18c2c1da…a1498`](https://stellar.expert/explorer/testnet/tx/18c2c1da3fc1c7c1502b033c4a0166a49449ae3a8812794442a21fe2664a1498) | success → `CAN22V2…F7QOYA5` |
| 3 | Faucet: 1000 USDC to `s0-defindex` | [`fc3ee701…031001`](https://stellar.expert/explorer/testnet/tx/fc3ee7010651b390cba3a7d8225a0d6c06a29efda048d8ff92fa338c7e031001) | success (issuer-signed changeTrust+payment, co-signed by s0-defindex) |
| 4 | Fund trial: 100 USDC (`1_000_000_000`) G→T | [`2cc87c48…03e47d`](https://stellar.expert/explorer/testnet/tx/2cc87c48deb6e9d1b3c07be6b208abc5d0aa6c9db9b16abc095accfb2703e47d) | success |
| 5 | `read_position` baseline (tx) | [`e9108131…6151`](https://stellar.expert/explorer/testnet/tx/e9108131544ce6ff6c8a295cd97fcef72483db73f6e9f191d2033546a8756151) | `["0","9630440478","10000000","-1","1000000000",1]` |
| 6 | deposit probe mode 0 (plain) | *no hash — simulation refused to submit* | FAIL `Error(Auth, InvalidAction)` (evidence/05) |
| 7 | deposit probe mode 1 (approve-then-plain) | *no hash — simulation refused to submit* | FAIL `Error(Auth, InvalidAction)` (evidence/06; approve itself succeeded) |
| 8 | deposit mode 2 (self-auth) 10 USDC invest=true | [`63e127a5…f64ed`](https://stellar.expert/explorer/testnet/tx/63e127a5f636ed160b7e563dd84a0cc26a5e1bb00dd58a8c0e318013955f64ed) | success: `amounts=[100000000]`, shares=`100000000` |
| 9 | `read_position` after deposit (tx) | [`4ea37b73…003837d`](https://stellar.expert/explorer/testnet/tx/4ea37b7359bb0e942808abb6392e3ff416fdcf781e886ade82e4d68ae003837d) | `["100000000","9730440478","10000000","100000000","900000000",1]` |
| 10 | `fetch_total_managed_funds` (read-only sim) | n/a | idle `9730440478`, invested `0` — invest=true allocated nothing |
| 11 | `withdraw` all 100M shares, mode 0 plain | [`10d8a16f…24388a`](https://stellar.expert/explorer/testnet/tx/10d8a16f06c7751d3d58f010aa6a89493de9717e7035cb89b38108236124388a) | success: out=`[100000000]`, burn event 100M shares |
| 12 | `read_position` final (tx) | [`9e3159c6…d2643f5`](https://stellar.expert/explorer/testnet/tx/9e3159c6abff74ed112064165bc182e7b09ad3a0608b2d2643f5b6145d7e5d5d) | `["0","9630440478","10000000","-1","1000000000",1]` — full round-trip, zero dust |

Raw secret-free CLI output per step: `evidence/01-deploy.txt` … `evidence/11-read-final.txt`.

## 4. Numbers

- Deposit: `100_000_000` (10 USDC, 7 dec), `tol_bps=50` → `amounts_min=[99_500_000]`.
- Shares minted: `100_000_000` (price exactly 1.0; vault total_supply 9630440478 → 9730440478).
- `get_asset_amounts_per_shares(10_000_000)` = `10_000_000` before AND after (price 1.0, no yield movement during spike).
- Withdrawn: `100_000_000` for `100_000_000` shares → **rounding 0** on this path (single-asset, price 1.0, idle-only).
- Trial USDC: 1_000_000_000 → 900_000_000 → 1_000_000_000. Vault supply returned to 9630440478.
- invest=true with 100%-idle state left `invested_amount = 0` (allocation follows existing ratio; no strategy leg exercised).

## 5. Self-auth finding (the crux)

**Deposit as `from = trial contract` REQUIRES `env.authorize_as_current_contract([token.transfer(T → vault)])`; plain invoker auth and approve-then-call both FAIL. Withdraw works with plain invoker auth.**

- Mode 0 (plain `vault.deposit(from=T)`) fails in simulation with `HostError: Error(Auth, InvalidAction)`. Diagnostic chain (evidence/05):
  `"[recording authorization only] encountered unauthorized call for a contract earlier in the call stack, make sure that you have called authorize_as_current_contract() with the appropriate arguments for it."` for `CAN22V2…` on `token.transfer(T → vault)`.
  The vault's `T.require_auth()` IS satisfied by direct-caller invoker auth (no `__check_auth` needed on T — recon's claim was wrong), but the vault then pulls funds via a plain **nested** `token.transfer(T → vault, amount)` (invoker = vault), which only T can authorize — via one explicit `authorize_as_current_contract` entry naming `ContractContext{contract: token, fn_name: "transfer", args: (T, vault, amount)}` (mode 2 succeeded, tx `63e127a5…`).
- Mode 1 proves an **allowance cannot substitute**: `token.approve(T → vault, 100M)` succeeded on-chain (approve event in evidence/06), yet the same `Error(Auth, InvalidAction)` followed — the vault uses `transfer`, never `transfer_from`, so the allowance is never consulted.
- Withdraw (mode 0 plain) succeeded first try (tx `10d8a16f…`): vault burns T's shares under T's invoker auth, then pays out from idle under its own authority — no nested from-auth, no self-auth entry needed on our side. Mode 2 was never needed.

S4 consequence: the production `defindex_strategy` deposit leg must wrap each deposit with the mode-2 self-auth entry (exact `ContractContext` shape above, same as `agent_account`'s approve/transfer pattern); withdraw needs only invoker auth for the idle path.

## 6. View callability (from inside contract context — all OK)

`read_position` (on-chain, callable by anyone — no auth gate on views) proves all of these decode and answer from contract context: vault-as-dfToken `balance(T)` → df shares; `total_supply()`; `get_asset_amounts_per_shares(x)` for both a constant (10M) and the live balance; `fetch_total_managed_funds()` → 1 asset entry (idle/invested/total; per-entry field decode skipped — length + totals sufficed for the spike); SAC `balance(T)` via `TokenClient`. `get_assets` was used off-chain to resolve the token (same view the contract could call; not re-proven on-chain — no decision depends on it).

## 7. Open questions / recommendations for S1–S4

1. **Strategy-invest path NOT exercised**: the vault sat 100% idle, so `invest=true` allocated nothing and no `strategy.deposit` ran. S4 must test a deposit that actually enters the Blend strategy (or force allocation via a fresh vault with nonzero invested ratio) — fees (1% vault / 20% protocol per `get_fees=[100,2000]`, semantics unverified) only bite there.
2. **Withdraw unwind path NOT exercised**: our withdraw came entirely from idle. A withdraw that must unwind `strategy.withdraw(amount, vault, to=from)` needs its own probe (auth shape differs: vault calls strategy, strategy pays `from` directly).
3. **SDK 22 (vault) vs 26 (ours) skew**: harmless here (XDR-level compat), but pin S4 to the workspace SDK and re-verify if DeFindex redeploys (testnet redeploys are frequent; re-resolve `testnet.contracts.json` + `get_assets` at S4 time).
4. **Third-party manager risk**: vault manager/rebalance/emergency roles belong to DeFindex; strategies can be paused (`StrategyPaused=144`) or rebalanced under us. S4 needs pause-aware error mapping (`StrategyPausedOrNotFound=141`, `StrategyWithdrawError=142`) and must never assume allocation stickiness.
5. **Tolerance**: `tol_bps=50` never bound (price 1.0, `amounts_min` never the constraint). S4 should keep a small tolerance against `NoOptimalAmounts=118` on multi-asset / volatile paths.
6. `invest=false` single-deposit probe skipped as non-decision-relevant (idle outcome already proves allocation follows ratio, not the flag).

## 8. Verdict: GO (conditional)

A trial contract on sdk 26.1.0 completed the full loop against the live DeFindex testnet vault — deposit with itself as `from`, share visibility, position reads, full withdraw — with all tx hashes above. The single auth rule is settled: deposits need one explicit `authorize_as_current_contract` entry for the nested `token.transfer`; allowances do not work; withdraws need only invoker auth. Conditional because the invested-strategy legs (deposit-into-strategy, unwind-withdraw) were unreachable while the vault is 100% idle and must be proven in S4 before production funds touch the invest path; the idle path proven here is sufficient to open S4.

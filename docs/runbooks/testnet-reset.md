# Runbook — Stellar Testnet Reset Recovery

The Stellar testnet resets roughly **quarterly** (announced ~2 weeks ahead on
developers.stellar.org / SDF Discord — subscribe so a reset never surprises you). A reset wipes the
entire ledger: **every Soroban contract and account disappears**. This runbook rebuilds Vibing
Farmer's on-chain world.

> **Next expected window: ~July 2026.** Treat any "friendbot / RPC returns account-not-found for
> addresses that worked yesterday" as a reset until proven otherwise.

## What dies vs. what survives

| Dies (must rebuild) | Survives |
|---|---|
| All Soroban contracts: registry (1a), demo agent account, old 1:1 vault, **autofarm vault** (live deposit target), blend_strategy, attestation, VFUSD/token | Source code + compiled `.wasm` artifacts (local) |
| All accounts + balances (vf-deployer, relayer, keeper, demo agents) — re-fund via friendbot | This repo, the deploy scripts, the runbooks |
| Blend testnet pool + its USDC reserve (Blend redeploys its own testnet) | Circle CCTP contracts are **Circle-operated** — Circle redeploys them; re-verify addresses (usually stable), don't assume |

## One-command recovery

Runs in WSL (soroban tooling is WSL-only):

```bash
wsl -e bash -lc '/mnt/c/SharredData/project/competition/vibing-farmer/scripts/redeploy-testnet.sh'
```

Phases (each is a resumable flag — `scripts/redeploy-testnet.sh <phase>` or `--from=<phase>`):

1. **prereq** — reminds you the 1a stack must be redeployed first (see §1a); prints the current JSON registry.
2. **build** — `stellar contract build`.
3. **blend** — you `export BLEND_POOL=… BLEND_USDC=…` from blend-utils (fails loudly if unset).
4. **deploy** — runs `deploy-seed.sh` (token + old vault + attestation + authorize) then
   `deploy-autofarm.sh` (the **live** autofarm vault + strategy + keeper wiring; needs
   `export KEEPER_ADDRESS=…`).
5. **checklist** — the manual env checklist (below).
6. **smoke** — the commands to prove it (run from PowerShell, not WSL).

## §1a — redeploy the registry + demo agent FIRST (the one gap)

`deploy-seed.sh` and `deploy-autofarm.sh` both **reuse** `registry` + `demoAgentAccount` from
`deployments/stellar-testnet.json` — they never redeploy the 1a stack. After a full reset those
addresses are dead, so you must rebuild 1a and update the JSON before running the deploy phase:

1. Deploy the agent-account wasm + registry (the 1a contracts — the registry is a leaf contract;
   the demo agent is a custom-account instance whose constructor pins its scope). Use the same
   `vf-deployer` identity and testnet flags as the deploy scripts. If no 1a seed script exists,
   deploy them by hand with `stellar contract deploy` (registry wasm, then the agent-account wasm
   → instance), mirroring `deploy-seed.sh`'s invocation style.
2. Write the new `registry`, `demoAgentAccount`, and `agentAccountWasmHash` into
   `deployments/stellar-testnet.json`.
3. Re-run `scripts/redeploy-testnet.sh --from=build`.

## Manual env checklist (same list the script prints)

- [ ] `deployments/stellar-testnet.json` — verify the deploy scripts wrote the new addresses.
- [ ] `frontend/src/stellar/config.js` `NETWORKS.testnet` block (or `VITE_SOROBAN_*` env overrides):
      autofarmVault, vault, token, blendPool, blendUsdc, registry, demoAgent, attestation, keeper.
- [ ] Cloudflare Pages env: `SOROBAN_VAULT_ADDRESS` (= new **autofarm** vault), `SOROBAN_TOKEN_ADDRESS`,
      `SOROBAN_AGENT_ALLOWLIST`.
- [ ] Relayer VM `deploy/.env`: Stellar contract refs + re-fund `RELAYER_STELLAR` keypair (friendbot).
- [ ] Keeper VM `deploy/.env`: `VAULT_ADDRESS` (= new autofarm vault), `POOL_1` (= new Blend pool),
      `USDC` (= new Blend USDC) + re-fund the keeper keypair (friendbot).
- [ ] Re-fund + re-authorize demo agent (the deploy scripts authorize) and smoke agents.
- [ ] CCTP contracts: verify at developers.circle.com/cctp/references/stellar-contracts — if changed,
      update `relayer/src/cctp/constants.mjs`.

## Verify

From Windows PowerShell (not WSL — rollup win32 binary):

```powershell
cd frontend
node scripts/stellar-relay-smoke.mjs   # gasless relay + deposit path
node scripts/m3-deposit-smoke.mjs      # passkey → real deposit
node scripts/smoke-lifeboat.mjs        # lifeboat state read
```

Fail loudly on any red — a green smoke suite is the acceptance gate for a completed reset recovery.

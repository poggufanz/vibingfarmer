#!/usr/bin/env bash
set -euo pipefail
# Run from WSL: bash scripts/soroban/deploy-autofarm.sh
# Requires: stellar-cli, a funded testnet identity named "vf-deployer" (same as deploy-seed.sh).
#
# Deploys the autofarm vault + strategy stack on Soroban testnet (sub-project vf-autofarm,
# Task 11). Follows deploy-seed.sh's reuse discipline:
#   - reuses the live registry + demo agent account (does NOT redeploy them)
#   - deploys a NEW rwa_vault instance — the OLD deployed vault (deployments/stellar-testnet.json
#     `vault`) predates add_strategy/set_keeper/compound/rebalance (dividend-model wasm) and
#     cannot host a strategy; this new instance is the strategy-registry-capable wasm from
#     Tasks 2-10
#   - deploys ONE blend_strategy wired to the existing live TestnetV2 Blend pool. Task 1's spike
#     found OWN_POOL_VIABLE=false: a self-deployed second pool cannot reach Active status without
#     seeding real Comet BLND:USDC backstop capital (undocumented minimum, real economic cost) —
#     see docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md. Per the plan's own fallback,
#     this deploys strategy1 ONLY and relies on the de-risk-to-idle rebalance path
#     (vault.rebalance(from=strategy1, to=vault), Task 9) instead of a second strategy.
#   - registers the strategy, sets the keeper (a DEDICATED keeper G-address, distinct from the
#     relayer — T2 identity-split fix; pass it via KEEPER_ADDRESS env/arg), re-scopes the demo
#     agent's registry record to this new vault+token (same overwrite-on-redeploy pattern
#     deploy-seed.sh has always used when the vault address changes, e.g. the Blend cutover)
NET=testnet
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOROBAN="$ROOT/soroban"
OUT="$ROOT/deployments/stellar-testnet.json"

stellar keys address vf-deployer >/dev/null 2>&1 || \
  stellar keys generate vf-deployer --network "$NET" --fund
ADMIN=$(stellar keys address vf-deployer)

( cd "$SOROBAN" && stellar contract build )
WASM_DIR="$SOROBAN/target/wasm32-unknown-unknown/release"
[ -f "$WASM_DIR/rwa_vault.wasm" ] || WASM_DIR="$SOROBAN/target/wasm32v1-none/release"

# ---- reuse: registry + demo agent (do NOT redeploy — see deploy-seed.sh header) ----
REGISTRY=$(python3 -c "import json;print(json.load(open('$OUT'))['registry'])")
DEMO_AGENT=$(python3 -c "import json;print(json.load(open('$OUT'))['demoAgentAccount'])")

# ---- keeper identity (T2 Fix 1: dedicated keeper key — no longer defaults to the relayer;
# doubling the two identities was the bug this fixes). Pass explicitly:
#   KEEPER_ADDRESS=G... bash scripts/soroban/deploy-autofarm.sh
# (or as the first positional arg). Must be the G-address that will sign with
# keeper/wrangler.jsonc's STELLAR_KEEPER_SECRET — generate/fund it separately; this script never
# generates or touches keys.
KEEPER_ADDRESS="${KEEPER_ADDRESS:-${1:-}}"
if [ -z "$KEEPER_ADDRESS" ]; then
  echo "ERROR: KEEPER_ADDRESS not set — pass it as an env var or the first arg (the dedicated keeper G-address; it must NOT be the relayer's). See keeper/wrangler.jsonc's STELLAR_KEEPER_SECRET." >&2
  exit 1
fi

# ---- fixed addresses (Task 1 spike findings + task brief — all verified live on testnet) ----
TOKEN=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU    # Blend testnet USDC (vault underlying)
POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF     # TestnetV2 Blend pool (only pool — no pool2)
BLND=CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF
ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD    # Soroswap router
RESERVE_TOKEN_ID=7                                                 # USDC bToken/supply reserve id (Task 1 spike)
KEEPER="$KEEPER_ADDRESS"   # dedicated compound/rebalance keeper — see identity-split note above

echo "ADMIN=$ADMIN"
echo "REGISTRY=$REGISTRY DEMO_AGENT=$DEMO_AGENT KEEPER=$KEEPER"

# ---- deploy the autofarm vault (strategy-registry-capable wasm) ----
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" --name "Vibing Farmer Autofarm" --symbol "vfVLT")
echo "AUTOFARM_VAULT=$VAULT"

# ---- deploy strategy #1 against the existing live pool ----
STRATEGY1=$(stellar contract deploy --wasm "$WASM_DIR/blend_strategy.wasm" \
  --source vf-deployer --network "$NET" \
  -- --vault "$VAULT" --pool "$POOL" --token "$TOKEN" --blnd "$BLND" --router "$ROUTER" \
     --reserve_token_id "$RESERVE_TOKEN_ID")
echo "STRATEGY_1=$STRATEGY1"

# ---- wire strategy + keeper on the vault (admin-only, vf-deployer IS the admin) ----
stellar contract invoke --id "$VAULT" --source vf-deployer --network "$NET" --send=yes \
  -- add_strategy --strategy "$STRATEGY1"
stellar contract invoke --id "$VAULT" --source vf-deployer --network "$NET" --send=yes \
  -- set_keeper --keeper "$KEEPER"

# ---- re-scope the demo agent's registry record to the new vault+token ----
stellar contract invoke --id "$REGISTRY" --source vf-deployer --network "$NET" --send=yes \
  -- authorize --owner "$ADMIN" --agent "$DEMO_AGENT" --vault "$VAULT" --token "$TOKEN" \
     --cap_per_period 1000000000000 --period_duration 86400 --expiry 4000000000

echo "Deployed: autofarmVault=$VAULT strategy1=$STRATEGY1 keeper=$KEEPER"
echo "Next: verify strategies()/keeper()/price_per_share(), run the 1-USDC round-trip, then sync"
echo "deployments/stellar-testnet.json + frontend/src/stellar/config.js + keeper/wrangler.jsonc"

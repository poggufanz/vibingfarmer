#!/usr/bin/env bash
set -euo pipefail
# Run from WSL: bash scripts/soroban/deploy-seed.sh
# Requires: stellar-cli, a funded testnet identity named "vf-deployer".
#
# Deploys the plain DeFi yield-farming stack on Soroban testnet:
#   - reuses the live 1a registry + demo agent account (does NOT redeploy them)
#   - deploys a plain SAC asset (no auth_required) as the yield-farming token
#   - deploys the yield vault wired to that token
#   - authorizes the demo agent in the registry, scoped to the new vault + token
# No RWA/KYC/compliance/guardrail (that layer was removed — plain yield farming).
NET=testnet
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOROBAN="$ROOT/soroban"
OUT="$ROOT/deployments/stellar-testnet.json"

stellar keys address vf-deployer >/dev/null 2>&1 || \
  stellar keys generate vf-deployer --network "$NET" --fund
ADMIN=$(stellar keys address vf-deployer)

( cd "$SOROBAN" && stellar contract build )
WASM_DIR="$SOROBAN/target/wasm32-unknown-unknown/release"
[ -f "$WASM_DIR/registry.wasm" ] || WASM_DIR="$SOROBAN/target/wasm32v1-none/release"

# 1a (registry + demo agent account) + the relayer pubkey already live on testnet —
# reuse, do NOT redeploy (would orphan the existing 1a contracts and churn addresses).
REGISTRY=$(python3 -c "import json;print(json.load(open('$OUT'))['registry'])")
ACCT_HASH=$(python3 -c "import json;print(json.load(open('$OUT'))['agentAccountWasmHash'])")
DEMO_AGENT=$(python3 -c "import json;print(json.load(open('$OUT'))['demoAgentAccount'])")
RELAYER=$(python3 -c "import json;print(json.load(open('$OUT')).get('relayer',''))")

# ---- token: plain SAC asset (no auth_required = open holding, plain DeFi) ----
# The deployer is the asset issuer + SAC admin, so it can mint the demo treasury.
ASSET="VFUSD:$ADMIN"
stellar contract asset deploy --asset "$ASSET" --source vf-deployer --network "$NET" 2>/dev/null || true
TOKEN=$(stellar contract id asset --asset "$ASSET" --network "$NET")

# ---- yield vault (stable-NAV, daily-dividend yield) ----
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" --name "Vibing Vault" --symbol "vfVLT")

# ---- wire the demo agent: authorize it in the registry, scoped to the new vault+token ----
# The 1a deploy created the demo agent ACCOUNT but never gave it a registry record. Authorize
# it here (owner = ADMIN/vf-deployer) so its deposits target the new vault. Permissive demo cap.
stellar contract invoke --id "$REGISTRY" --source vf-deployer --network "$NET" \
  -- authorize --owner "$ADMIN" --agent "$DEMO_AGENT" --vault "$VAULT" --token "$TOKEN" \
     --cap_per_period 1000000000000 --period_duration 86400 --expiry 4000000000

REGISTRY="$REGISTRY" ACCT_HASH="$ACCT_HASH" DEMO_AGENT="$DEMO_AGENT" RELAYER="$RELAYER" \
TOKEN="$TOKEN" VAULT="$VAULT" OUT="$OUT" \
python3 <<'PY'
import json, os
out = {
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": os.environ["REGISTRY"],
  "relayer": os.environ["RELAYER"],
  "agentAccountWasmHash": os.environ["ACCT_HASH"],
  "demoAgentAccount": os.environ["DEMO_AGENT"],
  "vault": {
    "address": os.environ["VAULT"],
    "token": os.environ["TOKEN"],
    "decimals": 7,
    "shareSymbol": "vfVLT"
  }
}
with open(os.environ["OUT"], "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
PY
echo "Wrote $OUT"
echo "VAULT=$VAULT TOKEN=$TOKEN"
echo "Next: sync frontend/src/stellar/config.js SOROBAN_VAULT_ADDRESS=$VAULT"

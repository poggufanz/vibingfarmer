#!/usr/bin/env bash
set -euo pipefail
# Run from WSL: bash scripts/soroban/deploy-seed.sh
# Requires: stellar-cli, a funded testnet identity named "vf-deployer".
NET=testnet
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOROBAN="$ROOT/soroban"
OUT="$ROOT/deployments/stellar-testnet.json"

stellar keys address vf-deployer >/dev/null 2>&1 || \
  stellar keys generate --global vf-deployer --network "$NET" --fund
ADMIN=$(stellar keys address vf-deployer)

( cd "$SOROBAN" && stellar contract build )
WASM_DIR="$SOROBAN/target/wasm32-unknown-unknown/release"
[ -f "$WASM_DIR/registry.wasm" ] || WASM_DIR="$SOROBAN/target/wasm32v1-none/release"

REGISTRY=$(stellar contract deploy \
  --wasm "$WASM_DIR/registry.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN")

ACCT_HASH=$(stellar contract upload \
  --wasm "$WASM_DIR/agent_account.wasm" \
  --source vf-deployer --network "$NET")

# Seed one demo agent account (owner=admin, dummy signer, far-future expiry).
VAULT="$ADMIN"  # placeholder until 1c vault exists; replace post-1c
TOKEN="$ADMIN"
DEMO_AGENT=$(stellar contract deploy \
  --wasm "$WASM_DIR/agent_account.wasm" \
  --source vf-deployer --network "$NET" \
  -- --owner "$ADMIN" \
     --signer "0000000000000000000000000000000000000000000000000000000000000000" \
     --scope "{\"owner\":\"$ADMIN\",\"vault\":\"$VAULT\",\"token\":\"$TOKEN\",\"cap_per_period\":\"1000000000\",\"period_duration\":86400,\"spent_in_period\":\"0\",\"period_start\":0,\"expiry\":4000000000,\"revoked\":false}")

cat > "$OUT" <<JSON
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "$REGISTRY",
  "agentAccountWasmHash": "$ACCT_HASH",
  "demoAgentAccount": "$DEMO_AGENT"
}
JSON
echo "Wrote $OUT"

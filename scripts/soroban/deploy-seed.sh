#!/usr/bin/env bash
set -euo pipefail
# Run from WSL: bash scripts/soroban/deploy-seed.sh
# Requires: stellar-cli, a funded testnet identity named "vf-deployer".
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

# ---- 1b: RWA (T-REX) stack (OZ README deploy order) ----
CTI=$(stellar contract deploy --wasm "$WASM_DIR/claim_topics_and_issuers.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
CLAIM_ISSUER=$(stellar contract deploy --wasm "$WASM_DIR/claim_issuer.wasm" \
  --source vf-deployer --network "$NET" -- --owner "$ADMIN")
IRS=$(stellar contract deploy --wasm "$WASM_DIR/identity_registry_storage.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
VERIFIER=$(stellar contract deploy --wasm "$WASM_DIR/identity_verifier.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --manager "$ADMIN" \
     --identity_registry_storage "$IRS" --claim_topics_and_issuers "$CTI")
COMPLIANCE=$(stellar contract deploy --wasm "$WASM_DIR/compliance.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN")
ALLOW_MOD=$(stellar contract deploy --wasm "$WASM_DIR/compliance_allow.wasm" \
  --source vf-deployer --network "$NET" -- --admin "$ADMIN" --manager "$ADMIN" --compliance "$COMPLIANCE")
TOKEN=$(stellar contract deploy --wasm "$WASM_DIR/rwa_token.wasm" \
  --source vf-deployer --network "$NET" \
  -- --name "Mock RWA" --symbol "mRWA" --admin "$ADMIN" --manager "$ADMIN" \
     --compliance "$COMPLIANCE" --identity_verifier "$VERIFIER")

# Configure: KYC topic 1, trust the claim issuer for it.
stellar contract invoke --id "$CTI" --source vf-deployer --network "$NET" \
  -- add_claim_topic --claim_topic 1 --operator "$ADMIN"
stellar contract invoke --id "$CTI" --source vf-deployer --network "$NET" \
  -- add_trusted_issuer --trusted_issuer "$CLAIM_ISSUER" --claim_topics '[1]' --operator "$ADMIN"

# Bind the token to the IRS + compliance (required before mint/transfer; see OZ README).
stellar contract invoke --id "$IRS" --source vf-deployer --network "$NET" \
  -- bind_token --token "$TOKEN" --operator "$ADMIN"
stellar contract invoke --id "$COMPLIANCE" --source vf-deployer --network "$NET" \
  -- bind_token --token "$TOKEN" --operator "$ADMIN"

cat > "$OUT" <<JSON
{
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": "$REGISTRY",
  "agentAccountWasmHash": "$ACCT_HASH",
  "demoAgentAccount": "$DEMO_AGENT",
  "rwa": {
    "claimTopicsAndIssuers": "$CTI",
    "claimIssuer": "$CLAIM_ISSUER",
    "identityRegistryStorage": "$IRS",
    "identityVerifier": "$VERIFIER",
    "compliance": "$COMPLIANCE",
    "complianceAllowModule": "$ALLOW_MOD",
    "token": "$TOKEN",
    "decimals": 7
  }
}
JSON
echo "Wrote $OUT"

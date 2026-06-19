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

# 1a (registry + demo agent account) already live on testnet — reuse, do NOT
# redeploy (would orphan the existing 1a contracts and churn addresses).
REGISTRY=$(python3 -c "import json;print(json.load(open('$OUT'))['registry'])")
ACCT_HASH=$(python3 -c "import json;print(json.load(open('$OUT'))['agentAccountWasmHash'])")
DEMO_AGENT=$(python3 -c "import json;print(json.load(open('$OUT'))['demoAgentAccount'])")

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

# ---- 1c: RWA vault (FOBXX-faithful, stable-NAV daily-dividend) ----
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" \
     --name "Vibing Vault mRWA" --symbol "vfmRWA")

# Load-bearing T-REX consequence: the vault must be a verified mRWA holder or
# deposit/drip/redeem/claim revert at the token move. Register its identity + IRS entry
# + whitelist it in the compliance allow module.
VAULT_IDENTITY=$(stellar contract deploy --wasm "$WASM_DIR/identity.wasm" \
  --source vf-deployer --network "$NET" -- --owner "$ADMIN")
# `--initial_profiles` mirrors the CountryData{Individual(Residence(360)), metadata:None}
# Val the Task-4 integration test uses; confirm the exact JSON shape against
# `stellar contract info --id "$IRS"` if the invoke rejects.
stellar contract invoke --id "$IRS" --source vf-deployer --network "$NET" \
  -- add_identity --account "$VAULT" --identity "$VAULT_IDENTITY" \
     --initial_profiles '[{"country":{"Individual":{"Residence":360}},"metadata":null}]' \
     --operator "$ADMIN"
stellar contract invoke --id "$ALLOW_MOD" --source vf-deployer --network "$NET" \
  -- allow_account --account "$VAULT" --operator "$ADMIN"

# The topic-1 KYC claim for the vault identity must be signed by the trusted claim-issuer
# key (off-chain Ed25519) and stored in $VAULT_IDENTITY. This is the SAME off-chain signing
# step 1b deferred for per-investor claims (see docs/soroban-kyc-seam.md). Sign the canonical
# message (0x01 || network_id || issuer.to_xdr || $VAULT_IDENTITY.to_xdr || topic||nonce ||
# claim_data) with the issuer secret, then:
#   stellar contract invoke --id "$VAULT_IDENTITY" --source vf-deployer --network "$NET" \
#     -- add_claim --topic 1 --scheme 101 --issuer "$CLAIM_ISSUER" \
#        --signature <sig_data> --data <claim_data> --uri <uri>
# The Rust integration test (Task 4) is the authoritative proof of the on-chain path.

REGISTRY="$REGISTRY" ACCT_HASH="$ACCT_HASH" DEMO_AGENT="$DEMO_AGENT" \
CTI="$CTI" CLAIM_ISSUER="$CLAIM_ISSUER" IRS="$IRS" VERIFIER="$VERIFIER" \
COMPLIANCE="$COMPLIANCE" ALLOW_MOD="$ALLOW_MOD" TOKEN="$TOKEN" \
VAULT="$VAULT" VAULT_IDENTITY="$VAULT_IDENTITY" OUT="$OUT" \
python3 <<'PY'
import json, os
out = {
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpc": "https://soroban-testnet.stellar.org",
  "registry": os.environ["REGISTRY"],
  "agentAccountWasmHash": os.environ["ACCT_HASH"],
  "demoAgentAccount": os.environ["DEMO_AGENT"],
  "rwa": {
    "claimTopicsAndIssuers": os.environ["CTI"],
    "claimIssuer": os.environ["CLAIM_ISSUER"],
    "identityRegistryStorage": os.environ["IRS"],
    "identityVerifier": os.environ["VERIFIER"],
    "compliance": os.environ["COMPLIANCE"],
    "complianceAllowModule": os.environ["ALLOW_MOD"],
    "token": os.environ["TOKEN"],
    "decimals": 7,
    "vault": os.environ["VAULT"],
    "vaultIdentity": os.environ["VAULT_IDENTITY"],
    "vaultShareSymbol": "vfmRWA"
  }
}
with open(os.environ["OUT"], "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
PY
echo "Wrote $OUT"

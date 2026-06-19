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
# Load-bearing T-REX consequence: the vault must be a verified mRWA holder, or
# deposit/drip/redeem/claim revert at the token move. Verifying it requires the
# full KYC path — identity contract + IRS entry + compliance allowlist + a real
# topic-1 KYC claim signed by the trusted issuer key. We mirror the audited
# integration test exactly (issuer secret = 0x00..00, scheme 101 = Ed25519).

# (1) Deploy the vault's identity first — the signed claim binds to the identity,
#     not the vault, so it can be produced before the vault exists.
VAULT_IDENTITY=$(stellar contract deploy --wasm "$WASM_DIR/identity.wasm" \
  --source vf-deployer --network "$NET" -- --owner "$ADMIN")

# (2) Mint the real Ed25519 topic-1 claim for this identity. The generator reuses
#     the audited sign_kyc_claim path and signs over the testnet network id, so the
#     message matches the on-chain build_claim_message byte-for-byte.
SIGNER_OUT=$(cd "$SOROBAN" && CLAIM_ISSUER="$CLAIM_ISSUER" VAULT_IDENTITY="$VAULT_IDENTITY" \
  cargo test -p rwa_vault gen_testnet_vault_claim -- --ignored --nocapture 2>/dev/null)
PUBKEY=$(printf '%s\n' "$SIGNER_OUT"    | sed -n 's/^SIGNER_PUBKEY=//p'      | tr -d '\r')
SIG_DATA=$(printf '%s\n' "$SIGNER_OUT"  | sed -n 's/^SIGNER_SIG_DATA=//p'    | tr -d '\r')
CLAIM_DATA=$(printf '%s\n' "$SIGNER_OUT" | sed -n 's/^SIGNER_CLAIM_DATA=//p' | tr -d '\r')
[ -n "$PUBKEY" ] && [ -n "$SIG_DATA" ] && [ -n "$CLAIM_DATA" ] || {
  echo "ERROR: claim generator produced no signature (build failed?)" >&2; exit 1; }

# (3) Trust the issuer signing key for topic 1 on the claim issuer (registry = CTI).
stellar contract invoke --id "$CLAIM_ISSUER" --source vf-deployer --network "$NET" \
  -- allow_key --public_key "$PUBKEY" --registry "$CTI" --claim_topic 1

# (4) Store the signed KYC claim on the vault identity.
stellar contract invoke --id "$VAULT_IDENTITY" --source vf-deployer --network "$NET" \
  -- add_claim --topic 1 --scheme 101 --issuer "$CLAIM_ISSUER" \
     --signature "$SIG_DATA" --data "$CLAIM_DATA" \
     --uri "https://vibing.farm/claim/vault-kyc"

# (5) Deploy the vault, then register its identity in the IRS + compliance allowlist.
VAULT=$(stellar contract deploy --wasm "$WASM_DIR/rwa_vault.wasm" \
  --source vf-deployer --network "$NET" \
  -- --admin "$ADMIN" --token "$TOKEN" \
     --name "Vibing Vault mRWA" --symbol "vfmRWA")
# add_identity requires >=1 country entry. `initial_profiles` is `Vec<Val>`
# (exported name; trait source calls it country_data_list), so stellar-cli parses
# each element with stellar-xdr's `serde::Deserialize for ScVal` (snake_case tags),
# NOT the convenience-struct form. The tagged JSON below is the exact ScVal that
# `CountryData{ country: Individual(Residence(360)), metadata: None }.into_val()`
# produces — verified offline to be byte-for-byte identical (struct->sorted ScMap,
# tuple-variant enum->ScVec[Symbol,..], Option::None->Void="void").
stellar contract invoke --id "$IRS" --source vf-deployer --network "$NET" \
  -- add_identity --account "$VAULT" --identity "$VAULT_IDENTITY" \
     --initial_profiles '[{"map":[{"key":{"symbol":"country"},"val":{"vec":[{"symbol":"Individual"},{"vec":[{"symbol":"Residence"},{"u32":360}]}]}},{"key":{"symbol":"metadata"},"val":"void"}]}]' \
     --operator "$ADMIN"
stellar contract invoke --id "$ALLOW_MOD" --source vf-deployer --network "$NET" \
  -- allow_account --account "$VAULT" --operator "$ADMIN"

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

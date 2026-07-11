#!/usr/bin/env bash
# Deploy the OZ webauthn-verifier + install the OZ smart_account wasm on testnet
# for the VF Wallet passkey spike (Task 6).
#
# Soroban tooling is WSL-only. Run via:
#   wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer && bash scripts/soroban/deploy-smart-account.sh"
#
# VERSION DISCIPLINE (plan §0): the wasm here MUST come from the OZ
# stellar-contracts release that smart-account-kit-bindings@0.1.2 targets — NOT
# blindly the newest OZ tag. Before running, confirm the bindings' expected OZ
# contract version (SAK README "Setup" / bindings source). If the SDK ships
# canonical testnet addresses for the verifier, prefer those over self-deploying
# (skip this script and paste the SDK defaults into config.js + deployments JSON).
#
# Place the matching wasm at:
#   scripts/soroban/wasm/smart_account.wasm
#   scripts/soroban/wasm/webauthn_verifier.wasm
set -euo pipefail

NET=testnet
SRC=vf-deployer   # existing funded testnet identity (CLI-only, never browser-imported)
WASM_DIR="$(dirname "$0")/wasm"

[ -f "$WASM_DIR/smart_account.wasm" ] || { echo "missing $WASM_DIR/smart_account.wasm (see header)" >&2; exit 1; }
[ -f "$WASM_DIR/webauthn_verifier.wasm" ] || { echo "missing $WASM_DIR/webauthn_verifier.wasm (see header)" >&2; exit 1; }

# 1. install the OZ smart_account wasm → prints the wasm hash
ACCOUNT_HASH=$(stellar contract install --network "$NET" --source "$SRC" --wasm "$WASM_DIR/smart_account.wasm")
echo "accountWasmHash=$ACCOUNT_HASH"

# 2. deploy the webauthn-verifier → prints its contract id
VERIFIER=$(stellar contract deploy --network "$NET" --source "$SRC" --wasm "$WASM_DIR/webauthn_verifier.wasm")
echo "webauthnVerifierAddress=$VERIFIER"

cat <<EOF

--- paste into frontend/src/wallet/config.js ---
export const ACCOUNT_WASM_HASH = '$ACCOUNT_HASH'
export const WEBAUTHN_VERIFIER_ADDRESS = '$VERIFIER'

--- add to deployments/stellar-testnet.json "smartAccount" block ---
"smartAccount": {
  "accountWasmHash": "$ACCOUNT_HASH",
  "webauthnVerifierAddress": "$VERIFIER",
  "ozContractsVersion": "v0.7.x",
  "sakVersion": "0.2.10",
  "indexerUrl": "<DEFAULT_INDEXER_URL for testnet, or self-hosted>"
}
EOF

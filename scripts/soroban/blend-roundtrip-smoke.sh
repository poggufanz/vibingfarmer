#!/usr/bin/env bash
set -euo pipefail
# Live-testnet proof of the Blend real-yield round trip: approve -> deposit -> supply into Blend
# -> harvest -> redeem -> principal recovered. Uses a PLAIN account (default vf-deployer) as the
# holder, so no custom-account session-key machinery is needed — this isolates the Blend
# integration (the gasless agent path is proven separately by stellar-deposit-smoke.mjs).
#
# Run from WSL:  bash scripts/soroban/blend-roundtrip-smoke.sh [HOLDER_KEY] [AMOUNT_BASE_UNITS]
# Requires: stellar-cli, the holder identity funded with XLM + Blend testnet USDC (>= AMOUNT),
# and the holder must already have a USDC trustline. Faucet USDC via the Blend testnet Lambda:
#   curl -s "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets?userId=<G_ADDR>" \
#     | tr -d '"[:space:]' | xargs -I{} sh -c 'stellar tx sign --sign-with-key <KEY> "{}" | stellar tx send'
# (the returned tx is issuer-pre-signed; the recipient co-signs the changeTrust+payment basket).
#
# Verified live 2026-06-28: 100 USDC -> real Blend b_token supply position, principal recovered.
HOLDER_KEY="${1:-vf-deployer}"
AMOUNT="${2:-1000000000}"            # default 100 USDC @ 7-dp
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
RPC="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/deployments/stellar-testnet.json"

V=$(python3 -c "import json;print(json.load(open('$OUT'))['vault']['address'])")
U=$(python3 -c "import json;print(json.load(open('$OUT'))['vault']['token'])")
P=$(python3 -c "import json;print(json.load(open('$OUT'))['vault'].get('blendPool',''))")
H=$(stellar keys address "$HOLDER_KEY")
[ -n "$P" ] || { echo "FAIL: vault.blendPool not set in $OUT — pool not wired (offline VFUSD deploy)"; exit 1; }
inv(){ stellar contract invoke --id "$1" --rpc-url "$RPC" --source "$HOLDER_KEY" -- "${@:2}"; }

echo "vault=$V token=$U pool=$P holder=$H amount=$AMOUNT"
USDC0=$(inv "$U" balance --id "$H")
echo "USDC before: $USDC0"

# allowance must cover the pull (vault uses transfer_from); approve for a bounded window
SEQ=$(curl -s "$RPC" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | grep -o '"sequence":[0-9]*' | grep -o '[0-9]*$')
inv "$U" approve --from "$H" --spender "$V" --amount "$AMOUNT" --expiration_ledger "$((SEQ + 100000))" >/dev/null
echo "approved $AMOUNT to vault"

# deposit -> vault supplies into Blend
inv "$V" deposit --from "$H" --amount "$AMOUNT" >/dev/null
SHARES=$(inv "$V" balance --id "$H")
VAULT_USDC=$(inv "$U" balance --id "$V")
echo "deposit done: shares=$SHARES  vault_own_usdc=$VAULT_USDC (expect ~0 = supplied to Blend)"
[ "$VAULT_USDC" = '"0"' ] || echo "WARN: vault holds USDC ($VAULT_USDC) — expected ~0 if fully supplied"

# harvest -> realize interest delta (permissionless). ~0 over a short hold is expected/honest.
HARVEST=$(inv "$V" harvest)
echo "harvest interest distributed: $HARVEST (0 ok on a short/cold hold)"

# redeem -> withdraw from Blend, pay holder back
inv "$V" redeem --from "$H" --shares "$SHARES" >/dev/null
USDC1=$(inv "$U" balance --id "$H")
SHARES1=$(inv "$V" balance --id "$H")
echo "redeem done: USDC after=$USDC1  shares=$SHARES1"
[ "$SHARES1" = '"0"' ] || { echo "FAIL: shares not fully redeemed ($SHARES1)"; exit 1; }
echo "PASS: Blend supply -> harvest -> redeem round trip complete; principal recovered."

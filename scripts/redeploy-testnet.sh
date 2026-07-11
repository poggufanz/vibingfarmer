#!/usr/bin/env bash
# scripts/redeploy-testnet.sh — quarterly Stellar testnet reset recovery (spec §8).
# Runs INSIDE WSL: wsl -e bash -lc '/mnt/c/SharredData/project/competition/vibing-farmer/scripts/redeploy-testnet.sh'
# Orchestrates the EXISTING deploy scripts (does not duplicate their logic) + prints a manual
# checklist. Each phase is a flag so a partial run can resume: pass a phase name to run one, or
# --from=<phase> to run from that phase onward. Phases: prereq build blend deploy checklist smoke.
set -euo pipefail
cd "$(dirname "$0")/.."

PHASE="${1:-all}"
ORDER=(prereq build blend deploy checklist smoke)

# Run a phase if PHASE is "all", equals the phase, or is --from=<earlier-or-equal phase>.
phase() {
  local target="$1"
  [[ "$PHASE" == "all" || "$PHASE" == "$target" ]] && return 0
  if [[ "$PHASE" == --from=* ]]; then
    local from="${PHASE#--from=}" seen=0
    for p in "${ORDER[@]}"; do
      [[ "$p" == "$from" ]] && seen=1
      [[ "$p" == "$target" && "$seen" == 1 ]] && return 0
    done
  fi
  return 1
}

if phase prereq; then
  echo "== [1/6] PREREQUISITE — 1a stack (registry + demo agent account) =="
  echo "A FULL testnet reset wipes EVERY Soroban contract, including the 1a registry"
  echo "(CAEHOZGU… today) and the demo agent account. deploy-seed.sh and deploy-autofarm.sh both"
  echo "REUSE those from deployments/stellar-testnet.json — after a full reset those addresses are"
  echo "DEAD, so the 1a stack MUST be redeployed FIRST and stellar-testnet.json's 'registry' +"
  echo "'demoAgentAccount' + 'agentAccountWasmHash' updated before the deploy phase."
  echo "See docs/runbooks/testnet-reset.md §1a for the redeploy commands. This wrapper does NOT"
  echo "automate 1a (it predates these scripts and has no seed script) — do it, then re-run --from=build."
  echo "Confirm the JSON registry is live before continuing:"
  REG=$(python3 -c "import json;print(json.load(open('deployments/stellar-testnet.json'))['registry'])" 2>/dev/null || echo "")
  echo "  current deployments/stellar-testnet.json registry = ${REG:-<none>}"
fi

if phase build; then
  echo "== [2/6] build contracts =="
  ( cd soroban && stellar contract build )
fi

if phase blend; then
  echo "== [3/6] resolve fresh Blend testnet addresses =="
  echo "Blend redeploys after every reset — get the current testnet pool + USDC reserve from:"
  echo "  https://github.com/blend-capital/blend-utils  (testnet deployment JSON)"
  echo "Export them before the deploy phase:  export BLEND_POOL=C... BLEND_USDC=C..."
  [[ -n "${BLEND_POOL:-}" && -n "${BLEND_USDC:-}" ]] || {
    echo "BLEND_POOL/BLEND_USDC unset — export both and re-run with --from=deploy"; exit 1;
  }
  echo "  BLEND_POOL=$BLEND_POOL"
  echo "  BLEND_USDC=$BLEND_USDC"
fi

if phase deploy; then
  echo "== [4/6] deploy + seed =="
  echo "-- deploy-seed.sh: token + old 1:1 vault + attestation + authorize demo agent --"
  USDC_TOKEN="${BLEND_USDC:-}" BLEND_POOL="${BLEND_POOL:-}" bash scripts/soroban/deploy-seed.sh
  echo "-- deploy-autofarm.sh: the app's LIVE vault (autofarm) + blend_strategy + keeper wiring --"
  echo "   (needs KEEPER_ADDRESS — the dedicated keeper G-address, NOT the relayer)"
  [[ -n "${KEEPER_ADDRESS:-}" ]] || { echo "KEEPER_ADDRESS unset — export it and re-run --from=deploy"; exit 1; }
  USDC_TOKEN="${BLEND_USDC:-}" BLEND_POOL="${BLEND_POOL:-}" KEEPER_ADDRESS="$KEEPER_ADDRESS" \
    bash scripts/soroban/deploy-autofarm.sh
fi

if phase checklist; then
  echo "== [5/6] MANUAL ENV CHECKLIST — update every one of these =="
  cat <<'EOF'
  [ ] deployments/stellar-testnet.json — verify the deploy scripts wrote the new addresses
  [ ] frontend/src/stellar/config.js NETWORKS.testnet block (or VITE_SOROBAN_* env overrides) —
      autofarmVault, vault, token, blendPool, blendUsdc, registry, demoAgent, attestation, keeper
  [ ] Cloudflare Pages env: SOROBAN_VAULT_ADDRESS (= new AUTOFARM vault), SOROBAN_TOKEN_ADDRESS,
      SOROBAN_AGENT_ALLOWLIST
  [ ] relayer VM deploy/.env: any Stellar contract refs + re-fund RELAYER_STELLAR keypair (friendbot)
  [ ] keeper VM deploy/.env: VAULT_ADDRESS (= new autofarm vault), POOL_1 (= new Blend pool), USDC
      (= BLEND_USDC) + re-fund the keeper keypair (friendbot)
  [ ] Re-fund + re-authorize demo agent (deploy scripts do the authorize) and any smoke agents
  [ ] CCTP contracts (Circle-operated) survive a Stellar reset? VERIFY at
      developers.circle.com/cctp/references/stellar-contracts — if changed, update
      relayer/src/cctp/constants.mjs
EOF
fi

if phase smoke; then
  echo "== [6/6] smoke (run from Windows PowerShell, NOT WSL — rollup win32 binary) =="
  echo "  cd frontend; node scripts/stellar-relay-smoke.mjs && node scripts/m3-deposit-smoke.mjs && node scripts/smoke-lifeboat.mjs"
fi

echo "done (phase=$PHASE)"

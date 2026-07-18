#!/usr/bin/env bash
set -euo pipefail
# Two-phase timelocked-upgrade smoke for the autofarm_vault (Tasks 1-5 of the vault-upgrade-
# timelock feature: schedule_upgrade / execute_upgrade / cancel_upgrade / pending_upgrade).
# Companion to the Task 6 rollout runbook (.superpowers/sdd/task-6-brief.md, Step 8). There was
# no prior "Task-16 upgrade smoke" to extend — a repo-wide grep for callers of the removed
# instant `upgrade` endpoint (scripts/, relayer/, frontend/, keeper/) found zero hits — so this
# is a new script, not an extension.
#
# Phases:
#   (a) SCHEDULE. If MULTISIG=0 (default, pre-cutover): schedule_upgrade with the single admin
#       key. If MULTISIG=1 (post-cutover, once the runbook's Step 5/6 have made the vault admin a
#       2-of-3 multisig G-account): builds ONE unsigned schedule_upgrade tx against the multisig
#       admin account, signs it with a SINGLE signer and asserts `tx send` is REJECTED
#       (insufficient signing weight — the multisig proof), then adds a SECOND signature to the
#       SAME envelope and asserts it SUCCEEDS. That successful send is the real schedule used by
#       phases (b)/(c). Before the cutover there is only one signer to withhold, so the proof
#       can't show anything — hence flagged off by default.
#   (b) BLOCKED EXECUTE. execute_upgrade called immediately after the schedule must fail with
#       contract error #25 (TimelockNotElapsed) — the 259200s/3-day delay has not elapsed.
#   (c) PENDING VIEW + CANCEL. pending_upgrade (a pure view, no auth) must report the scheduled
#       record; cancel_upgrade then clears it (admin-gated) and a second pending_upgrade view
#       confirms it is gone. This is the smoke's cleanup path.
#
# OUT OF SCOPE: the REAL execute_upgrade only becomes callable 259200s (3 days) after schedule —
# that is a separate, later, manual runbook step, not exercised here.
#
# Run from WSL (or anywhere with stellar-cli + network access). Pre-cutover:
#   NEW_WASM_HASH=<64-hex-hash> bash scripts/soroban/upgrade-timelock-smoke.sh
# Post-cutover (multisig proof):
#   MULTISIG=1 NEW_WASM_HASH=<64-hex-hash> \
#     MULTISIG_ADMIN=vf-vault-admin SIGNER_1=vf-admin-2 SIGNER_2=vf-admin-3 \
#     bash scripts/soroban/upgrade-timelock-smoke.sh
#
# Env (all optional except NEW_WASM_HASH):
#   VAULT_ID        autofarm_vault contract id (default: deployments/stellar-testnet.json .autofarmVault.address)
#   NEW_WASM_HASH   REQUIRED. hex hash of the wasm already uploaded via `stellar contract upload`
#                   (runbook Step 2) — this script never uploads or bootstraps, only probes the
#                   timelock endpoints on an already-timelocked vault.
#   ADMIN_SOURCE    single-key admin identity, used when MULTISIG=0 (default: vf-deployer)
#   MULTISIG        0|1 — enable the multisig proof + multisig-signed admin ops (default: 0)
#   MULTISIG_ADMIN  multisig G-account identity/alias, tx source once MULTISIG=1 (default: vf-vault-admin)
#   SIGNER_1        first weight-1 signer identity on MULTISIG_ADMIN (default: vf-deployer)
#   SIGNER_2        second weight-1 signer identity on MULTISIG_ADMIN (default: vf-admin-2)
#   SOROBAN_RPC_URL RPC endpoint (default: https://soroban-testnet.stellar.org)
#
# CLI flags verified against a real stellar-cli 27.0.0 binary's `--help` output (contract invoke,
# tx new, tx sign, tx send) — re-check with --help before relying on this if the CLI has moved on.
# The `Error(Contract, #N)` assertion format is taken from this repo's own live-testnet output,
# see docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md:111.
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
RPC="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/deployments/stellar-testnet.json"

VAULT_ID="${VAULT_ID:-$(python3 -c "import json;print(json.load(open('$OUT'))['autofarmVault']['address'])")}"
NEW_WASM_HASH="${NEW_WASM_HASH:?set NEW_WASM_HASH to the uploaded new wasm hash (runbook Step 2: stellar contract upload)}"
[[ "$NEW_WASM_HASH" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "FAIL: NEW_WASM_HASH must be a 64-char hex wasm hash, got: $NEW_WASM_HASH"; exit 1; }
ADMIN_SOURCE="${ADMIN_SOURCE:-vf-deployer}"
MULTISIG="${MULTISIG:-0}"
MULTISIG_ADMIN="${MULTISIG_ADMIN:-vf-vault-admin}"
SIGNER_1="${SIGNER_1:-vf-deployer}"
SIGNER_2="${SIGNER_2:-vf-admin-2}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; exit 1; }

# Read-only view — no admin auth, never sent as a tx (pending_upgrade writes nothing), so any
# funded identity works regardless of MULTISIG.
view(){ stellar contract invoke --id "$VAULT_ID" --rpc-url "$RPC" --source "$ADMIN_SOURCE" -- "$@"; }

# Admin-gated call (schedule_upgrade / execute_upgrade / cancel_upgrade all call require_admin).
# Pre-cutover: single-key invoke. Post-cutover (MULTISIG=1): build-only -> sign x2 -> send, using
# the two signers already proven sufficient by the phase (a) multisig proof below.
admin_invoke(){
  if [ "$MULTISIG" = "1" ]; then
    local tag="$TMP/admin-$$-$RANDOM"
    stellar contract invoke --id "$VAULT_ID" --rpc-url "$RPC" --source "$MULTISIG_ADMIN" \
      --build-only -- "$@" > "$tag.unsigned"
    stellar tx sign "$tag.unsigned" --sign-with-key "$SIGNER_1" --rpc-url "$RPC" > "$tag.sig1"
    stellar tx sign "$tag.sig1" --sign-with-key "$SIGNER_2" --rpc-url "$RPC" > "$tag.sig2"
    stellar tx send "$tag.sig2" --rpc-url "$RPC"
  else
    stellar contract invoke --id "$VAULT_ID" --rpc-url "$RPC" --source "$ADMIN_SOURCE" -- "$@"
  fi
}

echo "vault=$VAULT_ID new_wasm_hash=$NEW_WASM_HASH multisig=$MULTISIG"

# ---- (a) schedule_upgrade — multisig proof when MULTISIG=1, single-key otherwise ----
if [ "$MULTISIG" = "1" ]; then
  echo "--- phase (a): multisig proof (schedule_upgrade, 1-of-2 vs 2-of-2 signatures) ---"
  UNSIGNED="$TMP/schedule.unsigned.xdr"
  stellar contract invoke --id "$VAULT_ID" --rpc-url "$RPC" --source "$MULTISIG_ADMIN" \
    --build-only -- schedule_upgrade --new_wasm_hash "$NEW_WASM_HASH" > "$UNSIGNED"

  ONE_SIG="$TMP/schedule.1sig.xdr"
  stellar tx sign "$UNSIGNED" --sign-with-key "$SIGNER_1" --rpc-url "$RPC" > "$ONE_SIG"
  set +e
  ONE_SIG_OUT="$(stellar tx send "$ONE_SIG" --rpc-url "$RPC" 2>&1)"
  ONE_SIG_RC=$?
  set -e
  [ "$ONE_SIG_RC" -ne 0 ] || fail "phase (a): schedule_upgrade with 1 signature was ACCEPTED — expected rejection (insufficient signing weight). Output: $ONE_SIG_OUT"
  pass "phase (a).1: 1-of-2 signature rejected as expected"

  TWO_SIG="$TMP/schedule.2sig.xdr"
  stellar tx sign "$ONE_SIG" --sign-with-key "$SIGNER_2" --rpc-url "$RPC" > "$TWO_SIG"
  stellar tx send "$TWO_SIG" --rpc-url "$RPC" \
    || fail "phase (a): schedule_upgrade with 2 signatures was rejected — expected success"
  pass "phase (a).2: 2-of-2 signature accepted — schedule_upgrade committed"
else
  echo "--- phase (a): multisig proof SKIPPED (MULTISIG=0 — only meaningful once the runbook's Step 5/6 have cut the vault admin over to 2-of-3; re-run with MULTISIG=1 after that) ---"
  admin_invoke schedule_upgrade --new_wasm_hash "$NEW_WASM_HASH" >/dev/null \
    || fail "schedule_upgrade (single admin: $ADMIN_SOURCE) failed"
  pass "phase (a): schedule_upgrade committed with single admin ($ADMIN_SOURCE)"
fi

# ---- (b) execute_upgrade immediately after schedule must be blocked (TimelockNotElapsed, #25) ----
echo "--- phase (b): execute_upgrade immediately after schedule (must be blocked) ---"
set +e
EXEC_OUT="$(admin_invoke execute_upgrade 2>&1)"
EXEC_RC=$?
set -e
echo "$EXEC_OUT"
[ "$EXEC_RC" -ne 0 ] || fail "execute_upgrade SUCCEEDED immediately after schedule — timelock did not block it"
echo "$EXEC_OUT" | grep -qiE 'Error\(Contract,[[:space:]]*#25\)|TimelockNotElapsed' \
  || fail "execute_upgrade failed but not with contract error #25/TimelockNotElapsed — got: $EXEC_OUT"
pass "phase (b): execute_upgrade blocked with TimelockNotElapsed (contract error #25)"

# ---- (c) pending_upgrade view + cancel_upgrade cleanup ----
echo "--- phase (c): pending_upgrade view + cancel_upgrade cleanup ---"
PENDING_OUT="$(view pending_upgrade)"
echo "pending_upgrade -> $PENDING_OUT"
echo "$PENDING_OUT" | grep -qi "$NEW_WASM_HASH" \
  || fail "pending_upgrade did not report the scheduled wasm hash — got: $PENDING_OUT"
pass "phase (c).1: pending_upgrade shows the scheduled record"

admin_invoke cancel_upgrade >/dev/null || fail "cancel_upgrade failed"
CLEARED_OUT="$(view pending_upgrade)"
echo "pending_upgrade (after cancel) -> $CLEARED_OUT"
if echo "$CLEARED_OUT" | grep -qi "$NEW_WASM_HASH"; then
  fail "pending_upgrade still shows the record after cancel_upgrade"
fi
pass "phase (c).2: cancel_upgrade cleared the probe (pending_upgrade empty)"

echo "PASS: two-phase upgrade smoke complete (schedule -> blocked execute -> pending view -> cancel)."
echo "NOTE: the REAL execute_upgrade (after the real 259200s/3-day delay elapses) is a separate, later, manual runbook step — out of this smoke's scope."

#!/usr/bin/env bash
# Jalur-2 dev: relayer lokal + cloudflared quick tunnel, biar Pages (/api/vf-cross) bisa nyampe.
# Quick-tunnel URL BERUBAH tiap restart — setelah jalan, update RELAYER_ORIGIN di Pages:
#   cd relayer && npx wrangler pages secret put RELAYER_ORIGIN --project-name vibing-farmer
# lalu redeploy Pages (push branch / retry deployment) supaya secret kebaca.
set -euo pipefail
cd "$(dirname "$0")"
node --env-file=.dev.vars src/main.mjs &
RELAYER_PID=$!
trap 'kill $RELAYER_PID 2>/dev/null' EXIT
sleep 1
exec "$HOME/.local/bin/cloudflared" tunnel --url http://localhost:${RELAYER_PORT:-8788}

# Runbook — Relayer + Lifeboat Radar on an Oracle Always Free VM

Deploys the cross-chain relayer and the lifeboat radar to a free 24/7 host behind a Cloudflare
tunnel, reachable only through the app's own `/api/vf-cross/*` Pages proxy. No public inbound port
is ever opened on the VM.

**Stack:** `deploy/docker-compose.yml` — three services: `relayer` (`:8788`, tunnel-only),
`radar` (lifeboat daemon), `cloudflared` (tunnel). Persistence: SQLite on a Docker volume
(`RELAYER_DB_PATH=/data/relayer.db`) so a restart loses no jobs or mandates.

> Host choice: Oracle Cloud "Always Free" ARM (Ampere) is the only verified always-on free tier
> (Fly.io has no always-on free tier; Render/Koyeb free tiers sleep). If Oracle signup is blocked
> (card verification or Ampere capacity), Railway (~$5/mo) is a drop-in fallback — nothing in this
> design depends on the host; it just needs Docker + outbound network.

---

## 1. Oracle signup

1. Go to <https://www.oracle.com/cloud/free/> and create an account. A credit card is required for
   identity verification; Always Free resources are **not** charged.
2. Pick a home region that still has Ampere A1 capacity (e.g. `ap-singapore-1`, `us-phoenix-1`).
   Capacity moves around — if instance creation fails with "out of host capacity", retry later or
   pick another region at signup.

## 2. Create the VM

1. Compute → Instances → Create instance.
2. Shape: **`VM.Standard.A1.Flex`**, 2 OCPU / 12 GB RAM (inside Always Free: 4 OCPU / 24 GB total).
3. Image: **Ubuntu 24.04 LTS**.
4. Add your SSH public key.
5. Networking: default VCN is fine. Do **NOT** add any ingress rule beyond SSH (22). The relayer is
   tunnel-only — it never needs an inbound web port.

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out/in so the group takes effect
docker --version && docker compose version
```

## 4. Get the code

```bash
sudo mkdir -p /opt/vibingfarmer && sudo chown "$USER" /opt/vibingfarmer
git clone <repo-url> /opt/vibingfarmer          # private repo without a VM deploy key: scp a tarball instead
```

The compose file lives in `/opt/vibingfarmer/deploy` and builds the `relayer` and `radar` images
from the sibling `../relayer` and `../keeper` directories — keep the repo layout intact.

## 5. Cloudflare tunnel

1. Cloudflare **Zero Trust** dashboard → Networks → Tunnels → **Create tunnel** (name it
   `vf-relayer`), choose the **Cloudflared** connector, and copy the tunnel **token**.
2. Put the token in `deploy/.env` as `CLOUDFLARED_TUNNEL_TOKEN` (step 6).
3. In the tunnel's **Public Hostname** tab, add a route:
   - Subdomain/hostname: `vf-relayer.<your-domain>`
   - Service: **HTTP** → `relayer:8788` (the compose service name — cloudflared reaches it over the
     compose network, no host port needed).

## 6. Secrets

```bash
cd /opt/vibingfarmer/deploy
cp .env.example .env && chmod 600 .env
# fill EVERY value in .env. Generate the shared proxy key:
openssl rand -hex 32        # -> paste as RELAYER_PROXY_KEY (also set the SAME value in Cloudflare Pages, step 9)
```

Fund the relayer keypairs on testnet before first run: the Stellar relayer account
(`RELAYER_STELLAR_PUBLIC`) via friendbot, and the Base account (`RELAYER_BASE_PRIVKEY`) with Base
Sepolia ETH + test USDC.

## 7. Start the stack

```bash
cd /opt/vibingfarmer/deploy
docker compose up -d --build
docker compose logs -f --tail 50        # expect "vf-cross relayer listening on :8788" + a cloudflared "Registered tunnel connection"
```

## 8. Boot persistence (systemd)

```bash
sudo cp vibingfarmer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable vibingfarmer      # brings the stack up on every boot
```

## 9. Cloudflare Pages env

In the Pages project (Production **and** Preview if you use it):

- `RELAYER_ORIGIN=https://vf-relayer.<your-domain>`
- `RELAYER_PROXY_KEY=<the same value generated in step 6>`

Redeploy the Pages project so the new env is picked up.

## 10. Verify

```bash
# Direct tunnel, WITH the key + an unknown job -> 404 JSON (relayer reachable + auth passing):
curl -s https://vf-relayer.<your-domain>/api/vf-cross/status/x -H "x-vf-relayer-key: <key>"
#   => {"error":"unknown jobId"}

# Direct tunnel WITHOUT the key -> 401 (shared-secret gate working):
curl -s -o /dev/null -w "%{http_code}\n" https://vf-relayer.<your-domain>/api/vf-cross/status/x
#   => 401

# Through the app origin (proxy + _guard origin allowlist + rate limit + injected key):
curl -s https://<app>.pages.dev/api/vf-cross/status/x
#   => {"error":"unknown jobId"}   (404)
```

## 11. Restart-resilience drill

```bash
# Mint a mandate (from a machine with the repo + relayer .dev.vars):
cd relayer && node --env-file=.dev.vars smoke/mint-mandate.mjs   # POSTs /mandate, prints the approval
# On the VM, bounce the relayer, then reuse that approval on /farm:
docker compose restart relayer
# A /farm with the same approval must NOT return "unknown mandate" — sqlite persisted it.
```

---

## Operations

- **Logs:** `docker compose logs -f relayer` / `radar` / `cloudflared`.
- **Update:** `git pull && docker compose up -d --build` (systemd runs the same on reboot).
- **Rotate the proxy key:** regenerate, set it in both `deploy/.env` and Cloudflare Pages, then
  `docker compose up -d` + redeploy Pages.
- **DB location:** `/var/lib/docker/volumes/deploy_relayer-data/_data/relayer.db` — holds session-key
  mandates (expire at 1h TTL) and idempotency records; the volume is root-owned. Back up only if you
  need job history; mandates are ephemeral by design.
- **Testnet reset:** after a quarterly Stellar reset, update the Stellar addresses in `deploy/.env`
  and re-fund the keypairs (see `docs/runbooks/testnet-reset.md`), then `docker compose up -d`.

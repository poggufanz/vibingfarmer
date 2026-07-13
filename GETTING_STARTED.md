# GETTING_STARTED.md — Vibing Farmer

**"Set once. Vibe forever."**  
Indie open-source · AI agent swarm for automated yield farming on **Stellar/Soroban**.

Canonical product claims: [`prd.md`](prd.md). Architecture overview: [`README.md`](README.md).

---

## 0. What this is (current stack)

| Layer | Status | Notes |
|-------|--------|--------|
| Primary chain | âœ… Stellar **testnet** / Soroban | Live deposit → autofarm vault → **Blend v2** pool |
| Gas abstraction | âœ… Own fee-bump relay | `/api/stellar-relay` — **not 1Shot** |
| single-signature grant | âœ… `funding_router` | Budget + expiry; deploys per-run agents |
| AI | âœ… Venice / DeepSeek / fallback | BYOK-first; host keys optional |
| Cross-chain (optional) | âœ… CCTP v2 + ZeroDev | Base Sepolia leg via `relayer/` — **not 1Shot** |
| EVM single-chain path | âŒ Superseded | Old AgentVaultDepositor + 1Shot removed 2026-06-21 |

---

## 1. Prerequisites

- **Node.js** 20+ and npm
- **Stellar wallet** on testnet: [Freighter](https://www.freighter.app), xBull, or Albedo
- **Friendbot** for test XLM: https://friendbot.stellar.org  
- Optional: WSL + Rust + Stellar CLI (only if you build/deploy contracts)
- Optional: funded `STELLAR_RELAYER_SECRET` for gasless agent txs in local Functions

---

## 2. Quick start (frontend)

```bash
cd frontend
cp .env.example .env.local
cp .dev.vars.example .dev.vars   # server secrets for Pages Functions / local API

npm install
npm run dev
```

Open `http://localhost:5173`, connect a testnet wallet.

### Minimal `.dev.vars` (local gasless + AI)

```env
# Optional host AI (leave unset for BYOK / fallback-only)
# DEEPSEEK_API_KEY=sk-...

ALLOWED_ORIGIN=http://localhost:5173

# Fee-bump relayer (server-only). Generate + fund on testnet.
STELLAR_RELAYER_SECRET=S...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# See deployments/stellar-testnet.json for live values
SOROBAN_VAULT_ADDRESS=CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU
SOROBAN_ROUTER_ADDRESS=CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY
```

There are **no** `ONESHOT_*` variables. Do not add them.

Addresses and notes: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

---

## 3. Demo path (happy path)

1. Connect Freighter (testnet).
2. Fund wallet (Friendbot + testnet Blend USDC / faucet if configured).
3. Open **Strategy** wizard: amount, risk, agent count.
4. Review AI skills + council / eligibility (if shown) → approve.
5. **a single signature:** `funding_router.grant` (budget + duration).
6. Workers deposit gas-free via session keys + fee-bump relay.
7. Check graph / positions; kill switch = revoke allowance / agent revoke.

Optional: **`/farm`** cross-chain flow needs `relayer/` running + ZeroDev/CCTP env (see `relayer/` and `frontend/.env.example` Base section).

---

## 4. Contracts (WSL only)

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```

Deploy/seed scripts live under `scripts/soroban/` (e.g. `deploy-seed.sh`). Never run `cargo`/`stellar` from bare PowerShell.

---

## 5. Repo map (what you will edit)

```
soroban/contracts/          # funding_router, agent_account, vault, blend_strategy, registry, …
frontend/src/stellar/       # chain client, session keys, relay client
frontend/api/stellar-relay.js   # gasless fee-bump (replaces 1Shot)
frontend/src/orchestrator.js
frontend/src/worker.js
frontend/src/strategy/      # council, gates, Monte Carlo, monitor
relayer/                    # CCTP + Base/ZeroDev (optional leg)
keeper/                     # lifeboat radar
base-contracts/             # YieldRouter + adapters (Base)
deployments/                # stellar-testnet.json, base-sepolia.json
prd.md                      # product requirements
```

---

## 6. Gas abstraction — who replaced 1Shot?

| Era | Mechanism |
|-----|-----------|
| EVM prototype (superseded) | 1Shot Managed / Permissionless relayer |
| **Live Stellar path** | Own **fee-bump** relayer: `POST /api/stellar-relay` with allowlisted ops |
| **Live Base cross-chain** | Own Node relayer + **ZeroDev** session keys / UserOps |

If a doc still says “1Shot”, treat it as historical unless it is this file or `prd.md` timeline “superseded”.

---

## 7. Tests & lint

```bash
cd frontend && npm test && npm run lint && npm run build

wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```

---

## 8. Checklist — local demo ready

- [ ] `frontend` deps installed; `npm run dev` serves the app
- [ ] Wallet on **Stellar testnet** with Friendbot XLM
- [ ] `.dev.vars` has relayer secret + vault/router addresses from deployments JSON
- [ ] Strategy run: a single grant signature, workers deposit, shares increase on explorer/positions
- [ ] No `ONESHOT_*` in env; relay logs show fee-bump submit (not 1shotapi.com)
- [ ] (Optional) Cross-chain: `relayer` up + ZeroDev project id for `/farm`

---

## 9. Further reading

| Doc | Use |
|-----|-----|
| [prd.md](prd.md) | Full product requirements, FR table, timeline |
| [README.md](README.md) | Architecture, routes, env templates |
| [DESIGN.md](DESIGN.md) | UI / design system |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Agent coding instructions |
| [soroban/README.md](soroban/README.md) | Contract build/test one-liners |
| Stellar docs | https://developers.stellar.org |
| Blend | https://docs.blend.capital |
| Circle CCTP | https://developers.circle.com/cctp |
| ZeroDev | https://docs.zerodev.app |

---

## Historical note

Earlier drafts of this file described an **EVM Sepolia** MVP (EIP-7702, ERC-7715, AgentVaultDepositor, MockVault, 1Shot). That path was **decommissioned 2026-06-21**. This document describes the **current** Stellar-first product only.

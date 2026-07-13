<p align="center">
  <img src="frontend/public/vibing_farmer.logo.png" alt="Vibing Farmer Logo" width="100%" />
</p>

# Vibing Farmer

> Set once. Vibe forever.

Yield farming is mostly the same clicks: find a vault, approve, deposit, repeat for the next protocol. Vibing Farmer runs those deposits in parallel. An AI picks the vaults and writes per-agent instructions; you approve once; disposable worker keys do the rest. You pay zero gas.

I built this because sequential DeFi UIs waste time. You say how much and how much risk you'll take. Agents run the deposits. Scope is enforced on-chain (allowance, expiry, vault pin), not by trusting the AI.

Single chain: **Stellar / Soroban**. Contracts are under `soroban/`. The chain client is `frontend/src/stellar/`.

## How it works

1. **Strategy.** You set deposit amount, risk, and how many vaults. The strategist returns an allocation plan and a skill JSON per worker. Prefer **Venice AI** (paste an API key in Settings, or pay with x402 / SIWE and prepaid USDC). If neither is set, the app uses a DeepSeek server proxy so local demos still work. Before you commit, Monte Carlo runs 200 scenarios over 30 days on that allocation.

2. **AI council.** Three specialists (yield, risk, market) score the proposal separately. On disagreement, a synthesis call settles it. Verdict, cited playbook rules, and how the conflict was resolved all get logged.

3. **Review.** Open the skill JSON in the drawer, edit anything, approve only when you're happy. Nothing runs until then.

4. **Connect.** Freighter, xBull, or Albedo through Stellar Wallets Kit. No account upgrade, no extra browser permission ceremony.

5. **One signature.** Sign `funding_router.grant` (budget + expiry). Nested SEP-41 allowance is the leash. The router deploys fresh scoped `agent_account`s. Each worker signs deposits with an ed25519 session key on a Soroban auth entry; the fee-bump relayer (or your RPC) broadcasts. **1Shot is gone** (old EVM path). Gas is our Stellar fee-bump, plus optional ZeroDev on Base if you use the cross-chain leg.

6. **Parallel deposit.** `OrchestratorAgent` starts N `WorkerAgent`s with `Promise.allSettled`. Each pulls within the grant, builds a deposit, signs the auth entry with its session key, submits via fee-bump. Zero gas for the user.

7. **Attestation.** Strategy JSON is hashed and written on-chain. Anyone with the original JSON can recompute the hash.

8. **Monitor loop.** A Web Worker polls positions, flags APY drift and risk, and can propose rebalances. Council reviews each cycle. ACE Curator grows, merges, and prunes playbook rules from outcomes worth keeping. Journals and decision logs sit in localStorage and show up on the Agent Dashboard.

9. **Kill switch.** Two user-signed paths that still work if the relayer is down:
   - Global: `token.approve(router, 0)` (SEP-41 allowance *is* the budget; zero it and funding stops).
   - Per agent: `agent_account.revoke()` flips the `revoked` flag that `__check_auth` fails closed on, and zeroes that agent's vault allowance.
   Registry only mirrors revoke state for indexers/UI. It does not enforce.

---

## Architecture

```
User input (amount, risk level, vault count)
                |
                v
        AI strategist (Venice AI — key or x402; DeepSeek proxy fallback)
          |-- Multi-vault allocation + live DeFiLlama data
          |-- Skill JSON per agent (deposit cap + expiry)
          |-- MDP state: turbulence regime
                |
                v
        Monte Carlo sim (200 runs, 30d)
        AI Council (yield + risk + market specialists)
                |
                v
        User connects wallet + single-signature grant (funding_router)
                |
                v
        OrchestratorAgent --- attest strategy hash on-chain
          |
    +-----+-----+
    v     v     v
 Worker Worker Worker   (parallel agents)
   ed25519 session key signs a Soroban auth entry
   own fee-bump relay broadcasts (zero gas; not 1Shot)
   autofarm vault → Blend strategy — shares vfVLT, 7-dp
                |
                v
        Autonomous Monitor Loop (Web Worker)
          Council review each cycle
          ACE Curator (playbook evolution)
          Cycle journal + decision log
```

---

## Deployed contracts (Stellar testnet)

| Contract | Address |
|----------|---------|
| Autofarm vault (live deposit, `vfVLT` 7-dp) | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` |
| Funding router (single-signature grant) | `CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY` |
| Registry | `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ` |
| Blend USDC token (7-dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend v2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Demo agent (seeded smoke) | `CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC` |

Stellar Expert: `https://stellar.expert/explorer/testnet/contract/<address>`. Live map: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

> **Legacy (2026-07-13):** addresses above predate the hardening pass (agent revoke, derived registry records, vault strategy isolation, Blend live NAV). Details in [`SECURITY.md`](SECURITY.md). They are still the public demo until hardened wasm is redeployed and smoke-tested. Treat them as legacy until this note is removed with a new manifest.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Smart contracts | Rust, Soroban SDK, OpenZeppelin Stellar contracts |
| Frontend | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d |
| Chain client | `@stellar/stellar-sdk`, Stellar Wallets Kit (Freighter / xBull / Albedo) |
| AI | Venice AI (`zai-org-glm-5-1`) via API key or x402 (SIWE, prepaid USDC); DeepSeek (`deepseek-v4-flash`) server proxy as zero-config fallback |
| Live yield data | DeFiLlama API (APY, TVL, 7-day history) |
| Web search | Tavily API (server proxy) for strategy context |
| Gas | Own fee-bump relayer (`/api/stellar-relay`); replaces old 1Shot path; user pays 0 |
| Cross-chain (optional) | Circle CCTP v2 + Node `relayer/` + ZeroDev on Base Sepolia |
| Wallet | Standard Stellar wallet; no smart-account upgrade |
| Crypto | ed25519 session keys; libsodium KDF-sealed per-worker key vault |
| Validation | Zod at boundaries |
| Network | Stellar testnet (Soroban), 7-dp token base units |
| Hosting | Cloudflare Pages: static SPA + `/api/*` Pages Functions |
| CI | GitHub Actions: frontend lint, Vitest, build |
| Lint / format | ESLint 9 flat + Prettier; clippy on contracts |
| Tests | cargo (contracts), Vitest (frontend) |

---

## Contracts (`soroban/contracts/`)

- **`registry`** — metadata for indexers and UI. Not an auth boundary. `authorize(agent)` fills record fields from the agent’s own `scope_of()` (caller only passes the address; derived owner must sign). Owner cannot switch. `is_active` is fail-closed for unknown, revoked, or expired agents. `revoke` only mirrors state; enforcement is `agent_account.revoke()`.

- **`rwa_vault` / autofarm vault** — deposit vault (shares `vfVLT`, 7 decimals). Strategies supply into **Blend Capital v2** on testnet. Live target: `autofarmVault` in `deployments/stellar-testnet.json`.

- **`agent_account`** — Soroban custom account. `__check_auth` enforces constructor-pinned scope (vault, token, cap, expiry). Per-run agents come from `funding_router`.

- **`funding_router`** — single-signature factory and funding gate. SEP-41 allowance is the leash; the router does not custody funds long-term.

### What the vault rejects

- Amount over period cap → revert  
- Wrong vault or token → revert  
- Expired or revoked scope → revert  
- CEI ordering throughout  
- No custody of agent keys in the vault (session key lives on the agent account)

---

## Test suite

**Contracts** (cargo in `soroban/`): unit tests per crate, plus integration, invariant, fork, and security drills.

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

(Use WSL for those; see below.)

**Frontend** (Vitest): orchestrator, worker, Stellar client under `frontend/src/stellar/*.test.js` (client, agentSetup, agentDeposit, revoke, events, sessionKey, walletKit, scval, relay, config, format), skills, positions store, wallet, Venice AI, council, simulation, MDP, gates, monitor loop, decision log, playbook, curator, and related modules.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Scroll landing hero; no wallet required |
| `/home` | Portfolio, positions, alerts, market pulse |
| `/strategy` | Wizard: input → connect → skills → permission → execute → done |
| `/agent` | Dashboard: scopes, revoke, monitor status, journal, decision log |
| `/history` | Tx and strategy history |
| `/settings` | Wallet, permissions, agent config, language, skill source |
| `/vault/:protocol` | Per-vault detail |
| `/tx/:txHash` | Transaction detail |
| `/explorer` | On-chain verification (contracts, TVL, test stats); no wallet |
| `/ecosystem` | Stack notes: Stellar/Soroban, Venice AI, fee-bump, DeFiLlama |
| `/replay` | Timeline replay from static JSON (no RPC) |

---

## Strategy engine (`frontend/src/strategy/`)

| Module | Purpose |
|--------|---------|
| `mdp.js` | MDP state, action space, reward scoring |
| `simulation.js` | Seeded Monte Carlo (200 runs, 30-day horizon) |
| `council.js` | Council verdict (yield, risk, market) |
| `councilReview.js` | Pre-deposit deliberation + conflict resolution |
| `gates.js` | Pre-submit circuit breaker (economic, rate limits) |
| `monitorLoop.js` | Loop: observe → gate → simulate → council → execute → reflect |
| `decisionLog.js` | Decision audit trail |
| `cycleJournal.js` | Per-cycle journal (pass/fail, action, reward) |
| `curator.js` | ACE Curator: grow playbook rules from outcomes |
| `ruleStore.js` | Playbook persistence (seed, grow, merge, prune) |
| `keyVault.js` | KDF-sealed per-worker keys |
| `submitGate.js` | Economic + rate-limit gate |
| `permissionScope.js` | Scope builder (single source) |
| `session.js` | Grant persistence and rehydrate |
| `fetchDag.js` | Parallel fetch DAG with timing |

---

## Skill system

One typed skill file per agent (deposit-only; amounts in 7-dp base units):

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU",
  "skills": {
    "deposit": { "maxAmount": "1000000000", "vaultAddress": "CB5VKYDU…JDYU", "expiresAt": 1749686400 }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

`maxAmount` is 7-dp base units (`1000000000` = 100 USDC). Every field is editable in the Skills Drawer before approval. Allocation reasoning is steered by `frontend/src/skills/default/vault-advisor.md`. You can swap custom skill files in Settings.

---

## Prerequisites

- Stellar wallet on **testnet**: [Freighter](https://www.freighter.app), xBull, or Albedo  
- Funded testnet account ([Friendbot](https://friendbot.stellar.org)). Relayer pays agent fees, so you pay 0 gas for agent txs.  
- Testnet USDC from the deployed token contract for deposits  

---

## Quick start

```bash
cd frontend
cp .env.example .env.local       # Vite client vars
cp .dev.vars.example .dev.vars   # server proxy + relayer secrets (Pages Functions)
# Venice: paste key in Settings (https://venice.ai/settings/api) or use x402.
# DeepSeek fallback: optional DEEPSEEK_API_KEY on the server.

npm install
npm run dev
```

Open `http://localhost:5173`, connect Freighter / xBull / Albedo on testnet.

---

## Environment variables

**Server-side only** (Cloudflare Pages env / `.dev.vars` — never `VITE_` for secrets):

```env
DEEPSEEK_API_KEY=sk-...                          # /api/ai — optional fallback proxy (BYOK-first)
TAVILY_API_KEY=tvly-...                          # /api/search — optional market context
ALLOWED_ORIGIN=https://your-project.pages.dev    # /api/* origin allowlist (prod)

# Soroban fee-bump (/api/stellar-relay)
STELLAR_RELAYER_SECRET=S...                       # fund this keypair on testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CB5VKYDU…JDYU               # autofarm vault (see deployments JSON)
SOROBAN_ROUTER_ADDRESS=CBEI5VJK…NOFY              # funding_router
```

Leave host AI keys unset for a lockdown deploy (BYOK). Relayer fee-bumps from `STELLAR_RELAYER_SECRET`; user pays 0 gas. No `ONESHOT_*` vars.

---

## Smart contract commands (WSL only)

Do not run `cargo` / `stellar` in PowerShell. Use WSL:

```bash
# Build all contracts to wasm
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"

# Test
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

# Lint (warnings as errors)
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy --all-targets -- -D warnings"

# Deploy testnet + seed demo agent
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && ./deploy-seed.sh"
```

---

## Frontend scripts

```bash
cd frontend
npm test              # Vitest — *.test.js in src/ and src/strategy/
npm run lint          # ESLint flat config
npm run format        # Prettier write
npm run build         # production → dist/
npm run pages:dev     # build + wrangler pages dev (Functions locally)
```

---

## CI

**`.github/workflows/frontend.yml`** (push/PR on `main`, `iq`):

- lint: `npm run lint` (soft-fail)
- test: `npm test`
- build: `npm run build`

Contracts: build and test locally with cargo in WSL.

---

## Deploy (Cloudflare Pages)

Vite SPA in `dist/` on the edge; `/api/{ai,search,stellar-relay}` as Pages Functions. Local Vite reuses the same `api/*.js` handlers as middleware.

```bash
cd frontend
npm run pages:dev      # vite build + wrangler pages dev
npm run pages:deploy   # after `wrangler login`
```

Set `STELLAR_RELAYER_SECRET`, `SOROBAN_*`, `DEEPSEEK_API_KEY`, `ALLOWED_ORIGIN`, etc. in the Pages dashboard. Longer guide: [frontend/DEPLOY-CLOUDFLARE.md](frontend/DEPLOY-CLOUDFLARE.md).

---

## Directory structure

```
soroban/
  Cargo.toml                     # workspace
  contracts/
    registry/                    # per-agent scope metadata
    rwa_vault/                   # yield vault + autofarm (vfVLT, 7-dp)
    agent_account/               # custom account (__check_auth)
    funding_router/              # single-signature grant factory
    blend_strategy/              # vault → Blend pool
  # deploy scripts under scripts/soroban/

deployments/
  stellar-testnet.json           # live Stellar testnet addresses
  base-sepolia.json              # optional Base cross-chain leg

frontend/
  wrangler.jsonc                 # Cloudflare Pages (nodejs_compat)
  DEPLOY-CLOUDFLARE.md
  .env.example                   # client (VITE_) template
  .dev.vars.example              # server secrets (local Functions)
  api/                           # proxies (also Vite dev middleware)
    ai.js                        # DeepSeek proxy
    search.js                    # Tavily proxy
    stellar-relay.js             # fee-bump
    _guard.js                    # CORS + rate limit
    _pagesAdapter.js             # api/*.js → Pages Functions
  functions/api/                 # edge wrappers
  public/
    _routes.json                 # Functions only on /api/*
    _headers                     # security headers

frontend/src/
  stellar/                       # Soroban client
    client.js, config.js, walletKit.js, sessionKey.js,
    agentSetup.js, agentDeposit.js, revoke.js, events.js,
    relay.js, scval.js, format.js, index.js
  components/                    # pages and UI
  strategy/                      # decision engine (+ *.test.js)
  orchestrator.js                # dispatches workers
  worker.js                      # single vault flow
  agents/                        # lifecycle + background worker
  strategist.js                  # Venice / DeepSeek / fallback
  attestation.js, skills.js, defiLlama.js, positionsStore.js,
  history.js, settingsStore.js, config.js

agents/                          # runtime-generated, gitignored
docs/                            # gitignored local notes (not public docs)
```

---

## Documentation (tracked)

| Document | Focus |
|----------|-------|
| [prd.md](prd.md) | Product requirements and feature status |
| [GETTING_STARTED.md](GETTING_STARTED.md) | Local setup and demo checklist |
| [DESIGN.md](DESIGN.md) | Design system / UI |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Agent coding instructions |
| [soroban/README.md](soroban/README.md) | Contract build and test |

Folder `docs/` is gitignored (local planning notes). Do not link it as public repo docs.

---

## Resources

- [Stellar Developers](https://developers.stellar.org)
- [Soroban smart contracts](https://developers.stellar.org/docs/build/smart-contracts)
- [Stellar Wallets Kit](https://stellarwalletskit.dev)
- [Freighter wallet](https://www.freighter.app)
- [Blend Capital](https://docs.blend.capital) (Autofarm vault supplies the testnet pool)
- [Circle CCTP](https://developers.circle.com/cctp) (Stellar↔Base USDC)
- [ZeroDev](https://docs.zerodev.app) (Base session keys)
- [Venice AI](https://venice.ai)
- [DeepSeek API](https://api-docs.deepseek.com)
- [Tavily API](https://docs.tavily.com)
- [Cloudflare Pages](https://developers.cloudflare.com/pages/)
- [DeFiLlama API](https://defillama.com/docs/api)

---

## License

MIT

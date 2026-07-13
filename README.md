<p align="center">
  <img src="frontend/public/vibing_farmer.logo.png" alt="Vibing Farmer Logo" width="100%" />
</p>

# Vibing Farmer

> Set once. Vibe forever.

Yield farming means the same boring clicks over and over: find a vault, approve, deposit. Do it again for the next protocol. Vibing Farmer runs all of that in parallel. An AI picks the vaults, generates per-agent instructions, you approve once, and disposable worker keys execute — zero gas on your end.

Built out of frustration with click-heavy sequential DeFi workflows. The thesis: users express intent, agents execute autonomously, and the blockchain enforces boundaries with cryptography — not trust.

Vibing Farmer is **single-chain on Stellar/Soroban**. Contracts live in `soroban/`; the chain client lives in `frontend/src/stellar/`.

## How it works

1. **Strategy** — A privacy-first AI strategist takes your deposit amount, risk tolerance, and vault count, then outputs an allocation plan and a skill JSON per worker agent. The recommended provider is **Venice AI** (uncensored, zero-data-retention), used either by pasting a Venice API key in Settings or via x402 wallet payment (an EIP-4361 SIWE signature with a prepaid USDC balance — not a social login). If neither is configured, it falls back to a DeepSeek server-side proxy so the app works with zero setup. A Monte Carlo simulation runs 200 scenarios over 30 days against the proposed allocation before you commit.

2. **AI Council** — Three AI specialists (yield, risk, market) independently evaluate the proposal. If they disagree, a synthesis call resolves the conflict. The verdict, cited playbook rules, and resolution method are all logged.

3. **Review** — You read and edit the generated skill JSON. Every field is exposed in a slide-out drawer. Nothing executes until you approve.

4. **Connect** — Connect a standard Stellar wallet (Freighter / xBull / Albedo) via the Stellar Wallets Kit. There is no account upgrade and no browser permission prompt.

5. **single-signature grant** — You sign once on `funding_router.grant` (budget + expiry). Nested SEP-41 allowance is the leash; the router deploys fresh scoped `agent_account`s. Deposits are authorized by each worker's ed25519 session key signing a Soroban authorization entry — the fee-bump relayer (or your own RPC) can broadcast it. **1Shot is not used** (EVM-era; superseded by own Stellar fee-bump + optional ZeroDev on Base).

6. **Parallel execution** — `OrchestratorAgent` dispatches N `WorkerAgent` instances via `Promise.allSettled`. Each pulls funding within the grant, builds a deposit invocation, signs the Soroban auth entry with its session key, and submits through the fee-bump relayer. Zero gas for the user.

7. **Strategy attestation** — The AI strategy output gets hashed and written on-chain. Anyone can reproduce the hash from the original JSON.

8. **Autonomous monitor loop** — A background Web Worker polls positions, detects APY drift, surfaces risk alerts, and proposes rebalances. A TradingAgents-style council reviews each cycle. An ACE Curator grows, merges, and prunes playbook rules from notable outcomes. Cycle journals and decision logs are stored in localStorage and surfaced in the Agent Dashboard.

9. **Kill switch** — A user-signed `registry.revoke` works even when the relayer is down. Revocation is instant and on-chain.

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

## Deployed contracts — Stellar testnet

| Contract | Address |
|----------|---------|
| Autofarm vault (LIVE deposit, `vfVLT` 7-dp) | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` |
| Funding router (single-signature grant) | `CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY` |
| Registry | `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ` |
| Blend USDC token (7-dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend v2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Demo agent (seeded smoke) | `CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC` |

Verify on Stellar Expert: `https://stellar.expert/explorer/testnet/contract/<address>`. Canonical live map: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Smart contracts | Rust, Soroban SDK, OpenZeppelin Stellar contracts |
| Frontend | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d |
| Chain client | `@stellar/stellar-sdk`, Stellar Wallets Kit (Freighter / xBull / Albedo) |
| AI | **Venice AI** (`zai-org-glm-5-1`) — recommended, via API key or x402 wallet payment (SIWE, prepaid USDC); DeepSeek (`deepseek-v4-flash`) server-side proxy as zero-config fallback |
| Live yield data | DeFiLlama API — APY, TVL, 7-day history |
| Web search | Tavily API (server proxy) — live DeFi context for strategy prompts |
| Gas abstraction | Own fee-bump relayer (`/api/stellar-relay`) — replaces EVM-era 1Shot; user pays 0 |
| Cross-chain (optional) | Circle CCTP v2 + Node `relayer/` + ZeroDev on Base Sepolia |
| Wallet | Standard Stellar wallet (Freighter / xBull / Albedo) — no smart-account upgrade |
| Crypto | ed25519 session keys; libsodium — KDF-sealed per-worker key vault |
| Validation | Zod schemas at boundaries |
| Network | Stellar testnet (Soroban) — 7-dp token base units |
| Hosting | Cloudflare Pages — static SPA + `/api/*` Pages Functions (edge) |
| CI | GitHub Actions — frontend (lint, Vitest, build) |
| Lint/format | ESLint 9 flat config + Prettier; clippy (contracts) |
| Test runner | cargo (contracts), Vitest (frontend) |

---

## Contracts (`soroban/contracts/`)

Three Rust crates:

- **`registry`** — single source of truth for per-agent deposit scope. `authorize` sets vault, token, cap-per-period, period duration, expiry. Each deposit charges against the cap, rolling the fixed window if elapsed. `revoke` is an instant user-signed kill switch. `scope_of` reads the live scope.

- **`rwa_vault` / autofarm vault** — deposit vault (shares `vfVLT`, 7 decimals) with strategies that supply into **Blend Capital v2** on testnet. Live deposit target is `autofarmVault` in `deployments/stellar-testnet.json`.

- **`agent_account`** — Soroban custom account; `__check_auth` enforces constructor-pinned scope (vault, token, cap, expiry). Per-run agents are deployed via `funding_router`.

- **`funding_router`** — single-signature factory + funding gate (SEP-41 allowance leash; zero custody).

### Contract security

The vault rejects every violation:

- Amount exceeds period cap -> revert
- Vault or token mismatch -> revert
- Expired or revoked scope -> revert
- Checks-Effects-Interactions order throughout
- Zero custody of agent keys: the agent account holds the session key, not the vault

---

## Test suite

Contracts (cargo, in `soroban/`): unit tests per crate plus integration, invariant, fork, and security drills. Run with `cargo test`; lint with `cargo clippy --all-targets -- -D warnings`.

Frontend tests (Vitest): orchestrator, worker, the Stellar chain client (`frontend/src/stellar/*.test.js` — client, agentSetup, agentDeposit, revoke, events, sessionKey, walletKit, scval, relay, config, format), skills, positions store, wallet, Venice AI, council, simulation, MDP, gates, monitor loop, decision log, playbook, curator, and more.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Scroll-driven landing hero — first-time visitors, no wallet needed |
| `/home` | Portfolio, positions, alerts, Market Pulse |
| `/strategy` | 6-step wizard: input, connect, skills, permission, execute, done |
| `/agent` | Agent Dashboard — live scopes, revoke UI, monitor loop status, cycle journal, decision log |
| `/history` | Transaction and strategy history |
| `/settings` | Wallet, permissions, agent config, language, skill source |
| `/vault/:protocol` | Per-vault detail |
| `/tx/:txHash` | Transaction detail |
| `/explorer` | On-chain verification — contracts, TVL, test stats. No wallet required. |
| `/ecosystem` | Tech-stack reference — Stellar/Soroban, Venice AI, fee-bump relayer, DeFiLlama |
| `/replay` | Historical timeline replay (zero-RPC, static JSON) |

---

## Strategy engine (`frontend/src/strategy/`)

The `strategy/` directory contains the autonomous decision-making spine:

| Module | Purpose |
|--------|---------|
| `mdp.js` | Markov Decision Process — state builder, action-space enforcement, reward scoring |
| `simulation.js` | Seeded Monte Carlo simulation (200 runs, 30-day horizon) |
| `council.js` | TradingAgents-style council verdict (yield, risk, market specialists) |
| `councilReview.js` | Pre-deposit council deliberation with conflict resolution |
| `gates.js` | Pre-submit circuit breaker: economic, rate limits |
| `monitorLoop.js` | Never-stop autonomous loop: observe, gate, simulate, council, execute, reflect |
| `decisionLog.js` | Persistent decision audit trail |
| `cycleJournal.js` | Cycle-level journal (pass/fail, action taken, reward) |
| `curator.js` | ACE Curator — grows playbook rules from notable outcomes |
| `ruleStore.js` | Playbook persistence (seeds, growth, merge, prune) |
| `keyVault.js` | KDF-sealed per-worker key derivation |
| `submitGate.js` | Economic + rate-limit gate |
| `permissionScope.js` | Single-source scope builder |
| `session.js` | Grant persistence and rehydration |
| `fetchDag.js` | Parallel data-fetch DAG with timing telemetry |

---

## Skill system

The AI strategist generates a typed skill file per agent (deposit-only; amounts in 7-dp base units):

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

`maxAmount` is in 7-dp base units (`1000000000` = 100 USDC). Every field is editable in the Skills Drawer before approval. A vault-advisor system prompt (`frontend/src/skills/default/vault-advisor.md`) governs the AI's allocation reasoning. Users can swap in custom skill files.

---

## Prerequisites

- A Stellar wallet — [Freighter](https://www.freighter.app), xBull, or Albedo — set to **Stellar testnet**.
- A funded testnet account (use [Friendbot](https://friendbot.stellar.org)). The fee-bump relayer covers transaction fees for agent execution, so end users pay 0.
- Testnet USDC (the deployed token contract) to deposit.

---

## Quick start

```bash
cd frontend
cp .env.example .env.local       # Vite client vars
cp .dev.vars.example .dev.vars   # server-side proxy + relayer secrets (Pages Functions)
# Venice AI (recommended) needs no key — paste one in Settings
# (https://venice.ai/settings/api) or use x402 wallet payment.
# DeepSeek is the zero-config fallback (DEEPSEEK_API_KEY, optional).

npm install
npm run dev
```

Open `http://localhost:5173` and connect Freighter / xBull / Albedo on testnet.

---

## Environment variables

**Server-side (Cloudflare Pages env / `.dev.vars` — never bundled to the client):**

```env
DEEPSEEK_API_KEY=sk-...                          # /api/ai — optional fallback AI proxy (BYOK-first)
TAVILY_API_KEY=tvly-...                          # /api/search — optional live market context
ALLOWED_ORIGIN=https://your-project.pages.dev    # /api/* origin allowlist (prod)

# Soroban fee-bump relay (read by /api/stellar-relay)
STELLAR_RELAYER_SECRET=S...                       # relayer keypair secret — fund on testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CB5VKYDU…JDYU               # autofarm vault (see deployments JSON)
SOROBAN_ROUTER_ADDRESS=CBEI5VJK…NOFY              # funding_router (single-signature grant)
```

AI keys are BYOK-first — leave host keys unset for a lockdown deploy. The relay fee-bumps agent transactions from the funded `STELLAR_RELAYER_SECRET` keypair, so the user pays 0 gas. There is no 1Shot / `ONESHOT_*` config.

---

## Smart contract commands (WSL only)

Soroban tooling runs in WSL. Never run `cargo`/`stellar` directly in PowerShell.

```bash
# Build all contracts to wasm
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"

# Test all
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

# Lint (treat warnings as errors)
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy --all-targets -- -D warnings"

# Deploy to testnet + seed the demo agent
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && ./deploy-seed.sh"
```

---

## Frontend scripts

```bash
cd frontend
npm test              # Vitest — *.test.js in src/ and src/strategy/
npm run lint          # ESLint (flat config)
npm run format        # Prettier write
npm run build         # production build -> dist/
npm run pages:dev     # build + wrangler pages dev (Functions run locally)
```

---

## CI pipeline

**`.github/workflows/frontend.yml`** — frontend (push/PR on `main`, `iq`):

- **lint** — `npm run lint` (ESLint, soft-fail)
- **test** — `npm test` (Vitest)
- **build** — `npm run build` (Vite production build)

Soroban contracts are built and tested locally via cargo in WSL (see above).

---

## Deployment — Cloudflare Pages

The frontend ships as a Cloudflare Pages app: the Vite SPA (`dist/`) served from the
edge, and the `/api/{ai,search,stellar-relay}` proxies running as Pages Functions. Local
Vite dev is unchanged — it reuses the same `api/*.js` handlers as middleware.

```bash
cd frontend
npm run pages:dev      # local: vite build + wrangler pages dev
npm run pages:deploy   # deploy (run `wrangler login` first)
```

Set the server-side secrets (`STELLAR_RELAYER_SECRET`, `SOROBAN_*`, `DEEPSEEK_API_KEY`,
`ALLOWED_ORIGIN`, …) in the Pages dashboard. Full guide:
[frontend/DEPLOY-CLOUDFLARE.md](frontend/DEPLOY-CLOUDFLARE.md).

---

## Directory structure

```
soroban/
  Cargo.toml                     # workspace
  contracts/
    registry/                    # per-agent scope registry
    rwa_vault/                   # yield vault + autofarm (shares vfVLT, 7-dp)
    agent_account/               # Soroban custom account (__check_auth)
    funding_router/              # single-signature grant factory
    blend_strategy/              # vault → Blend pool
  # deploy scripts under scripts/soroban/

deployments/
  stellar-testnet.json           # live Stellar testnet addresses
  base-sepolia.json              # optional Base cross-chain leg

frontend/
  wrangler.jsonc                 # Cloudflare Pages runtime config (nodejs_compat)
  DEPLOY-CLOUDFLARE.md           # Pages deployment guide
  .env.example                   # client (VITE_) vars template
  .dev.vars.example              # server-side secrets template (local Functions)
  api/                           # Server-side proxies (Vite dev middleware)
    ai.js                        # DeepSeek AI proxy (key off the client)
    search.js                    # Tavily web-search proxy
    stellar-relay.js             # Soroban fee-bump relay proxy
    _guard.js                    # CORS allowlist + rate limit
    _pagesAdapter.js             # Reuses api/*.js handlers as Pages Functions
  functions/api/                 # Cloudflare Pages Functions (edge wrappers)
  public/
    _routes.json                 # Functions run only on /api/*
    _headers                     # Security headers

frontend/src/
  stellar/                       # Soroban chain client
    client.js                    # RPC + transaction assembly
    config.js                    # addresses, network passphrase, SOROBAN_DECIMALS
    walletKit.js                 # Stellar Wallets Kit (Freighter / xBull / Albedo)
    sessionKey.js                # ephemeral ed25519 session keys
    agentSetup.js                # authorize + fund an agent
    agentDeposit.js              # build + sign + submit a deposit auth entry
    revoke.js                    # user-signed kill switch
    events.js                    # contract event reads (audit trail)
    relay.js                     # fee-bump relay client
    scval.js                     # ScVal <-> JS helpers
    format.js                    # 7-dp display / base-unit helpers
    index.js                     # public surface
  components/
    LandingHero.jsx, NavBar.jsx, HomePage.jsx, AgentDashboard.jsx,
    ExplorerPage.jsx, EcosystemPage.jsx, ReplayPage.jsx, SettingsPage.jsx,
    OnboardingFlow.jsx, SkillDrawer.jsx, SkillDetailModal.jsx, SkillEditModal.jsx,
    WithdrawModal.jsx, VaultDetailPage.jsx, TxDetailPage.jsx, HistoryPanel.jsx,
    RightRail.jsx, SignatureMark.jsx, AgentActionPreview.jsx
  strategy/                      # autonomous decision engine (+ matching *.test.js)
    mdp.js, simulation.js, council.js, councilReview.js,
    gates.js, monitorLoop.js, decisionLog.js, cycleJournal.js,
    curator.js, ruleStore.js, keyVault.js, keyStore.js,
    submitGate.js, permissionScope.js, session.js, fetchDag.js
  orchestrator.js                # OrchestratorAgent — dispatches workers
  worker.js                      # WorkerAgent — single vault flow
  agents/
    agentController.js           # Agent lifecycle
    backgroundAgent.worker.js    # Web Worker — monitor, alerts
  strategist.js                      # AI strategist (Venice / DeepSeek / fallback)
  attestation.js                 # Strategy hash + on-chain attestation
  skills.js / skills.jsx         # Skill file generator + review UI
  defiLlama.js                   # Live yield data
  positionsStore.js              # On-chain position reads + caching
  history.js                     # Transaction + strategy history
  settingsStore.js               # User settings
  config.js                      # vault catalog, model slugs

agents/                          # Runtime-generated, gitignored
  session-{id}/agent-{n}-skills.json
  memory/agent-{n}-memory.json

docs/                            # All in English
```

---

## Documentation (tracked)

| Document | Focus |
|----------|-------|
| [prd.md](prd.md) | Product requirements — canonical feature/status table |
| [GETTING_STARTED.md](GETTING_STARTED.md) | Local setup + demo checklist |
| [DESIGN.md](DESIGN.md) | Design system + UI patterns |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Agent coding instructions |
| [soroban/README.md](soroban/README.md) | Contract build/test |

> Folder `docs/` is **gitignored** (local planning / deep technical notes). Do not link to it as public repo docs.

---

## Resources

- [Stellar Developers](https://developers.stellar.org)
- [Soroban smart contracts](https://developers.stellar.org/docs/build/smart-contracts)
- [Stellar Wallets Kit](https://stellarwalletskit.dev)
- [Freighter wallet](https://www.freighter.app)
- [Blend Capital](https://docs.blend.capital) — real-yield lending (autofarm vault supplies testnet pool)
- [Circle CCTP](https://developers.circle.com/cctp) — optional Stellar↔Base USDC
- [ZeroDev](https://docs.zerodev.app) — optional Base session keys (cross-chain leg)
- [Venice AI](https://venice.ai)
- [DeepSeek API](https://api-docs.deepseek.com)
- [Tavily API](https://docs.tavily.com)
- [Cloudflare Pages](https://developers.cloudflare.com/pages/)
- [DeFiLlama API](https://defillama.com/docs/api)

---

## License

MIT

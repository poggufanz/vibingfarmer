<p align="center">
  <img src="frontend/public/vibing_farmer.logo.png" alt="Vibing Farmer Logo" width="100%" />
</p>

# Vibing Farmer

> Set once. Vibe forever.

Yield farming means the same boring clicks over and over: find a vault, swap into the right token, approve, deposit. Do it again for the next protocol. Vibing Farmer runs all of that in parallel. An AI picks the vaults, generates per-agent instructions, you approve once, and disposable worker keys execute — zero gas on your end.

Built out of frustration with click-heavy sequential DeFi workflows. The thesis: users express intent, agents execute autonomously, and the blockchain enforces boundaries with cryptography — not trust.

## How it works

1. **Strategy** — A privacy-first AI strategist takes your deposit amount, risk tolerance, and vault count, then outputs an allocation plan and a skill JSON per worker agent. The recommended provider is **Venice AI** (uncensored, zero-data-retention), used either by pasting a Venice API key in Settings or via x402 wallet payment (an EIP-4361 SIWE signature with a prepaid USDC balance on Base — not a social login). If neither is configured, it falls back to a DeepSeek server-side proxy so the app works with zero setup. A Monte Carlo simulation runs 200 scenarios over 30 days against the proposed allocation before you commit.

2. **AI Council** — Three AI specialists (yield, risk, market) independently evaluate the proposal. If they disagree, a synthesis call resolves the conflict. The verdict, cited playbook rules, and resolution method are all logged.

3. **Review** — You read and edit the generated skill JSON. Every field is exposed in a slide-out drawer. Nothing executes until you approve.

4. **Smart account upgrade** — One EIP-7702 signature upgrades your MetaMask Flask EOA into a smart account.

5. **Scoped permission** — You sign once: a bounded `IERC20.approve(depositor, totalCap)` plus an `AgentRegistry.authorizeSessionKey` call per worker. Each scope records: vault, token, per-period cap, period duration, and expiry (max 30 days). Deposits require an EIP-712 message signed by the worker key — authorization lives in the signature, not `msg.sender`, so any submitter (the 1Shot relayer or your own RPC) can broadcast it.

6. **Parallel execution** — `OrchestratorAgent` dispatches N `WorkerAgent` instances via `Promise.allSettled`. Each does Swap, Approve, Deposit through the 1Shot EIP-7710 relayer. Zero gas for the user.

7. **Strategy attestation** — The AI strategy output gets hashed (keccak256) and written on-chain via `AgentVaultDepositor.attestStrategy`. Anyone can reproduce the hash from the original JSON.

8. **Autonomous monitor loop** — A background Web Worker polls positions, detects APY drift, surfaces risk alerts, and proposes rebalances. A TradingAgents-style council reviews each cycle. An ACE Curator grows, merges, and prunes playbook rules from notable outcomes. Cycle journals and decision logs are stored in localStorage and surfaced in the Agent Dashboard.

9. **Kill switch** — User-signed `AgentRegistry.revokeAgent` (or batch `revokeMany`) works even when the relayer is down. Revocation is instant and on-chain.

---

## Architecture

```
User input (amount, risk level, vault count)
                |
                v
        AI strategist (Venice AI — key or x402; DeepSeek proxy fallback)
          |-- Multi-vault allocation + live DeFiLlama data
          |-- Skill JSON per agent (swap + deposit constraints)
          |-- MDP state: turbulence regime, gas snapshot
                |
                v
        Monte Carlo sim (200 runs, 30d)
        AI Council (yield + risk + market specialists)
                |
                v
        User reviews skills -> approves
                |
                v
        OrchestratorAgent --- attestStrategy on-chain
          |
    +-----+-----+
    v     v     v
 Worker Worker Worker   (one per vault, parallel)
   AgentRegistry scope + EIP-712 signed deposits
   1Shot EIP-7710 relay (zero gas)
   AgentVaultDepositor.sol
   MockVault.sol (ERC-4626)
                |
                v
        Autonomous Monitor Loop (Web Worker)
          Council review each cycle
          ACE Curator (playbook evolution)
          Cycle journal + decision log
```

---

## Deployed contracts — Base Sepolia (84532)

| Contract | Address |
|----------|---------|
| AgentRegistry | `0x1f5eb2613585c439d9877CA4b99439f7d06bA4AA` |
| AgentVaultDepositor | `0xbf2091Fe26183369ae9f0Ba4735190F5fec7686c` |
| MockVault (ERC-4626, asset = USDC) | `0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC` |
| USDC (Circle testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Verify on Basescan: `https://sepolia.basescan.org/address/<address>`

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Smart contracts | Solidity ^0.8.24, OpenZeppelin, Foundry |
| Frontend | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d |
| Web3 | MetaMask Smart Accounts Kit v1.6.0, Viem v2, ethers.js v6 |
| AI | **Venice AI** (`zai-org-glm-5-1`) — recommended, via API key or x402 wallet payment (SIWE, prepaid USDC on Base); DeepSeek (`deepseek-v4-flash`) server-side proxy as zero-config fallback |
| Live yield data | DeFiLlama API — APY, TVL, 7-day history |
| Web search | Tavily API (server proxy) — live DeFi context for strategy prompts |
| Gas abstraction | 1Shot Managed API — EIP-7710 relayer via server proxy, auto-provisioned Base Sepolia server wallet |
| Wallet | MetaMask Flask 13.9+ (EIP-7702 smart account) |
| Crypto | libsodium — KDF-sealed per-worker key vault |
| Validation | Zod schemas at boundaries |
| Network | Base Sepolia (chain 84532) |
| Hosting | Cloudflare Pages — static SPA + `/api/*` Pages Functions (edge) |
| CI | GitHub Actions — contracts (unit + Slither + nightly fork) + frontend (lint, Vitest, build) |
| Lint/format | ESLint 9 flat config + Prettier |
| Test runner | Forge (contracts), Vitest (frontend) |

---

## Contracts

Three Solidity files:

- **AgentRegistry.sol** — single source of truth for per-agent deposit scope. `authorizeSessionKey` sets vault, token, cap-per-period, period duration, expiry. `rollAndSpend` charges each deposit against the cap, rolling the fixed window if elapsed. `revokeAgent` / `revokeMany` are instant user-signed kill switches.

- **AgentVaultDepositor.sol** — deposit-only execution. Recovers the worker key from an EIP-712 signature, reads scope from AgentRegistry, pulls tokens via `transferFrom`, deposits into the ERC-4626 vault, credits shares to the user. No custody — the contract holds zero tokens at rest.

- **MockVault.sol** — plain ERC-4626 wrapper around USDC with a configurable `apyBps` for demo purposes.

### Contract security

The depositor reverts on every violation:

- Amount exceeds period cap -> `CapExceeded`
- Vault or token mismatch -> `ScopeInactive`
- Expired scope -> `ScopeInactive`
- Revoked agent -> `ScopeInactive`
- Checks-Effects-Interactions order throughout
- `ReentrancyGuard` on `executeAgentDeposit`
- Zero custody: zero-custody invariant tested under stateful fuzz

---

## Test suite

| Category | File(s) | What it covers |
|----------|---------|----------------|
| Unit | `AgentVaultDepositor.t.sol`, `AgentRegistry.t.sol`, `MockVault.t.sol` | Happy paths, permission violations, edge cases, ERC-4626 compliance |
| Invariant | `DepositorInvariant.t.sol` + `Handler.sol` | Cap and reserves invariants under stateful fuzz |
| Security | `Destructive.t.sol` | Stolen-key, revoke-after-deposit, no-scope drills (live on Base Sepolia) |
| Integration | `MorphoForkTest.t.sol` | Real Morpho vault fork flow + 4626 edge cases |
| Simulation | `TimelineReplay.t.sol` | Mainnet fork depeg swaps replayed to JSON |
| Pause safety | `PauseInvariant.t.sol` | Pause never traps user funds (atomic-flow invariant) |
| Zero custody | `ZeroCustody.t.sol` | Worker holds nothing after execution |

Frontend tests (Vitest): orchestrator, worker, relay, skills, positions store, wallet, Venice AI, council, simulation, MDP, gates, monitor loop, decision log, playbook, curator, and more (28 `*.test.js` files in `frontend/src/strategy/`).

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
| `/ecosystem` | Tech-stack reference — MetaMask, Venice AI, 1Shot, DeFiLlama |
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
| `gates.js` | Pre-submit circuit breaker: gas freshness, economic, rate limits |
| `monitorLoop.js` | Never-stop autonomous loop: observe, gate, simulate, council, execute, reflect |
| `decisionLog.js` | Persistent decision audit trail |
| `cycleJournal.js` | Cycle-level journal (pass/fail, action taken, reward) |
| `curator.js` | ACE Curator — grows playbook rules from notable outcomes |
| `ruleStore.js` | Playbook persistence (seeds, growth, merge, prune) |
| `keyVault.js` | KDF-sealed per-worker key derivation |
| `submitGate.js` | Gas-freshness + economic + rate-limit gate |
| `permissionScope.js` | Single-source scope builder |
| `session.js` | Grant persistence and rehydration |
| `fetchDag.js` | Parallel data-fetch DAG with timing telemetry |

---

## Skill system

The AI strategist generates a typed skill file per agent:

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC",
  "skills": {
    "swap": { "maxSlippage": 0.5, "dexPreference": "uniswap-v3", "maxRetries": 2, "timeoutSeconds": 30 },
    "deposit": { "maxAmount": "100000000", "vaultAddress": "0xDff3...", "expiresAt": 1749686400 }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

Every field is editable in the Skills Drawer before approval. A vault-advisor system prompt (`frontend/src/skills/vault-advisor.md`) governs the AI's allocation reasoning. Users can swap in custom skill files.

---

## Prerequisites

- [MetaMask Flask 13.9+](https://metamask.io/flask/) — not regular MetaMask. Required for EIP-7702 + ERC-7715.
- Base Sepolia ETH for direct user-signed transactions (permission grants, attestation, withdraws)
- Base Sepolia USDC — bridged from Sepolia or via faucet

---

## Quick start

```bash
cp .env.example .env
# fill in VITE_RPC_URL, plus DEEPSEEK_API_KEY for the zero-config fallback proxy
# Venice AI (recommended) needs no .env key — users either paste a Venice API key
# in Settings (https://venice.ai/settings/api), or use x402 wallet payment (an
# EIP-4361 SIWE signature + prepaid USDC balance on Base — not a social login)

cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and connect MetaMask Flask.

---

## Environment variables

**Contracts / deploy (`.env` — see `.env.example`):**

```env
BASE_SEPOLIA_RPC=https://sepolia.base.org        # public default; Alchemy/QuickNode for higher limits
PRIVATE_KEY=0x...                                # deployer — never commit
ETHERSCAN_API_KEY=...                            # contract verification
MAINNET_RPC=...                                  # historical-replay fork tests
BASE_MAINNET_RPC=...                             # Morpho real-vault fork test
```

**API proxies (server-side — see `frontend/.dev.vars.example`; never bundled to the client):**

```env
DEEPSEEK_API_KEY=sk-...                          # /api/ai — fallback AI proxy (Venice is the recommended provider)
TAVILY_API_KEY=tvly-...                          # /api/search — optional live market context
ONESHOT_KEY=...                                  # /api/relay — 1Shot Managed API (key + secret + biz id)
ONESHOT_SECRET=...
ONESHOT_BIZ_ID=...
AGENT_VAULT_DEPOSITOR_ADDRESS=0x...              # must match src/config.js
ALLOWED_ORIGIN=https://your-project.pages.dev    # /api/* origin allowlist (prod)
RPC_URL=https://sepolia.base.org                 # optional — on-chain replay/code checks
```

**Client (build-time, `VITE_` prefix — inlined into the public bundle):**

```env
VITE_RPC_URL=https://sepolia.base.org            # read-only public client RPC
```

---

## Smart contract commands (WSL only)

Foundry runs in WSL. Never run `forge`/`cast`/`anvil` in PowerShell.

```bash
# Build
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge build"

# Unit tests (excludes fork tests)
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --no-match-contract Fork -vv"

# Fork tests only
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract Fork -vv"

# Coverage
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge coverage"

# Deploy to Base Sepolia
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge script script/Deploy.s.sol --rpc-url \$BASE_SEPOLIA_RPC --broadcast --verify"
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

**`.github/workflows/contracts.yml`** — Solidity:

- **unit** — `forge test --no-match-contract Fork` on every push/PR
- **slither** — static analysis (soft-fail, will promote to hard gate after Phase 5)
- **fork-nightly** — nightly scheduled fork tests against mainnet RPCs

**`.github/workflows/frontend.yml`** — frontend (push/PR on `main`, `iq`):

- **lint** — `npm run lint` (ESLint, soft-fail)
- **test** — `npm test` (Vitest)
- **build** — `npm run build` (Vite production build)

---

## Deployment — Cloudflare Pages

The frontend ships as a Cloudflare Pages app: the Vite SPA (`dist/`) served from the
edge, and the `/api/{ai,search,relay}` proxies running as Pages Functions. Local Vite
dev is unchanged — it reuses the same `api/*.js` handlers as middleware.

```bash
cd frontend
npm run pages:dev      # local: vite build + wrangler pages dev
npm run pages:deploy   # deploy (run `wrangler login` first)
```

Set the server-side secrets (`DEEPSEEK_API_KEY`, `ONESHOT_*`, `ALLOWED_ORIGIN`, …) in
the Pages dashboard. Full guide: [frontend/DEPLOY-CLOUDFLARE.md](frontend/DEPLOY-CLOUDFLARE.md).

---

## Directory structure

```
contracts/
  AgentRegistry.sol              # On-chain per-agent deposit scope
  AgentVaultDepositor.sol        # Deposit-only execution, EIP-712 auth
  MockVault.sol                  # ERC-4626 mock vault

test/
  AgentVaultDepositor.t.sol      # Unit tests
  AgentRegistry.t.sol            # Registry unit tests
  MockVault.t.sol                # ERC-4626 compliance
  PauseInvariant.t.sol           # Pause never traps funds
  ZeroCustody.t.sol              # Worker holds nothing
  integration/
    MorphoForkTest.t.sol         # Real vault fork flow
  invariant/
    DepositorInvariant.t.sol     # Stateful fuzz — cap + reserves
    Handler.sol                  # Fuzz handler
  security/
    Destructive.t.sol            # Stolen-key / revoke drills
  simulation/
    TimelineReplay.t.sol         # Mainnet depeg replay

script/
  Deploy.s.sol                   # Deploys AgentRegistry + AgentVaultDepositor + MockVault

deployments/
  base-sepolia.json              # Live deployment addresses

frontend/
  wrangler.jsonc                 # Cloudflare Pages runtime config (nodejs_compat)
  DEPLOY-CLOUDFLARE.md           # Pages deployment guide
  .dev.vars.example              # Server-side secrets template (local Functions)
  api/                           # Server-side proxies (Vite dev middleware)
    ai.js                        # DeepSeek AI proxy (key off the client)
    search.js                    # Tavily web-search proxy
    relay.js                     # 1Shot Managed API relay proxy
    _guard.js                    # CORS allowlist + rate limit
    _pagesAdapter.js             # Reuses api/*.js handlers as Pages Functions
  functions/api/                 # Cloudflare Pages Functions (edge wrappers)
  public/
    _routes.json                 # Functions run only on /api/*
    _headers                     # Security headers

frontend/src/
  components/
    LandingHero.jsx              # Scroll-driven landing
    NavBar.jsx                   # Shared navigation
    HomePage.jsx                 # Portfolio, Market Pulse, alerts
    AgentDashboard.jsx           # Agent status, revoke UI, loop panels
    ExplorerPage.jsx             # On-chain verification (no wallet)
    EcosystemPage.jsx            # Tech-stack reference
    ReplayPage.jsx               # Historical timeline replay
    SettingsPage.jsx             # Full settings
    OnboardingFlow.jsx           # First-time onboarding
    FlaskGate.jsx                # MetaMask Flask version gate
    SkillDrawer.jsx              # Skill viewer + editor
    SkillDetailModal.jsx         # Skill detail modal
    SkillEditModal.jsx           # Skill edit modal
    WithdrawModal.jsx            # User-signed ERC-4626 withdraw
    VaultDetailPage.jsx          # Per-vault view
    TxDetailPage.jsx             # Transaction detail
    HistoryPanel.jsx             # History panel
    RightRail.jsx                # Wallet, permissions, activity, skills panels
    SignatureMark.jsx            # Signature verification mark
    AgentActionPreview.jsx       # Agent action preview card
  strategy/                      # 56 files — autonomous decision engine
    mdp.js, simulation.js, council.js, councilReview.js,
    gates.js, monitorLoop.js, decisionLog.js, cycleJournal.js,
    curator.js, ruleStore.js, keyVault.js, keyStore.js,
    submitGate.js, permissionScope.js, session.js, fetchDag.js,
    gasSnapshot.js, gasFeeProvider.js, grantStore.js, seeds.js,
    playbook.js, playbookRules.js, prune.js, merge.js,
    reflector.js, rehydrate.js, rng.js, outcome.js
    + matching *.test.js for each
  orchestrator.js                # OrchestratorAgent — dispatches workers
  worker.js                      # WorkerAgent — single vault flow
  agents/
    agentController.js           # Agent lifecycle
    backgroundAgent.worker.js    # Web Worker — monitor, alerts
  venice.js                      # Venice AI + DeepSeek: strategy + skills
  relay.js                       # 1Shot EIP-7710 relay
  wallet.js                      # EIP-7702 + ERC-7715 + MetaMask SAK
  attestation.js                 # Strategy hash + on-chain attestation
  skills.js                      # Skill file generator
  skills.jsx                     # Skill review UI
  defiLlama.js                   # Live yield data
  positionsStore.js              # On-chain position reads + caching
  history.js                     # Transaction + strategy history
  settingsStore.js               # User settings
  config.js                      # Addresses, ABIs, vault catalog
  readProvider.js                # Dedicated read-only provider
  redelegation.js                # Re-delegation logic
  flaskDetect.js                 # MetaMask Flask detection
  skillLoader.js                 # Skill file loader
  marketSearch.js                # Market search
  sparkline.js                   # APY sparkline renderer
  motion.js                      # Framer Motion helpers

agents/                          # Runtime-generated, gitignored
  session-{id}/
    agent-{n}-skills.json
  memory/
    agent-{n}-memory.json

docs/
  technical-architecture.md
  technical-blockchain-usage.md
  technical-security-privacy.md
  technical-threat-model.md
  technical-api-events.md
  technical-database.md
  product-demo-scenario.md
  product-features-complete.md
  product-user-stories.md
  business-impact-model.md
  business-roadmap-backlog.md
  PLAN-REVIEW-FINDINGS.md
  spikes/                        # All 4 spikes resolved
```

---

## Documentation

| Document | Focus |
|----------|-------|
| [technical-architecture.md](docs/technical-architecture.md) | System design, ADRs, NFRs, failure modes |
| [technical-blockchain-usage.md](docs/technical-blockchain-usage.md) | On-chain scope, audit trail, delegation boundaries |
| [technical-security-privacy.md](docs/technical-security-privacy.md) | Threat model, security controls |
| [technical-threat-model.md](docs/technical-threat-model.md) | Max-loss numbers, key lifecycle, destructive drill results |
| [technical-api-events.md](docs/technical-api-events.md) | Event schemas, payloads, error handling |
| [technical-database.md](docs/technical-database.md) | Agent memory, local storage, retention |
| [product-demo-scenario.md](docs/product-demo-scenario.md) | Demo walkthrough and script |
| [product-features-complete.md](docs/product-features-complete.md) | Functional requirements, MoSCoW priority |
| [product-user-stories.md](docs/product-user-stories.md) | Personas, journeys, acceptance criteria |
| [business-impact-model.md](docs/business-impact-model.md) | Market problem, value model, KPIs |
| [business-roadmap-backlog.md](docs/business-roadmap-backlog.md) | Roadmap, milestones, risk |

---

## Resources

- [MetaMask Smart Accounts Kit](https://docs.metamask.io/wallet/smart-accounts/)
- [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)
- [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715)
- [1Shot API](https://1shotapi.com/docs)
- [Venice AI](https://venice.ai)
- [DeepSeek API](https://api-docs.deepseek.com)
- [Tavily API](https://docs.tavily.com)
- [Cloudflare Pages](https://developers.cloudflare.com/pages/)
- [DeFiLlama API](https://defillama.com/docs/api)

---

## License

MIT

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Vibing Farmer

**Tagline:** "Set once. Vibe forever."  
**Motivation:** Built out of frustration with complex, click-heavy sequential yield farming workflows.  
**Goal:** Autonomous, parallel multi-agent deposits under cryptographic scope bounds — user signs once, agents execute gas-free.

**Core product (live):** AI-coordinated agent swarm for automated yield farming on **Stellar/Soroban (testnet primary)**. AI strategist (DeepSeek default / Venice AI via x402+SIWE / deterministic fallback) + multi-perspective AI council generates strategy and per-agent skills. User signs **one** wallet signature (`funding_router.grant` — budget + expiry). Router deploys fresh scoped `agent_account`s; workers sign deposits with ephemeral ed25519 session keys; **own fee-bump relay** (`/api/stellar-relay`) sponsors gas. Autofarm vault supplies into **Blend Capital v2** (real testnet lending yield). Optional cross-chain leg: Stellar USDC → Circle CCTP v2 → Base Sepolia via **own Node relayer + ZeroDev session keys** (not 1Shot). Force-graph UI monitors agents and memory.

> **1Shot is superseded.** The EVM-era 1Shot Managed/Permissionless relayer was removed with the EVM stack (2026-06-21). Gas abstraction is **own Stellar fee-bump** + (optional Base) **ZeroDev**. Do not reintroduce `@uxly/1shot-client` or `ONESHOT_*` env vars.

> **Note:** Product requirements: [`prd.md`](prd.md). Design system: [`DESIGN.md`](DESIGN.md). Human onboarding: [`README.md`](README.md). Folder `docs/` is **gitignored** (local-only); do not assume it is in the public tree.

---

## Core Architecture Focus

| Component | Technical Choice | Purpose |
|-----------|------------------|---------|
| Smart Swarm | Multi-agent skill system + per-run agent accounts | Granular delegation + local memory |
| AI Strategist | DeepSeek default, Venice x402/SIWE, hardcoded fallback | Strategy + skill generation |
| Council / gates | Council debate + fail-closed eligibility (DeFiLlama + curated facts) | Risk before execution |
| single-signature grant | `funding_router` (SEP-41 allowance = leash) | 1 signature first run / 0 repeat |
| Gas abstraction | Own fee-bump relay (`/api/stellar-relay`, allowlist) | Zero XLM for the user |
| Yield | Autofarm vault → Blend v2 pool (testnet) | Real lending interest (not mock drip) |
| Cross-chain (optional) | CCTP v2 + Node relayer + ZeroDev CallPolicy | Stellarâ†”Base USDC exposure |
| Emergency | Lifeboat radar + vault `emergency_derisk` / `resume` | Ledger-speed de-risk under mandate |

---

## Current Phase

| Phase | Focus | Status |
|-------|--------|--------|
| 1 — Foundation (EVM) | Registry + depositor + 1Shot relay | âœ… superseded |
| 2 — Stellar migration | Full Soroban rebuild, EVM decommissioned | âœ… |
| 3 — Real yield + autonomy | Blend, autofarm vault, keeper, lifeboat | âœ… |
| 4 — Cross-chain + wallets | CCTP v2, passkey wallets, YieldRouter | âœ… |
| 5 — Hardening + single-signature grant | No-mock testnet hardening, `funding_router` | âœ… |
| 6 — Publish | Deploy, relayer VM, demo, open source | ðŸ”¨ |

---

## Core Architecture (live)

```
User Input (amount, risk, # agents / vaults)
        â”‚
        â–¼
AI Strategist (Venice x402/SIWE → DeepSeek /api/ai → equal-split fallback)
  + Council review + eligibility gate (fail-closed)
        â”‚
        â–¼
User reviews skills → approves
        â”‚
        â–¼
ONE wallet signature: funding_router.grant (budget + expiry + deploy N agents)
        â”‚
        â–¼
Orchestrator dispatches Workers (parallel, Promise.allSettled)
   â”Œâ”€â”€â”€â”€â”¼â”€â”€â”€â”€â”
   â–¼    â–¼    â–¼
Worker…  (session key = agent signer)
  â”‚ router.pull (relayed) → vault.deposit (auth entry + fee-bump)
  â””â”€â”€â–º autofarm vault → Blend strategy / pool
        â”‚
        â–¼
Keeper cron (compound/rebalance) · Lifeboat radar (derisk)
Memory (localStorage) + react-force-graph-2d
```

**Optional `/farm` cross-chain:** Stellar USDC burn (CCTP) → Node relayer → Base `YieldRouter` → ERC-4626 pools via ZeroDev session key. Unwind reverses the path.

---

## Directory Structure (high signal)

```
soroban/contracts/     # funding_router, agent_account, autofarm_vault, blend_strategy, registry, attestation
frontend/src/stellar/  # Soroban client, session keys, relay client, wallet kit
frontend/api/          # stellar-relay, ai, search, faucet, vf-cross, vf/*
frontend/src/          # orchestrator, worker, strategist.js (AI multi-provider), strategy/*, components
relayer/               # Node CCTP + Base/ZeroDev cross-chain relayer
keeper/                # Lifeboat radar runner
base-contracts/        # YieldRouter, AaveV3Adapter4626 (Base leg)
deployments/           # stellar-testnet.json, base-sepolia.json
prd.md                 # Product requirements (source of truth for product claims)
```

---

## Commands

### Smart Contracts (Soroban — Rust, WSL only)

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy --all-targets -- -D warnings"
```

Deploy/seed: `scripts/soroban/deploy-seed.sh` (and related). Addresses: `deployments/stellar-testnet.json`.

> âš ï¸ Run `cargo`/`stellar` under `wsl -e bash -lc`, never PowerShell-native.

**Lifeboat radar** (plain Node, not WSL):

```bash
cd keeper && node --env-file=.dev.vars src/radar-runner.mjs
```

### Frontend

```bash
cd frontend && npm run dev
cd frontend && npm test
cd frontend && npm run build
```

### Environment (server-side — never `VITE_` for secrets)

```bash
# frontend/.dev.vars (Pages Functions) / Cloudflare env
DEEPSEEK_API_KEY=...              # optional BYOK-first host key
TAVILY_API_KEY=...
ALLOWED_ORIGIN=https://your-app.pages.dev
STELLAR_RELAYER_SECRET=S...       # fee-bump sponsor
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CDWHNHIH... # autofarm vault — see deployments/stellar-testnet.json
SOROBAN_ROUTER_ADDRESS=CCEWWRQV... # funding_router
```

No `ONESHOT_KEY` / `ONESHOT_SECRET` — those are dead EVM-era vars.

---

## User Flow (product)

1. Connect Stellar wallet (Freighter / xBull / Albedo / VF Wallet).
2. Input amount, risk, agent count → AI + council + eligibility gate.
3. Review/edit skills → approve.
4. **a single signature:** `funding_router.grant` (budget + expiry; deploys agents).
5. Workers: `pull` + `deposit` via session keys + fee-bump relay (0 gas).
6. Vault supplies Blend; keeper compounds; radar can derisk under mandate.
7. Graph + memory update; revoke = `approve(router, 0)` or agent revoke.

---

## Key Implementation Notes

- **Gas:** `/api/stellar-relay` fee-bumps allowlisted ops only (vault deposit/redeem, router grant/pull, pinned wasm, allowlisted transfers). Fail-closed.
- **Parallel agents:** `Promise.allSettled` so one failure does not abort others.
- **Scope:** on-chain `__check_auth` + SEP-41 allowance expiry; not EIP-712/1Shot.
- **Primary chain:** Stellar testnet. Base is optional cross-chain only.
- **Demo agent** (`SOROBAN_DEMO_AGENT`) may still appear as a seeded address for smoke/explorer defaults — prefer session agents from the grant path for product flows.

---

## Key Docs (tracked)

- [prd.md](prd.md) — product requirements (canonical product claims)
- [README.md](README.md) — human onboarding + architecture overview
- [DESIGN.md](DESIGN.md) — design system / UI
- [GETTING_STARTED.md](GETTING_STARTED.md) — setup checklist
- [deployments/stellar-testnet.json](deployments/stellar-testnet.json) — live addresses
- Stellar: https://developers.stellar.org · Blend: https://docs.blend.capital · CCTP: https://developers.circle.com/cctp · ZeroDev: https://docs.zerodev.app

## graphify

If `graphify-out/graph.json` exists, prefer `graphify query` / `path` / `explain` for codebase questions. After code changes, `graphify update .` keeps the graph current.

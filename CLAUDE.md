# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Vibing Farmer

**Tagline:** "Set once. Vibe forever."  
**Motivation:** Built out of frustration with complex, click-heavy sequential yield farming workflows.
**Goal:** Empower users with autonomous, parallel multi-vault deposits governed by secure cryptographic boundaries.

**Core product:** AI-coordinated agent swarm for automated multi-vault yield farming on Base Sepolia. AI strategist (DeepSeek default / Venice AI via wallet x402+SIWE / hardcoded fallback) generates strategy + per-agent skill sets. User approves once, batching one EIP-712 `authorizeSessionKey` grant per agent on `AgentRegistry`. Orchestrator dispatches Worker agents in parallel — each signs an EIP-712 deposit and relays it via 1Shot Managed API to the deposit-only `AgentVaultDepositor` (no on-chain swap). Real-time react-force-graph-2d graph monitors agent network and memory.

**Vision:** Web3 → Web4 transition primitive. Users express intent, agents execute autonomously, blockchain enforces boundaries cryptographically.

> **Note:** All docs in `docs/` are written in English.

---

## Core Architecture Focus

| Component | Technical Choice | Purpose |
|-----------|------------------|---------|
| Smart Swarm | Multi-agent skill system | Granular agent delegation + local memory |
| AI Strategist | DeepSeek default, Venice AI x402/SIWE, hardcoded fallback | Strategy and per-agent skill auto-generation |
| Agent-to-Agent | Orchestrator & parallel Workers | Parallel execution for optimal DeFi UX |
| Gas Abstraction | 1Shot Managed API relay + EIP-712 agent scope | Zero-gas transactions under capped/expiring boundaries |

---

## Current Phase

Timeline: 20 days total (26 Mei – 15 Juni 2026)

| Phase | Days | Status | Focus |
|-------|------|--------|-------|
| 1 — Foundation | 1–3 | ✅ Done | Solidity review + setup + spike review |
| 2 — Smart Contract | 4–8 | ✅ Done | AgentRegistry.sol + AgentVaultDepositor.sol + tests |
| 3 — Integration | 9–13 | ✅ Done | 1Shot Managed API + Orchestrator/Worker agents + force-graph + Base Sepolia test |
| 4 — Polish | 14–17 | ✅ Done | Bug fix, AI skill gen, memory UI, Monte Carlo/replay/attestation, demo video |
| 5 — Publish | 18–20 | ⬜ | Open source publishing |

> **EVM decommissioned 2026-06-21 (sub-project 6).** The Solidity stack, the EVM frontend chain-layer, and the ethers/viem/1Shot dependencies were removed. Vibing Farmer is now **single-chain on Stellar/Soroban** — chain code lives in `soroban/` (contracts) and `frontend/src/stellar/` (client). The architecture, ADR, contract, and user-flow sections below describe the original EVM design and are retained as **migration history** — for the live system read `soroban/` + `frontend/src/stellar/` and `deployments/stellar-testnet.json`.

**All 4 original spikes resolved — see `docs/spikes/` (historical; some superseded by ADRs below, e.g. ERC-7715 → AgentRegistry, Venice-only → DeepSeek/Venice/fallback chain).**

## Planning Rules

- Planning files (`planning/`, `docs/superpowers/`) are **never committed** — both folders are in `.gitignore`
- Per-phase plans live locally only (not in repo)
- Only phase status table above is updated in this file as phases complete

---

## Core Architecture

```
User Input (amount, risk level, # of vaults)
        │
        ▼
AI Strategist (DeepSeek default → Venice x402/SIWE → hardcoded fallback)
  ├── Generate multi-vault allocation strategy
  └── Auto-generate skill set per agent (deposit cap, expiry)
        │
        ▼
User Reviews + Edits Generated Skills (UI)
        │
        ▼
Orchestrator (JavaScript, frontend)
  ├── Receives plan from AI strategist
  ├── Batches user-signed authorizeSessionKey per agent (AgentRegistry)
  ├── Dispatches Worker agents in PARALLEL
  └── Aggregates results + memory
        │
   ┌────┼────┐
   ▼    ▼    ▼
Worker  Worker  Worker   (one per vault, parallel)
Agent1  Agent2  AgentN
  │ Holds ephemeral session key (= on-chain "agent")
  │ Signs EIP-712 AgentDeposit within granted scope
  │ Via: 1Shot Managed API relay
  └──► AgentVaultDepositor.sol (Base Sepolia, deposit-only)
              ├──► validates scope via AgentRegistry
              └──► MockVault.sol (ERC-4626)
        │
        ▼
Agent Memory Files (JSON, per agent per session)
        │
        ▼
react-force-graph-2d (real-time, browser)
  ├── Nodes: Orchestrator + Workers + Vaults
  ├── Edges: dependencies + communication
  └── Click node → agent detail + memory entries
```

---

## Skill System

Each agent has a **skill set** — a JSON file defining allowed actions:

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC",
  "skills": {
    "deposit": {
      "maxAmount": "100000000",
      "vaultAddress": "0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "ai-strategist",
  "approvedByUser": true
}
```

AI strategist (DeepSeek/Venice/fallback) auto-generates skills per agent. User reviews/edits before execution. No swap skill — agents are deposit-only.

---

## Memory System

Each agent writes a memory file after execution:

```json
{
  "agentId": "worker-agent-1",
  "sessionId": "session-20260614-001",
  "vault": "0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC",
  "entries": [
    {
      "timestamp": 1748387200,
      "step": "deposit",
      "status": "success",
      "gasUsed": 45000,
      "sharesReceived": "100023456",
      "executionTimeMs": 4200,
      "lesson": "Vault accepted full deposit within cap"
    }
  ]
}
```

Memory stored as `agents/memory/agent-{n}-memory.json`. Displayed in react-force-graph-2d node detail. Read on next execution for context.

---

## Directory Structure

```
contracts/
  AgentRegistry.sol                  # EIP-712 per-agent scope: authorizeSessionKey/revokeAgent/scopeOf
  AgentVaultDepositor.sol            # Deposit-only — recovers EIP-712 signer, validates scope, holds no funds
  MockVault.sol                      # ERC-4626 mock vault for Base Sepolia demo

test/
  AgentRegistry.t.sol
  AgentVaultDepositor.t.sol
  MockVault.t.sol
  PauseInvariant.t.sol
  ZeroCustody.t.sol
  integration/ invariant/ mocks/ security/ simulation/

script/
  Deploy.s.sol                       # Deploys AgentRegistry + AgentVaultDepositor + MockVault

frontend/                            # React 18 + Vite 5 + React Router 6
  functions/                         # Cloudflare Pages Functions (/api/*)
  src/
    app.jsx, router.js               # App shell + routes
    orchestrator.js                  # Orchestrator: plan dispatch, session-key batching
    worker.js                        # Worker: ephemeral key, EIP-712 deposit, keyVault/keyStore
    skills.js, skills.jsx            # Skill generation + editor UI
    memory.js                        # Memory reader/writer + UI
    venice.js                        # AI strategist: DeepSeek/Venice/fallback chain
    x402.js                          # Venice wallet-funded inference (x402 + SIWE)
    wallet.js                        # Wallet connect, SIWE signing
    relay.js                         # 1Shot Managed API relay
    redelegation.js, attestation.js  # Scope re-delegation, on-chain strategy attestation
    config.js                        # Model slugs, addresses
    components/, screens.jsx         # UI screens + components
    strategy/                        # Monte Carlo, MDP/FinRL, council, curator, historical replay (58 files)
    agents/, skills/                 # Runtime-generated skill + memory files

deployments/
  base-sepolia.json                  # Deployed contract addresses

docs/                                # All in English
  technical-architecture.md
  technical-blockchain-usage.md
  technical-security-privacy.md
  technical-threat-model.md
  technical-api-events.md
  technical-database.md
  product-demo-scenario.md            # Demo script — read before recording
  product-features-complete.md
  product-user-stories.md
  business-impact-model.md
  business-roadmap-backlog.md
  PLAN-REVIEW-FINDINGS.md
```

---

## Commands

### Smart Contracts (Soroban — Rust, WSL only)

```bash
# Build all contracts to wasm
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"

# Test all
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

# Single test verbose
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test test_name -- --nocapture"

# Clippy (lint — treat warnings as errors)
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo clippy --all-targets -- -D warnings"

# Deploy to testnet — see soroban/deploy-seed.sh (deploys registry + vault + token, seeds the demo agent)
```

> ⚠️ **Soroban tooling runs in WSL only.** Run `cargo`/`stellar` under `wsl -e bash -lc`, never directly in PowerShell. Deployed addresses live in `deployments/stellar-testnet.json`.

### Frontend

```bash
# Dev server (Vite)
cd frontend && npm run dev

# Run tests
cd frontend && npm test

# Build
cd frontend && npm run build
```

### Environment Variables

Copy `frontend/.env.example` → `.env.local` (Vite dev) and `frontend/.dev.vars.example` → `.dev.vars` (Cloudflare Pages dev) before API testing or deployment:

```bash
# Server-side (Cloudflare Pages env vars / .dev.vars, NOT VITE_ prefixed)
DEEPSEEK_API_KEY=...                    # optional host AI key (BYOK-first; leave unset for lockdown)
TAVILY_API_KEY=...                      # optional, live market context
ALLOWED_ORIGIN=https://your-app.pages.dev

# Soroban gasless relay (read by /api/stellar-relay)
STELLAR_RELAYER_SECRET=S...             # relayer keypair secret, server-only — fund on testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CCDXZ6BU...       # deposit target (see deployments/stellar-testnet.json)
```

The Soroban relay fee-bumps agent transactions from a funded `STELLAR_RELAYER_SECRET` keypair — the user pays 0 gas. AI keys are BYOK-first (users paste their own in Settings); leave host keys unset for a lockdown deploy.

---

## Smart Contracts: AgentRegistry.sol + AgentVaultDepositor.sol

```solidity
// AgentRegistry — one agent key = one scope, forever (re-scope = new key)
struct AgentScope {
    address owner;
    address vault;
    address token;
    uint96  capPerPeriod;
    uint32  periodDuration;
    uint96  spentInPeriod;
    uint40  periodStart;
    uint40  expiry;
    bool    revoked;
}
mapping(address agent => AgentScope) public scopes;

event AgentAuthorized(address indexed owner, address indexed agent, address vault, address token, uint96 capPerPeriod, uint32 periodDuration, uint40 expiry);
event AgentRevoked(address indexed owner, address indexed agent);

function authorizeSessionKey(...) external;   // owner signs, grants scope to ephemeral agent key
function revokeAgent(address agent) external;
function scopeOf(address agent) external view returns (AgentScope memory);

// AgentVaultDepositor — deposit-only, holds no funds, recovers signer = agent
bytes32 public constant DEPOSIT_TYPEHASH =
    keccak256("AgentDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");

event AgentDepositExecuted(
    address indexed agent, address indexed owner, address indexed vault,
    address token, uint256 assetsIn, uint256 sharesOut, bytes32 execId
);

function hashDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) public view returns (bytes32);
function executeAgentDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes calldata sig)
    external returns (uint256 shares);
```

---

## User Flow

1. Connect wallet (standard EOA)
2. User inputs: amount, risk level, number of vaults
3. AI strategist (DeepSeek default / Venice x402+SIWE / hardcoded fallback) generates multi-vault strategy + skill set per agent
4. User reviews skills in UI → edits if needed → approves
5. Orchestrator batches one user-signed `authorizeSessionKey` per agent on `AgentRegistry` (capped + expiring scope)
6. Orchestrator dispatches N Worker agents in parallel
7. Each Worker: signs EIP-712 `AgentDeposit` with its ephemeral key → relays via 1Shot Managed API → `AgentVaultDepositor.executeAgentDeposit`
8. Depositor recovers signer, validates scope via `AgentRegistry.scopeOf`, deposits to `MockVault` (ERC-4626), emits `AgentDepositExecuted`
9. Events update react-force-graph-2d in real-time
10. Agents write memory files → displayed in graph node detail
11. Summary: N vaults deposited, total shares, projected yield (Monte Carlo)

---

## ADR Decisions

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Contract framework | Foundry | Hardhat | Native Solidity tests, fast, DeFi standard |
| Frontend force-graph library | react-force-graph-2d | vis.js, D3.js, Neo4j | React-native, simpler force-directed graph, no backend needed |
| Agent execution | Parallel (`Promise.allSettled`) | Sequential | Demo value: showcase A2A coordination |
| AI layer | DeepSeek default, Venice AI via x402/SIWE | ERC-7715 + Venice-only | Avoids MetaMask Flask hard dependency; wallet-funded inference, hardcoded fallback for reliability |
| Permission model | `AgentRegistry` EIP-712 scope (own storage) | ERC-7715 delegation toolkit | 7710 redeem can't do arbitrary contract calls; rolled own capped/expiring scope |
| Agent transactions | EIP-712 signed deposit + 1Shot Managed API | EIP-7702 smart account + permissionless relayer | Managed API supports Base Sepolia testnet; no EOA upgrade needed |
| Vault | MockVault.sol (ERC-4626) | Real protocol | Full demo control, no external deps |
| Network | Base Sepolia (84532) | Ethereum Sepolia | Lower fees, Base ecosystem alignment |

---

## Key Implementation Notes

**No MetaMask Flask required** — standard EOA wallet is sufficient. Agents use ephemeral session keys, not EIP-7702/ERC-7715.

**AI provider chain (`venice.js` / `resolveProvider`):** Venice AI (wallet-funded x402 + SIWE, `veniceAuth`) → DeepSeek (server proxy `/api/ai`, default; or user dev key) → hardcoded equal-split fallback (`buildFallbackForParams`). Both Venice and DeepSeek use model slug `deepseek-v4-flash` (`config.js`). Timeout-guarded, never blocks the flow.

**x402.js** — Venice wallet-funded inference on Base mainnet USDC. `signSiweForVenice` in `wallet.js` for SIWE auth. Balance read-only; top-up is server-side only (browser never holds a raw key).

**1Shot Managed API** — `@uxly/1shot-client`, server-side via `/api/relay` (Cloudflare Pages Function → `frontend/api/relay.js`). Requires `ONESHOT_KEY` / `ONESHOT_SECRET` / `ONESHOT_BIZ_ID`. Server wallet acts as relayer — user pays 0 gas.

**Parallel agents** — Use `Promise.allSettled()` not `Promise.all()` so one agent failure doesn't abort others.

**Security — enforced on-chain:**
- `AgentVaultDepositor` recovers the EIP-712 signer; `msg.sender` is irrelevant
- `AgentRegistry.scopeOf(agent)` checked: vault match, `capPerPeriod`/`spentInPeriod`, `expiry`, `revoked`
- `executed[execId]` replay guard
- `minAmount`/`minShares` floors guard against fee-on-transfer/slippage and adversarial vaults
- ReentrancyGuard + Pausable (guardian-only pause/unpause)
- Contract holds no user funds (`ZeroCustody.t.sol` invariant)

---

## Key Docs

- [Design system + component spec](DESIGN.md) — read before touching frontend/UI
- [Architecture + ADRs + NFRs](docs/technical-architecture.md)
- [On-chain scope + audit trail](docs/technical-blockchain-usage.md)
- [Security constraints + threat model](docs/technical-security-privacy.md), [technical-threat-model.md](docs/technical-threat-model.md)
- [Demo script](docs/product-demo-scenario.md) — read before recording
- 1Shot API (Managed): https://1shotapi.com/docs
- Venice AI: https://venice.ai/
- DeepSeek: https://platform.deepseek.com/
- react-force-graph: https://github.com/vasturiano/react-force-graph
- Base Sepolia: https://docs.base.org/network-information

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

# Vibing Farmer — Product Requirements Document

**Type:** Indie Open-Source Project
**Motivation:** Built out of frustration with sequential, click-heavy DeFi yield farming.
**Tagline:** "Set once. Vibe forever."

---

## Problem Statement

### Yield Farming UX is Broken

Yield farmers must execute **8+ manual transactions** per rebalance cycle:

1. Remove liquidity → sign approve/burn NFT
2. Receive raw tokens (ETH + USDC)
3. Swap tokens → sign approve + execute swap
4. Supply to lending protocol → sign supply + use as collateral
5. Borrow asset → sign execute borrow
6. Deposit to vault → sign approve + deposit & stake

**Every step = wallet popup + gas fee + risk of mis-click.**

### User Research (X/Twitter 2025–2026)

> "Are you tired of the tedious, multi-step dance of adjusting liquidity in DeFi?" — @John_Peace1

> "Normally it's: bridge → swap → find the right vault → deposit… and hope you didn't miss a step 😭" — @kokocodes

> "agent finance UX is still broken. Today you choose between: full wallet access (risky) • human over-control (co-approving every step)." — @0xYann_

> "only ~15–18% of wallet connects end in a real transaction." — @agnt_hub

---

## Solution: Vibing Farmer

### Elevator Pitch

> AI-coordinated agent swarm for automated multi-vault yield farming on Base Sepolia. An AI strategist (DeepSeek by default, Venice AI via wallet-funded x402/SIWE) generates an allocation strategy and per-agent skill bounds. User reviews and approves once, granting each ephemeral agent a capped, expiring, EIP-712-signed scope via `AgentRegistry`. An Orchestrator dispatches Worker agents in parallel — each deposits into one ERC-4626 vault via the deposit-only `AgentVaultDepositor`. Transactions relay gas-free via 1Shot Managed API. A real-time force-directed graph (react-force-graph-2d) tracks every agent's status and memory.

### What Makes This Different

| Feature | Vibing Farmer | Manual DeFi | Auto-compound bots (Yearn, Beefy) | "Set & forget" vault aggregators |
|---------|--------------|-------------|-----------------------------------|-----------------------------------|
| Agent execution | Parallel multi-agent | N/A | N/A | Single strategy, no agents |
| Skill system (user reviews bounds before execution) | ✅ | ❌ | ❌ | ❌ |
| Persistent agent memory (UI) | ✅ | ❌ | ❌ | ❌ |
| AI strategist (allocation + skill generation) | DeepSeek default / Venice x402 | ❌ | ❌ | ❌ |
| Gas-free relay | 1Shot Managed API | User pays | Depends on bot/protocol | Depends on protocol |
| Wallet control | Capped + expiring EIP-712 agent scope (AgentRegistry), revocable per agent | Full manual, every tx signed | Full custody handed to vault contract | Full custody handed to vault contract |
| Multi-vault diversification in one flow | ✅ (N vaults, one approval) | Manual per vault | Single strategy per vault | Limited to curated vault set |
| A2A parallel execution | ✅ | ❌ | ❌ | ❌ |
| Decision support | Monte Carlo sim, MDP (FinRL), historical replay, on-chain attestation | ❌ | ❌ | ❌ |

---

## Core Architecture

### 1. AI Strategist

- User inputs: amount, risk level, number of vaults
- Provider chain (resolveProvider): **Venice AI via wallet-funded x402/SIWE** (`veniceAuth`) → **DeepSeek** (server proxy `/api/ai`, default; or user dev key) → **hardcoded equal-split fallback** (`buildFallbackForParams`)
- Model: `deepseek-v4-flash` for both Venice and DeepSeek slugs (`config.js`)
- Output:
  - Multi-vault allocation strategy (which vaults, how much each)
  - Per-agent **skill set** (slippage tolerance, max retries, deposit cap, expiry)
- User reviews and can edit generated skills in UI before approval

### 2. Skill System

Each agent receives a skill set before execution:

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "0xDff3...b7AC",
  "skills": {
    "deposit": {
      "maxAmount": "50000000",
      "vaultAddress": "0xDff3...b7AC",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "ai-strategist",
  "approvedByUser": true,
  "sessionId": "session-20260614-001"
}
```

### 3. Agent Swarm (Parallel Execution)

- **Orchestrator** (`orchestrator.js`, frontend):
  - Receives plan from AI strategist
  - Batches one user-signed `authorizeSessionKey` call per agent up front (capped + expiring scope on `AgentRegistry`)
  - Dispatches N Worker agents in parallel (`Promise.allSettled`)
  - Aggregates results → writes summary to memory

- **Worker agents** (`worker.js`, frontend, one per vault):
  - Each holds an ephemeral session key (= on-chain "agent" identity)
  - Signs an EIP-712 `AgentDeposit` message within its granted scope
  - Sends the signed message via 1Shot Managed API relay to `AgentVaultDepositor`
  - Per-worker `keyVault` (libsodium-sealed key material), `keyStore`, `submitGate`, `gasSnapshot`
  - Emits on-chain event `AgentDepositExecuted` per successful deposit
  - Writes memory file after execution

> **No on-chain swap.** The original "Swap → Approve → Deposit" flow is obsolete — agents are **deposit-only** against pre-funded USDC.

### 4. Memory System

Each agent writes a memory file after execution, displayed in the force-graph node detail panel and read back as context for the next session.

```json
{
  "agentId": "worker-agent-1",
  "sessionId": "session-20260614-001",
  "vault": "0xDff3...b7AC",
  "entries": [
    {
      "timestamp": 1748387260,
      "step": "deposit",
      "status": "success",
      "sharesReceived": "100023456",
      "gasUsed": 45000,
      "executionTimeMs": 3800,
      "lesson": "Vault accepted full deposit within cap"
    }
  ]
}
```

### 5. Real-time Agent Graph

- `react-force-graph-2d` force-directed visualization (NOT vis.js)
- **Nodes:** Orchestrator + Worker agents + Vault targets
- **Edges:** dependency and communication between agents
- **Node states:** idle → running → confirmed → failed (color-coded)
- Updates in real-time from on-chain events (`AgentDepositExecuted`, etc.)
- Clicking a node opens detail panel: current step, skill bounds, memory entries

### 6. Permission & Relay Layer

- **`AgentRegistry.sol`:** per-agent scope (vault, max amount, expiry) granted via user-signed `authorizeSessionKey`; `revokeAgent`; `scopeOf` for on-chain read
- **`AgentVaultDepositor.sol`:** deposit-only, recovers the EIP-712 signer, validates scope against the registry, **holds no funds**, emits `AgentDepositExecuted`
- **1Shot Managed API:** gas-free relay via `/api/relay` (server-held `ONESHOT_KEY`/`ONESHOT_SECRET`/`ONESHOT_BIZ_ID`) — user pays 0 gas
- **`MockVault.sol`:** ERC-4626 vault for demo deposits

### 7. Decision Support (beyond original PRD scope)

- Monte Carlo simulation (200 scenarios / 30 days) for expected yield distribution
- MDP / FinRL-style state-action-reward modeling for allocation decisions
- Historical replay against forked on-chain data for strategy validation
- On-chain strategy attestation (keccak256 hash of strategy + skills)
- Council (multi-perspective strategy review) and curator/playbook learning loop
- User-signed ERC-4626 withdrawal flow

---

## Functional Requirements

| ID | Feature | Priority | Status |
|----|---------|---------|--------|
| FR-01 | AI strategy generation + skill auto-generation (DeepSeek/Venice/fallback chain) | Must | ✅ |
| FR-02 | Skill review + edit UI before execution | Must | ✅ |
| FR-03 | Orchestrator: parallel Worker dispatch | Must | ✅ |
| FR-04 | Worker: EIP-712 signed deposit per vault | Must | ✅ |
| FR-05 | Agent memory files: write after execution | Must | ✅ |
| FR-06 | Real-time agent network graph (react-force-graph-2d) | Must | ✅ |
| FR-07 | `AgentRegistry` EIP-712 scoped permission per agent | Must | ✅ |
| FR-08 | `AgentVaultDepositor` deposit-only execution | Must | ✅ |
| FR-09 | 1Shot Managed API relay for all agent transactions | Must | ✅ |
| FR-10 | Permission revocation (`revokeAgent`) | Should | ✅ |
| FR-11 | Memory-aware next execution (feed memory to AI prompt) | Could | ✅ |
| FR-12 | Monte Carlo simulation + historical replay | Could | ✅ |
| FR-13 | On-chain strategy attestation | Could | ✅ |
| FR-14 | User-signed withdrawal flow | Should | ✅ |
| FR-15 | Session persistence across page refresh | Should | ✅ |

---

## Core Deliverables Checklist

- [x] EIP-712 capped + expiring per-agent scope (`AgentRegistry.authorizeSessionKey`) in main flow
- [x] Interactive UI displays scope grant + permission revocation
- [x] 1Shot Managed API relays agent deposit txs — sponsored relayer wallet on Base Sepolia
- [x] AI strategist generates strategy + skill sets — shown before execution
- [x] Skill review UI allows manual adjustment of agent bounds
- [x] Agent swarm (≥2 parallel Workers) visible in force-graph
- [x] Agent memory persistent and displayed in node detail
- [x] All primary features fully functional in parallel on Base Sepolia
- [ ] Open-source publishing (Phase 5)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Solidity ^0.8.24, Foundry |
| Frontend | React 18 + Vite 5 + React Router 6 + Framer Motion + react-force-graph-2d |
| AI | DeepSeek (`deepseek-v4-flash`, server proxy default) / Venice AI (wallet-funded x402+SIWE, same model slug) / hardcoded fallback |
| Relay | 1Shot Managed API (`@uxly/1shot-client`, server-side via `/api/relay`) |
| Wallet | Standard EOA wallet — ephemeral per-agent session keys, EIP-712 signing |
| Network | Base Sepolia (84532) |
| Hosting | Cloudflare Pages (SPA + `/api/*` Pages Functions) |

### Deployed Addresses (Base Sepolia 84532)

| Contract | Address |
|----------|---------|
| AgentRegistry | `0x1f5eb2613585c439d9877CA4b99439f7d06bA4AA` |
| AgentVaultDepositor | `0xbf2091Fe26183369ae9f0Ba4735190F5fec7686c` |
| MockVault | `0xDff362A0Dc9E0190b2F77E52CF8Da38721b8b7AC` |
| USDC (mock) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Timeline

| Phase | Days | Deliverable | Status |
|-------|------|------------|--------|
| 1 — Foundation | 1–3 (26–28 Mei) | Solidity review, scope study, spike review | ✅ |
| 2 — Smart Contract | 4–8 (29 Mei – 2 Juni) | `AgentRegistry` + `AgentVaultDepositor` + `MockVault` + forge tests | ✅ |
| 3 — Integration | 9–13 (3–7 Juni) | 1Shot Managed API + Orchestrator/Worker agents + force-graph + Base Sepolia E2E | ✅ |
| 4 — Polish | 14–17 (8–11 Juni) | AI skill gen, memory UI, Monte Carlo/replay/attestation, bug fixes, demo video | ✅ |
| 5 — Publish | 18–20 (12–15 Juni) | Open source publishing | ⬜ |

---

## Critical Failure Modes

| Failure | Mitigation |
|---------|-----------|
| AI provider unavailable (DeepSeek/Venice down) | Hardcoded equal-split fallback (`buildFallbackForParams`) |
| 1Shot relay timeout | Auto-retry; Worker marks itself failed, others continue |
| One Worker Agent fails | `Promise.allSettled()` — other Workers continue |
| Contract reverts on scope exceeded/expired | Design intent — surfaced as clear error in graph node |
| Force-graph not rendering | Fallback: step-tracker list view |
| Page refresh mid-session | Session resume via `yv_resume_<addr>` snapshot + silent reconnect |

---

## Resources

- 1Shot API (Managed): https://1shotapi.com/docs
- Venice AI: https://venice.ai/
- DeepSeek: https://platform.deepseek.com/
- react-force-graph: https://github.com/vasturiano/react-force-graph
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
- Base Sepolia: https://docs.base.org/network-information

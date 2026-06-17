# Architectural Overview — Vibing Farmer

> **Skill Reference:** architecture-designer
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** Architectural overview, design principles, data flows, ADRs, NFRs, and failure modes

---

## 1. Architectural Overview

Vibing Farmer is a web-based DeFi platform that automates multi-vault yield farming using an **AI-coordinated agent swarm**. The architecture comprises 5 core layers:

1. **Venice AI Coordinator** — strategy generation + per-agent skill auto-generation
2. **Skill System** — user-reviewable JSON skills per agent per step
3. **Agent Swarm** — Orchestrator + parallel Worker Agents (JavaScript, frontend)
4. **Blockchain Layer** — AgentVaultDepositor.sol (permission enforcer) + MockVault.sol
5. **Visualization Layer** — vis.js Network graph (real-time, browser)

**Vision:** Web3 → Web4 transition primitive. Users express intent, agents execute autonomously, blockchain enforces boundaries cryptographically.

---

## 2. Design Principles

| Principle | Application |
|-----------|-------------|
| Intent-based execution | The user expresses intent; Venice AI translates it into an executable plan + skills |
| Permission-bounded execution | Per-agent ERC-7715 scope — agents only act within the boundaries set by the user |
| Parallel-first | Worker Agents run concurrently rather than sequentially |
| Gas abstraction | The user does not pay gas — transactions are relayed via 1Shot Permissionless Relayer |
| Privacy-first AI | Venice AI does not store user data |
| Fail-safe default | The smart contract reverts (never fails silently) on any scope violation |
| Observable execution | vis.js graph + agent memory = full visibility into agent activities |
| Skill-governed agents | All agent actions are restricted by the skill sets approved by the user |

---

## 3. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                             │
│                                                                  │
│  ┌─────────────┐   ┌────────────────────────────────────────┐   │
│  │  Venice AI  │   │          Vibing Farmer UI              │   │
│  │ Coordinator │◄──│  HTML/CSS/JS + ethers.js v6 + vis.js  │   │
│  │             │   └──────────────────┬─────────────────────┘   │
│  │ Strategy +  │                      │                         │
│  │ Skill Gen   │                      │                         │
│  └──────┬──────┘         ┌────────────▼──────────────┐         │
│         │                │   MetaMask Flask          │         │
│         ▼                │   EIP-7702: EOA → SA      │         │
│  ┌─────────────────┐     │   ERC-7715: Per-Agent     │         │
│  │  Skill Review   │     │   Permission Grant        │         │
│  │  & Edit UI      │     └────────────┬──────────────┘         │
│  └────────┬────────┘                  │ permissionContext × N   │
│           │                           │                         │
│           ▼                           ▼                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │             ORCHESTRATOR AGENT                           │   │
│  │  Receives plan → Dispatches Workers via Promise.allSettled│  │
│  └─────────────────┬──────────────────┬──────────────────────┘  │
│                    │                  │                          │
│            ┌───────▼──────┐   ┌───────▼──────┐                 │
│            │ Worker Agent │   │ Worker Agent │  (parallel)      │
│            │     1        │   │     N        │                  │
│            │ skill: JSON  │   │ skill: JSON  │                  │
│            └───────┬──────┘   └───────┬──────┘                 │
│                    │                  │                          │
└────────────────────┼──────────────────┼──────────────────────────┘
                     │ 1Shot Relay      │ 1Shot Relay
                     ▼                  ▼
         ┌────────────────────────────────────────┐
         │          SEPOLIA TESTNET               │
         │                                        │
         │  ┌─────────────────────────────────┐   │
         │  │   AgentVaultDepositor.sol       │   │
         │  │   agentPermissions[user][agId]  │   │
         │  │   executeAgentDeposit()         │   │
         │  │   CEI pattern + ReentrancyGuard │   │
         │  └──────────┬──────────────────────┘   │
         │             ▼                           │
         │  ┌──────────────┐  ┌──────────────┐   │
         │  │ MockVault A  │  │ MockVault B  │   │
         │  │ (ERC-4626)   │  │ (ERC-4626)   │   │
         │  └──────────────┘  └──────────────┘   │
         └────────────────────────────────────────┘
                     │
                     ▼
         ┌────────────────────────────────────────┐
         │   vis.js Network Graph (browser)       │
         │   Real-time event updates              │
         │   Agent memory in node detail          │
         └────────────────────────────────────────┘
```

---

## 4. Data Flow

```
1. User inputs intent (amount, risk level, number of vaults)
   → Venice AI API → strategy JSON + skill JSON per agent

2. User reviews skill cards → edits if needed → approves
   → Skill files are written to `agents/session-{id}/agent-{n}-skills.json`

3. User connects MetaMask Flask
   → EIP-7702: EOA is upgraded to a smart account

4. User grants ERC-7715 permissions per agent
   (specifying vault address, maxAmount, and expiry)
   → permissionContext per agentId is stored in sessionStorage

5. User clicks "Launch Swarm"
   → Orchestrator dispatches N Worker Agents via Promise.allSettled()

6. Each Worker Agent runs in parallel to:
   a. Read its skill file (maxSlippage, dexPreference, etc.)
   b. Construct calldata for swap → approve → deposit
   c. POST to 1Shot Permissionless Relayer with permissionContext
   d. 1Shot relays to AgentVaultDepositor.sol:
      CHECKS: validateAgentPermission(agentId, user, vault, amount)
      EFFECTS: usedAmount += amount
      INTERACTIONS: executeSwap → approve → MockVault.deposit()
   e. Contract emits: AgentStarted, SwapExecuted, ApproveExecuted,
                      DepositExecuted, AgentCompleted (or AgentFailed)

7. Frontend listens to events via ethers.js contract.on(...)
   → vis.js graph updates node colors: idle → running → confirmed/failed
   → Memory file is written to `agents/memory/agent-{n}-memory.json`

8. User clicks an agent node to see details: skill used + memory entries

9. Summary displayed: N vaults deposited, total shares, total estimated APY earned
```

---

## 5. ADR (Architecture Decision Records)

### ADR-01: Foundry as Smart Contract Framework

**Decision:** Use Foundry (via WSL) for development and testing.

**Rationale:** Native Solidity testing, built-in fuzz testing, fast execution, and industry standard for DeFi protocol development.

**Rejected:** Hardhat — too much boilerplate and slower feedback loop.

**Note:** Foundry must run via WSL on Windows — always use `wsl -e bash -c "..."`.

---

### ADR-02: HTML/CSS/JS + ethers.js v6 + vis.js (instead of React)

**Decision:** Plain HTML/CSS/JS with ethers.js v6 and vis.js Network via CDN.

**Rationale:** Faster setup, no build pipeline required, allowing total focus on Web3 and agent logic. The vis.js force-directed graph is perfect for agent network visualization.

**Rejected:** React (overkill for the interactive dashboard prototype) and D3.js (too low-level for a network graph).

---

### ADR-03: Venice AI as Coordinator and Skill Generator

**Decision:** Leverage Venice AI not just as a recommendation engine, but as a strategy coordinator that automatically generates skill sets per agent.

**Rationale:** Highly private (no data retention), open-source philosophy, and OpenAI-compatible. Adds significant value: instead of just "AI suggesting a vault", we get "AI generating an executable agent configuration."

**Rejected:** OpenAI/Anthropic and Groq (due to data-logging policies and lack of built-in privacy guardrails).

---

### ADR-04: Parallel Agent Dispatch (Promise.allSettled)

**Decision:** The Orchestrator uses `Promise.allSettled()` to dispatch all Workers in parallel.

**Rationale:** Demonstrates genuine parallel agent-to-agent coordination. Sequential execution offers no real concurrent scalability. `allSettled` is chosen over `all` so that a single worker failure does not abort other workers.

**Rejected:** Sequential dispatch (which fails to demonstrate parallel multi-agent swarm efficiency).

---

### ADR-05: Per-Agent ERC-7715 Permission (instead of one shared permission)

**Decision:** Every Worker Agent receives its own distinct ERC-7715 permission (agent-specific, vault-specific, amount-specific).

**Rationale:** Security-first design: Worker 1 cannot access Worker 2's vault even within the same session. Demonstrates fine-grained cryptographic permission boundaries.

**Rejected:** One single permission for all agents (overly broad scope, weaker security story).

---

### ADR-06: MockVault (instead of real protocol integration)

**Decision:** Deploy two MockVault.sol (ERC-4626) instances on the testnet.

**Rationale:** Complete control over the demo, zero dependencies on external live protocols, and deploy two instances to demonstrate parallel Workers depositing to different vaults.

---

## 6. NFR (Non-Functional Requirements)

| Aspect | Target |
|--------|--------|
| Full flow execution time (2 parallel vaults) | < 60 seconds |
| Venice AI response time | < 10 seconds |
| vis.js graph update latency from on-chain event | < 1 second |
| Gas cost for user | 0 (via 1Shot) |
| Browser support | Latest Chrome / Brave |
| Smart contract test coverage | ≥ 80% |
| Worker Agent failure isolation | One worker failure does not abort other workers |
| Minimum parallel Workers in demo | ≥ 2 (for parallel swarm validation) |

---

## 7. Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| EIP-7702 not supported on Sepolia | Blocker | Verified — live since March 5, 2025 |
| Regular MetaMask (not Flask) | Demo fails | Show warning: "Install MetaMask Flask (13.9+)" |
| Venice AI timeout | Skills not generated | Hardcoded fallback skill template |
| Venice AI JSON output malformed | Skill cards do not render | JSON schema validation + error message |
| 1Shot relay timeout per Worker | Transaction unconfirmed | Retry once based on maxRetries skill; mark worker as failed |
| Single Worker Agent failure | Partial execution | Promise.allSettled ensures other workers continue; graph node turns red |
| vis.js graph fails to render | Visualization missing | Fallback: step-tracker list view |
| Contract revert on permission exceeded | Transaction rejected | Expected security behavior — display clear error in graph node detail |
| agentId collision | Wrong permission used | Generate via keccak256(deterministic string) |
| MockVault deposit fails | Worker marks failed | Unit test thoroughly before deploying to Sepolia |

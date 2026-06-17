Created At: 2026-05-30T13:59:04Z
Completed At: 2026-05-30T13:59:04Z
File Path: `file:///c:/SharredData/project/competition/yield-vibing/docs/business-roadmap-backlog.md`

# Roadmap & Backlog — Vibing Farmer

> **Skill Reference:** architecture-designer + finance-expert
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** MVP timeline roadmap, feature prioritization, and risk management

---

## 1. Roadmap Summary

Project Duration: **20-day sprint setup** (from concept to fully working Sepolia MVP).
Target: End-to-end parallel multi-vault deposit automation with a secure agent swarm on Sepolia, integrated with standard wallet/permission libraries.

**Core Technological Highlights:** Multi-Agent Skill Boundaries + Venice AI Strategy Generation + Parallel A2A Coordination + 1Shot Gasless Relay.

---

## 2. Priority Matrix (MoSCoW)

### Must Have

| ID | Feature | Category |
|----|-------|-------|
| M1 | Wallet connect + EIP-7702 account upgrade | Smart Account Foundations |
| M2 | ERC-7715 permission grant UI per agent | Smart Account Foundations |
| M3 | AgentVaultDepositor.sol (per-agent permission + execution) | Core Logic |
| M4 | 1Shot API relay for all agent transactions | Gas Abstraction Layer |
| M5 | Venice AI: strategy generation + skill auto-generation per agent | AI Strategy Orchestration |
| M6 | Skill review + edit UI (user approves prior to execution) | User Agency |
| M7 | Orchestrator Agent: parallel Worker dispatch | Multi-Agent Parallel Swarm |
| M8 | Worker Agent: single vault Swap→Approve→Deposit | Worker Autonomy |
| M9 | Agent memory files: write + display | Traceability |
| M10 | vis.js Network graph: real-time agent visualization | Traceability |
| M11 | End-to-end flow on Sepolia testnet | E2E Live Environment |
| M12 | Codebase publication & setup guides | Documentation |

### Should Have

| ID | Feature | Rationale |
|----|-------|--------|
| S1 | Agent memory displayed in vis.js node details | Improves system traceability |
| S2 | Permission boundary enforcement (revert on exceed) per agent | Security & robust cryptographic enforcement |
| S3 | MockVault × 2 instances for demo of 2 parallel Workers | Validates parallel swarm scaling |
| S4 | Skill edit capability (user modifies slippage, amount) | Enables granular user-defined boundaries |

### Could Have

| ID | Feature | Rationale |
|----|-------|--------|
| C1 | Memory-aware Venice AI re-prompting | Feedback loop for smarter future strategies |
| C2 | APY comparison UI across vaults | Compelling visual statistics |
| C3 | ≥ 3 parallel Workers (expandable N) | Validates wide parallel orchestration |

### Won't Have (Explicitly Out of Scope)

| Feature | Reason for Exclusion |
|-------|-------------------|
| Cross-chain bridging | Extremely high latency, high security surface, out of initial scope |
| Remove liquidity automation | Requires active market monitoring and complex rebalancing rules |
| Custom AMM/DEX | Reinventing the wheel, should use production DEX aggregates like Uniswap |
| Mainnet deployment | Needs extensive auditing, testnet is safe for initial sandbox release |
| Mobile breakpoints | Core focus is desktop-first power user dashboard UX |

---

## 3. Milestones per Phase

### Phase 1: Foundation (Days 1–3 | May 26–28)

> **Note:** All 4 spikes are already resolved ✅. Spike review does not need to be repeated — proceed directly to understanding the architecture and technical preparations.

| Day | Deliverable | Complete |
|------|-------------|---------|
| Day 1 | Solidity review: storage, events, modifiers, access control | [ ] |
| Day 1 | Security patterns: CEI pattern, ReentrancyGuard, revert vs. silent fail | [ ] |
| Day 2 | Read `GETTING_STARTED.md` end-to-end: contract spec, build order, skill schema | [ ] |
| Day 2 | Understand the Skill System: JSON schema per agent, Venice AI → skills.js → worker.js flow | [ ] |
| Day 3 | Review the design prototype (`design/Vibing Farmer Prototype.html`) — UI reference before writing contracts | [ ] |
| Day 3 | Setup check: `forge build` OK · `.env.example` → `.env` · `agents/memory/` directory exists | [ ] |
| Day 3 | Verify `contracts/AgentVaultDepositor.sol` + `test/AgentVaultDepositor.t.sol` are ready to be populated | [ ] |

**Milestone gate:** `forge build` compiles successfully (green). All skeleton files are correctly named. Skill schema is thoroughly understood. Ready to implement logic in Phase 2.

### Phase 2: Smart Contracts (Days 4–8 | May 29 – June 2)

| Day | Deliverable | Complete |
|------|-------------|---------|
| Day 4 | MockVault.sol — minimal ERC-4626, deploy 2 instances | [ ] |
| Day 5 | AgentVaultDepositor.sol — per-agent permission struct + grantAgentPermission | [ ] |
| Day 6 | AgentVaultDepositor.sol — executeAgentDeposit (CEI) + all events | [ ] |
| Day 7 | Security review: per-agent validation, no admin key, ReentrancyGuard | [ ] |
| Day 8 | Testing: success path, fail path, parallel agentId, fuzz (forge test) | [ ] |

**Milestone gate:** All `forge test` cases pass, coverage ≥ 80%.

### Phase 3: Integration (Days 9–13 | June 3–7)

| Day | Deliverable | Complete |
|------|-------------|---------|
| Day 9 | 1Shot relay integration: relay.js + test Sepolia relay | [ ] |
| Day 10 | wallet.js: EIP-7702 upgrade + ERC-7715 per-agent permission | [ ] |
| Day 11 | venice.js: strategy generation + skill auto-generation | [ ] |
| Day 12 | skills.js + memory.js: review UI + memory write/read | [ ] |
| Day 11 | worker.js: single vault agent workflow | [ ] |
| Day 12 | orchestrator.js: parallel dispatch + Promise.allSettled | [ ] |
| Day 13 | graph.js: vis.js Network + real-time event updates | [ ] |

**Milestone gate:** 2 Worker Agents run in parallel on Sepolia, with real-time graph updates.

### Phase 4: Polish & Ship (Days 14–17 | June 8–11)

| Day | Deliverable | Complete |
|------|-------------|---------|
| Day 14 | Bug fixes: edge cases, error handling, UX polish | [ ] |
| Day 15 | Memory UI in node details, skill edit capability | [ ] |
| Day 16 | README, comprehensive documentation, architecture diagram updates | [ ] |
| Day 17 | Finalize deployment playbooks | [ ] |

**Milestone gate:** Code finalized and ready for release.

### Phase 5: Sandbox Deploy & Publish (Days 18–20 | June 12–15)

| Day | Deliverable | Complete |
|------|-------------|---------|
| Day 18–19 | End-to-end sandbox stress testing and security review | [ ] |
| Day 20 | Publish code on GitHub with open-source guidelines | [ ] |

---

## 4. Core Feature Backlog

### Contracts (Priority: Critical)

- `AgentVaultDepositor.sol` — per-agent permission mapping, executeAgentDeposit, 6 events
- `MockVault.sol` — ERC-4626 mock, deploy 2 instances (VaultA and VaultB)
- `script/Deploy.s.sol` — deploy AgentVaultDepositor + 2 MockVaults to Sepolia
- Foundry tests: unit (per agent), integration (2 parallel agents), fuzz (amount edge cases)

### Frontend — Agent System (Priority: Critical)

- `orchestrator.js` — receives the Venice AI plan, dispatches Workers via Promise.allSettled
- `worker.js` — single vault Swap→Approve→Deposit, respecting skill parameters
- `skills.js` — generates + renders editable skill cards, writes to `agents/session-{id}/`
- `memory.js` — append-only memory writing, reading, and rendering in node details

### Frontend — Visualization (Priority: High)

- `graph.js` — vis.js Network: initializes the graph, updates node states from on-chain events
- Node states: idle (gray) → running (blue) → confirmed (green) → failed (red)
- Click handler: detail panel showing skill JSON + memory entries

### Frontend — Web3 (Priority: High)

- `wallet.js` — MetaMask Flask detection, EIP-7702, ERC-7715 per agent
- `relay.js` — 1Shot relay per Worker Agent, with a 1x retry on timeout
- `venice.js` — strategy + skill generation, 10-second timeout, hardcoded fallback

### Frontend — App (Priority: High)

- `app.js` — state machine: input → strategy → skills → permissions → execute → done
- `ui.js` — step tracker, status badges, Etherscan links

---

## 5. Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| vis.js graph does not render smoothly with event updates | Medium | Medium | Test with mock events prior to real contract deployment |
| Venice AI JSON output does not match skill schema | Medium | High | Validate output and fall back to hardcoded skill template |
| Promise.allSettled executes too fast — 1Shot rate limit | Low | Medium | Add delay between Worker dispatches if necessary |
| Solo burnout | High | High | Max 8 hours/day. If stuck > 2 hours → pivot or skip |
| Scope creep into features C2/C3 | Medium | High | Strict boundaries: 2 Workers + basic memory = MVP. No feature creep after Day 13 |
| AgentId collision among agents | Low | Medium | Use keccak256(agentId string) — deterministic |
| MetaMask Flask version incompatibility | Low | High | Test in a clean browser profile, document the exact working Flask version |
| 1Shot Permissionless Relayer down | Low | High | Verify relayer health on Day 9. Implement fallback: direct EOA transaction for the demo |
| Venice AI response is slow (> 10 seconds) | Low | Low | Timeout + hardcoded fallback strategy |
| Poor documentation clarity | Low | Medium | Write guides first, keep README highly intuitive |

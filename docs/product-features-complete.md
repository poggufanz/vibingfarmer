# Complete Features — Vibing Farmer

> **Skill Reference:** mobile-developer + blockchain-developer
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** Comprehensive list of functional requirements, priorities, and integration dependencies

---

## 1. Summary

Vibing Farmer automates multi-vault yield farming using an agent swarm coordinated by Venice AI. The architecture consists of 5 core components integrated with one another:

1. **Venice AI Coordinator** — generates strategy + skill sets per agent.
2. **Skill System** — allows user review/edit + approval before execution.
3. **Agent Swarm** — Orchestrator + parallel Worker Agents.
4. **Memory System** — per-agent execution logs displayed in the UI.
5. **vis.js Graph** — real-time agent network visualization.

Scope: Multi-vault deposit automation (Swap → Approve → Deposit per vault, executed in parallel). This does not cover the full yield farming lifecycle.

---

## 2. Functional Requirements (FR)

### FR-01: Venice AI Strategy Generation + Skill Auto-Generation

**Description:** The user enters their intent (USDC amount, risk level, number of vaults) and receives a multi-vault allocation strategy along with auto-generated skill sets per agent from Venice AI.

**Input:**
- Total USDC amount (numeric value)
- Risk level: Low / Medium / High
- Target number of vaults (integer, minimum 2 for demo purposes)

**Output:**
- Multi-vault allocation strategy (vault address, amount per vault, vault name)
- Skill set JSON per agent, segmented by step type:
  - Swap skill: `{ maxSlippage, dexPreference, maxRetries, timeoutSeconds }`
  - Deposit skill: `{ maxAmount, vaultAddress, expiresAt }`
- Privacy badge: "Coordinated by Venice AI — No data retention"

**Constraints:**
- Use the Venice AI API (`https://api.venice.ai/api/v1`) — OpenAI-compatible.
- Model: `llama-3.3-70b`, `response_format: json_object`.
- `venice_parameters.include_venice_system_prompt: false`.
- Timeout: 10 seconds, falling back to a hardcoded strategy.
- If memory entries are available: feed them into the Venice AI prompt as context.

---

### FR-02: Skill Review + Edit UI

**Description:** The user can view, edit, and approve the Venice AI-generated skill sets before agents begin execution.

**Flow:**
1. The Venice AI output is rendered as Skill Cards (one card per agent).
2. Each card displays: `agentId`, target vault, and skill parameters (editable).
3. The user edits parameters if necessary (slippage, maxAmount, etc.).
4. The user clicks "Approve Skill Sets" → all skills are locked and written to `agents/session-{id}/agent-{n}-skills.json`.
5. Worker Agents utilize these skills during execution.

**Editable Fields per Skill:**
- Swap: `maxSlippage` (0–2%), `dexPreference` (dropdown menu), `maxRetries` (1–3)
- Deposit: `maxAmount` (≤ Venice AI allocation), `expiresAt` (timestamp)

**Constraints:**
- Execution cannot start until the user approves the skills.
- Skill files must be written to `agents/session-{id}/` before the Worker launch.

---

### FR-03: Wallet Connect + EIP-7702 Smart Account Upgrade

**Description:** The user connects MetaMask Flask, and the application upgrades the EOA to a smart account via EIP-7702.

**Flow:**
1. Detect the MetaMask Flask extension (not regular MetaMask).
2. Request `eth_requestAccounts` → retrieve the EOA address.
3. Check whether the account is already a smart account or still an EOA.
4. If it is an EOA: trigger EIP-7702 authorization via Viem + MetaMask SAK.
5. Display the upgrade status.

**Constraints:**
- Requires MetaMask Flask 13.9+ (regular MetaMask does not support ERC-7715).
- Network: Sepolia testnet.
- Handle cases where the account is already upgraded to a smart account (skip upgrade).
- Viem ESM CDN: `import { createWalletClient } from 'https://esm.sh/viem'`

---

### FR-04: ERC-7715 Permission Grant per Agent

**Description:** The user sets scoped permissions for each agent, defining vault boundaries, amount limits, and duration.

**Permission per Agent:**
- `agentId`: Unique agent identifier (bytes32)
- `allowedVault`: Allowed vault address (specific to each agent)
- `maxAmount`: Maximum USDC amount (conforming to the deposit skill)
- `expiresAt`: Expiration timestamp (default: 24 hours)

**Flow:**
1. Display permission cards (one per agent) with clear details.
2. The user clicks "Grant Permissions" → triggers `wallet_requestExecutionPermissions` (ERC-7715) for each agent.
3. Save the `permissionContext` per `agentId` in `sessionStorage`.
4. Display the status: "N Agent Permissions Active".

**Constraints:**
- The permission scope must be displayed clearly per agent before user approval.
- A "Revoke All Permissions" button must be available after granting.
- The displayed vault address must match the vault address from the approved skills.

---

### FR-05: Orchestrator Agent — Parallel Worker Dispatch

**Description:** The Orchestrator Agent receives the plan from Venice AI, spawns N Worker Agents, and dispatches them in parallel.

**Flow:**
1. Receive the strategy JSON from `venice.js`.
2. Spawn Worker Agent instances (one per vault in the strategy).
3. Dispatch all via `Promise.allSettled()` — ensuring one failure does not abort the others.
4. Aggregate results from all Workers.
5. Write the Orchestrator summary to memory.

**Constraints:**
- Use `Promise.allSettled()` instead of `Promise.all()`.
- The Orchestrator node is shown at the center of the vis.js graph.
- Render edges from the Orchestrator to each Worker agent.

---

### FR-06: Worker Agent — Single Vault Deposit Flow

**Description:** Each Worker Agent executes a complete single-vault deposit flow based on its assigned skill set.

**Flow per Worker:**
1. Read the skill set from `agents/session-{id}/agent-{n}-skills.json`.
2. Emit the `AgentStarted` event.
3. Send a relay request to the 1Shot API (swap step).
4. Emit the `SwapExecuted` event on confirmation.
5. Send a relay request to the 1Shot API (approve step).
6. Emit the `ApproveExecuted` event on confirmation.
7. Send a relay request to the 1Shot API (deposit step).
8. Emit the `DepositExecuted` event on confirmation.
9. Emit `AgentCompleted`.
10. Write the memory entry to `agents/memory/agent-{n}-memory.json`.

**Error Handling:**
- If 1Shot times out: retry 1x based on the skill's `maxRetries`.
- If a contract reverts: emit `AgentFailed`, write the error to memory, and halt the Worker (without aborting other Workers).
- If execution exceeds permissions: the contract reverts, and the Worker is marked as failed.

**Constraints:**
- All transactions must be routed via the 1Shot Permissionless Relayer (user pays zero gas).
- Strictly adhere to skill parameters: `maxSlippage`, `maxRetries`, and timeout.
- Write memory records after completion (regardless of success or failure).

---

### FR-07: Agent Memory System

**Description:** Each agent records execution outcomes to a persistent memory file, which is displayed in the UI and used as context in subsequent executions.

**Memory Format (Append-Only JSON):**
```json
{
  "agentId": "worker-agent-1",
  "sessionId": "session-20260609-001",
  "vault": "0xVaultA...",
  "entries": [
    {
      "timestamp": 1748387200,
      "step": "swap",
      "status": "success",
      "gasUsed": 45000,
      "slippageActual": 0.12,
      "executionTimeMs": 4200,
      "lesson": "MockVault A accepts 0.5% slippage reliably"
    },
    {
      "timestamp": 1748387260,
      "step": "deposit",
      "status": "success",
      "sharesReceived": "50023456",
      "executionTimeMs": 3800
    }
  ]
}
```

**Storage:** `agents/memory/agent-{n}-memory.json`

**Displayed in:** The vis.js node details panel when a user clicks an agent node.

**Used for:** Feeding into the Venice AI prompt as context during the next execution (Could Have).

---

### FR-08: vis.js Network Graph — Real-Time Monitoring

**Description:** A force-directed network graph that visualizes the agent swarm, execution status, and inter-agent communication in real time.

**Nodes:**
- Orchestrator Agent (center)
- Worker Agent × N
- Target Vault × N

**Edges:**
- Orchestrator → Worker Agent (dependency edge)
- Worker Agent → Vault (execution edge)

**Node States (Color-Coded):**
- `idle` — grey
- `running` — blue (animated border)
- `confirmed` — green
- `failed` — red

**Interaction:**
- Click node → details panel appears: current step, skills used, memory entries.
- Graph updates in real-time from on-chain events (via ethers.js `contract.on(...)`).

**Constraints:**
- Must use vis.js Network (not D3.js, not Neo4j).
- CDN: `https://unpkg.com/vis-network/standalone/umd/vis-network.min.js`

---

### FR-09: Permission Revocation

**Description:** Users can revoke permissions for all agents or a specific agent at any time.

**Flow:**
1. A "Revoke All Permissions" button is available once permissions are active.
2. Call `revokeAgentPermission` per `agentId` on the smart contract.
3. Update the UI: "Permissions revoked — agents cannot execute".

---

## 3. Priorities (MoSCoW)

| FR | Feature | Priority | Track |
|----|---------|-----------|-------|
| FR-01 | Venice AI Strategy + Skill Generation | Must | Venice |
| FR-02 | Skill Review + Edit UI | Must | Agent |
| FR-03 | Wallet Connect + EIP-7702 | Must | Qualification |
| FR-04 | ERC-7715 Permission per Agent | Must | Qualification |
| FR-05 | Orchestrator Agent (Parallel Dispatch) | Must | A2A |
| FR-06 | Worker Agent (Single Vault Flow) | Must | Agent + 1Shot |
| FR-07 | Agent Memory System | Must | Agent |
| FR-08 | vis.js Network Graph | Must | Agent + A2A |
| FR-09 | Permission Revocation | Should | Security |

---

## 4. Platform Considerations

| Aspect | Detail |
|-------|--------|
| Browser | Chrome / Brave (MetaMask Flask extension support) |
| Wallet | MetaMask Flask (not regular MetaMask) |
| Network | Sepolia testnet |
| Smart Contract | Solidity ^0.8.24, Foundry |
| Frontend | HTML/CSS/JS + ethers.js v6 + vis.js Network |
| AI | Venice AI API (OpenAI-compatible, llama-3.3-70b) |
| Relay | 1Shot Permissionless Relayer (JSON-RPC, no API key) |
| Viem | ESM CDN for EIP-7702/ERC-7715 signing |

---

## 5. Integration & Dependencies

| Component | Dependency | Notes |
|----------|-----------|---------|
| MetaMask Flask | Flask 13.9+ extension | Regular MetaMask does not support ERC-7715 |
| Viem | ESM CDN (`esm.sh/viem`) | EIP-7702 + ERC-7715 signing |
| ethers.js | v6 via CDN | Contract event listening + calldata encoding |
| vis.js Network | `unpkg.com/vis-network` | Force-directed graph, no backend |
| Venice AI | REST API + API key | `https://api.venice.ai/api/v1` |
| 1Shot API | Permissionless Relayer | `https://relayer.1shotapi.com/relayers` — no API key |
| Foundry | `forge`, `cast` (via WSL) | Smart contract development + testing |

---

## 6. References

- EIP-7702: https://eips.ethereum.org/EIPS/eip-7702
- ERC-7715: https://eips.ethereum.org/EIPS/eip-7715
- ERC-7710: https://eips.ethereum.org/EIPS/eip-7710
- MetaMask Smart Accounts Kit: https://docs.metamask.io/wallet/smart-accounts/
- Venice AI Docs: https://docs.venice.ai/
- 1Shot API Docs: https://1shotapi.com/docs
- vis.js Network Docs: https://visjs.github.io/vis-network/docs/network/

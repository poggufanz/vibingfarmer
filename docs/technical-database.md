# Database & Data Model — Vibing Farmer

> **Skill Reference:** database-schema-designer
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** Technical documentation of the data model, storage strategy, and data retention policies

---

## 1. Data Model Summary

Vibing Farmer **does not utilize a traditional database** (SQL/NoSQL). The platform's state is stored across four layers:

| Layer | Storage | Stored Data |
|-------|---------|-------------|
| On-chain (Sepolia) | Smart contract storage | Per-agent permission state, transaction events (audit trail) |
| Local filesystem | JSON files (`agents/`) | Per-agent skill files, per-agent memory files |
| Browser | `localStorage` / `sessionStorage` | Session state, UI state, permissionContext per agent |
| Off-chain ephemeral | API response | Venice AI strategy + skill output, 1Shot relay status |

No backend servers or developer-managed databases exist.

---

## 2. On-Chain Storage (Smart Contract)

### `AgentVaultDepositor.sol` — State Variables

```solidity
struct AgentPermission {
    address allowedVault;   // allowed vault for this agent
    uint256 maxAmount;      // USDC limit amount (in wei)
    uint256 usedAmount;     // amount already executed
    uint256 expiresAt;      // expiry timestamp (Unix)
    bool isActive;          // permission status
}

// Nested mapping: user address → agentId → permission
mapping(address user => mapping(bytes32 agentId => AgentPermission)) public agentPermissions;
```

### Event Log (On-Chain Audit Trail — Immutable)

| Event | Fields |
|-------|--------|
| `AgentStarted` | agentId, user, vault |
| `SwapExecuted` | agentId, user, amountIn, amountOut |
| `ApproveExecuted` | agentId, user, vault, amount |
| `DepositExecuted` | agentId, user, vault, amount, shares |
| `AgentCompleted` | agentId, user, vault, shares |
| `AgentFailed` | agentId, user, reason |

---

## 3. Skill Files (JSON, Local)

### Path

```
agents/
  session-{sessionId}/
    agent-1-skills.json
    agent-2-skills.json
```

### Schema (per file)

```json
{
  "agentId": "worker-agent-1",
  "sessionId": "session-20260609-001",
  "vaultAddress": "0xMockVaultA",
  "vaultName": "MockVault USDC-A",
  "skills": {
    "swap": {
      "maxSlippage": 0.5,
      "dexPreference": "uniswap-v3",
      "maxRetries": 2,
      "timeoutSeconds": 30
    },
    "deposit": {
      "maxAmount": "50000000",
      "vaultAddress": "0xMockVaultA",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true,
  "approvedAt": 1748387100
}
```

### Lifecycle

1. Venice AI generates skill JSON → stored in memory (not file yet)
2. User reviews + edits via Skill Card UI
3. User approves → file written to `agents/session-{id}/agent-{n}-skills.json`
4. Worker Agent reads skill file before execution
5. The skill file is read-only once approved

---

## 4. Memory Files (JSON, Local — Append-Only)

### Path

```
agents/
  memory/
    agent-1-memory.json
    agent-2-memory.json
```

### Schema (per file)

```json
{
  "agentId": "worker-agent-1",
  "vault": "0xMockVaultA",
  "entries": [
    {
      "sessionId": "session-20260609-001",
      "timestamp": 1748387200,
      "step": "swap",
      "status": "success",
      "gasUsed": 45000,
      "slippageActual": 0.12,
      "executionTimeMs": 4200,
      "txHash": "0xABC123...",
      "lesson": "MockVault A accepts 0.5% slippage reliably"
    },
    {
      "sessionId": "session-20260609-001",
      "timestamp": 1748387260,
      "step": "deposit",
      "status": "success",
      "sharesReceived": "50023456",
      "executionTimeMs": 3800,
      "txHash": "0xDEF456..."
    }
  ]
}
```

### Lifecycle

1. Worker Agent completes execution (success or failure) → writes an entry to the memory file
2. Entry is appended to the `entries` array (never overwritten)
3. On the next session, the memory file is read and fed into the Venice AI prompt as context
4. Memory entries are displayed in the vis.js node details panel

---

## 5. Browser Storage

### `sessionStorage` (lost when the tab is closed)

| Key | Value (Example) | Description |
|-----|----------------|-------------|
| `vf_permission_context_agent1` | JSON string | ERC-7715 context for Worker Agent 1 |
| `vf_permission_context_agent2` | JSON string | ERC-7715 context for Worker Agent 2 |
| `vf_strategy` | JSON string | Venice AI strategy for the current session |
| `vf_skills_approved` | `"true"` | Indicates whether the user has approved the skill configurations |
| `vf_execution_state` | JSON string | Execution status of all active agents |

### `localStorage` (persistent across sessions)

| Key | Value (Example) | Description |
|-----|----------------|-------------|
| `vf_connected_address` | `"0x1234...5678"` | Last connected wallet address |
| `vf_network` | `"sepolia"` | Last connected network |
| `vf_last_session_id` | `"session-20260609-001"` | ID of the last active session |

---

## 6. Core Entities

### Strategy Object (ephemeral, from Venice AI)

```json
{
  "sessionId": "session-20260609-001",
  "totalAmount": "100000000",
  "riskLevel": "Low",
  "vaultCount": 2,
  "vaults": [
    {
      "vaultAddress": "0xMockVaultA",
      "vaultName": "MockVault USDC-A",
      "amount": "50000000",
      "estimatedAPY": 7.8,
      "reasoning": "Vault A is conservative, suitable for a Low risk profile."
    },
    {
      "vaultAddress": "0xMockVaultB",
      "vaultName": "MockVault USDC-B",
      "amount": "50000000",
      "estimatedAPY": 8.2,
      "reasoning": "Vault B offers stable APY, risk level is acceptable."
    }
  ]
}
```

### Per-Agent Permission (off-chain representation)

```json
{
  "agentId": "worker-agent-1",
  "agentIdBytes32": "0x<keccak256>",
  "userAddress": "0x1234...5678",
  "allowedVault": "0xMockVaultA",
  "maxAmount": "50000000",
  "usedAmount": "0",
  "expiresAt": 1749686400,
  "isActive": true,
  "permissionContext": "<ERC-7715 context string from MetaMask Flask>"
}
```

### Execution State (session)

```json
{
  "sessionId": "session-20260609-001",
  "orchestratorStatus": "completed",
  "agents": [
    {
      "agentId": "worker-agent-1",
      "vault": "0xMockVaultA",
      "status": "confirmed",
      "steps": [
        { "name": "swap", "status": "confirmed", "txHash": "0xABC..." },
        { "name": "approve", "status": "confirmed", "txHash": "0xDEF..." },
        { "name": "deposit", "status": "confirmed", "txHash": "0xGHI...", "shares": "50023456" }
      ]
    },
    {
      "agentId": "worker-agent-2",
      "vault": "0xMockVaultB",
      "status": "confirmed",
      "steps": [
        { "name": "swap", "status": "confirmed", "txHash": "0xJKL..." },
        { "name": "approve", "status": "confirmed", "txHash": "0xMNO..." },
        { "name": "deposit", "status": "confirmed", "txHash": "0xPQR...", "shares": "50034567" }
      ]
    }
  ]
}
```

---

## 7. Core Relationships

```
User Wallet Address
    │
    └── N AgentPermissions (on-chain: agentPermissions[user][agentId])
            ├── agentId-1 → AgentPermission { vault: VaultA, maxAmount, usedAmount, expiresAt }
            └── agentId-2 → AgentPermission { vault: VaultB, maxAmount, usedAmount, expiresAt }

Session ID
    │
    ├── Strategy JSON (ephemeral)
    │
    ├── Skill Files (local JSON, agents/session-{id}/)
    │   ├── agent-1-skills.json
    │   └── agent-2-skills.json
    │
    └── Memory Files (local JSON, agents/memory/)
        ├── agent-1-memory.json  ← appended per session
        └── agent-2-memory.json  ← appended per session

On-Chain Events (immutable, per agentId)
    ├── AgentStarted
    ├── SwapExecuted
    ├── ApproveExecuted
    ├── DepositExecuted
    ├── AgentCompleted
    └── AgentFailed
```

---

## 8. Key Queries

| Query | Method | Usage Scenario |
|-------|--------|----------------|
| Check active permission per agent | `contract.agentPermissions(userAddress, agentIdBytes32)` | Before execution |
| Deposit history per agent | `queryFilter(DepositExecuted, {agentId})` | Dashboard status updates |
| Vault balance (agent 1) | `mockVaultA.balanceOf(userAddress)` | After deposit |
| Vault balance (agent 2) | `mockVaultB.balanceOf(userAddress)` | After deposit |
| Agent memory (local) | Read `agents/memory/agent-{n}-memory.json` | Node details panel |

---

## 9. Data Retention & Privacy

| Data Type | Retention | Notes |
|-----------|-----------|-------|
| On-chain events | Permanent (immutable blockchain) | Cannot be deleted |
| Smart contract state | Until permission is expired or revoked | Testnet only |
| Skill files (`agents/`) | Single session — can be cleared manually | Full user control |
| Memory files (`agents/memory/`) | Persistent across sessions (append-only) | User can delete manually |
| `localStorage` | Manual clearing via browser | Full user control |
| `sessionStorage` | Cleared when the tab is closed | Automatic |
| Venice AI conversation | **Not stored** | No retention — Venice AI policy |
| 1Shot relay logs | Guided by 1Shot's policy | Outside developer control |

**Privacy note:** User input data (such as USDC amount and risk level) is never transmitted to the developer's server. Venice AI does not retain conversation data. All skill and memory files are stored locally on the user's browser or filesystem — they are never transmitted to any external server.

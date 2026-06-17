# GETTING_STARTED.md — Vibing Farmer MVP Plan

**"Set once. Vibe forever."**  
Purpose: **Indie Open-Source Project** · Scope: Parallel Yield Farming Automation Swarm

---

## 0. Spike Status — All Resolved ✅

| Spike | Status | Critical Finding |
|-------|--------|-----------------|
| EIP-7702 + MetaMask SAK | ✅ | Sepolia live since March 5, 2025. **MetaMask Flask 13.9+ required** (not regular MM). Viem ESM CDN for auth signing. |
| ERC-7715 scoped permissions | ✅ | AgentVaultDepositor uses own `agentPermissions` mapping. ERC-7715 shown in frontend UI. `context` stored in sessionStorage. |
| 1Shot API relayer | ✅ | Use **Permissionless Relayer** (`relayer.1shotapi.com/relayers`). No API key. Pure JSON-RPC. |
| Venice AI | ✅ | OpenAI-compatible. Model: `llama-3.3-70b`. OpenAI SDK via ESM CDN pointed at Venice base URL. `response_format: json_object`. |

**Proceed to Phase 2: write contracts.**

---

## 1. MVP Scope

**In scope — must demo:**
- EIP-7702 EOA → smart account upgrade (MetaMask Flask)
- ERC-7715 scoped permission grant per agent (vault + maxAmount + expiry)
- Venice AI: strategy generation + per-agent skill set auto-generation
- Skill review + edit UI (user approves before execution)
- Orchestrator Agent dispatching ≥2 Worker Agents in parallel
- Each Worker: Swap → Approve → Deposit via 1Shot relay (user pays 0 gas)
- AgentVaultDepositor.sol + MockVault.sol × 2 on Sepolia
- vis.js Network graph: real-time agent network visualization
- Agent memory files: write after execution, display in graph node detail

**Explicit out of scope:**
- Mainnet deployment
- Real vault protocols (Aave, Compound)
- Cross-chain
- Mobile breakpoints
- Memory-aware Venice AI re-prompting (Could Have)

---

## 2. Target Directory Structure

```
vibing-farmer/
│
├── contracts/
│   ├── AgentVaultDepositor.sol     # Core — per-agent permission + parallel execution (CEI + ReentrancyGuard)
│   └── MockVault.sol               # ERC-4626 mock vault (deploy 2 instances for demo)
│
├── test/
│   ├── AgentVaultDepositor.t.sol   # Forge tests — success path, permission violations, fuzz, parallel
│   └── MockVault.t.sol             # Basic ERC-4626 compliance checks
│
├── script/
│   └── Deploy.s.sol                # Deploys AgentVaultDepositor + 2x MockVault to Sepolia
│
├── frontend/
│   ├── index.html                  # App shell — vis.js + ethers.js v6 + Viem via CDN
│   ├── app.js                      # State machine: input→strategy→skills→execute→done
│   ├── orchestrator.js             # Orchestrator Agent: receives plan, dispatches workers
│   ├── worker.js                   # Worker Agent: single vault Swap→Approve→Deposit
│   ├── skills.js                   # Skill file generator + UI for review/edit
│   ├── memory.js                   # Memory file reader/writer + UI renderer
│   ├── graph.js                    # vis.js Network controller: nodes, edges, real-time update
│   ├── wallet.js                   # EIP-7702 upgrade + ERC-7715 per-agent permission
│   ├── relay.js                    # 1Shot relay request builder + execution
│   ├── venice.js                   # Venice AI: strategy generation + skill auto-generation
│   ├── ui.js                       # DOM helpers, step tracker, status badges
│   └── style.css                   # Port from design/styles.css
│
├── agents/                         # Runtime-generated (gitignored in prod, committed for demo)
│   ├── session-{id}/
│   │   ├── agent-1-skills.json     # Worker Agent 1 skill set
│   │   └── agent-2-skills.json     # Worker Agent 2 skill set
│   └── memory/
│       ├── agent-1-memory.json     # Worker Agent 1 execution memory
│       └── agent-2-memory.json     # Worker Agent 2 execution memory
│
├── design/                         # ✅ EXISTS — v2 prototype, reference
│
├── docs/                           # ✅ EXISTS — all in Indonesian
│
├── .env                            # Never commit — copy from .env.example
├── .env.example                    # ✅ EXISTS
├── foundry.toml                    # ✅ EXISTS
├── CLAUDE.md                       # ✅ EXISTS — Claude Code guidance
├── DESIGN.md                       # ✅ EXISTS — UI spec
└── GETTING_STARTED.md              # ✅ This file
```

---

## 3. Build Order

Dependencies flow top-to-bottom. Don't skip ahead.

```
[Spike results reviewed]
        ↓
foundry init check (already done)
        ↓
MockVault.sol (simpler, no deps — deploy 2 instances)
        ↓
AgentVaultDepositor.sol (depends on MockVault interface)
        ↓
forge test (≥ 80% coverage gate)
        ↓
forge script Deploy.s.sol → Sepolia (2x MockVault + 1x AgentVaultDepositor)
        ↓
frontend/wallet.js       ← MetaMask SAK + EIP-7702 + ERC-7715 per-agent
        ↓
frontend/relay.js        ← 1Shot relay for Worker Agents
        ↓
frontend/venice.js       ← Venice AI strategy + skill generation
        ↓
frontend/skills.js       ← Skill file generator + review UI
        ↓
frontend/memory.js       ← Memory file writer + display UI
        ↓
frontend/worker.js       ← Worker Agent: single vault flow
        ↓
frontend/orchestrator.js ← Orchestrator: parallel Worker dispatch
        ↓
frontend/graph.js        ← vis.js Network: real-time agent graph
        ↓
frontend/app.js          ← Wire everything: state machine + event listeners
        ↓
frontend/index.html      ← Final UI (port from design/)
        ↓
End-to-end Sepolia test (2 parallel Worker Agents)
        ↓
Demo video
```

---

## 4. Contract Spec

### `MockVault.sol`

```
ERC-4626 minimal mock.
State:
  - balances: mapping(address → uint256) shares
  - totalDeposited: uint256
  - name: string  (e.g. "MockVault USDC-A", "MockVault USDC-B")

Functions:
  deposit(uint256 assets, address receiver) → shares
  balanceOf(address) → uint256
  totalAssets() → uint256
  asset() → address  (returns mock USDC address)

No real yield logic — shares = assets 1:1 for demo.
APY data lives in frontend mock, not on-chain.
Deploy 2 instances for parallel agent demo.
```

### `AgentVaultDepositor.sol`

```
State:
  agentPermissions: mapping(address user => mapping(bytes32 agentId => AgentPermission))
    AgentPermission { address vault, uint256 maxAmount, uint256 usedAmount, uint256 expiresAt, bool active }

Events (frontend + vis.js graph must listen):
  AgentStarted(bytes32 indexed agentId, address user, address vault)
  SwapExecuted(bytes32 indexed agentId, address user, uint256 amountIn, uint256 amountOut)
  ApproveExecuted(bytes32 indexed agentId, address user, address vault, uint256 amount)
  DepositExecuted(bytes32 indexed agentId, address user, address vault, uint256 amount, uint256 shares)
  AgentCompleted(bytes32 indexed agentId, address user, address vault, uint256 shares)
  AgentFailed(bytes32 indexed agentId, address user, string reason)

External functions:
  grantAgentPermission(bytes32 agentId, address vault, uint256 maxAmount, uint256 expiresAt)
  revokeAgentPermission(bytes32 agentId)
  executeAgentDeposit(bytes32 agentId, address user, address vault, uint256 amount)
    → CEI pattern:
      CHECKS: validateAgentPermission(agentId, user, vault, amount)
      EFFECTS: permissions[user][agentId].usedAmount += amount
      INTERACTIONS: executeSwap → approve → MockVault.deposit()

Security invariants (revert, never silent fail):
  amount <= agentPermissions[user][agentId].maxAmount - usedAmount
  vault == agentPermissions[user][agentId].vault
  block.timestamp < agentPermissions[user][agentId].expiresAt
  agentPermissions[user][agentId].active == true
  ReentrancyGuard on executeAgentDeposit
  No admin roles
```

---

## 5. Frontend Module Responsibilities

### `venice.js`
- POST to `https://api.venice.ai/api/v1/chat/completions`
- Model: `llama-3.3-70b`, `response_format: json_object`, `venice_parameters.include_venice_system_prompt: false`
- **Strategy prompt:** user amount + risk + N vaults → multi-vault allocation JSON
- **Skill generation prompt:** for each agent's step type → skill parameters JSON
- Timeout: 10s; fallback to hardcoded mock strategy
- Expected output shape:
  ```json
  {
    "strategy": [
      { "vaultAddress": "0xVaultA", "amount": "50000000", "vaultName": "MockVault USDC-A" },
      { "vaultAddress": "0xVaultB", "amount": "50000000", "vaultName": "MockVault USDC-B" }
    ],
    "agents": [
      {
        "agentId": "worker-agent-1",
        "vault": "0xVaultA",
        "skills": {
          "swap": { "maxSlippage": 0.5, "dexPreference": "uniswap-v3", "maxRetries": 2, "timeoutSeconds": 30 },
          "deposit": { "maxAmount": "50000000", "vaultAddress": "0xVaultA", "expiresAt": 1749686400 }
        }
      }
    ]
  }
  ```

### `skills.js`
- Receive skill JSON from `venice.js`
- Render editable skill cards per agent (slippage input, DEX select, max amount)
- User approves → `skills.approve(agentId)` sets `approvedByUser: true`
- Write approved skill to `agents/session-{id}/agent-{n}-skills.json`

### `memory.js`
- After each Worker completes: write memory entry to `agents/memory/agent-{n}-memory.json`
- Read memory at session start (pass to Venice AI for context)
- Render memory entries in vis.js node detail panel

### `worker.js` (Worker Agent)
- Receive: agentId, vault, amount, skill JSON, permissionContext
- Execute: `grantAgentPermission` → 1Shot relay `executeAgentDeposit`
- Listen: `AgentStarted`, `SwapExecuted`, `ApproveExecuted`, `DepositExecuted`, `AgentCompleted`, `AgentFailed`
- Write memory on completion/failure
- Respect skill params: maxRetries, maxSlippage, timeout

### `orchestrator.js` (Orchestrator Agent)
- Receive plan from `venice.js`
- Instantiate N Worker Agents
- Dispatch all via `Promise.allSettled()` (one failure doesn't abort others)
- Aggregate results → write orchestrator memory summary

### `graph.js`
- Init vis.js Network with nodes: Orchestrator + Worker Agents + Vault targets
- Edges: Orchestrator→Worker, Worker→Vault
- Listen to contract events: update node color/status in real-time
  - idle: gray, running: blue, confirmed: green, failed: red
- Click handler: show agent detail panel with skill JSON + memory entries

### `wallet.js`
- Detect MetaMask Flask extension
- `eth_requestAccounts` → get EOA address
- EIP-7702 authorization via Viem + MetaMask SAK
- For each agent: `wallet_requestExecutionPermissions` (ERC-7715) → `permissionContext`
- Store `permissionContext` per agentId in `sessionStorage`
- `revokeAgentPermission(agentId)` call

### `relay.js`
- Build 1Shot relay request payload from `permissionContext` + agentId + calldata
- POST to `https://relayer.1shotapi.com/relayers` (JSON-RPC)
- Poll for tx confirmation
- Return tx hashes for each step
- Retry 1x on timeout

---

## 6. Integration Points & Gotchas

| Integration | Gotcha |
|-------------|--------|
| ethers.js v6 | `provider.getSigner()` is async. `BigInt` not `BigNumber`. |
| MetaMask Flask | Regular MetaMask will NOT work — Flask 13.9+ required. |
| 1Shot relay | `from` in relayed tx = relayer address (not user wallet). Show this on Etherscan. |
| Venice AI | `venice_parameters.include_venice_system_prompt: false` required for clean JSON output. |
| Parallel Workers | Use `Promise.allSettled()` — not `Promise.all()`. One failure must not abort others. |
| vis.js events | `contract.on(eventName, ...)` via ethers.js v6. Update node data with `nodes.update({id, color})`. |
| Skill files | Write to `agents/` directory. For live demo, pre-populate with Venice AI output. |
| Memory files | Append-only JSON array. Read entire file, push new entry, write back. |
| AgentId | Use `ethers.keccak256(ethers.toUtf8Bytes("agent-1"))` to generate bytes32 agentId. |

---

## 7. Environment Setup

```bash
# 1. Install Foundry (WSL)
wsl -e bash -c "curl -L https://foundry.paradigm.xyz | bash && foundryup"

# 2. Install OpenZeppelin (WSL)
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge install OpenZeppelin/openzeppelin-contracts"

# 3. Copy env
cp .env.example .env
# Fill: SEPOLIA_RPC, PRIVATE_KEY, VENICE_API_KEY

# 4. Create agents directories
mkdir -p agents/memory

# 5. Serve frontend
npx serve frontend/
```

`foundry.toml` config:
```toml
[profile.default]
src = "contracts"
out = "out"
libs = ["lib"]
solc = "0.8.24"

[rpc_endpoints]
sepolia = "${SEPOLIA_RPC}"

[etherscan]
sepolia = { key = "${ETHERSCAN_API_KEY}" }
```

---

## 8. MVP Completion Checklist

Before recording demo video:

**Smart Contracts**
- [ ] `forge build` clean
- [ ] `forge test` all pass
- [ ] `forge coverage` ≥ 80%
- [ ] AgentVaultDepositor + 2x MockVault deployed to Sepolia
- [ ] Contract addresses in `.env`

**Frontend — Core**
- [ ] Venice AI generates strategy + skill sets (2 agents shown)
- [ ] Skill review UI renders — user can edit slippage/amount
- [ ] Orchestrator dispatches 2 Worker Agents in parallel
- [ ] vis.js graph shows Orchestrator → Worker1 → VaultA and Orchestrator → Worker2 → VaultB
- [ ] Graph nodes update in real-time from on-chain events
- [ ] Memory entries visible in node detail panel after completion

**Frontend — Web3**
- [ ] Wallet connect → EIP-7702 upgrade visible in MetaMask Flask
- [ ] ERC-7715 permission dialog appears per agent
- [ ] 1Shot relay fires — `from` = relayer on Sepolia Etherscan
- [ ] `AgentCompleted` events render success in graph

**Demo Video Must Show (≤ 5 min)**
- [ ] Venice AI generating strategy + skill sets
- [ ] Skill review + approve step
- [ ] EIP-7702 EOA upgrade in MetaMask Flask
- [ ] 2 Workers running in parallel (vis.js graph)
- [ ] Deposit txs on Sepolia Etherscan — `from` = 1Shot relayer
- [ ] Memory entries shown in agent node
- [ ] Success: both vaults deposited

**Architecture Pillars Demonstrated**
- [ ] Secure Smart Swarm — skill system + memory visible
- [ ] Privacy-First AI Recommendation — strategy + skill generation shown
- [ ] Autonomous Parallel Orchestration — parallel Orchestrator→Worker dispatch shown
- [ ] Complete Gas Abstraction — 1Shot relayer gas sponsoring evidenced on Etherscan

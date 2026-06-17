# CLAUDE.md

This file provides guidance to Agent when working with code in this repository.

## Project: Vibing Farmer

**Tagline:** "Set once. Vibe forever."  
**Motivation:** Built out of frustration with complex, click-heavy sequential yield farming workflows.
**Goal:** Empower users with autonomous, parallel multi-vault deposits governed by secure cryptographic boundaries.

**Core product:** AI-coordinated agent swarm for automated multi-vault yield farming. Venice AI generates strategy + per-agent skill sets. User approves skills once. Orchestrator Agent dispatches Worker Agents in parallel — each executing Swap → Approve → Deposit for one vault. All transactions via ERC-7715 scoped permission + 1Shot Permissionless Relayer. Real-time vis.js graph monitors agent network and memory.

**Vision:** Web3 → Web4 transition primitive. Users express intent, agents execute autonomously, blockchain enforces boundaries cryptographically.

> **Note:** All docs in `docs/` are written in English.

---

## Core Architecture Focus

| Component | Technical Choice | Purpose |
|-----------|------------------|---------|
| Smart Swarm | Multi-agent skill system | Granular agent delegation + local memory |
| Privacy-First AI | Venice AI (Llama-3.3-70b) | Strategy and per-agent skill auto-generation |
| Agent-to-Agent | Orchestrator & parallel Workers | Parallel execution for optimal DeFi UX |
| Gas Abstraction | 1Shot Relayer & EIP-7702 | Zero-gas transactions under ERC-7715 scoped boundaries |

---

## Current Phase

Timeline: 20 days total (26 Mei – 15 Juni 2026)

| Phase | Days | Focus |
|-------|------|-------|
| 1 — Foundation | 1–3 | Solidity review + EIP-7702/ERC-7715 study |
| 2 — Smart Contract | 4–8 | AgentVaultDepositor.sol + tests |
| 3 — Integration | 9–13 | 1Shot + Orchestrator/Worker agents + vis.js graph + Sepolia test |
| 4 — Polish | 14–17 | Bug fix, Venice AI skill gen, memory UI, demo video |
| 5 — Publish | 18–20 | Open source publishing |

**All 4 spikes resolved. ✅ See `docs/spikes/` for full findings. Key decisions below.**

---

## Core Architecture

```
User Input (amount, risk level, # of vaults)
        │
        ▼
Venice AI Coordinator
  ├── Generate multi-vault allocation strategy
  └── Auto-generate skill set JSON per agent per step
        │
        ▼
User Reviews + Edits Generated Skills (UI)
        │
        ▼
Orchestrator Agent (JavaScript, frontend)
  ├── Receives plan from Venice AI
  ├── Dispatches Worker Agents in PARALLEL
  └── Aggregates results + memory
        │
   ┌────┼────┐
   ▼    ▼    ▼
Worker  Worker  Worker   (one per vault, parallel)
Agent1  Agent2  AgentN
  │ Skill: swap-skill.json, deposit-skill.json
  │ Each: Swap → Approve → Deposit
  │ Via: ERC-7715 permission + 1Shot relay
  └──► AgentVaultDepositor.sol (Sepolia)
              └──► MockVault.sol (ERC-4626)
        │
        ▼
Agent Memory Files (JSON, per agent per session)
        │
        ▼
vis.js Network Graph (real-time, browser)
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
  "vaultAddress": "0xABCD...",
  "skills": {
    "swap": {
      "maxSlippage": 0.5,
      "dexPreference": "uniswap-v3",
      "maxRetries": 2,
      "timeoutSeconds": 30
    },
    "deposit": {
      "maxAmount": "100000000",
      "vaultAddress": "0xABCD...",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

Venice AI auto-generates skills based on step type. User reviews/edits before execution. Stored as `agents/session-{id}/agent-{n}-skills.json`.

---

## Memory System

Each agent writes a memory file after execution:

```json
{
  "agentId": "worker-agent-1",
  "sessionId": "session-20260527-001",
  "vault": "0xABCD...",
  "entries": [
    {
      "timestamp": 1748387200,
      "step": "swap",
      "status": "success",
      "gasUsed": 45000,
      "slippageActual": 0.12,
      "executionTimeMs": 4200,
      "lesson": "Vault A accepts 0.5% slippage reliably"
    }
  ]
}
```

Memory stored as `agents/memory/agent-{n}-memory.json`. Displayed in vis.js node detail. Read on next execution for context.

---

## Directory Structure

```
design/                              # UI prototype — reference implementation
  Vibing Farmer Prototype.html       # v2 current — React 18 + Babel CDN
  styles.css                         # v2 design tokens + all components
  src/
    app.jsx                          # State machine, right rail, palette picker
    components.jsx                   # Icon, Sidebar, TopBar, StepRail
    screens.jsx                      # Screen components
    tweaks-panel.jsx                 # Tweak form controls

contracts/
  AgentVaultDepositor.sol            # Core — multi-agent permission + execution
  MockVault.sol                      # ERC-4626 mock vault for Sepolia demo

test/
  AgentVaultDepositor.t.sol          # Forge tests — success, violations, fuzz
  MockVault.t.sol                    # ERC-4626 compliance checks

script/
  Deploy.s.sol                       # Deploys AgentVaultDepositor + MockVault

frontend/
  index.html                         # App shell — vis.js + ethers.js v6
  app.js                             # State machine + event wiring
  orchestrator.js                    # Orchestrator Agent: plan dispatch
  worker.js                          # Worker Agent: single vault flow
  skills.js                          # Skill file generator + editor UI
  memory.js                          # Memory file reader/writer + UI
  graph.js                           # vis.js Network graph controller
  wallet.js                          # EIP-7702 + ERC-7715 + MetaMask SAK
  relay.js                           # 1Shot API relay builder + execution
  venice.js                          # Venice AI: strategy + skill generation
  ui.js                              # DOM helpers, step tracker
  style.css                          # Port from design/styles.css

agents/                              # Runtime-generated skill + memory files
  session-{id}/
    agent-{n}-skills.json            # Per-agent skill set
  memory/
    agent-{n}-memory.json            # Per-agent execution memory

docs/                                # All in English
  technical-architecture.md
  technical-blockchain-usage.md
  technical-security-privacy.md
  technical-api-events.md
  technical-database.md
  product-demo-scenario.md            # Demo script — read before recording
  product-features-complete.md
  product-user-stories.md
  business-impact-model.md
  business-roadmap-backlog.md
  spikes/                            # All 4 spikes ✅ resolved
```

---

## Commands

### Smart Contracts (Foundry — WSL only)

```bash
# Build
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge build"

# Test all
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test"

# Single test verbose
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-test testFunctionName -vvv"

# Fuzz test
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-test testFuzz -vvv --fuzz-runs 1000"

# Coverage (target ≥ 80%)
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge coverage"

# Deploy to Sepolia
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge script script/Deploy.s.sol --rpc-url \$SEPOLIA_RPC --broadcast --verify"
```

> ⚠️ **Foundry runs in WSL only.** Never run `forge`/`cast`/`anvil` directly in PowerShell — it will fail.

### Frontend

```bash
# Serve locally
npx serve frontend/

# Serve design prototype (reference)
npx serve design/
```

### Environment Variables

Copy `.env.example` → `.env` before deployment or API testing:

```bash
SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0x...                      # deployer key (never commit)
VENICE_API_KEY=...                     # Venice AI API key
AGENT_VAULT_DEPOSITOR_ADDRESS=0x...    # filled after deploy
MOCK_VAULT_ADDRESS=0x...               # filled after deploy (can be multiple)
```

1Shot Permissionless Relayer requires no API key — pure JSON-RPC.

---

## Smart Contract: AgentVaultDepositor.sol

```solidity
// Permission per agent (not per user)
struct AgentPermission {
    address allowedVault;
    uint256 maxAmount;
    uint256 usedAmount;
    uint256 expiresAt;
    bool isActive;
    bytes32 agentId;
}

mapping(address user => mapping(bytes32 agentId => AgentPermission)) public agentPermissions;

// Events — frontend + graph must listen
event AgentStarted(bytes32 indexed agentId, address user, address vault);
event SwapExecuted(bytes32 indexed agentId, address user, uint256 amountIn, uint256 amountOut);
event ApproveExecuted(bytes32 indexed agentId, address user, address vault, uint256 amount);
event DepositExecuted(bytes32 indexed agentId, address user, address vault, uint256 amount, uint256 shares);
event AgentCompleted(bytes32 indexed agentId, address user, address vault, uint256 shares);
event AgentFailed(bytes32 indexed agentId, address user, string reason);

// Core functions
function grantAgentPermission(bytes32 agentId, address vault, uint256 maxAmount, uint256 expiresAt) external;
function executeAgentDeposit(bytes32 agentId, address user, address vault, uint256 amount) external;
function revokeAgentPermission(bytes32 agentId) external;
```

---

## User Flow

1. Connect MetaMask Flask → EIP-7702 upgrades EOA to smart account
2. User inputs: amount, risk level, number of vaults
3. Venice AI generates: multi-vault strategy + skill JSON per agent
4. User reviews skills in UI → edits if needed → approves
5. Orchestrator Agent dispatches N Worker Agents in parallel
6. Each Worker Agent: ERC-7715 permission grant → 1Shot relay → AgentVaultDepositor
7. AgentVaultDepositor: validates scope → Swap → Approve → Deposit to MockVault
8. Events emitted → vis.js graph updates in real-time
9. Agents write memory files → displayed in graph node detail
10. Summary: N vaults deposited, total shares, total APY earned

---

## ADR Decisions

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Contract framework | Foundry | Hardhat | Native Solidity tests, fast, DeFi standard |
| Frontend vis library | vis.js Network | D3.js, Neo4j | Simpler force-directed graph, no backend needed |
| Agent execution | Parallel (Promise.all) | Sequential | Demo value: showcase A2A coordination |
| AI layer | Venice AI | OpenAI/Anthropic | Privacy-first, open-source model, OpenAI-compatible |
| Vault | MockVault.sol (ERC-4626) | Real protocol | Full demo control, no external deps |

---

## Key Implementation Notes

**⚠️ MetaMask Flask required** — NOT regular MetaMask Extension. Flask 13.9.0+ required for ERC-7715. Download: https://metamask.io/flask/

**EIP-7702 on Sepolia** — Live since March 5, 2025 (Pectra upgrade). No blockers.

**Frontend stack:**
```html
<script type="module">
  import { createWalletClient, custom } from 'https://esm.sh/viem'
  import { erc7715ProviderActions } from 'https://esm.sh/@metamask/smart-accounts-kit/actions'
</script>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
```

**Venice AI:** `https://api.venice.ai/api/v1` (OpenAI-compatible). Model: `llama-3.3-70b`. Use `response_format: { type: 'json_object' }` + `venice_parameters: { include_venice_system_prompt: false }`. Timeout 10s, hardcoded fallback.

**1Shot API** — Permissionless Relayer. No API key. POST to `https://relayer.1shotapi.com/relayers` (JSON-RPC). Pass `permissionContext` + `delegationManager`.

**ethers.js v6** — `provider.getSigner()` is async. `BigInt` not `BigNumber`.

**Parallel agents** — Use `Promise.allSettled()` not `Promise.all()` so one agent failure doesn't abort others.

**Security — enforce in AgentVaultDepositor:**
- Amount ≤ agentPermissions[user][agentId].maxAmount (revert, never silent fail)
- Vault == agentPermissions[user][agentId].allowedVault (revert)
- `block.timestamp < expiresAt` (revert if expired)
- CEI pattern: all checks before all interactions
- No privileged admin roles post-deploy
- ReentrancyGuard on `executeAgentDeposit`

---

## Technical Spikes

All resolved ✅. See `docs/spikes/` for full research.

| Spike | Status | Key Finding |
|-------|--------|-------------|
| EIP-7702 + MetaMask SAK | ✅ | Sepolia live since Mar 5 2025. Use Viem ESM CDN. Flask 13.9+ required. |
| ERC-7715 scoped permissions | ✅ | AgentVaultDepositor uses own storage. ERC-7715 for UI demo. |
| 1Shot API relayer | ✅ | Permissionless Relayer (`relayer.1shotapi.com/relayers`). No API key. Pure JSON-RPC. |
| Venice AI capabilities | ✅ | OpenAI-compatible. Model: `llama-3.3-70b`. Use OpenAI SDK via ESM CDN. |

---

## Key Docs

- [Design system + component spec](DESIGN.md) — read before touching frontend/UI
- [Architecture + ADRs + NFRs](docs/technical-architecture.md)
- [On-chain scope + audit trail](docs/technical-blockchain-usage.md)
- [Security constraints](docs/technical-security-privacy.md)
- [Demo script](docs/product-demo-scenario.md) — read before recording
- MetaMask Smart Accounts Kit: https://docs.metamask.io/wallet/smart-accounts/
- EIP-7702: https://eips.ethereum.org/EIPS/eip-7702
- ERC-7715: https://eips.ethereum.org/EIPS/eip-7715
- 1Shot API: https://1shotapi.com/docs
- Venice AI: https://venice.ai/
- vis.js Network: https://visjs.github.io/vis-network/docs/network/

# Demo Scenario — Vibing Farmer

> **Skill Reference:** mobile-developer + blockchain-developer + cognitive-fluency-psychology
> **Version:** 2.0 | **Date:** May 27, 2026
> **Purpose:** End-to-end sandbox walkthrough and demonstration guide

---

## 1. Demo Objectives

To demonstrate that Vibing Farmer successfully automates a multi-vault deposit flow using an agent swarm—from intent input to confirmation of all vaults on Sepolia. This workflow features Venice AI as the coordinator, a user-reviewable skill system, and real-time visualization on a vis.js graph.

**Core Demo Narrative:**
> "You have 100 USDC. Typically, this requires 8 MetaMask popups per vault and 15 minutes of your time. With Vibing Farmer, Venice AI automatically generates the strategy and agent skill sets. You review and approve them once, and the agent swarm executes two parallel vaults—completely gasless. Set once. Vibe forever."

---

## 2. Demo Personas

| Persona | Name | Profile |
|---------|------|--------|
| Active Yield Farmer | Arya | Has 100 USDC, wants efficient multi-vault yield farming, wishes to avoid repeating 8 popups per vault |
| Observer / Developer | External Reviewer | Evaluating the integration of MetaMask, 1Shot, Venice AI, and agent coordination |

---

## 3. Step-by-Step Demo Flow

### Step 0: Preparation (Pre-Recording)

- MetaMask Flask installed (not regular MetaMask) with a Sepolia account ready.
- AgentVaultDepositor and 2x MockVault deployed on Sepolia.
- 100 testnet USDC available in the demo wallet.
- Venice AI API key configured.
- `agents/memory/` contains at least one memory entry from a previous session (optional, but highly recommended to showcase memory capability).

---

### Step 1: Input Intent into Venice AI (0:00–0:45)

1. Open Vibing Farmer in the browser.
2. Show the input form:
   - "How much USDC do you have?" → 100 USDC
   - "Risk level?" → Low
   - "How many vaults?" → 2
3. Click "Generate Strategy".
4. Venice AI returns a response:
   - **Strategy:** 50 USDC to MockVault USDC-A (APY: 7.8%), 50 USDC to MockVault USDC-B (APY: 8.2%).
   - **Agent 1 skills:** `{ swap: { maxSlippage: 0.5, dexPreference: "uniswap-v3" }, deposit: { maxAmount: 50000000, vault: "0xVaultA" } }`
   - **Agent 2 skills:** `{ swap: { maxSlippage: 0.5, dexPreference: "uniswap-v3" }, deposit: { maxAmount: 50000000, vault: "0xVaultB" } }`
   - **Privacy note:** "This strategy is processed via Venice AI — no data is retained."

**Visuals shown:** Strategy card + 2 skill cards (Agent 1 and Agent 2).

---

### Step 2: Review & Approve Skill Sets (0:45–1:15)

1. The UI displays two editable Skill Cards:
   - **Agent 1:** maxSlippage: 0.5% | vault: MockVault USDC-A | maxAmount: 50 USDC
   - **Agent 2:** maxSlippage: 0.5% | vault: MockVault USDC-B | maxAmount: 50 USDC
2. Demo action: change Agent 2 maxSlippage to 0.3% (to showcase editability).
3. Click "Approve Skill Sets".
4. UI updates: "Skills approved — agents ready" ✓

**Visuals shown:** Editable skill form + approve button.

---

### Step 3: Connect Wallet + EIP-7702 Upgrade (1:15–2:00)

1. Click the "Connect Wallet" button.
2. MetaMask Flask popup appears → select account.
3. The app detects the account as an EOA.
4. Information displayed: "Your account will be upgraded to a Smart Account via EIP-7702".
5. MetaMask Flask displays the authorization request.
6. The user signs the transaction → the account now functions as a smart account.
7. UI updates: "Smart Account Active" badge ✓

**Visuals:** MetaMask Flask authorization dialog + status badge (EOA → Smart Account).

---

### Step 4: Grant the ERC-7715 Advanced Permission (2:00–2:30)

1. The UI displays ONE permission summary: "Authorize up to **100 USDC** total, capped and
   expiring in 24 hours, redeemable by the gasless relayer to fund your vault deposits."
2. The user clicks "Grant Permission".
3. MetaMask (Smart Accounts Kit) displays the `wallet_requestExecutionPermissions` dialog for a
   single `erc20-token-periodic` Advanced Permission (cap = total, grantee = the 1Shot relayer).
4. The user approves once → UI updates: "Permission active — agents can now fund deposits" ✓
5. Separately, the orchestrator batches one `AgentRegistry.authorizeSessionKey` per agent into a
   single popup (the per-agent vault/cap/expiry scope). No USDC `approve` is needed.

**Visuals:** One Advanced-Permission card + MetaMask dialog; then the batched scope popup.

---

### Step 5: Agent Swarm Parallel Execution (2:30–3:30)

1. The vis.js Network graph appears:
   - Center node: **Orchestrator Agent** (blue, running)
   - Edges connecting to: **Worker Agent 1** (grey) + **Worker Agent 2** (grey)
   - Edges from Workers to: **MockVault A** + **MockVault B**

2. Click "Launch Agent Swarm" → Orchestrator dispatches Workers in parallel.

3. **Worker Agent 1** (left):
   - `started` → node changes from grey to blue (running)
   - `redeem-permission` → "Redeemed AP slice: 50 USDC → depositor ✓" (the relayer's `transfer`)
   - `deposit` → `AgentDepositExecuted` on-chain → node changes from blue to green (confirmed) ✓

4. **Worker Agent 2** (right, running simultaneously):
   - Performs the exact same steps as Agent 1 but targeted at VaultB.
   - Both agents run **simultaneously on the graph**.

5. `AgentCompleted` events → all nodes turn green.
6. No MetaMask popups appear during execution (all actions occur via 1Shot relay).

**Visuals:** A vis.js graph showing two Workers running in parallel with nodes changing color in real-time.

---

### Step 6: Memory in Node Details (3:30–3:50)

1. Click the **Worker Agent 1** node on the graph.
2. The details panel appears:
   - Skills utilized: `{ swap: { maxSlippage: 0.5 }, deposit: { maxAmount: 50000000 } }`
   - Memory entries:
     ```
     step: swap | status: success | executionTime: 4.2s | slippage: 0.12%
     step: deposit | status: success | shares: 50023456 | executionTime: 3.8s
     lesson: "MockVault A reliable with 0.5% slippage"
     ```
3. Explain that this memory will be read by Venice AI in subsequent executions.

**Visuals:** Node details panel with the skill JSON and memory entries.

---

### Step 7: Verification on Base Sepolia (3:50–4:20)

1. Click the explorer link on one of the Agent nodes.
2. Show the two transactions on Base Sepolia:
   - The **redeem**: `from` = the 1Shot server wallet, calling `DelegationManager` → `USDC.transfer`
     into the depositor (under the period cap).
   - The **deposit**: `AgentDepositExecuted(agent, owner, vault, token, assetsIn, sharesOut, execId)`.
   - Both have `from` = the relayer (NOT the user's wallet) → gas abstraction; MockVault balance ↑.

---

### Step 8: Closing (4:20–4:45)

- Summary:
  - "100 USDC → deposited into 2 vaults in < 60 seconds."
  - "Venice AI generates the strategy and skills, which the user reviews once."
  - "2 parallel agents, 0 gas, 0 manual transactions."
  - "Set once. Vibe forever."
- Emphasize the modular open-source design.

---

## 4. Demo Readiness Checklist

**Smart Contracts**
- [ ] AgentVaultDepositor + 2x MockVault deployed on Sepolia.
- [ ] Contract addresses hardcoded in the frontend or `.env`.
- [ ] All `forge` tests pass.

**Frontend**
- [ ] Venice AI strategy and skill generation function with a valid API key.
- [ ] Editable skill review UI and approval flow functional.
- [ ] vis.js graph initialized and visualizing 2 Workers.
- [ ] Graph nodes update in real-time based on on-chain events.
- [ ] Memory panel displays when clicking nodes.
- [ ] 1Shot relay configured and successfully tested on Sepolia.
- [ ] EIP-7702 upgrade visible in MetaMask Flask.
- [ ] ERC-7715 permission dialog displayed (per agent or batched).

**Demo Environment**
- [ ] MetaMask Flask (not regular MetaMask) installed in the demo browser.
- [ ] 100 testnet USDC available in the demo wallet.
- [ ] Venice AI API key is valid and response has been tested.
- [ ] Stable internet connection during recording.
- [ ] Screen recorder ready (resolution ≥ 1080p).
- [ ] Narration script prepared.

---

## 5. Expected Outcomes

| Outcome | Target |
|---------|--------|
| Full flow finishes without errors | ✓ (Mandatory) |
| Venice AI strategy & skill generation visible | ✓ (Privacy AI Integration) |
| Skill review & edit step visible | ✓ (Granular Agent Control) |
| 2 Workers running in parallel on the graph | ✓ (A2A Swarm Parallelization) |
| EIP-7702 upgrade visible in MetaMask Flask | ✓ (Smart Account Foundations) |
| ERC-7715 permission dialog displayed per agent | ✓ (Scoped Boundary Security) |
| 1Shot relay transactions visible on Etherscan | ✓ (Complete Gas Abstraction) |
| Agent memory visible in node details | ✓ (Traceable Swarm State) |
| Demo duration | ≤ 5 minutes |
| User interactions (clicks) during the demo | ≤ 8 clicks |

---

## 6. Demo Flow (Final — Phase 4)

### Scene 1: Load App (30s)
- Open http://localhost:3000.
- Show the dark 3-column layout.
- Console: "Vibing Farmer ready. Connect wallet to start."

### Scene 2: Connect Wallet (30s)
- Click "Connect Wallet" → MetaMask Flask popup appears.
- After connecting: step dot "01 Connect" turns green, right rail displays address + "eip-7702 ready".

### Scene 3: Venice AI Strategy (60s)
- Input: Amount 10 USDC, Risk Medium, Vaults 2, Venice API Key.
- Click "Generate Strategy".
- Show: Graph appears — Orchestrator (yellow) + 2 Workers (grey) + 2 Vaults (purple).
- Activity log displays Venice AI rationale (not the fallback).

### Scene 4: Node Details (30s)
- Click the Orchestrator node → right rail shows agent counts.
- Click Worker 1 → displays Agent ID, Vault address, and Skills (Venice-generated JSON).

### Scene 5: ERC-7715 Permission (60s)
- Click "Approve & Execute".
- MetaMask Flask popup displays: erc20-token-periodic, USDC, 24h expiry.
- Approve → "Permission granted. Dispatching agents..."

### Scene 6: Agent Execution (60s)
- Workers turn blue (active).
- Workers turn green (completed).
- Activity log displays: "Done — 2 deposited, 0 failed".
- Step "04 Execute" turns green.

### Scene 7: Memory Entries (30s)
- Click the Worker node AFTER execution.
- Memory entries display: step names, ✓ status, timestamps, and lesson text.

### Scene 8: Reset (15s)
- Click "Reset" → clears state and localStorage.

---

## 7. Lifeboat Demo Beat (Stellar/Soroban — live system)

> The rest of this document predates the EVM→Stellar migration (see `CLAUDE.md`) and is kept as
> historical demo-flow reference. This beat covers the automated emergency de-risk feature —
> vault `emergency_derisk`/`resume`/`lifeboat_state`, the keeper radar (`keeper/src/radar.js`),
> and the frontend `LifeboatPanel` — as it runs on the live Stellar testnet deploy.

1. **Grant the mandate.** In the LifeboatPanel, click "Grant 24h mandate" → the user signs
   `set_mandate(expiry = now + 24h)`. The panel flips to **ARMED** with a live countdown to
   expiry.
2. **Attack.** Run `whale-sim.mjs --attack` to drain pool liquidity and trigger the
   liquidity-crunch signal the keeper radar watches for.
3. **Engage.** Within ~1 ledger (~6 s) [live-measured engage latency to be recorded from the
   smoke run], the panel flips to **ENGAGED** and a "Lifeboat engaged · Liquidity drop" row
   appears in the event log — the radar detected the drop, confirmed a live mandate, and
   submitted `emergency_derisk`.
4. **Auto-resume.** After the calm window (the all-clear streak) elapses with no danger signal,
   the radar submits `resume` and the panel returns to **ARMED**.
5. **Honesty shot.** Let the mandate expire (do not renew it), then run `whale-sim.mjs --attack`
   again. The radar still detects the danger signal, but the mandate has expired — it fails
   closed and does NOT de-risk. The panel/log shows **"DISARMED — mandate expired, lifeboat
   cannot act"**. This is a deliberate demonstration of the safeguard's honest boundary: deposits
   and redemptions stay open throughout, but the automated de-risk/resume pair is powerless
   without a live, user-granted mandate.

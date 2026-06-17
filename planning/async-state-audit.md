# Async State Audit & UX Robustness Inventory

This document details the audit of all asynchronous actions, loading states, empty-state fallbacks, and error boundaries in the **Yield Vibing** Web3 frontend.

## 1. Async Actions & State Matrix

| Async Operation | Trigger Control | Loading Indicator | Disabled During Async? | Error Surf Location | Fallback / Safe State |
|:---|:---|:---|:---|:---|:---|
| **Wallet Connect** | Connect button (TopBar / stage card) | "Connecting..." text | Yes (button disabled) | Beneath action buttons in `ConnectCard` | Stays on EOA phase, prompts connect |
| **Wallet Upgrade (EIP-7702)** | Upgrade EOA button | "Upgrading..." text | Yes | ConnectCard error box | Safe fallback to EOA direct execution |
| **Network Switch** | Switch Network button | "Switching..." (browser dependent) | N/A | Log entry `AgentFailed` | Remains on active network, warns user |
| **ERC-7715 Scoped Grant** | mm-permission-modal confirm | Stage loading tick | Yes | Beneath permission text in `PermissionCard` | Fallback toDirect Execution/Manual Re-trigger |
| **Orchestrator Dispatch** | Auto-triggered after permission | Viscount nodes turning yellow/running | Yes (stage auto-advances) | Viscount node turning red + AgentFailed log | Hardcoded direct vault-advisor logic |
| **Withdraw (Manual)** | Withdraw button in positions row | "Withdrawing..." on button | Yes | Modal error box | Balances un-impacted, retains position |
| **Harvest (Manual)** | Alert card claim rewards | "Claiming..." state | Yes | Modal error box | Accrued rewards preserved |
| **Emergency Withdraw** | Alert card emergency exit | "Withdrawing..." | Yes | Modal error box | 1Shot relayer fallback / Direct tx |
| **Venice AI Strategy** | Start New Strategy button | 2D graph thinking nodes / loading card | Yes | Fallback strategy generated immediately | Static 4-vault strategy catalog fallback |
| **DeFiLlama APY Fetch** | Auto-fetch on homepage mount | Stays on cached state | N/A | Silent console.warn, uses cached catalog | Static 4-vault catalog (`config.js` / cache) |
| **Tavily Web Search** | Venice AI generation pipeline | N/A (part of Venice loading) | N/A | Venice fallback to static DeFi context | Fallback to static DeFi context |

## 2. Completed Polish Details

- [x] **Double-Click Gaps Resolved**: Disabled action buttons during wallet connect, manual withdraw, and permission approval to prevent duplicate RPC calls.
- [x] **Failure Logs surfaced**: Changed catch block `addLog` from `OrchestratorPlanned` to `AgentFailed` for connect failures.
- [x] **Error surrender**: Surfaced MetaMask / Relayer RPC execution errors directly in the card UI (`ConnectCard`, `PermissionCard`) and modal sheets (`WithdrawModal`) so judges are never left with a hung loading spinner.
- [x] **DeFiLlama/Tavily Timeout**: Gated external APIs with a strict 8s-10s timeout AbortController to guarantee instantaneous fallback rather than browser network hangs.

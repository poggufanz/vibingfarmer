# Roadmap v2 (Base Sepolia) — Plan Set INDEX

> **Source:** `planning/vibing_farmer_roadmap.md` (Spec-Grade Roadmap v2).
> **This index** = verification result + execution order across 5 phase plans.
> **For agentic workers:** each phase is its OWN plan file with full TDD tasks. Execute in the order below.

**Goal:** Harden Vibing Farmer from an accounting-only demo into a security-spine product where every safety bound has one on-chain source of truth, proven by tests.

**Verification date:** 2026-06-11 (via serena + graphify against working tree on branch `iq`).

---

## Verification result — roadmap vs actual project

### Already done / settled (DO NOT re-do)

| Roadmap item | Reality | Action |
|---|---|---|
| §0.1 Network = Base Sepolia 84532 | `foundry.toml` already `base_sepolia` + `[etherscan] chain 84532` | DONE. Only env-var name differs: repo uses `ETHERSCAN_API_KEY` (v2 multichain URL), not `BASESCAN_API_KEY`. Keep repo's. |
| §0.2/§0.3 "verify ERC-7715 on Base Sepolia — BLOCKER" | RESOLVED earlier. 7710 redeem of arbitrary contract calls is IMPOSSIBLE (enforcer `erc20-token-periodic` = `transfer()`-only, 68 bytes). See memory `eip7702-erc7715-findings`. | **Decision = Jalur B** (one-time `approve` + on-chain registry scope; each deposit is an **EIP-712 signature by the worker key**, submitted by any relayer). Jalur A (pure 7715 deposit) is dead. There is NO FunctionCall delegation on the deposit leg — the worker signs an EIP-712 message and the 1Shot relayer broadcasts it. All plans assume this. |
| Session-key authorization primitive | `AgentVaultDepositor.sol` already has `sessionKeys` mapping + `authorizeSessionKey`/`revokeSessionKey`; FunctionCall-delegation plan exists (`2026-06-09-session-redeemable-contract-calls.md`). | Reuse. Phase 1 moves scope into a dedicated `AgentRegistry` but keeps the session redemption model. |

### Real gaps the roadmap correctly identifies (NOT done)

| Gap | Evidence | Plan |
|---|---|---|
| Docs falsely claim worker Swap→Approve→Deposit via ERC-7715 | `README.md:18,44,85`; `docs/technical-blockchain-usage.md:16,192` | Phase 1, Task 1 |
| No dedicated `AgentRegistry.sol` (scope inline in depositor) | `contracts/` = only `AgentVaultDepositor.sol` + `MockVault.sol` | Phase 1, Task 2 |
| `executeAgentDeposit` over-parameterized (`agentId,user,vault,amount`) — vault/owner spoofable | `AgentVaultDepositor.sol:146-151` | Phase 1, Task 3 |
| **Contract never moves real ERC20** — `MockVault.deposit` is accounting-only (`shares=assets`, no `transferFrom`) | `MockVault.sol:44-54` | Phase 1, Task 3 + Phase 4 |
| No `execId` idempotency | grep `executed` → none | Phase 1, Task 3 |
| Cap is single `maxAmount`/`usedAmount`, not period-based | `AgentVaultDepositor.sol:18-26` | Phase 1, Task 2 |
| No `Pausable` / circuit breaker | only `ReentrancyGuard` | Phase 1, Task 3 + Phase 2, Task 3 |
| No fork tests (USDC depeg, Morpho Base) | no `test/simulation/` | Phase 3, Phase 4 |
| No invariant / destructive tests | — | Phase 4 |
| No `deployments/base-sepolia.json` | dir absent | Phase 1, Task 6 |

---

## Execution order (across plans)

```
Phase 1 — Trust Foundation     → 2026-06-11-roadmap-v2-phase1-trust-foundation.md
Phase 2 — Ops Security         → 2026-06-11-roadmap-v2-phase2-ops-security.md
Phase 3 — Historical Replay    → 2026-06-11-roadmap-v2-phase3-historical-replay.md
Phase 4 — Real Integration     → 2026-06-11-roadmap-v2-phase4-real-integration.md
Phase 5 — Refactor & UX        → 2026-06-11-roadmap-v2-phase5-refactor-ux.md
```

Phase 1 is the critical path (everything else depends on the new `AgentRegistry` + `executeAgentDeposit` signature). Phases 3 and 5 are independent of each other once Phase 1 lands; Phase 4 needs Phase 1 contracts.

## Shared type contract (consistent across all plans)

```solidity
// AgentRegistry.sol
struct AgentScope {
    address owner;          // immutable after set
    address vault;          // ERC-4626 target, one agent = one vault
    address token;          // vault underlying asset
    uint96  capPerPeriod;
    uint32  periodDuration; // seconds, > 0
    uint96  spentInPeriod;
    uint40  periodStart;
    uint40  expiry;
    bool    revoked;
}
function authorizeSessionKey(address agent, address vault, address token, uint96 capPerPeriod, uint32 periodDuration, uint40 expiry) external;
function revokeAgent(address agent) external;
function revokeMany(address[] calldata agents) external;
function isActive(address agent) external view returns (bool);
function scopeOf(address agent) external view returns (AgentScope memory);
function rollAndSpend(address agent, uint256 amount) external; // onlyDepositor
function scopesOfOwner(address owner) external view returns (address[] memory);
function setDepositor(address depositor) external; // once, by deployer

// AgentVaultDepositor.sol (Jalur B — approve + transferFrom; EIP-712 signed auth)
function hashDeposit(uint256 amount, uint256 minAmount, bytes32 execId) external view returns (bytes32);
function executeAgentDeposit(uint256 amount, uint256 minAmount, bytes32 execId, bytes calldata sig)
    external nonReentrant whenNotPaused returns (uint256 shares);
// agent = ECDSA.recover(hashDeposit(...), sig)  — NOT msg.sender.
// token, vault, owner all derived from registry.scopeOf(agent).
// EIP-712 type: AgentDeposit(uint256 amount,uint256 minAmount,bytes32 execId)
// domain: name="VibingFarmer", version="1", chainId, verifyingContract=depositor
```

> **Why signed, not `msg.sender`-keyed:** gasless via the 1Shot relayer means submitter ≠ authorizer. Keying scope by `msg.sender` would resolve every relayed call to the relayer's unscoped address → all deposits revert. The depositor recovers the worker-key signer instead; any address may submit. `execId` is the per-authorization replay guard.

> **DELETE-ON-IMPLEMENT:** Jalur A (7715 `transfer` leg) spec is retained in the roadmap doc for history only. Do not implement it — the project path is Jalur B.

## Global Definition of Done

Every security parameter has one on-chain source of truth; every docs/UI claim is provable by code or data; worst-case compromised-server loss is written as a number and proven by the destructive test (Phase 4, Task 4).

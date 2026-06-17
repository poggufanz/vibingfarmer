# Blockchain — Vibing Farmer

> **Skill Reference:** blockchain-developer + web3-expert
> **Version:** 3.0 | **Date:** June 14, 2026
> **Purpose:** Technical documentation of the on-chain integration: the two cryptographic
> boundaries (ERC-7715 Advanced Permission + AgentRegistry scope), the deposit-only depositor,
> audit trail, and risk analysis. This reflects the live Roadmap-v2 architecture.

---

## 1. Role of the Blockchain

The blockchain is the **execution layer** and the **permission enforcer** — not a data store. Two
independent, user-signed boundaries gate every movement of funds, and both are enforced on-chain:

1. **ERC-7715 Advanced Permission (AP)** — a single MetaMask Smart-Accounts-Kit grant
   (`erc20-token-periodic`) that caps *how much USDC can ever leave the user* within a period.
2. **AgentRegistry scope** — a per-agent grant that caps *which vault, how much, and until when*
   each worker key may deposit.

Both are load-bearing: the AP releases the funds, the registry authorizes the deposit. Neither
alone can move money to an unintended place. The user pays **zero gas** — a 1Shot Managed-API
server wallet sponsors every transaction.

**Network:** Base Sepolia (chainId **84532**)
**Standards used:**
- **ERC-7715:** `wallet_requestExecutionPermissions` — the user grants one capped, expiring
  `erc20-token-periodic` Advanced Permission to the redeemer (the 1Shot server wallet).
- **ERC-7710 / DelegationManager:** the AP is redeemed via `redeemDelegations` — the only
  execution the periodic enforcer permits is `IERC20.transfer`, which we point at the depositor.
- **EIP-712:** each worker key signs a typed `AgentDeposit` / `AgentHeldDeposit` struct; the
  depositor recovers the signer and reads its scope. `msg.sender` is irrelevant to authorization.
- **ERC-4626:** the target vault standard (MockVault for the demo).

> **Not used:** EIP-7702 EOA upgrade and the ERC-7715 *toolkit redemption of arbitrary calls*
> were evaluated and rejected (see ADRs in `technical-architecture.md`). A standard EOA is
> sufficient; the AP is redeemed only for the `transfer` the enforcer allows.

---

## 2. On-Chain vs. Off-Chain Components

### On-Chain (Base Sepolia)

| Component | Contract | Description |
|-----------|----------|-------------|
| Per-agent scope storage + checks | `AgentRegistry.sol` | One agent key = one capped/expiring scope; `authorizeSessionKey` / `revokeAgent` / `scopeOf` |
| Deposit execution (deposit-only) | `AgentVaultDepositor.sol` | Recovers the EIP-712 signer, validates scope, deposits; holds no user funds |
| ERC-7715 AP redemption | `DelegationManager` (`0xdb9B…47dB3`) | `redeemDelegations` → `USDC.transfer(depositor, slice)` under the period cap |
| Vault | `MockVault.sol` (ERC-4626) | Demo vault; `deposit(assets, receiver)` mints shares to the user |

### Off-Chain

| Component | Technology | Description |
|-----------|------------|-------------|
| AI strategist | DeepSeek (default) / Venice x402+SIWE / hardcoded fallback | Strategy + per-agent skill generation |
| Gas relay + AP redeem | 1Shot **Managed API** (server-wallet relayer) | Broadcasts `redeemDelegations` and `depositHeld`; user pays 0 gas |
| Orchestrator Agent | JavaScript (frontend) | Requests the AP, batches `authorizeSessionKey`, dispatches Workers |
| Worker Agents | JavaScript (frontend) | Per vault: redeem AP slice → sign `AgentHeldDeposit` → relay `depositHeld` |
| Skill / memory files | JSON (local) | Per-agent config + append-only execution logs |
| UI + graph | React + react-force-graph-2d | Triggers flows + real-time visualization |
| Permission UI | MetaMask (Smart Accounts Kit) | User grants/revokes the ERC-7715 AP |

> **1Shot on testnet:** the keyless *Permissionless Relayer* is mainnet-only. On Base Sepolia we
> use the **Managed API** — a key+secret-authenticated, funded server wallet that acts as the
> relayer (and, as the AP grantee, the valid redeemer). Credentials live server-side only
> (`frontend/api/relay.js`), never in the client bundle.

---

## 3. Smart Contract Scope

### `AgentRegistry.sol` — one agent key, one scope

```solidity
struct AgentScope {
    address owner;          // the user who granted this scope
    address vault;          // the only vault this agent may deposit into
    address token;          // the only token (USDC)
    uint96  capPerPeriod;   // max units per period
    uint32  periodDuration;
    uint96  spentInPeriod;
    uint40  periodStart;
    uint40  expiry;
    bool    revoked;
}
mapping(address agent => AgentScope) public scopes;

function authorizeSessionKey(/* owner-signed: agent, vault, token, cap, period, expiry */) external;
function revokeAgent(address agent) external;
function scopeOf(address agent) external view returns (AgentScope memory);

event AgentAuthorized(address indexed owner, address indexed agent, address vault, address token,
                      uint96 capPerPeriod, uint32 periodDuration, uint40 expiry);
event AgentRevoked(address indexed owner, address indexed agent);
```

A scope is **immutable once set** — re-scoping means a new key. `rollAndSpend(agent, amount)`
advances the period window and reverts if the cap would be exceeded.

### `AgentVaultDepositor.sol` — deposit-only, holds no funds

```solidity
bytes32 public constant DEPOSIT_TYPEHASH =
    keccak256("AgentDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");
// Distinct struct so a held-funds deposit signature can never be replayed as a transferFrom one.
bytes32 public constant HELD_DEPOSIT_TYPEHASH =
    keccak256("AgentHeldDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");

// Main flow: deposit USDC ALREADY held by this contract (pushed in by an ERC-7715 redeem).
// Funds come from the contract's own unreserved balance — never transferFrom(owner).
function depositHeld(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes sig)
    external returns (uint256 shares);

// Legacy/fallback: pull via transferFrom(owner) after a user approve (kept for the approve path).
function executeAgentDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes sig)
    external returns (uint256 shares);

// Guardian escape hatch: sweep funds stranded by a redeem whose depositHeld never landed,
// so transient custody can never become permanent custody. Only unreserved surplus is movable.
function sweepStranded(address token, address to) external;

event AgentDepositExecuted(address indexed agent, address indexed owner, address indexed vault,
                           address token, uint256 assetsIn, uint256 sharesOut, bytes32 execId);
```

**Security constraints (enforced on-chain):**
- Recovers the EIP-712 signer (`agent`); `msg.sender` (the relayer) is irrelevant to authorization.
- `scopeOf(agent)` checked: `owner != 0`, vault/token match, `capPerPeriod`/`spentInPeriod`,
  `expiry`, `revoked`.
- `executed[execId]` replay guard.
- `minAmount` / `minShares` floors guard fee-on-transfer, slippage, and adversarial vaults.
- `depositHeld` spends only `balanceOf(this) - reserves[token]` — never funds reserved by a
  concurrent in-flight deposit, and never `transferFrom(owner)`.
- ReentrancyGuard + Pausable (guardian-only pause). No admin can move user funds.
- **Zero custody:** invariant tests (`ZeroCustody.t.sol`) assert no *permanent* custody — any
  transient balance between redeem and deposit nets to the in-flight reserves and is sweepable.

### `MockVault.sol`

ERC-4626 (`deposit`, `balanceOf`, `totalAssets`, `asset`). One instance funds the demo; APY/metadata
are off-chain. `asset()` is the Base Sepolia USDC used by the scope + AP.

---

## 4. The two-boundary funding flow (main path)

```mermaid
sequenceDiagram
    actor User
    participant MM as MetaMask (Smart Accounts Kit)
    participant Orch as Orchestrator (browser)
    participant Worker as Worker key (off-chain)
    participant Relayer as 1Shot server wallet (grantee + relayer)
    participant DM as DelegationManager
    participant Dep as AgentVaultDepositor
    participant Reg as AgentRegistry
    participant Vault as ERC-4626 Vault

    User->>MM: requestExecutionPermissions (erc20-token-periodic, cap=total, to=relayer)
    MM-->>Orch: permissionContext + delegationManager  (REAL grant on 84532)
    User->>Reg: authorizeSessionKey(agent, vault, USDC, cap, period, expiry)  (one batched popup)
    loop per worker (serial)
        Worker->>Relayer: redeem this slice (permissionContext, transfer→depositor, amount)
        Relayer->>DM: redeemDelegations(contexts, modes, executions)
        DM->>Dep: USDC.transfer(depositor, amount)   (only the enforcer-allowed call)
        Worker->>Worker: sign EIP-712 AgentHeldDeposit(amount,minAmount,minShares,execId)
        Worker->>Relayer: relay depositHeld(payload)
        Relayer->>Dep: depositHeld(amount, minAmount, minShares, execId, sig)
        Dep->>Dep: agent = ecrecover(sig); check scopeOf(agent)
        Dep->>Reg: rollAndSpend(agent, amount)
        Dep->>Vault: deposit(amount, owner)
        Vault-->>User: shares
    end
```

**Why the redeem is safe.** The `ERC20PeriodTransferEnforcer` (audited by Consensys Diligence)
releases **only** `IERC20.transfer(address,uint256)` — target must equal the token, selector must be
`0xa9059cbb`, amount bounded by the period cap. It does **not** constrain the transfer *recipient*,
so the redeem may transfer straight into `AgentVaultDepositor`. The pushed-in USDC is then deposited
by `depositHeld` under the AgentRegistry scope. The earlier project assumption — *"a worker cannot
redeem a 7715 permission to fund a deposit"* — was wrong: it assumed the redeem had to call the
depositor directly. Redeeming a plain `transfer` into the depositor, then depositing the held funds,
makes the AP genuinely load-bearing with no enforcer modification.

**Grantee = redeemer.** `redeemDelegations` requires `msg.sender == leaf delegate`, so the AP's
grantee MUST be whoever broadcasts the redeem — here the 1Shot server wallet
(`POST /api/relay {action:'wallet'}` → its address). The same wallet sponsors gas for `depositHeld`.

---

## 5. Audit Trail & Verification

Every step leaves on-chain evidence verifiable on the Base Sepolia explorer:

| Step | On-Chain Evidence |
|------|-------------------|
| AP granted | MetaMask returns a real `delegationManager` + `permissionContext` (84532) |
| Scope grant per agent | `AgentAuthorized` event; `scopeOf(agent)` readable |
| AP redeemed (funds in) | `DelegationManager` tx → `USDC.transfer` to the depositor (under the period cap) |
| Deposit | `AgentDepositExecuted(agent, owner, vault, token, assetsIn, sharesOut, execId)` + vault balance ↑ |
| Gas relayed | tx `from` = the 1Shot server wallet, **not** the user's EOA |
| Revoke | `AgentRevoked` event; later deposits revert `ScopeInactive` |

**How to verify in the demo:**
1. Open the redeem tx — `from` is the 1Shot server wallet; it calls `DelegationManager`.
2. Open the deposit tx — `AgentDepositExecuted` with a unique `execId`; `from` is the relayer.
3. Read `scopeOf(agent)` to show the cap/expiry that bounded the deposit.
4. Show the user's vault `balanceOf` increased; the depositor's USDC balance is `0` at rest.
5. Show distinct `agent` keys per Worker — proof of parallel, independently-scoped agents.

---

## 6. Risks & Mitigations

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Redeem under-funds the depositor → `depositHeld` reverts | Low | `depositHeld` checks `available >= amount`; funds stay sweepable via `sweepStranded` |
| Stranded transient custody after a failed deposit | Low | Guardian `sweepStranded` drains unreserved surplus; ZeroCustody invariant tested |
| `execId` replay (gas-drain) | Low | `executed[execId]` on-chain guard + warm-cache + on-chain `executed()` precheck in the relay |
| Adversarial / fee-on-transfer vault | Low | `minAmount` + `minShares` floors revert a shortfall |
| 1Shot relay down | Medium | Redeem fails closed (worker surfaces it); the legacy approve + user-signed path remains |
| Codeless / stale depositor address | Low | Relay refuses to broadcast to an address with no code (no silent no-op) |
| Reentrancy | Low | CEI + ReentrancyGuard; depositor holds no funds |

---

## 7. Why the Blockchain is Core

Two user-signed boundaries, both enforced on-chain, are what make autonomous agents trustworthy:

- **ERC-7715 Advanced Permission** caps the *total* USDC the agents can ever move and expires on its
  own. The user grants it once; MetaMask Smart Accounts Kit and the audited periodic enforcer do the
  rest. This is the boundary that releases funds.
- **AgentRegistry scope** caps *each* agent to one vault, one amount, one expiry, individually
  revocable. This is the boundary that authorizes the deposit.
- **EIP-712 worker signatures** make authorization independent of `msg.sender`, so a gas-sponsoring
  relayer can never act outside the two boundaries above.
- **Deposit-only, zero-custody depositor** means the contract never holds user funds at rest.

Both MetaMask SAK (grant + redeem) and 1Shot (relay) are load-bearing in the fund-moving path — the
agents move real USDC on Base Sepolia, under cryptographic limits the user set, for zero gas.

---
title: "ERC-7715 Scoped Permissions — Grant Flow & Enforcement"
category: "Architecture & Design"
status: "✅ Resolved"
priority: "High"
timebox: "3 days"
created: 2026-05-26
updated: 2026-05-26
owner: "Muhammad Faiq"
tags: ["technical-spike", "architecture", "erc-7715", "permissions", "agent"]
---

# ERC-7715 Scoped Permissions — Grant Flow & Enforcement

## Summary

**Spike Objective:** Determine how ERC-7715 scoped permissions are granted, stored, and validated — both from MetaMask SDK side and from VaultDepositor contract side — for the vibing-farmer agent flow.

**Why This Matters:** ERC-7715 is the core security primitive. It defines what the agent CAN do without repeated user approval. Wrong implementation = either broken UX (constant popups) or broken security (agent can exceed user limits). Directly shapes VaultDepositor.sol architecture.

**Timebox:** 3 days

**Decision Deadline:** 2026-05-30 — must resolve before implementing VaultDepositor permission validation logic.

---

## Research Findings

### ERC-7715 is a Draft Standard ⚠️

ERC-7715 (Request Permissions from Wallets) is still **DRAFT** as of May 2026.
Requires EIP-4337 + EIP-7710.

MetaMask calls it "Advanced Permissions" — only available in **MetaMask Flask 13.5.0+**.
Source: https://eips.ethereum.org/EIPS/eip-7715

---

### Actual Permission Object Format

ERC-7715 uses a generic permission schema — NOT a fixed Solidity struct.

```typescript
type PermissionRequest = {
  chainId: Hex          // e.g. "0xaa36a7" for Sepolia
  from?: Address        // user's smart account (optional if single account)
  to: Address           // session account receiving the permission
  permission: {
    type: string                    // e.g. "erc20-token-periodic"
    isAdjustmentAllowed: boolean    // can wallet adjust scope?
    data: Record<string, any>       // type-specific
  }
  rules?: {
    type: string        // e.g. "expiry"
    data: Record<string, any>
  }[]
}
```

Built-in rule type for expiry:
```typescript
{
  type: "expiry",
  data: { timestamp: 1748304000 }  // unix seconds
}
```

Built-in permission types supported by MetaMask SAK:
- `native-token-allowance` — ETH allowance
- `erc20-token-allowance` — ERC-20 one-time allowance
- `erc20-token-periodic` — ERC-20 recurring allowance (most useful for vibing-farmer)
- `erc721-token-allowance` — NFT
- Custom types via custom caveats enforcers (Foundry)

**For vibing-farmer:** Use `erc20-token-periodic` with USDC address + maxAmount + period = expiry duration.

---

### Grant Flow — Actual RPC Call

```javascript
// Direct JSON-RPC (no SAK required on frontend)
const [grantedPermission] = await window.ethereum.request({
  method: 'wallet_requestExecutionPermissions',
  params: [{
    chainId: '0xaa36a7',  // Sepolia
    to: VAULT_DEPOSITOR_ADDRESS,  // session account = VaultDepositor
    permission: {
      type: 'erc20-token-periodic',
      isAdjustmentAllowed: false,  // user's amount must be honored exactly
      data: {
        tokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',  // USDC Sepolia
        periodAmount: '100000000',   // 100 USDC (6 decimals)
        periodDuration: 86400,       // 1 day in seconds
        justification: 'Automated vault deposit via vibing-farmer'
      }
    },
    rules: [{
      type: 'expiry',
      data: { timestamp: Math.floor(Date.now() / 1000) + 86400 }  // 24h
    }]
  }]
})
// Returns PermissionResponse[]
```

---

### Permission Response Structure

```typescript
type PermissionResponse = {
  // Echo of original request (may be attenuated by wallet)
  chainId: Hex
  from: Address          // user's smart account address
  to: Address            // session account (VaultDepositor)
  permission: { ... }
  rules: [...]

  // Response-specific fields
  context: Hex                      // OPAQUE — pass to redeemDelegations()
  dependencies: {                   // accounts to deploy before redemption
    factory: Address
    factoryData: Hex
  }[]
  delegationManager: Address        // call redeemDelegations() on this
}
```

**`context` = opaque bytes.** Do NOT try to decode it. Just store it and pass to `redeemDelegations`.

---

### ⚠️ ARCHITECTURE CHANGE: VaultDepositor Must Change

**Original design (wrong):**
```solidity
// ❌ Wrong — validatePermission doesn't work this way
function executeDeposit(address user, address vault, uint256 amount, bytes permissionContext)
```

**Actual ERC-7715 / ERC-7710 execution pattern:**

The `context` is NOT passed directly to VaultDepositor. It is passed to `delegationManager.redeemDelegations()`, which then calls VaultDepositor.

VaultDepositor.sol becomes the target of execution, not the validator:

```
Frontend → calls delegationManager.redeemDelegations(
  [permissionContext],    // from ERC-7715 response
  [executionMode],        // e.g. single call mode
  [encodedVaultDeposit]  // ABI-encoded call to VaultDepositor.deposit(amount, vault)
)
→ DelegationManager validates context
→ DelegationManager calls user's smart account
→ User's smart account executes deposit on VaultDepositor
```

**Two options for VaultDepositor:**

**Option A (Simpler for initial release):** VaultDepositor is a standalone contract. DelegationManager routes execution to it. VaultDepositor does NOT validate permissions itself — the DelegationManager already enforced scope.

```solidity
// VaultDepositor.sol — simplified, DelegationManager handles scope
contract VaultDepositor is ReentrancyGuard {
    function deposit(uint256 amount, address vault) external nonReentrant {
        // msg.sender = user's smart account (delegationManager calls us via user account)
        // DelegationManager already validated permission scope before we were called
        // We just need to validate vault is known/safe
        require(vault == MOCK_VAULT_ADDRESS, "Unknown vault");
        
        IERC20(USDC).transferFrom(msg.sender, address(this), amount);
        IERC20(USDC).approve(vault, amount);
        IERC4626(vault).deposit(amount, msg.sender);
    }
}
```

**Option B (Demo-friendly, self-contained):** Keep permission storage in VaultDepositor, manually validate via stored permissions. Skip DelegationManager for the live demo and call VaultDepositor directly from 1Shot relay.

For the MVP, **Option B is better** — it's self-contained, doesn't need DelegationManager deployed, and is easier to demo. Store permissions on-chain in VaultDepositor and validate there.

---

### Revised VaultDepositor Permission Model (Option B)

For MVP: store permissions in contract, bypass DelegationManager complexity.

```solidity
struct Permission {
    address vault;
    uint256 maxAmount;
    uint256 expiresAt;
    bool active;
}

mapping(address user => Permission) public permissions;

// User calls this directly (or via MetaMask TX)
function grantPermission(address vault, uint256 maxAmount, uint256 expiresAt) external {
    require(expiresAt > block.timestamp, "Invalid expiry");
    permissions[msg.sender] = Permission(vault, maxAmount, expiresAt, true);
    emit PermissionGranted(msg.sender, vault, maxAmount, expiresAt);
}

// 1Shot relayer calls this on behalf of user
function executeDeposit(address user, uint256 amount, address vault) external nonReentrant {
    Permission memory p = permissions[user];
    require(p.active, "No permission");
    require(block.timestamp < p.expiresAt, "Permission expired");
    require(amount <= p.maxAmount, "Exceeds scope");
    require(vault == p.vault, "Vault not in scope");
    
    // CEI: all checks done, now interactions
    IERC20(USDC).transferFrom(user, address(this), amount);
    IERC20(USDC).approve(vault, amount);
    uint256 shares = IERC4626(vault).deposit(amount, user);
    
    emit DepositExecuted(user, vault, amount, shares);
}

function revokePermission() external {
    delete permissions[msg.sender];
    emit PermissionRevoked(msg.sender, msg.sender);
}
```

**This is the viable MVP approach.** ERC-7715 is shown in the FRONTEND (permission UI) but the on-chain enforcement uses VaultDepositor's own storage. The `context` from ERC-7715 response is displayed to user and stored for demo evidence, but the actual enforcement is VaultDepositor's `permissions` mapping.

---

### Permission Revocation

```javascript
// Revoke via MetaMask (updates wallet-side state)
await window.ethereum.request({
  method: 'wallet_revokeExecutionPermission',
  params: [{ permissionContext: storedContext }]
})

// Also call VaultDepositor directly to revoke on-chain
await vaultDepositorContract.revokePermission()
```

---

### UI Display Requirements

MetaMask Flask shows the permission scope to user before signing. The `isAdjustmentAllowed: false` forces MetaMask to show EXACTLY what was requested — user cannot reduce it.

Show in the UI BEFORE calling `wallet_requestExecutionPermissions`:
```
Vault:      0xMockVault...
Max USDC:   100 USDC
Expires:    26 Mei 2026, 14:30
Agent:      VaultDepositor (0x...)
```

After grant, persist context in `sessionStorage`:
```javascript
sessionStorage.setItem('permissionContext', grantedPermission.context)
sessionStorage.setItem('delegationManager', grantedPermission.delegationManager)
```

---

## Decision

### Recommendation

**Hybrid approach:**
1. Frontend calls `wallet_requestExecutionPermissions` (ERC-7715) — for demo story + MetaMask popup
2. VaultDepositor stores permissions independently via `grantPermission()` — for reliable on-chain enforcement
3. `grantPermission()` is called via a separate tx (can be combined with 1Shot relay or direct)
4. `executeDeposit()` called by 1Shot relayer with user address + amount + vault

This shows ERC-7715 in the demo (satisfies MetaMask SAK integration requirements) while keeping on-chain logic self-contained and testable.

### Rationale

ERC-7715 is DRAFT and DelegationManager adds complexity not worth handling solo in 20 days. Self-contained permission storage in VaultDepositor is auditable, testable, and demonstrable. ERC-7715 frontend flow fits the modular, extensible architecture perfectly.

### Follow-up Actions

- [x] ERC-7715 permission format documented
- [x] Grant flow confirmed: `wallet_requestExecutionPermissions` JSON-RPC
- [x] On-chain validation: use VaultDepositor's own storage (not DelegationManager)
- [ ] Implement `grantPermission()` + `revokePermission()` in VaultDepositor.sol
- [ ] Build frontend permission grant modal with MetaMask Flask popup + on-chain tx
- [ ] Store `context` in sessionStorage for demo display
- [ ] Add `PermissionGranted` event handling in frontend
- [ ] Write unit tests for permission boundary enforcement (revert on exceed)

---

## Status History

| Date       | Status         | Notes                                          |
| ---------- | -------------- | ---------------------------------------------- |
| 2026-05-26 | 🔴 Not Started | Spike created, blocked until EIP-7702 confirmed |
| 2026-05-26 | ✅ Resolved    | Architecture revised: VaultDepositor own storage, ERC-7715 for UI |

---

_Last updated: 2026-05-26 by Muhammad Faiq_

---
title: "EIP-7702 + MetaMask Smart Accounts Kit Integration"
category: "API Integration"
status: "✅ Resolved"
priority: "High"
timebox: "3 days"
created: 2026-05-26
updated: 2026-05-26
owner: "Muhammad Faiq"
tags: ["technical-spike", "api-integration", "eip-7702", "metamask", "smart-accounts"]
---

# EIP-7702 + MetaMask Smart Accounts Kit Integration

## Summary

**Spike Objective:** Determine if EIP-7702 EOA-to-smart-account upgrade works on Sepolia via MetaMask Smart Accounts Kit, and identify the exact SDK setup required for the vibing-farmer flow.

**Why This Matters:** EIP-7702 is the foundational layer. If Sepolia doesn't support it or the SDK setup is non-trivial, the entire architecture shifts. Blocks VaultDepositor contract design and frontend wallet integration.

**Timebox:** 3 days

**Decision Deadline:** 2026-05-29 — must resolve before writing VaultDepositor.sol or wallet connect UI.

---

## Research Question(s)

**Primary Question:** Does Sepolia fully support EIP-7702 today, and can MetaMask Smart Accounts Kit upgrade an EOA in a single user interaction?

**Secondary Questions:**

- What version of MetaMask Smart Accounts Kit is current, and what are the install/import patterns?
- What RPC calls does EIP-7702 require, and does Sepolia's public RPC support them?
- Can the upgrade be done without a custom bundler/paymaster, or does it need 1Shot relay from the start?
- What does the MetaMask UI show to the user during the upgrade transaction?

---

## Research Findings

### EIP-7702 on Sepolia — CONFIRMED ✅

**Pectra upgrade activated on Sepolia at epoch 222464 (March 5, 2025 07:29 UTC).**
Source: https://blog.ethereum.org/2025/02/14/pectra-testnet-announcement

Mainnet activation: May 7, 2025. Sepolia was first. **No blockers.**

EIP-7702 tx type = `0x04`. Authorization tuple format:
```
[chain_id, address, nonce, y_parity, r, s]
```
EOA code after upgrade = `0xef0100 || delegator_address` (delegation indicator).

---

### MetaMask Smart Accounts Kit

**Package:** `@metamask/smart-accounts-kit`

```bash
npm install @metamask/smart-accounts-kit
```

**⚠️ CRITICAL: SAK is built on Viem, NOT ethers.js.**

The ADR decision ("ethers.js v6 only") must be revised. EIP-7702 authorization signing and ERC-7715 permission requests require Viem.

**Workaround for no-build frontend:** Use Viem via ESM CDN.
```html
<script type="module">
  import { createWalletClient, custom } from 'https://esm.sh/viem'
  import { sepolia } from 'https://esm.sh/viem/chains'
</script>
```

---

### ⚠️ CRITICAL: MetaMask Flask Required (NOT Regular MetaMask)

ERC-7715 Advanced Permissions require **MetaMask Flask 13.5.0+**.
- Flask 13.9.0+ can auto-upgrade EOA when requesting permissions (no separate upgrade step needed).
- Regular MetaMask Extension does NOT support `wallet_requestExecutionPermissions`.
- Flask download: https://metamask.io/flask/

**Demo implication:** Must record demo using MetaMask Flask. Document this for judges.

---

### EIP-7702 Upgrade Flow (Actual)

The delegation target is `EIP7702StatelessDeleGatorImpl` from MetaMask Delegation Framework:

```typescript
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
} from '@metamask/smart-accounts-kit'
import { createWalletClient, custom } from 'viem'
import { sepolia } from 'viem/chains'

// 1. Create wallet client from MetaMask provider
const walletClient = createWalletClient({
  transport: custom(window.ethereum),
  chain: sepolia,
})

// 2. Get delegator contract address for Sepolia
const environment = getSmartAccountsEnvironment(sepolia.id)
const contractAddress = environment.implementations.EIP7702StatelessDeleGatorImpl

// 3. Sign EIP-7702 authorization (triggers MetaMask Flask popup)
const [address] = await walletClient.requestAddresses()
const authorization = await walletClient.signAuthorization({
  account: address,
  contractAddress,
  executor: 'self',
})

// 4. Send type 0x04 tx to set EOA code (includes authorization)
// 1Shot can relay this with authorizationList support
```

---

### Check if Already Upgraded

```typescript
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'

const code = await publicClient.getCode({ address: userAddress })
if (code) {
  // code = 0xef0100 || delegatorAddress (23 bytes)
  const delegatorAddress = `0x${code.substring(8)}`
  const expected = getSmartAccountsEnvironment(sepolia.id)
    .implementations.EIP7702StatelessDeleGatorImpl
  const isUpgraded = delegatorAddress.toLowerCase() === expected.toLowerCase()
}
```

---

### Frontend Tech Stack Revision

Original plan: plain HTML/JS + ethers.js v6 only.

**Revised:** Add Viem via ESM CDN for EIP-7702/ERC-7715. Keep ethers.js v6 for contract event listening and ABI encoding if preferred, but Viem handles auth signing.

| Concern | Library |
|---------|---------|
| EIP-7702 authorization signing | Viem (`signAuthorization`) |
| ERC-7715 permission request | Viem + SAK `erc7715ProviderActions` |
| Contract event listening | ethers.js v6 OR Viem publicClient |
| General RPC | Either |

Since SAK is Viem-based and can't be imported via CDN (it's npm-only), call ERC-7715 directly via JSON-RPC for the no-build frontend:

```javascript
// Direct JSON-RPC — no SAK needed
const permissionsResponse = await window.ethereum.request({
  method: 'wallet_requestExecutionPermissions',
  params: [{ ... }]
})
```

Viem can be used via `https://esm.sh/viem` for authorization signing only.

---

## Decision

### Recommendation

**Proceed with original architecture. EIP-7702 on Sepolia confirmed. No blockers.**

Use MetaMask Flask 13.9.0+ which auto-handles EIP-7702 upgrade during permission grant (no separate upgrade step needed for demo). This simplifies the user flow to one interaction.

### Rationale

- Flask 13.9.0+ combines upgrade + permission grant → single user interaction = cleaner demo
- Viem ESM CDN handles the authorization signing for pure frontend
- Direct JSON-RPC for `wallet_requestExecutionPermissions` eliminates SAK npm dependency issue

### Implementation Notes

```javascript
// wallet.js — simplified flow for demo (Flask 13.9+ auto-upgrades)

import { createWalletClient, createPublicClient, custom, http } from 'https://esm.sh/viem'
import { sepolia } from 'https://esm.sh/viem/chains'
import { erc7715ProviderActions } from 'https://esm.sh/@metamask/smart-accounts-kit/actions'

const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })

const walletClient = createWalletClient({
  chain: sepolia,
  transport: custom(window.ethereum),
}).extend(erc7715ProviderActions())

// Check upgrade status
async function isUpgraded(address) {
  const code = await publicClient.getCode({ address })
  return code && code.startsWith('0xef0100')
}

// Request permissions — Flask 13.9+ auto-upgrades if needed
async function requestPermissions(sessionAccountAddress, vaultAddress, maxAmountUsdc, expiryTs) {
  return walletClient.requestExecutionPermissions([{
    chainId: sepolia.id,
    expiry: expiryTs,
    to: sessionAccountAddress,
    permission: {
      type: 'erc20-token-periodic',
      data: {
        tokenAddress: USDC_SEPOLIA_ADDRESS,
        periodAmount: BigInt(maxAmountUsdc) * BigInt(1e6),
        periodDuration: expiryTs - Math.floor(Date.now() / 1000),
        justification: `Vault deposit to ${vaultAddress}`,
      },
      isAdjustmentAllowed: false,
    },
  }])
  // Returns: [{ context, delegationManager, dependencies, ... }]
}
```

Note: `erc7715ProviderActions` may not be available via ESM CDN if SAK lacks CDN build.
Fallback: use direct `window.ethereum.request({ method: 'wallet_requestExecutionPermissions', params: [...] })`.

### Follow-up Actions

- [x] Confirmed Sepolia supports EIP-7702 (March 5, 2025)
- [ ] Download MetaMask Flask 13.9.0+ on demo browser profile
- [ ] Verify `esm.sh/viem` loads correctly in browser (no bundler)
- [ ] Verify `esm.sh/@metamask/smart-accounts-kit` is available as ESM, or fall back to direct JSON-RPC
- [ ] Test actual EIP-7702 upgrade tx on Sepolia before recording demo
- [ ] Update frontend ADR: "Viem (ESM CDN) for EIP-7702/ERC-7715, ethers.js v6 for contract calls"
- [ ] Unblock ERC-7715 spike

---

## Status History

| Date       | Status         | Notes                              |
| ---------- | -------------- | ---------------------------------- |
| 2026-05-26 | 🔴 Not Started | Spike created, highest priority    |
| 2026-05-26 | ✅ Resolved    | Sepolia confirmed, SAK documented, critical Flask requirement found |

---

_Last updated: 2026-05-26 by Muhammad Faiq_

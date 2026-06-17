---
title: "1Shot API Permissionless Relayer — EIP-7710 Gas Abstraction"
category: "API Integration"
status: "✅ Resolved"
priority: "High"
timebox: "2 days"
created: 2026-05-26
updated: 2026-05-26
owner: "Muhammad Faiq"
tags: ["technical-spike", "api-integration", "1shot", "eip-7710", "gas-abstraction", "relay"]
---

# 1Shot API Permissionless Relayer — EIP-7710 Gas Abstraction

## Summary

**Spike Objective:** Determine how 1Shot API permissionless relayer works, what it costs, and how VaultDepositor calls are routed through it so the user pays zero gas for agent-executed transactions.

**Why This Matters:** 1Shot relay is a core architectural piece. Also critical UX: user shouldn't pay gas for agent actions after setting permissions. If 1Shot doesn't support Sepolia or the API is complex, need fallback plan.

**Timebox:** 2 days

**Decision Deadline:** 2026-05-31 — must resolve before building agent execution layer.

---

## Research Findings

### ✅ Correct Approach: Permissionless Relayer (No API Key Required)

**Endpoint:** `https://relayer.1shotapi.com/relayers`

**No account. No API key. No SDK.** Pure JSON-RPC — grant EIP-7710 permission, relayer sponsors gas.
This is the correct integration and aligns with the EIP-7710/7715 architecture.

> ~~1Shot Business API~~ (`api.1shotapi.com/v0`) — M2M JWT approach — **NOT used**. Too complex, requires dashboard setup + funded wallet account. The permissionless relayer is the right path.

---

### Permissionless Relayer Flow

No account setup. No funded wallet. No dashboard. Pure JSON-RPC.

**How it works:**
1. User grants EIP-7710 permission via ERC-7715 (`wallet_requestExecutionPermissions`)
2. Frontend POSTs relay request to `https://relayer.1shotapi.com/relayers` with the `permissionContext`
3. Relayer validates permission scope, sponsors gas, submits tx to Sepolia
4. `from` in tx = 1Shot relayer address → demo evidence of gas abstraction ✅

**Exact request format** (verify against https://docs.1shotapi.com — OpenRPC spec):

```javascript
// relay.js — permissionless relayer
const ONESHOT_RELAYER = 'https://relayer.1shotapi.com/relayers'

export async function relayVaultDeposit(permissionContext, delegationManager, executionCalldata) {
  // executionCalldata = ABI-encoded call to VaultDepositor (or redeemDelegations)
  const res = await fetch(ONESHOT_RELAYER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'relay_executePermission',   // verify actual method name from OpenRPC spec
      id: 1,
      params: [{
        chainId: '0xaa36a7',              // Sepolia
        permissionContext,                 // from wallet_requestExecutionPermissions response
        delegationManager,                 // from wallet_requestExecutionPermissions response
        executionCalldata,                 // ABI-encoded target action
      }]
    })
  })

  const { result, error } = await res.json()
  if (error) throw new Error(`1Shot relay error: ${error.message}`)
  return result  // { txHash }
}
```

> ⚠️ **Exact JSON-RPC method name and params must be verified against the OpenRPC spec at `relayer.1shotapi.com`.** The structure above is inferred from EIP-7710 + 1Shot docs. Read the actual spec before implementing.

---

### Sepolia Support ✅

Confirmed: 1Shot supports Sepolia testnet. Examples in docs use `chainId: 11155111`.

---

### Rate Limits & Cost

- Bearer token expires: 1 hour (re-generate as needed)
- Rate limits: not documented explicitly; sandbox/MVP usage is low volume, no concern
- Testnet gas: 1Shot funds from their wallet; you fund the 1Shot wallet with Sepolia ETH
- Sepolia ETH: free from faucets (Alchemy, Infura, etc.)

---

### ⚠️ MetaMask Delegation Note

From 1Shot docs:
> "MetaMask currently disallows EIP-712 delegation signatures in their browser and mobile wallets. You will need to import your account into another browser wallet like OKX Wallet to sign and store delegations in the 1Shot API portal."

This only applies to the **wallet delegation** feature of 1Shot (where you delegate your own wallet TO 1Shot service). This is NOT required for the initial MVP — we use the Business API with 1Shot's own managed wallets, not user wallet delegation.

---

## Decision

### Recommendation

**Use 1Shot Permissionless Relayer. No API key. No account. No dashboard.**

Endpoint: `https://relayer.1shotapi.com/relayers`

Flow: ERC-7715 permission grant → pass `context` + `delegationManager` to relayer → relayer submits tx.

### Rationale

- No credentials = nothing to manage, nothing to leak
- Architecturally correct: aligns with EIP-7710 spec and ERC-7715 permission context
- `from` = 1Shot relayer = clean gas abstraction demo evidence
- Simpler frontend: no auth flow, no token refresh, just one POST

### Implementation Notes

```javascript
// relay.js

const ONESHOT_RELAYER = 'https://relayer.1shotapi.com/relayers'

export async function relayDeposit({ permissionContext, delegationManager, executionCalldata }) {
  const res = await fetch(ONESHOT_RELAYER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'relay_executePermission',  // ⚠️ verify from OpenRPC spec
      params: [{
        chainId: '0xaa36a7',
        permissionContext,
        delegationManager,
        executionCalldata,
      }]
    })
  })

  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result  // expected: { txHash }
}
```

Polling confirmation (ethers.js v6):
```javascript
const receipt = await provider.waitForTransaction(txHash, 1, 60_000)  // 1 confirm, 60s timeout
```

### Follow-up Actions

- [ ] Read OpenRPC spec at `https://relayer.1shotapi.com/relayers` — confirm method name + params
- [ ] Test minimal relay call on Sepolia (any tx) before wiring VaultDepositor
- [ ] Build `relay.js` — no auth, just POST + poll
- [ ] Confirm `from` = 1Shot relayer on Sepolia Etherscan → screenshot for live demo verification

---

## Status History

| Date       | Status         | Notes                           |
| ---------- | -------------- | ------------------------------- |
| 2026-05-26 | 🔴 Not Started | Spike created, core MVP req  |
| 2026-05-26 | ✅ Resolved    | Business API approach confirmed, EIP-7702 authorizationList support found |

---

_Last updated: 2026-05-26 by Muhammad Faiq_

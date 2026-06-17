# One-Grant FunctionCall Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user grant permission exactly once — replace the token-transfer-scoped ERC-7715 grant with a raw ERC-7710 `FunctionCall` delegation that legally authorizes the agents' arbitrary contract calls, surface a loud error when the session cannot boot, and route the background agent (harvest/withdraw) through the same zero-popup session redemption.

**Architecture:** The deposit loop already redeems contract calls through an ephemeral session account (`strategy/session.js` → `sendTransactionWithDelegation`), which only needs two inputs: `permissionContext` and `delegationManager`. The current grant (`wallet.js → requestERC7715Permission`) uses `erc20-token-periodic` scope — a USDC-transfer permission — so when the session tries to redeem `executeAgentDeposit` (a non-transfer call to a different contract), the DelegationManager caveat enforcer reverts and the code silently falls back to a user-signed popup per call. The fix swaps that grant for a `ScopeType.FunctionCall` delegation scoped to the AgentVaultDepositor contract and its five action selectors, signed once by the user's MetaMask. We feed `encodeDelegations([signedDelegation])` as `permissionContext` and `smartAccount.environment.DelegationManager` as `delegationManager` — the existing `initSession`/`redeemCall`/`grantStore`/`rehydrate` chain consumes both unchanged.

**Tech Stack:** Vite + React 18 (JSX, no TS), `@metamask/smart-accounts-kit` 1.6.0 (`createDelegation`, `ScopeType`, `Implementation`, `toMetaMaskSmartAccount`, `encodeDelegations`), `viem` (`createWalletClient`, `createPublicClient`, `custom`, `http`), `ethers` v6 (ABI encoding in relay), Vitest (`vi.mock` for SAK/viem). Chain: Base Sepolia (84532).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/config.js` | Add `DEPOSITOR_SELECTORS` — the five AgentVaultDepositor function signatures the delegation must allow | Modify |
| `frontend/src/strategy/rootDelegation.js` | Build + sign the user's root `FunctionCall` delegation via MetaMask; return `{ permissionContext, delegationManager }` | Create |
| `frontend/src/strategy/rootDelegation.test.js` | Unit tests for the above (SAK + viem mocked) | Create |
| `frontend/src/strategy/session.js` | Add `bootSession()` — validates the grant has a delegationManager and boots the session, throwing a loud, coded error otherwise (#2) | Modify |
| `frontend/src/strategy/session.test.js` | Tests for `bootSession()` | Modify |
| `frontend/src/app.jsx` | `handlePermConfirm`: call `createUserRootDelegation()` instead of `requestERC7715Permission()`; use `bootSession()` and surface failures in the UI instead of silently continuing (#1 wiring + #2) | Modify |
| `frontend/src/relay.js` | Add session-redeem branch to `relayWithdraw`/`relayHarvest` mirroring `relayDeposit` (#3); add `encodeSetAgentCapabilities`/`encodeExecuteWithdraw`/`encodeExecuteHarvest` helpers | Modify |
| `frontend/src/relay.test.js` | Tests for background-agent session redemption (#3) | Modify |

---

## Background: what each existing piece already does (do not rebuild)

- `strategy/session.js`
  - `prepareSessionAccount()` → generates the ephemeral session account, returns its address. MUST be called before the grant so the grant names it as delegate.
  - `initSession({ permissionContext, delegationManager })` → boots a local-account wallet client that broadcasts via `http()` RPC and extends `erc7710WalletActions()`.
  - `redeemCall({ to, data })` → `sendTransactionWithDelegation({ to, data, permissionContext, delegationManager })` — zero popup.
  - `hasSession()` → true when booted.
- `strategy/grantStore.js` — `saveGrant`/`loadGrant`/`hasValidGrant` persist `{ permissionContext, delegationManager, expiresAt(ms) }` in localStorage. Never persists the session key.
- `strategy/rehydrate.js` — `rehydrateSession()` re-boots `initSession` from a persisted valid grant on page load.
- `relay.js` — `relayDeposit`/`relayGrantPermission` already try `redeemCall` first when `hasSession()`, falling back on throw. `relayWithdraw`/`relayHarvest` (lines 275–289) do NOT — they always go on-chain user-signed. That is gap #3.
- `redelegation.js` — already uses `createDelegation` + `toMetaMaskSmartAccount` for the orchestrator→worker A2A chain. Reuse its import patterns (note: `createCaveatBuilder`/`hashDelegation` live in `@metamask/smart-accounts-kit/utils`).

---

## Task 1: Add the allowed-selector list to config

**Files:**
- Modify: `frontend/src/config.js` (append after the `DEPOSITOR_ABI` block, around line 49)

The `FunctionCall` scope restricts the delegation to a fixed set of contract methods. List exactly the five actions the deposit loop and background loop redeem. SAK accepts ABI function-signature strings directly as selectors — no need to precompute 4-byte hex.

- [ ] **Step 1: Add the constant**

In `frontend/src/config.js`, after the closing `]` of `DEPOSITOR_ABI` (line 49) and before the `// MockVault ABI` comment, insert:

```javascript
// Function selectors the single user→session FunctionCall delegation is scoped to.
// These are EXACTLY the AgentVaultDepositor methods the session account redeems —
// deposit loop (grant + deposit) and background loop (setCapabilities + withdraw + harvest).
// SAK ScopeType.FunctionCall accepts ABI signature strings; the AllowedMethods enforcer
// reverts any call whose selector is not in this set, so widening this list widens authority.
export const DEPOSITOR_SELECTORS = [
  'grantAgentPermission(bytes32,address,uint256,uint256)',
  'executeAgentDeposit(bytes32,address,address,uint256)',
  'setAgentCapabilities(bytes32,bool,bool)',
  'executeWithdraw(bytes32,address,address,uint256)',
  'executeHarvest(bytes32,address,address,bool)',
]
```

- [ ] **Step 2: Verify the file still imports cleanly**

Run: `cd frontend && npx vitest run src/relay.test.js`
Expected: PASS (existing tests unaffected — this is an additive export).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/config.js
git commit -m "feat: add DEPOSITOR_SELECTORS for FunctionCall delegation scope"
```

---

## Task 2: Build the user root FunctionCall delegation module

**Files:**
- Create: `frontend/src/strategy/rootDelegation.js`
- Test: `frontend/src/strategy/rootDelegation.test.js`

This module replaces the token-transfer ERC-7715 grant. It builds a `FunctionCall` delegation FROM the connected user TO the session account, signs it via the user's MetaMask (one EIP-712 signature popup — `custom(window.ethereum)` is correct here because we are SIGNING typed data, not broadcasting), then returns the two fields the session needs.

Key distinction (document it in code): **signing uses `custom(window.ethereum)`** so MetaMask shows the popup; **redemption broadcast uses `http()`** (already handled in `session.js`) because MetaMask blocks `eth_sendRawTransaction` from dapps.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/rootDelegation.test.js`:

```javascript
// frontend/src/strategy/rootDelegation.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock SAK + viem BEFORE importing the module under test.
const signDelegationMock = vi.fn(async () => '0xSIGNATURE')
const createDelegationMock = vi.fn((cfg) => ({ __delegation: true, ...cfg }))
const toSmartAccountMock = vi.fn(async () => ({
  address: '0xUSER',
  environment: { DelegationManager: '0xDELEGATIONMANAGER' },
  signDelegation: signDelegationMock,
}))
vi.mock('@metamask/smart-accounts-kit', () => ({
  createDelegation: (cfg) => createDelegationMock(cfg),
  toMetaMaskSmartAccount: (cfg) => toSmartAccountMock(cfg),
  Implementation: { Stateless7702: 'Stateless7702' },
  ScopeType: { FunctionCall: 'FunctionCall' },
}))
const encodeDelegationsMock = vi.fn(() => '0xENCODEDCONTEXT')
vi.mock('@metamask/smart-accounts-kit/utils', () => ({
  encodeDelegations: (d) => encodeDelegationsMock(d),
}))
vi.mock('viem', () => ({
  createWalletClient: (cfg) => ({ __wallet: true, ...cfg }),
  createPublicClient: (cfg) => ({ __public: true, ...cfg }),
  custom: (provider) => ({ __transport: 'custom', provider }),
  http: (url) => ({ __transport: 'http', url }),
}))
vi.mock('viem/chains', () => ({ baseSepolia: { id: 84532, name: 'Base Sepolia' } }))
vi.mock('../config.js', () => ({
  AGENT_VAULT_DEPOSITOR_ADDRESS: '0xDEPOSITOR',
  DEPOSITOR_SELECTORS: ['grantAgentPermission(bytes32,address,uint256,uint256)'],
}))

import { createUserRootDelegation } from './rootDelegation.js'

describe('createUserRootDelegation', () => {
  beforeEach(() => {
    signDelegationMock.mockClear()
    createDelegationMock.mockClear()
    toSmartAccountMock.mockClear()
    encodeDelegationsMock.mockClear()
    vi.stubGlobal('window', { ethereum: { request: vi.fn() } })
  })

  it('scopes the delegation to the depositor contract + allowed selectors, FROM user TO session', async () => {
    await createUserRootDelegation({ userAddress: '0xUSER', sessionAddress: '0xSESSION' })
    expect(createDelegationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '0xUSER',
        to: '0xSESSION',
        scope: expect.objectContaining({
          type: 'FunctionCall',
          targets: ['0xDEPOSITOR'],
          selectors: ['grantAgentPermission(bytes32,address,uint256,uint256)'],
        }),
      })
    )
  })

  it('signs via the user MetaMask smart account and returns encoded context + manager', async () => {
    const result = await createUserRootDelegation({ userAddress: '0xUSER', sessionAddress: '0xSESSION' })
    expect(signDelegationMock).toHaveBeenCalledOnce()
    expect(encodeDelegationsMock).toHaveBeenCalledWith([
      expect.objectContaining({ signature: '0xSIGNATURE' }),
    ])
    expect(result).toEqual({
      permissionContext: '0xENCODEDCONTEXT',
      delegationManager: '0xDELEGATIONMANAGER',
    })
  })

  it('builds the user smart account with a custom(window.ethereum) signer (signing path, not broadcast)', async () => {
    await createUserRootDelegation({ userAddress: '0xUSER', sessionAddress: '0xSESSION' })
    const cfg = toSmartAccountMock.mock.calls[0][0]
    expect(cfg.implementation).toBe('Stateless7702')
    expect(cfg.address).toBe('0xUSER')
    // signer walletClient must use the injected provider so MetaMask shows the signature popup
    expect(cfg.signer.walletClient.transport.__transport).toBe('custom')
  })

  it('throws a clear error when window.ethereum is missing', async () => {
    vi.stubGlobal('window', {})
    await expect(
      createUserRootDelegation({ userAddress: '0xUSER', sessionAddress: '0xSESSION' })
    ).rejects.toThrow(/no wallet provider/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/rootDelegation.test.js`
Expected: FAIL with "Failed to resolve import './rootDelegation.js'" (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/strategy/rootDelegation.js`:

```javascript
// frontend/src/strategy/rootDelegation.js
// Builds + signs the SINGLE user→session root delegation that makes "sign once, vibe
// forever" legal for arbitrary contract calls.
//
// WHY NOT ERC-7715: wallet_requestExecutionPermissions only grants token-transfer scope
// (erc20-token-periodic). The session later redeems executeAgentDeposit / executeWithdraw /
// executeHarvest — non-transfer calls to the AgentVaultDepositor contract. A token-transfer
// permission's caveat enforcer reverts those, so every redeem silently fell back to a
// per-call MetaMask popup. MetaMask's own docs say arbitrary contract calls must use
// createDelegation, not wallet_grantPermissions. This module is that path.
//
// SIGN vs BROADCAST transport (critical):
//   - SIGNING the delegation uses custom(window.ethereum) → MetaMask shows ONE EIP-712
//     signature popup for the user. This is the only user interaction.
//   - REDEEMING later (session.js) broadcasts via http() RPC, because MetaMask blocks
//     eth_sendRawTransaction from dapps. Different client, different purpose.
//
// OUTPUT shape is intentionally identical to the old parseGrantResult so initSession,
// saveGrant, rehydrate and redeemCall all consume it unchanged.
import {
  createDelegation,
  toMetaMaskSmartAccount,
  Implementation,
  ScopeType,
} from '@metamask/smart-accounts-kit'
import { encodeDelegations } from '@metamask/smart-accounts-kit/utils'
import { createWalletClient, createPublicClient, custom, http } from 'viem'
import { baseSepolia as chain } from 'viem/chains'
import { AGENT_VAULT_DEPOSITOR_ADDRESS, DEPOSITOR_SELECTORS } from '../config.js'

/**
 * Build, sign (one MetaMask popup), and encode the user's root FunctionCall delegation.
 * @param {{userAddress: string, sessionAddress: string}} params
 *   userAddress    — connected MetaMask account (the delegator/grantor)
 *   sessionAddress — ephemeral session account address from prepareSessionAccount()
 *                    (the delegate that redeems later, zero popup)
 * @returns {Promise<{permissionContext: string, delegationManager: string}>}
 */
export async function createUserRootDelegation({ userAddress, sessionAddress }) {
  if (!window?.ethereum) throw new Error('createUserRootDelegation: no wallet provider')

  // Read-only client for account environment resolution (DelegationManager address etc.).
  const publicClient = createPublicClient({
    chain,
    transport: http(import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org'),
  })

  // Signing client over the INJECTED provider → MetaMask shows the signature popup.
  const walletClient = createWalletClient({
    account: userAddress,
    chain,
    transport: custom(window.ethereum),
  })

  // The user's EIP-7702-upgraded account, with MetaMask as the signer.
  const userSmartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: userAddress,
    signer: { walletClient },
  })

  // Scope: only the depositor contract, only the five action selectors. The session
  // account cannot call anything else with this delegation.
  const delegation = createDelegation({
    from: userAddress,
    to: sessionAddress,
    environment: userSmartAccount.environment,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [AGENT_VAULT_DEPOSITOR_ADDRESS],
      selectors: DEPOSITOR_SELECTORS,
    },
  })

  // ONE signature popup. signDelegation returns the signature string.
  const signature = await userSmartAccount.signDelegation({ delegation })
  const signedDelegation = { ...delegation, signature }

  return {
    permissionContext: encodeDelegations([signedDelegation]),
    delegationManager: userSmartAccount.environment.DelegationManager,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/rootDelegation.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/rootDelegation.js frontend/src/strategy/rootDelegation.test.js
git commit -m "feat: build+sign user root FunctionCall delegation for one-grant autonomy"
```

---

## Task 3: Add a loud `bootSession` guard (#2)

**Files:**
- Modify: `frontend/src/strategy/session.js` (add export after `initSession`, around line 69)
- Test: `frontend/src/strategy/session.test.js` (add cases)

Today `app.jsx` does `if (permResult.delegationManager) { initSession(...) }` — when the manager is missing, the branch is skipped silently, `permActive` is still set true, and execution falls to the popup path with no signal to the user. Replace that silent guard with a wrapper that throws a clear, coded error the UI can surface.

- [ ] **Step 1: Write the failing test**

In `frontend/src/strategy/session.test.js`, update the import line and add a new describe block. Change line 20 from:

```javascript
import { initSession, redeemCall, clearSession, getSessionAddress } from './session.js'
```

to:

```javascript
import { initSession, redeemCall, clearSession, getSessionAddress, bootSession, hasSession } from './session.js'
```

Then append before the final closing `})` of the file:

```javascript
describe('bootSession (loud guard)', () => {
  beforeEach(() => { clearSession(); vi.stubGlobal('window', { ethereum: { request: vi.fn() } }) })

  it('boots a redeemable session when context + manager are present', () => {
    const addr = bootSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(addr).toBe('0xSESSION')
    expect(hasSession()).toBe(true)
  })

  it('throws GRANT_INCOMPLETE when delegationManager is missing (never silently continues)', () => {
    expect(() => bootSession({ permissionContext: '0xctx', delegationManager: null }))
      .toThrow(/GRANT_INCOMPLETE/)
    expect(hasSession()).toBe(false)
  })

  it('throws GRANT_INCOMPLETE when permissionContext is missing', () => {
    expect(() => bootSession({ permissionContext: '', delegationManager: '0xdm' }))
      .toThrow(/GRANT_INCOMPLETE/)
    expect(hasSession()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/session.test.js`
Expected: FAIL with "bootSession is not a function" (not yet exported).

- [ ] **Step 3: Write the implementation**

In `frontend/src/strategy/session.js`, insert this function immediately after `initSession` (after its closing `}` at line 69), before `getSessionAddress`:

```javascript
/**
 * Boot the session, but LOUDLY: if the grant is incomplete (no delegationManager or
 * permissionContext), throw a coded error instead of silently leaving the session
 * unbooted. An unbooted session means every later action falls back to a per-call
 * MetaMask popup — the exact "sign once" failure we must never hide from the user.
 * @param {{permissionContext: string, delegationManager: string}} grant
 * @returns {string} session account address
 */
export function bootSession({ permissionContext, delegationManager }) {
  if (!permissionContext) {
    throw new Error('GRANT_INCOMPLETE: no permissionContext returned — autonomous redemption cannot boot')
  }
  if (!delegationManager) {
    throw new Error('GRANT_INCOMPLETE: no delegationManager returned — autonomous redemption cannot boot')
  }
  return initSession({ permissionContext, delegationManager })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/session.test.js`
Expected: PASS (original 6 + 3 new = 9 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/session.js frontend/src/strategy/session.test.js
git commit -m "feat: add loud bootSession guard for incomplete grants"
```

---

## Task 4: Wire the wizard permission step to the new grant (#1 wiring + #2)

**Files:**
- Modify: `frontend/src/app.jsx`
  - imports (lines 23, 26)
  - `handlePermConfirm` (lines 635–688)

Replace the ERC-7715 call with the FunctionCall delegation, prepare the session account first (so the grant names it as delegate), boot loudly, and on any failure surface `permError` + stay on the permission step instead of advancing to execute.

> **Note on testing:** `app.jsx` is a large React component with no existing unit test in this repo; its logic is covered indirectly by the `rootDelegation`, `session`, and `relay` unit tests. This task is pure wiring of already-tested functions. Verification is a clean build + the full suite, plus the manual smoke test at the end.

- [ ] **Step 1: Update imports**

In `frontend/src/app.jsx`, change line 23 from:

```javascript
import { connectWallet, requestERC7715Permission, signSiweForVenice, switchToSepolia, getProvider } from './wallet.js';
```

to:

```javascript
import { connectWallet, signSiweForVenice, switchToSepolia, getProvider } from './wallet.js';
import { createUserRootDelegation } from './strategy/rootDelegation.js';
import { prepareSessionAccount } from './strategy/session.js';
```

Then change line 26 from:

```javascript
import { initSession, clearSession, hasSession } from './strategy/session.js';
```

to:

```javascript
import { bootSession, clearSession, hasSession } from './strategy/session.js';
```

(Note: `initSession` is no longer called directly from `app.jsx` — `bootSession` wraps it. `prepareSessionAccount` is added. Verify no other line in `app.jsx` references `initSession`; if it does, repoint it to `bootSession`.)

- [ ] **Step 2: Replace `handlePermConfirm`**

In `frontend/src/app.jsx`, replace the entire `handlePermConfirm` function (lines 635–688) with:

```javascript
  const handlePermConfirm = async () => {
    setPermPhase("prompting");
    setPermError(null);
    try {
      // Name the session account as the delegate BEFORE signing, so the grant binds
      // redemption authority to it. Same account is reused by initSession/redeemCall.
      const sessionAddress = prepareSessionAccount();

      // ONE MetaMask signature: a FunctionCall delegation scoped to AgentVaultDepositor's
      // action selectors. This is the legal "sign once" — token-transfer ERC-7715 could not
      // authorize these arbitrary contract calls (they reverted → popup per call).
      const grant = await createUserRootDelegation({
        userAddress: realAddress,
        sessionAddress,
      });
      const expiresAtMs = Date.now() + 86400 * 1000;

      console.log('[strategy] root delegation grant:', {
        permissionContext: grant.permissionContext,
        delegationManager: grant.delegationManager,
        sessionAddress,
      });

      // Boot LOUDLY — bootSession throws GRANT_INCOMPLETE if the manager/context is missing,
      // so we never silently advance to execution on a popup-per-call path.
      bootSession({
        permissionContext: grant.permissionContext,
        delegationManager: grant.delegationManager,
      });
      saveGrant({
        permissionContext: grant.permissionContext,
        delegationManager: grant.delegationManager,
        expiresAt: expiresAtMs,
      });

      setPermContext(grant.permissionContext);
      setPermActive(true);
      setPermExpiresAt(expiresAtMs);
      setPermPhase("idle");

      const ag = strategy?.agents || [];
      ag.forEach((a) => addLog({
        event: "PermissionGranted",
        agent: a.id,
        meta: `vault ${shortAddr(a.vault.addr)} · ${a.allocation} usdc max`,
      }));
      setTimeout(() => {
        setStage("execute");
        startExecution(grant.permissionContext);
      }, 600);
    } catch (err) {
      // Loud failure: stay on the permission step, show the error, do NOT advance.
      setPermPhase("idle");
      setPermActive(false);
      setPermError(err.message);
      addLog({ event: "AgentFailed", meta: `permission failed: ${err.message}` });
    }
  };
```

- [ ] **Step 3: Verify `handleGrant` still drives the UI phase**

Confirm line 628 `const handleGrant = () => setPermPhase("prompting");` is unchanged — `handleGrant` is the button that opens the confirm UI; `handlePermConfirm` is the confirm action. (`handlePermConfirm` now sets `prompting` itself at entry for the duration of signing, which is harmless and gives an in-progress state.)

- [ ] **Step 4: Build the frontend to catch import/JSX errors**

Run: `cd frontend && npx vite build`
Expected: build succeeds, no "is not exported by" or unresolved-import errors. (If `wallet.js`'s now-unused `requestERC7715Permission` triggers a lint/unused warning, that is acceptable — leave the function in `wallet.js` as a documented fallback; do not delete it in this task.)

- [ ] **Step 5: Run the full unit suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — all suites green (rootDelegation, session, relay, plus existing).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: grant one FunctionCall delegation at permission step, fail loud on incomplete grant"
```

---

## Task 5: Route the background agent through session redemption (#3)

**Files:**
- Modify: `frontend/src/relay.js`
  - add encode helpers (after `encodeGrantAgentPermission`, around line 35)
  - rewrite `relayWithdraw`/`relayHarvest` (lines 275–289)
- Test: `frontend/src/relay.test.js` (add a describe block)

`relayWithdraw`/`relayHarvest` currently always run `ensureBgSetup` (an EIP-5792 batch popup) + a user-signed on-chain action. When a session is active, the same calls (`grantAgentPermission`, `setAgentCapabilities`, `executeWithdraw`/`executeHarvest`) are all in `DEPOSITOR_SELECTORS`, so the session can redeem each with zero popup. Mirror the `relayDeposit` pattern: try redeem first, fall back to the existing on-chain path on throw or when no session.

- [ ] **Step 1: Write the failing test**

In `frontend/src/relay.test.js`, the existing `./wallet.js` mock (lines 10–14) already stubs `executeWithdrawOnChain`/`executeHarvestOnChain`/`batchCalls`. Add this describe block before the final closing of the file (after the existing `describe('relay redeem-first', ...)` block):

```javascript
describe('background agent redeem-first (#3)', () => {
  beforeEach(() => { redeemMock.mockReset(); hasSessionMock.mockReset(); global.fetch = vi.fn(async () => ({ ok: false })) })

  it('relayWithdraw redeems via session (zero popup) when a session is active', async () => {
    hasSessionMock.mockReturnValue(true)
    redeemMock.mockResolvedValue('0xREDEEMWITHDRAW')
    const res = await relayWithdraw({ user: USER, vault: VAULT, amount: 5n })
    expect(res.status).toBe('redeemed')
    expect(res.txHash).toBe('0xREDEEMWITHDRAW')
    // grant + setCapabilities + withdraw all redeemed → 3 redeemCall invocations, no batch popup
    expect(redeemMock).toHaveBeenCalledTimes(3)
  })

  it('relayWithdraw falls back to the on-chain batch path when no session', async () => {
    hasSessionMock.mockReturnValue(false)
    const res = await relayWithdraw({ user: USER, vault: VAULT, amount: 5n })
    expect(res.status).toBe('onchain')
    expect(res.txHash).toBe('0xONCHAINWD')
  })

  it('relayHarvest redeems via session when active', async () => {
    hasSessionMock.mockReturnValue(true)
    redeemMock.mockResolvedValue('0xREDEEMHARVEST')
    const res = await relayHarvest({ user: USER, vault: VAULT, recompound: false })
    expect(res.status).toBe('redeemed')
    expect(res.txHash).toBe('0xREDEEMHARVEST')
    expect(redeemMock).toHaveBeenCalledTimes(3)
  })
})
```

Update the `./wallet.js` mock at the top of the file (lines 10–14) so the on-chain fallbacks return identifiable hashes. Replace:

```javascript
vi.mock('./wallet.js', () => ({
  grantAgentPermissionOnChain: vi.fn(async () => '0xONCHAINGRANT'),
  executeAgentDepositOnChain: vi.fn(async () => '0xONCHAINDEP'),
  batchCalls: vi.fn(), executeWithdrawOnChain: vi.fn(), executeHarvestOnChain: vi.fn(),
}))
```

with:

```javascript
vi.mock('./wallet.js', () => ({
  grantAgentPermissionOnChain: vi.fn(async () => '0xONCHAINGRANT'),
  executeAgentDepositOnChain: vi.fn(async () => '0xONCHAINDEP'),
  batchCalls: vi.fn(async () => '0xBATCH'),
  executeWithdrawOnChain: vi.fn(async () => '0xONCHAINWD'),
  executeHarvestOnChain: vi.fn(async () => '0xONCHAINHV'),
}))
```

Also extend the `./config.js` mock (lines 15–17) so the background ABI encoders have an address. Replace:

```javascript
vi.mock('./config.js', () => ({
  ONE_SHOT_RELAYER_URL: 'http://x', AGENT_VAULT_DEPOSITOR_ADDRESS: '0xDEP', SEPOLIA_CHAIN_ID: 84532,
}))
```

with:

```javascript
vi.mock('./config.js', () => ({
  ONE_SHOT_RELAYER_URL: 'http://x',
  AGENT_VAULT_DEPOSITOR_ADDRESS: '0x' + '44'.repeat(20),
  SEPOLIA_CHAIN_ID: 84532,
}))
```

And update the `relayWithdraw`/`relayHarvest` import line (line 19). Change:

```javascript
import { relayGrantPermission, relayDeposit } from './relay.js'
```

to:

```javascript
import { relayGrantPermission, relayDeposit, relayWithdraw, relayHarvest } from './relay.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/relay.test.js`
Expected: FAIL — the new cases expect `status: 'redeemed'` and 3 `redeemCall`s, but the current `relayWithdraw`/`relayHarvest` never call `redeemCall` (they always batch + on-chain).

- [ ] **Step 3: Add the background encode helpers**

In `frontend/src/relay.js`, after `encodeGrantAgentPermission` (closing `}` at line 35) and before the `submitRelay` doc comment, insert:

```javascript
/** Encode setAgentCapabilities calldata. */
export function encodeSetAgentCapabilities(agentId, allowWithdraw, allowHarvest) {
  const iface = new ethers.Interface([
    'function setAgentCapabilities(bytes32 agentId, bool allowWithdraw, bool allowHarvest)'
  ])
  return iface.encodeFunctionData('setAgentCapabilities', [agentId, allowWithdraw, allowHarvest])
}

/** Encode executeWithdraw calldata. */
export function encodeExecuteWithdraw(agentId, user, vault, amount) {
  const iface = new ethers.Interface([
    'function executeWithdraw(bytes32 agentId, address user, address vault, uint256 amount)'
  ])
  return iface.encodeFunctionData('executeWithdraw', [agentId, user, vault, amount])
}

/** Encode executeHarvest calldata. */
export function encodeExecuteHarvest(agentId, user, vault, recompound) {
  const iface = new ethers.Interface([
    'function executeHarvest(bytes32 agentId, address user, address vault, bool recompound)'
  ])
  return iface.encodeFunctionData('executeHarvest', [agentId, user, vault, recompound])
}
```

- [ ] **Step 4: Rewrite `relayWithdraw` and `relayHarvest`**

In `frontend/src/relay.js`, replace the two functions at lines 274–289 (the `relayWithdraw` and `relayHarvest` definitions, NOT `ensureBgSetup` above them) with:

```javascript
/**
 * Emergency withdraw `amount` (units) from `vault` back to `user`.
 * Session active → redeem grant + setCapabilities + withdraw, each zero popup.
 * No session → existing on-chain path (setup batch popup + user-signed action).
 */
export async function relayWithdraw({ user, vault, amount }) {
  const agentId = bgAgentId(vault)
  const expiresAt = Math.floor(Date.now() / 1000) + 3600

  if (hasSession()) {
    try {
      // 1) grant permission for this background agentId (redeemed)
      await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: await encodeGrantAgentPermission(agentId, vault, BG_MAX, expiresAt) })
      // 2) enable withdraw capability (redeemed)
      await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: encodeSetAgentCapabilities(agentId, true, true) })
      // 3) the withdraw action (redeemed)
      const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: encodeExecuteWithdraw(agentId, user, vault, BigInt(amount)) })
      return { txHash, status: 'redeemed' }
    } catch (e) {
      console.warn('[relay] withdraw redeem failed, falling back on-chain:', e?.message)
    }
  }

  // Fallback: setup batch (one popup) + user-signed action with explicit gasLimit.
  await ensureBgSetup(agentId, vault)
  const txHash = await executeWithdrawOnChain(agentId, user, vault, BigInt(amount))
  return { txHash, status: 'onchain' }
}

/**
 * Harvest rewards from `vault` for `user` (optionally recompound).
 * Session active → redeem grant + setCapabilities + harvest, each zero popup.
 * No session → existing on-chain path.
 */
export async function relayHarvest({ user, vault, recompound = false }) {
  const agentId = bgAgentId(vault)
  const expiresAt = Math.floor(Date.now() / 1000) + 3600

  if (hasSession()) {
    try {
      await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: await encodeGrantAgentPermission(agentId, vault, BG_MAX, expiresAt) })
      await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: encodeSetAgentCapabilities(agentId, true, true) })
      const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: encodeExecuteHarvest(agentId, user, vault, recompound) })
      return { txHash, status: 'redeemed' }
    } catch (e) {
      console.warn('[relay] harvest redeem failed, falling back on-chain:', e?.message)
    }
  }

  await ensureBgSetup(agentId, vault)
  const txHash = await executeHarvestOnChain(agentId, user, vault, recompound)
  return { txHash, status: 'onchain' }
}
```

(`redeemCall` and `hasSession` are already imported at the top of `relay.js` line 4. `BG_MAX`, `bgAgentId`, `ensureBgSetup`, `executeWithdrawOnChain`, `executeHarvestOnChain` are already defined/imported. The encode helpers were added in Step 3.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/relay.test.js`
Expected: PASS — existing `relay redeem-first` cases plus the 3 new background cases.

- [ ] **Step 6: Run the full suite + build**

Run: `cd frontend && npx vitest run && npx vite build`
Expected: all tests PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/relay.js frontend/src/relay.test.js
git commit -m "feat: redeem background harvest/withdraw via session for zero-popup vibe loop"
```

---

## Manual smoke test (after all tasks)

Real wallet verification — the unit tests mock SAK/viem, so confirm the live signature flow once.

1. `cd frontend && npx vite` (or `npx serve` per CLAUDE.md), open in a browser with **MetaMask Flask 13.9+** on **Base Sepolia**.
2. Walk the wizard: Strategy → Connect (1 connect popup, optional 1 SIWE popup) → Skills → **Grant Permission**.
3. At Grant Permission: expect **exactly one** MetaMask signature popup (EIP-712 typed-data, the FunctionCall delegation). Confirm.
4. Execute step: agents run. Expect **zero** further MetaMask popups for grant/deposit. Watch the activity log for `redeemed` statuses (console `[strategy] root delegation grant` logs the `delegationManager`).
5. Reload the page mid-window, re-enter the wizard → `handleSkillsContinue` should skip the permission step entirely (`hasValidGrant()` true) and run with no popup.
6. Trigger a background harvest/withdraw (Dashboard/Settings background agent) → expect `redeemed` status in logs, no popup.
7. Negative path: to confirm #2 is loud, temporarily force `delegationManager` undefined (e.g. comment out the field in the returned object) and confirm the UI stays on the permission step showing the `GRANT_INCOMPLETE` error rather than advancing. Revert the temporary change.

---

## Self-Review

**Spec coverage:**
- #1(A) proper FunctionCall route — Tasks 1, 2, 4. ✅ (config selectors → rootDelegation module → wired into permission step; redeem path unchanged because `permissionContext`/`delegationManager` shape preserved)
- #2 loud boot — Task 3 (`bootSession` throws `GRANT_INCOMPLETE`) + Task 4 (app surfaces `permError`, stays on step, sets `permActive(false)`). ✅
- #3 background redeem — Task 5 (session branch in `relayWithdraw`/`relayHarvest` + encode helpers + tests). ✅

**Placeholder scan:** No TBD/TODO/"add error handling" — every code step shows full code, every test shows full assertions, every command shows expected output. ✅

**Type/name consistency:**
- `createUserRootDelegation({ userAddress, sessionAddress })` → returns `{ permissionContext, delegationManager }` — consumed identically by `bootSession`, `saveGrant`, `redeemCall`. ✅
- `bootSession({ permissionContext, delegationManager })` — same field names as `initSession`. ✅
- `DEPOSITOR_SELECTORS` defined Task 1, imported Task 2, consumed in `rootDelegation.js`. ✅
- Encode helpers `encodeSetAgentCapabilities`/`encodeExecuteWithdraw`/`encodeExecuteHarvest` defined Task 5 Step 3, used Task 5 Step 4. ✅
- `bgAgentId`, `BG_MAX`, `ensureBgSetup` reused from existing `relay.js` — names verified against current source. ✅

**Open risk flagged for executor:** `Implementation.Stateless7702` requires the user's account to be EIP-7702-upgraded on Base Sepolia (SAK handles this during connect). If `toMetaMaskSmartAccount` rejects because the account isn't upgraded, the connect step's upgrade must complete first — verify the Connect step (`handleUpgrade`) ran before reaching Grant Permission. The manual smoke test step 7 covers the loud-failure behavior if this happens in practice.

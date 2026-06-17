# One-Grant Session Redemption for /strategy Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/strategy` wizard ask the user for exactly ONE MetaMask signature (the ERC-7715 grant at step 04); every on-chain action afterward — grant-permission, deposit, and re-entry within validity — executes via ERC-7710 session redemption with zero further popups.

**Architecture:** The user signs one ERC-7715 `requestExecutionPermissions` call. SAK returns a `permissionContext` + `delegationManager`. We create an in-memory **session account** (ephemeral viem key) and a **session wallet client** extended with `erc7710WalletActions`. All later contract calls (`grantAgentPermission`, `executeAgentDeposit`) route through `sessionClient.sendTransactionWithDelegation({ to, data, permissionContext, delegationManager })`, which the DelegationManager redeems *from the user's smart account* (`msg.sender == user`) — satisfying the deployed `AgentVaultDepositor` checks with no redeploy and no popup. The granted context + expiry persist to `localStorage` so reload / wizard re-entry inside the validity window skips step 04 entirely. The existing `/api/relay` managed path and on-chain user-signed path remain as ordered fallbacks if redemption throws.

**Tech Stack:** `@metamask/smart-accounts-kit@1.6.0` (`erc7710WalletActions`, `erc7715ProviderActions`), `viem` (`createWalletClient`, `privateKeyToAccount`, `generatePrivateKey`), `ethers v6` (calldata encode), React 18 (Babel CDN, no build), Vitest, Base Sepolia (84532).

---

## Background: Why this works without a contract redeploy

`contracts/AgentVaultDepositor.sol` (already deployed at `0xcAD4A07Db284AB55518AF406fD18877b2AC5A442`):

```solidity
function executeAgentDeposit(bytes32 agentId, address user, address vault, uint256 amount) ... {
    AgentPermission storage perm = agentPermissions[user][agentId];   // line 122
    ...
    if (msg.sender != user) revert UnauthorizedCaller();              // line 129
}
function grantAgentPermission(bytes32 agentId, ...) {
    agentPermissions[msg.sender][agentId] = AgentPermission({ ... }); // line 72
}
```

Both functions are keyed on the caller being the user. ERC-7710 `sendTransactionWithDelegation` redeems the user's signed delegation through the DelegationManager, which executes the inner call **from the user's own smart account**. So `msg.sender == user` holds, both functions succeed, and the user never sees a popup after the initial grant. This is the SAK two-layer model (ERC-7715 grant → ERC-7710 redeem) from `planning/inspiration/SAK.md` §9.2.

### Current popup sources being eliminated

| # | Where | Today | After |
|---|-------|-------|-------|
| 1 | `handlePermConfirm` → `requestERC7715Permission` (step 04) | 1 popup (KEEP) | 1 popup ✅ |
| 2 | `orchestrator.dispatch` → `batchCalls(grantCalls)` (EIP-5792) | +1 popup | 0 — session redeem |
| 3 | `worker.execute` → `relayGrantPermission` → `grantAgentPermissionOnChain` | +N popups (fallback) | 0 — session redeem |
| 4 | `worker.execute` → `relayDeposit` → `executeAgentDepositOnChain` | +N popups (fallback) | 0 — session redeem |

### Files touched (poros = /strategy)

- **Create:** `frontend/src/strategy/session.js` — session account + ERC-7710 client factory + redeem helper (NEW, the core).
- **Create:** `frontend/src/strategy/session.test.js` — unit tests for persistence + client shape.
- **Create:** `frontend/src/strategy/grantStore.js` — persist/load/clear granted permission (context+expiry+delegationManager).
- **Create:** `frontend/src/strategy/grantStore.test.js` — unit tests for round-trip + expiry.
- **Modify:** `frontend/src/wallet.js` — `requestERC7715Permission` returns `delegationManager`; add session-client wiring exports.
- **Modify:** `frontend/src/relay.js` — `relayGrantPermission` / `relayDeposit` try session redemption first, then managed, then on-chain.
- **Modify:** `frontend/src/app.jsx` — step 04 handler persists grant + boots session; rehydrate-on-mount effect; `handleAgain`/`handleDisconnect` clear store.

> **Convention note:** This codebase ships React via Babel CDN (no bundler step for the app itself), but `frontend/` has a real `node_modules` and `vite.config.js`. SAK + viem are already imported by `redelegation.js`, so ESM `import` from these packages is proven to work in this project. Follow that exact import style.

---

## Task 1: grantStore — persist the single grant across reloads

**Files:**
- Create: `frontend/src/strategy/grantStore.js`
- Test: `frontend/src/strategy/grantStore.test.js`

The granted permission must survive reload / wizard re-entry so the user is truly asked once. Store the non-secret `permissionContext`, `delegationManager`, and `expiresAt` in `localStorage`. The session *private key* is NOT persisted (regenerated per page-load; a fresh ephemeral key re-delegated under the same root is fine and avoids leaking a standing key — same rationale as `redelegation.js`).

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/strategy/grantStore.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveGrant, loadGrant, clearGrant, hasValidGrant } from './grantStore.js'

describe('grantStore', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('round-trips a saved grant', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: 9999999999000 })
    const g = loadGrant()
    expect(g).toEqual({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: 9999999999000 })
  })

  it('returns null when nothing stored', () => {
    expect(loadGrant()).toBeNull()
  })

  it('hasValidGrant is true only for a future, complete grant', () => {
    expect(hasValidGrant()).toBe(false)
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() + 60_000 })
    expect(hasValidGrant()).toBe(true)
  })

  it('hasValidGrant is false for an expired grant', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() - 1 })
    expect(hasValidGrant()).toBe(false)
  })

  it('clearGrant removes it', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() + 60_000 })
    clearGrant()
    expect(loadGrant()).toBeNull()
  })

  it('loadGrant returns null when context is missing (corrupt)', () => {
    localStorage.setItem('yv_strategy_grant', JSON.stringify({ delegationManager: '0xdm', expiresAt: Date.now() + 60_000 }))
    expect(loadGrant()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/grantStore.test.js`
Expected: FAIL — `Cannot find module './grantStore.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/strategy/grantStore.js
// Persists the SINGLE ERC-7715 grant so the user is asked exactly once.
// Stores only non-secret data (opaque permissionContext, delegationManager address,
// expiry ms). The session private key is NEVER persisted — it is regenerated per
// page-load and re-used under the same root grant (see strategy/session.js).

const GRANT_KEY = 'yv_strategy_grant'

/**
 * @param {{permissionContext: string, delegationManager: string, expiresAt: number}} grant
 *   expiresAt is unix MILLISECONDS.
 */
export function saveGrant(grant) {
  if (!grant?.permissionContext || !grant?.delegationManager || !grant?.expiresAt) return
  localStorage.setItem(GRANT_KEY, JSON.stringify({
    permissionContext: grant.permissionContext,
    delegationManager: grant.delegationManager,
    expiresAt: grant.expiresAt,
  }))
}

/** @returns {{permissionContext, delegationManager, expiresAt}|null} */
export function loadGrant() {
  const raw = localStorage.getItem(GRANT_KEY)
  if (!raw) return null
  try {
    const g = JSON.parse(raw)
    if (!g?.permissionContext || !g?.delegationManager || !g?.expiresAt) return null
    return g
  } catch {
    return null
  }
}

export function clearGrant() {
  localStorage.removeItem(GRANT_KEY)
}

/** True when a complete, unexpired grant is stored. */
export function hasValidGrant() {
  const g = loadGrant()
  return !!g && g.expiresAt > Date.now()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/grantStore.test.js`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/grantStore.js frontend/src/strategy/grantStore.test.js
git commit -m "feat: persist single ERC-7715 grant across reloads"
```

---

## Task 2: session.js — ERC-7710 session account + redeem helper

**Files:**
- Create: `frontend/src/strategy/session.js`
- Test: `frontend/src/strategy/session.test.js`

This is the core. It owns:
1. An **ephemeral session account** (viem key, in-memory, per page-load — never bundled, never persisted), mirroring the security note in `redelegation.js`.
2. A **session wallet client** extended with `erc7710WalletActions()` whose transport is the user's `window.ethereum` (so redemption is signed by the session account but submitted through MetaMask's provider, no popup because the session key signs programmatically).
3. `redeemCall({ to, data })` — the single entry point all later on-chain actions use. Throws if no active grant (caller falls back).

> **API shape (verified against installed `@metamask/smart-accounts-kit@1.6.0`):**
> - `erc7710WalletActions()` adds `sendTransactionWithDelegation(args) => Promise<0x...>`
> - `args = SendTransactionParameters & { permissionContext: Hex, delegationManager: Hex }`
> - The redeemed call's `to`/`data`/`value` are standard `sendTransaction` fields.

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/strategy/session.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock SAK + viem BEFORE importing the module under test.
const sendTxMock = vi.fn(async () => '0xdeadbeef')
vi.mock('@metamask/smart-accounts-kit/actions', () => ({
  erc7710WalletActions: () => (client) => ({ ...client, sendTransactionWithDelegation: sendTxMock }),
}))
vi.mock('viem', () => ({
  createWalletClient: (cfg) => ({ ...cfg, extend: (fn) => ({ ...cfg, ...fn({ ...cfg }) }) }),
  custom: (p) => ({ __transport: p }),
}))
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: (k) => ({ address: '0xSESSION', __key: k }),
  generatePrivateKey: () => '0xPRIV',
}))

import { initSession, redeemCall, clearSession, getSessionAddress } from './session.js'

describe('session', () => {
  beforeEach(() => {
    sendTxMock.mockClear()
    clearSession()
    vi.stubGlobal('window', { ethereum: { request: vi.fn() } })
  })

  it('initSession creates a session account with an address', () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(getSessionAddress()).toBe('0xSESSION')
  })

  it('redeemCall routes to sendTransactionWithDelegation with context + manager', async () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    const hash = await redeemCall({ to: '0xVault', data: '0xcalldata' })
    expect(hash).toBe('0xdeadbeef')
    expect(sendTxMock).toHaveBeenCalledWith(expect.objectContaining({
      to: '0xVault', data: '0xcalldata', permissionContext: '0xctx', delegationManager: '0xdm',
    }))
  })

  it('redeemCall throws when no session is active', async () => {
    await expect(redeemCall({ to: '0xVault', data: '0x' })).rejects.toThrow(/no active session/i)
  })

  it('clearSession disables redemption', async () => {
    initSession({ permissionContext: '0xctx', delegationManager: '0xdm' })
    clearSession()
    await expect(redeemCall({ to: '0xVault', data: '0x' })).rejects.toThrow(/no active session/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/session.test.js`
Expected: FAIL — `Cannot find module './session.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/strategy/session.js
// ERC-7710 session redemption — the "execute many, sign once" core.
// After the user grants ONE ERC-7715 permission, every later on-chain action
// (grantAgentPermission, executeAgentDeposit) is redeemed by an ephemeral session
// account via sendTransactionWithDelegation. The DelegationManager executes the
// inner call FROM the user's smart account (msg.sender == user), so the deployed
// AgentVaultDepositor checks pass with no redeploy and no MetaMask popup.
//
// SECURITY: the session private key is generated in memory per page-load and is
// NEVER persisted or bundled. It only holds redemption authority scoped under the
// user's freshly-signed root grant, and is discarded on reload. Same rationale as
// the orchestrator key in redelegation.js.
import { createWalletClient, custom } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { erc7710WalletActions } from '@metamask/smart-accounts-kit/actions'

let sessionClient = null
let sessionAccount = null
let activeContext = null
let activeManager = null

/**
 * Boot the ERC-7710 session from a granted permission. Idempotent per grant.
 * @param {{permissionContext: string, delegationManager: string}} grant
 */
export function initSession({ permissionContext, delegationManager }) {
  if (!permissionContext || !delegationManager) throw new Error('initSession: missing context/manager')
  if (!window?.ethereum) throw new Error('initSession: no wallet provider')

  sessionAccount = privateKeyToAccount(generatePrivateKey())
  sessionClient = createWalletClient({
    account: sessionAccount,
    transport: custom(window.ethereum),
  }).extend(erc7710WalletActions())

  activeContext = permissionContext
  activeManager = delegationManager
  return sessionAccount.address
}

/** @returns {string|null} session account address, or null if not booted */
export function getSessionAddress() {
  return sessionAccount?.address || null
}

/** True when a session is booted and can redeem. */
export function hasSession() {
  return !!sessionClient && !!activeContext && !!activeManager
}

/**
 * Redeem ONE contract call through the granted permission. Zero popup.
 * @param {{to: string, data: string, value?: bigint}} call
 * @returns {Promise<string>} tx hash
 */
export async function redeemCall({ to, data, value = 0n }) {
  if (!hasSession()) throw new Error('redeemCall: no active session')
  return sessionClient.sendTransactionWithDelegation({
    to,
    data,
    value,
    permissionContext: activeContext,
    delegationManager: activeManager,
  })
}

/** Tear down the session (on revoke / disconnect / new strategy). */
export function clearSession() {
  sessionClient = null
  sessionAccount = null
  activeContext = null
  activeManager = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/session.test.js`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/session.js frontend/src/strategy/session.test.js
git commit -m "feat: add ERC-7710 session redemption core for popup-free execution"
```

---

## Task 3: wallet.js — surface delegationManager from the grant

**Files:**
- Modify: `frontend/src/wallet.js:93-130` (`requestERC7715Permission`)

The current `requestERC7715Permission` returns only `permissionContext` + `grantedPermissions`. SAK's response also carries `delegationManager` (the address redemption is sent to). We need it for `initSession`. The raw `wallet_requestExecutionPermissions` result is an array of `PermissionResponse` objects each with `context` + `delegationManager` (verified against SAK 1.6.0 `PermissionResponse` type).

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/wallet.test.js  (create if absent)
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./flaskDetect.js', () => ({ requireFlask: vi.fn(async () => {}) }))
vi.mock('./readProvider.js', () => ({ getReadProvider: () => ({}) }))
vi.mock('ethers', () => ({ ethers: { BrowserProvider: class {}, Contract: class {}, Interface: class {} } }))

import { requestERC7715Permission } from './wallet.js'

describe('requestERC7715Permission', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      ethereum: {
        request: vi.fn(async ({ method }) => {
          if (method === 'wallet_requestExecutionPermissions') {
            return [{ context: '0xCTX', delegationManager: '0xDM', dependencies: [] }]
          }
          return null
        }),
      },
    })
  })

  it('returns delegationManager from the granted permission', async () => {
    // connectWallet sets module-level `account`; emulate by requesting accounts first.
    await window.ethereum.request({ method: 'eth_requestAccounts' })
    // requestERC7715Permission needs `account` set — see Step 3 note on test seam.
    const res = await requestERC7715Permission(86400)
    expect(res.permissionContext).toBe('0xCTX')
    expect(res.delegationManager).toBe('0xDM')
  })
})
```

> **Test seam note:** `requestERC7715Permission` guards on the module-level `account` (set by `connectWallet`). If isolating it in a unit test is awkward, add a tiny test-only setter `export function __setAccountForTest(a){ account = a }` guarded by a comment, OR assert the parsing logic by extracting a pure `parseGrantResult(result)` helper (preferred — see Step 3). The plan uses the pure-helper approach so no test-only export leaks into production.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/wallet.test.js`
Expected: FAIL — `res.delegationManager` is `undefined`

- [ ] **Step 3: Write minimal implementation**

Extract a pure parser and use it inside `requestERC7715Permission`. Replace the `return { permissionContext..., grantedPermissions... }` block at the end of `requestERC7715Permission` (currently `frontend/src/wallet.js:126-130`):

```javascript
// ADD near top of wallet.js (after imports) — pure, testable parser.
/**
 * Normalize the wallet_requestExecutionPermissions result into the fields the
 * session layer needs. SAK returns an array of PermissionResponse objects, each
 * carrying { context, delegationManager, dependencies }.
 * @param {any} result
 * @returns {{permissionContext: string, delegationManager: string|null, grantedPermissions: Array}}
 */
export function parseGrantResult(result) {
  const first = Array.isArray(result) ? result[0] : result
  return {
    permissionContext: first?.context || first?.permissionContext || result?.permissionContext || '0xmock',
    delegationManager: first?.delegationManager || null,
    grantedPermissions: Array.isArray(result) ? result : (result?.grantedPermissions || []),
  }
}
```

Then change the tail of `requestERC7715Permission`:

```javascript
  // ...existing code that sets `const result = await window.ethereum.request({...})`
  if (!result) throw new Error('No permission result returned from MetaMask')
  return parseGrantResult(result)
```

> Keep the existing `'0xmock'` demo fallback behavior intact via `parseGrantResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/wallet.test.js`
Expected: PASS

(If the `account`-guard seam blocks the full-function test, keep a focused unit test on `parseGrantResult` directly — it is exported and pure:)

```javascript
import { parseGrantResult } from './wallet.js'
it('parseGrantResult extracts context + manager from array', () => {
  const r = parseGrantResult([{ context: '0xCTX', delegationManager: '0xDM' }])
  expect(r).toMatchObject({ permissionContext: '0xCTX', delegationManager: '0xDM' })
})
it('parseGrantResult falls back to 0xmock with no context', () => {
  expect(parseGrantResult(null).permissionContext).toBe('0xmock')
})
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet.js frontend/src/wallet.test.js
git commit -m "feat: expose delegationManager from ERC-7715 grant result"
```

---

## Task 4: relay.js — redeem-first for grant + deposit

**Files:**
- Modify: `frontend/src/relay.js:169-202` (`relayGrantPermission`, `relayDeposit`)

Make session redemption the FIRST attempt for both relayed actions, before the managed proxy and before user-signed on-chain. Order: **session redeem → managed API → on-chain user-signed**. Session redeem throws when no grant is active (e.g. EIP-5792 full-batch path on a wallet without 5792), so the existing fallbacks stay intact.

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/relay.test.js  (create if absent)
import { describe, it, expect, beforeEach, vi } from 'vitest'

const redeemMock = vi.fn()
const hasSessionMock = vi.fn()
vi.mock('./strategy/session.js', () => ({
  redeemCall: (...a) => redeemMock(...a),
  hasSession: () => hasSessionMock(),
}))
vi.mock('./wallet.js', () => ({
  grantAgentPermissionOnChain: vi.fn(async () => '0xONCHAINGRANT'),
  executeAgentDepositOnChain: vi.fn(async () => '0xONCHAINDEP'),
  batchCalls: vi.fn(), executeWithdrawOnChain: vi.fn(), executeHarvestOnChain: vi.fn(),
}))
vi.mock('./config.js', () => ({
  ONE_SHOT_RELAYER_URL: 'http://x', AGENT_VAULT_DEPOSITOR_ADDRESS: '0xDEP', SEPOLIA_CHAIN_ID: 84532,
}))

import { relayGrantPermission, relayDeposit } from './relay.js'

describe('relay redeem-first', () => {
  beforeEach(() => { redeemMock.mockReset(); hasSessionMock.mockReset(); global.fetch = vi.fn(async () => ({ ok: false })) })

  it('relayGrantPermission uses session redemption when a session is active', async () => {
    hasSessionMock.mockReturnValue(true)
    redeemMock.mockResolvedValue('0xREDEEMGRANT')
    const res = await relayGrantPermission({ agentId: '0xa', vault: '0xv', maxAmount: 1n, expiresAt: 9999999999, permissionContext: '0xctx' })
    expect(res.txHash).toBe('0xREDEEMGRANT')
    expect(res.status).toBe('redeemed')
  })

  it('relayGrantPermission falls back to on-chain when no session', async () => {
    hasSessionMock.mockReturnValue(false)
    const res = await relayGrantPermission({ agentId: '0xa', vault: '0xv', maxAmount: 1n, expiresAt: 9999999999, permissionContext: '0xctx' })
    expect(res.txHash).toBe('0xONCHAINGRANT')
  })

  it('relayDeposit uses session redemption first', async () => {
    hasSessionMock.mockReturnValue(true)
    redeemMock.mockResolvedValue('0xREDEEMDEP')
    const res = await relayDeposit({ agentId: '0xa', user: '0xu', vault: '0xv', amount: 1n, permissionContext: '0xctx' })
    expect(res.txHash).toBe('0xREDEEMDEP')
    expect(res.status).toBe('redeemed')
  })

  it('relayDeposit falls back to managed→on-chain when redeem throws', async () => {
    hasSessionMock.mockReturnValue(true)
    redeemMock.mockRejectedValue(new Error('redeem boom'))
    // managed proxy returns !ok (configured=false) → on-chain
    const res = await relayDeposit({ agentId: '0xa', user: '0xu', vault: '0xv', amount: 1n, permissionContext: '0xctx' })
    expect(res.txHash).toBe('0xONCHAINDEP')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/relay.test.js`
Expected: FAIL — current `relayGrantPermission` returns `status: 'onchain'`, never `'redeemed'`

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `relay.js` (after the existing imports):

```javascript
import { redeemCall, hasSession } from './strategy/session.js'
```

Replace `relayGrantPermission` (currently `frontend/src/relay.js:169-178`):

```javascript
export async function relayGrantPermission({ agentId, vault, maxAmount, expiresAt, permissionContext }) {
  const calldata = await encodeGrantAgentPermission(agentId, vault, maxAmount, expiresAt)

  // 1) Session redemption — zero popup, redeemed from the user's smart account.
  if (hasSession()) {
    try {
      const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: calldata })
      return { txHash, status: 'redeemed' }
    } catch (e) {
      console.warn('[relay] grant redeem failed, falling back:', e?.message)
    }
  }

  // 2) Keyless 1Shot relay (mainnet only) — unchanged.
  if (!ONESHOT_SUPPORTED_CHAINS.has(String(SEPOLIA_CHAIN_ID))) {
    // 3) On-chain user-signed (one popup) — last resort.
    const txHash = await grantAgentPermissionOnChain(agentId, vault, maxAmount, expiresAt)
    return { txHash, status: 'onchain' }
  }
  return submitRelay({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, calldata, permissionContext })
}
```

Replace `relayDeposit` (currently `frontend/src/relay.js:189-202`):

```javascript
export async function relayDeposit({ agentId, user, vault, amount, permissionContext }) {
  const calldata = await encodeExecuteAgentDeposit(agentId, user, vault, amount)

  // 1) Session redemption — zero popup, redeemed from the user's smart account.
  if (hasSession()) {
    try {
      const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: calldata })
      return { txHash, status: 'redeemed' }
    } catch (e) {
      console.warn('[relay] deposit redeem failed, falling back:', e?.message)
    }
  }

  // 2) Base Sepolia: managed proxy (real, gas-abstracted), then on-chain.
  if (!ONESHOT_SUPPORTED_CHAINS.has(String(SEPOLIA_CHAIN_ID))) {
    const managed = await relayDepositManaged({ agentId, user, vault, amount })
    if (managed) return managed
    const txHash = await executeAgentDepositOnChain(agentId, user, vault, amount)
    return { txHash, status: 'onchain' }
  }

  // 3) Keyless 1Shot relay (mainnet only).
  return submitRelay({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, calldata, permissionContext })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/relay.test.js`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/relay.js frontend/src/relay.test.js
git commit -m "feat: route grant + deposit through session redemption first"
```

---

## Task 5: orchestrator.js — skip the EIP-5792 grant batch when a session is active

**Files:**
- Modify: `frontend/src/orchestrator.js:64-93` (the `isUnsupportedByOneShot()` batch block)

Today, on Base Sepolia, the orchestrator pre-batches grant calls via `batchCalls` (popup #2). When a session is active, all grants are redeemed per-worker inside `relayGrantPermission` with no popup, so the batch must be skipped entirely. Guard the whole batch block behind `!hasSession()`.

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/orchestrator.test.js  (create if absent)
import { describe, it, expect, beforeEach, vi } from 'vitest'

const batchCallsMock = vi.fn(async () => '0xBATCH')
const hasSessionMock = vi.fn()
vi.mock('./wallet.js', () => ({ batchCalls: (...a) => batchCallsMock(...a) }))
vi.mock('./strategy/session.js', () => ({ hasSession: () => hasSessionMock() }))
vi.mock('./relay.js', () => ({
  isUnsupportedByOneShot: () => true,
  useManagedRelay: () => true,
  buildGrantCall: vi.fn(async () => ({ to: '0x', data: '0x' })),
  buildDepositCall: vi.fn(async () => ({ to: '0x', data: '0x' })),
}))
vi.mock('./venice.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))
vi.mock('./worker.js', () => ({
  WorkerAgent: class { constructor(c){ this.c = c } async execute(){ return { success: true, txHash: '0xW' } } },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

import { OrchestratorAgent } from './orchestrator.js'

describe('orchestrator session-aware batching', () => {
  beforeEach(() => { batchCallsMock.mockClear(); hasSessionMock.mockReset() })

  const strategy = { vaults: [{ address: '0xV1', allocation: 0.5 }, { address: '0xV2', allocation: 0.5 }] }

  it('does NOT batch grants when a session is active', async () => {
    hasSessionMock.mockReturnValue(true)
    const orch = new OrchestratorAgent({ user: '0xU', permissionContext: '0xctx', sessionId: 's1', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(batchCallsMock).not.toHaveBeenCalled()
  })

  it('still batches grants when no session (legacy path)', async () => {
    hasSessionMock.mockReturnValue(false)
    const orch = new OrchestratorAgent({ user: '0xU', permissionContext: '0xctx', sessionId: 's2', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(batchCallsMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/orchestrator.test.js`
Expected: FAIL — `batchCalls` is called even when a session is active

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `orchestrator.js`:

```javascript
import { hasSession } from './strategy/session.js'
```

Wrap the existing batch block. Change the guard at `frontend/src/orchestrator.js:71` from:

```javascript
    if (isUnsupportedByOneShot()) {
```

to:

```javascript
    // When an ERC-7710 session is active, every grant + deposit is redeemed
    // per-worker with zero popup — so skip the EIP-5792 pre-batch entirely.
    if (isUnsupportedByOneShot() && !hasSession()) {
```

(Leave the block body unchanged — `batchedHash` / `grantsBatched` stay `null`/`false` when a session is active, so workers run their normal redeem path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/orchestrator.test.js`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/orchestrator.js frontend/src/orchestrator.test.js
git commit -m "feat: skip EIP-5792 grant batch when session redemption is active"
```

---

## Task 6: app.jsx — boot session on grant, persist, and rehydrate on re-entry

**Files:**
- Modify: `frontend/src/app.jsx:611-636` (`handlePermConfirm`)
- Modify: `frontend/src/app.jsx:133-208` (state region — add rehydrate effect)
- Modify: `frontend/src/app.jsx:868-905` (`handleAgain`, `handleRevoke`, `handleDisconnect` — clear session+store)

Wire the new layer into the wizard: on grant, persist + boot session; on mount with a valid stored grant, skip step 04; on reset/revoke/disconnect, tear down.

- [ ] **Step 1: Write the failing test (integration-style, pure handler extraction)**

Because `app.jsx` is a large React component (no existing test harness for it), test the **rehydration decision** as a pure helper rather than mounting the component. Create the helper and test it.

```javascript
// frontend/src/strategy/rehydrate.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hasValidGrantMock = vi.fn()
const loadGrantMock = vi.fn()
const initSessionMock = vi.fn()
vi.mock('./grantStore.js', () => ({ hasValidGrant: () => hasValidGrantMock(), loadGrant: () => loadGrantMock() }))
vi.mock('./session.js', () => ({ initSession: (...a) => initSessionMock(...a), hasSession: () => false }))

import { rehydrateSession } from './rehydrate.js'

describe('rehydrateSession', () => {
  beforeEach(() => { hasValidGrantMock.mockReset(); loadGrantMock.mockReset(); initSessionMock.mockReset() })

  it('boots the session and reports active when a valid grant exists', () => {
    hasValidGrantMock.mockReturnValue(true)
    loadGrantMock.mockReturnValue({ permissionContext: '0xctx', delegationManager: '0xdm', expiresAt: Date.now() + 1000 })
    const r = rehydrateSession()
    expect(initSessionMock).toHaveBeenCalledWith({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(r).toEqual({ active: true, expiresAt: expect.any(Number), permissionContext: '0xctx' })
  })

  it('returns inactive when no valid grant', () => {
    hasValidGrantMock.mockReturnValue(false)
    const r = rehydrateSession()
    expect(initSessionMock).not.toHaveBeenCalled()
    expect(r).toEqual({ active: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/rehydrate.test.js`
Expected: FAIL — `Cannot find module './rehydrate.js'`

- [ ] **Step 3: Write the helper**

```javascript
// frontend/src/strategy/rehydrate.js
// Pure glue: re-boot an ERC-7710 session from a persisted grant on page-load /
// wizard re-entry, so the user is never re-prompted within the validity window.
import { hasValidGrant, loadGrant } from './grantStore.js'
import { initSession } from './session.js'

/** @returns {{active: true, expiresAt: number, permissionContext: string} | {active: false}} */
export function rehydrateSession() {
  if (!hasValidGrant()) return { active: false }
  const g = loadGrant()
  initSession({ permissionContext: g.permissionContext, delegationManager: g.delegationManager })
  return { active: true, expiresAt: g.expiresAt, permissionContext: g.permissionContext }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/rehydrate.test.js`
Expected: PASS (2 passed)

- [ ] **Step 5: Wire into app.jsx — imports**

Add to the import block near the other strategy imports in `frontend/src/app.jsx` (after line 25 `import { generateStrategy }...`):

```javascript
import { saveGrant, clearGrant } from './strategy/grantStore.js';
import { initSession, clearSession } from './strategy/session.js';
import { rehydrateSession } from './strategy/rehydrate.js';
```

- [ ] **Step 6: Wire into app.jsx — boot + persist on grant**

In `handlePermConfirm` (`frontend/src/app.jsx:611`), after `const permResult = await requestERC7715Permission(86400);` and before `setPermContext(...)`, boot the session and persist:

```javascript
      const permResult = await requestERC7715Permission(86400);
      const expiresAtMs = Date.now() + 86400 * 1000;

      // Boot the ERC-7710 session + persist the single grant → all later actions
      // redeem with zero popup, and reload/re-entry within 24h skips this step.
      if (permResult.delegationManager) {
        initSession({
          permissionContext: permResult.permissionContext,
          delegationManager: permResult.delegationManager,
        });
        saveGrant({
          permissionContext: permResult.permissionContext,
          delegationManager: permResult.delegationManager,
          expiresAt: expiresAtMs,
        });
      }

      setPermContext(permResult.permissionContext);
      setPermActive(true);
      setPermExpiresAt(expiresAtMs);
```

(Remove the now-duplicated `const expiresAtMs = Date.now() + 86400 * 1000;` line that previously sat lower in the same handler.)

- [ ] **Step 7: Wire into app.jsx — rehydrate on mount**

Add a mount effect in the effects region (near `frontend/src/app.jsx:198`, beside the attestation effect). It re-boots the session and, if the user lands on `/strategy` step 04 with a live grant, marks permission active so the UI reflects "already granted":

```javascript
  // Rehydrate the single grant on mount: if a valid ERC-7715 grant is persisted,
  // re-boot the ERC-7710 session so the user is never re-prompted within 24h.
  useE(() => {
    const r = rehydrateSession();
    if (r.active) {
      setPermActive(true);
      setPermExpiresAt(r.expiresAt);
      setPermContext(r.permissionContext);
    }
  }, []);
```

- [ ] **Step 8: Wire into app.jsx — tear down on reset/revoke/disconnect**

In `handleAgain` (`frontend/src/app.jsx:868`), after `setPermContext(null);` add:

```javascript
    clearSession();
    clearGrant();
```

In `handleRevoke` (`frontend/src/app.jsx:895`), after `setPermActive(false);` add:

```javascript
    clearSession();
    clearGrant();
```

In `handleDisconnect` (`frontend/src/app.jsx:903`), after `setPermActive(false);` (within the same statement line) add on the next line:

```javascript
    clearSession();
    clearGrant();
```

- [ ] **Step 9: Run the full unit suite + a manual smoke check**

Run: `cd frontend && npx vitest run`
Expected: PASS — all existing tests + the 4 new files green.

Manual smoke (documented, not automated — needs Flask): `npx serve frontend/` → connect → grant once at step 04 → observe execute step completes with NO second MetaMask popup → reload page → re-enter `/strategy` → permission shows active, no re-prompt.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/app.jsx frontend/src/strategy/rehydrate.js frontend/src/strategy/rehydrate.test.js
git commit -m "feat: boot session on grant and rehydrate single permission on re-entry"
```

---

## Task 7: Update the step-04 copy to reflect single-signature truth

**Files:**
- Modify: `frontend/src/screens.jsx:339-420` (`PermissionCard`)

The card already says "batched in a single signature" — now make it literally accurate: one signature, then autonomous. Tighten the eyebrow + lede so the demo narrative matches behavior. No logic change.

- [ ] **Step 1: Update the eyebrow + lede copy**

In `PermissionCard`, change the eyebrow's second span and the `lede` paragraph:

```jsx
      <div className="eyebrow">
        <span className="num">04</span>
        <span>Scoped permission · ERC-7715 · sign once</span>
        <span className="rule" />
        <span>then fully autonomous · ERC-7710 redemption</span>
      </div>

      <h1 className="h-display">
        Sign once. Every agent runs without another popup.
      </h1>
      <p className="lede">
        This single signature grants a scoped, expiring permission. From here, the orchestrator and every worker
        execute Swap → Approve → Deposit by <b>redeeming</b> this grant — no further MetaMask prompts. Outside the
        granted scope, <span className="mono">AgentVaultDepositor.sol</span> still <b>reverts</b>.
      </p>
```

- [ ] **Step 2: Verify it renders (manual)**

Run: `npx serve frontend/` → walk to step 04 → confirm copy reads "Sign once…" and layout is intact.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens.jsx
git commit -m "docs: reframe permission step as sign-once autonomous redemption"
```

---

## Task 8: Refresh graphify + final verification

**Files:** none (tooling + verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — entire suite green.

- [ ] **Step 2: Update the knowledge graph**

Run: `graphify update .`
Expected: graph regenerated (AST-only, no API cost).

- [ ] **Step 3: Sanity-grep for leftover popup sources**

Run: `cd /c/SharredData/project/competition/vibing-farmer && grep -rn "batchCalls\|grantAgentPermissionOnChain\|executeAgentDepositOnChain" frontend/src/ | grep -v ".test.js"`
Expected: each remaining call is now behind a `hasSession()` guard or a documented fallback (orchestrator batch, relay fallbacks, background-agent harvest/withdraw which are out of /strategy scope).

- [ ] **Step 4: Final commit (if graph changed)**

```bash
git add graphify-out/
git commit -m "chore: refresh knowledge graph after session-redemption changes"
```

---

## Out of Scope (explicitly deferred)

- **Background agent** (`relay.js` `ensureBgSetup` / `relayWithdraw` / `relayHarvest`): these own a separate agentId namespace and fire only on the `done` dashboard, not in the `/strategy` wizard. They can adopt `redeemCall` later, but are NOT part of "one grant for the strategy flow." Leaving them unchanged keeps this plan's blast radius on the wizard.
- **Contract changes:** none. The deployed `AgentVaultDepositor` already enforces `msg.sender == user`, which ERC-7710 redemption satisfies.
- **Removing the managed `/api/relay` proxy:** kept as a fallback for resilience per the chosen execution model.

## Notes for the implementer

- This project runs the app via Babel CDN but `frontend/` has real `node_modules` + Vitest — run all tests with `cd frontend && npx vitest run`.
- SAK + viem ESM imports are already proven in `frontend/src/redelegation.js`; match its import style exactly.
- `permissionContext` may be the demo string `'0xmock'` if Flask returns no real context. In that case `delegationManager` is `null`, `initSession` is skipped, and the flow degrades to the existing managed/on-chain fallback — still functional, just not popup-free. This is the intended demo-safe degradation.
- Convert any relative dates in commits/notes to absolute (today: 2026-06-09).

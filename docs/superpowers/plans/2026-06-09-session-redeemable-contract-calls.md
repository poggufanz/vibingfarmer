# Session-Redeemable Contract Calls — Fix Autonomous Loop Popups

> **For agentic workers:** Inline execution (superpowers:executing-plans). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autonomous monitor loop (and deposit workers) execute on-chain with ZERO MetaMask popups after the user grants once, by switching from an ERC-7715 token-scoped permission to a Delegation-Framework **FunctionCall** delegation that the ephemeral session account can redeem.

**Architecture:** Replace `wallet_requestExecutionPermissions` (token-only scope) with a SAK `createDelegation({ scope: FunctionCall })` signed by the user's MetaMask smart account, scoped to `AgentVaultDepositor`'s `execute*` / `grant*` selectors. The session account redeems each call via `redeemDelegations` → DelegationManager → user's DeleGator. Under EIP-7702 the DeleGator runs at the user's EOA address, so the contract's `msg.sender == user` guard passes. **No contract redeploy.**

**Tech Stack:** `@metamask/smart-accounts-kit` 1.6.0, `viem` 2.21, `ethers` 6.13, Vite, Vitest, Base Sepolia (84532).

---

## Context

**Problem:** The NEVER-STOP monitor loop requests a MetaMask transaction every cycle even though the user already granted a permission. Console shows `[relay] deposit redeem failed, falling back: Execution reverted` then a second on-chain `CALL_EXCEPTION` (status 0).

**Root cause (research-corrected):**
1. The grant is `erc20-token-periodic` (a USDC-spend scope, wallet.js:135). The session redeems `executeAgentDeposit(...)` — a contract call, **not** a token transfer. The DelegationManager caveat enforcer rejects the mismatch → `redeemDelegations` reverts. ERC-7715 has **no `functionCall` permission type** — only token scopes (`getSupportedExecutionPermissions` confirms). `ScopeType.FunctionCall` exists only in the lower-level Delegation Framework `createDelegation()`.
2. When `hasSession()` is true, the on-chain `grantAgentPermission` is **skipped** (orchestrator.js:75, worker.js:43), so `agentPermissions[user][agentId].active == false`. Even a correctly-scoped redeem then hits `if (!perm.active) revert PermissionNotActive()` (AgentVaultDepositor.sol:130). The user-signed fallback reverts for the same reason.
3. The monitor's `execute` (app.jsx:450) routes harvest/rebalance to `relayHarvest`/`relayWithdraw` (relay.js:275-289), which **never check `hasSession()`** — they always do EIP-5792 user-signed batches → 2 popups per "keep" cycle by design.

**Corrected feasibility:** `msg.sender` during redemption = the user's DeleGator = the user's EOA under EIP-7702, so the existing contract guards already pass. The fix is client-side only: change the grant from a token permission to a FunctionCall delegation, stop skipping the on-chain grant (redeem it through the session), and route the monitor through the session too.

**Intended outcome:** User signs ONE delegation. Deposits, grants, capabilities, harvests, and withdraws all redeem through the session with no further popups. The loop runs autonomously.

---

## Key Unknown — De-risk First

Whether MetaMask Flask 13.9 + SAK 1.6.0 will (a) build a `toMetaMaskSmartAccount` for the connected EOA and (b) let it sign a `ScopeType.FunctionCall` delegation that the DelegationManager accepts where the leaf executes as the EOA. **Task 0 proves this on a single deposit before any wider wiring.** If Task 0 fails, stop and report — do not build Tasks 1-4 on an unproven primitive.

---

## File Structure

- `src/strategy/userAccount.js` — **new.** Builds + caches the user's `toMetaMaskSmartAccount` (EIP-7702 Hybrid) from the connected MetaMask signer. One responsibility: expose the signer object SAK needs to `signDelegation`.
- `src/strategy/functionCallGrant.js` — **new.** Builds + signs the FunctionCall delegation scoped to `AgentVaultDepositor` selectors. Returns `{ delegation, delegationManager }`.
- `src/strategy/session.js` — **modify.** `redeemCall` already routes to `sendTransactionWithDelegation`; confirm it carries the FunctionCall delegation as `permissionContext`. Add `redeemBatch` for grant+capabilities+deposit in one redemption if SAK supports batch mode.
- `src/wallet.js` — **modify.** `requestERC7715Permission` → delegate to `functionCallGrant.js`; keep the same return shape (`{ permissionContext, delegationManager, grantedPermissions }`) so `app.jsx` and `grantStore.js` are untouched.
- `src/relay.js` — **modify.** `relayHarvest` / `relayWithdraw` check `hasSession()` and redeem `executeHarvest` / `executeWithdraw` (plus a one-time grant+`setAgentCapabilities` redemption) instead of user-signed batches.
- `src/orchestrator.js` + `src/worker.js` — **modify.** When `hasSession()`, redeem `grantAgentPermission` (zero popup) instead of skipping it, so `perm.active` is set before deposit.
- Test files alongside each (`*.test.js`) — Vitest, following the existing mock pattern in `session.test.js`.

---

## Task 0: Spike — prove session redeems one FunctionCall deposit

**Files:**
- Create: `src/strategy/userAccount.js`
- Create: `src/strategy/functionCallGrant.js`
- Manual browser verification (no automated test — this is a spike)

- [ ] **Step 1: Build the user smart account module**

```js
// src/strategy/userAccount.js
// Wraps the connected MetaMask EOA as a SAK smart account so it can sign a
// Delegation-Framework delegation. EIP-7702 Hybrid: the delegate code runs AT
// the EOA address, so redeemed calls have msg.sender == user (the contract guard
// in AgentVaultDepositor passes with no redeploy).
import { toMetaMaskSmartAccount, Implementation } from '@metamask/smart-accounts-kit'
import { createPublicClient, custom, http } from 'viem'
import { baseSepolia as chain } from 'viem/chains'
import { getAccount } from '../wallet.js'

let userSmartAccount = null

export async function getUserSmartAccount() {
  if (userSmartAccount) return userSmartAccount
  const address = getAccount()
  if (!address) throw new Error('getUserSmartAccount: wallet not connected')
  if (!window?.ethereum) throw new Error('getUserSmartAccount: no provider')

  const publicClient = createPublicClient({
    chain,
    transport: http(import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org'),
  })

  // EIP-7702: the connected EOA IS the account. Signer is the injected provider.
  userSmartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    address,                                  // 7702 — account lives at the EOA address
    signer: { walletClient: window.ethereum },
  })
  return userSmartAccount
}

export function clearUserSmartAccount() { userSmartAccount = null }
```

- [ ] **Step 2: Build the FunctionCall grant module**

```js
// src/strategy/functionCallGrant.js
// One delegation, user-signed, authorizing the session account to call the
// AgentVaultDepositor execute*/grant* selectors. Replaces the ERC-7715 token grant.
import { createDelegation, ScopeType } from '@metamask/smart-accounts-kit'
import { AGENT_VAULT_DEPOSITOR_ADDRESS } from '../config.js'
import { getUserSmartAccount } from './userAccount.js'

const SELECTORS = [
  'grantAgentPermission(bytes32,address,uint256,uint256)',
  'setAgentCapabilities(bytes32,bool,bool)',
  'executeAgentDeposit(bytes32,address,address,uint256)',
  'executeWithdraw(bytes32,address,address,uint256)',
  'executeHarvest(bytes32,address,address,bool)',
]

/**
 * @param {string} sessionAddress - the ephemeral session account (delegate)
 * @returns {Promise<{ delegation: object, delegationManager: string }>}
 */
export async function buildFunctionCallGrant(sessionAddress) {
  const user = await getUserSmartAccount()
  const delegation = createDelegation({
    scope: {
      type: ScopeType.FunctionCall,
      targets: [AGENT_VAULT_DEPOSITOR_ADDRESS],
      selectors: SELECTORS,
    },
    from: user.address,
    to: sessionAddress,
    environment: user.environment,
  })
  const signature = await user.signDelegation({ delegation })
  return {
    delegation: { ...delegation, signature },
    delegationManager: user.environment.DelegationManager,
  }
}
```

- [ ] **Step 3: Temporary spike harness in browser console**

Add a `window.__spike` hook temporarily at the end of `app.jsx`'s permission handler (remove after spike): after `connectWallet()` + `prepareSessionAccount()`, call `buildFunctionCallGrant(sessionAddress)`, `initSession({ permissionContext: delegation, delegationManager })`, then `redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: <encodeGrantAgentPermission(...)> })` and `redeemCall(<encodeExecuteAgentDeposit(...)>)`.

- [ ] **Step 4: Run dev server and execute the spike**

Run: `cd frontend && npx vite` (or existing dev script). Connect Flask, trigger the spike.
Expected: ONE signature prompt (signDelegation), then `grantAgentPermission` and `executeAgentDeposit` both land on-chain (status 1) with NO further MetaMask popups. Verify on https://sepolia.basescan.org.

- [ ] **Step 5: Decision gate**

If both redemptions succeed on-chain → continue to Task 1. If `signDelegation` is rejected by Flask, or `redeemDelegations` reverts → STOP, capture the exact error, and report. Do not proceed. (Fallback option, if needed: the pragmatic 1-popup EIP-5792 batch — out of scope unless the spike fails.)

- [ ] **Step 6: Commit the spike modules (no harness)**

Remove the temporary `window.__spike` hook. Commit `userAccount.js` + `functionCallGrant.js`.

```bash
rtk git add frontend/src/strategy/userAccount.js frontend/src/strategy/functionCallGrant.js
rtk git commit -m "feat: add user smart account + FunctionCall delegation grant"
```

---

## Task 1: Wire the FunctionCall grant into requestERC7715Permission

**Files:**
- Modify: `src/wallet.js:110-151` (`requestERC7715Permission`)
- Test: `src/wallet.grant.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
// src/wallet.grant.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const buildGrantMock = vi.fn(async () => ({ delegation: { d: 1, signature: '0xsig' }, delegationManager: '0xDM' }))
vi.mock('./strategy/functionCallGrant.js', () => ({ buildFunctionCallGrant: buildGrantMock }))
vi.mock('./strategy/session.js', () => ({ prepareSessionAccount: () => '0xSESSION', saveSessionGrant: vi.fn() }))
vi.mock('./flaskDetect.js', () => ({ requireFlask: vi.fn() }))
vi.mock('./readProvider.js', () => ({ getReadProvider: vi.fn() }))

import { requestERC7715Permission } from './wallet.js'

describe('requestERC7715Permission → FunctionCall grant', () => {
  beforeEach(() => { buildGrantMock.mockClear(); vi.stubGlobal('window', { ethereum: {} }) })

  it('returns permissionContext=delegation and delegationManager from the signed grant', async () => {
    // connectWallet sets module-level `account`; emulate via the exported setter path.
    const res = await requestERC7715Permission(86400)
    expect(buildGrantMock).toHaveBeenCalledWith('0xSESSION')
    expect(res.permissionContext).toEqual({ d: 1, signature: '0xsig' })
    expect(res.delegationManager).toBe('0xDM')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd frontend && npx vitest run src/wallet.grant.test.js`
Expected: FAIL (still calls `wallet_requestExecutionPermissions`).

- [ ] **Step 3: Replace the grant body**

In `src/wallet.js`, replace the `window.ethereum.request({ method: 'wallet_requestExecutionPermissions', ... })` block inside `requestERC7715Permission` with:

```js
  const sessionAddress = prepareSessionAccount()
  const { buildFunctionCallGrant } = await import('./strategy/functionCallGrant.js')
  const { delegation, delegationManager } = await buildFunctionCallGrant(sessionAddress)
  const grantData = {
    permissionContext: delegation,        // the signed Delegation object (redeem context)
    delegationManager,
    grantedPermissions: [{ chainId: SEPOLIA_CHAIN_ID_HEX, context: delegation }],
  }
  saveSessionGrant(grantData)
  return grantData
```

Keep the `requireFlask()` gate above it unchanged. Remove the now-unused `parseGrantResult` call inside this function (leave the export — other callers may use it).

- [ ] **Step 4: Run it, expect PASS**

Run: `cd frontend && npx vitest run src/wallet.grant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add frontend/src/wallet.js frontend/src/wallet.grant.test.js
rtk git commit -m "feat: issue FunctionCall delegation from grant request"
```

---

## Task 2: Stop skipping the on-chain grant — redeem it through the session

**Files:**
- Modify: `src/worker.js:42-55` (grant step)
- Modify: `src/orchestrator.js:73-93` (batch skip logic)
- Test: `src/worker.test.js` (extend if exists, else create)

- [ ] **Step 1: Write the failing test**

```js
// src/worker.session.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const relayGrant = vi.fn(async () => ({ txHash: '0xg', status: 'redeemed' }))
const relayDeposit = vi.fn(async () => ({ txHash: '0xd', status: 'redeemed' }))
vi.mock('./relay.js', () => ({ relayGrantPermission: relayGrant, relayDeposit }))
vi.mock('./memory.js', () => ({ writeMemory: vi.fn(), createEntry: () => ({}), buildLesson: () => '' }))
vi.mock('./skills.js', () => ({ loadSkill: vi.fn() }))
vi.mock('./strategy/session.js', () => ({ hasSession: () => true }))

import { WorkerAgent } from './worker.js'

describe('WorkerAgent with active session', () => {
  it('still grants permission (redeemed) before depositing — perm.active must be set', async () => {
    const w = new WorkerAgent({ agentId: '0xA', user: '0xU', vault: '0xV', amount: 1n, sessionId: 's', onEvent: vi.fn() })
    const res = await w.execute()
    expect(relayGrant).toHaveBeenCalled()   // NOT skipped under session
    expect(res.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd frontend && npx vitest run src/worker.session.test.js`
Expected: FAIL — current `if (!this.batchedHash && !this.grantsBatched && !hasSession())` skips the grant when `hasSession()`.

- [ ] **Step 3: Fix worker.js grant gate**

In `src/worker.js:43`, change the condition so a session still grants (it just redeems with no popup):

```js
      // Step 1: Grant on-chain permission. Under a session this is REDEEMED (zero
      // popup) but MUST still run — executeAgentDeposit reverts if perm.active==false.
      if (!this.batchedHash && !this.grantsBatched) {
```

(Drop `&& !hasSession()`.) `relayGrantPermission` already redeems via the session when `hasSession()` is true (relay.js:174).

- [ ] **Step 4: Fix orchestrator.js batch skip**

In `src/orchestrator.js:75`, the batch is correctly skipped under a session (per-worker redemption handles it). Leave the batch skip, but verify the worker grant now covers it. No change needed if Step 3 makes workers grant per-agent. Add a comment at line 73 noting grants are redeemed per-worker under session.

- [ ] **Step 5: Run it, expect PASS**

Run: `cd frontend && npx vitest run src/worker.session.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add frontend/src/worker.js frontend/src/orchestrator.js frontend/src/worker.session.test.js
rtk git commit -m "fix: redeem on-chain grant under session so perm.active is set"
```

---

## Task 3: Route monitor harvest/rebalance through the session

**Files:**
- Modify: `src/relay.js:275-289` (`relayWithdraw`, `relayHarvest`)
- Test: `src/relay.session.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
// src/relay.session.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redeem = vi.fn(async () => '0xredeemed')
vi.mock('./strategy/session.js', () => ({ hasSession: () => true, redeemCall: redeem }))
vi.mock('./wallet.js', () => ({
  batchCalls: vi.fn(), executeWithdrawOnChain: vi.fn(), executeHarvestOnChain: vi.fn(),
  grantAgentPermissionOnChain: vi.fn(), executeAgentDepositOnChain: vi.fn(),
}))

import { relayWithdraw, relayHarvest } from './relay.js'

describe('monitor relay under session', () => {
  beforeEach(() => redeem.mockClear())

  it('relayWithdraw redeems executeWithdraw with NO user-signed batch', async () => {
    const r = await relayWithdraw({ user: '0xU', vault: '0xV', amount: '100' })
    expect(redeem).toHaveBeenCalled()
    expect(r.status).toBe('redeemed')
  })

  it('relayHarvest redeems executeHarvest', async () => {
    const r = await relayHarvest({ user: '0xU', vault: '0xV', recompound: false })
    expect(redeem).toHaveBeenCalled()
    expect(r.status).toBe('redeemed')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd frontend && npx vitest run src/relay.session.test.js`
Expected: FAIL — current functions call `ensureBgSetup` + `executeWithdrawOnChain` (user-signed), never `redeemCall`.

- [ ] **Step 3: Add session path to relayWithdraw / relayHarvest**

In `src/relay.js`, import `redeemCall` (already imports `hasSession`). Prepend a session branch to each. The bg agent's grant + `setAgentCapabilities(allowWithdraw,allowHarvest)` must be redeemed once before the action (contract requires `perm.allowWithdraw`/`allowHarvest`):

```js
export async function relayWithdraw({ user, vault, amount }) {
  const agentId = bgAgentId(vault)
  if (hasSession()) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('grantAgentPermission', [agentId, vault, BG_MAX, expiresAt]) })
    await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('setAgentCapabilities', [agentId, true, true]) })
    const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('executeWithdraw', [agentId, user, vault, BigInt(amount)]) })
    return { txHash, status: 'redeemed' }
  }
  await ensureBgSetup(agentId, vault)
  const txHash = await executeWithdrawOnChain(agentId, user, vault, BigInt(amount))
  return { txHash, status: 'onchain' }
}

export async function relayHarvest({ user, vault, recompound = false }) {
  const agentId = bgAgentId(vault)
  if (hasSession()) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600)
    await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('grantAgentPermission', [agentId, vault, BG_MAX, expiresAt]) })
    await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('setAgentCapabilities', [agentId, true, true]) })
    const txHash = await redeemCall({ to: AGENT_VAULT_DEPOSITOR_ADDRESS, data: BG_IFACE.encodeFunctionData('executeHarvest', [agentId, user, vault, recompound]) })
    return { txHash, status: 'redeemed' }
  }
  await ensureBgSetup(agentId, vault)
  const txHash = await executeHarvestOnChain(agentId, user, vault, recompound)
  return { txHash, status: 'onchain' }
}
```

Note: the `redeemCall` import must be added to the existing `import { redeemCall, hasSession } from './strategy/session.js'` (already present at relay.js:4 — confirm `redeemCall` is in it).

- [ ] **Step 4: Run it, expect PASS**

Run: `cd frontend && npx vitest run src/relay.session.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add frontend/src/relay.js frontend/src/relay.session.test.js
rtk git commit -m "fix: redeem monitor harvest/withdraw through session (no popups)"
```

---

## Task 4: Full regression + end-to-end browser verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `cd frontend && npx vitest run`
Expected: PASS. Pay attention to `session.test.js`, `rehydrate.test.js`, `monitorLoop.test.js` — they assert the injected-deps + redeem contract; do not break them.

- [ ] **Step 2: Manual end-to-end**

Run dev server, connect Flask, run a full strategy:
1. One signature at grant (signDelegation). No popup after.
2. Deposits land (BaseScan status 1).
3. Let the monitor loop tick (set a short `apyInterval`). On a "keep" verdict, harvest/rebalance executes with NO popup.

Expected: console shows `status: 'redeemed'`, zero `[relay] … redeem failed, falling back`, zero `CALL_EXCEPTION`.

- [ ] **Step 3: Update graphify graph**

Run: `graphify update .`

---

## Task 5: Persist findings + workflow preference to memory + CLAUDE.md

**Files:**
- Create: `C:\Users\mfaiq\.claude\projects\C--SharredData-project-competition-vibing-farmer\memory\session-functioncall-redemption.md`
- Create: `C:\Users\mfaiq\.claude\projects\C--SharredData-project-competition-vibing-farmer\memory\feedback-inline-execution-default.md`
- Modify: `C:\Users\mfaiq\.claude\projects\C--SharredData-project-competition-vibing-farmer\memory\MEMORY.md` (add index lines)
- Modify: `C:\SharredData\project\competition\vibing-farmer\CLAUDE.md` (Key Implementation Notes + a workflow note)

- [ ] **Step 1: Write the memory file**

Frontmatter `type: project`. Record: ERC-7715 supports token scopes only (no functionCall); contract calls require a Delegation-Framework `ScopeType.FunctionCall` delegation signed by the user smart account; under EIP-7702 redemption `msg.sender == user` so AgentVaultDepositor needs NO redeploy; the on-chain grant must still run (redeemed) or `perm.active==false` reverts; monitor harvest/withdraw must check `hasSession()` and redeem `executeHarvest`/`executeWithdraw` (with grant+`setAgentCapabilities` first). Link `[[eip7702-erc7715-findings]]`.

- [ ] **Step 2: Write the inline-execution preference memory**

Frontmatter `type: feedback`. Body: for this project, default to **inline execution — never dispatch subagents** (the configured model is unavailable to subagents, so Agent/Task calls fail). Follow with `**Why:**` (subagent model errors out) and `**How to apply:**` (do exploration + plan execution inline in the main session; use Explore/Plan/Agent tools only if the user explicitly asks).

- [ ] **Step 3: Add MEMORY.md index lines**

```
- [Session FunctionCall redemption](session-functioncall-redemption.md) — ERC-7715 is token-scope-only; contract calls need FunctionCall delegation; no redeploy (7702 → msg.sender==user); grant must still redeem or perm.active reverts
- [Inline execution default](feedback-inline-execution-default.md) — default to inline; never dispatch subagents (subagent model unavailable, Agent/Task calls fail)
```

- [ ] **Step 4: Update CLAUDE.md**

Add a bullet under Key Implementation Notes: zero-popup autonomy uses a SAK FunctionCall delegation (not ERC-7715 token scope) redeemed by the ephemeral session account; the on-chain `grantAgentPermission` is redeemed, never skipped. Add a short **Workflow** note: execute inline by default — do not dispatch subagents (subagent model unavailable in this environment).

- [ ] **Step 5: Commit**

```bash
rtk git add CLAUDE.md
rtk git commit -m "docs: note FunctionCall delegation redemption + inline-execution workflow"
```

(Memory files live outside the repo — no commit needed.)

---

## Verification Summary

- **Unit:** `cd frontend && npx vitest run` — all green, including the 3 new test files and the untouched `session.test.js` / `monitorLoop.test.js`.
- **Spike gate (Task 0):** single deposit redeems on-chain with one signature — proves the primitive before wider work.
- **End-to-end:** full strategy + monitor loop on Base Sepolia, zero popups after the grant, no `redeem failed` / `CALL_EXCEPTION` in console, BaseScan confirms status-1 txs.
- **Rollback:** each task is an isolated commit; revert any single task without affecting the others. If Task 0 fails, none of Tasks 1-5 are started.

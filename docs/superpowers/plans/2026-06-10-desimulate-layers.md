# De-Simulate All Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every "simulated" / fake-latency artifact from the Vibing Farmer execution path so the demo reflects real on-chain behavior, and harden AI output validation + on-chain reconciliation.

**Architecture:** The deposit path is `WorkerAgent.execute()` → `relayDeposit()` → (Base Sepolia 84532) managed-API proxy or user-signed fallback → `AgentVaultDepositor.executeAgentDeposit()` → `MockVault.deposit()`. `executeAgentDeposit` is the single real tx; it atomically emits `SwapExecuted`, `ApproveExecuted`, `DepositExecuted`. There is **no real ERC20 `transferFrom`** anywhere — `MockVault` is pure-accounting. The fake parts live only in `worker.js` (sleep-mock swap/approve steps) and the UI's silent fallbacks.

**Tech Stack:** Vite + React 18 (`frontend/src`, ESM, `.jsx`), ethers.js v6, Vitest (frontend tests), Foundry/forge (contracts, WSL only).

---

## ⚠️ Corrections to the original feedback (read before starting)

The feedback was written against an assumed architecture. Verified against the actual code, three items change:

1. **Layer 2 (Approve) premise is FALSE here.** `AgentVaultDepositor.executeAgentDeposit` (`contracts/AgentVaultDepositor.sol:146-181`) does **not** call `IERC20(USDC).transferFrom`. It emits `SwapExecuted` + `ApproveExecuted` then calls `IVault(vault).deposit(amount, user)`, and `MockVault.deposit` (`contracts/MockVault.sol:44-55`) moves no tokens. So a real on-chain USDC `approve` is **not required** and adding a batch `USDC.approve` (feedback "Jalan 2") would be a **no-op**. We do **NOT** implement EIP-2612 permit or batch-approve. Instead we make the `approve` UI step honest: it is resolved from the **real deposit tx hash** (the `ApproveExecuted` event is emitted atomically inside that tx).

2. **Layer 3 (MockVault yield) is ALREADY IMPLEMENTED.** `contracts/MockVault.sol` already has `apyBps`, `depositTimestamp`, time-based `getUnclaimedRewards` (lines 11, 16, 59-65). Do **NOT** re-implement it, and do **NOT** adopt the feedback's `convertToAssets(shares)` change — current `convertToAssets` is `pure` returns `shares` (1:1) and is called context-free by `reconcilePositionsFromChain` (`positionsStore.js:68`). Making it depend on `msg.sender` would break that read. Layer 3 is **verify-only** (Task 5).

3. **1Shot relay (Layer 4 infra) is already correct.** `relay.js:53` excludes Base Sepolia (84532) from `ONESHOT_SUPPORTED_CHAINS`; 84532 uses the managed-API proxy (`relayDepositManaged`). The method name is already `relayer_send7710Transaction` (`relay.js:126`), not the deprecated `relay_executePermission`. No code change needed — only the **visibility** fix in Layer 4 (Task 2).

**Net scope:** Task 1 (Venice validation), Task 2 (gas-method visibility), Task 3 (de-simulate swap+approve in worker), **Task 3B (eliminate every remaining fake tx-hash + `[simulated]` artifact)**, Task 4 (reconcile retry), Task 5 (verify MockVault yield), Task 6 (OPTIONAL/deferred — split `app.jsx`). Ordering below = highest demo-visible value first.

### Full-codebase simulation sweep (graphify + grep, 2026-06-10)

Every remaining artifact, triaged. "Fix" items are all covered by a task below; "keep" items are legitimate and intentionally untouched.

| Location | What | Verdict |
|----------|------|---------|
| `worker.js:58,64,108` | `sleep(300/200)` fake swap/approve latency + helper | **FIX → Task 3** |
| `worker.js:89` | `simulated: depositResult.status === 'simulated'` | **FIX → Task 3B** (status can no longer be `simulated`) |
| `relay.js:110-117` | `submitRelay` returns fake `'0xsim_'+Date.now()` hash, `status:'simulated'` | **FIX → Task 3B** (throw instead) |
| `app.jsx:893,909,918` | `"[simulated]"` / `"[simulated relay]"` log labels | **FIX → Task 3B** |
| `app.jsx:1103-1115` | step-rail "done" nav fabricates `fakeHash()` + confirmed steps, overwriting real exec data | **FIX → Task 3 Step 4** |
| `screens.jsx:9,551` + `app.jsx:11` | `fakeHash()` helper def/export/import (only consumer is the block above) | **FIX → Task 3 Step 4** (remove once unused) |
| `skills.js:30` + `venice.js:220,249` | skill `swap` schema `dexPreference:'mock'` | **FIX → Task 3 Step 6** (add `required:false` to both copies) |
| `config.js:3-6`, `defiLlama.js`, `ExplorerPage.jsx` | `MOCK_VAULT_*` deployed addresses + protocol→vault mapping | **KEEP** — real contracts deployed on Base Sepolia (ADR-approved demo vault) |
| `ExplorerPage.jsx:33` | hardcoded coverage numbers "verifiable via `forge test`" | **KEEP** — static display of real test output, not execution |
| `EcosystemPage.jsx:94` | hardcoded SVG diagram via `dangerouslySetInnerHTML` | **KEEP** — static asset, no user input |
| `agents.jsx:117,193` | d3 force-graph `d3ReheatSimulation` / "physics simulation" | **KEEP** — graph layout physics, not blockchain |
| `agents.jsx:596`, `monitorLoop.js`, `app.jsx:471` | MDP `simulate` phase = `scoreReward(...)` | **KEEP** — real reward math (FinRL framing), legitimately named |
| all `*.test.js` `vi.mock(...)` | test doubles | **KEEP** — test infrastructure |
| `setTimeout(...)` in `apyHistory/defiLlama/marketSearch/venice/motion/SettingsPage/WithdrawModal/TxDetailPage/RightRail/ExplorerPage/agents:534` | AbortController timeouts + copy-confirm + onClose delays | **KEEP** — real async control, not faked work |
| `wallet.js:244` | `setTimeout(2000)` | **KEEP** — poll interval for real `wallet_getCallsStatus` confirmation |
| `*:placeholder=` attrs | input placeholders | **KEEP** — UI affordance |

After all tasks, **zero** code path can produce a fabricated tx hash or a `simulated` status. The only residual "sim" strings are graph-physics and MDP-phase names (legitimate).

---

## File map

| File | Responsibility | Tasks |
|------|----------------|-------|
| `frontend/src/venice.js` | Stricter `validateVeniceResponse` | 1 |
| `frontend/src/venice.test.js` (new) | Tests for validation | 1 |
| `frontend/src/worker.js` | Remove sleeps; emit `gasMethod`; `skipped` swap; tx-backed approve | 2, 3 |
| `frontend/src/worker.test.js` (new) | Tests for worker step emission | 2, 3 |
| `frontend/src/app.jsx` | Render gas-method warning; handle `skipped`; reconcile retry | 2, 3, 4 |
| `frontend/src/agents.jsx` | `skipped` step palette + label | 3 |
| `frontend/src/skills.js` + `frontend/src/venice.js` | Skill schema: swap `required` flag (both copies) | 3 |
| `frontend/src/screens.jsx` | Remove `fakeHash()` helper + export | 3 |
| `frontend/src/relay.js` | `submitRelay` throws instead of fake `0xsim` hash | 3B |
| `contracts/MockVault.sol` | Verify-only (no edit) | 5 |
| `frontend/src/hooks/*` (new, OPTIONAL) | Extracted state hooks | 6 |

---

## Task 1: Harden Venice AI output validation

**Why first:** Isolated, pure function, no UI coupling. An AI returning `expected_apy: 0` currently passes validation and renders "0% APY" — looks broken. Lowest risk, immediate reliability win.

**Files:**
- Modify: `frontend/src/venice.js:286-313` (`validateVeniceResponse`)
- Test: `frontend/src/venice.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/venice.test.js`:

```js
import { describe, it, expect } from 'vitest'
// validateVeniceResponse is currently not exported — Step 3 exports it.
import { validateVeniceResponse } from './venice.js'

const VAULTS = [
  { address: '0xAAAa000000000000000000000000000000000001', name: 'A' },
  { address: '0xBBBb000000000000000000000000000000000002', name: 'B' },
]

const validVault = (over = {}) => ({
  address: VAULTS[0].address,
  reasoning: 'Solid overcollateralized lending with deep liquidity and low drawdown.',
  expected_apy: 4.8,
  allocation: 1.0,
  risk_tier: 'low',
  ...over,
})

describe('validateVeniceResponse', () => {
  it('accepts a well-formed single-vault response', () => {
    const res = { selected_vaults: [validVault()] }
    expect(() => validateVeniceResponse(res, VAULTS)).not.toThrow()
  })

  it('rejects expected_apy of 0', () => {
    const res = { selected_vaults: [validVault({ expected_apy: 0 })] }
    expect(() => validateVeniceResponse(res, VAULTS)).toThrow(/expected_apy/)
  })

  it('rejects expected_apy as a string "N/A"', () => {
    const res = { selected_vaults: [validVault({ expected_apy: 'N/A' })] }
    expect(() => validateVeniceResponse(res, VAULTS)).toThrow(/expected_apy/)
  })

  it('rejects allocation > 1', () => {
    const res = { selected_vaults: [validVault({ allocation: 1.5 })] }
    expect(() => validateVeniceResponse(res, VAULTS)).toThrow(/allocation/)
  })

  it('rejects a missing/invalid risk_tier', () => {
    const res = { selected_vaults: [validVault({ risk_tier: undefined })] }
    expect(() => validateVeniceResponse(res, VAULTS)).toThrow(/risk_tier/)
  })

  it('still rejects a hallucinated address', () => {
    const res = { selected_vaults: [validVault({ address: '0xdead' })] }
    expect(() => validateVeniceResponse(res, VAULTS)).toThrow(/hallucinated/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/venice.test.js`
Expected: FAIL — `validateVeniceResponse is not a function` (not exported yet) and missing-field assertions not enforced.

- [ ] **Step 3: Export the function and add the stricter checks**

In `frontend/src/venice.js`, change the declaration at line 286 from:

```js
function validateVeniceResponse(response, vaultData = VAULT_CATALOG) {
```

to:

```js
export function validateVeniceResponse(response, vaultData = VAULT_CATALOG) {
```

Then, inside the existing `response.selected_vaults.forEach((v, i) => { ... })` loop (lines 293-300), add the new field checks **after** the existing address + reasoning checks. Define the risk-tier set just above the function. Final form of that region:

```js
const VALID_RISK_TIERS = new Set(['low', 'medium', 'high'])

export function validateVeniceResponse(response, vaultData = VAULT_CATALOG) {
  const allowedAddresses = new Set(vaultData.map(v => v.address.toLowerCase()))

  if (!response.selected_vaults || !Array.isArray(response.selected_vaults)) {
    throw new Error('Missing selected_vaults array')
  }

  response.selected_vaults.forEach((v, i) => {
    if (!allowedAddresses.has(v.address?.toLowerCase())) {
      throw new Error(`Vault ${i}: hallucinated address ${v.address}`)
    }
    if (!v.reasoning || v.reasoning.length < 20) {
      throw new Error(`Vault ${i}: reasoning missing or too short`)
    }
    if (typeof v.expected_apy !== 'number' || v.expected_apy <= 0 || v.expected_apy > 100) {
      throw new Error(`Vault ${i}: invalid expected_apy: ${v.expected_apy}`)
    }
    if (typeof v.allocation !== 'number' || v.allocation <= 0 || v.allocation > 1) {
      throw new Error(`Vault ${i}: invalid allocation: ${v.allocation}`)
    }
    if (!VALID_RISK_TIERS.has(v.risk_tier)) {
      throw new Error(`Vault ${i}: invalid risk_tier: ${v.risk_tier}`)
    }
  })

  const total = response.selected_vaults.reduce((s, v) => s + v.allocation, 0)
  if (Math.abs(total - 1.0) > 0.01) {
    throw new Error(`Allocation sum ${total.toFixed(2)} !== 1.0`)
  }

  // Cap to catalog size
  if (response.selected_vaults.length > vaultData.length) {
    response.selected_vaults = response.selected_vaults.slice(0, vaultData.length)
  }

  return response
}
```

> Note: `yield_source` is intentionally **not** validated — the code's actual field is the optional `v.yield_source_type` (used only in `saveReasoning`, `venice.js:192`); enforcing it would cause false rejections. Do not add it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/venice.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Sanity-check the failure path doesn't break the app**

`generateStrategy` already wraps `validateVeniceResponse` in try/catch (`venice.js:146` inside the `try` at 136, catch at 196 → `buildFallbackForParams`). A stricter throw simply routes a malformed AI response to the hardcoded fallback. No further change needed — confirm by reading `venice.js:196-201`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/venice.js frontend/src/venice.test.js
git commit -m "feat: stricter Venice response validation (apy/allocation/risk_tier)"
```

---

## Task 2: Surface the real gas-payment method (relayer vs user-signed)

**Why:** On Base Sepolia, if the managed proxy is unconfigured, `relayDeposit` silently falls back to a **user-signed** tx (`relay.js:209-213`). The demo then looks like gas abstraction worked when it didn't. Judges checking Etherscan see `from = user`, not the relayer. Make the method explicit in the event + UI.

**Files:**
- Modify: `frontend/src/worker.js:68-90` (deposit step + completed emit)
- Modify: `frontend/src/app.jsx:868-925` (step/completed handlers — store + render `gasMethod`)
- Test: `frontend/src/worker.test.js` (create)

Relevant `relayDeposit` statuses (`relay.js`): `relayed` / `submitted` → relayer paid; `onchain` → user-signed fallback; `simulated` → mock (mainnet-only branch, should not occur on 84532). The full-batch path returns `{ status: 'onchain' }` (`worker.js:71`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/worker.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

// Mock collaborators so execute() runs without a chain or relay.
vi.mock('./relay.js', () => ({
  relayGrantPermission: vi.fn(async () => ({ txHash: '0xgrant' })),
  relayDeposit: vi.fn(async () => ({ txHash: '0xdep', status: 'onchain' })),
}))
vi.mock('./memory.js', () => ({
  writeMemory: vi.fn(),
  createEntry: (step, status, data, lesson) => ({ step, status, ...data, lesson }),
  buildLesson: () => 'lesson',
}))
vi.mock('./skills.js', () => ({ loadSkill: vi.fn() }))

import { WorkerAgent } from './worker.js'

function runWorker(depositStatus) {
  return new Promise((resolve) => {
    const events = []
    import('./relay.js').then(({ relayDeposit }) => {
      relayDeposit.mockResolvedValueOnce({ txHash: '0xdep', status: depositStatus })
    })
    const w = new WorkerAgent({
      agentId: '0x' + '11'.repeat(32),
      user: '0xuser', vault: '0xvault', amount: 1000000n,
      permissionContext: '0xctx', sessionId: 's1', grantsBatched: true,
      onEvent: (name, data) => {
        events.push({ name, data })
        if (name === 'completed' || name === 'failed') resolve(events)
      },
    })
    w.execute()
  })
}

describe('WorkerAgent gasMethod', () => {
  it('emits gasMethod "user-signed" when deposit status is onchain', async () => {
    const events = await runWorker('onchain')
    const deposit = events.find((e) => e.name === 'step' && e.data.step === 'deposit' && e.data.status === 'done')
    expect(deposit.data.gasMethod).toBe('user-signed')
  })

  it('emits gasMethod "relayer" when deposit status is relayed', async () => {
    const events = await runWorker('relayed')
    const deposit = events.find((e) => e.name === 'step' && e.data.step === 'deposit' && e.data.status === 'done')
    expect(deposit.data.gasMethod).toBe('relayer')
  })

  it('marks swap as skipped (no fake latency)', async () => {
    const events = await runWorker('relayed')
    const swap = events.find((e) => e.name === 'step' && e.data.step === 'swap' && e.data.status !== 'pending')
    expect(swap.data.status).toBe('skipped')
  })
})
```

> The `swap skipped` assertion belongs to Task 3 but is included here so the test file is written once; it will fail until Task 3 lands, which is expected.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/worker.test.js`
Expected: FAIL — `deposit.data.gasMethod` is `undefined`.

- [ ] **Step 3: Compute and emit `gasMethod` + `relayer` in worker.js**

In `frontend/src/worker.js`, replace the deposit block (lines 68-90) with:

```js
      // Step 4: Deposit — batched (already on-chain) or via relay
      this.emit('step', { agentId: this.agentId, step: 'deposit', status: 'pending' })
      const depositResult = (this.batchedHash && !this.grantsBatched)
        ? { txHash: this.batchedHash, status: 'onchain' }
        : await relayDeposit({
            agentId: this.agentId,
            user: this.user,
            vault: this.vault,
            amount: this.amount,
            permissionContext: this.permissionContext
          })
      const gasMethod =
        depositResult.status === 'onchain' ? 'user-signed'
        : depositResult.status === 'simulated' ? 'simulated'
        : 'relayer'
      const lesson = buildLesson(this.vault, { shares: this.amount.toString() })
      this.memoryEntries.push(createEntry('deposit', 'success', { txHash: depositResult.txHash, gasMethod }, lesson))
      this.emit('step', {
        agentId: this.agentId, step: 'deposit', status: 'done',
        txHash: depositResult.txHash, gasMethod, relayer: depositResult.relayer || null
      })

      // Write memory
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('completed', {
        agentId: this.agentId,
        vault: this.vault,
        txHash: depositResult.txHash,
        gasMethod,
        relayer: depositResult.relayer || null,
        simulated: depositResult.status === 'simulated'
      })

      return { success: true, txHash: depositResult.txHash }
```

- [ ] **Step 4: Store `gasMethod` and render a warning in app.jsx**

In `frontend/src/app.jsx`, the deposit-`done` branch is inside the `step` handler (lines 868-895). Replace the `if (data.status === "done")` block (lines 891-894) with one that records `gasMethod` and adds an honest log line:

```js
          if (data.status === "done") {
            const evMap = { swap: "SwapExecuted", approve: "ApproveExecuted", deposit: "DepositExecuted" };
            if (stepName === "deposit") {
              const gasLabel = data.gasMethod === "relayer" ? "gas paid by relayer"
                : data.gasMethod === "user-signed" ? "⚠ gas paid by user · relay not configured"
                : data.gasMethod === "simulated" ? "[simulated]"
                : "";
              addLog({
                event: "DepositExecuted", agent: dId,
                meta: `${data.txHash ? `tx ${shortAddr(data.txHash)}` : "[simulated]"}${gasLabel ? " · " + gasLabel : ""}`,
              });
            } else if (evMap[stepName]) {
              addLog({ event: evMap[stepName], agent: dId, meta: data.txHash ? `tx ${shortAddr(data.txHash)}` : "[simulated]" });
            }
          }
```

Also persist `gasMethod` on the agent exec state. In the same `step` handler, inside the `setExecMap` updater (lines 872-890), add `gasMethod` to the returned object so the dashboard can show it:

```js
            return {
              ...prev,
              [dId]: {
                ...cur,
                activeStep: stepName,
                gasMethod: data.gasMethod || cur.gasMethod || null,
                steps: { ...(cur.steps || {}), [stepName]: stepStatus },
                hashes: data.txHash ? { ...(cur.hashes || {}), [stepName]: data.txHash } : (cur.hashes || {}),
                memory: [...(cur.memory || []), {
                  status: stepStatus,
                  title: `${stepName} ${data.status === "done" ? "confirmed" : "executing"}`,
                  meta: data.txHash
                    ? `tx ${shortAddr(data.txHash)}${data.gasMethod === "user-signed" ? " · ⚠ user-signed" : ""}`
                    : "via 1Shot relayer",
                  hash: data.txHash || null,
                  t: nowT(),
                }],
              },
            };
```

- [ ] **Step 5: Run worker test (gasMethod cases pass; swap-skipped still fails)**

Run: `cd frontend && npx vitest run src/worker.test.js`
Expected: the two `gasMethod` tests PASS; the `swap skipped` test FAILS (lands in Task 3).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/worker.js frontend/src/app.jsx frontend/src/worker.test.js
git commit -m "feat: surface real gas-payment method (relayer vs user-signed) in events and log"
```

---

## Task 3: De-simulate the swap + approve steps in worker.js

**Why:** `worker.js:56-66` fakes swap (`sleep(300)`) and approve (`sleep(200)`) with no on-chain action. Reality: for our USDC→USDC MockVault there is **no swap**, and the `ApproveExecuted` event is emitted **atomically inside the deposit tx**. Make both honest: swap = `skipped` (with reason), approve = resolved from the **real deposit tx hash**.

**Files:**
- Modify: `frontend/src/worker.js:56-90` (swap → skipped; approve resolved post-deposit)
- Modify: `frontend/src/app.jsx:868-895` (handle `skipped` status) and `:1108-1110` (fallback demo block)
- Modify: `frontend/src/agents.jsx:67-68, 88-97` (`skipped` label + palette)
- Modify: `frontend/src/venice.js:218-225, 249` (skill `swap.required` flag)

- [ ] **Step 1: Confirm the worker test's swap-skipped expectation (already written in Task 2)**

The assertion `expect(swap.data.status).toBe('skipped')` already exists in `frontend/src/worker.test.js`. Run it to confirm current RED:

Run: `cd frontend && npx vitest run src/worker.test.js -t "skipped"`
Expected: FAIL — swap currently emits `done`, not `skipped`.

- [ ] **Step 2: Rewrite the swap + approve steps in worker.js**

In `frontend/src/worker.js`, replace lines 56-90 (Step 2 swap through the `completed` emit). The deposit/gasMethod block from Task 2 is folded in here so the file is internally consistent. Full replacement of lines 56-90:

```js
      // Step 2: Swap — for our USDC→USDC MockVault there is no token conversion.
      // Honest: mark skipped. (On-chain, executeAgentDeposit still emits a 1:1
      // SwapExecuted event atomically with the deposit; no separate swap tx exists.)
      const swapNeeded = false // tokenIn === tokenOut for MockVault
      this.emit('step', { agentId: this.agentId, step: 'swap', status: 'pending' })
      if (swapNeeded) {
        // Reserved for real tokenIn !== tokenOut routing (Uniswap V3) — not used by MockVault.
        this.memoryEntries.push(createEntry('swap', 'success', { amountIn: this.amount.toString(), amountOut: this.amount.toString() }))
        this.emit('step', { agentId: this.agentId, step: 'swap', status: 'done' })
      } else {
        this.memoryEntries.push(createEntry('swap', 'skipped', { reason: 'USDC→USDC: no swap required' }))
        this.emit('step', { agentId: this.agentId, step: 'swap', status: 'skipped', reason: 'USDC→USDC: no swap required' })
      }

      // Step 3: Approve — no real ERC20 approve exists (MockVault is pure-accounting;
      // executeAgentDeposit never calls transferFrom). The ApproveExecuted event is
      // emitted on-chain ATOMICALLY inside the deposit tx, so we resolve this step
      // from the real deposit tx hash AFTER the deposit returns (below).
      this.emit('step', { agentId: this.agentId, step: 'approve', status: 'pending' })

      // Step 4: Deposit — batched (already on-chain) or via relay
      this.emit('step', { agentId: this.agentId, step: 'deposit', status: 'pending' })
      const depositResult = (this.batchedHash && !this.grantsBatched)
        ? { txHash: this.batchedHash, status: 'onchain' }
        : await relayDeposit({
            agentId: this.agentId,
            user: this.user,
            vault: this.vault,
            amount: this.amount,
            permissionContext: this.permissionContext
          })
      const gasMethod =
        depositResult.status === 'onchain' ? 'user-signed'
        : depositResult.status === 'simulated' ? 'simulated'
        : 'relayer'

      // Resolve approve from the real deposit tx (ApproveExecuted emitted in the same tx).
      this.memoryEntries.push(createEntry('approve', 'success', { txHash: depositResult.txHash, note: 'emitted on-chain in deposit tx' }))
      this.emit('step', { agentId: this.agentId, step: 'approve', status: 'done', txHash: depositResult.txHash })

      const lesson = buildLesson(this.vault, { shares: this.amount.toString() })
      this.memoryEntries.push(createEntry('deposit', 'success', { txHash: depositResult.txHash, gasMethod }, lesson))
      this.emit('step', {
        agentId: this.agentId, step: 'deposit', status: 'done',
        txHash: depositResult.txHash, gasMethod, relayer: depositResult.relayer || null
      })

      // Write memory
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('completed', {
        agentId: this.agentId,
        vault: this.vault,
        txHash: depositResult.txHash,
        gasMethod,
        relayer: depositResult.relayer || null,
        simulated: depositResult.status === 'simulated'
      })

      return { success: true, txHash: depositResult.txHash }
```

Then delete the now-unused `sleep` helper at the bottom of the file (`worker.js:108-110`):

```js
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

- [ ] **Step 3: Handle `skipped` status in the app.jsx step handler**

In `frontend/src/app.jsx`, the `step` handler computes `stepStatus` at line 871:

```js
            const stepStatus = data.status === "done" ? "confirmed" : "running";
```

Replace with a 3-way mapping so `skipped` is preserved (not shown as a spinner):

```js
            const stepStatus = data.status === "done" ? "confirmed"
              : data.status === "skipped" ? "skipped"
              : "running";
```

And in the `if (data.status === "done")` log block (already edited in Task 2), the swap arm now never fires for the skipped case. Add a `skipped` log arm right before it. Final structure of that conditional:

```js
          if (data.status === "skipped" && stepName === "swap") {
            addLog({ event: "SwapExecuted", agent: dId, meta: data.reason || "skipped · no swap required" });
          }
          if (data.status === "done") {
            // ... (gasMethod-aware block from Task 2, unchanged) ...
          }
```

- [ ] **Step 4: De-fake the step-rail "done" navigation block in app.jsx**

`frontend/src/app.jsx:1103-1115` is the `onStepClick` handler's `id === "done"` branch. Clicking the "done" step in the rail **fabricates** a confirmed `execMap` with `fakeHash()` for every agent — overwriting real execution data with fake tx hashes. Single largest simulation artifact. Fix: **preserve the real `execMap`**, only synthesize a confirmed shell with **no hashes** for agents that have none. Replace the whole `if (id === "done") { ... }` block (lines 1103-1116):

```js
    if (id === "done") {
      setStage("done"); setConnectPhase("upgraded"); setPermActive(true);
      // Preserve real execution state. Navigating back to "done" must NOT fabricate
      // tx hashes — only fill a confirmed shell (no hashes) for agents the user
      // genuinely reached but whose live exec map was lost (e.g. after reload).
      setExecMap((prev) => {
        const map = { ...(prev || {}) };
        ensured.agents.forEach((a) => {
          const cur = map[a.id];
          const alreadyReal = cur && cur.hashes && cur.hashes.deposit;
          if (alreadyReal) return; // keep real, event-sourced state untouched
          map[a.id] = {
            status: "confirmed", activeStep: null,
            steps: { swap: "skipped", approve: "confirmed", deposit: "confirmed" },
            hashes: cur?.hashes || {}, // never fakeHash() — empty if no real tx
            gasMethod: cur?.gasMethod || null,
            memory: cur?.memory?.length ? cur.memory : [{ status: "confirmed", title: "agent completed", meta: "position confirmed on-chain", t: nowT(), lesson: "vault deposit complete" }],
            metrics: cur?.metrics || { totalRuns: 1, successRate: 100, startedAt: Date.now(), completedAt: Date.now() },
          };
        });
        return map;
      });
    }
```

Remove the now-unused `fakeHash` import. In `frontend/src/app.jsx:11`, drop `fakeHash` so the line reads:

```js
  PermissionCard, SuccessCard, shortAddr,
```

Verify: `rtk grep "fakeHash" frontend/src/app.jsx` — expected no matches.

- [ ] **Step 4b: Remove the dead `fakeHash` helper in screens.jsx**

`fakeHash` is now dead. In `frontend/src/screens.jsx`, delete the definition (line 9):

```js
const fakeHash = () => "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
```

and remove `fakeHash` from the export block (line 551) so it reads:

```js
  PermissionCard, SuccessCard, shortAddr,
```

Confirm no remaining consumers: `rtk grep "fakeHash" frontend/src` — expected no matches.

- [ ] **Step 5: Add the `skipped` step palette + label in agents.jsx**

In `frontend/src/agents.jsx`, extend `STEP_LABELS` (line 68):

```js
const STEP_LABELS = { swap: "Swap", approve: "Approve", deposit: "Deposit" };
const STEP_NOTE = { swap: "skipped · USDC→USDC needs no swap" };
```

Add a `skipped` color to BOTH palette objects (the bright palette at lines ~88-92 and the dim palette at ~95-97). After the `confirmed:` entry in each, add:

```js
  skipped:   "#6b7280",
```

The agent step pip (line 272) already renders `className={`agent-step-pip ${ex.steps?.[sid] || "idle"}`}` — so a `skipped` step yields class `agent-step-pip skipped`. Add this CSS rule to the stylesheet that defines `.agent-step-pip` (search for `.agent-step-pip` under `frontend/`; likely `frontend/src/style.css` or `frontend/styles.css`):

```css
.agent-step-pip.skipped { opacity: 0.45; }
```

If the `.agent-step-pip` rule is not found in a `.css` file under `frontend/`, skip this CSS step — the pip still renders with default styling and the `title` tooltip (`STEP_LABELS[sid]`) conveys state.

- [ ] **Step 6: Mark swap as optional in the generated skill schema (venice.js)**

In `frontend/src/venice.js`, update the fallback skill `swap` object (line 220) and the prompt's JSON schema `swap` line (line 249) to include a `required` flag so the skill card can reflect that swap is conditional.

Fallback (line 220) — change:

```js
      swap: { maxSlippage: 0.5, dexPreference: 'mock', maxRetries: 2, timeoutSeconds: 30 },
```

to:

```js
      swap: { required: false, maxSlippage: 0.5, dexPreference: 'mock', maxRetries: 2, timeoutSeconds: 30 },
```

Prompt schema (line 249) — change:

```js
    "swap": { "maxSlippage": 0.5, "dexPreference": "uniswap-v3", "maxRetries": 2, "timeoutSeconds": 30 },
```

to:

```js
    "swap": { "required": false, "maxSlippage": 0.5, "dexPreference": "uniswap-v3", "maxRetries": 2, "timeoutSeconds": 30 },
```

**Second copy in `skills.js`** — `frontend/src/skills.js:30` has the same fallback skill swap object. Change:

```js
      swap: { maxSlippage: 0.5, dexPreference: 'mock', maxRetries: 2, timeoutSeconds: 30 },
```

to:

```js
      swap: { required: false, maxSlippage: 0.5, dexPreference: 'mock', maxRetries: 2, timeoutSeconds: 30 },
```

> The skill card renderer (`frontend/src/skills.jsx` / `SkillDrawer.jsx`) reads the skill object generically; the extra `required` key renders as another field. If you want an explicit "Swap not required (tokenIn = tokenOut)" caption, add it where `skills.swap` is rendered — optional, not required for de-simulation.

- [ ] **Step 7: Run worker test — all pass**

Run: `cd frontend && npx vitest run src/worker.test.js`
Expected: PASS (3 tests, including `marks swap as skipped`).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/worker.js frontend/src/app.jsx frontend/src/agents.jsx frontend/src/venice.js frontend/src/skills.js frontend/src/screens.jsx
git commit -m "feat: de-simulate swap/approve — skip USDC→USDC swap, resolve approve from real deposit tx, drop fake hashes"
```

---

## Task 3B: Eliminate every remaining fake tx-hash + `[simulated]` artifact

**Why:** Two paths can still surface fabricated data: `submitRelay` returns a fake `'0xsim_'` hash with `status:'simulated'` (`relay.js:110-117`), and `app.jsx` renders `"[simulated]"` log labels (`:893,909,918`). On Base Sepolia (84532) `submitRelay` is **unreachable** — `relayDeposit`/`relayGrantPermission` take the unsupported-chain branch first — so making it throw changes nothing on our chain while removing the only code able to mint a fake hash. After this, `depositResult.status` can only ever be `relayed`/`submitted`/`onchain`; `simulated` becomes impossible, so the `[simulated]` UI branches are dead and get replaced with honest text.

**Files:**
- Modify: `frontend/src/relay.js:110-117` (`submitRelay` — throw instead of fake hash)
- Modify: `frontend/src/app.jsx:893,909,918` (honest labels)
- Modify: `frontend/src/relay.test.js` (only if a test asserts the `simulated` return — adjust to expect a throw)

- [ ] **Step 1: Make `submitRelay` throw instead of returning a fake hash**

In `frontend/src/relay.js`, replace the defensive simulation branch (lines 113-117):

```js
  // Defensive: keyless relayer can't serve this chain → simulate rather than hard-fail.
  if (!ONESHOT_SUPPORTED_CHAINS.has(chainStr)) {
    await new Promise(r => setTimeout(r, 700))
    return { txHash: '0xsim_' + Date.now().toString(16), status: 'simulated' }
  }
```

with a hard error — no fabricated hash can ever leave this function:

```js
  // Keyless relayer can't serve this chain. Callers (relayDeposit/relayGrantPermission)
  // already route Base Sepolia to the managed proxy / on-chain fallback BEFORE calling
  // submitRelay, so reaching here is a real misconfiguration — fail loudly, never fake a tx.
  if (!ONESHOT_SUPPORTED_CHAINS.has(chainStr)) {
    throw new Error(`1Shot keyless relayer does not support chain ${chainStr} — use the managed proxy`)
  }
```

- [ ] **Step 2: Check for a test asserting the old simulated return**

Run: `rtk grep "simulated|0xsim" frontend/src/relay.test.js`
Expected: if any test expects `status: 'simulated'` from `submitRelay`, change it to `await expect(submitRelay({...})).rejects.toThrow(/does not support chain/)`. If no match, no test change needed.

- [ ] **Step 3: Replace the `[simulated]` labels in app.jsx with honest text**

`status: 'simulated'` can no longer occur, so `data.simulated` is always false and a missing `txHash` now means a genuine failure, not a simulation. Update the three sites.

`frontend/src/app.jsx:893` (inside the deposit/step `done` log — only the non-deposit `evMap` arm remains after Task 2; this is its `meta` fallback):

```js
            if (evMap[stepName]) addLog({ event: evMap[stepName], agent: dId, meta: data.txHash ? `tx ${shortAddr(data.txHash)}` : "no tx hash" });
```

`frontend/src/app.jsx:909` (completed-event memory `meta`):

```js
                  meta: `tx ${shortAddr(data.txHash)}`,
```

`frontend/src/app.jsx:918` (completed `addLog`):

```js
          addLog({ event: "AgentCompleted", agent: dId, meta: data.txHash ? `tx ${shortAddr(data.txHash)}` : "completed · no tx hash" });
```

- [ ] **Step 4: Drop the now-meaningless `simulated` flag from the worker completed event**

In `frontend/src/worker.js`, the `completed` emit carries `simulated: depositResult.status === 'simulated'` (always false now). Remove that line from the `this.emit('completed', { ... })` object so it reads:

```js
      this.emit('completed', {
        agentId: this.agentId,
        vault: this.vault,
        txHash: depositResult.txHash,
        gasMethod,
        relayer: depositResult.relayer || null
      })
```

> `app.jsx` references to `data.simulated` (line 909/918, edited above) no longer read it — safe to drop.

- [ ] **Step 5: Run the relay + worker suites**

Run: `cd frontend && npx vitest run src/relay.test.js src/worker.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/relay.js frontend/src/app.jsx frontend/src/worker.js frontend/src/relay.test.js
git commit -m "fix: remove fake 0xsim relay hash and [simulated] labels — fail loud instead of faking a tx"
```

---

## Task 4: Reconcile on-chain positions with retry/backoff

**Why:** `handleExecDone` (`app.jsx:966-1014`) reads chain balances once. Right after a deposit, balances can lag 1-2 blocks, so the read returns null/zero and the UI shows the **allocation seed** (hardcoded `a.allocation * 1e6`) instead of real `balanceOf`. Retry with backoff makes the on-chain number win.

**Files:**
- Modify: `frontend/src/app.jsx:966-1014` (`handleExecDone` — add `reconcileWithRetry` and use it)

- [ ] **Step 1: Add a retry helper above `handleExecDone`**

In `frontend/src/app.jsx`, immediately before `const handleExecDone = async () => {` (line 966), insert:

```js
  // Chain balances can lag 1-2 blocks after a deposit. Retry until at least one
  // vault reports a non-zero balance, then trust the on-chain numbers.
  async function reconcileWithRetry(address, maxAttempts = 3, delayMs = 3000) {
    for (let i = 0; i < maxAttempts; i++) {
      let result = null;
      try { result = await reconcilePositionsFromChain(address); } catch { result = null; }
      if (result && Object.values(result).some((p) => BigInt(p.balance || '0') > 0n)) {
        return result;
      }
      if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }
```

- [ ] **Step 2: Use the retry helper in `handleExecDone`**

In `frontend/src/app.jsx`, replace the single-shot read (lines 989-990):

```js
    let chain = null;
    try { chain = await reconcilePositionsFromChain(realAddress); } catch { /* keep seed */ }
```

with:

```js
    const chain = await reconcileWithRetry(realAddress);
```

The downstream `if (chain) { ... } else if (seed) { ... }` branches (lines 991-1012) are unchanged — they already prefer chain over seed.

- [ ] **Step 3: Verify in the browser (preview)**

Run the dev server and complete a deposit flow; confirm the "done" screen shows on-chain balances (not the seed) after the retry window. Use the preview tooling:

- `preview_start` (serves `frontend/`), then drive the flow.
- `preview_console_logs` — confirm no unhandled rejection from `reconcileWithRetry`.
- `preview_snapshot` — confirm position balances render.

If a full wallet flow isn't reachable in preview, this step is satisfied by the unit-level guarantee that `reconcileWithRetry` returns the chain map when any balance is > 0 (covered by reading `positionsStore.reconcilePositionsFromChain`, `positionsStore.js:48-91`).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: retry on-chain position reconciliation with backoff so real balances win over seed"
```

---

## Task 5: Verify MockVault yield accrual (NO code change)

**Why:** Layer 3 is already implemented (`apyBps`, `depositTimestamp`, `getUnclaimedRewards` — `contracts/MockVault.sol:11,16,59-65`). This task **proves** it works and guards against regressions. Do **not** modify `convertToAssets` (it must stay `pure` for `positionsStore.js:68`).

**Files:**
- Read: `contracts/MockVault.sol` (no edit)
- Test: `test/MockVault.t.sol` (add a yield-accrual test if absent)

- [ ] **Step 1: Check whether a yield test already exists**

Run: `rtk grep "getUnclaimedRewards" test/MockVault.t.sol`
Expected: if a `testYieldAccrual`/`getUnclaimedRewards` test exists, skip to Step 4 (run it). If not, continue.

- [ ] **Step 2: Add a yield-accrual test**

Append to `test/MockVault.t.sol` (inside the existing test contract; it deploys a `MockVault` — match the existing setUp's constructor args `("Test", asset, apyBps)`):

```solidity
function testYieldAccruesOverTime() public {
    address user = address(0xBEEF);
    // vault apyBps is set in setUp; assert accrual is monotonic and ~linear.
    vault.deposit(1_000_000, user); // 1 USDC (6 decimals)
    assertEq(vault.getUnclaimedRewards(user), 0, "no yield at t0");

    vm.warp(block.timestamp + 365 days);
    uint256 oneYear = vault.getUnclaimedRewards(user);
    assertGt(oneYear, 0, "yield must accrue after a year");

    // ~ principal * apyBps / 10000 after one year (integer math tolerance)
    uint256 expected = (1_000_000 * vault.apyBps()) / 10000;
    assertApproxEqAbs(oneYear, expected, 1, "one-year yield ~ apy");
}
```

> If `setUp` names the vault variable differently or doesn't expose `apyBps()`, adapt the identifiers to match the existing file — read `test/MockVault.t.sol` first.

- [ ] **Step 3: Verify `convertToAssets` is still `pure` (guard the reconcile contract)**

Run: `rtk grep "function convertToAssets" contracts/MockVault.sol`
Expected: `function convertToAssets(uint256 shares) public pure returns (uint256)`. If anyone changed it to read `msg.sender`, that is a regression — revert it; `positionsStore.reconcilePositionsFromChain` calls `convertToAssets(shares)` with no user context.

- [ ] **Step 4: Run the contract tests (WSL only)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract MockVault -vvv"`
Expected: PASS, including `testYieldAccruesOverTime`.

- [ ] **Step 5: Commit (only if a test was added)**

```bash
git add test/MockVault.t.sol
git commit -m "test: assert MockVault time-based yield accrual"
```

---

## Task 6 (OPTIONAL — DEFER until after demo): Split app.jsx into hooks

**Why deferred:** `app.jsx` is large but the de-simulation work (Tasks 1-5) is what judges see. This is pure maintainability and carries refactor risk. Do **not** start it before the demo is green. Listed for completeness.

**Files:**
- Create: `frontend/src/hooks/useStrategyFlow.js`, `frontend/src/hooks/useAgentExecution.js`, `frontend/src/hooks/usePermission.js`
- Modify: `frontend/src/app.jsx` (consume hooks)

**Approach (one hook at a time, behavior-preserving):**

- [ ] **Step 1:** Extract permission state first (smallest surface): move `permPhase`, `permActive`, `permContext` + `handleGrant`/`handlePermConfirm`/`handleRevoke` into `usePermission()`. Return the same names. Wire in `app.jsx`. Run `cd frontend && npx vitest run` + manual smoke. Commit.
- [ ] **Step 2:** Extract `useStrategyFlow()` (`strategyPhase`, `strategy`, `rawStrategy`, `handleSubmit`, `handleRegenerate`). Wire, test, commit.
- [ ] **Step 3:** Extract `useAgentExecution()` (`execMap`, `agentMapRef`, `startExecution`, `handleExecDone` — note `handleExecDone` now contains `reconcileWithRetry` from Task 4). Wire, test, commit.

Each step is its own commit with `cd frontend && npx vitest run` passing in between. If any extraction changes behavior, stop and revert that step — this is non-essential.

---

## Final verification

- [ ] **Step 1: Frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: all suites PASS (existing + new `venice.test.js`, `worker.test.js`).

- [ ] **Step 2: Frontend build**

Run: `cd frontend && npm run build`
Expected: build succeeds, no unresolved import (e.g. the removed `sleep`).

- [ ] **Step 3: Contract tests (WSL)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test"`
Expected: all PASS.

- [ ] **Step 4: Grep the whole tree for remaining simulation artifacts**

Run each; all must come back clean (or only the KEEP-list residue noted):

```bash
rtk grep "sleep\(" frontend/src        # expected: no matches (helper deleted)
rtk grep "fakeHash" frontend/src        # expected: no matches (helper + all callers removed)
rtk grep "0xsim" frontend/src           # expected: no matches (submitRelay throws)
rtk grep "\[simulated\]" frontend/src   # expected: no matches (labels replaced)
rtk grep "status: 'simulated'" frontend/src  # expected: no matches
```

Residual `simulate`/`simulation` strings are allowed **only** in: `agents.jsx` (d3 graph physics), `monitorLoop.js` / `app.jsx:471` / `agents.jsx:596` (MDP `simulate` phase = real `scoreReward`), and `*.test.js` mocks. Anything else is a missed artifact — fix it.

- [ ] **Step 5: Final commit (if anything uncommitted)**

```bash
git add -A
git commit -m "chore: finalize de-simulation pass across worker, venice, positions"
```

---

## Self-review notes (already reconciled against the code)

- **Spec coverage:** Layer 1 → Task 3. Layer 2 → Task 3 (reframed: no batch-approve; approve resolved from real tx). Layer 3 → Task 5 (verify-only). Layer 4 → Task 2. Layer 5 → Task 4. Layer 6 → Task 1. Layer 7 → Task 6 (deferred). **Beyond the 7 layers — full-sweep artifacts → Task 3 Step 4/4b (rail-nav `fakeHash`) + Task 3B (`submitRelay` fake hash + `[simulated]` labels + `simulated` flag).**
- **Deliberately NOT done (with reason):** EIP-2612 permit / batch `USDC.approve` (no `transferFrom` exists → no-op); `convertToAssets` yield change (breaks `positionsStore` read); Uniswap V3 swap wiring (no USDC/USDC pool; tokenIn === tokenOut → swap genuinely unnecessary; the `swapNeeded` branch is left as a documented seam).
- **Type/name consistency:** event field `gasMethod` ∈ {`relayer`,`user-signed`,`simulated`}; step status `skipped` added to worker emit + `app.jsx` `stepStatus` map + `agents.jsx` palette; `execMap[id].steps.swap` may now be `"skipped"`.
- **1Shot:** code already uses managed proxy on 84532 + `relayer_send7710Transaction`; the user's `relayer_getCapabilities` check is a runtime verification, not a code change — run it manually if relaying behaves unexpectedly, but it does not block this plan.

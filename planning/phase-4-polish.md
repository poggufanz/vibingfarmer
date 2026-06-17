# Phase 4 — Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Vibing Farmer frontend for demo-ready quality — fix Reset localStorage bug, Venice AI skill display, activity log clarity, memory UI timestamps, and update demo script.

**Architecture:** All changes are frontend-only (`frontend/`). No contract changes needed. Five focused tasks, each independently committable.

**Tech Stack:** Vanilla JS ESM, vis.js, localStorage, Venice AI (OpenAI-compat API), MetaMask Flask

**Deadline:** 15 Juni 2026 | Prize: $11,000

---

## File Map

| File | Change |
|------|--------|
| `frontend/app.js` | Reset handler → call clearMemory + clearSkills |
| `frontend/relay.js` | Log simulated relay differently in return value |
| `frontend/ui.js` | Memory entry timestamp format; skills display simplification |
| `frontend/venice.js` | Verify generateAgentSkills output shape matches skills.js |
| `docs/produk-demo-skenario.md` | Update demo script for Phase 4 final flow |
| `CLAUDE.md` | Mark Phase 3 done, Phase 4 done |

---

## Task 1 — Fix Reset: Clear localStorage

**Problem:** `app.js` Reset handler clears graph/log/steps but NOT `yv_memory` or `yv_skills`. Re-run after reset shows stale memory from previous session in node detail panel.

**Files:**
- Modify: `frontend/app.js` (Reset button handler, lines ~206–225)

- [ ] **Step 1: Import clearMemory + clearSkills in app.js**

At top of `frontend/app.js`, add to existing imports:
```js
import { readMemory, loadAllMemory, clearMemory } from './memory.js'
import { loadSkill, clearSkills } from './skills.js'
```

- [ ] **Step 2: Call clear functions in Reset handler**

In `frontend/app.js`, inside the `btn-reset` click handler, add after `state.graph?.reset()`:
```js
clearMemory()
clearSkills()
```

Full handler after fix:
```js
document.getElementById('btn-reset').addEventListener('click', () => {
  state.phase = 'idle'
  state.strategy = null
  state.vaultPlans = []
  state.permissionContext = null
  state.graph?.reset()
  clearMemory()
  clearSkills()
  hideGraph()
  document.getElementById('log-entries').innerHTML = ''
  document.getElementById('detail-panel').innerHTML = '<span class="empty">—</span>'
  const walletMeta = document.getElementById('wallet-meta')
  const walletDetail = document.getElementById('wallet-detail')
  if (walletMeta) walletMeta.textContent = 'not connected'
  if (walletDetail) walletDetail.innerHTML = '<span class="empty">— belum connect</span>'
  ;['connect', 'generate', 'approve', 'execute', 'done'].forEach(s => setStep(s, 'pending'))
  setButtonEnabled('btn-connect', true)
  setButtonEnabled('btn-generate', false)
  setButtonEnabled('btn-approve', false)
  setButtonVisible('btn-reset', false)
  logActivity('Reset.', 'info')
})
```

- [ ] **Step 3: Test manually**
  1. Run full flow (Generate → Approve → Execute)
  2. Click node Worker → verify memory entries show
  3. Click Reset
  4. DevTools → Application → Local Storage → verify `yv_memory` and `yv_skills` are gone
  5. Re-run flow → click Worker node → memory shows fresh entries only

- [ ] **Step 4: Commit**
```
git add frontend/app.js
git commit -m "fix(reset): clear yv_memory and yv_skills on reset"
```

---

## Task 2 — Activity Log: Mark Simulated Relay

**Problem:** Simulated relay returns `txHash: '0xsim_...'` which shows in activity log as a real-looking hash. For demo clarity, should indicate relay is simulated on Sepolia.

**Files:**
- Modify: `frontend/worker.js` (completed event handler)

- [ ] **Step 1: Pass status from relay result to completed event**

In `frontend/worker.js`, the `execute()` method after successful deposit:
```js
// Step 4: Deposit via 1Shot relay
this.emit('step', { agentId: this.agentId, step: 'deposit', status: 'pending' })
const depositResult = await relayDeposit({
  agentId: this.agentId,
  user: this.user,
  vault: this.vault,
  amount: this.amount,
  permissionContext: this.permissionContext
})
const lesson = buildLesson(this.vault, { shares: this.amount.toString() })
this.memoryEntries.push(createEntry('deposit', 'success', { txHash: depositResult.txHash }, lesson))
this.emit('step', { agentId: this.agentId, step: 'deposit', status: 'done', txHash: depositResult.txHash })

// Write memory
writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
this.emit('completed', {
  agentId: this.agentId,
  vault: this.vault,
  txHash: depositResult.txHash,
  simulated: depositResult.status === 'simulated'
})
```

- [ ] **Step 2: Update completed log message in app.js**

In `frontend/app.js`, `handleAgentEvent` case `'completed'`:
```js
case 'completed':
  logActivity(
    `Agent ${agentId.slice(0, 10)}... completed. ${data.simulated ? '[simulated]' : `TX: ${data.txHash?.slice(0, 14)}...`}`,
    'success'
  )
  state.graph?.setWorkerStatus(agentId, 'done')
  break
```

- [ ] **Step 3: Test manually**
  - Run flow → activity log shows `Agent 0x6167656e... completed. [simulated]`
  - Looks intentional, not like a broken hash

- [ ] **Step 4: Commit**
```
git add frontend/worker.js frontend/app.js
git commit -m "fix(relay): label simulated relay in activity log"
```

---

## Task 3 — Memory UI: Timestamp + Better Entry Display

**Problem:** Memory entries in right rail show step/status/lesson but no timestamp. Hard to read at a glance during demo.

**Files:**
- Modify: `frontend/ui.js` (`showAgentDetail` function, memory entry rendering)

- [ ] **Step 1: Update memory entry rendering in showAgentDetail**

In `frontend/ui.js`, replace the memory entry map in `showAgentDetail`:
```js
${agent.memory && agent.memory.length > 0
  ? agent.memory.map(e => {
      const t = new Date(e.timestamp * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      return `
        <div class="memory-entry memory-entry--${e.status}">
          <div class="memory-entry-row">
            <span class="memory-step">${e.step}</span>
            <span class="memory-status">${e.status === 'success' ? '✓' : '✕'}</span>
            <span class="memory-time">${t}</span>
          </div>
          ${e.lesson ? `<div class="memory-lesson">${e.lesson}</div>` : ''}
        </div>
      `
    }).join('')
  : `<div class="detail-empty">No entries yet</div>`}
```

- [ ] **Step 2: Add CSS for memory-entry-row and memory-time**

In `frontend/style.css`, add after `.memory-entry`:
```css
.memory-entry-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.memory-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-dim, #666);
  font-family: var(--font-mono, monospace);
}
```

- [ ] **Step 3: Test manually**
  - Run full flow
  - Click Worker node after execute
  - Memory entries show: step name, ✓/✕ status, timestamp on same row, lesson below

- [ ] **Step 4: Commit**
```
git add frontend/ui.js frontend/style.css
git commit -m "feat(memory-ui): add timestamp + cleaner entry layout in node detail"
```

---

## Task 4 — Venice AI Skill Generation Test

**Problem:** Venice AI key is in `.env` but never tested in browser flow. `generateAgentSkills` output shape needs to match what `skills.js` stores and `showAgentDetail` displays.

**Files:**
- Read: `frontend/venice.js` (verify generateAgentSkills output)
- Modify if needed: `frontend/venice.js`

- [ ] **Step 1: Get Venice API key**

From `.env`: `VENICE_API_KEY=VENICE_ADMIN_KEY_...`
Copy just the value (everything after `=`).

- [ ] **Step 2: Test Generate Strategy with Venice**
  1. Hard refresh (`Ctrl+Shift+R`)
  2. Connect Wallet
  3. In Venice API Key field, paste the key from `.env`
  4. Fill: Amount 10, Risk Medium, Vaults 2
  5. Click Generate Strategy
  6. Expected: Activity log shows `Strategy: <Venice rationale>` (not "Fallback: equal split...")
  7. DevTools Console: no errors

- [ ] **Step 3: Test Approve & Execute with Venice key**
  1. Click Approve & Execute
  2. MetaMask popup → approve
  3. After execute: click Worker node
  4. Skills section should show Venice-generated JSON with `generatedBy: "venice-ai"`
  5. Memory section shows entries

- [ ] **Step 4: If generateAgentSkills fails, check venice.js**

Open `frontend/venice.js` and verify `generateAgentSkills` returns object with shape:
```js
{
  agentId: string,
  vaultAddress: string,
  skills: { swap: {...}, deposit: {...} },
  generatedBy: 'venice-ai',
  approvedByUser: false
}
```

If Venice returns different shape, map it to this structure before `saveSkill()`.

- [ ] **Step 5: Commit if any fix was needed**
```
git add frontend/venice.js
git commit -m "fix(venice): normalize generateAgentSkills output shape"
```
(Skip if no fix needed)

---

## Task 5 — Demo Script Update + CLAUDE.md

**Goal:** Update demo scenario for final video, mark phases complete.

**Files:**
- Modify: `docs/produk-demo-skenario.md`
- Modify: `CLAUDE.md` (phase status table)

- [ ] **Step 1: Update demo script key points**

In `docs/produk-demo-skenario.md`, update/add:

```markdown
## Demo Flow (Final — Phase 4)

### Scene 1: Load App (30s)
- Open http://localhost:3000
- Show dark 3-column layout
- Console: "YIELD VIBING ready. Connect wallet to start."

### Scene 2: Connect Wallet (30s)
- Click Connect Wallet → MetaMask Flask popup
- After connect: step dot "01 Connect" green, right rail shows address + "eip-7702 ready"

### Scene 3: Venice AI Strategy (60s)
- Fill: Amount 10 USDC, Risk Medium, Vaults 2, Venice API Key
- Click Generate Strategy
- Show: graph appears — Orchestrator (yellow) + 2 Workers (grey) + 2 Vaults (purple)
- Activity log: Venice AI rationale (not fallback)

### Scene 4: Node Detail (30s)
- Click Orchestrator node → right rail shows agent counts
- Click Worker 1 → Agent ID, Vault address, Skills (Venice-generated JSON)

### Scene 5: ERC-7715 Permission (60s)
- Click Approve & Execute
- MetaMask Flask popup: erc20-token-periodic, USDC, 24h expiry
- Approve → "Permission granted. Dispatching agents..."

### Scene 6: Agent Execution (60s)
- Workers turn blue (active)
- Workers turn green (completed)
- Activity log: "Done — 2 deposited, 0 failed"
- Step 04 Execute green

### Scene 7: Memory Entries (30s)
- Click Worker node AFTER execute
- Memory entries: step names, ✓ status, timestamps, lesson text

### Scene 8: Reset (15s)
- Click Reset → clean slate, localStorage cleared
```

- [ ] **Step 2: Update CLAUDE.md phase status**

In `CLAUDE.md`, update the phase table:
```markdown
| Phase | Days | Status | Focus |
|-------|------|--------|-------|
| 1 — Foundation | 1–3 | ✅ Done | Solidity review + setup + spike review |
| 2 — Smart Contract | 4–8 | ✅ Done | AgentVaultDepositor.sol + tests |
| 3 — Integration | 9–13 | ✅ Done | 1Shot + Orchestrator/Worker agents + vis.js graph + Sepolia test |
| 4 — Polish | 14–17 | ✅ Done | Bug fix, Venice AI skill gen, memory UI, demo video |
| 5 — Buffer | 18–20 | ⬜ | Submission |
```

- [ ] **Step 3: Commit**
```
git add docs/produk-demo-skenario.md CLAUDE.md
git commit -m "docs(phase-4): update demo script + mark phases 3-4 done"
```

---

## Checklist Phase 4 Done

- [ ] Reset clears localStorage (no stale memory after reset)
- [ ] Simulated relay labeled `[simulated]` in activity log
- [ ] Memory entries show timestamp + ✓/✕ + lesson
- [ ] Venice AI tested with real key — strategy generation works
- [ ] Skills panel shows Venice-generated JSON after execute
- [ ] Demo script updated in `docs/produk-demo-skenario.md`
- [ ] CLAUDE.md phases updated

---

## After Phase 4 → Phase 5 (Buffer / Submission)

- Record demo video following Scene 1–8 script
- Write hackathon submission text (4 prize tracks)
- Push final branch, open PR to main
- Submit to hackathon portal before 15 Juni 2026

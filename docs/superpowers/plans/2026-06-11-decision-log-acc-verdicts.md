# Decision Log + ACC Verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each council specialist's compressed (ACC) verdict and persist a dedicated, calibration-ready decision log for the autonomous monitor loop, surfaced in a read-only UI panel.

**Architecture:** A new pure `decisionLog.js` store (localStorage, append-only, capped, never-throws) mirrors the existing `cycleJournal.js`. The never-stop `monitorLoop.js` gains one injected `recordDecision` dep, called on keep+discard only (where the council actually deliberated). `council.js` synthesis is untouched — its result already carries `specialists[]`; today that's dropped at journal time, now it's captured. A `DecisionLogPanel` mirrors `LoopStatusPanel`.

**Tech Stack:** Vanilla ES modules, React 18 (CDN/Babel), Vitest, localStorage.

**Conventions:**
- Tests run from `frontend/`: `npx vitest run src/strategy/<file>.test.js`.
- Commit messages: conventional (`feat:`/`test:`), no step numbers in the text, no attribution footer (attribution disabled globally).
- `docs/superpowers/` is gitignored — never `git add` this plan or the spec.

**Spec:** `docs/superpowers/specs/2026-06-11-decision-log-acc-verdicts-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/strategy/decisionLog.js` | **new** — ACC summary, record builder, localStorage store, read API |
| `frontend/src/strategy/decisionLog.test.js` | **new** — unit tests for the above |
| `frontend/src/strategy/monitorLoop.js` | add `recordDecision` dep + 2 call sites |
| `frontend/src/strategy/monitorLoop.test.js` | add call/no-call assertions |
| `frontend/src/agents.jsx` | **new** `DecisionLogPanel` + export |
| `frontend/src/app.jsx` | import + inject `recordDecision`; render panel |
| `frontend/src/style.css` | `.decision-log` styles on existing tokens |

---

## Task 1: ACC summary helper

**Files:**
- Create: `frontend/src/strategy/decisionLog.js`
- Test: `frontend/src/strategy/decisionLog.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/decisionLog.test.js`:

```js
// frontend/src/strategy/decisionLog.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { accSummary } from './decisionLog.js'

describe('accSummary', () => {
  it('uses the first concern when present, with cited rules', () => {
    expect(accSummary({ signal: 'WITHDRAW', citedRules: ['risk-turbulent-veto'], concerns: ['turbulent market'] }))
      .toBe('WITHDRAW — turbulent market (risk-turbulent-veto)')
  })

  it('falls back to a positive phrase when no concerns', () => {
    expect(accSummary({ signal: 'DEPOSIT', citedRules: ['yield-uplift'], concerns: [] }))
      .toBe('DEPOSIT — clear to proceed (yield-uplift)')
  })

  it('omits the rules suffix when no cited rules', () => {
    expect(accSummary({ signal: 'HOLD', citedRules: [], concerns: [] }))
      .toBe('HOLD — hold')
  })

  it('tolerates missing arrays', () => {
    expect(accSummary({ signal: 'DEPOSIT' })).toBe('DEPOSIT — clear to proceed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: FAIL — `accSummary is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/strategy/decisionLog.js`:

```js
// frontend/src/strategy/decisionLog.js
// Decision log for the autonomous monitor loop — adapts EvoDS Step 7 ACC at the
// sub-agent level. Each council specialist's verdict is compressed to a single
// deterministic summary line (no per-cycle AI), and the full per-specialist set
// plus the council's authoritative decision is persisted for post-mortem and
// future calibration. Mirrors cycleJournal.js: pure localStorage, append-only,
// capped, never throws. Distinct from cycleJournal (operational trail) — this
// store only records cycles where the council actually deliberated.

const POSITIVE = { DEPOSIT: 'clear to proceed', HOLD: 'hold', WITHDRAW: 'exit' }

/** Compress one specialist verdict to a single human-readable line. Pure. */
export function accSummary({ signal, citedRules = [], concerns = [] } = {}) {
  const reason = concerns[0] ?? POSITIVE[signal] ?? ''
  const rules = citedRules.length ? ` (${citedRules.join(', ')})` : ''
  return `${signal} — ${reason}${rules}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/decisionLog.js frontend/src/strategy/decisionLog.test.js
git commit -m "feat: add deterministic ACC summary for council verdicts"
```

---

## Task 2: buildDecisionRecord

**Files:**
- Modify: `frontend/src/strategy/decisionLog.js`
- Test: `frontend/src/strategy/decisionLog.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/decisionLog.test.js`:

```js
import { buildDecisionRecord } from './decisionLog.js'

const verdict = (over = {}) => ({
  verdict: 'keep', reason: null, confidence: 0.69, resolvedBy: 'weighted',
  citedRules: ['yield-uplift', 'risk-calm-clear'],
  specialists: [
    { role: 'yield',  signal: 'DEPOSIT', confidence: 0.78, citedRules: ['yield-uplift'], concerns: [] },
    { role: 'risk',   signal: 'DEPOSIT', confidence: 0.6,  citedRules: ['risk-calm-clear'], concerns: [] },
    { role: 'market', signal: 'HOLD',    confidence: 0.7,  citedRules: ['market-gas-negative'], concerns: ['gas exceeds expected gain'] },
  ],
  ...over,
})

describe('buildDecisionRecord', () => {
  const ctx = () => ({
    cycle: 42,
    idea: { kind: 'rebalance', vaultName: 'Aave USDC', apyGain: 1.4 },
    state: { market: { turbulence: 'calm' } },
    verdict: verdict(),
  })

  it('maps council output to the EvoDS schema', () => {
    const r = buildDecisionRecord(ctx())
    expect(r).toMatchObject({
      cycle: 42,
      action: { kind: 'rebalance', vault: 'Aave USDC', apyGain: 1.4 },
      turbulence: 'calm',
      majoritySignal: 'DEPOSIT',
      majorityCount: 2,
      finalDecision: 'keep',
      resolvedBy: 'weighted',
      reason: null,
      citedRules: ['yield-uplift', 'risk-calm-clear'],
    })
  })

  it('computes a stable id from cycle + ts', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.id).toBe(`c42-${r.ts}`)
    expect(typeof r.ts).toBe('number')
  })

  it('attaches an ACC summary to every specialist verdict', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.verdicts).toHaveLength(3)
    expect(r.verdicts[2]).toEqual({
      role: 'market', signal: 'HOLD', confidence: 0.7,
      summary: 'HOLD — gas exceeds expected gain (market-gas-negative)',
    })
  })

  it('avgConfidence is the mean confidence of the majority-signal specialists', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.avgConfidence).toBeCloseTo(0.69, 3) // (0.78 + 0.6) / 2
  })

  it('records when the council vetoes against the majority (finalDecision != majoritySignal)', () => {
    const v = verdict({
      verdict: 'discard', reason: 'Risk Analyst', resolvedBy: 'veto', citedRules: ['risk-turbulent-veto'],
      specialists: [
        { role: 'yield',  signal: 'DEPOSIT',  confidence: 0.8, citedRules: ['yield-uplift'], concerns: [] },
        { role: 'risk',   signal: 'WITHDRAW', confidence: 0.9, citedRules: ['risk-turbulent-veto'], concerns: ['turbulent market'] },
        { role: 'market', signal: 'DEPOSIT',  confidence: 0.8, citedRules: ['market-gas-positive'], concerns: [] },
      ],
    })
    const r = buildDecisionRecord({ cycle: 7, idea: { kind: 'harvest' }, state: { market: { turbulence: 'turbulent' } }, verdict: v })
    expect(r.majoritySignal).toBe('DEPOSIT')
    expect(r.majorityCount).toBe(2)
    expect(r.finalDecision).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
  })

  it('applies defensive defaults on a missing idea', () => {
    const r = buildDecisionRecord({ cycle: 1, idea: undefined, state: {}, verdict: verdict() })
    expect(r.action).toEqual({ kind: 'unknown', vault: null, apyGain: null })
    expect(r.turbulence).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: FAIL — `buildDecisionRecord is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/decisionLog.js`:

```js
/** Most frequent signal among the specialists + how many voted it. */
function majority(specialists) {
  const counts = {}
  for (const s of specialists) counts[s.signal] = (counts[s.signal] || 0) + 1
  let signal = null, count = 0
  for (const [sig, n] of Object.entries(counts)) if (n > count) { signal = sig; count = n }
  return { signal, count }
}

/** Map a council result + cycle context into an EvoDS-schema decision record. Pure. */
export function buildDecisionRecord({ cycle, idea, state, verdict }) {
  const specialists = verdict?.specialists || []
  const { signal: majoritySignal, count: majorityCount } = majority(specialists)
  const majBucket = specialists.filter((s) => s.signal === majoritySignal)
  const avgConfidence = majBucket.length
    ? +(majBucket.reduce((a, s) => a + s.confidence, 0) / majBucket.length).toFixed(3)
    : 0
  const ts = Date.now()
  return {
    id: `c${cycle}-${ts}`,
    ts,
    cycle,
    action: {
      kind: idea?.kind || 'unknown',
      vault: idea?.vaultName ?? idea?.fromVault ?? null,
      apyGain: idea?.apyGain ?? null,
    },
    turbulence: state?.market?.turbulence || 'unknown',
    verdicts: specialists.map((s) => ({
      role: s.role,
      signal: s.signal,
      confidence: s.confidence,
      summary: accSummary(s),
    })),
    majoritySignal,
    majorityCount,
    avgConfidence,
    finalDecision: verdict?.verdict ?? null,
    resolvedBy: verdict?.resolvedBy ?? null,
    reason: verdict?.reason ?? null,
    citedRules: verdict?.citedRules || [],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/decisionLog.js frontend/src/strategy/decisionLog.test.js
git commit -m "feat: build EvoDS-schema decision record from council output"
```

---

## Task 3: localStorage store + read API

**Files:**
- Modify: `frontend/src/strategy/decisionLog.js`
- Test: `frontend/src/strategy/decisionLog.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/decisionLog.test.js`:

```js
import { recordDecision, getDecisions, clearDecisions, getDecisionSummary } from './decisionLog.js'

describe('decisionLog store', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  const ctxFor = (cycle, signal) => ({
    cycle, idea: { kind: 'rebalance', vaultName: 'V' }, state: { market: { turbulence: 'calm' } },
    verdict: {
      verdict: signal === 'DEPOSIT' ? 'keep' : 'discard', resolvedBy: 'unanimous', reason: null, citedRules: [],
      specialists: [
        { role: 'yield',  signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'risk',   signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'market', signal, confidence: 0.7, citedRules: [], concerns: [] },
      ],
    },
  })

  it('records a decision and reads it back newest-first', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    recordDecision(ctxFor(2, 'HOLD'))
    const rows = getDecisions()
    expect(rows).toHaveLength(2)
    expect(rows[0].cycle).toBe(2)
    expect(rows[0].finalDecision).toBe('discard')
    expect(rows[1].cycle).toBe(1)
  })

  it('caps at 100 rows, pruning oldest', () => {
    for (let i = 1; i <= 130; i++) recordDecision(ctxFor(i, 'DEPOSIT'))
    const rows = getDecisions()
    expect(rows).toHaveLength(100)
    expect(rows[0].cycle).toBe(130)
    expect(rows[99].cycle).toBe(31)
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_decision_log', 'not json')
    expect(getDecisions()).toEqual([])
    expect(() => recordDecision(ctxFor(1, 'DEPOSIT'))).not.toThrow()
  })

  it('clearDecisions empties the store', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    clearDecisions()
    expect(getDecisions()).toEqual([])
  })

  it('summary tallies signals per agent role', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    recordDecision(ctxFor(2, 'HOLD'))
    const s = getDecisionSummary()
    expect(s.total).toBe(2)
    expect(s.byAgent.yield).toMatchObject({ DEPOSIT: 1, HOLD: 1 })
    expect(s.byAgent.risk).toMatchObject({ DEPOSIT: 1, HOLD: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: FAIL — `recordDecision is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/decisionLog.js`:

```js
const KEY = 'yv_decision_log'
const MAX_ROWS = 100
const ROLES = ['yield', 'risk', 'market']

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(rows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
  } catch (err) {
    console.warn('[DecisionLog] write failed:', err.message)
  }
}

/** Build + persist a decision record. Never throws. */
export function recordDecision(ctx) {
  try {
    const rows = read()
    rows.push(buildDecisionRecord(ctx))
    write(rows)
  } catch (err) {
    console.warn('[DecisionLog] recordDecision failed:', err.message)
  }
}

/** @returns newest-first array of decision records. */
export function getDecisions() {
  return read().reverse()
}

export function clearDecisions() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

/** Per-agent signal tallies + total — seed for future calibration. */
export function getDecisionSummary() {
  const rows = read()
  const byAgent = {}
  for (const role of ROLES) byAgent[role] = { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 }
  for (const row of rows) {
    for (const v of row.verdicts || []) {
      if (byAgent[v.role] && v.signal in byAgent[v.role]) byAgent[v.role][v.signal] += 1
    }
  }
  return { total: rows.length, byAgent }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/strategy/decisionLog.test.js`
Expected: PASS (all decisionLog tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/decisionLog.js frontend/src/strategy/decisionLog.test.js
git commit -m "feat: persist decision log with per-agent summary read model"
```

---

## Task 4: Wire recordDecision into the monitor loop

**Files:**
- Modify: `frontend/src/strategy/monitorLoop.js`
- Test: `frontend/src/strategy/monitorLoop.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/monitorLoop.test.js` (the existing file already defines `makeDeps` / `calmState` at top — reuse them):

```js
describe('createMonitorLoop recordDecision', () => {
  it('records a decision on keep (council deliberated)', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).toHaveBeenCalledOnce()
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ cycle: 1, verdict: expect.objectContaining({ verdict: 'keep' }) }),
    )
  })

  it('records a decision on discard', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({
      recordDecision,
      council: vi.fn(async () => ({ verdict: 'discard', reason: 'Risk Analyst', confidence: 0.9, citedRules: [], specialists: [], resolvedBy: 'veto' })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).toHaveBeenCalledOnce()
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ verdict: 'discard' }) }),
    )
  })

  it('does NOT record on idle (no council ran)', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea(null)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('does NOT record on a gated cycle', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision, gates: () => ({ passed: false, blockedBy: 'gas', reason: 'gas too high' }) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('a throwing recordDecision never breaks the cycle', async () => {
    const recordDecision = vi.fn(() => { throw new Error('storage full') })
    const { saved, deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(saved[0]).toMatchObject({ verdict: 'keep' }) // journal still wrote → loop survived
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/strategy/monitorLoop.test.js`
Expected: FAIL — `recordDecision` not called (keep/discard assertions fail).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/strategy/monitorLoop.js`, add `recordDecision` to the destructured deps. Change the signature line (currently `frontend/src/strategy/monitorLoop.js:21`):

```js
export function createMonitorLoop({ getState, runGates, gates = () => ({ passed: true }), simulate, council, execute, reflect, journal, recordDecision = () => {}, heartbeatMs = 60_000, onPhase }) {
```

Add a safe wrapper near the existing `phase` helper (after line 28):

```js
  // Decision capture is observability — a throwing recorder must not kill a cycle.
  const record = (ctx) => { try { recordDecision(ctx) } catch { /* ignore */ } }
```

In the discard branch, add the record call before the journal write (currently `frontend/src/strategy/monitorLoop.js:60-62`):

```js
      if (v.verdict !== 'keep') {
        record({ cycle, idea, state, verdict: v })
        journal.saveCycle({ cycle, phase: 'evaluate', verdict: 'discard', score: projectedReward.riskAdjustedScore, confidence: v.confidence, reason: v.reason, citedRules: v.citedRules, turbulence: state.market.turbulence })
        return
      }
```

In the keep branch, add the record call right after entering the `try` (currently `frontend/src/strategy/monitorLoop.js:66-68`):

```js
      // keep → execute, then reflect on the real outcome (ACE).
      try {
        record({ cycle, idea, state, verdict: v })
        phase('execute')
        const txHash = await execute(idea, allocations)
```

(Placing the keep-branch `record` inside the existing `try` is fine — `record` is itself wrapped and never throws, so it cannot trigger the crash path.)

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/strategy/monitorLoop.test.js`
Expected: PASS — new suite passes AND all pre-existing monitorLoop tests still pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/monitorLoop.js frontend/src/strategy/monitorLoop.test.js
git commit -m "feat: capture council decisions from the monitor loop"
```

---

## Task 5: Inject recordDecision in app.jsx

**Files:**
- Modify: `frontend/src/app.jsx` (import line ~61; `createMonitorLoop({...})` deps ~469-506)

No unit test (app.jsx is the React wiring shell, covered manually). Verify by import resolution + a dev serve in Task 6.

- [ ] **Step 1: Add the import**

In `frontend/src/app.jsx`, alongside the existing cycleJournal import (`frontend/src/app.jsx:61`), add:

```js
import { recordDecision, getDecisions, getDecisionSummary } from './strategy/decisionLog.js';
```

- [ ] **Step 2: Inject into createMonitorLoop**

In the `createMonitorLoop({...})` deps object, add `recordDecision` next to the existing `journal` dep (after `frontend/src/app.jsx:503`):

```js
      journal: { saveCycle: (row) => { saveCycle(row); setLoopTick((t) => t + 1); } },
      recordDecision: (ctx) => { recordDecision(ctx); setLoopTick((t) => t + 1); },
```

(The extra `setLoopTick` bump guarantees the panel refreshes on the decision write even though the journal write also bumps — harmless and explicit.)

- [ ] **Step 3: Verify the app still boots**

Run (from repo root): `npx serve frontend/`
Open the served URL, confirm no console import/runtime errors on load.
Expected: app loads; no `decisionLog.js` module errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: wire decision log into the autonomous loop"
```

---

## Task 6: DecisionLogPanel UI

**Files:**
- Modify: `frontend/src/agents.jsx` (add component near `LoopStatusPanel` ~793; add to export block ~868)
- Modify: `frontend/src/app.jsx` (render panel near `loopPanel` ~1400; import the component ~15)
- Modify: `frontend/src/style.css` (append `.decision-log` styles)

No unit test (visual component; the suite is logic-only). Verified by dev serve.

- [ ] **Step 1: Add the panel component**

In `frontend/src/agents.jsx`, immediately before the `export {` block (~line 868), add. Note `useSAg`/`useEAg`/`React` are the same aliases `LoopStatusPanel` uses — reuse them; `agoLabel` is already defined in this file:

```jsx
const SIGNAL_CLASS = { DEPOSIT: 'keep', HOLD: 'gated', WITHDRAW: 'discard' };

const DecisionLogPanel = ({ rows, summary }) => {
  const [now, setNow] = useSAg(() => Date.now());
  const [open, setOpen] = useSAg(() => null);
  useEAg(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const byAgent = summary?.byAgent || {};
  return (
    <div className="decision-log">
      <div className="decision-agents">
        {['yield', 'risk', 'market'].map((role) => {
          const t = byAgent[role] || { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 };
          return (
            <div className="decision-agent" key={role}>
              <span className="decision-agent-role mono">{role}</span>
              <span className="decision-agent-tally mono">
                <span className="keep">{t.DEPOSIT}</span>·
                <span className="gated">{t.HOLD}</span>·
                <span className="discard">{t.WITHDRAW}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="decision-rows">
        {(rows || []).map((r) => (
          <div className={`decision-row ${open === r.id ? 'open' : ''}`} key={r.id}>
            <button className="decision-row-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="decision-row-num mono">#{String(r.cycle).padStart(2, '0')}</span>
              <span className={`decision-badge ${r.finalDecision === 'keep' ? 'keep' : 'discard'}`}>{r.finalDecision}</span>
              <span className="decision-row-maj mono">{r.majoritySignal} ×{r.majorityCount}</span>
              <span className="decision-row-conf tnum mono">{Math.round((r.avgConfidence || 0) * 100)}%</span>
              <span className="decision-row-by mono">{r.resolvedBy}</span>
              <span className="decision-row-time">{agoLabel(r.ts, now)}</span>
            </button>
            {open === r.id && (
              <div className="decision-verdicts">
                {(r.verdicts || []).map((v) => (
                  <div className={`decision-verdict ${SIGNAL_CLASS[v.signal] || ''}`} key={v.role}>
                    <span className="decision-verdict-role mono">{v.role}</span>
                    <span className="decision-verdict-conf tnum mono">{Math.round((v.confidence || 0) * 100)}%</span>
                    <span className="decision-verdict-summary">{v.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {(!rows || rows.length === 0) && (
          <div className="decision-empty">No council decisions yet. Each keep or discard verdict from the autonomous loop is logged here with all three specialist opinions.</div>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Export the component**

In the same `frontend/src/agents.jsx` export block (~line 868), add `DecisionLogPanel`:

```jsx
export {
  LoopStatusPanel,
  DecisionLogPanel,
  AgentGraph, AgentTiles, MemoryModal, StrategyCard, ExecuteCard,
  buildStrategy, makeInitialExecState, AGENT_PROTOCOLS, STEP_IDS, STEP_LABELS,
};
```

- [ ] **Step 3: Import + render in app.jsx**

In `frontend/src/app.jsx`, add `DecisionLogPanel` to the existing agents.jsx import group (the block around `frontend/src/app.jsx:15` that imports `LoopStatusPanel`):

```js
  StrategyCard, ExecuteCard, MemoryModal, LoopStatusPanel, DecisionLogPanel,
```

Then render it adjacent to the existing `loopPanel` prop usage (around `frontend/src/app.jsx:1400`). Pass the same gating condition `agentEnabled` used by `loopPanel`:

```jsx
                  decisionPanel={agentEnabled && (
                    <DecisionLogPanel rows={getDecisions().slice(0, 8)} summary={getDecisionSummary()} />
                  )}
```

If the receiving screen component does not yet accept a `decisionPanel` prop, render the panel directly under the existing `<LoopStatusPanel ... />` instead, inside the same parent container, so it appears in the same column. Use whichever insertion matches the current `loopPanel` wiring.

- [ ] **Step 4: Add styles**

Append to `frontend/src/style.css` (uses existing design tokens — match the variable names already used by `.loop-status`; if a referenced var is absent, substitute the nearest existing token):

```css
/* ── Decision log panel ─────────────────────────────────────────── */
.decision-log { display: flex; flex-direction: column; gap: 0.75rem; }

.decision-agents { display: flex; gap: 0.5rem; }
.decision-agent {
  flex: 1; display: flex; flex-direction: column; gap: 0.15rem;
  padding: 0.4rem 0.5rem; border: 1px solid var(--border, #2a2a32);
  border-radius: 0.5rem; background: var(--surface-2, #16161c);
}
.decision-agent-role { font-size: 0.7rem; text-transform: uppercase; opacity: 0.6; letter-spacing: 0.04em; }
.decision-agent-tally { font-size: 0.85rem; display: flex; gap: 0.25rem; align-items: baseline; }
.decision-agent-tally .keep { color: var(--ok, #4ade80); }
.decision-agent-tally .gated { color: var(--warn, #fbbf24); }
.decision-agent-tally .discard { color: var(--danger, #f87171); }

.decision-rows { display: flex; flex-direction: column; gap: 0.3rem; }
.decision-row { border: 1px solid var(--border, #2a2a32); border-radius: 0.5rem; overflow: hidden; }
.decision-row-head {
  width: 100%; display: grid;
  grid-template-columns: auto auto 1fr auto auto auto;
  gap: 0.5rem; align-items: center;
  padding: 0.4rem 0.6rem; background: none; border: none; cursor: pointer;
  color: inherit; text-align: left; font: inherit;
}
.decision-row-head:hover { background: var(--surface-2, #16161c); }
.decision-badge { font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 0.3rem; text-transform: uppercase; }
.decision-badge.keep { background: rgba(74, 222, 128, 0.15); color: var(--ok, #4ade80); }
.decision-badge.discard { background: rgba(248, 113, 113, 0.15); color: var(--danger, #f87171); }
.decision-row-by { font-size: 0.7rem; opacity: 0.55; }
.decision-row-time { font-size: 0.7rem; opacity: 0.55; }

.decision-verdicts {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding: 0.35rem 0.6rem 0.55rem; border-top: 1px solid var(--border, #2a2a32);
  background: var(--surface-2, #16161c);
}
.decision-verdict { display: grid; grid-template-columns: 4rem 3rem 1fr; gap: 0.5rem; align-items: baseline; font-size: 0.8rem; }
.decision-verdict-role { text-transform: uppercase; font-size: 0.7rem; opacity: 0.7; }
.decision-verdict.keep .decision-verdict-role { color: var(--ok, #4ade80); }
.decision-verdict.gated .decision-verdict-role { color: var(--warn, #fbbf24); }
.decision-verdict.discard .decision-verdict-role { color: var(--danger, #f87171); }
.decision-verdict-summary { opacity: 0.85; }

.decision-empty { font-size: 0.8rem; opacity: 0.6; padding: 0.6rem; }
```

- [ ] **Step 5: Verify in the browser**

Run (from repo root): `npx serve frontend/`
Enable the agent so the monitor loop runs (or in devtools console seed a row):

```js
// devtools console — seed one decision to render the panel without waiting for a heartbeat
JSON.parse(localStorage.getItem('yv_decision_log') || '[]'); // confirm key
```

Confirm: panel renders, agent tallies show, a decision row expands to three `role · conf · summary` lines, empty-state copy shows when the log is empty.
Expected: no console errors; layout matches the loop panel column.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/agents.jsx frontend/src/app.jsx frontend/src/style.css
git commit -m "feat: add decision log panel to the agent dashboard"
```

---

## Final verification

- [ ] Run the full strategy suite (from `frontend/`): `npx vitest run src/strategy/`
  Expected: all green, including pre-existing `council.test.js`, `councilReview.test.js`, `cycleJournal.test.js`, `monitorLoop.test.js`.
- [ ] Run `graphify update .` from repo root to refresh the knowledge graph (AST-only, no API cost).
- [ ] Confirm `council.js`, `cycleJournal.js`, `reflector.js` were never modified (scope guarantee): `git diff --name-only main...HEAD` should NOT list them.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** §4 module → Tasks 1–3; §5 ACC summary → Task 1; §6 wiring → Tasks 4–5; §7 UI → Task 6; §8 tests → embedded in Tasks 1–4; §9 files → File Structure table. All covered.
- **Placeholders:** none — every code step has full content; the one conditional (Task 6 Step 3 `decisionPanel` vs inline render) gives an explicit fallback, not a TODO.
- **Type consistency:** `recordDecision(ctx)` ctx shape `{cycle, idea, state, verdict}` identical across Tasks 3, 4, 5. Record fields (`finalDecision`, `majoritySignal`, `majorityCount`, `avgConfidence`, `resolvedBy`, `verdicts[].summary`) consistent between Task 2 builder, Task 3 store tests, and Task 6 panel. localStorage key `yv_decision_log` consistent.

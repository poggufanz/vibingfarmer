# Fast-Fail Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure-math fast-fail gate layer to the `/strategy` autonomous monitor loop that blocks hopeless cycles BEFORE any Venice AI call, so a bad market state sleeps the loop without spending AI credit.

**Architecture:** FinRL's Turbulence Index + hard environment constraints, ported to DeFi. Gates are pure functions `(state, idea) → { id, passed, reason }` composed by `evaluateGates` with fail-fast ordering. The monitor loop runs `evaluateGates` immediately after observing state and before `simulate`/`council` — a blocked gate journals a `gated` verdict and returns (loop sleeps). No AI, no network inside any gate.

**Tech Stack:** Vanilla ES modules (`frontend/src/strategy/`), Vitest, React 18 (UI surface in `agents.jsx` + `style.css`). No new dependencies.

---

## Background (read before starting)

The monitor loop pipeline today (`frontend/src/strategy/monitorLoop.js`):

```
observe → gate(enforceActionSpace) → simulate → council → execute → reflect → journal → sleep
```

- `council` (`frontend/src/strategy/council.js`) is mostly deterministic, BUT on a genuine 3-way split it escalates to **one injected AI call** (`resolveConflict` → Venice). That is the credit spend this plan protects.
- `enforceActionSpace` (`frontend/src/strategy/mdp.js`) already trims allocations to a risk ceiling and returns `violations`, but it does NOT short-circuit the loop — every cycle with an idea still reaches `simulate` + `council`.
- `state.market` comes from `deriveTurbulence` / `deriveSignals` in `mdp.js`: `{ turbulence: 'calm'|'elevated'|'turbulent', signals: string[] }`. `deriveSignals` adds a `'gas-spike'` signal when a high gas snapshot is supplied.
- The loop runs an idle `runCycle(null)` on each heartbeat; real work arrives via `loop.submitIdea(idea)`. An `idea` looks like `{ kind: 'harvest'|'rebalance', proposed, currentAllocations, apyGain, estGasUsdc, vaultAddress, ... }`.

**Fast-fail gates are the FIRST line of defense.** They run only when there is an `idea`, classify the idea as offensive (`deposit`/`rebalance`) or defensive (`harvest`/`withdraw`), and block offensive ideas when the environment is hostile — exactly FinRL's "turbulent ⇒ no buy, only sell" rule generalized to gas, capital, and a legal-universe check.

Exported symbols already available from `mdp.js`: `RISK_RANK`, `normalizeRisk`, `riskCeiling`, `deriveSignals`, `buildStrategyState`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/strategy/gates.js` | Pure fast-fail gate functions + `evaluateGates` composer | Create |
| `frontend/src/strategy/gates.test.js` | Unit tests for each gate + composer ordering | Create |
| `frontend/src/strategy/monitorLoop.js` | Inject + run `gates` before simulate/council | Modify |
| `frontend/src/strategy/monitorLoop.test.js` | Prove a gated idea skips simulate/council/execute | Modify |
| `frontend/src/strategy/mdp.js` | `buildStrategyState` accepts optional `gas` → `deriveSignals` | Modify |
| `frontend/src/strategy/mdp.test.js` | Cover gas-aware state build | Modify |
| `frontend/src/strategy/cycleJournal.js` | Count `gated` in `getJournalSummary` | Modify |
| `frontend/src/app.jsx` | Wire `evaluateGates` into the loop + feed live gas into state | Modify |
| `frontend/src/agents.jsx` | Surface `gated` verdict (chip, badge, row detail) | Modify |
| `frontend/style.css` | `.loop-chip.gated` + `.loop-badge.gated` styling | Modify |

---

## Task 1: Pure fast-fail gates module

**Files:**
- Create: `frontend/src/strategy/gates.js`
- Test: `frontend/src/strategy/gates.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/gates.test.js`:

```js
// frontend/src/strategy/gates.test.js
import { describe, it, expect } from 'vitest'
import {
  turbulenceGate, gasGate, capitalGate, universeGate, evaluateGates, OFFENSIVE_KINDS,
} from './gates.js'

// Minimal hand-built StrategyState — gates must not depend on buildStrategyState.
function makeState(over = {}) {
  return {
    capital: { amountUsdc: 1000, heldUsdc: 0 },
    profile: { riskLevel: 'high', numVaults: 3 },
    market: { turbulence: 'calm', signals: [] },
    universe: [
      { address: '0xA', riskTier: 'low' },
      { address: '0xB', riskTier: 'high' },
    ],
    ...over,
  }
}
const deposit = { kind: 'deposit', proposed: [] }
const rebalance = { kind: 'rebalance', proposed: [] }
const harvest = { kind: 'harvest' }

describe('turbulenceGate', () => {
  it('blocks an offensive idea in a turbulent market', () => {
    const r = turbulenceGate(makeState({ market: { turbulence: 'turbulent', signals: [] } }), deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('turbulence')
  })
  it('lets a defensive idea (harvest) through even when turbulent', () => {
    const r = turbulenceGate(makeState({ market: { turbulence: 'turbulent', signals: [] } }), harvest)
    expect(r.passed).toBe(true)
  })
  it('passes offensive ideas when calm', () => {
    expect(turbulenceGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('gasGate', () => {
  it('blocks an offensive idea when a gas-spike signal is present', () => {
    const r = gasGate(makeState({ market: { turbulence: 'calm', signals: ['gas-spike'] } }), rebalance)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('gas')
  })
  it('passes defensive ideas during a gas spike', () => {
    const r = gasGate(makeState({ market: { turbulence: 'calm', signals: ['gas-spike'] } }), harvest)
    expect(r.passed).toBe(true)
  })
  it('passes when no gas-spike signal', () => {
    expect(gasGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('capitalGate', () => {
  it('blocks an offensive idea with no deployable capital', () => {
    const r = capitalGate(makeState({ capital: { amountUsdc: 0, heldUsdc: 0 } }), deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('capital')
  })
  it('passes defensive ideas regardless of capital', () => {
    expect(capitalGate(makeState({ capital: { amountUsdc: 0, heldUsdc: 0 } }), harvest).passed).toBe(true)
  })
})

describe('universeGate', () => {
  it('blocks when no vault sits within the risk ceiling', () => {
    // turbulent ceiling = 'low'; universe has only a 'high' vault → no legal allocation
    const state = makeState({
      market: { turbulence: 'turbulent', signals: [] },
      universe: [{ address: '0xB', riskTier: 'high' }],
    })
    const r = universeGate(state, deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('universe')
  })
  it('passes when at least one vault is within ceiling', () => {
    expect(universeGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('evaluateGates', () => {
  it('passes a clean offensive idea in a calm market', () => {
    const r = evaluateGates(makeState(), deposit)
    expect(r.passed).toBe(true)
    expect(r.blockedBy).toBe(null)
    expect(r.results).toHaveLength(4)
  })
  it('fails fast on turbulence before reaching later gates', () => {
    const state = makeState({ market: { turbulence: 'turbulent', signals: ['gas-spike'] }, capital: { amountUsdc: 0, heldUsdc: 0 } })
    const r = evaluateGates(state, deposit)
    expect(r.passed).toBe(false)
    expect(r.blockedBy).toBe('turbulence') // first gate in order wins
    expect(typeof r.reason).toBe('string')
  })
  it('always passes a defensive idea (only-sell-allowed analog)', () => {
    const state = makeState({ market: { turbulence: 'turbulent', signals: ['gas-spike'] }, capital: { amountUsdc: 0, heldUsdc: 0 } })
    expect(evaluateGates(state, harvest).passed).toBe(true)
  })
  it('exposes the offensive kinds it guards', () => {
    expect(OFFENSIVE_KINDS).toEqual(['deposit', 'rebalance'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/gates.test.js"`
Expected: FAIL — `Failed to resolve import './gates.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/strategy/gates.js`:

```js
// frontend/src/strategy/gates.js
// Fast-fail gates — the FIRST line of defense for the /strategy monitor loop.
// Inspired by FinRL (AI4Finance): the Turbulence Index restricts the agent to
// defensive actions when the market is chaotic, and the trading environment hard-
// codes constraints that disable illegal actions outright. Here every gate is a
// PURE function (state, idea) -> { id, passed, reason } — no AI call, no network,
// no storage. When a gate blocks, the loop sleeps without spending Venice credit.
//
// Offensive ideas (deposit / rebalance) deploy capital and are what we guard.
// Defensive ideas (harvest / withdraw) reduce exposure and always pass — this is
// the DeFi analog of FinRL's "turbulent market => only sell allowed".

import { RISK_RANK, normalizeRisk, riskCeiling } from './mdp.js'

/** Action kinds that deploy capital — the only kinds gates can block. */
export const OFFENSIVE_KINDS = ['deposit', 'rebalance']

/** Below this much free USDC a deposit/rebalance is not worth a cycle. */
const MIN_DEPLOY_USDC = 1

const isOffensive = (idea) => OFFENSIVE_KINDS.includes(idea && idea.kind)

/** FinRL Turbulence Index: a turbulent regime blocks every offensive action. */
export function turbulenceGate(state, idea) {
  const turbulent = state && state.market && state.market.turbulence === 'turbulent'
  if (turbulent && isOffensive(idea)) {
    return { id: 'turbulence', passed: false, reason: `turbulent market — ${idea.kind} blocked, defensive actions only` }
  }
  return { id: 'turbulence', passed: true }
}

/** Network congestion = execution risk: a gas spike defers offensive actions. */
export function gasGate(state, idea) {
  const signals = (state && state.market && state.market.signals) || []
  if (signals.includes('gas-spike') && isOffensive(idea)) {
    return { id: 'gas', passed: false, reason: `gas spike — ${idea.kind} deferred until network calms` }
  }
  return { id: 'gas', passed: true }
}

/** Nothing to deploy → no point asking the council. */
export function capitalGate(state, idea) {
  const amount = Number((state && state.capital && state.capital.amountUsdc) || 0)
  if (isOffensive(idea) && amount < MIN_DEPLOY_USDC) {
    return { id: 'capital', passed: false, reason: 'no deployable capital' }
  }
  return { id: 'capital', passed: true }
}

/** Hard environment constraint: if no vault sits within the effective risk
 *  ceiling there is no legal allocation, so the council would only churn. */
export function universeGate(state, idea) {
  if (!isOffensive(idea)) return { id: 'universe', passed: true }
  const ceiling = RISK_RANK[riskCeiling(state)]
  const universe = (state && state.universe) || []
  const hasLegal = universe.some((v) => RISK_RANK[normalizeRisk(v.riskTier)] <= ceiling)
  if (!hasLegal) {
    return { id: 'universe', passed: false, reason: `no vault within ${riskCeiling(state)} ceiling` }
  }
  return { id: 'universe', passed: true }
}

// Ordering is the fail-fast priority: cheapest / most decisive first.
const GATES = [turbulenceGate, gasGate, capitalGate, universeGate]

/**
 * Run every gate and report the first blocker (if any). Pure.
 * @param {Object} state StrategyState (see mdp.buildStrategyState)
 * @param {Object} idea  { kind, ... }
 * @returns {{ passed:boolean, blockedBy:string|null, reason:string|null, results:Array }}
 */
export function evaluateGates(state, idea) {
  const results = GATES.map((g) => g(state, idea))
  const blocked = results.find((r) => !r.passed)
  if (blocked) return { passed: false, blockedBy: blocked.id, reason: blocked.reason, results }
  return { passed: true, blockedBy: null, reason: null, results }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/gates.test.js"`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/gates.js frontend/src/strategy/gates.test.js
git commit -m "feat: add pure fast-fail gates for the strategy monitor loop"
```

---

## Task 2: Run gates in the monitor loop before any AI call

**Files:**
- Modify: `frontend/src/strategy/monitorLoop.js`
- Test: `frontend/src/strategy/monitorLoop.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/monitorLoop.test.js`, inside the `describe('createMonitorLoop', ...)` block (before its closing `})`):

```js
  it('gated idea sleeps without simulate/council/execute (saves AI credit)', async () => {
    const { saved, deps } = makeDeps({
      gates: vi.fn(() => ({ passed: false, blockedBy: 'turbulence', reason: 'turbulent market — deposit blocked', results: [] })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'deposit', proposed: [], currentAllocations: [] })
    expect(deps.gates).toHaveBeenCalledOnce()
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(deps.council).not.toHaveBeenCalled()
    expect(deps.execute).not.toHaveBeenCalled()
    expect(saved[0]).toMatchObject({ cycle: 1, phase: 'gate', verdict: 'gated', gate: 'turbulence' })
  })

  it('passing gates proceed to council as before', async () => {
    const { saved, deps } = makeDeps({
      gates: vi.fn(() => ({ passed: true, blockedBy: null, reason: null, results: [] })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.council).toHaveBeenCalledOnce()
    expect(saved[0]).toMatchObject({ verdict: 'keep' })
  })

  it('defaults to pass-through gates when none injected', async () => {
    const { deps } = makeDeps()
    delete deps.gates
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.council).toHaveBeenCalledOnce()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/monitorLoop.test.js"`
Expected: FAIL — the gated test reaches `council`/`simulate` because no gate short-circuit exists yet.

- [ ] **Step 3: Update the loop signature + JSDoc**

In `frontend/src/strategy/monitorLoop.js`, add the `gates` dependency to the JSDoc block (after the `deps.runGates` line, around line 11):

```js
 * @param {(state:Object, idea:Object) => {passed:boolean, blockedBy:string|null, reason:string|null}} [deps.gates]  // pure fast-fail gates — FIRST defense, no AI/network
```

Change the destructuring signature (line 20) from:

```js
export function createMonitorLoop({ getState, runGates, simulate, council, execute, reflect, journal, heartbeatMs = 60_000, onPhase }) {
```

to:

```js
export function createMonitorLoop({ getState, runGates, gates = () => ({ passed: true }), simulate, council, execute, reflect, journal, heartbeatMs = 60_000, onPhase }) {
```

- [ ] **Step 4: Insert the fast-fail block and remove the redundant gate phase**

In `runCycle`, replace this region (current lines 35–43):

```js
      if (!idea) {
        journal.saveCycle({ cycle, phase: 'observe', verdict: 'idle', turbulence: state.market.turbulence })
        return
      }

      phase('gate')
      const { allocations, violations } = runGates(idea.proposed, state)
      phase('simulate')
```

with:

```js
      if (!idea) {
        journal.saveCycle({ cycle, phase: 'observe', verdict: 'idle', turbulence: state.market.turbulence })
        return
      }

      // FIRST line of defense — pure math, no AI, no network. A blocked gate
      // sleeps the loop here, before simulate/council, so no Venice credit burns.
      phase('gate')
      const gate = gates(state, idea)
      if (!gate.passed) {
        journal.saveCycle({ cycle, phase: 'gate', verdict: 'gated', gate: gate.blockedBy, reason: gate.reason, turbulence: state.market.turbulence })
        return
      }

      const { allocations, violations } = runGates(idea.proposed, state)
      phase('simulate')
```

(Note: the old standalone `phase('gate')` that preceded `runGates` is now the gate-evaluation phase; `runGates`/`enforceActionSpace` runs immediately after a pass, still visually under `gate`. `LOOP_PHASES` in `agents.jsx` is unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/monitorLoop.test.js"`
Expected: PASS — all monitorLoop tests green, including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/strategy/monitorLoop.js frontend/src/strategy/monitorLoop.test.js
git commit -m "feat: run fast-fail gates before council in the monitor loop"
```

---

## Task 3: Wire `evaluateGates` into the live loop

**Files:**
- Modify: `frontend/src/app.jsx:54` (import), `frontend/src/app.jsx:461-496` (loop config)

- [ ] **Step 1: Add the import**

In `frontend/src/app.jsx`, change line 54 from:

```js
import { buildStrategyState, enforceActionSpace, scoreReward } from './strategy/mdp.js';
```

to:

```js
import { buildStrategyState, enforceActionSpace, scoreReward } from './strategy/mdp.js';
import { evaluateGates } from './strategy/gates.js';
```

- [ ] **Step 2: Inject the `gates` dependency**

In the `createMonitorLoop({ ... })` config, add the `gates` field directly after the `runGates` line (currently line 470):

```js
      runGates: (proposed, state) => enforceActionSpace(proposed, state),
      gates: (state, idea) => evaluateGates(state, idea),
```

- [ ] **Step 3: Verify the bundle builds (no test for the wiring itself)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vite build"`
Expected: build succeeds with no unresolved-import errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: wire fast-fail gates into the strategy monitor loop"
```

---

## Task 4: Feed live gas into loop state so `gasGate` has teeth

`gasGate` reads `state.market.signals` for `'gas-spike'`, but the loop's `getState`
calls `buildStrategyState` with `deriveTurbulence` (no gas). This task makes
`buildStrategyState` gas-aware and pipes the gas snapshot the wizard already
fetches into the loop. Gas stays optional — when absent, behavior is unchanged.

**Files:**
- Modify: `frontend/src/strategy/mdp.js:85-97` (`buildStrategyState`)
- Test: `frontend/src/strategy/mdp.test.js`
- Modify: `frontend/src/app.jsx` (gas ref + getState)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/mdp.test.js` a new block (import `buildStrategyState` and `VAULT_CATALOG` are already used in that file — reuse the existing imports; if `buildStrategyState` is not yet imported there, add it to the existing `import ... from './mdp.js'` line):

```js
describe('buildStrategyState gas awareness', () => {
  it('adds a gas-spike signal when a high gas snapshot is supplied', () => {
    const state = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'high', numVaults: 2,
      vaultData: [], marketContext: 'markets calm', positions: {},
      gas: { level: 'high', gwei: 120 },
    })
    expect(state.market.signals).toContain('gas-spike')
  })
  it('omits gas-spike when no gas snapshot is supplied', () => {
    const state = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'high', numVaults: 2,
      vaultData: [], marketContext: 'markets calm', positions: {},
    })
    expect(state.market.signals).not.toContain('gas-spike')
  })
})
```

If `mdp.test.js` does not already import `buildStrategyState`, change its import line to include it, e.g.:

```js
import { riskCeiling, enforceActionSpace, ACTION_SPACE, buildStrategyState } from './mdp.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/mdp.test.js"`
Expected: FAIL — `gas-spike` not present because `buildStrategyState` ignores `gas`.

- [ ] **Step 3: Make `buildStrategyState` gas-aware**

In `frontend/src/strategy/mdp.js`, ensure `deriveSignals` is reachable (it is defined in the same file). Update the `buildStrategyState` signature and `market` field.

Change the JSDoc `@param` list to add (after the `positions` line, around line 84):

```js
 * @param {{ level:'normal'|'elevated'|'high', gwei:number }|null} [p.gas]  // optional live gas snapshot
```

Change the destructuring (line 85) from:

```js
export function buildStrategyState({ amountUsdc, riskLevel, numVaults, vaultData, marketContext, positions = {} }) {
```

to:

```js
export function buildStrategyState({ amountUsdc, riskLevel, numVaults, vaultData, marketContext, positions = {}, gas = null }) {
```

Change the `market` line (currently line 93) from:

```js
    market: deriveTurbulence(marketContext),
```

to:

```js
    market: deriveSignals(marketContext, gas),
```

(`deriveSignals` already falls back to `deriveTurbulence` behavior when `gas` is null, so the no-gas path is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/mdp.test.js"`
Expected: PASS.

- [ ] **Step 5: Capture the latest gas snapshot in app.jsx**

In `frontend/src/app.jsx`, add a ref next to the other refs (after line 213, `const loopRef = useR(null);`):

```js
  const latestGasRef = useR(null); // last live gas snapshot { level, gwei } for the monitor loop
```

Populate it where gas is already logged. Change the block at lines 591–593 from:

```js
        if (veniceResult.mdpState?.gasLevel) {
          addLog({ event: "OrchestratorPlanned", meta: `parallel fetch · gas ${veniceResult.mdpState.gasGwei} gwei (${veniceResult.mdpState.gasLevel})` });
        }
```

to:

```js
        if (veniceResult.mdpState?.gasLevel) {
          latestGasRef.current = { level: veniceResult.mdpState.gasLevel, gwei: veniceResult.mdpState.gasGwei };
          addLog({ event: "OrchestratorPlanned", meta: `parallel fetch · gas ${veniceResult.mdpState.gasGwei} gwei (${veniceResult.mdpState.gasLevel})` });
        }
```

- [ ] **Step 6: Pass the gas snapshot into `getState`**

In the `createMonitorLoop` config, change the `getState` (lines 462–469) to include `gas`:

```js
      getState: async () => buildStrategyState({
        amountUsdc: Number(amount) || 0,
        riskLevel: risk,
        numVaults: strategy.agents.length,
        vaultData: VAULT_CATALOG,
        marketContext: marketLive,
        positions: agentData.positions,
        gas: latestGasRef.current,
      }),
```

- [ ] **Step 7: Verify the build**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vite build"`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/strategy/mdp.js frontend/src/strategy/mdp.test.js frontend/src/app.jsx
git commit -m "feat: feed live gas into strategy loop state so the gas gate engages"
```

---

## Task 5: Surface the `gated` verdict in the loop UI

**Files:**
- Modify: `frontend/src/strategy/cycleJournal.js:48-58` (`getJournalSummary`)
- Test: `frontend/src/strategy/cycleJournal.test.js`
- Modify: `frontend/src/agents.jsx:635-641` (`loopRowDetail`), `:689-694` (chips), `:700` (badge label)
- Modify: `frontend/style.css:3286-3289`, `:3316-3319`

- [ ] **Step 1: Write the failing test for the journal summary**

Append to `frontend/src/strategy/cycleJournal.test.js` (match the existing harness — it already mocks `localStorage`; reuse the existing imports and add `getJournalSummary` if not imported):

```js
describe('getJournalSummary gated count', () => {
  it('counts gated cycles', () => {
    clearCycles()
    saveCycle({ cycle: 1, verdict: 'gated', gate: 'turbulence' })
    saveCycle({ cycle: 2, verdict: 'keep' })
    saveCycle({ cycle: 3, verdict: 'gated', gate: 'gas' })
    const s = getJournalSummary()
    expect(s.gated).toBe(2)
    expect(s.keep).toBe(1)
  })
})
```

If `cycleJournal.test.js` does not import `getJournalSummary` / `clearCycles` / `saveCycle`, add them to its existing `import ... from './cycleJournal.js'` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/cycleJournal.test.js"`
Expected: FAIL — `s.gated` is `undefined`.

- [ ] **Step 3: Add `gated` to the journal summary**

In `frontend/src/strategy/cycleJournal.js`, update `getJournalSummary` (lines 48–58) to include `gated`:

```js
export function getJournalSummary() {
  const rows = read()
  const count = (v) => rows.filter((r) => r.verdict === v).length
  return {
    total: rows.length,
    keep: count('keep'),
    discard: count('discard'),
    gated: count('gated'),
    crash: count('crash'),
    idle: count('idle'),
    lastCycle: rows.length ? rows[rows.length - 1].cycle : 0,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/cycleJournal.test.js"`
Expected: PASS.

- [ ] **Step 5: Render the gated verdict in `agents.jsx`**

In `frontend/src/agents.jsx`, update `loopRowDetail` (lines 635–641) to handle the `gated` verdict — change:

```js
const loopRowDetail = (r) => {
  const rules = (r.citedRules || []).join(', ');
  if (r.verdict === 'crash') return r.error || 'crashed · loop recovered';
  if (r.verdict === 'discard') return `${r.reason || 'council declined'}${rules ? ` · ${rules}` : ''}`;
  if (r.verdict === 'keep') return `score ${r.score ?? '—'} · ${rules || '—'} · tx ${(r.txHash || '').slice(0, 10)}…`;
  return `observed market · ${r.turbulence || 'calm'} · no action needed`;
};
```

to:

```js
const loopRowDetail = (r) => {
  const rules = (r.citedRules || []).join(', ');
  if (r.verdict === 'crash') return r.error || 'crashed · loop recovered';
  if (r.verdict === 'gated') return `${r.gate || 'gate'} gate · ${r.reason || 'blocked before council'} · no AI credit spent`;
  if (r.verdict === 'discard') return `${r.reason || 'council declined'}${rules ? ` · ${rules}` : ''}`;
  if (r.verdict === 'keep') return `score ${r.score ?? '—'} · ${rules || '—'} · tx ${(r.txHash || '').slice(0, 10)}…`;
  return `observed market · ${r.turbulence || 'calm'} · no action needed`;
};
```

- [ ] **Step 6: Add the gated chip**

In `LoopStatusPanel`, update the `loop-chips` block (lines 689–694) — change:

```jsx
      <div className="loop-chips">
        <span className="loop-chip keep">keep {summary.keep}</span>
        <span className="loop-chip discard">discard {summary.discard}</span>
        <span className="loop-chip crash">crash {summary.crash}</span>
        <span className="loop-chip idle">observe {summary.idle}</span>
      </div>
```

to:

```jsx
      <div className="loop-chips">
        <span className="loop-chip keep">keep {summary.keep}</span>
        <span className="loop-chip discard">discard {summary.discard}</span>
        <span className="loop-chip gated">gated {summary.gated || 0}</span>
        <span className="loop-chip crash">crash {summary.crash}</span>
        <span className="loop-chip idle">observe {summary.idle}</span>
      </div>
```

(The badge label at line 700 needs no change — `r.verdict === 'idle' ? 'observe' : r.verdict` already renders `gated` verbatim.)

- [ ] **Step 7: Add the gated styling**

In `frontend/style.css`, after the `.loop-chip.idle` rule (line 3289) add:

```css
.loop-chip.gated   { color: var(--warn, #d6a338); border-color: color-mix(in srgb, var(--warn, #d6a338) 35%, transparent); }
```

And after the `.loop-badge.idle` rule (line 3319) add:

```css
.loop-badge.gated  { background: color-mix(in srgb, var(--warn, #d6a338) 14%, transparent); color: var(--warn, #d6a338); }
```

(If a `--warn` token already exists in `style.css`, the fallback is harmless; if not, the `#d6a338` fallback applies.)

- [ ] **Step 8: Verify the build**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vite build"`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/strategy/cycleJournal.js frontend/src/strategy/cycleJournal.test.js frontend/src/agents.jsx frontend/style.css
git commit -m "feat: surface gated verdict in the monitor-loop journal UI"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full strategy test suite**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run src/strategy/"`
Expected: PASS — gates, monitorLoop, mdp, cycleJournal suites all green, no regressions.

- [ ] **Step 2: Run the complete test suite**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vitest run"`
Expected: PASS — full suite green.

- [ ] **Step 3: Production build**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer/frontend && npx vite build"`
Expected: build succeeds.

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`
Expected: graph updated (AST-only, no API cost).

- [ ] **Step 5: Manual smoke (optional, if dev server is running)**

Start the loop with the agent enabled, then submit a deposit idea while `marketContext` contains a turbulent keyword (e.g. "exploit"/"depeg"). Confirm a `gated` row appears in the loop journal with `turbulence gate · ... · no AI credit spent`, the `gated` chip increments, and no Venice/AI network call fires for that cycle.

---

## Self-Review

**Spec coverage:**
- "Gates as pure functions: input → boolean" → `gates.js`, each gate returns `{ id, passed, reason }`; `evaluateGates` composes them (Task 1). ✅
- "FIRST line of defense, before AI call" → loop runs `gates(state, idea)` immediately after `getState`, before `simulate`/`council` (Task 2). ✅
- "All pure math — no AI call, no network request" → gates import only `RISK_RANK`/`normalizeRisk`/`riskCeiling` from `mdp.js`; they read `state` fields only. Gas is fetched OUTSIDE the gate and passed in as data (Task 4). ✅
- "If a gate fails, loop sleeps without spending Venice credit" → blocked gate journals `gated` and `return`s before `council`; test asserts `council`/`simulate`/`execute` not called (Task 2). ✅
- "Turbulence Index: market chaos ⇒ only sell" → `turbulenceGate` blocks offensive kinds, defensive (harvest/withdraw) always pass (Task 1). ✅
- "Easy to test, easy to debug" → every gate independently unit-tested; `evaluateGates.blockedBy`/`reason` are debuggable strings; UI surfaces the gate id + reason (Tasks 1, 5). ✅
- "Stick to /strategy as the axis, other files allowed" → core lives in `frontend/src/strategy/`; touches to `app.jsx`/`agents.jsx`/`style.css` are wiring + surfacing only. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases" placeholders; every code step shows complete code. ✅

**Type consistency:** `evaluateGates` returns `{ passed, blockedBy, reason, results }` everywhere; the loop reads `gate.passed`, `gate.blockedBy`, `gate.reason`; the journal stores `gate`/`reason`; the UI reads `r.gate`/`r.reason`. `OFFENSIVE_KINDS = ['deposit', 'rebalance']` is consistent across the module and tests. `gas` snapshot shape `{ level, gwei }` matches `deriveSignals`/`fetchGasSnapshot`. ✅

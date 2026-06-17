# Strategy State/Action/Reward Formalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/strategy` wizard a formal Markov Decision Process vocabulary — State (what the strategist observes), Action (what it may do, with enforced bounds), Reward (how a strategy is scored) — instead of the current informal "fetch data → ask AI → render" flow.

**Architecture:** Add one pure, framework-free module `frontend/src/strategy/mdp.js` as the formal poros. `generateStrategy` (venice.js) builds a `StrategyState`, the AI proposes allocations, `enforceActionSpace` clamps them to the risk ceiling (profile risk ∧ market-turbulence gate, a FinRL turbulence-index analog) and re-normalizes weights to sum 1.0, then `scoreReward` projects a risk-adjusted reward. The reward + a compact state summary ride along the strategy object into `StrategyCard`, which renders a State · Action · Reward panel. `realizedReward` closes the RL loop from agent memory post-execution. All logic is unit-tested with Vitest.

**Tech Stack:** Vanilla ES modules, React 18 (Babel/JSX via Vite), Vitest. No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/strategy/mdp.js` | **NEW.** Formal MDP: `buildStrategyState`, `deriveTurbulence`, `riskCeiling`, `enforceActionSpace`, `scoreReward`, `realizedReward`, constants. Pure functions, no React, no I/O. |
| `frontend/src/strategy/mdp.test.js` | **NEW.** Vitest unit tests for every exported function. |
| `frontend/src/venice.js` | **MODIFY.** After validating the AI response: build state, enforce action space, attach `reward` + `mdpState` to the returned strategy. |
| `frontend/src/app.jsx` | **MODIFY.** `mapVeniceToStrategy` passes `reward` + `mdpState` through to the strategy object. |
| `frontend/src/agents.jsx` | **MODIFY.** `buildStrategy` fallback attaches a locally-computed reward; `StrategyCard` renders the S·A·R panel. |
| `frontend/src/skills/default/vault-advisor.md` | **MODIFY.** Reframe the system prompt in explicit State/Action/Reward language. |

**Design rule:** `mdp.js` is the single source of truth for the MDP. Neither venice.js, app.jsx, nor agents.jsx re-implement risk ranking, turbulence, normalization, or reward math — they import from `mdp.js`. DRY.

---

### Task 1: Create the MDP module — State observation

**Files:**
- Create: `frontend/src/strategy/mdp.js`
- Test: `frontend/src/strategy/mdp.test.js`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/strategy/mdp.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { normalizeRisk, deriveTurbulence, buildStrategyState, RISK_RANK } from './mdp.js'

describe('normalizeRisk', () => {
  it('maps the app-internal "med" to "medium"', () => {
    expect(normalizeRisk('med')).toBe('medium')
  })
  it('lowercases and passes through canonical tiers', () => {
    expect(normalizeRisk('HIGH')).toBe('high')
    expect(normalizeRisk('low')).toBe('low')
  })
  it('defaults unknown values to "medium"', () => {
    expect(normalizeRisk(undefined)).toBe('medium')
    expect(normalizeRisk('weird')).toBe('medium')
  })
})

describe('deriveTurbulence (FinRL turbulence-index analog)', () => {
  it('returns calm for empty/benign context', () => {
    expect(deriveTurbulence(null).turbulence).toBe('calm')
    expect(deriveTurbulence('yields stable and healthy').turbulence).toBe('calm')
  })
  it('flags turbulent on exploit/hack/depeg keywords', () => {
    const r = deriveTurbulence('A major exploit drained the pool today')
    expect(r.turbulence).toBe('turbulent')
    expect(r.signals).toContain('exploit')
  })
  it('flags elevated on volatility/caution keywords', () => {
    expect(deriveTurbulence('markets are volatile, yields compressing').turbulence).toBe('elevated')
  })
})

describe('buildStrategyState', () => {
  const vaultData = [
    { address: '0xAAA', protocol: 'aave-v3', apy: 4.8, risk: 'low', yield_source: 'lending', drawdown: '-1.2', min_capital: 100 },
    { address: '0xBBB', protocol: 'pendle-v2', apy: 9.4, risk: 'high', yield_source: 'structured', drawdown: '-6.5', min_capital: 1000 },
  ]
  it('captures capital, profile, universe, and market regime', () => {
    const s = buildStrategyState({ amountUsdc: 5000, riskLevel: 'med', numVaults: 2, vaultData, marketContext: 'volatile markets' })
    expect(s.capital.amountUsdc).toBe(5000)
    expect(s.profile.riskLevel).toBe('medium')
    expect(s.universe).toHaveLength(2)
    expect(s.universe[0].riskTier).toBe('low')
    expect(s.market.turbulence).toBe('elevated')
  })
  it('derives heldUsdc from 6-decimal position balances', () => {
    const s = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'low', numVaults: 1, vaultData, marketContext: null,
      positions: { '0xAAA': { balance: '2500000' } }, // 2.5 USDC
    })
    expect(s.capital.heldUsdc).toBeCloseTo(2.5, 5)
    expect(s.portfolio.heldVaultCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: FAIL — "Failed to resolve import './mdp.js'".

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/strategy/mdp.js`:

```js
// Formal Markov Decision Process model for the /strategy wizard.
// Inspired by FinRL (AI4Finance Foundation): every strategy decision is framed as
// State (what the strategist observes) -> Action (what it may do, bounded) ->
// Reward (how the strategy is scored). This module is the single source of truth
// for that vocabulary. Pure functions only — no React, no network, no storage.

import { VAULT_CATALOG } from '../config.js'

/** Risk ordering used by the action-space ceiling. Lower = safer. */
export const RISK_RANK = { low: 0, medium: 1, high: 2 }

/** Normalize the app's internal 'med' and any casing to canonical low|medium|high. */
export function normalizeRisk(risk) {
  const r = String(risk || '').toLowerCase()
  if (r === 'med') return 'medium'
  if (r === 'low' || r === 'medium' || r === 'high') return r
  return 'medium'
}

const TURBULENT_KEYWORDS = ['exploit', 'hack', 'depeg', 'collapse', 'insolven', 'drain', 'attack']
const ELEVATED_KEYWORDS = ['volatil', 'uncertain', 'compress', 'caution', 'outflow', 'liquidat', 'downturn']

/**
 * FinRL turbulence-index analog: classify the market regime from the live
 * market-context string. Deterministic keyword scan — no AI call.
 * @param {string|null} marketContext
 * @returns {{ turbulence:'calm'|'elevated'|'turbulent', signals:string[] }}
 */
export function deriveTurbulence(marketContext) {
  const text = String(marketContext || '').toLowerCase()
  if (!text) return { turbulence: 'calm', signals: [] }
  const hit = (kws) => kws.filter((k) => text.includes(k))
  const turbulent = hit(TURBULENT_KEYWORDS)
  if (turbulent.length) return { turbulence: 'turbulent', signals: turbulent }
  const elevated = hit(ELEVATED_KEYWORDS)
  if (elevated.length) return { turbulence: 'elevated', signals: elevated }
  return { turbulence: 'calm', signals: [] }
}

/** Map a raw catalog/DeFiLlama vault into a normalized observation vector. */
function toObservation(v) {
  return {
    address: v.address,
    protocol: v.protocol,
    apy: Number(v.apy) || 0,
    riskTier: normalizeRisk(v.risk || v.risk_tier),
    yieldSource: v.yield_source || v.yield_source_type || 'unknown',
    drawdown: Number(v.drawdown) || 0,
    minCapital: Number(v.min_capital) || 0,
    tvl: v.tvl != null ? Number(v.tvl) : null,
  }
}

/**
 * Build the formal observation the strategist reasons over (the State).
 * @param {Object} p
 * @param {number} p.amountUsdc
 * @param {string} p.riskLevel       // 'low' | 'med' | 'medium' | 'high'
 * @param {number} p.numVaults
 * @param {Array}  p.vaultData        // live DeFiLlama vaults or VAULT_CATALOG
 * @param {string|null} p.marketContext
 * @param {Object} [p.positions]      // { addr: { balance } } 6-decimal USDC strings
 * @returns {Object} StrategyState
 */
export function buildStrategyState({ amountUsdc, riskLevel, numVaults, vaultData, marketContext, positions = {} }) {
  const universe = (vaultData && vaultData.length ? vaultData : VAULT_CATALOG).map(toObservation)
  const holdings = positions || {}
  const heldUnits = Object.values(holdings).reduce((s, p) => s + Number(p && p.balance || 0), 0)
  return {
    capital: { amountUsdc: Number(amountUsdc) || 0, heldUsdc: heldUnits / 1e6 },
    profile: { riskLevel: normalizeRisk(riskLevel), numVaults: Number(numVaults) || 1 },
    portfolio: { holdings, heldVaultCount: Object.keys(holdings).length },
    market: deriveTurbulence(marketContext),
    universe,
    observedAt: Date.now(),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: PASS — all `normalizeRisk`, `deriveTurbulence`, `buildStrategyState` cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/mdp.js frontend/src/strategy/mdp.test.js
git commit -m "feat: add formal StrategyState observation model"
```

---

### Task 2: Action space — risk ceiling + constraint enforcement

**Files:**
- Modify: `frontend/src/strategy/mdp.js`
- Test: `frontend/src/strategy/mdp.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/mdp.test.js`:

```js
import { riskCeiling, enforceActionSpace, ACTION_SPACE } from './mdp.js'

const UNIVERSE = [
  { address: '0xAAA', protocol: 'aave-v3', apy: 4.8, risk: 'low', drawdown: '-1.2', min_capital: 100 },
  { address: '0xBBB', protocol: 'morpho-blue', apy: 6.1, risk: 'medium', drawdown: '-2.8', min_capital: 500 },
  { address: '0xCCC', protocol: 'pendle-v2', apy: 9.4, risk: 'high', drawdown: '-6.5', min_capital: 1000 },
]
const stateWith = (riskLevel, marketContext) =>
  buildStrategyState({ amountUsdc: 5000, riskLevel, numVaults: 3, vaultData: UNIVERSE, marketContext })

describe('riskCeiling', () => {
  it('is the profile risk when the market is calm', () => {
    expect(riskCeiling(stateWith('high', null))).toBe('high')
    expect(riskCeiling(stateWith('low', null))).toBe('low')
  })
  it('a turbulent market forces the ceiling down to low', () => {
    expect(riskCeiling(stateWith('high', 'exploit drained the pool'))).toBe('low')
  })
  it('an elevated market caps a high-risk profile at medium', () => {
    expect(riskCeiling(stateWith('high', 'volatile, yields compressing'))).toBe('medium')
  })
})

describe('enforceActionSpace', () => {
  it('drops vaults above the ceiling and re-normalizes weights to 1.0', () => {
    const state = stateWith('medium', null) // ceiling = medium
    const proposed = [
      { address: '0xAAA', allocation: 0.5, risk_tier: 'low' },
      { address: '0xCCC', allocation: 0.5, risk_tier: 'high' }, // gated out
    ]
    const { allocations, violations } = enforceActionSpace(proposed, state)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].address).toBe('0xAAA')
    expect(allocations[0].allocation).toBe(1)
    expect(violations.some((v) => v.includes('pendle-v2'))).toBe(true)
  })
  it('normalizes a valid set whose weights do not sum to 1.0', () => {
    const state = stateWith('high', null)
    const proposed = [
      { address: '0xAAA', allocation: 0.2 },
      { address: '0xBBB', allocation: 0.2 },
    ]
    const { allocations } = enforceActionSpace(proposed, state)
    const sum = allocations.reduce((s, a) => s + a.allocation, 0)
    expect(sum).toBeCloseTo(1.0, 4)
  })
  it('falls back to the safest vault when everything is gated', () => {
    const state = stateWith('low', 'exploit everywhere') // ceiling = low
    const proposed = [{ address: '0xCCC', allocation: 1, risk_tier: 'high' }]
    const { allocations, violations } = enforceActionSpace(proposed, state)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].address).toBe('0xAAA') // lowest-risk in universe
    expect(violations.some((v) => v.includes('fell back'))).toBe(true)
  })
  it('exposes a static ACTION_SPACE description for the UI', () => {
    expect(ACTION_SPACE.allocate.constraint).toMatch(/sum to 1\.0/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: FAIL — `riskCeiling`, `enforceActionSpace`, `ACTION_SPACE` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/mdp.js`:

```js
/** Static description of what a strategy action may contain. Surfaced in the UI. */
export const ACTION_SPACE = {
  allocate: { type: 'continuous', perVault: [0, 1], constraint: 'weights sum to 1.0' },
  execute: {
    swap: { maxSlippagePct: [0.1, 1.0] },
    deposit: { boundedBy: 'agent skill maxAmount + expiresAt' },
  },
}

/** Turbulence regime -> the highest risk tier any allocated vault may hold. */
const TURBULENCE_CEILING = { calm: 'high', elevated: 'medium', turbulent: 'low' }

const RANK_TO_TIER = ['low', 'medium', 'high']

/**
 * The effective risk ceiling for a state: the stricter of the user's profile
 * risk and the market-turbulence gate.
 * @param {Object} state StrategyState
 * @returns {'low'|'medium'|'high'}
 */
export function riskCeiling(state) {
  const profileRank = RISK_RANK[state.profile.riskLevel]
  const turbRank = RISK_RANK[TURBULENCE_CEILING[state.market.turbulence]]
  return RANK_TO_TIER[Math.min(profileRank, turbRank)]
}

/**
 * Enforce the action space on a proposed allocation. Returns a NEW
 * { allocations, violations }: every kept vault respects the risk ceiling and
 * the weights are re-normalized to sum exactly 1.0. Pure — mutates nothing.
 * @param {Array<{address:string, allocation:number, risk_tier?:string}>} proposed
 * @param {Object} state StrategyState
 * @returns {{ allocations: Array, violations: string[] }}
 */
export function enforceActionSpace(proposed, state) {
  const violations = []
  const byAddr = new Map(state.universe.map((v) => [v.address.toLowerCase(), v]))
  const ceiling = RISK_RANK[riskCeiling(state)]

  const kept = (proposed || []).filter((p) => {
    const obs = byAddr.get(String(p.address).toLowerCase())
    if (!obs) { violations.push(`unknown vault ${p.address}`); return false }
    const tier = RISK_RANK[normalizeRisk(p.risk_tier || obs.riskTier)]
    if (tier > ceiling) {
      violations.push(`${obs.protocol} (${normalizeRisk(p.risk_tier || obs.riskTier)}) exceeds ${RANK_TO_TIER[ceiling]} ceiling under ${state.market.turbulence} market`)
      return false
    }
    return true
  })

  let pool = kept
  if (!pool.length) {
    const safest = [...state.universe].sort((a, b) => RISK_RANK[a.riskTier] - RISK_RANK[b.riskTier])[0]
    if (safest) {
      pool = [{ address: safest.address, allocation: 1, risk_tier: safest.riskTier }]
      violations.push('all proposals gated — fell back to safest vault')
    }
  }

  const sum = pool.reduce((s, p) => s + (Number(p.allocation) || 0), 0) || 1
  const allocations = pool.map((p) => ({ ...p, allocation: +((Number(p.allocation) || 0) / sum).toFixed(4) }))
  return { allocations, violations }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: PASS — all `riskCeiling` and `enforceActionSpace` cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/mdp.js frontend/src/strategy/mdp.test.js
git commit -m "feat: add action space with risk-ceiling enforcement"
```

---

### Task 3: Reward model — projected + realized

**Files:**
- Modify: `frontend/src/strategy/mdp.js`
- Test: `frontend/src/strategy/mdp.test.js`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/strategy/mdp.test.js`:

```js
import { scoreReward, realizedReward } from './mdp.js'

describe('scoreReward (projected reward)', () => {
  const state = buildStrategyState({ amountUsdc: 10000, riskLevel: 'high', numVaults: 2, vaultData: UNIVERSE, marketContext: null })
  it('computes the allocation-weighted blended APY', () => {
    const r = scoreReward([
      { address: '0xAAA', allocation: 0.5, expected_apy: 4.8, risk_tier: 'low', drawdown: -1.2 },
      { address: '0xCCC', allocation: 0.5, expected_apy: 9.4, risk_tier: 'high', drawdown: -6.5 },
    ], state)
    expect(r.blendedApy).toBeCloseTo(7.1, 2)
  })
  it('projects annual USDC yield on deployed capital', () => {
    const r = scoreReward([{ address: '0xAAA', allocation: 1, expected_apy: 5, risk_tier: 'low', drawdown: -1 }], state)
    expect(r.projectedAnnualUsdc).toBeCloseTo(500, 2) // 5% of 10000
  })
  it('a turbulent market inflates the risk penalty', () => {
    const calm = buildStrategyState({ amountUsdc: 1000, riskLevel: 'high', numVaults: 1, vaultData: UNIVERSE, marketContext: null })
    const turbulent = buildStrategyState({ amountUsdc: 1000, riskLevel: 'high', numVaults: 1, vaultData: UNIVERSE, marketContext: 'exploit drained pool' })
    const alloc = [{ address: '0xCCC', allocation: 1, expected_apy: 9.4, risk_tier: 'high', drawdown: -6.5 }]
    expect(scoreReward(alloc, turbulent).riskPenalty).toBeGreaterThan(scoreReward(alloc, calm).riskPenalty)
  })
  it('risk-adjusted score rewards safer allocations per unit of risk', () => {
    const lowOnly = scoreReward([{ address: '0xAAA', allocation: 1, expected_apy: 4.8, risk_tier: 'low', drawdown: -1.2 }], state)
    expect(lowOnly.riskAdjustedScore).toBeGreaterThan(0)
  })
})

describe('realizedReward (closes the RL loop from memory)', () => {
  it('returns zeros for no entries', () => {
    expect(realizedReward([])).toEqual({ successRate: 0, avgSlippage: 0, totalGas: 0 })
  })
  it('aggregates success rate, avg slippage, and total gas', () => {
    const r = realizedReward([
      { status: 'success', slippageActual: 0.12, gasUsed: 45000 },
      { status: 'failed', slippageActual: 0.30, gasUsed: 21000 },
    ])
    expect(r.successRate).toBe(0.5)
    expect(r.avgSlippage).toBeCloseTo(0.21, 3)
    expect(r.totalGas).toBe(66000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: FAIL — `scoreReward`, `realizedReward` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/mdp.js`:

```js
const TURBULENCE_MULTIPLIER = { calm: 1, elevated: 1.3, turbulent: 1.8 }

/**
 * Project the reward of a strategy BEFORE execution. FinRL reward = delta portfolio
 * value; here we project it as risk-adjusted expected yield on deployed capital.
 * @param {Array<{address:string, allocation:number, expected_apy?:number, apy?:number, risk_tier?:string, drawdown?:number}>} allocations weights sum to 1.0
 * @param {Object} state StrategyState
 * @returns {{ blendedApy:number, riskPenalty:number, riskAdjustedScore:number, projectedAnnualUsdc:number, turbulence:string }}
 */
export function scoreReward(allocations, state) {
  const byAddr = new Map(state.universe.map((v) => [v.address.toLowerCase(), v]))
  let blended = 0
  let drawWeighted = 0
  let riskWeighted = 0
  ;(allocations || []).forEach((a) => {
    const obs = byAddr.get(String(a.address).toLowerCase()) || {}
    const w = Number(a.allocation) || 0
    const apy = Number(a.expected_apy != null ? a.expected_apy : (a.apy != null ? a.apy : obs.apy)) || 0
    const draw = Math.abs(Number(a.drawdown != null ? a.drawdown : obs.drawdown) || 0)
    blended += w * apy
    drawWeighted += w * draw
    riskWeighted += w * (RISK_RANK[normalizeRisk(a.risk_tier || obs.riskTier)] + 1)
  })
  const turbMult = TURBULENCE_MULTIPLIER[state.market.turbulence] || 1
  const riskPenalty = +(drawWeighted * turbMult).toFixed(2)
  const riskAdjustedScore = +(blended / (riskWeighted || 1)).toFixed(2)
  const projectedAnnualUsdc = +((blended / 100) * (state.capital.amountUsdc || 0)).toFixed(2)
  return { blendedApy: +blended.toFixed(2), riskPenalty, riskAdjustedScore, projectedAnnualUsdc, turbulence: state.market.turbulence }
}

/**
 * Realized reward AFTER execution — closes the RL loop from agent memory entries.
 * @param {Array<{gasUsed?:number, slippageActual?:number, status?:string}>} memoryEntries
 * @returns {{ successRate:number, avgSlippage:number, totalGas:number }}
 */
export function realizedReward(memoryEntries) {
  const e = memoryEntries || []
  if (!e.length) return { successRate: 0, avgSlippage: 0, totalGas: 0 }
  const ok = e.filter((m) => m.status === 'success').length
  const slip = e.reduce((s, m) => s + (Number(m.slippageActual) || 0), 0)
  const gas = e.reduce((s, m) => s + (Number(m.gasUsed) || 0), 0)
  return { successRate: +(ok / e.length).toFixed(2), avgSlippage: +(slip / e.length).toFixed(3), totalGas: gas }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/mdp.test.js`
Expected: PASS — full `mdp.test.js` suite green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/mdp.js frontend/src/strategy/mdp.test.js
git commit -m "feat: add projected + realized reward model"
```

---

### Task 4: Wire State/Action/Reward into generateStrategy

**Files:**
- Modify: `frontend/src/venice.js:1-8` (imports), `frontend/src/venice.js:145-168` (post-validate block)

- [ ] **Step 1: Add the import**

In `frontend/src/venice.js`, add to the import block at the top (after line 7, the `hashStrategy` import):

```js
import { buildStrategyState, enforceActionSpace, scoreReward, riskCeiling } from './strategy/mdp.js'
```

- [ ] **Step 2: Build state, enforce action space, attach reward**

In `frontend/src/venice.js`, replace this exact block (currently lines 145-148):

```js
    const parsed = validateVeniceResponse(JSON.parse(content), vaultData)
    console.log(`[ai] Strategy via ${provider.name} · skill: ${skill.source} · vaults: ${vaultDataSource}`)
    // Deterministic tamper-proof hash of the AI strategy + reasoning (for on-chain attestation)
    const strategyHash = hashStrategy({ ...parsed, generatedBy: provider.name })
```

with:

```js
    const parsed = validateVeniceResponse(JSON.parse(content), vaultData)
    console.log(`[ai] Strategy via ${provider.name} · skill: ${skill.source} · vaults: ${vaultDataSource}`)

    // --- Formal MDP: State -> Action -> Reward (FinRL framing) ---
    // STATE: snapshot what the strategist observed.
    const mdpFullState = buildStrategyState({
      amountUsdc: amount, riskLevel, numVaults: safeNumVaults, vaultData, marketContext,
    })
    // ACTION: clamp the AI's proposed allocation to the risk ceiling, renormalize to 1.0.
    const { allocations, violations } = enforceActionSpace(parsed.selected_vaults, mdpFullState)
    parsed.selected_vaults = allocations.map((al) => {
      const orig = parsed.selected_vaults.find((v) => String(v.address).toLowerCase() === String(al.address).toLowerCase()) || {}
      return { ...orig, address: al.address, allocation: al.allocation, risk_tier: al.risk_tier || orig.risk_tier }
    })
    // REWARD: project a risk-adjusted score for the enforced allocation.
    const reward = scoreReward(parsed.selected_vaults, mdpFullState)
    // Compact state summary for the UI (full universe is too heavy to carry/attest).
    const mdpState = {
      turbulence: mdpFullState.market.turbulence,
      signals: mdpFullState.market.signals,
      universeSize: mdpFullState.universe.length,
      riskCeiling: riskCeiling(mdpFullState),
      profileRisk: mdpFullState.profile.riskLevel,
      capitalUsdc: mdpFullState.capital.amountUsdc,
      actionViolations: violations,
    }
    if (violations.length) console.log('[mdp] action-space violations:', violations)

    // Deterministic tamper-proof hash of the ENFORCED strategy (for on-chain attestation)
    const strategyHash = hashStrategy({ ...parsed, generatedBy: provider.name })
```

- [ ] **Step 3: Attach `reward` + `mdpState` to the returned object**

In `frontend/src/venice.js`, replace the success-path return (currently line 168):

```js
    return { ...parsed, generatedBy: provider.name, skillSource: skill.source, marketContextUsed: marketContext !== null, vaultDataSource, vaultsUsed: vaultData, strategyHash, attestation: null }
```

with:

```js
    return { ...parsed, generatedBy: provider.name, skillSource: skill.source, marketContextUsed: marketContext !== null, vaultDataSource, vaultsUsed: vaultData, strategyHash, attestation: null, reward, mdpState }
```

- [ ] **Step 4: Verify the build still resolves**

Run: `cd frontend && npx vite build`
Expected: PASS — build completes, no unresolved import for `./strategy/mdp.js`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/venice.js
git commit -m "feat: enforce action space and attach reward in strategy generation"
```

---

### Task 5: Carry reward through the strategy object

**Files:**
- Modify: `frontend/src/app.jsx:114` (`mapVeniceToStrategy` return)
- Modify: `frontend/src/agents.jsx:1-27` (import), `frontend/src/agents.jsx:50-57` (`buildStrategy` return)

- [ ] **Step 1: Pass reward through `mapVeniceToStrategy`**

In `frontend/src/app.jsx`, replace the `mapVeniceToStrategy` return (currently line 114):

```js
  return { agents, total, blendedApy: blended.toFixed(1), risk, rationale: veniceResult.strategy_summary || veniceResult.rationale };
```

with:

```js
  return { agents, total, blendedApy: blended.toFixed(1), risk, rationale: veniceResult.strategy_summary || veniceResult.rationale, reward: veniceResult.reward || null, mdpState: veniceResult.mdpState || null };
```

- [ ] **Step 2: Give the fallback `buildStrategy` a reward too**

In `frontend/src/agents.jsx`, add to the imports at the top of the file (find the existing import block; add this line after the existing `config.js` / sibling imports — it must resolve relative to `agents.jsx`):

```js
import { buildStrategyState, scoreReward, riskCeiling } from './strategy/mdp.js'
import { VAULT_CATALOG } from './config.js'
```

> Note: if `VAULT_CATALOG` is already imported in `agents.jsx`, do NOT add the duplicate import line — keep only the `mdp.js` import.

- [ ] **Step 3: Compute reward in `buildStrategy`**

In `frontend/src/agents.jsx`, replace the `buildStrategy` return (currently lines 50-56):

```js
  const blendedApy = agents.reduce((acc, a, i) => acc + Number(a.vault.apy) * (a.allocation / total), 0);
  return {
    agents,
    total,
    blendedApy: blendedApy.toFixed(1),
    risk,
  };
```

with:

```js
  const blendedApy = agents.reduce((acc, a, i) => acc + Number(a.vault.apy) * (a.allocation / total), 0);
  // Formal MDP reward for the offline fallback strategy (no AI / no live market).
  const mdpFullState = buildStrategyState({ amountUsdc: total, riskLevel: risk, numVaults: agents.length, vaultData: VAULT_CATALOG, marketContext: null });
  const fallbackAllocations = agents.map((a) => ({ address: a.vault.addr || a.vault.address, allocation: a.allocation / total, apy: Number(a.vault.apy), risk_tier: a.vault.risk }));
  const reward = scoreReward(fallbackAllocations, mdpFullState);
  return {
    agents,
    total,
    blendedApy: blendedApy.toFixed(1),
    risk,
    reward,
    mdpState: { turbulence: 'calm', signals: [], universeSize: VAULT_CATALOG.length, riskCeiling: riskCeiling(mdpFullState), profileRisk: mdpFullState.profile.riskLevel, capitalUsdc: total, actionViolations: [] },
  };
```

> Note: `AGENT_PROTOCOLS` entries used by `buildStrategy` carry `apy` and an address field. If the address property is named differently than `addr`/`address`, the `reward.blendedApy` still computes from the inline `apy`; only `riskAdjustedScore` weighting reads the universe by address. This is acceptable for the fallback path.

- [ ] **Step 4: Verify build + existing tests still pass**

Run: `cd frontend && npx vite build && npx vitest run`
Expected: PASS — build clean, `positionsStore.test.js` and `mdp.test.js` all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx frontend/src/agents.jsx
git commit -m "feat: carry MDP reward through strategy object and fallback"
```

---

### Task 6: Render the State · Action · Reward panel in StrategyCard

**Files:**
- Modify: `frontend/src/agents.jsx:371-432` (`StrategyCard`, insert panel after the agents list)

- [ ] **Step 1: Insert the panel**

In `frontend/src/agents.jsx`, immediately AFTER the closing `</div>` of `<div className="strategy-agents">` (currently line 432) and BEFORE the attestation block `{(attestation || attesting || strategyHash) && (` (currently line 434), insert:

```jsx
      {strategy.reward && strategy.mdpState && (
        <div className="mdp-panel" style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11 }}>
            <div style={{ padding: "12px 14px", borderRight: "1px solid var(--border)" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>State · observed</div>
              <div style={{ color: "var(--text)" }}>market · {strategy.mdpState.turbulence}</div>
              <div style={{ color: "var(--text-muted)" }}>universe · {strategy.mdpState.universeSize} vaults</div>
              <div style={{ color: "var(--text-muted)" }}>capital · {strategy.mdpState.capitalUsdc} USDC</div>
            </div>
            <div style={{ padding: "12px 14px", borderRight: "1px solid var(--border)" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Action · bounded</div>
              <div style={{ color: "var(--text)" }}>risk ceiling · {strategy.mdpState.riskCeiling}</div>
              <div style={{ color: "var(--text-muted)" }}>weights · sum to 1.0</div>
              <div style={{ color: strategy.mdpState.actionViolations && strategy.mdpState.actionViolations.length ? "var(--warn, #c87)" : "var(--text-muted)" }}>
                gated · {strategy.mdpState.actionViolations ? strategy.mdpState.actionViolations.length : 0}
              </div>
            </div>
            <div style={{ padding: "12px 14px" }}>
              <div style={{ color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Reward · projected</div>
              <div style={{ color: "var(--text)" }}>risk-adj · {strategy.reward.riskAdjustedScore}</div>
              <div style={{ color: "var(--text-muted)" }}>≈ {strategy.reward.projectedAnnualUsdc} USDC / yr</div>
              <div style={{ color: "var(--text-muted)" }}>risk penalty · {strategy.reward.riskPenalty}</div>
            </div>
          </div>
          {strategy.mdpState.actionViolations && strategy.mdpState.actionViolations.length > 0 && (
            <div className="mono" style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)" }}>
              {strategy.mdpState.actionViolations[0]}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 2: Verify it renders without error**

Run: `cd frontend && npx vite build`
Expected: PASS — JSX compiles, no syntax error.

- [ ] **Step 3: Manual smoke check**

Run: `npx serve frontend/` (or the project's dev command), open the app, enter an amount + risk, run a strategy. Confirm a three-column "State · Action · Reward" panel appears under the agent rows, showing the market regime, risk ceiling, and projected risk-adjusted reward.
Expected: Panel visible; for a fallback strategy it shows `market · calm` and a numeric risk-adjusted score.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agents.jsx
git commit -m "feat: render State/Action/Reward panel in StrategyCard"
```

---

### Task 7: Reframe the advisor prompt in State/Action/Reward language

**Files:**
- Modify: `frontend/src/skills/default/vault-advisor.md`

- [ ] **Step 1: Add an MDP framing section**

In `frontend/src/skills/default/vault-advisor.md`, insert this block immediately AFTER line 8 (the `---` that follows the intro, before `## YOUR MENTAL MODEL`):

```markdown
## REASON AS A FORMAL DECISION PROCESS (State → Action → Reward)

Frame every recommendation as one step of a Markov Decision Process,
the way FinRL frames trading. You are not just "picking a vault" — you are
choosing an ACTION over an observed STATE to maximize a risk-adjusted REWARD.

- STATE — what you observe: the user's capital and risk profile, the live market
  context block (if present), and the vault universe (APY, TVL, risk tier, yield
  source). Read all of it before deciding.
- ACTION — what you may do: assign an allocation weight in [0, 1] to each vault,
  with all weights summing to exactly 1.0. You may NOT allocate to a vault whose
  risk tier exceeds the user's risk profile, and you must down-weight risk when
  the market context signals turbulence (exploits, depegs, sharp volatility).
- REWARD — what you maximize: expected yield ADJUSTED for risk, not headline APY.
  A lower-APY allocation with far less drawdown exposure is the better action.
  State your reward logic in `strategy_summary`: why this allocation maximizes
  risk-adjusted return for THIS state.

---
```

- [ ] **Step 2: Tie the reasoning field to the reward**

In `frontend/src/skills/default/vault-advisor.md`, replace this exact `reasoning` schema line (currently line 141):

```markdown
      "reasoning": "2-3 sentences. Be specific: WHY this vault for THIS user's amount and risk. Name the yield source. Name one concrete risk they accept."
```

with:

```markdown
      "reasoning": "2-3 sentences framed as State -> Action -> Reward: what in the STATE (amount, risk, market) makes this vault the right ACTION, and what REWARD (risk-adjusted yield) it contributes. Name the yield source and one concrete risk accepted."
```

- [ ] **Step 3: Verify the prompt still loads**

Run: `cd frontend && npx vite build`
Expected: PASS — `vault-advisor.md?raw` import unaffected; build clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/skills/default/vault-advisor.md
git commit -m "docs: reframe advisor prompt as State/Action/Reward MDP"
```

---

### Task 8: Refresh the knowledge graph + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — `mdp.test.js` (all State/Action/Reward cases) + `positionsStore.test.js` green.

- [ ] **Step 2: Run the production build**

Run: `cd frontend && npx vite build`
Expected: PASS — clean build, no warnings about `./strategy/mdp.js`.

- [ ] **Step 3: Update graphify**

Run: `graphify update .`
Expected: AST re-extraction picks up `frontend/src/strategy/mdp.js` and the modified files. No API cost.

- [ ] **Step 4: Final commit (if graph artifacts changed)**

```bash
git add graphify-out
git commit -m "chore: update knowledge graph for MDP module"
```

---

## Self-Review

**Spec coverage** (FinRL State/Action/Reward formalization, poros = `/strategy`):
- **State** → Task 1 `buildStrategyState` + `deriveTurbulence` (capital, profile, portfolio, market regime, vault universe). Surfaced in UI Task 6, prompt Task 7.
- **Action** → Task 2 `enforceActionSpace` + `riskCeiling` + `ACTION_SPACE` (allocation weights, risk ceiling, turbulence gate, renormalization). Wired Task 4, prompt Task 7.
- **Reward** → Task 3 `scoreReward` (projected risk-adjusted) + `realizedReward` (memory loop). Wired Task 4/5, surfaced Task 6.
- **Poros stays `/strategy`**: every change centers on the strategy step (venice.js generateStrategy, StrategyCard, vault-advisor.md, mapVeniceToStrategy). Other files touched only to thread the data through.

**Placeholder scan:** No TBD/TODO. Every code step shows full code. Every test step shows full assertions. Commands have expected output.

**Type consistency:** `buildStrategyState` shape (`capital`/`profile`/`portfolio`/`market`/`universe`) consistent across Tasks 1–5. `riskCeiling`/`enforceActionSpace`/`scoreReward` signatures match between definition (Tasks 2–3) and call sites (Tasks 4–5). `mdpState` fields written in venice.js (Task 4) and agents.jsx fallback (Task 5) match exactly what StrategyCard reads (Task 6): `turbulence`, `signals`, `universeSize`, `riskCeiling`, `profileRisk`, `capitalUsdc`, `actionViolations`. `reward` fields (`blendedApy`, `riskPenalty`, `riskAdjustedScore`, `projectedAnnualUsdc`, `turbulence`) consistent between Task 3 and Task 6.

**Open assumption to verify at execution:** Task 5 assumes `AGENT_PROTOCOLS` vault entries expose an address field; the note documents the graceful degradation if not. Confirm the dev command for the smoke check (Task 6 Step 3) — `npx serve frontend/` per CLAUDE.md, or the Vite dev server if configured.
```
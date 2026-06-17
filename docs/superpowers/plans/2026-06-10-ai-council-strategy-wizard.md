# AI Council in the /strategy Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a real, AI-powered TradingAgents-style AI Council inside the `/strategy` wizard review step — three Venice AI specialists (Yield / Risk / Market) deliberate in parallel on the proposed allocation, each emits a compressed verdict citing role-scoped playbook rules, a synthesis resolves them, and after deposit the cited rules earn helpful/harmful counters (ACE loop).

**Architecture:** A new wizard-only council module (`councilReview.js`) runs three role specialists in parallel. Each specialist is a real AI call (the existing DeepSeek server-proxy provider — keyless, JSON-only) with a role-specific system prompt, a role-filtered subset of playbook rules, and a different slice of strategy/market data. **AI-only — no fabricated/heuristic verdicts:** each specialist retries once on failure; if it still cannot get a real verdict, the council returns an `unavailable` state and the UI offers a retry (it never invents a signal). A synthesis step (hard-veto → unanimity → weighted majority → one AI conflict call) produces a keep/discard verdict. The verdict's `citedRules` are stamped onto the strategy; after the deposit executes (`handleExecDone`), `reflect()` increments those rules' counters in the shared `playbook.js` store. The existing autonomous-loop council (`council.js`) is left untouched.

**No hardcoded values:** no secrets (keyless proxy), no fake numbers, no canned verdicts. The only static content is the playbook rule catalog (the rules the AI reasons over) and role system prompts — both are domain knowledge, not fabricated outputs.

**Tech Stack:** React 18 (Babel-free Vite build under `frontend/`), Vitest, Venice AI (OpenAI-compatible, `llama-3.3-70b`) via the existing `venice.js` proxy pattern, localStorage playbook.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/strategy/playbookRules.js` | Authoritative catalog mapping each role → its playbook rule IDs + human descriptions; validators. | Create |
| `frontend/src/strategy/playbookRules.test.js` | Unit tests for the catalog + validators. | Create |
| `frontend/src/venice.js` | Add `parseSpecialistVerdict` (pure) + `councilSpecialistVerdict` (AI call). | Modify |
| `frontend/src/venice.test.js` | Add tests for `parseSpecialistVerdict`. | Modify |
| `frontend/src/strategy/councilReview.js` | Wizard council: input builder, role prompts, deterministic fallbacks, per-role specialist runner, synthesis, public `councilReview`. | Create |
| `frontend/src/strategy/councilReview.test.js` | Unit tests for input builder, fallbacks, synthesis, and orchestration. | Create |
| `frontend/src/agents.jsx` | `CouncilPanel` component; render it in `StrategyCard` above `SimulationPanel`. | Modify |
| `frontend/style.css` | Council panel styles. | Modify |
| `frontend/src/app.jsx` | Council state + async effect, pass `council` prop to `StrategyCard`, `reflect()` after deposit; extract pure `councilOutcome` helper. | Modify |
| `frontend/src/app.test.js` (or new `frontend/src/strategy/outcome.test.js`) | Test `councilOutcome`. | Create |

**Data shapes (used across tasks — keep names exact):**

```js
// Specialist verdict — always from a real AI call (no fabricated source)
/** @typedef {{
 *   role: 'yield'|'risk'|'market',
 *   signal: 'DEPOSIT'|'HOLD'|'WITHDRAW',
 *   confidence: number,        // 0..1
 *   reasoning: string,
 *   citedRules: string[],      // ⊆ that role's rule IDs
 *   concerns: string[],
 *   source: 'ai'
 * }} SpecialistVerdict */

// Council result — 'unavailable' when any specialist could not get a real AI verdict
/** @typedef {{
 *   verdict: 'keep'|'discard'|'unavailable',
 *   reason: string|null,
 *   confidence: number,
 *   citedRules: string[],      // de-duped union of contributing verdicts
 *   specialists: SpecialistVerdict[],   // only the verdicts that succeeded
 *   resolvedBy: 'veto'|'unanimous'|'weighted'|'ai-conflict'|'unavailable'
 * }} CouncilResult */

// Council input (built from strategy + StrategyState)
/** @typedef {{
 *   amountUsdc:number, numVaults:number,
 *   blendedApy:number, projectedAnnualUsdc:number, riskAdjustedScore:number, riskPenalty:number,
 *   turbulence:'calm'|'elevated'|'turbulent', violations:string[], maxDrawdown:number, riskTier:string,
 *   gasGwei:number|null, gasLevel:string|null, marketSignals:string[],
 *   vaults: Array<{name:string, protocol:string, apy:number, drawdown:number, allocationPct:number, riskTier:string}>
 * }} CouncilInput */
```

---

### Task 1: Playbook role-rule catalog

Per the TradingAgents spec (§6.6.3) each role sees only its relevant rules. This catalog is what the AI specialists are shown, what they must cite from, and what `reflect()` later increments in the existing `playbook.js` localStorage store (rule IDs are new and coherent; counters accumulate per-id automatically).

**Files:**
- Create: `frontend/src/strategy/playbookRules.js`
- Test: `frontend/src/strategy/playbookRules.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/playbookRules.test.js
import { describe, it, expect } from 'vitest'
import { ROLE_RULES, rulesForRole, ruleIdsForRole, allRuleIds, isValidRuleForRole } from './playbookRules.js'

describe('playbookRules catalog', () => {
  it('defines exactly the three council roles', () => {
    expect(Object.keys(ROLE_RULES).sort()).toEqual(['market', 'risk', 'yield'])
  })

  it('every rule has a non-empty id and description', () => {
    for (const role of Object.keys(ROLE_RULES)) {
      for (const r of ROLE_RULES[role]) {
        expect(typeof r.id).toBe('string')
        expect(r.id.length).toBeGreaterThan(0)
        expect(r.description.length).toBeGreaterThan(10)
      }
    }
  })

  it('rule ids are globally unique across roles', () => {
    const ids = allRuleIds()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rulesForRole returns the role array, ruleIdsForRole returns just ids', () => {
    expect(rulesForRole('yield')).toBe(ROLE_RULES.yield)
    expect(ruleIdsForRole('risk')).toEqual(ROLE_RULES.risk.map((r) => r.id))
  })

  it('unknown role yields empty results, never throws', () => {
    expect(rulesForRole('bogus')).toEqual([])
    expect(ruleIdsForRole('bogus')).toEqual([])
  })

  it('isValidRuleForRole only accepts ids belonging to that role', () => {
    const yieldId = ROLE_RULES.yield[0].id
    const riskId = ROLE_RULES.risk[0].id
    expect(isValidRuleForRole('yield', yieldId)).toBe(true)
    expect(isValidRuleForRole('yield', riskId)).toBe(false)
    expect(isValidRuleForRole('yield', 'nope')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/playbookRules.test.js`
Expected: FAIL — "Failed to resolve import './playbookRules.js'".

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/playbookRules.js
// ACE-inspired per-role playbook catalog for the /strategy wizard AI Council.
// Each council specialist is shown ONLY its role's rules and must cite from them.
// citedRules flow to reflector.js, which increments these ids in playbook.js —
// rules that consistently precede good deposits gain council weight over time.
// (TradingAgents adaptation §6.6.3: per-role playbook subset prevents cross-role noise.)

export const ROLE_RULES = {
  yield: [
    { id: 'yld-apy-attractive', description: 'Blended APY clears the profile target; the headline yield justifies entry.' },
    { id: 'yld-projection-positive', description: 'Risk-adjusted projected annual yield (USDC) is positive after the risk penalty.' },
    { id: 'yld-tvl-adequate', description: 'Selected vaults have adequate TVL/track record so the quoted APY is credible.' },
  ],
  risk: [
    { id: 'rsk-turbulent-veto', description: 'Market regime is turbulent — defer entry; capital preservation outranks yield.' },
    { id: 'rsk-gates-clear', description: 'No action-space gate violations: allocations respect the risk ceiling and sum to 1.0.' },
    { id: 'rsk-drawdown-bounded', description: '30-day max drawdown of the basket stays within the profile risk tolerance.' },
    { id: 'rsk-regime-calm', description: 'Regime is calm/elevated with no violations — risk posture supports deploying.' },
  ],
  market: [
    { id: 'mkt-gas-affordable', description: 'Entry gas cost is small relative to expected yield; timing is economically sound.' },
    { id: 'mkt-timing-favorable', description: 'Calm regime and clear signals make now a favorable entry window.' },
    { id: 'mkt-signals-clear', description: 'No adverse live market signals (exploits, depegs, governance alarms) flagged.' },
  ],
}

export function rulesForRole(role) {
  return ROLE_RULES[role] || []
}

export function ruleIdsForRole(role) {
  return rulesForRole(role).map((r) => r.id)
}

export function allRuleIds() {
  return Object.values(ROLE_RULES).flat().map((r) => r.id)
}

export function isValidRuleForRole(role, ruleId) {
  return ruleIdsForRole(role).includes(ruleId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/playbookRules.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/playbookRules.js frontend/src/strategy/playbookRules.test.js
git commit -m "feat: add per-role playbook rule catalog for AI Council"
```

---

### Task 2: Venice per-role specialist call

Adds the AI primitive each specialist uses. `parseSpecialistVerdict` is pure (unit-testable like `validateVeniceResponse`, no fetch mock needed); `councilSpecialistVerdict` wires it to the existing `callChatCompletions`/`resolveProvider` server-proxy path (wallet is not connected at wizard step 01, so we use the keyless proxy exactly like `classifyRisk` and `resolveCouncilConflict`).

**Files:**
- Modify: `frontend/src/venice.js` (append near `resolveCouncilConflict`, end of file before EOF)
- Test: `frontend/src/venice.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/venice.test.js`:

```js
import { parseSpecialistVerdict } from './venice.js'

describe('parseSpecialistVerdict', () => {
  const allowed = ['yld-apy-attractive', 'yld-projection-positive', 'yld-tvl-adequate']

  it('parses a well-formed verdict and keeps only allowed cited rules', () => {
    const v = parseSpecialistVerdict({
      signal: 'DEPOSIT', confidence: 0.82,
      reasoning: 'APY clears target and projection is positive.',
      citedRules: ['yld-apy-attractive', 'rsk-turbulent-veto', 'bogus'],
      concerns: ['thin TVL on vault 2'],
    }, 'yield', allowed)
    expect(v.role).toBe('yield')
    expect(v.signal).toBe('DEPOSIT')
    expect(v.confidence).toBe(0.82)
    expect(v.citedRules).toEqual(['yld-apy-attractive']) // cross-role + hallucinated dropped
    expect(v.source).toBe('ai')
  })

  it('clamps confidence to [0,1] and uppercases the signal', () => {
    const v = parseSpecialistVerdict({ signal: 'deposit', confidence: 2, reasoning: 'x', citedRules: [] }, 'yield', allowed)
    expect(v.confidence).toBe(1)
    expect(v.signal).toBe('DEPOSIT')
  })

  it('throws on an invalid signal', () => {
    expect(() => parseSpecialistVerdict({ signal: 'BUY', confidence: 0.5, reasoning: 'x' }, 'yield', allowed))
      .toThrow(/signal/)
  })

  it('throws when reasoning is missing', () => {
    expect(() => parseSpecialistVerdict({ signal: 'HOLD', confidence: 0.5 }, 'yield', allowed))
      .toThrow(/reasoning/)
  })

  it('defaults missing citedRules/concerns to empty arrays', () => {
    const v = parseSpecialistVerdict({ signal: 'HOLD', confidence: 0.4, reasoning: 'cautious' }, 'risk', ['rsk-regime-calm'])
    expect(v.citedRules).toEqual([])
    expect(v.concerns).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/venice.test.js`
Expected: FAIL — `parseSpecialistVerdict` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/venice.js` (after `resolveCouncilConflict`, before EOF):

```js
const VALID_SIGNALS = new Set(['DEPOSIT', 'HOLD', 'WITHDRAW'])

/**
 * Pure parser/validator for a council specialist's JSON verdict. Drops cited
 * rules that aren't in the role's allowed set (anti-hallucination, mirrors
 * validateVeniceResponse's address check). Throws on structural problems so the
 * caller can fall back to the deterministic specialist.
 * @param {object} raw parsed JSON from the model
 * @param {'yield'|'risk'|'market'} role
 * @param {string[]} allowedRuleIds rule ids this role may cite
 * @returns {import('./strategy/councilReview.js').SpecialistVerdict}
 */
export function parseSpecialistVerdict(raw, role, allowedRuleIds = []) {
  const signal = String(raw?.signal || '').toUpperCase()
  if (!VALID_SIGNALS.has(signal)) throw new Error(`invalid signal: ${raw?.signal}`)
  if (!raw?.reasoning || String(raw.reasoning).length < 1) throw new Error('reasoning missing')
  const conf = Math.max(0, Math.min(1, +Number(raw.confidence).toFixed(3)))
  const allowed = new Set(allowedRuleIds)
  const citedRules = Array.isArray(raw.citedRules) ? raw.citedRules.filter((id) => allowed.has(id)) : []
  const concerns = Array.isArray(raw.concerns) ? raw.concerns.map(String).slice(0, 4) : []
  return { role, signal, confidence: Number.isFinite(conf) ? conf : 0, reasoning: String(raw.reasoning), citedRules, concerns, source: 'ai' }
}

/**
 * Run ONE council specialist as a Venice AI call. Server-proxy by default (the
 * wallet is not connected at wizard step 01). Returns null on any failure so the
 * caller substitutes the deterministic fallback — the council never blocks.
 * @param {{role:string, systemPrompt:string, userPrompt:string, allowedRuleIds:string[], devApiKey?:string|null, signal?:AbortSignal}} args
 * @returns {Promise<import('./strategy/councilReview.js').SpecialistVerdict|null>}
 */
export async function councilSpecialistVerdict({ role, systemPrompt, userPrompt, allowedRuleIds, devApiKey = null, signal }) {
  const provider = resolveProvider(null, devApiKey)
  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), VENICE_TIMEOUT_MS) : null
  const sig = signal || controller.signal
  try {
    const content = await callChatCompletions(
      provider.url, provider.model, provider.headers,
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      provider.isVenice, sig
    )
    return parseSpecialistVerdict(JSON.parse(content), role, allowedRuleIds)
  } catch (err) {
    console.warn(`[council] ${role} specialist failed (${provider.name}):`, err.message)
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/venice.test.js`
Expected: PASS (original tests + 5 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/venice.js frontend/src/venice.test.js
git commit -m "feat: add Venice per-role council specialist call and verdict parser"
```

---

### Task 3: Wizard council module

The orchestration core. Pure where possible: the input builder and synthesis are pure and fully tested; `councilReview` injects the AI specialist runner and the conflict resolver so tests run without network. **No deterministic verdict fabrication** — a specialist that cannot get a real AI verdict (after one retry) yields `null`, and the council reports `unavailable`.

**Files:**
- Create: `frontend/src/strategy/councilReview.js`
- Test: `frontend/src/strategy/councilReview.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/councilReview.test.js
import { describe, it, expect, vi } from 'vitest'
import { buildCouncilInput, synthesize, councilReview } from './councilReview.js'

const baseInput = {
  amountUsdc: 100, numVaults: 2,
  blendedApy: 6.2, projectedAnnualUsdc: 6.1, riskAdjustedScore: 5.4, riskPenalty: 0.3,
  turbulence: 'calm', violations: [], maxDrawdown: 4, riskTier: 'medium',
  gasGwei: 12, gasLevel: 'normal', marketSignals: [],
  vaults: [{ name: 'A', protocol: 'aave-v3', apy: 5, drawdown: 3, allocationPct: 60, riskTier: 'low' }],
}
const w1 = () => 1.0
const ai = (role, signal, confidence, citedRules = [`${role}-c`]) =>
  ({ role, signal, confidence, reasoning: 'ai', citedRules, concerns: [], source: 'ai' })

describe('buildCouncilInput', () => {
  it('derives council input from strategy + state', () => {
    const strategy = {
      total: 100, risk: 'med', blendedApy: '6.2',
      reward: { projectedAnnualUsdc: 6.1, riskAdjustedScore: 5.4, riskPenalty: 0.3 },
      mdpState: { turbulence: 'elevated', actionViolations: ['x'], gasGwei: 20, gasLevel: 'elevated', signals: ['s1'], profileRisk: 'medium' },
      agents: [{ allocation: 60, vault: { name: 'A', protocol: 'aave-v3', apy: '5', drawdown: 3, risk: 'low' } }],
    }
    const inp = buildCouncilInput(strategy, { market: { turbulence: 'calm' } })
    expect(inp.amountUsdc).toBe(100)
    expect(inp.blendedApy).toBe(6.2)
    expect(inp.turbulence).toBe('elevated')          // mdpState wins over state
    expect(inp.violations).toEqual(['x'])
    expect(inp.vaults[0].allocationPct).toBe(60)
    expect(inp.maxDrawdown).toBe(3)
  })
})

describe('synthesize', () => {
  it('hard-vetoes when risk WITHDRAW confidence > 0.85', async () => {
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.9), ai('risk', 'WITHDRAW', 0.9), ai('market', 'DEPOSIT', 0.8)], { resolveConflict: vi.fn(), market: {} })
    expect(r.verdict).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
  })
  it('keeps on unanimous DEPOSIT without AI conflict call', async () => {
    const resolveConflict = vi.fn()
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.8), ai('risk', 'DEPOSIT', 0.7), ai('market', 'DEPOSIT', 0.75)], { resolveConflict, market: {} })
    expect(r.verdict).toBe('keep')
    expect(r.resolvedBy).toBe('unanimous')
    expect(resolveConflict).not.toHaveBeenCalled()
  })
  it('escalates to the AI resolver only on a genuine split', async () => {
    const resolveConflict = vi.fn(async () => 'DEPOSIT')
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.6), ai('risk', 'DEPOSIT', 0.55), ai('market', 'HOLD', 0.7)], { resolveConflict, market: {} })
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(r.resolvedBy).toBe('ai-conflict')
    expect(r.verdict).toBe('keep')
  })
})

describe('councilReview orchestration (AI-only)', () => {
  it('synthesizes when all three specialists return real verdicts', async () => {
    const specialist = vi.fn(async ({ role }) => ai(role, 'DEPOSIT', 0.8))
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(async () => 'HOLD'), weight: w1 })
    expect(r.specialists).toHaveLength(3)
    expect(r.specialists.every((s) => s.source === 'ai')).toBe(true)
    expect(r.verdict).toBe('keep')
  })

  it('retries a failing specialist once before giving up', async () => {
    let calls = 0
    const specialist = vi.fn(async ({ role }) => {
      if (role === 'market') { calls++; return calls >= 2 ? ai('market', 'DEPOSIT', 0.7) : null }
      return ai(role, 'DEPOSIT', 0.8)
    })
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(async () => 'HOLD'), weight: w1, attempts: 2 })
    expect(calls).toBe(2)                 // failed once, succeeded on retry
    expect(r.verdict).not.toBe('unavailable')
    expect(r.specialists).toHaveLength(3)
  })

  it('returns unavailable (no fabricated verdict) when a specialist keeps failing', async () => {
    const specialist = vi.fn(async ({ role }) => (role === 'market' ? null : ai(role, 'DEPOSIT', 0.8)))
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(), weight: w1, attempts: 2 })
    expect(r.verdict).toBe('unavailable')
    expect(r.resolvedBy).toBe('unavailable')
    expect(r.citedRules).toEqual([])
    expect(r.specialists.length).toBe(2)  // only the ones that succeeded
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/councilReview.test.js`
Expected: FAIL — "Failed to resolve import './councilReview.js'".

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/councilReview.js
// TradingAgents-style AI Council for the /strategy wizard (TauricResearch
// arXiv 2412.20138). Three specialists — Yield / Risk / Market — deliberate in
// PARALLEL on the proposed deposit. Each is a real AI call (DeepSeek server proxy)
// with its own system prompt, a role-filtered playbook subset, and a different
// data slice. AI-ONLY: a specialist that cannot produce a real verdict (after one
// retry) yields null and the council reports 'unavailable' — it never fabricates a
// signal. Synthesis: hard-veto (Risk WITHDRAW>0.85) → unanimity → weighted
// majority → ONE injected AI conflict call. Cited rules flow to reflector.js
// after deposit.
//
// Distinct from council.js (the always-on monitor-loop council, deterministic by
// design): this module is AI-first and runs once, at strategy review time.

const VETO_CONF = 0.85
const MARGIN = 0.25

export const ROLE_LABEL = { yield: 'Yield Analyst', risk: 'Risk Analyst', market: 'Market Analyst' }

const ROLE_SYSTEM = {
  yield: 'You are the Yield Analyst on a DeFi AI Council. You judge ONLY yield quality: blended APY vs the risk profile, the risk-adjusted projected annual return, and whether TVL makes the quoted APY credible. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  risk: 'You are the Risk Analyst on a DeFi AI Council. You judge ONLY downside risk: market regime (turbulent ⇒ WITHDRAW), action-space gate violations, basket drawdown vs the profile tolerance. Safety outranks yield. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
  market: 'You are the Market Analyst on a DeFi AI Council. You judge ONLY timing and execution cost: gas level vs expected yield, regime, and any adverse live market signals. Output JSON only: {"signal":"DEPOSIT|HOLD|WITHDRAW","confidence":0..1,"reasoning":"...","citedRules":["..."],"concerns":["..."]}. Cite ONLY rule ids from the provided list.',
}

/** Build the per-role user prompt with that role's data slice + citable rule ids. */
export function buildSpecialistPrompt(role, input, rules) {
  const ruleList = rules.map((r) => `  - ${r.id}: ${r.description}`).join('\n')
  const vaults = input.vaults.map((v) => `${v.name} (${v.protocol}) ${v.apy}% APY · ${v.allocationPct}% alloc · ${v.drawdown}% dd · ${v.riskTier}`).join('; ')
  let slice = ''
  if (role === 'yield') {
    slice = `Blended APY: ${input.blendedApy}%\nProjected annual (risk-adjusted): ${input.projectedAnnualUsdc} USDC\nRisk-adjusted score: ${input.riskAdjustedScore} (penalty ${input.riskPenalty})\nProfile risk: ${input.riskTier}`
  } else if (role === 'risk') {
    slice = `Market regime: ${input.turbulence}\nGate violations: ${input.violations.length ? input.violations.join('; ') : 'none'}\nBasket max drawdown (30d): ${input.maxDrawdown}%\nProfile risk tolerance: ${input.riskTier}`
  } else {
    slice = `Gas: ${input.gasGwei ?? 'n/a'} gwei (${input.gasLevel ?? 'n/a'})\nMarket regime: ${input.turbulence}\nLive market signals: ${input.marketSignals.length ? input.marketSignals.join('; ') : 'none'}`
  }
  return `Proposed deposit: ${input.amountUsdc} USDC across ${input.numVaults} vault(s): ${vaults}\n\nYour data:\n${slice}\n\nRules you may cite (use the id):\n${ruleList}\n\nShould we proceed with this deposit? Respond in JSON only.`
}

/** Adapt strategy + StrategyState into the council input. Pure. */
export function buildCouncilInput(strategy, state = {}) {
  const reward = strategy?.reward || {}
  const mdp = strategy?.mdpState || {}
  const vaults = (strategy?.agents || []).map((a) => ({
    name: a.vault?.name || '',
    protocol: a.vault?.protocol || '',
    apy: Number(a.vault?.apy) || 0,
    drawdown: Number(a.vault?.drawdown) || 0,
    allocationPct: strategy?.total ? +(((Number(a.allocation) || 0) / strategy.total) * 100).toFixed(1) : 0,
    riskTier: a.vault?.risk || a.vault?.risk_tier || 'medium',
  }))
  return {
    amountUsdc: Number(strategy?.total) || 0,
    numVaults: vaults.length,
    blendedApy: Number(strategy?.blendedApy) || 0,
    projectedAnnualUsdc: Number(reward.projectedAnnualUsdc) || 0,
    riskAdjustedScore: Number(reward.riskAdjustedScore) || 0,
    riskPenalty: Number(reward.riskPenalty) || 0,
    turbulence: mdp.turbulence || state?.market?.turbulence || 'calm',
    violations: mdp.actionViolations || [],
    maxDrawdown: vaults.reduce((m, v) => Math.max(m, v.drawdown), 0),
    riskTier: strategy?.risk || mdp.profileRisk || 'medium',
    gasGwei: mdp.gasGwei ?? state?.gas?.gwei ?? null,
    gasLevel: mdp.gasLevel ?? state?.gas?.level ?? null,
    marketSignals: mdp.signals || state?.market?.signals || [],
    vaults,
  }
}

/** Synthesize 3 verdicts into a keep/discard result. Mirrors council.js synthesis. */
export async function synthesize(verdicts, { resolveConflict, market }) {
  const risk = verdicts.find((v) => v.role === 'risk') || { signal: 'HOLD', confidence: 0 }
  const cited = (signal) => [...new Set(verdicts.filter((v) => v.signal === signal).flatMap((v) => v.citedRules))]
  const avg = verdicts.reduce((a, v) => a + v.confidence, 0) / (verdicts.length || 1)
  const labelFirstNonDeposit = () => {
    const x = verdicts.find((v) => v.signal !== 'DEPOSIT')
    return x ? ROLE_LABEL[x.role] : null
  }
  const res = (verdict, reason, confidence, citedRules, resolvedBy) =>
    ({ verdict, reason, confidence: +Number(confidence).toFixed(3), citedRules, specialists: verdicts, resolvedBy })

  // 1. Hard veto
  if (risk.signal === 'WITHDRAW' && risk.confidence > VETO_CONF) {
    return res('discard', 'Risk Analyst', risk.confidence, risk.citedRules, 'veto')
  }
  // 2. Tally
  const counts = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + 1), m), {})
  const tally = verdicts.reduce((m, v) => ((m[v.signal] = (m[v.signal] || 0) + v.confidence), m), {})
  if (counts.DEPOSIT === 3) return res('keep', null, avg, cited('DEPOSIT'), 'unanimous')
  if ((counts.HOLD || 0) + (counts.WITHDRAW || 0) === 3) return res('discard', labelFirstNonDeposit(), avg, [], 'unanimous')
  const proceed = (tally.DEPOSIT || 0) / 3
  const against = ((tally.HOLD || 0) + (tally.WITHDRAW || 0)) / 3
  if (proceed - against > MARGIN) return res('keep', null, proceed, cited('DEPOSIT'), 'weighted')
  if (against - proceed > MARGIN) return res('discard', labelFirstNonDeposit(), against, [], 'weighted')
  // 3. Genuine split → one AI conflict call
  let signal = 'HOLD'
  if (typeof resolveConflict === 'function') {
    try { signal = await resolveConflict(verdicts, market) } catch { signal = 'HOLD' }
  }
  const keep = signal === 'DEPOSIT'
  return res(keep ? 'keep' : 'discard', keep ? null : 'AI synthesis', avg, keep ? cited('DEPOSIT') : [], 'ai-conflict')
}

/** Run one specialist with up to `attempts` tries. Returns a real verdict or null. */
async function runSpecialist(role, input, deps, attempts) {
  const { specialist, ROLE_RULES, devApiKey, signal } = deps
  if (typeof specialist !== 'function') return null
  const rules = ROLE_RULES[role] || []
  const userPrompt = buildSpecialistPrompt(role, input, rules)
  const allowedRuleIds = rules.map((r) => r.id)
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await specialist({ role, systemPrompt: ROLE_SYSTEM[role], userPrompt, allowedRuleIds, devApiKey, signal })
      if (v) return v
    } catch { /* retry */ }
  }
  return null
}

/**
 * Run the full wizard council. AI-only: if any specialist cannot produce a real
 * verdict after `attempts` tries, returns an 'unavailable' result (no fabricated
 * signal) so the UI can offer a retry.
 * @param {import('./councilReview.js').CouncilInput} input
 * @param {{ specialist?:Function, resolveConflict?:Function, weight?:Function, devApiKey?:string|null, signal?:AbortSignal, attempts?:number }} deps
 *   specialist({role, systemPrompt, userPrompt, allowedRuleIds, devApiKey, signal}) → Promise<SpecialistVerdict|null>
 * @returns {Promise<import('./councilReview.js').CouncilResult>}
 */
export async function councilReview(input, deps = {}) {
  const { specialist, resolveConflict, devApiKey = null, signal, attempts = 2 } = deps
  const { ROLE_RULES } = await import('./playbookRules.js')
  const roles = ['yield', 'risk', 'market']
  const sharedDeps = { specialist, ROLE_RULES, devApiKey, signal }
  const settled = await Promise.all(roles.map((role) => runSpecialist(role, input, sharedDeps, attempts)))
  const verdicts = settled.filter(Boolean)
  if (verdicts.length < roles.length) {
    return { verdict: 'unavailable', reason: 'council unavailable', confidence: 0, citedRules: [], specialists: verdicts, resolvedBy: 'unavailable' }
  }
  return synthesize(verdicts, { resolveConflict, market: { turbulence: input.turbulence } })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/councilReview.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/councilReview.js frontend/src/strategy/councilReview.test.js
git commit -m "feat: add AI Council review engine for the strategy wizard"
```

---

### Task 4: Council deliberation panel UI

A new `CouncilPanel` renders the three specialist verdicts + the synthesis verdict + cited rules, placed in `StrategyCard` directly above `SimulationPanel`. Loading and unavailable states are handled so the review card never looks broken while the AI calls are in flight.

**Files:**
- Modify: `frontend/src/agents.jsx` (add `CouncilPanel`; render in `StrategyCard`; thread `council` prop)
- Modify: `frontend/style.css` (append council styles)

- [ ] **Step 1: Add the `CouncilPanel` component**

In `frontend/src/agents.jsx`, immediately BEFORE `const SimulationPanel = ({ simulation }) => {` (currently line ~390), insert:

```jsx
/* ============================================
   AI Council deliberation panel (step 01)
   Three Venice AI specialists deliberate in parallel on the proposed deposit;
   each emits a compressed verdict citing role-scoped playbook rules. Synthesis
   resolves them into keep/discard. (TradingAgents adaptation — see
   planning/inspiration/TradingAgents.md)
   ============================================ */
const COUNCIL_ROLE_META = {
  yield: { label: 'Yield Analyst', glyph: '📈' },
  risk: { label: 'Risk Analyst', glyph: '⚠️' },
  market: { label: 'Market Analyst', glyph: '🌊' },
};
const COUNCIL_SIGNAL_TONE = {
  DEPOSIT: 'var(--ok)',
  HOLD: 'var(--warn, #c87)',
  WITHDRAW: 'var(--bad, #ff7479)',
};
const COUNCIL_RESOLVED_LABEL = {
  veto: 'risk veto',
  unanimous: 'unanimous',
  weighted: 'weighted majority',
  'ai-conflict': 'AI synthesis (split)',
};

const CouncilPanel = ({ council, onRetry }) => {
  if (council === undefined) return null;
  const loading = council === null;
  const unavailable = !loading && council.verdict === 'unavailable';
  const order = ['yield', 'risk', 'market'];
  const specialists = (loading || unavailable) ? [] : [...(council.specialists || [])].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const keep = !loading && council.verdict === 'keep';
  return (
    <div className="council-panel">
      <div className="council-head mono">
        <span className="council-title">AI Council · three specialists deliberating</span>
        {!loading && !unavailable && (
          <span className={`council-verdict ${keep ? 'keep' : 'discard'}`}>
            {keep ? 'proceed' : 'caution'} · {COUNCIL_RESOLVED_LABEL[council.resolvedBy] || council.resolvedBy}
          </span>
        )}
      </div>

      {loading ? (
        <div className="council-loading mono">
          <span className="think-spin" /> specialists analyzing yield · risk · market in parallel…
        </div>
      ) : unavailable ? (
        <div className="council-loading mono">
          Council unavailable — the AI provider didn’t respond.
          {onRetry && <button type="button" className="btn btn-ghost council-retry" onClick={onRetry}>Retry deliberation</button>}
        </div>
      ) : (
        <>
          <div className="council-grid">
            {specialists.map((s) => {
              const meta = COUNCIL_ROLE_META[s.role] || { label: s.role, glyph: '•' };
              return (
                <div key={s.role} className="council-spec">
                  <div className="council-spec-head mono">
                    <span className="council-spec-role">{meta.glyph} {meta.label}</span>
                    <span className="council-spec-signal" style={{ color: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }}>
                      {s.signal}
                    </span>
                  </div>
                  <div className="council-spec-conf mono">
                    <div className="council-conf-track"><div className="council-conf-fill" style={{ width: `${Math.round(s.confidence * 100)}%`, background: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }} /></div>
                    <span className="tnum">{Math.round(s.confidence * 100)}%</span>
                    <span className="council-spec-src ai">AI</span>
                  </div>
                  {s.citedRules?.length > 0 && (
                    <div className="council-rules">
                      {s.citedRules.map((id) => <span key={id} className="council-rule-chip mono">{id}</span>)}
                    </div>
                  )}
                  {s.concerns?.length > 0 && (
                    <div className="council-concerns mono">⚠ {s.concerns.join(' · ')}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="council-foot mono">
            {keep
              ? `Council recommends proceeding (${Math.round(council.confidence * 100)}% confidence). Cited rules earn outcome feedback after deposit.`
              : `Council advises caution${council.reason ? ` · ${council.reason}` : ''}. You can still proceed — the decision is yours.`}
          </div>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Render the panel in `StrategyCard`**

In `frontend/src/agents.jsx`, change the `StrategyCard` signature to accept `council` + `onCouncilRetry` (currently ends `attesting, simulation }) => {`):

```jsx
const StrategyCard = ({ strategy, skillSource, onProceed, onRegenerate, strategyHash, attestation, attesting, simulation, council, onCouncilRetry }) => {
```

Then insert `<CouncilPanel ... />` immediately BEFORE the existing `<SimulationPanel simulation={simulation} />` line (line ~529):

```jsx
      <CouncilPanel council={council} onRetry={onCouncilRetry} />

      <SimulationPanel simulation={simulation} />
```

- [ ] **Step 3: Append council styles**

Append to `frontend/style.css`:

```css
/* ── AI Council deliberation panel (strategy review) ───────────────────── */
.council-panel {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.council-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 11px;
}
.council-title { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
.council-verdict { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.council-verdict.keep { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 50%, transparent); }
.council-verdict.discard { color: var(--warn, #c87); border-color: color-mix(in oklab, var(--warn, #c87) 50%, transparent); }
.council-loading { padding: 16px 14px; font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.council-retry { margin-left: auto; font-size: 11px; padding: 3px 10px; }
.council-grid { display: grid; grid-template-columns: repeat(3, 1fr); }
.council-spec { padding: 12px 14px; border-right: 1px solid var(--border); }
.council-spec:last-child { border-right: none; }
.council-spec-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; margin-bottom: 8px; }
.council-spec-role { color: var(--text); }
.council-spec-signal { font-weight: 600; }
.council-spec-conf { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--text-muted); margin-bottom: 8px; }
.council-conf-track { flex: 1; height: 4px; border-radius: 999px; background: var(--border); overflow: hidden; }
.council-conf-fill { height: 100%; border-radius: 999px; }
.council-spec-src { font-size: 9px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); }
.council-spec-src.ai { color: var(--accent, #cfff3d); }
.council-rules { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.council-rule-chip { font-size: 9px; padding: 1px 6px; border-radius: 4px; background: rgba(127,127,127,0.12); color: var(--text-muted); }
.council-concerns { font-size: 10px; color: var(--warn, #c87); }
.council-foot { padding: 9px 14px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-muted); }
@media (max-width: 640px) {
  .council-grid { grid-template-columns: 1fr; }
  .council-spec { border-right: none; border-bottom: 1px solid var(--border); }
  .council-spec:last-child { border-bottom: none; }
}
```

- [ ] **Step 4: Verify the build still compiles**

Run: `cd frontend && npx vite build`
Expected: build succeeds with no errors referencing `agents.jsx` or `style.css`. (`CouncilPanel` renders `null` until wired in Task 5, so no runtime change yet.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agents.jsx frontend/style.css
git commit -m "feat: render AI Council deliberation panel in strategy review"
```

---

### Task 5: Wire the council into the wizard (app.jsx)

Run `councilReview` as an async effect when a strategy becomes ready (same data sources the simulation `useMemo` uses), feed the result to `StrategyCard`, and stash the verdict's `citedRules` in a ref so the post-deposit reflector (Task 6) can read them.

**Files:**
- Modify: `frontend/src/app.jsx`

- [ ] **Step 1: Add imports**

After the existing council/reflector imports (lines 58–60), add:

```jsx
import { councilReview, buildCouncilInput } from './strategy/councilReview.js';
import { councilSpecialistVerdict } from './venice.js';
```

- [ ] **Step 2: Add council state + a ref for cited rules**

Near the other strategy state (after `const [strategy, setStrategy] = useS(null);`, line ~166), add:

```jsx
  const [council, setCouncil] = useS(undefined);   // undefined = no strategy yet, null = deliberating
  const [councilRetry, setCouncilRetry] = useS(0);  // bump to re-run deliberation
  const councilCitedRef = useRef({ citedRules: [], verdict: null });
```

> `useRef` is already imported in app.jsx as `useR` per the file's aliasing convention — check the React import line at the top and use whatever alias is in scope (e.g. `useR`). If the alias is `useR`, write `const councilCitedRef = useR({ citedRules: [], verdict: null });`.

- [ ] **Step 3: Add the async council effect**

Immediately AFTER the `simulation` `useM(...)` block (ends line ~534), add:

```jsx
  // AI Council deliberation for the proposed allocation. Async (3 parallel AI
  // calls + possible synthesis call) so it runs as an effect, not a useMemo. Uses
  // the SAME live signals as the simulation panel. AI-only: each specialist retries
  // once; if the provider still fails, the council reports 'unavailable' and the
  // panel offers a retry — no fabricated verdict.
  useE(() => {
    if (!strategy?.agents?.length) { setCouncil(undefined); return; }
    let cancelled = false;
    setCouncil(null); // → panel shows "deliberating"
    const ctrl = new AbortController();
    const state = buildStrategyState({
      amountUsdc: Number(amount) || 0,
      riskLevel: risk,
      numVaults: strategy.agents.length,
      vaultData: VAULT_CATALOG,
      marketContext: marketLive,
      positions: agentData.positions,
      gas: latestGasRef.current,
    });
    const input = buildCouncilInput(strategy, state);
    councilReview(input, {
      specialist: councilSpecialistVerdict,
      resolveConflict: resolveCouncilConflict,
      weight: playbookWeight,
      devApiKey: devApiKey || null,
      signal: ctrl.signal,
    })
      .then((result) => {
        if (cancelled) return;
        setCouncil(result);
        councilCitedRef.current = { citedRules: result.citedRules || [], verdict: result.verdict };
        addLog({ event: 'OrchestratorPlanned', meta: `AI Council · ${result.verdict} · ${result.resolvedBy}${result.citedRules?.length ? ` · ${result.citedRules.join(', ')}` : ''}` });
      })
      .catch((e) => { if (!cancelled) { console.warn('[app] council failed:', e); setCouncil(undefined); } });
    return () => { cancelled = true; ctrl.abort(); };
  }, [strategy, amount, risk, councilRetry]);
```

`councilRetry` in the deps lets the panel's "Retry deliberation" button re-run the council without regenerating the whole strategy.

> If `addLog` is defined LATER than this effect in the component body, that is fine — it is a stable callback closed over by the effect. Confirm `buildStrategyState`, `VAULT_CATALOG`, `marketLive`, `agentData`, `latestGasRef`, `devApiKey`, `playbookWeight`, and `resolveCouncilConflict` are all already in scope here (they are — used by the adjacent `simulation` memo and monitor-loop effect).

- [ ] **Step 4: Pass the `council` prop to `StrategyCard`**

At the `StrategyCard` render (line ~1211), add `council={council}`:

```jsx
        return <StrategyCard strategy={strategy} skillSource={skillSource} onProceed={handleAcceptStrategy} onRegenerate={handleRegenerate} strategyHash={rawStrategy?.strategyHash} attestation={strategyAttestation} attesting={attesting} simulation={simulation} council={council} onCouncilRetry={() => setCouncilRetry((n) => n + 1)} />;
```

- [ ] **Step 5: Verify the dev build + manual smoke**

Run: `cd frontend && npx vite build`
Expected: build succeeds.

Then start the dev server and confirm visually (use the preview workflow):
1. `/strategy` → enter an amount, pick a risk level, submit.
2. After the strategy card appears, the **AI Council** panel shows "deliberating" then resolves to three specialist cards (each with a signal, confidence bar, `AI` tag, and rule chips) plus a synthesis verdict line — sitting directly above the Simulation panel. (If the provider is down, it shows "Council unavailable" with a Retry button instead.)
3. Check the console: an `AI Council · keep|discard · <resolvedBy>` log line appears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: run AI Council on the proposed strategy and surface it in review"
```

---

### Task 6: Close the ACE loop — reflect after deposit

After the deposit executes, increment the council's cited rules in the playbook: helpful if any agent confirmed, harmful if all failed. A tiny pure helper makes the outcome decision testable.

**Files:**
- Modify: `frontend/src/app.jsx` (extract `councilOutcome`, call `reflect` in `handleExecDone`)
- Create: `frontend/src/strategy/outcome.js` + `frontend/src/strategy/outcome.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/outcome.test.js
import { describe, it, expect } from 'vitest'
import { councilOutcome } from './outcome.js'

const agents = [{ id: 'w1' }, { id: 'w2' }]

describe('councilOutcome', () => {
  it('returns success when at least one agent confirmed', () => {
    expect(councilOutcome({ w1: { status: 'confirmed' }, w2: { status: 'failed' } }, agents)).toBe('success')
  })
  it('returns failure when all agents failed', () => {
    expect(councilOutcome({ w1: { status: 'failed' }, w2: { status: 'failed' } }, agents)).toBe('failure')
  })
  it('returns failure when nothing confirmed (idle/missing)', () => {
    expect(councilOutcome({}, agents)).toBe('failure')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/outcome.test.js`
Expected: FAIL — "Failed to resolve import './outcome.js'".

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/outcome.js
// Maps post-execution agent state to a single council outcome for the reflector.
// 'success' if any worker confirmed its deposit; 'failure' otherwise. Pure.

/**
 * @param {Object} execMap  { agentId: { status: 'idle'|'running'|'confirmed'|'failed' } }
 * @param {Array<{id:string}>} agents
 * @returns {'success'|'failure'}
 */
export function councilOutcome(execMap, agents) {
  const confirmed = (agents || []).some((a) => execMap?.[a.id]?.status === 'confirmed')
  return confirmed ? 'success' : 'failure'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/outcome.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `reflect` into `handleExecDone`**

In `frontend/src/app.jsx`, add the import after the council imports:

```jsx
import { councilOutcome } from './strategy/outcome.js';
```

Then in `handleExecDone` (line ~1043), immediately AFTER `setStage("done");` (line 1044), add:

```jsx
    // ACE loop: credit/debit the rules the council cited at review time, based on
    // how the deposit actually went. Closes review → deposit → reflect end-to-end.
    const { citedRules, verdict } = councilCitedRef.current;
    if (verdict === 'keep' && citedRules.length) {
      const outcome = councilOutcome(execMap, strategy?.agents || []);
      reflect({ verdict, citedRules, outcome }, { increment: playbookIncrement });
      addLog({ event: 'OrchestratorPlanned', meta: `Council reflect · ${outcome} · ${citedRules.join(', ')}` });
    }
```

> `reflect` and `playbookIncrement` are already imported (lines 59–60). `execMap` and `strategy` are in scope in `handleExecDone`.

- [ ] **Step 6: Verify build + full test run**

Run: `cd frontend && npx vite build`
Expected: build succeeds.

Run: `cd frontend && npx vitest run`
Expected: all suites pass (playbookRules, venice, councilReview, outcome, plus the existing suites — no regressions).

- [ ] **Step 7: Manual end-to-end smoke**

Start the dev server and:
1. `/strategy` → submit a calm/low-risk strategy → Council shows a **keep** verdict with cited rules.
2. Proceed through connect → skills → permission → execute → done.
3. In the browser console run `JSON.parse(localStorage.getItem('yv_playbook'))` and confirm the council's cited rule ids now have incremented `helpful` counts.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app.jsx frontend/src/strategy/outcome.js frontend/src/strategy/outcome.test.js
git commit -m "feat: reflect AI Council cited rules into playbook after deposit"
```

---

## Self-Review

**1. Spec coverage** (against the AI Council narrative):
- "tiga specialist agents jalan parallel" → Task 3 `councilReview` runs 3 roles via `Promise.all`. ✅
- "setiap satu punya system prompt dan data yang benar-benar berbeda" → Task 3 `ROLE_SYSTEM` (3 distinct prompts) + `buildSpecialistPrompt` (3 distinct data slices). ✅
- "subset playbook yang relevan untuk role-nya" → Task 1 `ROLE_RULES` + per-role rule list injected into each prompt. ✅
- "Output-nya compressed verdict, bukan free-text" → Task 2 `parseSpecialistVerdict` enforces `{signal, confidence, citedRules, concerns}` JSON. ✅
- "Setiap verdict harus include `citedRules`" → enforced + validated against the role's allowed ids. ✅
- "memungkinkan Reflector mengupdate counters-nya nanti" → Task 6 `reflect()` after deposit. ✅
- Poros tetap di `/strategy` → all user-visible behavior lands in the `StrategyCard` review (Task 4) + wizard wiring (Task 5); the autonomous-loop `council.js` is untouched. ✅
- Single-round parallel (per TradingAgents.md §6.7 "AI Council currently uses single-round parallel verdict") — matched; multi-round debate explicitly out of scope. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step ships complete code. The one stub (`ruleLines`) is explicitly removed in Task 3 Step 4. ✅

**3. Type consistency:**
- `SpecialistVerdict` shape is produced only by `parseSpecialistVerdict` (Task 2, `source:'ai'`); consumed by `synthesize`, `councilReview`, and `CouncilPanel`. ✅
- `councilReview` returns the `CouncilResult` shape (incl. `verdict:'unavailable'` / `resolvedBy:'unavailable'`) consumed by `CouncilPanel` (handles loading/unavailable/keep/discard) and by the app effect (`citedRules`, `verdict`). ✅
- `councilSpecialistVerdict({role, systemPrompt, userPrompt, allowedRuleIds, devApiKey, signal})` — the exact signature `councilReview`'s `specialist` dep is called with (Task 3) and the exact signature implemented in Task 2. ✅
- `reflect({verdict, citedRules, outcome}, {increment})` matches the existing `reflector.js` contract (verified against current source). ✅
- `councilOutcome(execMap, agents)` returns `'success'|'failure'`, the exact union `reflect` maps to helpful/harmful. ✅

**Risk notes for the implementer:**
- React hook aliases: app.jsx aliases hooks (`useS`, `useE`, `useM`, and likely `useR`/`useRef`). Use the alias already in scope — Task 5 Step 2 calls this out.
- The council effect deps `[strategy, amount, risk]` mirror the simulation memo so both recompute together on regenerate.
- Venice calls go through the keyless server proxy (`resolveProvider(null, devApiKey)`), consistent with `classifyRisk`/`resolveCouncilConflict`; no wallet auth needed at step 01.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-10-ai-council-strategy-wizard.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

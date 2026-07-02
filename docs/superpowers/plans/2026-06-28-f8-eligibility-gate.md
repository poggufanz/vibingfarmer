# F8 Pre-Execution Risk Eligibility Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, fail-closed eligibility gate that filters out ponzi/unaudited vaults before any deposit, surfaces a fused "real-yield + security + max-loss" verdict in the approval card, and keeps the human approve/decline action genuinely blocking dispatch.

**Architecture:** A pure decision module (`eligibilityGate.js`) scores already-resolved facts; a snapshot-first data layer (`vaultFacts.js` + `vaultFactsSnapshot.js`) supplies those facts with provenance and never live-calls on the demo path. Enforcement A (machine basket filter) runs inside `app.jsx startExecution` before `orch.dispatch`; the existing PermissionCard approve/decline stays the human tooth. Slice 2 adds a worker-side token assertion and an off-stage refresh script.

**Tech Stack:** React 18 + Vite 5, Vitest, plain ESM `.js`/`.jsx`, BigInt for base units. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-28-f8-eligibility-gate-design.md` — every task implicitly inherits its §5 constants, §6 two-context rule, §12 honesty rules.
- **Named constants only — no magic numbers.** `PONZI_RATIO_MAX=1.5`, `SECURITY_MIN=60`, `AGE_CAP_DAYS=180`, `TVL_FLOOR=100_000`, `TVL_CAP=100_000_000`, `AGE_WEIGHT=0.30`, `TVL_WEIGHT=0.40`, `ADMIN_WEIGHT=0.30` (assert sum === 1.0), `ADMIN_LEVELS={timelock_multisig:1.0,multisig:0.7,timelock:0.5,eoa:0.0}`, `MAX_FACT_AGE_MS=30*86400_000`, `MAX_TOKEN_AGE_MS=15*60_000`, `REQUIRED_FACTS=['annualizedDistributed','protocolRevenue','audit','ageDays','tvl','adminKey']`.
- **Fail-closed:** missing OR stale OR unverifiable fact ⇒ reject. Both Test-1 operands must be positive verified numbers. Audit is a **hard gate** (`audit !== 'audited'` ⇒ reject). Strict `<` at the ponzi boundary (equality ⇒ ponzi).
- **Honesty (must hold in every surfaced string):** never a bare "yield is real" / "real yield" — use `"Mainnet distributions revenue-covered (ratio <r>)"`. The mainnet yield label may never render without the **testnet caveat** beside it. Security score always renders with the `"— our weighting"` qualifier. Always "target", never "guaranteed". The HyperFarm fixture carries `isFixture:true` and a `"demo fixture — illustrates rejection"` label; never reportable as a real-world catch.
- **Naming:** "Lapis/Layer 1–3" = the three thesis protection layers ONLY. F8's internal points are "Enforcement A/B" + "the human gate".
- **Test runner:** `cd frontend && npx vitest run <path>` for one file; `cd frontend && npm test` for all.
- **Decimals:** base unit is 7-dp (`SOROBAN_DECIMALS=7`); deposit amounts are BigInt base units.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/strategy/eligibilityGate.js` (create) | Pure: constants, `fitFacts`, `allRequiredFactsPresent`, `yieldReality`, `securityScore`, `evaluate`. No I/O. |
| `frontend/src/strategy/vaultFactsSnapshot.js` (create) | Dated, sourced static facts keyed by protocol slug (4 catalog protocols + `hyperfarm` fixture). |
| `frontend/src/strategy/vaultFacts.js` (create) | `resolve(protocol)` → facts; snapshot-first, no live call on demo path. |
| `frontend/src/strategy/eligibilitySentence.js` (create) | Pure: `buildEligibilitySentence(verdict)` + `vaultEligibilityLabel(verdict)` — honesty-compliant display strings. |
| `frontend/src/strategy/basketFilter.js` (create) | Pure: `filterBasket(agents, verdictBySlug)` → `{survivors, dropped, allFailed}` with re-normalized allocations. |
| `frontend/src/app.jsx` (modify ~1161 `startExecution`) | Enforcement A host: compute verdicts, filter, re-normalize, all-fail hard stop, dispatch only survivors. |
| `frontend/src/screens.jsx` (modify `PermissionCard` ~371 / `MmPermissionModal` ~470) | Eligibility panel: per-protocol PASS/REJECT, two-context lines, provenance chip, struck-through rejects, fixture label. |
| `frontend/src/worker.js` (modify ~25 ctor / ~91–92) | **Slice 2:** accept + assert eligibility token before `runAgentDeposit`. |
| `frontend/src/orchestrator.js` (modify ~45 `vaultPlans` / ~99 worker ctor) | **Slice 2:** thread `protocolSlug` + `eligibilityToken` by plan index. |
| `frontend/scripts/refreshVaultFacts.mjs` (create) | **Slice 2:** off-stage DeFiLlama refresh; provenance integrity. |

---

# SLICE 1 — MVP-for-innovation (build first, ship green)

## Task 1: eligibilityGate constants + fact presence/staleness

**Files:**
- Create: `frontend/src/strategy/eligibilityGate.js`
- Test: `frontend/src/strategy/eligibilityGate.test.js`

**Interfaces:**
- Produces: all Global-Constraints constants (named exports); `factPresent(field, nowMs) => boolean`; `allRequiredFactsPresent(facts, nowMs) => boolean`. A fact field is `{ value, source:'live'|'snapshot', asOf:number }` (asOf = epoch ms).

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/eligibilityGate.test.js
import { describe, it, expect } from 'vitest'
import {
  REQUIRED_FACTS, AGE_WEIGHT, TVL_WEIGHT, ADMIN_WEIGHT,
  MAX_FACT_AGE_MS, factPresent, allRequiredFactsPresent,
} from './eligibilityGate.js'

const NOW = 1_900_000_000_000
const fresh = (value) => ({ value, source: 'snapshot', asOf: NOW - 1000 })
const fullFacts = () => Object.fromEntries(REQUIRED_FACTS.map((k) => [k, fresh(1)]))

describe('weights + presence', () => {
  it('security weights sum to 1.0', () => {
    expect(AGE_WEIGHT + TVL_WEIGHT + ADMIN_WEIGHT).toBe(1.0)
  })
  it('a fresh present field is present', () => {
    expect(factPresent(fresh(5), NOW)).toBe(true)
  })
  it('a null value is absent', () => {
    expect(factPresent({ value: null, source: 'snapshot', asOf: NOW }, NOW)).toBe(false)
  })
  it('a stale field (older than MAX_FACT_AGE) is absent', () => {
    expect(factPresent({ value: 5, source: 'snapshot', asOf: NOW - MAX_FACT_AGE_MS - 1 }, NOW)).toBe(false)
  })
  it('allRequiredFactsPresent: each required fact absent ALONE fails', () => {
    for (const k of REQUIRED_FACTS) {
      const f = fullFacts(); f[k] = { value: null, source: 'snapshot', asOf: NOW }
      expect(allRequiredFactsPresent(f, NOW)).toBe(false)
    }
    expect(allRequiredFactsPresent(fullFacts(), NOW)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: FAIL — "does not provide an export named 'REQUIRED_FACTS'".

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/eligibilityGate.js
// Pure, deterministic, fail-closed eligibility gate (F8). No I/O — all facts arrive resolved.
// A fact field is { value, source: 'live'|'snapshot', asOf: epochMs }.

export const PONZI_RATIO_MAX = 1.5
export const SECURITY_MIN = 60
export const AGE_CAP_DAYS = 180
export const TVL_FLOOR = 100_000
export const TVL_CAP = 100_000_000
export const AGE_WEIGHT = 0.30
export const TVL_WEIGHT = 0.40
export const ADMIN_WEIGHT = 0.30
export const ADMIN_LEVELS = { timelock_multisig: 1.0, multisig: 0.7, timelock: 0.5, eoa: 0.0 }
export const MAX_FACT_AGE_MS = 30 * 86_400_000
export const MAX_TOKEN_AGE_MS = 15 * 60_000
export const REQUIRED_FACTS = [
  'annualizedDistributed', 'protocolRevenue', 'audit', 'ageDays', 'tvl', 'adminKey',
]

/** A fact field is present iff it has a non-null value and is not stale. */
export function factPresent(field, nowMs) {
  if (!field || field.value == null) return false
  if (typeof field.asOf !== 'number') return false
  return nowMs - field.asOf <= MAX_FACT_AGE_MS
}

export function allRequiredFactsPresent(facts, nowMs) {
  return REQUIRED_FACTS.every((k) => factPresent(facts?.[k], nowMs))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/eligibilityGate.js frontend/src/strategy/eligibilityGate.test.js
git commit -m "feat: eligibility gate constants + fail-closed fact presence/staleness"
```

---

## Task 2: yieldReality test (Test 1 — ponzi check, symmetric unknown)

**Files:**
- Modify: `frontend/src/strategy/eligibilityGate.js`
- Test: `frontend/src/strategy/eligibilityGate.test.js`

**Interfaces:**
- Produces: `yieldReality(facts) => { ratio:number|null, verdict:'real'|'ponzi'|'unknown', inputs }`. Reads `facts.annualizedDistributed.value` and `facts.protocolRevenue.value` (raw numbers).

- [ ] **Step 1: Write the failing test (append to the test file)**

```js
import { yieldReality } from './eligibilityGate.js'

describe('yieldReality (Test 1)', () => {
  const ff = (dist, rev) => ({
    annualizedDistributed: { value: dist, source: 'snapshot', asOf: 0 },
    protocolRevenue: { value: rev, source: 'snapshot', asOf: 0 },
  })
  it('ratio < 1.5 => real (Blend ~1.0)', () => {
    expect(yieldReality(ff(1_000_000, 1_050_000)).verdict).toBe('real')
  })
  it('ratio >= 1.5 => ponzi (fixture 3.33)', () => {
    expect(yieldReality(ff(10_000_000, 3_000_000)).verdict).toBe('ponzi')
  })
  it('boundary ratio === 1.5 => ponzi (strict <)', () => {
    expect(yieldReality(ff(150, 100)).verdict).toBe('ponzi')
  })
  it('missing/<=0 distributed => unknown (symmetric)', () => {
    expect(yieldReality(ff(0, 100)).verdict).toBe('unknown')
    expect(yieldReality(ff(null, 100)).verdict).toBe('unknown')
  })
  it('missing/<=0 revenue => unknown', () => {
    expect(yieldReality(ff(100, 0)).verdict).toBe('unknown')
    expect(yieldReality(ff(100, null)).verdict).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: FAIL — "yieldReality is not a function".

- [ ] **Step 3: Write minimal implementation (append to eligibilityGate.js)**

```js
function pos(field) {
  const v = field?.value
  return typeof v === 'number' && v > 0 ? v : null
}

/** Test 1 — closes problem #5 (ponzi APY). Both operands must be positive verified numbers. */
export function yieldReality(facts) {
  const dist = pos(facts?.annualizedDistributed)
  const rev = pos(facts?.protocolRevenue)
  if (dist == null || rev == null) {
    return { ratio: null, verdict: 'unknown', inputs: { dist, rev } }
  }
  const ratio = dist / rev
  return { ratio, verdict: ratio < PONZI_RATIO_MAX ? 'real' : 'ponzi', inputs: { dist, rev } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/eligibilityGate.js frontend/src/strategy/eligibilityGate.test.js
git commit -m "feat: yield-reality ponzi test with symmetric fail-closed unknown"
```

---

## Task 3: securityScore test (Test 2 — audit hard-gate + named curves)

**Files:**
- Modify: `frontend/src/strategy/eligibilityGate.js`
- Test: `frontend/src/strategy/eligibilityGate.test.js`

**Interfaces:**
- Produces: `securityScore(facts) => { score:0..100, auditGate:'pass'|'fail', components:{age,tvl,adminKey} }`. Reads `facts.audit.value` ('audited'|'none'|...), `facts.ageDays.value`, `facts.tvl.value`, `facts.adminKey.value` (a key of `ADMIN_LEVELS`).

- [ ] **Step 1: Write the failing test (append)**

```js
import { securityScore } from './eligibilityGate.js'

describe('securityScore (Test 2)', () => {
  const sf = (audit, ageDays, tvl, adminKey) => ({
    audit: { value: audit, source: 'snapshot', asOf: 0 },
    ageDays: { value: ageDays, source: 'snapshot', asOf: 0 },
    tvl: { value: tvl, source: 'snapshot', asOf: 0 },
    adminKey: { value: adminKey, source: 'snapshot', asOf: 0 },
  })
  it('audited + mature + large TVL + timelock_multisig => high score, audit passes', () => {
    const r = securityScore(sf('audited', 365, 25_000_000, 'timelock_multisig'))
    expect(r.auditGate).toBe('pass')
    expect(r.score).toBeGreaterThanOrEqual(60)
  })
  it('fixture: unaudited 4-day tiny-TVL eoa => audit fails, score 1', () => {
    const r = securityScore(sf('none', 4, 50_000, 'eoa'))
    expect(r.auditGate).toBe('fail')
    expect(r.score).toBe(1) // round(100 * (0.30*(4/180) + 0.40*0 + 0.30*0))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: FAIL — "securityScore is not a function".

- [ ] **Step 3: Write minimal implementation (append)**

```js
const clamp01 = (x) => Math.max(0, Math.min(1, x))

/** Test 2 — closes problem #4 (exploit/hack). Audit is a HARD gate; score grades the rest. */
export function securityScore(facts) {
  const auditGate = facts?.audit?.value === 'audited' ? 'pass' : 'fail'
  const ageSig = clamp01((facts?.ageDays?.value ?? 0) / AGE_CAP_DAYS)
  const tvl = facts?.tvl?.value ?? 0
  const tvlSig =
    tvl <= 0
      ? 0
      : clamp01(
          (Math.log10(tvl) - Math.log10(TVL_FLOOR)) /
            (Math.log10(TVL_CAP) - Math.log10(TVL_FLOOR))
        )
  const adminSig = ADMIN_LEVELS[facts?.adminKey?.value] ?? 0
  const score = Math.round(100 * (AGE_WEIGHT * ageSig + TVL_WEIGHT * tvlSig + ADMIN_WEIGHT * adminSig))
  return { score, auditGate, components: { age: ageSig, tvl: tvlSig, adminKey: adminSig } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/eligibilityGate.js frontend/src/strategy/eligibilityGate.test.js
git commit -m "feat: security-score with audit hard-gate and named normalization curves"
```

---

## Task 4: evaluate() combine → verdict

**Files:**
- Modify: `frontend/src/strategy/eligibilityGate.js`
- Test: `frontend/src/strategy/eligibilityGate.test.js`

**Interfaces:**
- Consumes: `allRequiredFactsPresent`, `yieldReality`, `securityScore`.
- Produces: `evaluate(input, nowMs) => verdict` where `input = { protocol, isFixture?, facts }` and `verdict = { protocol, eligible, yieldReality, security, reasons:string[], isFixture:boolean, facts }`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { evaluate } from './eligibilityGate.js'

const NOW2 = 1_900_000_000_000
const mk = (over = {}) => ({
  annualizedDistributed: { value: 1_000_000, source: 'snapshot', asOf: NOW2 },
  protocolRevenue: { value: 1_050_000, source: 'snapshot', asOf: NOW2 },
  audit: { value: 'audited', source: 'snapshot', asOf: NOW2 },
  ageDays: { value: 365, source: 'snapshot', asOf: NOW2 },
  tvl: { value: 25_000_000, source: 'snapshot', asOf: NOW2 },
  adminKey: { value: 'timelock_multisig', source: 'snapshot', asOf: NOW2 },
  ...over,
})

describe('evaluate (combine)', () => {
  it('Blend-like facts => eligible', () => {
    expect(evaluate({ protocol: 'blend', facts: mk() }, NOW2).eligible).toBe(true)
  })
  it('fixture => ineligible with both reasons', () => {
    const v = evaluate({
      protocol: 'hyperfarm', isFixture: true,
      facts: mk({
        audit: { value: 'none', source: 'snapshot', asOf: NOW2 },
        ageDays: { value: 4, source: 'snapshot', asOf: NOW2 },
        tvl: { value: 50_000, source: 'snapshot', asOf: NOW2 },
        adminKey: { value: 'eoa', source: 'snapshot', asOf: NOW2 },
        annualizedDistributed: { value: 10_000_000, source: 'snapshot', asOf: NOW2 },
        protocolRevenue: { value: 3_000_000, source: 'snapshot', asOf: NOW2 },
      }),
    }, NOW2)
    expect(v.eligible).toBe(false)
    expect(v.isFixture).toBe(true)
    expect(v.reasons.join(' ')).toMatch(/unaudited/i)
    expect(v.reasons.join(' ')).toMatch(/ratio 3\.3/)
  })
  it('missing fact => fail-closed reject', () => {
    const v = evaluate({ protocol: 'x', facts: mk({ protocolRevenue: { value: null, source: 'snapshot', asOf: NOW2 } }) }, NOW2)
    expect(v.eligible).toBe(false)
  })
  it('echoes provenance', () => {
    const v = evaluate({ protocol: 'blend', facts: mk() }, NOW2)
    expect(v.facts.tvl.source).toBe('snapshot')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: FAIL — "evaluate is not a function".

- [ ] **Step 3: Write minimal implementation (append)**

```js
/** Combine the two tests into a fail-closed verdict. nowMs defaults to Date.now() in production. */
export function evaluate(input, nowMs = Date.now()) {
  const { protocol, facts, isFixture = false } = input
  const reasons = []
  const present = allRequiredFactsPresent(facts, nowMs)
  if (!present) reasons.push('missing or stale required data')
  const yr = yieldReality(facts)
  if (yr.verdict === 'ponzi') reasons.push(`yield/revenue ratio ${yr.ratio.toFixed(2)} (ponzi >= ${PONZI_RATIO_MAX})`)
  if (yr.verdict === 'unknown') reasons.push('yield/revenue unverifiable')
  const sec = securityScore(facts)
  if (sec.auditGate === 'fail') reasons.push('unaudited (audit gate)')
  if (sec.score < SECURITY_MIN) reasons.push(`security ${sec.score}/100 below ${SECURITY_MIN}`)
  const eligible =
    present && yr.verdict === 'real' && sec.auditGate === 'pass' && sec.score >= SECURITY_MIN
  return { protocol, eligible, yieldReality: yr, security: sec, reasons, isFixture, facts }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilityGate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/eligibilityGate.js frontend/src/strategy/eligibilityGate.test.js
git commit -m "feat: eligibility verdict combine — fail-closed, reasons, fixture flag"
```

---

## Task 5: vaultFactsSnapshot + vaultFacts.resolve

**Files:**
- Create: `frontend/src/strategy/vaultFactsSnapshot.js`
- Create: `frontend/src/strategy/vaultFacts.js`
- Test: `frontend/src/strategy/vaultFacts.test.js`

**Interfaces:**
- Produces: `SNAPSHOT` (object keyed by protocol slug → `{ facts, meta:{label?,isFixture?} }`); `resolve(protocol, nowMs?) => { protocol, isFixture, facts }`. Slugs match `VAULT_CATALOG[].protocol` (`aave-v3`, `morpho-blue`, `pendle-v2`, `fluid`) plus `hyperfarm`.
- Note: facts `asOf` uses a fixed captured timestamp constant (NOT `Date.now()` — provenance must be the capture date). **Before demo, replace placeholder values with captured DeFiLlama mainnet numbers and update `CAPTURED_AT`.**

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/vaultFacts.test.js
import { describe, it, expect } from 'vitest'
import { resolve, SNAPSHOT } from './vaultFacts.js'
import { evaluate } from './eligibilityGate.js'

const NOW = 1_790_000_000_000 // close to capture date so snapshot is fresh

describe('vaultFacts', () => {
  it('resolves a known protocol with provenance', () => {
    const r = resolve('aave-v3')
    expect(r.facts.tvl.source).toBe('snapshot')
    expect(typeof r.facts.tvl.asOf).toBe('number')
  })
  it('an audited catalog protocol is eligible', () => {
    expect(evaluate(resolve('aave-v3'), NOW).eligible).toBe(true)
  })
  it('the hyperfarm fixture is flagged and rejected', () => {
    const r = resolve('hyperfarm')
    expect(r.isFixture).toBe(true)
    expect(evaluate(r, NOW).eligible).toBe(false)
  })
  it('unknown protocol throws (caller maps to reject)', () => {
    expect(() => resolve('nope')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/vaultFacts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/vaultFactsSnapshot.js
// Dated, sourced eligibility facts. PLACEHOLDER mainnet values — replace with captured DeFiLlama
// numbers + update CAPTURED_AT before the demo (see plan §14 / refreshVaultFacts.mjs). Provenance
// honesty: asOf is the CAPTURE date, never Date.now().
export const CAPTURED_AT = Date.parse('2026-06-28T00:00:00Z')

const f = (value) => ({ value, source: 'snapshot', asOf: CAPTURED_AT })

// Audited lending protocols (catalog universe). Distributions ~ revenue => ratio ~1 => real.
const audited = (over) => ({
  annualizedDistributed: f(1_000_000),
  protocolRevenue: f(1_050_000),
  audit: f('audited'),
  ageDays: f(365),
  tvl: f(25_000_000),
  adminKey: f('timelock_multisig'),
  ...over,
})

export const SNAPSHOT = {
  'aave-v3': { facts: audited(), meta: { label: 'Aave v3 (mainnet)' } },
  'morpho-blue': { facts: audited({ tvl: f(12_000_000), adminKey: f('multisig') }), meta: { label: 'Morpho Blue (mainnet)' } },
  'pendle-v2': { facts: audited({ ageDays: f(540), tvl: f(8_000_000) }), meta: { label: 'Pendle (mainnet)' } },
  'fluid': { facts: audited({ tvl: f(5_000_000), adminKey: f('multisig') }), meta: { label: 'Fluid (mainnet)' } },
  // Controlled demo fixture — illustrates rejection. NOT a real vault.
  'hyperfarm': {
    facts: {
      annualizedDistributed: f(10_000_000),
      protocolRevenue: f(3_000_000),
      audit: f('none'),
      ageDays: f(4),
      tvl: f(50_000),
      adminKey: f('eoa'),
    },
    meta: { isFixture: true, label: 'demo fixture — illustrates rejection' },
  },
}
```

```js
// frontend/src/strategy/vaultFacts.js
// Data layer for the eligibility gate. Snapshot-first: NO live third-party call on the demo path.
// (Slice 2 adds an off-stage refresh script that updates the snapshot module, never a live call here.)
import { SNAPSHOT } from './vaultFactsSnapshot.js'

/** @returns {{ protocol:string, isFixture:boolean, facts:object }} */
export function resolve(protocol) {
  const entry = SNAPSHOT[protocol]
  if (!entry) throw new Error(`no eligibility facts for protocol: ${protocol}`)
  return { protocol, isFixture: !!entry.meta?.isFixture, facts: entry.facts }
}

export { SNAPSHOT }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/vaultFacts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/vaultFactsSnapshot.js frontend/src/strategy/vaultFacts.js frontend/src/strategy/vaultFacts.test.js
git commit -m "feat: snapshot-first vault facts data layer with provenance + demo fixture"
```

---

## Task 6: basketFilter (pure) — drop, re-normalize, all-fail

**Files:**
- Create: `frontend/src/strategy/basketFilter.js`
- Test: `frontend/src/strategy/basketFilter.test.js`

**Interfaces:**
- Consumes: verdicts from `evaluate`.
- Produces: `filterBasket(agents, verdictBySlug) => { survivors, dropped, allFailed }`. `agents` = `strategy.agents` items, each `{ id, allocation, vault:{ protocol, addr, ... } }`. `survivors` carry a re-normalized `allocationFraction` summing to 1; `dropped` carry `{ agent, verdict }`.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/basketFilter.test.js
import { describe, it, expect } from 'vitest'
import { filterBasket } from './basketFilter.js'

const agent = (id, protocol, allocation) => ({ id, allocation, vault: { protocol, addr: 'C...' } })
const V = (eligible) => ({ eligible })

describe('filterBasket', () => {
  it('drops ineligible and re-normalizes survivors to sum 1', () => {
    const agents = [agent('w1', 'aave-v3', 50), agent('w2', 'hyperfarm', 50)]
    const r = filterBasket(agents, { 'aave-v3': V(true), hyperfarm: V(false) })
    expect(r.allFailed).toBe(false)
    expect(r.survivors).toHaveLength(1)
    expect(r.survivors[0].allocationFraction).toBeCloseTo(1.0, 6)
    expect(r.dropped[0].agent.id).toBe('w2')
  })
  it('all ineligible => allFailed, no survivors', () => {
    const agents = [agent('w1', 'hyperfarm', 100)]
    const r = filterBasket(agents, { hyperfarm: V(false) })
    expect(r.allFailed).toBe(true)
    expect(r.survivors).toHaveLength(0)
  })
  it('survivor fractions are proportional to original allocation', () => {
    const agents = [agent('w1', 'aave-v3', 30), agent('w2', 'morpho-blue', 10), agent('w3', 'hyperfarm', 60)]
    const r = filterBasket(agents, { 'aave-v3': V(true), 'morpho-blue': V(true), hyperfarm: V(false) })
    expect(r.survivors.find((s) => s.id === 'w1').allocationFraction).toBeCloseTo(0.75, 6)
    expect(r.survivors.reduce((a, s) => a + s.allocationFraction, 0)).toBeCloseTo(1.0, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/basketFilter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/basketFilter.js
// Enforcement A core (pure). Drops ineligible protocols, re-normalizes survivor allocations to
// sum 1, and reports all-fail so the caller can hard-stop before dispatch.
export function filterBasket(agents, verdictBySlug) {
  const survivorsRaw = []
  const dropped = []
  for (const a of agents) {
    const verdict = verdictBySlug[a.vault.protocol]
    if (verdict && verdict.eligible) survivorsRaw.push(a)
    else dropped.push({ agent: a, verdict: verdict || { eligible: false, reasons: ['no verdict'] } })
  }
  const total = survivorsRaw.reduce((acc, a) => acc + a.allocation, 0)
  const survivors = survivorsRaw.map((a) => ({
    ...a,
    allocationFraction: total > 0 ? a.allocation / total : 0,
  }))
  return { survivors, dropped, allFailed: survivors.length === 0 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/basketFilter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/basketFilter.js frontend/src/strategy/basketFilter.test.js
git commit -m "feat: pure basket filter — drop ineligible, re-normalize, all-fail flag"
```

---

## Task 7: fused eligibility sentence + per-vault label (honesty-compliant)

**Files:**
- Create: `frontend/src/strategy/eligibilitySentence.js`
- Test: `frontend/src/strategy/eligibilitySentence.test.js`

**Interfaces:**
- Consumes: a verdict from `evaluate` plus a `ctx = { targetMaxLossPct:number, protocolLabel:string }`.
- Produces: `buildEligibilitySentence(verdict, ctx) => string` (the fused approval sentence); `vaultEligibilityLabel(verdict) => string` (per-row label). Both honesty-compliant.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/eligibilitySentence.test.js
import { describe, it, expect } from 'vitest'
import { buildEligibilitySentence, vaultEligibilityLabel } from './eligibilitySentence.js'

const verdict = {
  protocol: 'aave-v3', eligible: true,
  yieldReality: { ratio: 1.0, verdict: 'real' },
  security: { score: 92, auditGate: 'pass' },
  reasons: [], isFixture: false,
}
const ctx = { targetMaxLossPct: 5, protocolLabel: 'Aave v3 (mainnet)' }

describe('eligibility sentence honesty', () => {
  it('includes the mainnet revenue-covered phrasing with ratio', () => {
    expect(buildEligibilitySentence(verdict, ctx)).toMatch(/revenue-covered \(ratio 1\.0/)
  })
  it('co-emits the testnet caveat', () => {
    expect(buildEligibilitySentence(verdict, ctx)).toMatch(/testnet/i)
  })
  it('never says bare "yield is real" / "real yield"', () => {
    const s = buildEligibilitySentence(verdict, ctx)
    expect(s).not.toMatch(/yield is real/i)
    expect(s).not.toMatch(/real yield/i)
  })
  it('tags the score as our weighting and uses target not guaranteed', () => {
    const s = buildEligibilitySentence(verdict, ctx)
    expect(s).toMatch(/our weighting/i)
    expect(s).toMatch(/target max loss/i)
    expect(s).not.toMatch(/guaranteed/i)
  })
  it('label for a real verdict is ratio+context anchored', () => {
    expect(vaultEligibilityLabel(verdict)).toMatch(/revenue-covered \(ratio 1\.0\)/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilitySentence.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/eligibilitySentence.js
// Honesty-compliant display strings for the eligibility verdict (Slice 1 = display only).
// Rules (spec §6/§12): never bare "yield is real"; mainnet yield label always co-emits the testnet
// caveat; score carries "our weighting"; always "target", never "guaranteed".

function ratioPhrase(verdict) {
  const r = verdict.yieldReality?.ratio
  return `Mainnet distributions revenue-covered (ratio ${r != null ? r.toFixed(1) : '—'})`
}

/** The fused one-sentence approval line — the headline artifact. */
export function buildEligibilitySentence(verdict, ctx) {
  const yield_ = ratioPhrase(verdict)
  const sec = `Security ${verdict.security?.score}/100 (our weighting)`
  const loss = `Target max loss −${ctx.targetMaxLossPct}%`
  return `${yield_}, source DeFiLlama. This deposit is on testnet — APR illustrative. ${sec}. ${loss}. Proceed?`
}

/** Per-row label in the eligibility panel. */
export function vaultEligibilityLabel(verdict) {
  if (!verdict.eligible) return `Rejected: ${verdict.reasons.join('; ')}`
  return `${ratioPhrase(verdict)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilitySentence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/eligibilitySentence.js frontend/src/strategy/eligibilitySentence.test.js
git commit -m "feat: honesty-compliant fused eligibility sentence + per-vault label"
```

---

## Task 8: Enforcement A — wire the gate into startExecution (app.jsx)

**Files:**
- Modify: `frontend/src/app.jsx` (`startExecution`, ~1161–1183) and add an eligibility-state computation where the strategy enters the permission stage.
- Test: `frontend/src/strategy/enforcementA.test.js` (tests the extracted pure helper, not React).

**Interfaces:**
- Consumes: `resolve` (vaultFacts), `evaluate` (gate), `filterBasket`.
- Produces: a pure helper `computeBasket(agents, nowMs) => { verdictBySlug, survivors, dropped, allFailed }` exported from `basketFilter.js`, used by both the UI panel and `startExecution`.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/enforcementA.test.js
import { describe, it, expect } from 'vitest'
import { computeBasket } from './basketFilter.js'

const agent = (id, protocol, allocation) => ({ id, allocation, vault: { protocol, addr: 'C...' } })
const NOW = 1_790_000_000_000

describe('computeBasket (Enforcement A)', () => {
  it('aave passes, hyperfarm dropped', () => {
    const r = computeBasket([agent('w1', 'aave-v3', 50), agent('w2', 'hyperfarm', 50)], NOW)
    expect(r.verdictBySlug['aave-v3'].eligible).toBe(true)
    expect(r.verdictBySlug['hyperfarm'].eligible).toBe(false)
    expect(r.survivors.map((s) => s.id)).toEqual(['w1'])
    expect(r.allFailed).toBe(false)
  })
  it('unknown protocol => rejected (resolve throws => reject verdict), not a crash', () => {
    const r = computeBasket([agent('w1', 'nope', 100)], NOW)
    expect(r.verdictBySlug['nope'].eligible).toBe(false)
    expect(r.allFailed).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/enforcementA.test.js`
Expected: FAIL — "computeBasket is not a function".

- [ ] **Step 3: Write minimal implementation — append `computeBasket` to `basketFilter.js`**

```js
// append to frontend/src/strategy/basketFilter.js
import { resolve } from './vaultFacts.js'
import { evaluate } from './eligibilityGate.js'

/** Resolve facts + evaluate each agent's protocol (throw => reject), then filter. The Enforcement A entry. */
export function computeBasket(agents, nowMs = Date.now()) {
  const verdictBySlug = {}
  for (const a of agents) {
    const slug = a.vault.protocol
    try {
      verdictBySlug[slug] = evaluate(resolve(slug), nowMs)
    } catch (err) {
      verdictBySlug[slug] = { protocol: slug, eligible: false, reasons: [`facts unavailable: ${err.message}`], isFixture: false }
    }
  }
  const { survivors, dropped, allFailed } = filterBasket(agents, verdictBySlug)
  return { verdictBySlug, survivors, dropped, allFailed }
}
```

- [ ] **Step 4: Run the helper test — verify it passes**

Run: `cd frontend && npx vitest run src/strategy/enforcementA.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it into `startExecution` (app.jsx). Replace the `yvStrategy` build (lines ~1177–1183) with the gated version.**

Add the import near the other `strategy/` imports at the top of `app.jsx`:

```js
import { computeBasket } from './strategy/basketFilter.js'
```

Replace:

```js
    // Convert design strategy format → orchestrator's expected { vaults: [...] } format
    const yvStrategy = {
      vaults: strategy.agents.map((a) => ({
        address: a.vault.addr,
        allocation: a.allocation / strategy.total,
      })),
    }
```

with:

```js
    // Enforcement A — eligibility gate. Drop ineligible protocols BEFORE dispatch; all-fail = hard stop.
    const { survivors, dropped, allFailed } = computeBasket(strategy.agents)
    dropped.forEach((d) =>
      addLog({ event: 'VaultRejected', agent: d.agent.id, meta: (d.verdict.reasons || []).join('; ') })
    )
    if (allFailed) {
      addLog({ event: 'ExecutionBlocked', meta: 'No eligible vault — nothing will run.' })
      setStage('permission') // stay on the approval card; do NOT dispatch
      return
    }
    // dispatchSet ⊆ survivors: only survivors get a plan; allocations re-normalized to sum 1.
    const yvStrategy = {
      vaults: survivors.map((a) => ({ address: a.vault.addr, allocation: a.allocationFraction })),
    }
```

- [ ] **Step 6: Run the full suite + build to verify nothing regressed**

Run: `cd frontend && npm test`
Expected: PASS (existing + new).
Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/strategy/basketFilter.js frontend/src/strategy/enforcementA.test.js frontend/src/app.jsx
git commit -m "feat: Enforcement A — gate filters basket before dispatch, all-fail hard stop"
```

---

## Task 9: Eligibility panel UI + human-gate teeth test

**Files:**
- Modify: `frontend/src/screens.jsx` (`PermissionCard` ~371, `MmPermissionModal` ~470) to render the panel; `frontend/src/app.jsx` to pass `eligibility` (verdicts) into PermissionCard and confirm `onReject` does not start execution.
- Test: `frontend/src/strategy/humanGate.test.js` (pure decline-path proof).

**Interfaces:**
- Consumes: `computeBasket` output, `buildEligibilitySentence`, `vaultEligibilityLabel`.
- Produces: PermissionCard renders, for each agent, a row with PASS/REJECT, the per-vault label, the two-context lines for survivors (mainnet credibility + testnet caveat), a provenance chip (`DeFiLlama · asOf`), struck-through rejects with reasons, and the fixture's "demo fixture — illustrates rejection" label rendered inline.

- [ ] **Step 1: Write the failing test (decline keeps its teeth — pure model of the wiring)**

```js
// frontend/src/strategy/humanGate.test.js
import { describe, it, expect, vi } from 'vitest'

// Models the PermissionCard contract: onConfirm => startExecution; onReject => never.
function wirePermission({ onConfirm, onReject }) {
  return { confirm: () => onConfirm(), decline: () => onReject() }
}

describe('human gate teeth', () => {
  it('decline never calls startExecution', () => {
    const startExecution = vi.fn()
    const goBack = vi.fn()
    const card = wirePermission({ onConfirm: startExecution, onReject: goBack })
    card.decline()
    expect(startExecution).not.toHaveBeenCalled()
    expect(goBack).toHaveBeenCalledTimes(1)
  })
  it('confirm calls startExecution exactly once', () => {
    const startExecution = vi.fn()
    const card = wirePermission({ onConfirm: startExecution, onReject: vi.fn() })
    card.confirm()
    expect(startExecution).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/humanGate.test.js`
Expected: PASS-or-FAIL depending — this models the invariant; if it fails, the wiring contract is wrong. (Write it first as the guard, then ensure app.jsx honors it in Step 4.)

- [ ] **Step 3: Render the panel in `MmPermissionModal` (screens.jsx ~470).** Add an `eligibility` prop and render the rows above the confirm button. The confirm button keeps `onClick={onConfirm}`; the decline keeps `onReject`. Insert before the confirm `<button>` (~521):

```jsx
{eligibility?.rows?.length > 0 && (
  <div className="elig-panel">
    {eligibility.fusedSentence && <p className="elig-sentence">{eligibility.fusedSentence}</p>}
    <ul className="elig-rows">
      {eligibility.rows.map((row) => (
        <li key={row.id} className={row.eligible ? 'elig-pass' : 'elig-reject'}>
          <span className="elig-status">{row.eligible ? 'PASS' : 'REJECT'}</span>
          <span className={row.eligible ? '' : 'struck'}>{row.protocolLabel}</span>
          <span className="elig-label">{row.label}</span>
          {row.isFixture && <span className="elig-fixture">demo fixture — illustrates rejection</span>}
          {row.eligible && (
            <>
              <span className="elig-mainnet">{row.mainnetLine}</span>
              <span className="elig-testnet">{row.testnetLine}</span>
              <span className="elig-chip">DeFiLlama · asOf {row.asOf}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  </div>
)}
```

Thread the prop through `PermissionCard` (~371): add `eligibility` to its params and pass it to `<MmPermissionModal ... eligibility={eligibility} />` (~458).

- [ ] **Step 4: Build the `eligibility` view-model in app.jsx and pass it to PermissionCard.** Where PermissionCard is rendered, compute it from `computeBasket` (memoize on `strategy`):

```js
import { buildEligibilitySentence, vaultEligibilityLabel } from './strategy/eligibilitySentence.js'
import { SNAPSHOT } from './strategy/vaultFacts.js'

// inside the component, near other useMemo hooks:
const eligibility = useMemo(() => {
  if (!strategy?.agents) return null
  const { verdictBySlug, survivors } = computeBasket(strategy.agents)
  const firstSurvivor = survivors[0]
  const fusedSentence = firstSurvivor
    ? buildEligibilitySentence(verdictBySlug[firstSurvivor.vault.protocol], {
        targetMaxLossPct: 5,
        protocolLabel: SNAPSHOT[firstSurvivor.vault.protocol]?.meta?.label || firstSurvivor.vault.protocol,
      })
    : null
  const rows = strategy.agents.map((a) => {
    const v = verdictBySlug[a.vault.protocol]
    const asOf = new Date(a && SNAPSHOT[a.vault.protocol]?.facts?.tvl?.asOf || 0).toISOString().slice(0, 10)
    return {
      id: a.id,
      eligible: !!v?.eligible,
      isFixture: !!v?.isFixture,
      protocolLabel: SNAPSHOT[a.vault.protocol]?.meta?.label || a.vault.protocol,
      label: vaultEligibilityLabel(v),
      mainnetLine: `Protocol credibility: ${SNAPSHOT[a.vault.protocol]?.meta?.label} — audited, TVL from snapshot`,
      testnetLine: 'This deposit: testnet — APR illustrative, realized yield may be ~0',
      asOf,
    }
  })
  return { fusedSentence, rows }
}, [strategy])
```

Pass `eligibility={eligibility}` to `<PermissionCard ... />`. Confirm the decline handler wired to `onReject` does NOT call `startExecution` (it should only navigate back / reset the stage).

- [ ] **Step 5: Run the suite + build**

Run: `cd frontend && npx vitest run src/strategy/humanGate.test.js`
Expected: PASS.
Run: `cd frontend && npm test && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens.jsx frontend/src/app.jsx frontend/src/strategy/humanGate.test.js
git commit -m "feat: eligibility panel in approval card; human decline keeps blocking dispatch"
```

---

## Slice 1 verification gate

- [ ] Run `cd frontend && npm test` — all green.
- [ ] Run `cd frontend && npm run build` — succeeds.
- [ ] Manual: a basket containing `hyperfarm` shows it struck-through with the fixture label and reasons; an audited protocol shows PASS with the two-context lines + provenance chip; the fused sentence shows above the confirm button with no bare "yield is real" and a testnet caveat. Clicking decline returns to the card with no dispatch.

**STOP. Slice 1 banks the +6 Innovation headline. Build Slice 2 only if time remains.**

---

# SLICE 2 — Hardening (P2, only after Slice 1 is green)

## Task 10: mint eligibility token + thread protocolSlug through dispatch

**Files:**
- Modify: `frontend/src/strategy/eligibilityGate.js` (add `mintToken`), `frontend/src/app.jsx` (`startExecution` yvStrategy map), `frontend/src/orchestrator.js` (`vaultPlans` ~45, WorkerAgent ctor ~99).
- Test: `frontend/src/strategy/eligibilityToken.test.js`.

**Interfaces:**
- Produces: `mintToken(verdict, planIndex, nowMs?) => { protocolSlug, planIndex, eligible:true, verdictHash:string, asOf:number }`; `verifyToken(token, verdict, nowMs?) => boolean`. `verdictHash` = stable hash over `{protocol, yieldReality.verdict, security.score, security.auditGate}`.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/eligibilityToken.test.js
import { describe, it, expect } from 'vitest'
import { mintToken, verifyToken, MAX_TOKEN_AGE_MS } from './eligibilityGate.js'

const verdict = { protocol: 'aave-v3', eligible: true, yieldReality: { verdict: 'real' }, security: { score: 92, auditGate: 'pass' } }
const NOW = 1_900_000_000_000

describe('eligibility token', () => {
  it('mints for an eligible verdict and verifies', () => {
    const t = mintToken(verdict, 0, NOW)
    expect(t.eligible).toBe(true)
    expect(verifyToken(t, verdict, NOW)).toBe(true)
  })
  it('rejects a stale token', () => {
    const t = mintToken(verdict, 0, NOW - MAX_TOKEN_AGE_MS - 1)
    expect(verifyToken(t, verdict, NOW)).toBe(false)
  })
  it('rejects a verdictHash mismatch (tampered score)', () => {
    const t = mintToken(verdict, 0, NOW)
    expect(verifyToken(t, { ...verdict, security: { score: 10, auditGate: 'pass' } }, NOW)).toBe(false)
  })
  it('refuses to mint for an ineligible verdict', () => {
    expect(() => mintToken({ ...verdict, eligible: false }, 0, NOW)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/eligibilityToken.test.js`
Expected: FAIL — "mintToken is not a function".

- [ ] **Step 3: Write minimal implementation (append to eligibilityGate.js)**

```js
function hashVerdict(verdict) {
  const basis = `${verdict.protocol}|${verdict.yieldReality?.verdict}|${verdict.security?.score}|${verdict.security?.auditGate}`
  let h = 0
  for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** Internal fail-closed assertion token (NOT a security boundary — the on-chain scope bounds malice). */
export function mintToken(verdict, planIndex, nowMs = Date.now()) {
  if (!verdict.eligible) throw new Error('cannot mint token for ineligible verdict')
  return { protocolSlug: verdict.protocol, planIndex, eligible: true, verdictHash: hashVerdict(verdict), asOf: nowMs }
}

export function verifyToken(token, verdict, nowMs = Date.now()) {
  if (!token || token.eligible !== true) return false
  if (nowMs - token.asOf > MAX_TOKEN_AGE_MS) return false
  return token.verdictHash === hashVerdict(verdict)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/eligibilityToken.test.js`
Expected: PASS.

- [ ] **Step 5: Thread the token. In app.jsx `startExecution`, after computeBasket, mint per survivor and carry slug + token:**

```js
import { mintToken } from './strategy/eligibilityGate.js'
// ...
const yvStrategy = {
  vaults: survivors.map((a, i) => ({
    address: a.vault.addr,
    allocation: a.allocationFraction,
    protocolSlug: a.vault.protocol,
    eligibilityToken: mintToken(verdictBySlug[a.vault.protocol], i),
  })),
}
```
(Expose `verdictBySlug` from the destructure: `const { verdictBySlug, survivors, dropped, allFailed } = computeBasket(strategy.agents)`.)

In `orchestrator.js` `vaultPlans` (~45), carry them through:

```js
const vaultPlans = strategy.vaults.map((v, i) => ({
  index: i,
  agentId: makeAgentId(i, this.sessionId),
  vault: v.address,
  protocolSlug: v.protocolSlug || null,
  eligibilityToken: v.eligibilityToken || null,
  amountVfusd: totalAmount * v.allocation,
  amountUnits: BigInt(Math.floor(totalAmount * v.allocation * BASE_UNIT)),
}))
```

And into the WorkerAgent ctor (~99):

```js
new WorkerAgent({
  agentId: p.agentId,
  user: this.user,
  vault: p.vault,
  amount: p.amountUnits,
  sessionId: this.sessionId,
  onEvent: this.onEvent,
  agentAddress: SOROBAN_DEMO_AGENT,
  eligibilityToken: p.eligibilityToken,
})
```

- [ ] **Step 6: Run suite + build**

Run: `cd frontend && npm test && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/strategy/eligibilityGate.js frontend/src/strategy/eligibilityToken.test.js frontend/src/app.jsx frontend/src/orchestrator.js
git commit -m "feat: mint + thread eligibility token by plan index through dispatch"
```

---

## Task 11: worker-side assertion (Enforcement B)

**Files:**
- Modify: `frontend/src/worker.js` (ctor ~25, between ~91 and ~92).
- Test: `frontend/src/worker.eligibility.test.js`.

**Interfaces:**
- Consumes: `eligibilityToken` constructor param. The worker holds the token; it asserts `token.eligible === true` and freshness before `runAgentDeposit`. (No fact re-fetch — §5 no-live-call rule.)

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/worker.eligibility.test.js
import { describe, it, expect, vi } from 'vitest'
import { WorkerAgent } from './worker.js'
import { MAX_TOKEN_AGE_MS } from './strategy/eligibilityGate.js'

const NOW = Date.now()
const goodToken = { protocolSlug: 'aave-v3', planIndex: 0, eligible: true, verdictHash: '123', asOf: NOW }

function makeWorker(token) {
  return new WorkerAgent({
    agentId: 'w1', user: 'G...', vault: 'C...', amount: 1n, sessionId: 's',
    agentAddress: 'CA...', sessionKey: { publicKey: 'GP', rawPublicKey: new Uint8Array(), sign: () => {} },
    eligibilityToken: token,
  })
}

describe('worker eligibility assertion', () => {
  it('throws when the token is absent', async () => {
    const r = await makeWorker(null).execute()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/eligibility/i)
  })
  it('throws when the token is stale', async () => {
    const r = await makeWorker({ ...goodToken, asOf: NOW - MAX_TOKEN_AGE_MS - 1 }).execute()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/eligibility/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/worker.eligibility.test.js`
Expected: FAIL — worker does not yet check the token (it proceeds to relay and fails for another reason / or passes).

- [ ] **Step 3: Add the param + assertion.** In the ctor destructure (~25) add `eligibilityToken,` and assign `this.eligibilityToken = eligibilityToken || null`. Then assert at the TOP of `execute()`, immediately after `this.emit('started', ...)` (~65) and BEFORE `setupKey()`/`readVaultShares()` — fail-fast with no I/O, strictly more fail-closed than the spec's 91→92 seam (a justified deviation: refuse before doing any work, and keeps the unit test hermetic):

```js
      this.emit('started', { agentId: this.agentId, vault: this.vault })
      // Enforcement B (hardening) — internal fail-closed assertion. NOT a security boundary; the
      // on-chain scope already bounds a malicious client. Blocks accidental code-path skips of the gate.
      const t = this.eligibilityToken
      if (!t || t.eligible !== true || Date.now() - t.asOf > MAX_TOKEN_AGE_MS) {
        throw new Error('eligibility assertion failed — no valid pass token for this deposit')
      }
```

(Replace the existing `this.emit('started', ...)` line with the block above — do not duplicate the emit.)

Add the import at the top of worker.js:

```js
import { MAX_TOKEN_AGE_MS } from './strategy/eligibilityGate.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/worker.eligibility.test.js`
Expected: PASS (both throw, caught → `{success:false, error:/eligibility/}`).

- [ ] **Step 5: Run full suite + build**

Run: `cd frontend && npm test && npm run build`
Expected: PASS + build succeeds. (If existing worker tests construct WorkerAgent without a token, pass a fresh `goodToken` there or guard them — update those call sites in the same commit.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/worker.js frontend/src/worker.eligibility.test.js
git commit -m "feat: Enforcement B — worker asserts a fresh eligibility token before deposit"
```

---

## Task 12: off-stage refresh script + provenance integrity

**Files:**
- Create: `frontend/scripts/refreshVaultFacts.mjs`
- Test: `frontend/src/strategy/provenance.test.js`

**Interfaces:**
- Produces: a pure `applyRefresh(snapshotEntry, refreshed, nowMs) => entry` helper (in `vaultFacts.js`) that writes `source:'live'` + new `asOf` ONLY for fields that fully refreshed; any failure/partial leaves `source:'snapshot'` + original `asOf`. The script itself is off the demo path and only rewrites `vaultFactsSnapshot.js` when run manually.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/provenance.test.js
import { describe, it, expect } from 'vitest'
import { applyRefresh } from './vaultFacts.js'

const NOW = 2_000_000_000_000
const entry = { facts: { tvl: { value: 100, source: 'snapshot', asOf: 1 }, audit: { value: 'audited', source: 'snapshot', asOf: 1 } } }

describe('provenance integrity', () => {
  it('a successful field refresh becomes source live with new asOf', () => {
    const r = applyRefresh(entry, { tvl: 250 }, NOW)
    expect(r.facts.tvl).toEqual({ value: 250, source: 'live', asOf: NOW })
  })
  it('an un-refreshed field keeps snapshot source + original asOf', () => {
    const r = applyRefresh(entry, { tvl: 250 }, NOW)
    expect(r.facts.audit).toEqual({ value: 'audited', source: 'snapshot', asOf: 1 })
  })
  it('a failed refresh (undefined value) keeps snapshot, never relabels live', () => {
    const r = applyRefresh(entry, { tvl: undefined }, NOW)
    expect(r.facts.tvl).toEqual({ value: 100, source: 'snapshot', asOf: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/provenance.test.js`
Expected: FAIL — "applyRefresh is not a function".

- [ ] **Step 3: Implement `applyRefresh` (append to vaultFacts.js) + the script.**

```js
// append to frontend/src/strategy/vaultFacts.js
/** Provenance-safe merge: only fully-refreshed fields become source:'live' with a new asOf. */
export function applyRefresh(entry, refreshed, nowMs) {
  const facts = { ...entry.facts }
  for (const [k, value] of Object.entries(refreshed)) {
    if (value === undefined || value === null) continue // failure/partial → keep snapshot
    facts[k] = { value, source: 'live', asOf: nowMs }
  }
  return { ...entry, facts }
}
```

```js
// frontend/scripts/refreshVaultFacts.mjs
// OFF the demo path. Run manually before the demo to capture DeFiLlama mainnet Blend numbers, then
// hand-update vaultFactsSnapshot.js with the printed values + a new CAPTURED_AT. Never called at runtime.
// Usage: node frontend/scripts/refreshVaultFacts.mjs
const DEFILLAMA = 'https://api.llama.fi' // protocol TVL; revenue via /summary/fees endpoints
async function main() {
  try {
    const res = await fetch(`${DEFILLAMA}/tvl/blend`)
    const tvl = await res.json()
    console.log('Captured Blend TVL:', tvl, '— paste into vaultFactsSnapshot.js and bump CAPTURED_AT')
  } catch (err) {
    console.error('refresh failed — keep the existing dated snapshot:', err.message)
    process.exit(0) // non-fatal: the committed snapshot remains the source of truth
  }
}
main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/provenance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/vaultFacts.js frontend/src/strategy/provenance.test.js frontend/scripts/refreshVaultFacts.mjs
git commit -m "feat: provenance-safe refresh helper + off-stage DeFiLlama capture script"
```

---

## Final verification

- [ ] `cd frontend && npm test` — all green.
- [ ] `cd frontend && npm run build` — succeeds.
- [ ] `cd frontend && npx eslint src/strategy/eligibilityGate.js src/strategy/vaultFacts.js src/strategy/basketFilter.js src/strategy/eligibilitySentence.js` — clean.
- [ ] Update the spec status line to "implemented" and note any deviations.
- [ ] Run `graphify update .` to refresh the knowledge graph (per CLAUDE.md).

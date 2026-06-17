# Playbook Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the frozen counter-map playbook into a single living rule store that grows (AI Curator), prunes (harmful≫helpful), and merges (lexical dedup) from real execution evidence — the full ACE loop, browser-only.

**Architecture:** A new `ruleStore.js` holds first-class rule records `{id, role, category, text, helpful, harmful, evals, status, origin, createdAt}` in localStorage `yv_playbook_v2`. `playbook.js` and `playbookRules.js` become thin store-backed shims so every existing caller (`app.jsx`, `council.js`, `councilReview.js`, `reflector.js`) is unchanged. `curator.js` proposes new rules via Venice AI on notable outcomes; `prune.js` and `merge.js` are pure passes the store invokes after a grow.

**Tech Stack:** Vanilla ESM JS, Vitest, localStorage, Venice AI (OpenAI-compatible, existing `venice.js`).

**Reference spec:** `docs/superpowers/specs/2026-06-11-playbook-storage-design.md`

**Conventions (match existing strategy modules):**
- Pure modules, dependencies injected. Never throw across a public boundary — `try/catch` + `console.warn`.
- Vitest with the localStorage stub from `playbook.test.js` (`vi.stubGlobal`).
- Commit messages: conventional, no step numbers in the text.
- Run tests from `frontend/`: `npx vitest run src/strategy/<file>.test.js`.

---

## File Structure

| File | New? | Responsibility |
|------|------|----------------|
| `frontend/src/strategy/seeds.js` | new | Seed rule const (union of both id namespaces) + `roleToCategory` |
| `frontend/src/strategy/ruleStore.js` | new | Record store: CRUD, counters, weight, seed upsert, legacy fold-in |
| `frontend/src/strategy/prune.js` | new | Pure `prunePass(rules, cfg)` |
| `frontend/src/strategy/merge.js` | new | Pure `mergePass(rules, cfg)` — char-trigram cosine |
| `frontend/src/strategy/curator.js` | new | `proposeRule(ctx, deps)` — Venice grow + merge + prune |
| `frontend/src/strategy/playbook.js` | modify | Re-export counters from store (back-compat shim) |
| `frontend/src/strategy/playbookRules.js` | modify | `ROLE_RULES` etc. become store reads; seeds move to `seeds.js` |
| `frontend/src/strategy/monitorLoop.js` | modify | Add `curate` dep; call on failure + ai-conflict |
| `frontend/src/app.jsx` | modify | Inject `curate` into `createMonitorLoop`; wire Venice |

---

## Task 1: Seed catalog (`seeds.js`)

**Files:**
- Create: `frontend/src/strategy/seeds.js`
- Test: `frontend/src/strategy/seeds.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/seeds.test.js
import { describe, it, expect } from 'vitest'
import { SEED_RULES, roleToCategory } from './seeds.js'

describe('seeds', () => {
  it('every seed has the required record shape', () => {
    for (const s of SEED_RULES) {
      expect(s).toMatchObject({
        id: expect.any(String),
        role: expect.stringMatching(/^(yield|risk|market)$/),
        category: expect.stringMatching(/^(strategy|risk|gas)$/),
        text: expect.any(String),
        origin: 'seed',
      })
      expect(s.text.length).toBeGreaterThan(0)
    }
  })

  it('covers BOTH id namespaces (catalog + council inline)', () => {
    const ids = SEED_RULES.map((r) => r.id)
    // playbookRules.js catalog ids
    expect(ids).toContain('yld-apy-attractive')
    expect(ids).toContain('rsk-turbulent-veto')
    expect(ids).toContain('mkt-gas-affordable')
    // council.js inline ids
    expect(ids).toContain('yield-uplift')
    expect(ids).toContain('risk-turbulent-veto')
    expect(ids).toContain('market-gas-positive')
  })

  it('ids are unique', () => {
    const ids = SEED_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('maps role to display category', () => {
    expect(roleToCategory('yield')).toBe('strategy')
    expect(roleToCategory('risk')).toBe('risk')
    expect(roleToCategory('market')).toBe('gas')
    expect(roleToCategory('unknown')).toBe('strategy')
  })

  it('category always matches roleToCategory(role)', () => {
    for (const s of SEED_RULES) expect(s.category).toBe(roleToCategory(s.role))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/seeds.test.js`
Expected: FAIL — cannot resolve `./seeds.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/seeds.js
// ACE living-playbook seed catalog. Union of the two historical id namespaces:
// the playbookRules.js per-role catalog (yld-/rsk-/mkt-) AND the council.js
// inline cited ids (yield-/risk-/market-). Seeding BOTH means every id the
// deterministic council can cite resolves to a real record in the store, so
// weight()/increment() always hit a record. Seeds are origin:'seed' — protected
// from hard-delete (retire-only), because the deterministic council still cites them.

const CAT = { yield: 'strategy', risk: 'risk', market: 'gas' }

export function roleToCategory(role) {
  return CAT[role] || 'strategy'
}

function seed(id, role, text) {
  return { id, role, category: roleToCategory(role), text, origin: 'seed' }
}

export const SEED_RULES = [
  // ── playbookRules.js catalog (shown to the AI wizard council) ──
  seed('yld-apy-attractive', 'yield', 'Blended APY clears the profile target; the headline yield justifies entry.'),
  seed('yld-projection-positive', 'yield', 'Risk-adjusted projected annual yield (USDC) is positive after the risk penalty.'),
  seed('yld-tvl-adequate', 'yield', 'Selected vaults have adequate TVL/track record so the quoted APY is credible.'),
  seed('rsk-turbulent-veto', 'risk', 'Market regime is turbulent — defer entry; capital preservation outranks yield.'),
  seed('rsk-gates-clear', 'risk', 'No action-space gate violations: allocations respect the risk ceiling and sum to 1.0.'),
  seed('rsk-drawdown-bounded', 'risk', '30-day max drawdown of the basket stays within the profile risk tolerance.'),
  seed('rsk-regime-calm', 'risk', 'Regime is calm/elevated with no violations — risk posture supports deploying.'),
  seed('mkt-gas-affordable', 'market', 'Entry gas cost is small relative to expected yield; timing is economically sound.'),
  seed('mkt-timing-favorable', 'market', 'Calm regime and clear signals make now a favorable entry window.'),
  seed('mkt-signals-clear', 'market', 'No adverse live market signals (exploits, depegs, governance alarms) flagged.'),
  // ── council.js inline cited ids (deterministic monitor-loop council) ──
  seed('yield-uplift', 'yield', 'Projected risk-adjusted reward exceeds the current position — deposit on uplift.'),
  seed('yield-harvest-free', 'yield', 'Harvest is a free reward claim — always worth depositing.'),
  seed('yield-no-uplift', 'yield', 'No risk-adjusted uplift over the current position — hold.'),
  seed('risk-turbulent-veto', 'risk', 'Turbulent market regime — withdraw/hold; capital preservation first.'),
  seed('risk-gate-violation', 'risk', 'Action-space gate violation present — withdraw/hold until allocations are valid.'),
  seed('risk-calm-clear', 'risk', 'Calm regime with no violations — risk posture supports depositing.'),
  seed('market-harvest-timing', 'market', 'Harvest timing is always fine — a free claim has no gas-timing risk.'),
  seed('market-gas-positive', 'market', 'Net expected gain after gas is positive — timing is economically sound.'),
  seed('market-gas-negative', 'market', 'Gas exceeds the expected gain — hold until execution is cheaper.'),
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/seeds.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/seeds.js frontend/src/strategy/seeds.test.js
git commit -m "feat: add ACE seed rule catalog unifying both id namespaces"
```

---

## Task 2: Rule store — records, CRUD, seed upsert (`ruleStore.js`)

**Files:**
- Create: `frontend/src/strategy/ruleStore.js`
- Test: `frontend/src/strategy/ruleStore.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/ruleStore.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getRules, addRule, upsertSeeds, retireRule, deleteRule, replaceAll, clearPlaybook,
} from './ruleStore.js'

function stubStorage() {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  })
}

describe('ruleStore — records & CRUD', () => {
  beforeEach(stubStorage)

  it('upsertSeeds is idempotent and stamps createdAt', () => {
    upsertSeeds()
    const n = getRules().length
    expect(n).toBeGreaterThan(0)
    upsertSeeds()
    expect(getRules().length).toBe(n)
    expect(getRules()[0].createdAt).toEqual(expect.any(Number))
  })

  it('getRules filters by role and status', () => {
    upsertSeeds()
    const yield_ = getRules({ role: 'yield' })
    expect(yield_.length).toBeGreaterThan(0)
    expect(yield_.every((r) => r.role === 'yield')).toBe(true)
    expect(getRules({ status: 'active' }).every((r) => r.status === 'active')).toBe(true)
  })

  it('addRule appends a grown rule with zeroed counters', () => {
    addRule({ id: 'grown-1', role: 'market', category: 'gas', text: 'Avoid deposits during gas spikes above 80 gwei.', origin: 'grown' })
    const r = getRules().find((x) => x.id === 'grown-1')
    expect(r).toMatchObject({ id: 'grown-1', origin: 'grown', status: 'active', helpful: 0, harmful: 0, evals: 0 })
    expect(r.createdAt).toEqual(expect.any(Number))
  })

  it('addRule ignores a duplicate id', () => {
    addRule({ id: 'dup', role: 'yield', text: 'a' })
    addRule({ id: 'dup', role: 'yield', text: 'b' })
    expect(getRules().filter((r) => r.id === 'dup').length).toBe(1)
  })

  it('retireRule sets status retired; deleteRule removes', () => {
    addRule({ id: 'g', role: 'risk', text: 'x', origin: 'grown' })
    retireRule('g')
    expect(getRules().find((r) => r.id === 'g').status).toBe('retired')
    deleteRule('g')
    expect(getRules().find((r) => r.id === 'g')).toBeUndefined()
  })

  it('replaceAll overwrites the collection atomically', () => {
    upsertSeeds()
    replaceAll([{ id: 'only', role: 'yield', category: 'strategy', text: 't', helpful: 0, harmful: 0, evals: 0, status: 'active', origin: 'grown', createdAt: 1 }])
    expect(getRules().length).toBe(1)
    expect(getRules()[0].id).toBe('only')
  })

  it('clearPlaybook empties the store', () => {
    upsertSeeds()
    clearPlaybook()
    expect(getRules()).toEqual([])
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_playbook_v2', 'not json')
    expect(getRules()).toEqual([])
    expect(() => addRule({ id: 'z', role: 'yield', text: 't' })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/ruleStore.test.js`
Expected: FAIL — cannot resolve `./ruleStore.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/ruleStore.js
// ACE living playbook — single source of truth. Each rule is one record holding
// its text AND its helpful/harmful evidence. Seeds (origin:'seed') are protected:
// the deterministic council still cites them, so they can only be RETIRED
// (weight-floored), never deleted. Grown rules (origin:'grown') are AI-added and
// fully deletable. Pure localStorage I/O; never throws across a public boundary.
import { SEED_RULES, roleToCategory } from './seeds.js'

const KEY = 'yv_playbook_v2'
const LEGACY_KEY = 'yv_playbook'
const W_MIN = 0.5
const W_MAX = 1.5

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (v && typeof v === 'object' && Array.isArray(v.rules)) return v
  } catch { /* fall through */ }
  return { rules: [], legacyFolded: false }
}

function write(doc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc))
  } catch (err) {
    console.warn('[RuleStore] write failed:', err.message)
  }
}

function newRecord(partial) {
  const role = partial.role || 'yield'
  return {
    id: partial.id,
    role,
    category: partial.category || roleToCategory(role),
    text: partial.text || '',
    helpful: partial.helpful || 0,
    harmful: partial.harmful || 0,
    evals: (partial.helpful || 0) + (partial.harmful || 0),
    status: partial.status || 'active',
    origin: partial.origin || 'grown',
    createdAt: partial.createdAt || Date.now(),
  }
}

/** Read rules, optionally filtered. */
export function getRules({ role, status } = {}) {
  let rules = read().rules
  if (role) rules = rules.filter((r) => r.role === role)
  if (status) rules = rules.filter((r) => r.status === status)
  return rules
}

/** Append a rule. Ignores a duplicate id. Never throws. */
export function addRule(partial) {
  try {
    if (!partial || !partial.id) return
    const doc = read()
    if (doc.rules.some((r) => r.id === partial.id)) return
    doc.rules = [...doc.rules, newRecord(partial)]
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] addRule failed:', err.message)
  }
}

/** Idempotent seed install. Adds any missing SEED_RULES; folds legacy counters once. */
export function upsertSeeds(seeds = SEED_RULES) {
  try {
    const doc = read()
    const have = new Set(doc.rules.map((r) => r.id))
    for (const s of seeds) {
      if (!have.has(s.id)) doc.rules.push(newRecord({ ...s, status: 'active', helpful: 0, harmful: 0 }))
    }
    if (!doc.legacyFolded) foldLegacy(doc)
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] upsertSeeds failed:', err.message)
  }
}

/** One-time fold of the old {id:{helpful,harmful}} counter map into matching records. */
function foldLegacy(doc) {
  doc.legacyFolded = true
  let legacy
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}') } catch { return }
  if (!legacy || typeof legacy !== 'object') return
  for (const r of doc.rules) {
    const c = legacy[r.id]
    if (c) {
      r.helpful += c.helpful || 0
      r.harmful += c.harmful || 0
      r.evals = r.helpful + r.harmful
    }
  }
}

export function retireRule(id) {
  const doc = read()
  const r = doc.rules.find((x) => x.id === id)
  if (r) { r.status = 'retired'; write(doc) }
}

export function deleteRule(id) {
  const doc = read()
  const next = doc.rules.filter((r) => r.id !== id)
  if (next.length !== doc.rules.length) { doc.rules = next; write(doc) }
}

export function replaceAll(rules) {
  const doc = read()
  doc.rules = Array.isArray(rules) ? rules : []
  write(doc)
}

export function clearPlaybook() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/ruleStore.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/ruleStore.js frontend/src/strategy/ruleStore.test.js
git commit -m "feat: add unified rule store with records, CRUD, and seed upsert"
```

---

## Task 3: Rule store — counters & weight (`ruleStore.js`)

**Files:**
- Modify: `frontend/src/strategy/ruleStore.js`
- Test: `frontend/src/strategy/ruleStore.test.js` (append a describe block)

- [ ] **Step 1: Write the failing test**

```js
// append to frontend/src/strategy/ruleStore.test.js
import { increment, weight, getCounters } from './ruleStore.js'

describe('ruleStore — counters & weight', () => {
  beforeEach(stubStorage)

  it('unknown rule is neutral weight 1.0', () => {
    upsertSeeds()
    expect(weight('does-not-exist')).toBe(1.0)
  })

  it('increment bumps the matching record and evals; helpful raises weight', () => {
    upsertSeeds()
    for (let i = 0; i < 10; i++) increment('yield-uplift', 'helpful')
    const r = getRules().find((x) => x.id === 'yield-uplift')
    expect(r.helpful).toBe(10)
    expect(r.evals).toBe(10)
    const w = weight('yield-uplift')
    expect(w).toBeGreaterThan(1.0)
    expect(w).toBeLessThanOrEqual(1.5)
  })

  it('harmful lowers weight (floored at 0.5)', () => {
    upsertSeeds()
    for (let i = 0; i < 10; i++) increment('risk-calm-clear', 'harmful')
    const w = weight('risk-calm-clear')
    expect(w).toBeLessThan(1.0)
    expect(w).toBeGreaterThanOrEqual(0.5)
  })

  it('a retired rule is floored to 0.5 regardless of counters', () => {
    upsertSeeds()
    increment('yield-uplift', 'helpful')
    retireRule('yield-uplift')
    expect(weight('yield-uplift')).toBe(0.5)
  })

  it('increment ignores invalid kind and unknown id without throwing', () => {
    upsertSeeds()
    expect(() => increment('yield-uplift', 'bogus')).not.toThrow()
    expect(() => increment('nope', 'helpful')).not.toThrow()
  })

  it('getCounters returns the legacy {id:{helpful,harmful}} shape', () => {
    upsertSeeds()
    increment('yield-uplift', 'helpful')
    expect(getCounters()['yield-uplift']).toEqual({ helpful: 1, harmful: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/ruleStore.test.js`
Expected: FAIL — `increment` / `weight` / `getCounters` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/strategy/ruleStore.js`:

```js
/** Bump a rule's counter. kind = 'helpful' | 'harmful'. Bumps evals. Never throws. */
export function increment(id, kind) {
  if (!id || (kind !== 'helpful' && kind !== 'harmful')) return
  try {
    const doc = read()
    const r = doc.rules.find((x) => x.id === id)
    if (!r) return
    r[kind] = (r[kind] || 0) + 1
    r.evals = (r.helpful || 0) + (r.harmful || 0)
    write(doc)
  } catch (err) {
    console.warn('[RuleStore] increment failed:', err.message)
  }
}

/**
 * Confidence multiplier in [0.5, 1.5] from the helpful/harmful ratio (Laplace-smoothed).
 * Unknown id → 1.0 (neutral, council always safe). Retired → 0.5 (de-emphasized).
 */
export function weight(id) {
  const r = read().rules.find((x) => x.id === id)
  if (!r) return 1.0
  if (r.status === 'retired') return W_MIN
  const h = r.helpful || 0
  const x = r.harmful || 0
  if (h + x === 0) return 1.0
  const ratio = (h + 1) / (h + x + 2)
  return +(W_MIN + (W_MAX - W_MIN) * ratio).toFixed(3)
}

/** Back-compat counter shape: { id: { helpful, harmful } }. */
export function getCounters() {
  const out = {}
  for (const r of read().rules) out[r.id] = { helpful: r.helpful || 0, harmful: r.harmful || 0 }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/ruleStore.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/ruleStore.js frontend/src/strategy/ruleStore.test.js
git commit -m "feat: add record-backed counters, weight, and legacy counter shape"
```

---

## Task 4: `playbook.js` back-compat shim

**Files:**
- Modify: `frontend/src/strategy/playbook.js`
- Test: `frontend/src/strategy/playbook.test.js` (existing — must stay green)

- [ ] **Step 1: Update the existing test for the v2 key + seeding**

The existing `playbook.test.js` references the legacy `yv_playbook` key in its corrupt-storage test and expects `increment` to work on an arbitrary id. Records only exist after seeding, so update two tests:

```js
// frontend/src/strategy/playbook.test.js — replace the 'getCounters round-trips' and
// 'never throws on corrupt storage' tests with these; add upsertSeeds import.
import { increment, weight, getCounters, clearPlaybook } from './playbook.js'
import { upsertSeeds } from './ruleStore.js'

// inside describe, the counter tests must seed first because counters live on records:
it('getCounters round-trips and clearPlaybook resets', () => {
  upsertSeeds()
  increment('yield-uplift', 'helpful')
  expect(getCounters()['yield-uplift']).toEqual({ helpful: 1, harmful: 0 })
  clearPlaybook()
  expect(getCounters()).toEqual({})
})

it('never throws on corrupt storage', () => {
  localStorage.setItem('yv_playbook_v2', 'nope')
  expect(getCounters()).toEqual({})
  expect(() => increment('x', 'helpful')).not.toThrow()
  expect(weight('y')).toBe(1.0)
})
```

Also update the three weight tests (`helpful increments…`, `harmful increments…`, `mixed history…`) to call `upsertSeeds()` as their first line, since counters now require a record to exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/playbook.test.js`
Expected: FAIL — `playbook.js` still uses its own `yv_playbook` map; seeded-record behavior absent.

- [ ] **Step 3: Replace `playbook.js` with a shim**

```js
// frontend/src/strategy/playbook.js
// ACE counter layer — now a thin re-export of the unified rule store. Kept as a
// stable import surface for existing callers (app.jsx, reflector wiring): the
// helpful/harmful evidence and the derived [0.5,1.5] council weight live on rule
// records in ruleStore.js. See ruleStore.js / seeds.js for the living-playbook engine.
export { increment, weight, getCounters, clearPlaybook } from './ruleStore.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/strategy/playbook.test.js src/strategy/ruleStore.test.js`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/playbook.js frontend/src/strategy/playbook.test.js
git commit -m "refactor: make playbook a store-backed shim for the counter layer"
```

---

## Task 5: `playbookRules.js` store-backed catalog

**Files:**
- Modify: `frontend/src/strategy/playbookRules.js`
- Test: `frontend/src/strategy/playbookRules.test.js` (existing — adapt)

- [ ] **Step 1: Write/adapt the failing test**

```js
// frontend/src/strategy/playbookRules.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rulesForRole, ruleIdsForRole, allRuleIds, isValidRuleForRole } from './playbookRules.js'
import { upsertSeeds, addRule, retireRule } from './ruleStore.js'

describe('playbookRules (store-backed catalog)', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
    upsertSeeds()
  })

  it('rulesForRole returns active rules for that role with id + description', () => {
    const r = rulesForRole('risk')
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]).toHaveProperty('id')
    expect(r[0]).toHaveProperty('description')
  })

  it('a grown rule shows up in its role; a retired rule does not', () => {
    addRule({ id: 'grown-x', role: 'market', text: 'New gas heuristic.', origin: 'grown' })
    expect(ruleIdsForRole('market')).toContain('grown-x')
    retireRule('mkt-gas-affordable')
    expect(ruleIdsForRole('market')).not.toContain('mkt-gas-affordable')
  })

  it('isValidRuleForRole rejects cross-role citation', () => {
    expect(isValidRuleForRole('risk', 'rsk-gates-clear')).toBe(true)
    expect(isValidRuleForRole('risk', 'mkt-gas-affordable')).toBe(false)
  })

  it('allRuleIds spans every role', () => {
    const ids = allRuleIds()
    expect(ids).toContain('yld-apy-attractive')
    expect(ids).toContain('rsk-turbulent-veto')
    expect(ids).toContain('mkt-gas-affordable')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/playbookRules.test.js`
Expected: FAIL — the current `ROLE_RULES` is a static const, retired/grown rules are not reflected.

- [ ] **Step 3: Rewrite `playbookRules.js` as store reads**

```js
// frontend/src/strategy/playbookRules.js
// ACE per-role playbook catalog — now READ FROM the living rule store. The AI
// wizard council (councilReview.js) shows each specialist ONLY its role's ACTIVE
// rules and must cite from them. Grown rules (Curator) appear automatically;
// pruned/retired rules drop out. The {id, description} shape is preserved for the
// existing councilReview prompt builder. Seed content lives in seeds.js.
import { getRules } from './ruleStore.js'

/** Active rules for a role, shaped {id, description} for the council prompt. */
export function rulesForRole(role) {
  return getRules({ role, status: 'active' }).map((r) => ({ id: r.id, description: r.text }))
}

export function ruleIdsForRole(role) {
  return rulesForRole(role).map((r) => r.id)
}

export function allRuleIds() {
  return getRules({ status: 'active' }).map((r) => r.id)
}

export function isValidRuleForRole(role, ruleId) {
  return ruleIdsForRole(role).includes(ruleId)
}

/** Back-compat: councilReview.js imports ROLE_RULES and indexes by role. */
export const ROLE_RULES = {
  get yield() { return rulesForRole('yield') },
  get risk() { return rulesForRole('risk') },
  get market() { return rulesForRole('market') },
}
```

> Note: `councilReview.js` does `const { ROLE_RULES } = await import('./playbookRules.js')` then `ROLE_RULES[role]`. The getter object returns the live active subset per access — no change needed in `councilReview.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/strategy/playbookRules.test.js src/strategy/councilReview.test.js`
Expected: PASS for both. If `councilReview.test.js` seeded nothing and relied on the old static catalog, add `upsertSeeds()` in its `beforeEach` with the localStorage stub.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/playbookRules.js frontend/src/strategy/playbookRules.test.js
git commit -m "refactor: serve playbook catalog from the living rule store"
```

---

## Task 6: Prune pass (`prune.js`)

**Files:**
- Create: `frontend/src/strategy/prune.js`
- Test: `frontend/src/strategy/prune.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/prune.test.js
import { describe, it, expect } from 'vitest'
import { prunePass, PRUNE_CFG } from './prune.js'

const rule = (over) => ({
  id: 'r', role: 'yield', category: 'strategy', text: 't',
  helpful: 0, harmful: 0, evals: 0, status: 'active', origin: 'grown', createdAt: 1, ...over,
})

describe('prunePass', () => {
  it('keeps a rule below MIN_EVALS even if harmful-heavy', () => {
    const out = prunePass([rule({ helpful: 0, harmful: 3, evals: 3 })])
    expect(out.length).toBe(1)
  })

  it('hard-deletes a grown rule that is harmful >> helpful past MIN_EVALS', () => {
    const out = prunePass([rule({ helpful: 1, harmful: 6, evals: 7 })])
    expect(out.length).toBe(0)
  })

  it('retires (not deletes) a seed rule that underperforms', () => {
    const out = prunePass([rule({ origin: 'seed', helpful: 1, harmful: 6, evals: 7 })])
    expect(out.length).toBe(1)
    expect(out[0].status).toBe('retired')
  })

  it('does not prune a healthy rule', () => {
    const out = prunePass([rule({ helpful: 8, harmful: 1, evals: 9 })])
    expect(out[0].status).toBe('active')
    expect(out.length).toBe(1)
  })

  it('reactivates a retired rule that recovered (helpful >= harmful)', () => {
    const out = prunePass([rule({ origin: 'seed', status: 'retired', helpful: 5, harmful: 4, evals: 9 })])
    expect(out[0].status).toBe('active')
  })

  it('respects custom config', () => {
    const out = prunePass([rule({ helpful: 0, harmful: 3, evals: 3 })], { MIN_EVALS: 2, HARM_RATIO: 2 })
    expect(out.length).toBe(0)
  })

  it('exposes default config constants', () => {
    expect(PRUNE_CFG.MIN_EVALS).toBe(5)
    expect(PRUNE_CFG.HARM_RATIO).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/prune.test.js`
Expected: FAIL — cannot resolve `./prune.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/prune.js
// ACE grow-and-refine — the prune half. Pure: takes rules, returns a new array.
// A rule underperforms when, past a minimum number of evaluations, harmful counts
// dominate helpful ones. Grown rules are hard-deleted (only the AI path cites
// them). Seed rules are RETIRED instead of deleted — the deterministic council
// still cites them, so we floor their weight rather than break a citation. A
// retired rule that recovers (helpful >= harmful) is reactivated.

export const PRUNE_CFG = { MIN_EVALS: 5, HARM_RATIO: 2 }

function underperforms(r, cfg) {
  return r.evals >= cfg.MIN_EVALS && r.harmful >= r.helpful * cfg.HARM_RATIO
}

export function prunePass(rules, cfg = PRUNE_CFG) {
  const out = []
  for (const r of rules) {
    if (underperforms(r, cfg)) {
      if (r.origin === 'grown') continue            // hard delete
      out.push({ ...r, status: 'retired' })         // seed → retire
    } else if (r.status === 'retired' && r.helpful >= r.harmful) {
      out.push({ ...r, status: 'active' })           // recovered → reactivate
    } else {
      out.push(r)
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/prune.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/prune.js frontend/src/strategy/prune.test.js
git commit -m "feat: add deterministic prune pass (grown-delete, seed-retire, reactivate)"
```

---

## Task 7: Merge pass (`merge.js`)

**Files:**
- Create: `frontend/src/strategy/merge.js`
- Test: `frontend/src/strategy/merge.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/merge.test.js
import { describe, it, expect } from 'vitest'
import { mergePass, trigramCosine, MERGE_CFG } from './merge.js'

const rule = (over) => ({
  id: 'r', role: 'yield', category: 'strategy', text: 't',
  helpful: 0, harmful: 0, evals: 0, status: 'active', origin: 'grown', createdAt: 1, ...over,
})

describe('trigramCosine', () => {
  it('is 1.0 for identical text and lower for different text', () => {
    expect(trigramCosine('gas is high', 'gas is high')).toBeCloseTo(1.0, 5)
    expect(trigramCosine('gas is high now', 'gas is high right now')).toBeGreaterThan(0.6)
    expect(trigramCosine('deposit on uplift', 'turbulent regime veto')).toBeLessThan(0.3)
  })
})

describe('mergePass', () => {
  it('merges near-duplicate same-role rules: oldest id, summed counters', () => {
    const out = mergePass([
      rule({ id: 'old', text: 'Avoid deposits when gas is very high', helpful: 2, harmful: 1, evals: 3, createdAt: 1 }),
      rule({ id: 'new', text: 'Avoid deposits when gas is very high now', helpful: 3, harmful: 0, evals: 3, createdAt: 9 }),
    ])
    expect(out.length).toBe(1)
    expect(out[0].id).toBe('old')
    expect(out[0].helpful).toBe(5)
    expect(out[0].harmful).toBe(1)
    expect(out[0].evals).toBe(6)
  })

  it('never merges across roles even if text is identical', () => {
    const out = mergePass([
      rule({ id: 'a', role: 'yield', text: 'identical text here' }),
      rule({ id: 'b', role: 'risk', text: 'identical text here' }),
    ])
    expect(out.length).toBe(2)
  })

  it('a seed+grown collision keeps the seed origin', () => {
    const out = mergePass([
      rule({ id: 'seed-1', origin: 'seed', text: 'Gas cost is small relative to yield', createdAt: 1 }),
      rule({ id: 'grown-1', origin: 'grown', text: 'Gas cost is small relative to the yield', createdAt: 9 }),
    ])
    expect(out.length).toBe(1)
    expect(out[0].origin).toBe('seed')
    expect(out[0].id).toBe('seed-1')
  })

  it('leaves dissimilar rules untouched', () => {
    const out = mergePass([
      rule({ id: 'a', text: 'deposit on risk-adjusted uplift' }),
      rule({ id: 'b', text: 'withdraw in turbulent regime' }),
    ])
    expect(out.length).toBe(2)
  })

  it('exposes default config', () => {
    expect(MERGE_CFG.THRESHOLD).toBe(0.8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/merge.test.js`
Expected: FAIL — cannot resolve `./merge.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/merge.js
// ACE bulletpoint analyzer — lexical variant. Pure: takes rules, returns a new
// array with near-duplicate rules merged. Similarity is char-trigram cosine on
// the text, computed WITHIN A ROLE ONLY (cross-role merge would corrupt the
// council partition). A cluster collapses to the OLDEST id (lowest createdAt,
// usually a seed), with distinct text concatenated and helpful/harmful/evals
// SUMMED. A seed+grown collision keeps the seed origin so the council's cited id
// survives. No embeddings, no network — demo-safe and deterministic.

export const MERGE_CFG = { THRESHOLD: 0.8 }

function trigrams(text) {
  const s = `  ${String(text).toLowerCase().replace(/\s+/g, ' ').trim()}  `
  const m = new Map()
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

export function trigramCosine(a, b) {
  const ta = trigrams(a)
  const tb = trigrams(b)
  let dot = 0
  for (const [g, x] of ta) if (tb.has(g)) dot += x * tb.get(g)
  const mag = (m) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0))
  const denom = mag(ta) * mag(tb)
  return denom === 0 ? 0 : dot / denom
}

function combine(cluster) {
  const ordered = [...cluster].sort((x, y) => x.createdAt - y.createdAt)
  const base = ordered[0]
  const seed = ordered.find((r) => r.origin === 'seed')
  const texts = [...new Set(ordered.map((r) => r.text))]
  const sum = (k) => ordered.reduce((s, r) => s + (r[k] || 0), 0)
  return {
    ...base,
    id: (seed || base).id,
    origin: seed ? 'seed' : base.origin,
    text: texts.join(' '),
    helpful: sum('helpful'),
    harmful: sum('harmful'),
    evals: sum('helpful') + sum('harmful'),
  }
}

export function mergePass(rules, cfg = MERGE_CFG) {
  const byRole = {}
  for (const r of rules) (byRole[r.role] ||= []).push(r)

  const out = []
  for (const role of Object.keys(byRole)) {
    const items = byRole[role]
    const used = new Array(items.length).fill(false)
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue
      const cluster = [items[i]]
      used[i] = true
      for (let j = i + 1; j < items.length; j++) {
        if (used[j]) continue
        if (trigramCosine(items[i].text, items[j].text) >= cfg.THRESHOLD) {
          cluster.push(items[j])
          used[j] = true
        }
      }
      out.push(cluster.length === 1 ? cluster[0] : combine(cluster))
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/merge.test.js`
Expected: PASS (all tests). If the `trigramCosine('gas is high now', 'gas is high right now')` assertion is borderline, it only needs `> 0.6`; the implementation comfortably clears it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/merge.js frontend/src/strategy/merge.test.js
git commit -m "feat: add lexical trigram merge pass with same-role-only dedup"
```

---

## Task 8: Curator — grow via Venice (`curator.js`)

**Files:**
- Create: `frontend/src/strategy/curator.js`
- Test: `frontend/src/strategy/curator.test.js`

The Curator is pure orchestration: it takes a notable-outcome context and an injected `ask` function (the Venice call) plus store ops, and applies ADD → merge → prune. The store ops are injected so the test can use in-memory fakes.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/strategy/curator.test.js
import { describe, it, expect, vi } from 'vitest'
import { proposeRule } from './curator.js'

function fakeStore(initial = []) {
  let rules = [...initial]
  return {
    getRules: () => rules,
    addRule: (r) => { if (!rules.some((x) => x.id === r.id)) rules = [...rules, { helpful: 0, harmful: 0, evals: 0, status: 'active', createdAt: Date.now(), ...r }] },
    replaceAll: (next) => { rules = next },
    _rules: () => rules,
  }
}

const ctx = { role: 'market', outcome: 'failure', concerns: ['gas exceeded gain'], turbulence: 'elevated', reason: 'execute reverted' }

describe('proposeRule', () => {
  it('adds a grown rule from a valid Venice JSON delta', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => ({ role: 'market', text: 'Skip deposits when gas exceeds the projected gain.' }))
    await proposeRule(ctx, { ask, store })
    const added = store._rules().find((r) => r.origin === 'grown')
    expect(added).toBeTruthy()
    expect(added.role).toBe('market')
    expect(added.category).toBe('gas')
    expect(added.status).toBe('active')
  })

  it('no-ops when Venice returns bad JSON / null', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => null)
    await proposeRule(ctx, { ask, store })
    expect(store._rules().length).toBe(0)
  })

  it('no-ops and never throws when Venice rejects', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => { throw new Error('timeout') })
    await expect(proposeRule(ctx, { ask, store })).resolves.toBeUndefined()
    expect(store._rules().length).toBe(0)
  })

  it('a proposed near-duplicate is merged, not double-added', async () => {
    const store = fakeStore([
      { id: 'mkt-gas-affordable', role: 'market', category: 'gas', text: 'Entry gas cost is small relative to expected yield.', helpful: 2, harmful: 0, evals: 2, status: 'active', origin: 'seed', createdAt: 1 },
    ])
    const ask = vi.fn(async () => ({ role: 'market', text: 'Entry gas cost is small relative to the expected yield.' }))
    await proposeRule(ctx, { ask, store })
    const market = store._rules().filter((r) => r.role === 'market')
    expect(market.length).toBe(1)
    expect(market[0].origin).toBe('seed') // seed survives the merge
  })

  it('ignores a delta whose role is missing or invalid', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => ({ text: 'no role here' }))
    await proposeRule(ctx, { ask, store })
    expect(store._rules().length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/curator.test.js`
Expected: FAIL — cannot resolve `./curator.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/strategy/curator.js
// ACE Curator — the grow half. On a NOTABLE outcome (a failed cycle or an
// AI-conflict resolution) it asks Venice for ONE new playbook rule that would
// have prevented the failure or resolved the split, then ADDs it and runs the
// merge + prune passes over the role's rules. AI is injected as `ask`; store ops
// are injected so this stays pure and testable. Fire-and-forget by contract:
// any failure is swallowed (no-op) so the never-stop monitor loop is never blocked.
import { roleToCategory } from './seeds.js'
import { mergePass } from './merge.js'
import { prunePass } from './prune.js'

const VALID_ROLES = new Set(['yield', 'risk', 'market'])

function slug(text) {
  const base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `grown-${base || 'rule'}-${Date.now().toString(36)}`
}

/**
 * @param {{role?:string, outcome:string, concerns?:string[], turbulence?:string, reason?:string}} ctx
 * @param {{ ask:(ctx)=>Promise<{role:string,text:string}|null>,
 *           store:{ getRules:Function, addRule:Function, replaceAll:Function } }} deps
 */
export async function proposeRule(ctx, { ask, store }) {
  try {
    if (typeof ask !== 'function' || !store) return
    const delta = await ask(ctx)
    if (!delta || typeof delta !== 'object') return
    const role = delta.role
    const text = typeof delta.text === 'string' ? delta.text.trim() : ''
    if (!VALID_ROLES.has(role) || text.length < 8) return

    store.addRule({ id: slug(text), role, category: roleToCategory(role), text, origin: 'grown', status: 'active', helpful: 0, harmful: 0, evals: 0 })

    // Refine: merge near-dups, then prune the role's rules. Write back atomically.
    const all = store.getRules()
    const refined = prunePass(mergePass(all))
    store.replaceAll(refined)
  } catch (err) {
    console.warn('[Curator] proposeRule skipped:', err.message)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/strategy/curator.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/curator.js frontend/src/strategy/curator.test.js
git commit -m "feat: add ACE Curator that grows, merges, and prunes from notable outcomes"
```

---

## Task 9: Wire `curate` into the monitor loop

**Files:**
- Modify: `frontend/src/strategy/monitorLoop.js`
- Test: `frontend/src/strategy/monitorLoop.test.js` (append a describe block)

- [ ] **Step 1: Write the failing test**

```js
// append to frontend/src/strategy/monitorLoop.test.js
describe('createMonitorLoop curate (ACE grow)', () => {
  it('curates on a failed execution (harmful outcome)', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({ curate, execute: vi.fn(async () => { throw new Error('reverted') }) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', reason: 'reverted' }))
  })

  it('curates when the council resolved by ai-conflict', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({
      curate,
      council: vi.fn(async () => ({ verdict: 'keep', reason: null, confidence: 0.6, citedRules: ['yield-uplift'], specialists: [], resolvedBy: 'ai-conflict' })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).toHaveBeenCalledWith(expect.objectContaining({ resolvedBy: 'ai-conflict' }))
  })

  it('does NOT curate on a clean unanimous keep', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({ curate })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).not.toHaveBeenCalled()
  })

  it('a throwing curate never stops the loop', async () => {
    const curate = vi.fn(() => { throw new Error('venice down') })
    const { saved, deps } = makeDeps({ curate, council: vi.fn(async () => ({ verdict: 'keep', confidence: 0.6, citedRules: ['yield-uplift'], specialists: [], resolvedBy: 'ai-conflict' })) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(saved[0]).toMatchObject({ verdict: 'keep' }) // journal still wrote → loop survived
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/strategy/monitorLoop.test.js`
Expected: FAIL — `curate` is never invoked.

- [ ] **Step 3: Add the `curate` dep and call sites**

In `frontend/src/strategy/monitorLoop.js`, add `curate` to the destructured deps and a wrapped invoker, then call it on the two notable paths.

Change the signature line (currently around line 22):

```js
export function createMonitorLoop({ getState, runGates, gates = () => ({ passed: true }), simulate, council, execute, reflect, journal, recordDecision = () => {}, curate = () => {}, heartbeatMs = 60_000, onPhase }) {
```

Add a wrapped invoker next to `record` (around line 32):

```js
  // Curation is fire-and-forget learning — a throwing/slow curator must never kill a cycle.
  const grow = (ctx) => { try { curate(ctx) } catch { /* ignore */ } }
```

On the AI-conflict keep path (inside the `try` after a successful execute, around line 77, right after the success `journal.saveCycle(...)`):

```js
        if (v.resolvedBy === 'ai-conflict') grow({ role: v.citedRules[0]?.split('-')[0] || 'yield', outcome: 'success', resolvedBy: v.resolvedBy, citedRules: v.citedRules, reason: v.reason, turbulence: state.market.turbulence })
```

On the execution-failure path (the `catch (execErr)` block, around line 79, after the crash `journal.saveCycle(...)`):

```js
        grow({ role: v.citedRules[0]?.split('-')[0] || 'yield', outcome: 'failure', resolvedBy: v.resolvedBy, citedRules: v.citedRules, reason: execErr?.message || String(execErr), turbulence: state.market.turbulence })
```

Update the JSDoc deps block to document `curate`:

```js
 * @param {(ctx:Object)=>void} [deps.curate]   // ACE Curator — grow on failure / ai-conflict only
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/strategy/monitorLoop.test.js`
Expected: PASS (existing + 4 new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/strategy/monitorLoop.js frontend/src/strategy/monitorLoop.test.js
git commit -m "feat: trigger the Curator on failed or AI-contested cycles"
```

---

## Task 10: Wire the Curator into `app.jsx`

**Files:**
- Modify: `frontend/src/app.jsx` (imports near line 57-62; loop construction near line 470-507)

This task has no new unit test (it is React composition wiring covered by the module tests above). Verify by build + the full suite.

- [ ] **Step 1: Add imports**

After the existing strategy imports (around line 62), add:

```js
import { proposeRule } from './strategy/curator.js';
import { upsertSeeds, getRules, addRule, replaceAll } from './strategy/ruleStore.js';
```

- [ ] **Step 2: Seed the store once on mount**

Inside the component, in the existing mount effect that sets up the loop (near line 468, before `createMonitorLoop`), ensure seeds exist:

```js
    upsertSeeds(); // ACE: install seed rules + fold any legacy counters once
```

- [ ] **Step 3: Build the Venice-backed `ask` and inject `curate`**

Add a `curate` entry to the `createMonitorLoop({...})` object (alongside `reflect`, around line 503). It calls Venice for a rule delta and applies it through the store:

```js
      curate: (ctx) => {
        // One Venice call → {role, text} delta. Fire-and-forget; proposeRule swallows failures.
        const ask = async (c) => {
          try {
            const sys = 'You are the Curator of a DeFi yield-farming AI Council playbook. Given a notable cycle outcome, propose ONE concise, generalizable rule for the named role that would have prevented the failure or resolved the disagreement. Output JSON ONLY: {"role":"yield|risk|market","text":"..."}.';
            const user = `Role: ${c.role}\nOutcome: ${c.outcome}\nResolved by: ${c.resolvedBy || 'n/a'}\nReason: ${c.reason || 'n/a'}\nRegime: ${c.turbulence || 'n/a'}\nCited rules: ${(c.citedRules || []).join(', ') || 'none'}\n\nPropose one new rule as JSON.`;
            const out = await askVeniceJson({ system: sys, user, devApiKey: devApiKey || null });
            return out && out.role && out.text ? { role: out.role, text: String(out.text) } : null;
          } catch { return null; }
        };
        proposeRule(ctx, { ask, store: { getRules, addRule, replaceAll } });
      },
```

> `askVeniceJson` is the project's existing Venice JSON helper. If the exact export name differs, use the same helper `resolveCouncilConflict` / `councilSpecialistVerdict` are built on in this file (search `venice` imports near the top of `app.jsx`) — it must return a parsed JSON object or throw. Match its actual signature; the contract `proposeRule` needs is simply `ask(ctx) → Promise<{role,text}|null>`.

- [ ] **Step 4: Verify build + full suite**

Run: `cd frontend && npx vitest run && npm run build`
Expected: all strategy tests PASS; production build succeeds with no unresolved imports.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: wire the ACE Curator into the autonomous monitor loop"
```

---

## Final verification

- [ ] Run the whole suite: `cd frontend && npx vitest run`
- [ ] Confirm coverage ≥ 80% on the new modules: `cd frontend && npx vitest run --coverage src/strategy`
- [ ] Manual sanity (optional, dev server): start the monitor loop, force a failed cycle, confirm a `grown` rule appears in `localStorage.yv_playbook_v2` and that repeated harmful outcomes retire/delete it.

---

## Spec coverage map

| Spec section | Task(s) |
|--------------|---------|
| §2 Store + record + API | 2, 3 |
| §3 Seed migration + legacy fold | 1, 2 |
| §4 Prune | 6 |
| §5 Merge | 7 |
| §6 Curator / grow | 8, 9, 10 |
| §7 Wiring (shims, loop, app) | 4, 5, 9, 10 |
| §8 Testing | every task (TDD) |
| §9 ACE fidelity | whole plan |

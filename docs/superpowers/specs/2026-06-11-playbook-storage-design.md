# Playbook Storage — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming)
**Inspired by:** ACE — Agentic Context Engineering (Stanford / SambaNova / UC Berkeley, ICLR 2026), itself a successor to *Dynamic Cheatsheet* (Suzgun et al.). See `planning/inspiration/ACE.md`.

---

## 1. Motivation

The strategy engine already runs the ACE **Generator → Reflector → Counter** loop:

| File | Role | ACE analog |
|------|------|-----------|
| `council.js` | 3 deterministic specialists emit `citedRules` | Generator |
| `councilReview.js` | AI-first wizard council, role-filtered rule subset | Generator (AI) |
| `reflector.js` | kept cycle → success=helpful / failure=harmful on cited rules | Reflector |
| `playbook.js` | localStorage counter map, `weight(id)` → council confidence | Counter Layer |
| `playbookRules.js` | **static** ROLE_RULES catalog | Playbook content (frozen) |

What is missing relative to the ACE "playbook as a living document" thesis:

1. The playbook is a counter map plus a **frozen** catalog — rules never **grow** (no Curator / ADD).
2. **No prune** — `harmful >> helpful` rules are never removed or de-emphasized.
3. Rules are not first-class records: counters (`playbook.js`) live apart from text (`playbookRules.js`).
4. No **refine/merge** (dedup of near-duplicate rules).
5. Two id namespaces drift: `council.js` cites `yield-uplift` / `risk-turbulent-veto`; `playbookRules.js` uses `yld-apy-attractive` / `rsk-turbulent-veto`. Never unified.

This spec turns the playbook into a single **living rule store** that grows, prunes, and merges from real execution evidence — the full ACE loop, browser-only, never-stop-safe.

### Decisions locked during brainstorming

- **Scope:** Full ACE — grow + prune + merge.
- **Merge method:** Deterministic lexical (char-trigram cosine). No embeddings, no backend, no model download.
- **Grow trigger:** Notable outcomes only — cycle failure or AI-conflict resolution.
- **Storage structure:** Unified rule store (Approach A); `playbook.js` / `playbookRules.js` become store-backed shims so all existing callers keep working.

### Out of scope (follow-ups)

- A dashboard panel to view playbook rules / counters / status. This spec is the storage + evolution engine only.
- LLM-based merge and embedding-based similarity (lexical is sufficient for the rule-set size).

---

## 2. Architecture + Storage Schema

New module `frontend/src/strategy/ruleStore.js` — single source of truth. localStorage key `yv_playbook_v2` (separate from legacy `yv_playbook`; one-time migration in §3).

### Rule record

```js
{
  id: 'yld-apy-attractive',   // stable unique slug
  role: 'yield',              // 'yield'|'risk'|'market' — council partition key (REQUIRED)
  category: 'strategy',       // 'strategy'|'risk'|'gas' — display label; 1:1 map from role
  text: 'Blended APY clears the profile target…',
  helpful: 0,
  harmful: 0,
  evals: 0,                   // helpful + harmful; explicit so prune threshold reads cleanly
  status: 'active',           // 'active' | 'retired' (retired = weight-floored, never deleted)
  origin: 'seed',             // 'seed' (protected: retire-only) | 'grown' (AI-added: hard-deletable)
  createdAt: 1749600000000,
}
```

### role ↔ category map

Council needs `role`; the display taxonomy from the ACE narrative is `risk|gas|strategy`. Both stored on the record:

```
yield  → strategy
risk   → risk
market → gas
```

### Public API (stable — all existing callers keep working)

```js
// counters — replaces playbook.js internals; playbook.js re-exports these
increment(id, kind)         // 'helpful'|'harmful'; also bumps evals; never throws
weight(id)                  // [0.5,1.5] Laplace-smoothed; retired → floor 0.5; unknown id → 1.0
getCounters()               // back-compat shape

// store ops — new
getRules({ role, status })  // filtered read
addRule(record)             // Curator grow; id-dedup, stamps createdAt
upsertSeeds(seedArray)      // idempotent migration/seed
retireRule(id) / deleteRule(id)
replaceAll(rules)           // atomic write-back (merge/prune use this)
clearPlaybook()             // back-compat reset
```

### `weight()` semantics

Active math is unchanged from current `playbook.js`:

```
ratio = (helpful + 1) / (helpful + harmful + 2)   // Laplace-smoothed, 0.5 = neutral
w     = 0.5 + (1.5 - 0.5) * ratio                 // map to [0.5, 1.5]
```

- Unknown id → `1.0` (neutral) — deterministic council always safe.
- `status:'retired'` → floored to `0.5` (de-emphasized, never crashes a specialist that still cites it).

**Why a separate v2 key:** legacy `yv_playbook` is `{ id: {helpful, harmful} }`; the new store is records-with-text. A clean new key means zero risk to a running demo's existing localStorage, with a one-time fold-in (§3).

---

## 3. Seed migration

`upsertSeeds()` runs once on store init — idempotent, keyed by id, skips existing.

Seed source = **union of both current namespaces**, so every id the council can cite becomes a real record:

- `playbookRules.js` ROLE_RULES (`yld-*`, `rsk-*`, `mkt-*`) → `origin:'seed'`.
- `council.js` inline ids → `origin:'seed'`, short seed text:
  `yield-uplift`, `yield-harvest-free`, `yield-no-uplift`,
  `risk-turbulent-veto`, `risk-gate-violation`, `risk-calm-clear`,
  `market-harvest-timing`, `market-gas-positive`, `market-gas-negative`.

The seed array moves to a new `seeds.js` const consumed by `upsertSeeds`.

**Legacy counter import:** if `yv_playbook` exists, fold its `{helpful, harmful}` into matching seed records once (recompute `evals`). Leave the legacy key untouched — no destructive delete on a demo machine.

---

## 4. Prune (automatic, deterministic)

Pure function `prunePass(rules, cfg) → rules`. Runs after each Curator notable-outcome pass. No AI, no network.

A rule is pruned when **all** hold:

```
evals   >= MIN_EVALS                 (default 5)
harmful >= helpful * HARM_RATIO      (default 2)
```

- `origin:'grown'` → **hard delete** (`deleteRule`) — only the AI path cites it, safe.
- `origin:'seed'` → **retire** (`status:'retired'`) — the deterministic council may still cite it; weight is floored, never crashed.

Constants exported and configurable. **Reversible:** a retired seed that later earns helpful counters auto-reactivates (`status:'active'`) — honest grow-and-refine.

---

## 5. Merge (lexical dedup / refine)

Pure function `mergePass(rules, cfg) → rules`. Runs after grow (a new rule may duplicate an existing one).

- Similarity = **char-trigram cosine** on `text`, computed **within the same role only** (cross-role merge would corrupt the council partition).
- Threshold default `0.8`.
- Cluster near-duplicates → keep the **oldest** id (lowest `createdAt`, usually a seed), concatenate distinct text, **sum** `helpful` / `harmful` / `evals`.
- Seed + grown collision → survivor inherits the **seed** origin (protects the id the council cites).
- Self-only clusters are untouched.

---

## 6. Curator / grow

New module `frontend/src/strategy/curator.js` — pure orchestration, Venice AI injected.

### Trigger (notable outcomes only)

In `monitorLoop.js`:

- cycle **failure** (the `execErr` path), or
- verdict `resolvedBy === 'ai-conflict'`.

A new injected dep `curate(ctx)` is called right after `reflect` on those paths. Fire-and-forget, fully wrapped: any throw / timeout journals a `curate-skip` and the loop continues (never-stop preserved).

### `proposeRule(ctx, deps)`

- Input: the failed / contested cycle — cited role(s), concerns, regime, outcome.
- One Venice call (`venice.js`, OpenAI-compatible, `response_format: { type: 'json_object' }`, 10s timeout — same pattern as existing AI calls). System prompt: *"Propose ONE new DeFi playbook rule for role R that would prevent this failure / resolve this split. JSON: {role, text}."*
- Parse delta → `addRule({ ...json, id: slug(text), category: roleToCategory(role), origin:'grown', status:'active', helpful:0, harmful:0, evals:0 })`.
- Then `mergePass` (dedup vs existing) → `prunePass`.
- **Fallback:** Venice down / bad JSON / duplicate id → no-op, journal `curate-skip`. Zero loop impact.

A grown rule now lives in the store, so the next **wizard** `councilReview` shows it to the relevant LLM specialist (because `playbookRules.js ROLE_RULES` is store-backed). It can then be cited, earn counters, and be pruned if it underperforms — the full ACE loop closes.

**Wizard-path symmetry:** the same `curate` may also fire on the `app.jsx` AI-conflict at review time (one extra call, optional).

---

## 7. Wiring (exact touch points)

| File | Change |
|------|--------|
| `ruleStore.js` | **new** — store + ops + invokes prune/merge |
| `prune.js` | **new** — pure `prunePass` |
| `merge.js` | **new** — pure `mergePass` (trigram cosine) |
| `seeds.js` | **new** — seed rule const (union of both namespaces) |
| `curator.js` | **new** — `proposeRule` + Venice orchestration |
| `playbook.js` | `increment` / `weight` / `getCounters` / `clearPlaybook` re-export from store (back-compat shim) |
| `playbookRules.js` | `ROLE_RULES` / `rulesForRole` / `ruleIdsForRole` / `allRuleIds` become store reads (active rules); seed const moves to `seeds.js` |
| `monitorLoop.js` | add `curate` dep; call on failure + ai-conflict; journal curate events |
| `app.jsx` | inject `curate` into `createMonitorLoop`; wire Venice like existing council calls; **no change** to weight/reflect imports (shim) |
| `council.js`, `councilReview.js`, `reflector.js` | **unchanged** (public APIs stable) |

---

## 8. Testing (Vitest, ≥80%)

Mirrors existing `*.test.js` style. Pure modules → high coverage, Venice the only mock.

- `ruleStore.test.js` — CRUD; weight math (active / retired / unknown); evals bump; localStorage round-trip; legacy import fold-in.
- `seeds.test.js` — every council-cited id resolves to a record; idempotent upsert.
- `prune.test.js` — grown delete vs seed retire; `MIN_EVALS` / `HARM_RATIO` boundaries; reactivation of a retired seed.
- `merge.test.js` — same-role-only; trigram threshold; counter summation; oldest-id survival; cross-role never merges.
- `curator.test.js` — JSON parse → addRule; fallback no-op on Venice fail / bad JSON / duplicate; never throws.
- `monitorLoop.test.js` — extend: `curate` fires on failure + ai-conflict, never on a clean keep; a throwing `curate` does not stop the loop.

---

## 9. ACE fidelity check

| ACE component | This design |
|---------------|-------------|
| Generator | `council.js` (deterministic) + `councilReview.js` (AI) — existing |
| Reflector + Counter | `reflector.js` + store `increment` — existing, now record-backed |
| Curator (ADD delta) | `curator.js` — new, notable-outcome trigger |
| Bulletpoint Analyzer (dedup/merge) | `merge.js` lexical — new |
| Grow-and-refine / prune | `prune.js` — new, grown-delete / seed-retire |
| Playbook as living document | `ruleStore.js` unified records — new |

Faithful to ACE semantics; the only deliberate divergence is lexical similarity in place of sentence-transformer embeddings (browser-only, demo-safe).

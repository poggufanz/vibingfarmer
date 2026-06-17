# Decision Log + ACC Compressed Verdicts — Design

**Date:** 2026-06-11
**Status:** Approved (design)
**Inspired by:** EvoDS Step 7 — Adaptive Context Compression (ACC) at the sub-agent level (`planning/inspiration/EvoDS.md`). Manager-level orchestration, Autonomous Skill Acquisition, and Agentic RL are deliberately **scoped out** (live-trading risk profile).

---

## 1. Context — what already exists

The monitor-loop consensus gate is **already built**. EvoDS Step 7 is only **half** implemented:

| EvoDS Step 7 piece | Status | Location |
|---|---|---|
| Deterministic consensus gate (majority + confidence → else HOLD/discard) | ✅ Done | `council.js` synthesis: hard-veto → unanimity → weighted-margin → 1 AI tiebreak |
| 3 specialists emit `{signal, confidence}` | ✅ Done | `council.js` yield / risk / market |
| ACC **compressed verdict** — per-agent 1–2 sentence `summary` | ⚠️ Partial | specialists emit `concerns[]` + `citedRules`, no distilled summary line |
| **Decision log** — full record incl. EACH specialist's verdict+summary | ❌ Missing | `cycleJournal.js` persists only the **aggregate** (`verdict, confidence, reason, citedRules`) — the per-specialist layer is dropped |
| Calibration substrate (per-agent accuracy / threshold tuning) | ❌ Missing | nothing reads accuracy per agent |

**Consequence:** because `cycleJournal` discards the individual verdicts, the system can never answer "was the Risk Analyst right?" or tune thresholds from history.

`council.js`'s synthesis is **richer** than EvoDS's flat 2/3 rule (it adds a hard veto + a weighted-confidence margin). Rewriting it to the flat rule = regression risk on passing tests for no real gain.

## 2. Scope

**In scope:**
- Per-specialist **ACC compressed verdict** (`signal + confidence + summary`), summary produced **deterministically** (no per-cycle AI).
- A **dedicated decision-log store** capturing all 3 verdicts + the aggregate + the authoritative decision, EvoDS-schema, calibration-ready.
- A **read-only UI panel** surfacing recent decisions with the 3 specialist verdicts expandable.

**Out of scope (held tight):**
- No change to `council.js` synthesis (zero regression).
- No change to `cycleJournal.js` / `reflector.js`.
- No calibration **logic** (the store is built so a future calibration layer can attach outcomes via a stable `id`; computing accuracy/threshold adjustments is a later slice).
- No per-cycle AI compression call (would burn Venice credit every heartbeat and add a failure path to the never-stop loop).

## 3. Architecture & data flow

```
monitorLoop cycle
  → council(input) → v { verdict, confidence, reason, resolvedBy, specialists[] }
  council ran?  (verdict is keep OR discard — NOT idle / gated / crash)
        │ yes
        ▼
  recordDecision({ cycle, idea, state, verdict: v })   ← NEW injected dep, default no-op
        ▼
  decisionLog.js: buildDecisionRecord → append to own localStorage store
```

`council.js`, `cycleJournal.js`, `reflector.js` are **untouched**. The council result `v` already carries `v.specialists` — today it is simply dropped at journal time. We capture it.

The decision is recorded on **both keep and discard** (the council deliberated in both cases). It is **not** recorded for `idle` / `gated` / `crash` cycles, where no council ran.

## 4. New module — `frontend/src/strategy/decisionLog.js`

Pure module, mirrors `cycleJournal.js` conventions: `localStorage` I/O, append-only, capped at 100 rows, **never throws**, no React, no network.

### Exports

- `accSummary(verdict) → string` — pure, deterministic (see §5).
- `buildDecisionRecord({ cycle, idea, state, verdict }) → record` — pure; maps council output → EvoDS-schema record.
- `recordDecision(ctx) → void` — `buildDecisionRecord` + persist; the function injected into the loop.
- `getDecisions() → record[]` — newest-first.
- `clearDecisions() → void`.
- `getDecisionSummary() → { byAgent, total }` — per-agent signal tallies (DEPOSIT/HOLD/WITHDRAW counts per role) + total decisions. The calibration teaser / read-model seed.

### Record schema

```json
{
  "id": "c42-1718100000000",
  "ts": 1718100000000,
  "cycle": 42,
  "action": { "kind": "rebalance", "vault": "Aave USDC", "apyGain": 1.4 },
  "turbulence": "calm",
  "verdicts": [
    { "role": "yield",  "signal": "DEPOSIT", "confidence": 0.78, "summary": "DEPOSIT — risk-adjusted uplift (yield-uplift)" },
    { "role": "risk",   "signal": "DEPOSIT", "confidence": 0.6,  "summary": "DEPOSIT — calm, no gate violations (risk-calm-clear)" },
    { "role": "market", "signal": "HOLD",    "confidence": 0.7,  "summary": "HOLD — gas exceeds expected gain (market-gas-negative)" }
  ],
  "majoritySignal": "DEPOSIT",
  "majorityCount": 2,
  "avgConfidence": 0.69,
  "finalDecision": "keep",
  "resolvedBy": "weighted",
  "reason": null,
  "citedRules": ["yield-uplift", "risk-calm-clear"]
}
```

Field notes:
- `majoritySignal` / `majorityCount` / `avgConfidence` — descriptive EvoDS stats. `avgConfidence` = mean confidence of the specialists voting the majority signal.
- `finalDecision` / `resolvedBy` / `reason` — the council's **authoritative** outcome (`keep`/`discard`, `veto|unanimous|weighted|ai-conflict`). A veto or weighted margin can legitimately override the naive majority; storing both, honestly, is exactly what makes the log useful for calibration.
- `id` = `c{cycle}-{ts}` — stable join key so a future outcome/calibration layer can attach success/failure to the decision.
- Defensive defaults: missing `idea` fields → `action.kind = 'unknown'`, etc. Never throws.

## 5. ACC summary template (deterministic, no AI)

```js
const POSITIVE = { DEPOSIT: 'clear to proceed', HOLD: 'hold', WITHDRAW: 'exit' }

function accSummary({ signal, citedRules = [], concerns = [] }) {
  const reason = concerns[0] ?? POSITIVE[signal] ?? ''
  const rules = citedRules.length ? ` (${citedRules.join(', ')})` : ''
  return `${signal} — ${reason}${rules}`
}
```

Faithful to ACC: compress to one structured, human-readable line. No raw analysis dump, zero credit burn, never-stop-safe. Driven entirely off fields the deterministic specialists already emit.

## 6. Wiring (2 small edits)

- **`monitorLoop.js`** — add `recordDecision = () => {}` to the destructured deps; call it in the keep branch **and** the discard branch with `{ cycle, idea, state, verdict: v }`. Wrapped so a throw never breaks the cycle (consistent with the never-stop contract). Idle/gated/crash branches: not called. (~4 lines.)
- **`app.jsx`** — `import { recordDecision, getDecisions, getDecisionSummary } from './strategy/decisionLog.js'`; inject `recordDecision` into `createMonitorLoop({...})`. (~2 lines for wiring.)

## 7. UI — `DecisionLogPanel`

Co-located with `LoopStatusPanel` in `agents.jsx`, same export block, same visual idiom.

- **Props:** `{ rows: getDecisions().slice(0, 8), summary: getDecisionSummary() }`.
- **Re-render:** driven by the existing `loopTick` (the decision is written in the same cycle as the journal row, which already bumps `loopTick`). No new tick plumbing.
- **Header chips:** per-agent signal tallies (yield / risk / market) — the calibration teaser.
- **Each decision row:** `#cycle · [keep|discard badge] · majoritySignal ×count · avg conf · resolvedBy-tag`. Expand → three lines `role · signal · conf · summary` (the ACC verdicts).
- **Empty state:** mirrors the loop panel's copy.
- **CSS:** new classes (`.decision-log`, `.decision-row`, `.decision-verdict`, …) in `style.css`, built on the existing design tokens.
- Wire into `app.jsx` near the existing `loopPanel`.

## 8. Testing

- **`decisionLog.test.js`:**
  - `accSummary` — with a concern; with no concern (uses POSITIVE); with/without cited rules.
  - `buildDecisionRecord` — schema completeness; majority/avg math; veto-overrides-majority case (finalDecision ≠ majoritySignal); 3-way split; all-HOLD; defensive defaults on missing `idea`.
  - store — append, newest-first `getDecisions`, cap at 100, `clearDecisions`, never-throws on corrupt `localStorage`.
  - `getDecisionSummary` — per-agent tallies correct.
- **`monitorLoop.test.js`:** `recordDecision` called on keep and on discard; **not** called on gated / idle / crash.
- Panel is visual and covered by the established idiom; the existing suite is logic-only (`.test.js`), so no component unit test is added.

## 9. Files touched

| File | Change |
|---|---|
| `frontend/src/strategy/decisionLog.js` | **new** — store + ACC summary + record builder |
| `frontend/src/strategy/decisionLog.test.js` | **new** — unit tests |
| `frontend/src/strategy/monitorLoop.js` | add `recordDecision` dep + 2 call sites |
| `frontend/src/strategy/monitorLoop.test.js` | add call/no-call assertions |
| `frontend/src/agents.jsx` | **new** `DecisionLogPanel` + export |
| `frontend/src/app.jsx` | import + inject `recordDecision`; render panel |
| `frontend/src/style.css` | `.decision-log` styles on existing tokens |

## 10. Non-goals / future

- Calibration logic (per-agent accuracy, Bayesian threshold update) — enabled by `id` + `getDecisionSummary`, deferred.
- Outcome correlation (join decision → execute success/failure) — deferred.
- Touching the wizard council (`councilReview.js`) — separate surface, not in this slice.

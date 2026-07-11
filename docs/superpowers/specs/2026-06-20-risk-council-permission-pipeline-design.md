# Cognitive Risk → Council → Permission Pipeline — Design Spec

> Date: 2026-06-20 · Branch: `iq` · Status: design approved, Phase-1 core partially proven in code
> Domain: **DeFi yield farming only** (RWA / OJK / SEC dropped — older inspiration docs are stale)
> The optional deep emergent behavioral engine is **never named** in this spec by deliberate instruction.

---

## 1. One sentence

Turn live market context into an **honest risk distribution (VaR/CVaR)**, debate the rebalance decision in a **bounded multi-agent council loop** that is autonomous only in reasoning, **hard-stop** before any action, hand the human **one plain sentence** to approve, then execute on testnet/sim.

## 2. Problem & motivation

Most risk tools answer "what if it goes bad?" with **one confident number** ("portfolio down 12%"). That number hides the tail — and people are ruined by the worst 5%, not the average. The opposite extreme (raw Monte Carlo / econometric stress) is honest about spread but **narrative-blind**: it draws from a fixed distribution and doesn't understand what an event *means*.

This pipeline sits between: an honest **spread** shaped by **understanding of real signals**, then a decision layer that debates it from structurally different bases, then a human gate. The differentiator is not "many independent brains" (same base model — see §13) but **audited structured reasoning + a router that knows when cheap math suffices and when depth is worth the cost**.

## 3. Scope & non-goals

**In scope (Phase 1, core):** behavioral aggregate layer → Monte Carlo VaR/CVaR → council loop (Proposer / Risk-Compliance / Validator) → permission layer (1 sentence, Yes/No) → testnet execution via existing relay/worker.

**Roadmap (Phase 2, same doc, marked optional):** full 4-signal fan-out (news/macro via LLM, crypto/stock via data API), the deep emergent engine adapter behind the router seam, vector-RAG backend behind the retriever interface.

**Non-goals:** no RWA / securities-regulator framing; no autonomous fund movement; no accuracy %; no latent-vector inter-agent comms; deep mode never on the critical path.

## 4. Architecture

```
live context ─► param fusion ─► BEHAVIORAL ROUTER
                                  ├ aggregate (mock, ALWAYS, pure math)        ┐
                                  └ deep emergent (local stand-in, OPT toggle) ┘
                                              ▼
                                   Monte Carlo ─► VaR / CVaR (honest spread)
                                              ▼
              COUNCIL LOOP  ── muter sampai konvergen (max 2–3 iter) ──┐
              Proposer        (temp↑, seeks yield/rebalance)           │
              Risk/Compliance (temp 0, RAG corpus, cite-or-abstain, hard-veto)
              Validator       (temp 0, numbers must match sim output)  │
                 3 exits: converge · stalemate=no-consensus · fatal-inconsistency
                                              ▼
                         WAJIB BERHENTI (never auto-executes)
                                              ▼
              PERMISSION LAYER ─► 1 plain sentence ─► human Yes / No
                                              ▼
                         execute (testnet / sim) — existing relay/worker path
```

Chain-agnostic: the whole layer is off-chain text/data orchestration. The Soroban migration does not touch it.

## 5. Modules

### 5.1 Already built + proven in code (Phase 1)

| Module | State | Notes |
|---|---|---|
| `riskMetrics.js` | **Written + proven** | VaR(95) = (1-α) quantile of signed returns; CVaR(95) = mean of outcomes ≤ VaR. Textbook ES, MC/historical method. Pure, deterministic. Loss-framing via `asLoss`. |
| `behavioral.js` | **Written + proven** | `aggregateStress` (Tingkat-1 mock: turbulence/drawdown → correlation + vol + drift deltas), `emergentStress` (deep local stand-in), `routeBehavior` (router), `simulateCorrelatedPath` (2-asset Cholesky — correlation→1 fattens the tail). |
| `complianceCorpus.js` | **Written + proven** | Curated DeFi rule corpus (id, citation, metric, threshold, tags) + keyword/tag retriever + `checkTailCompliance` (cite-or-abstain; CVaR vs tier floor). No RWA/OJK/SEC. |

**Proof run** (`__riskproof.mjs`, throwaway — to be converted to Vitest), 10 000 seeded paths, 30-day horizon, 2-vault basket:

| market | corr | vol× | mean | VaR(95) | CVaR(95) | worst | verdict |
|---|---|---|---|---|---|---|---|
| calm | 0.20 | 1.0× | +0.65% | −1.46% | −1.98% | −4.30% | **PASS** `CVAR_TAIL_FLOOR` |
| panic | 0.85 | 2.5× | +0.52% | −5.99% | −7.68% | −14.33% | **VETO** `CVAR_TAIL_FLOOR` |

Mean is nearly identical (both green); CVaR diverges ~4×, worst-case ~3.3×. The same rule, fed two distributions, returns two cited verdicts. This is the "honest spread" claim standing in code.

### 5.2 To build (Phase 1)

| Module | Job |
|---|---|
| `riskParams.js` | Fuse existing live context (turbulence / apyTrend / gas — already gathered elsewhere) + behavioral deltas → one scenario param object for Monte Carlo. (Full 4-signal fan-out = Phase 2.) |
| `councilLoop.js` | The debate loop. Deterministic pre-checks short-circuit (reuse `council.js` cost discipline); escalate to bounded AI calls only on genuine ambiguity. 3 roles, convergence, 3 exits, max-iter cap. Never-stop-safe. |
| `permissionLayer.js` | Converged council result → 1 plain sentence (LLM + template fallback) → Yes/No gate. Yes → existing testnet exec. No → log to `reflector`/`playbook`. |

### 5.3 Untouched (no regression)

`councilReview.js` (Yield/Risk/Market, single-pass) stays as the **per-deposit gate** — 250+ passing tests stay safe. `councilLoop.js` is the **strategy-level** decision (rebalance/hedge/hold) driven by simulated VaR/CVaR. Different input, different job.

## 6. Council loop mechanics

- **Input:** sim VaR/CVaR distribution + proposed allocation.
- **Proposer** (temp ~0.9): seeks yield/rebalance opportunity; outputs a proposal + the numbers it relies on.
- **Risk/Compliance** (temp 0, RAG over `complianceCorpus`): retrieves relevant rules, **must cite a rule id or abstain**, hard-vetoes on a cited breach. What makes it honestly different from Proposer is the corpus binding, not the temperature.
- **Validator** (temp 0): the Proposer's cited numbers must match the sim output (VaR/CVaR consistency); flags fatal inconsistency.
- **3 exits (set max-iter upfront, 2–3):**
  1. **Converge** — Proposer & Risk agree, Validator consistent → proceed to permission.
  2. **Stalemate** — max-iter reached without agreement → "no consensus" (a *valid* result, surfaced to the human, not a failure).
  3. **Fatal inconsistency** — Validator finds numbers ≠ sim → stop.
- **Cost guard:** deterministic short-circuit first; bounded AI calls per round; hard iteration cap. Loop is autonomous **only in reasoning** — it **WAJIB BERHENTI** before any action (Aladdin principle: no autonomous decision at the action point).

## 7. Behavioral router + mock + deep stand-in

- **Aggregate (always, cheap math):** `aggregateStress` — drawdown/turbulence → correlation spike + vol surge + drift drag, fed to the correlated Monte Carlo. ~80% of the "simulation world" value. Proven to fatten the tail (§5.1).
- **Deep (optional toggle, off critical path):** `emergentStress` — a LOCAL approximation of narrative dynamics (rumor contagion / opinion clustering) as extra tail-fatness params. Never replaces the aggregate path. The real external engine is a future adapter behind `routeBehavior` — **never named here, never on the critical path; if it is slow/absent the core still runs.**

## 8. VaR / CVaR

Extend the simulation output with VaR(95) and CVaR(95) per `riskMetrics.js`. Output framing for humans: most-likely / best / worst-5%, plus the two numbers. Signed convention (positive tail = still a gain; negative = real loss). **The metric is only as honest as the distribution it is given — that burden sits in the simulation params, not in the VaR formula (§13).**

## 9. Permission layer

- **WAJIB BERHENTI:** loop output never auto-executes.
- Summarize the whole debate to **one plain sentence** (LLM, with a deterministic template fallback), e.g. "Risk is up, but mostly from gas, not your assets — proceed with the rebalance?" — not a raw VaR table, not the debate transcript.
- Human **Yes/No**. Yes → execute on testnet/sim via the existing relay/worker path. No → discard + log to `reflector`/`playbook` for ACE learning.
- Reuses the established "AI proposes → human reviews → then runs" pattern (existing batched-permission UX); only the payload changes from "deposit" to "rebalance".

## 10. UX surface

New "Risk & Council" panel in the connected `/strategy` flow: histogram with the worst-5% tail marked + VaR/CVaR, deep-mode toggle, collapsible debate trace (cited rules visible), then the one-sentence Yes/No gate. Reuses `AgentActionPreview` / `RightRail`. Connected-app only (needs AI/Flask).

## 11. Key data contracts

```js
// riskMetrics(outcomes, alpha) →
{ alpha, var95, cvar95, worst, best, mean, n, tailCount } // signed % returns

// aggregateStress({turbulence, drawdownPct}) →
{ correlation, volMultiplier, driftDrag, rules:[ruleId] }

// checkTailCompliance({cvar95, worst}, {riskTier}) →
{ verdict:'pass'|'veto'|'abstain', citedRule, citation, reason, floor }

// councilLoop(input, deps) →
{ outcome:'converge'|'no-consensus'|'fatal', proposal, citedRules, iterations, trace }

// permissionLayer(result) →
{ sentence, recommend:'proceed'|'hold', payload } // awaits human Yes/No
```

## 12. Testing plan (Vitest, 80% bar, AAA)

- `riskMetrics`: seeded-sample determinism; VaR/CVaR exact on a known array; empty-input guard; signed vs `asLoss`.
- `behavioral`: aggregate rules fire on the right turbulence/drawdown; correlation↑ measurably widens the outcome std (calm vs panic); router picks deep only when requested AND warranted.
- `complianceCorpus`: retrieval by tag; **cite-or-abstain** (no rule → abstain, never invent); pass vs veto across tiers.
- `councilLoop`: each of the 3 exits reachable; deterministic short-circuit avoids AI calls; iteration cap enforced (cost bound); abstaining Risk does not fabricate a veto.
- `permissionLayer`: template fallback when LLM absent; never auto-proceeds without explicit Yes.
- Convert `__riskproof.mjs` into a regression test; then delete the demo file.

## 13. Open risks & honest limits (carried into pitch)

**Verified (sourced):** VaR/CVaR definitions are textbook (VaR = (1-α) quantile; CVaR/ES = mean loss beyond it). CVaR-alongside-VaR matches industry direction (Basel III FRTB replaced 99% VaR with 97.5% ES for market-risk capital; ES preferred for stress testing). Sort-and-average-the-tail is the standard Monte Carlo/historical CVaR method — so "small add" is accurate, not optimism.

**Design judgment (no external source, test it yourself):** module boundaries, the council loop's cost guard, and splitting `councilLoop` from `councilReview` are engineering opinions — reasonable, not proven "good" by any external standard.

**Explicitly hedged (do not over-claim):**
- Whether a multi-agent debate on the **same base model** beats a single well-structured prompt is **unsettled in the literature**. Claim only "audited structured reasoning," never "debate is provably better."
- VaR/CVaR is **only as honest as the simulation distribution**. A confident-looking VaR from wrong assumptions is still wrong. The honesty burden lives in `simulation.js` / the params, not in the metric.
- Deep mode mimics *effects*, not real individuals; it is an approximation, optional, never critical-path.
- No claim of avoiding groupthink via independent brains; no autonomous fund movement; no accuracy percentage.

## 14. Phasing

- **Phase 1 (core):** `riskMetrics` + `behavioral` + `complianceCorpus` (done), `riskParams` + `councilLoop` + `permissionLayer` (to build), simulation VaR/CVaR wiring, "Risk & Council" UX panel, Vitest suite, demo→test conversion.
- **Phase 2 (roadmap):** full 4-signal fan-out; deep emergent external engine adapter behind `routeBehavior`; vector-RAG backend behind the `complianceCorpus` retriever.

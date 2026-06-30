# F8 — Pre-Execution Risk Eligibility Gate

> Spec · sub-project F8 · 2026-06-28 · branch `iq`
> Depends on: Blend cutover (done), Risk→Council→Permission modules (exist, see §0)
> Status: **IMPLEMENTED** (2026-06-28, branch `iq`, Slice 1 + Slice 2). 366 frontend tests green, build + eslint clean.
> Deviations from plan: (1) test `NOW = 1_790_000_000_000` was 85.6d after `CAPTURED_AT` (2026-06-28),
> exceeding `MAX_FACT_AGE_MS` (30d) → would fail the gate; `vaultFacts.test.js` + `enforcementA.test.js`
> now derive `NOW = CAPTURED_AT + 1000` (provenance honesty keeps `CAPTURED_AT` = capture date).
> (2) `basketFilter.js` imports hoisted to top of file (eslint `import/first`), not appended mid-file.
> (3) `worker.eligibility.test.js` adds the `memory.js` mock (plan omitted it → failure-path
> `writeMemory` hit absent `localStorage` and rejected instead of returning `{success:false}`).
> (4) all 4 existing `worker.test.js` constructors now pass a fresh `goodToken()` (Enforcement B
> runs before the `agentAddress` check). (5) snapshot mainnet numbers are still PLACEHOLDERS —
> run `scripts/refreshVaultFacts.mjs` + bump `CAPTURED_AT` before the live demo.
> Not committed (lives under `docs/superpowers/` — gitignored by project policy)
>
> v2 changelog (from 5-lens adversarial review): "3 enforcement points" → **2 enforcement
> points + presentation** (the council/permission pipeline has no production caller — verified);
> sliced into **MVP-for-innovation** vs **hardening**; renamed to end the Lapis/Layer naming
> collision; closed all determinism/fail-closed gaps (required-facts set, symmetric unknowns,
> named normalization curves, staleness bounds, audit hard-gate); tightened every surfaced string
> for the mainnet-protocol / testnet-deposit honesty line.

---

## 0. Verified ground truth (read before trusting any seam)

Confirmed against real code on 2026-06-28:

- **The council/permission pipeline is NOT on the deposit path.** `runRiskCouncil` /
  `buildPermission` / `confirmPermission` (`strategy/riskCouncil.js:19`, `strategy/permissionLayer.js:35,64`)
  have **zero production callers** — only each other + `*.test.js`. The live deposit path is:
  `app.jsx:1161 startExecution()` → `app.jsx:1402 orch.dispatch(yvStrategy, total)` →
  `orchestrator.js:43 dispatch` → `WorkerAgent` → `worker.js:92 runAgentDeposit` →
  `stellar/agentDeposit.js:82`. No council, no permission gate in between.
  ⇒ The permission sentence is a **display artifact**, not an enforcement point.
- **All catalog vaults share one on-chain address.** `VAULT_CATALOG` (`config.js:24–73`) — all 4
  entries use `SOROBAN_VAULT_ADDRESS` (`stellar/config.js`). `yvStrategy.vaults[].address`
  (`app.jsx:1178`) is therefore identical across the basket. ⇒ Any per-vault token must key on a
  **protocol slug + plan index**, never the address. The worker (`worker.js:25–50`) holds only
  `{vault(address), amount, sessionKey}` — it sees **no facts**.
- **Protocol identity exists only upstream, in `app.jsx`.** `strategy.agents` carries
  `vault.protocol/name/apy`; these are dropped when `yvStrategy` is flattened to
  `{vaults:[{address, allocation}]}` at `app.jsx:1178`. ⇒ The gate (which needs protocol identity
  to resolve facts) must run in `app.jsx`, before `orch.dispatch`.

## 1. Context

Master Strategy differentiator = **3 protection layers** ("Lapis 1/2/3"). Two exist; Lapis 1 does not:

| Protection layer (thesis) | Status | Module |
|---------------------------|--------|--------|
| 🔴 **Lapis 1** — eligibility gate (before entering) | **greenfield — this spec** | new |
| 🔵 Lapis 2 — target max-loss + council (while running) | exists (unwired on deposit path) | `riskCouncil`/`councilLoop`/`riskParams` |
| 🟢 Lapis 3 — one-decision + exit (anytime) | done | permission UI + revoke |

> **Naming discipline:** "Lapis / protection layer 1–3" refers ONLY to the three thesis layers.
> F8's internal enforcement points are named **Enforcement A / B** and **Presentation** — never
> "Layer N" — to keep the thesis trinity clean.

Lapis 1 maps to two named real problems (Master Strategy lines 119–125), and the spec keeps that
mapping explicit because it is where a technical gate becomes an innovation story:

- **Test 1 (yield-reality)** closes problem #5 — rug/ponzi APY ("the ponzis collapsed").
- **Test 2 (security-score)** closes problem #4 — smart-contract exploit/hack ("$2.9B lost, 2025").

**Greenfield here:** the two deterministic tests, the per-vault verdict, the basket-filter
enforcement, the fused permission sentence, the two-context honesty labeling, the demo fixture.

## 2. Goals / Non-goals

**Goals**

1. A **deterministic, pure, fail-closed** eligibility gate run in `app.jsx` **before**
   `orch.dispatch`, once per candidate protocol.
2. Two reproducible tests: **yield-real-vs-ponzi** and **security-score 0–100** (audit a hard gate).
3. **Enforcement A (sufficient):** ineligible protocols are dropped from the basket before dispatch;
   all-fail → hard stop. This alone guarantees an ineligible protocol never reaches a deposit.
4. **Honest provenance + two-context honesty:** every fact carries `source` + `asOf`; missing /
   unverifiable / stale data ⇒ fail-closed reject; mainnet-protocol credibility and testnet-deposit
   context are stated **separately**, never merged (§6).
5. **The fused permission sentence** (named, exact copy in §8) — the headline artifact and demo climax.
6. **Visible in demo:** a clearly-labeled bad-vault fixture is rejected on screen; Blend passes on
   captured-real data with a visible provenance chip.

**Non-goals**

- Wiring the council/permission *enforcement* pipeline into the deposit path (out of scope; the
  permission sentence is display only).
- Real OJK/SEC legal classification (corpus seam only).
- Mainnet deposit. The gate scores the **protocol** (real on mainnet); the deposit is testnet (§6).
- LLM deciding pass/fail. The LLM writes the explanation sentence only; a thrown/flaky LLM must not
  change the verdict (tested, §13).
- **Enforcement B (worker assertion) is NOT a security boundary** — the on-chain scope already bounds
  a malicious client. B is an internal fail-closed assertion against accidental code-path skips, and
  it is **hardening (P2)**, not required for the headline (§3 slicing).

## 3. Slicing — bank the +6 before any gold-plating

F8 is a **2-day stretch** item; the Master Strategy says the +6 Innovation comes from *assembling*,
not from invisible plumbing. So build in this order and stop-line accordingly:

**Slice 1 — MVP-for-innovation (required for the headline; build first, ship green):**
`eligibilityGate.js` (pure) · `vaultFactsSnapshot.js` (dated facts) · `vaultFacts.js` (snapshot
resolve, no live call) · **Enforcement A** (basket filter + re-normalize + all-fail stop in
`app.jsx`) · the **fused permission sentence** + **Eligibility panel** (`screens.jsx`) · the
**HyperFarm fixture** rejected on screen · **Blend passes** on captured-real data + provenance chip.

**Slice 2 — hardening (P2, only after Slice 1 is green):**
**Enforcement B** (worker eligibility-token assertion, §7) · the optional off-stage live-refresh
script (§5). If time runs out, Slice 2 is dropped and the headline still lands.

## 4. Architecture

Decision logic is a **pure function** over already-resolved facts — no I/O — so tests are
deterministic without a network. All I/O lives in the data layer.

```
strategy/eligibilityGate.js      # pure(facts) -> verdict.  No I/O. The gate + all named constants.
strategy/vaultFacts.js           # resolve(protocol) -> facts. Snapshot-first; no live call on demo path.
strategy/vaultFactsSnapshot.js   # dated, sourced static facts (Blend + non-Blend + HyperFarm fixture).
scripts/refreshVaultFacts.mjs    # Slice 2, optional, OFF the demo path. Refresh snapshot from DeFiLlama.
```

Per-vault evaluation is wrapped so a data-layer throw maps to a reject (not a basket abort):

```js
// in app.jsx, before orch.dispatch — Enforcement A host (protocol identity still present)
const verdicts = candidates.map((p) => {
  try { return eligibilityGate.evaluate(vaultFacts.resolve(p)) }   // resolve may throw / return unknown
  catch { return REJECT(p, 'facts unavailable') }                  // throw -> fail-closed reject
})
const survivors = verdicts.filter(v => v.eligible)
if (survivors.length === 0) return hardStop('No eligible vault — nothing will run.')  // explicit guard
const basket = renormalize(survivors)                              // allocations re-sum to 100%
// dispatchSet is built STRICTLY from survivors; a dropped vault gets no plan and no token
orch.dispatch(buildYvStrategy(basket), total)
```

Verdict shape (every fact field carries provenance):

```js
{ protocol, eligible: bool,
  yieldReality: { ratio, verdict: 'real'|'ponzi'|'unknown', inputs },
  security:     { score: 0..100, auditGate: 'pass'|'fail', components: {age, tvl, adminKey} },
  reasons: [ '...' ],                 // human-readable, lists failing test(s)
  isFixture: bool,                    // true only for HyperFarm; never reportable as a real-world catch
  facts }                             // each field { value, source:'live'|'snapshot', asOf }
```

## 5. The two tests — deterministic, every threshold named

All constants live in `eligibilityGate.js`. **No magic numbers** — and that now actually holds:

```
PONZI_RATIO_MAX = 1.5
SECURITY_MIN    = 60
AGE_CAP_DAYS    = 180          // age signal saturates here
TVL_FLOOR       = 100_000      // USD; below floor -> tvl signal 0
TVL_CAP         = 100_000_000  // USD; at/above cap -> tvl signal 1
AGE_WEIGHT  = 0.30 ; TVL_WEIGHT = 0.40 ; ADMIN_WEIGHT = 0.30   // assert sum === 1.0
ADMIN_LEVELS = { timelock_multisig:1.0, multisig:0.7, timelock:0.5, eoa:0.0 }
MAX_FACT_AGE_MS  = 30 * 86400_000   // 30d — stale fact -> reject
MAX_TOKEN_AGE_MS = 15 * 60_000      // 15m — stale/replayed pass-token -> reject (Slice 2)
REQUIRED_FACTS = ['annualizedDistributed','protocolRevenue','audit','ageDays','tvl','adminKey']
```

**Fact presence (fail-closed core).** A fact is *present* iff `value != null` **and**
`now - asOf <= MAX_FACT_AGE_MS`. `allRequiredFactsPresent(facts)` returns true only if every name in
`REQUIRED_FACTS` is present. Missing **or stale** ⇒ not present ⇒ reject. One TDD case per fact
asserts that fact's absence (and its staleness) **alone** → `eligible:false`.

**Test 1 — yield real or ponzi?** (closes #5). Both operands must be positive verified numbers;
a defaulted/zero/missing operand never yields a "real" pass:

```
if (annualizedDistributed missing/≤0)  || (protocolRevenue missing/≤0)  -> verdict = 'unknown'   // reject
ratio = annualizedDistributed / protocolRevenue
verdict = ratio < PONZI_RATIO_MAX ? 'real' : 'ponzi'     // strict <, equality biases to ponzi (conservative)
```
`annualizedDistributed` = yield paid to depositors over a trailing window, annualized (defined in the
snapshot's capture note; raw field renamed from `distributed`). `apy` is **display-only** (permission
sentence / panel) and is not an input to the verdict.
- Blend: distributions ARE borrow interest → ratio ≈ 1 → `real`.
- Fixture: 10M / 3M = 3.33 → `ponzi`.

**Test 2 — hack/rug risk → security-score** (closes #4). **Audit is a hard gate, not a weighted term:**

```
auditGate = (audit === 'audited') ? 'pass' : 'fail'      // missing audit -> caught earlier as not-present
if (auditGate === 'fail') -> reject ('unaudited')
ageSig   = clamp(ageDays / AGE_CAP_DAYS, 0, 1)
tvlSig   = clamp( (log10(tvl) - log10(TVL_FLOOR)) / (log10(TVL_CAP) - log10(TVL_FLOOR)), 0, 1)
adminSig = ADMIN_LEVELS[adminKey]                          // missing/unknown level -> not-present -> reject
score    = round(100 * (AGE_WEIGHT*ageSig + TVL_WEIGHT*tvlSig + ADMIN_WEIGHT*adminSig))
reject if score < SECURITY_MIN
```
*Present-but-negative ≠ missing:* `audit:'none'` (a verified fact) → audit-gate fail → reject.
`audit` field **absent** → not-present → reject. Both reject, for distinct, correct reasons.
- Blend (audited; ~mature; large mainnet TVL; governed): audit-gate pass, high score → **eligible**.
- Fixture (`audit:'none'`, ageDays 4, tvl 50_000<floor, adminKey `eoa`): audit-gate **fail** →
  reject; and for completeness its score = `round(100*(0.30*0.022 + 0.40*0 + 0.30*0))` = **1** (well
  below 60). Stated exactly, not "~38".

**Verdict combine (fail-closed):**
```
eligible = allRequiredFactsPresent(facts)
        && yieldReality.verdict === 'real'
        && auditGate === 'pass'
        && security.score >= SECURITY_MIN
```
Any `unknown`, any missing/stale fact, any thrown resolve ⇒ `eligible:false`.

## 6. Two-context labeling (MANDATORY — the honesty line)

The gate scores **Blend-the-protocol** on **mainnet** data (testnet TVL is play money). The deposit
runs on **testnet**. These are presented as **two separate, labeled statements**, everywhere the
verdict shows (panel AND permission sentence). Never merged.

- **(a) Protocol credibility:** "Blend (mainnet) — TVL <X>, audited <firm>. source: DeFiLlama, asOf <date>."
- **(b) This deposit:** "testnet — APR illustrates the Blend lending mechanism; testnet demand is
  seeded and realized yield may be ~0; not representative of mainnet returns."

**Forbidden:** any mainnet TVL/revenue figure rendered adjacent to the testnet position such that a
reader could think the deposit sits in mainnet TVL; any bare "yield is real" / "real yield" string;
the displayed yield label is the ratio-and-context phrase **"Mainnet distributions revenue-covered
(ratio <r>)"**, never "Yield is real". A review/test must check for these (§13).

## 7. Enforcement — two points (A sufficient, B hardening)

**Enforcement A — basket filter in `app.jsx` (Slice 1, the real gate).** Ineligible protocols are
dropped before `orch.dispatch`, so the AI council/dispatch never spends effort on a vault that
should be rejected. Allocation re-normalizes across survivors. `dispatchSet ⊆ survivors` is asserted
at plan construction — a dropped protocol receives **no per-agent plan and no token**, so it cannot
reach a worker. `survivors.length === 0` → explicit hard stop **before** dispatch (the §13 all-fail
test asserts dispatch/worker are never invoked, not merely "no deposit").

**Human gate — PermissionCard approve/decline (Slice 1, KEEPS ITS TEETH — non-negotiable).** The
eligibility *display* (panel + fused sentence) is presentational, but the user's approve/**decline**
*action* is real enforcement and must NOT be demoted to cosmetic — human-in-the-loop approval is VF's
core differentiator. The existing flow already gates here (`screens.jsx` PermissionCard →
`app.jsx:1138 handlePermConfirm` → `startExecution`); decline must mean `startExecution` is never
called ⇒ no `orch.dispatch` ⇒ no deposit. F8 adds the verdict to this card without weakening the
decline path. So eligibility has **two independent teeth before dispatch**: machine auto-reject
(Enforcement A) AND human decline (this gate) — either one alone blocks the deposit. §13 adds a test:
a declined approval results in `orch.dispatch`/worker never invoked.

**Enforcement B — worker eligibility-token assertion (Slice 2, hardening, NOT bypass-proof against
malicious callers).** A small token `{ protocolSlug, planIndex, eligible:true, verdictHash, asOf }`
is computed at gate time and threaded by **plan index + protocol slug** (not address — all addresses
are identical). Threading edit points (named, since the critic showed these signatures don't carry
it today):
- `app.jsx:~1178` — add `protocolSlug` + `eligibilityToken` to each object in the `yvStrategy.vaults` map.
- `orchestrator.js:~45` — carry both through `vaultPlans`, and into `new WorkerAgent({...})` at `~99–110`.
- `worker.js:~25` — add `eligibilityToken` constructor param; between `worker.js:91` and `:92`,
  assert `token.eligible === true` && `now - token.asOf <= MAX_TOKEN_AGE_MS` &&
  `token.verdictHash === hash(threaded verdict)`; else throw → `failed` emit (`worker.js:125`).

The worker validates the **threaded** token/verdict (no fact re-fetch — that would violate §5's
no-live-call-on-stage rule). B defends against accidental internal skips, **not** a hand-crafted
malicious worker call (the on-chain scope handles that). "Bypass-proof" wording is deliberately not used.

## 8. The fused permission sentence (headline artifact — exact copy)

Rendered in the existing `screens.jsx` PermissionCard, before the user signs the session key. It is
**display**, and it collapses all three thesis layers into one decision. Required target copy
(co-emitting the testnet caveat is mandatory — the yield-real slot may never render bare):

> "Blend distributions are revenue-covered on mainnet (ratio ~1.0, source DeFiLlama). **This deposit
> is on testnet — APR illustrative.** Security 92/100 (our weighting). Target max loss −5%. Proceed?"

`buildPermission` slots: `mainnetYieldLabel` + **required** `testnetCaveat`, `securityScore` +
required `— our weighting` qualifier, `targetMaxLoss` (always "target", never "guaranteed").

## 9. Reject behavior (default #1)

- One protocol fails → drop it, re-normalize survivors to 100%, surface why. Healthy vaults still run.
- All fail → hard stop, honest message, nothing runs.
- Reasons list the failing test(s): e.g. *"Rejected: unaudited (audit gate); yield/revenue ratio 3.33
  (ponzi ≥ 1.5)."*

## 10. Demo fixture (default #2 — labeled, fixture-flagged)

```
HyperFarm  — label "demo fixture — illustrates rejection"
  audit:'none', ageDays:4, tvl:50_000, adminKey:'eoa',
  annualizedDistributed:10_000_000, protocolRevenue:3_000_000
  → yieldReality 'ponzi' (3.33); audit-gate fail; score 1  → REJECTED, reasons listed
```
- `isFixture:true` on its verdict; the gate output records the flag so it can **never** be reported
  as a real-world catch.
- UI: its **"demo fixture — illustrates rejection"** label renders adjacent to, and un-truncatable
  from, its reject row (§11). Honest that it is a controlled example.

## 11. UI surfacing

- **Eligibility panel** (`screens.jsx` PermissionCard, before session-key grant): per-protocol
  PASS/REJECT; the two scores **with the judgment qualifier** ("security 92/100 — our weighting");
  the **two-context** labels (§6) as two distinct lines; a **provenance chip** on the Blend row
  ("DeFiLlama · asOf <date>") so its numbers read as *captured data, not a hardcoded constant";
  rejected protocols struck-through with reasons; the fixture's demo label rendered inline.
- `agents.jsx` ExecuteCard unchanged for Slice 1 (gate ran upstream). A Slice-2 worker-token reject
  surfaces as a failed step with its reason.

## 12. Honesty rules (carried from Bagian 5 + project feedback)

- LLM writes the explanation sentence **only** — never pass/fail; a thrown LLM leaves the verdict
  unchanged (tested).
- "Target", never "guaranteed", for any loss/drawdown statement.
- Every figure tagged: `verified` (live/snapshot + source + asOf) vs `judgment` (weights, thresholds,
  the score) vs `hedged`. The score always renders with its "our weighting" qualifier.
- No claim the gate prevents loss — it filters *eligibility*; it does not guarantee outcomes.
- **Provenance integrity:** the optional live-refresh (Slice 2) writes `source:'live'` + a new `asOf`
  **only on a fully successful refresh of that specific field**; any failure/partial leaves the
  field's `source:'snapshot'` and original `asOf` untouched (tested). A snapshot is never relabeled live.

## 13. Test plan (TDD, fail-closed proofs)

`eligibilityGate.test.js` (pure, no network):
- Blend snapshot facts → `eligible:true`; fixture → `eligible:false` asserting **each** reason.
- **Per-field**: each of `REQUIRED_FACTS` absent **alone** → reject; each **stale** (asOf older than
  MAX_FACT_AGE) → reject.
- Test 1 symmetric unknown: missing/≤0 `annualizedDistributed` → `unknown` → reject; same for
  `protocolRevenue`. Ratio boundary at `PONZI_RATIO_MAX` rejects (strict `<`).
- Test 2: audit-gate — `audit:'none'` → reject; `audit` absent → reject (distinct reasons). Security
  score from a known component vector equals the **exact integer** and respects each cap; boundary at
  `SECURITY_MIN`. Assert `AGE_WEIGHT+TVL_WEIGHT+ADMIN_WEIGHT === 1.0`.
- Provenance echoed: verdict carries each field's `source` + `asOf`.

Pipeline / app-level:
- Basket re-normalize: drop one, survivors sum to 100%. `dispatchSet ⊆ survivors` (a rejected
  protocol produces zero plans/workers referencing it).
- Throwing `resolve` drops only that protocol; all-throw → hard stop. All-fail → **council,
  buildPermission, dispatch, worker never invoked**.
- LLM-explanation throws → verdict unchanged.
- **Human decline keeps its teeth:** a declined PermissionCard approval → `startExecution` /
  `orch.dispatch` / worker never invoked (no deposit), even when the basket has eligible survivors.

Honesty / UI:
- Permission sentence contains the testnet caveat adjacent to the yield slot; contains **no** bare
  "yield is real"/"real yield"; contains **no** mainnet TVL/revenue figure; score carries "our
  weighting". (Treated as fail-closed proofs.)
- Eligibility panel renders two distinct context lines (no merged mainnet/testnet line), the
  provenance chip, the struck-through reject + reason, and the fixture's "demo fixture" label.

Slice 2 (when built):
- Worker deposit **throws** when the token is absent / `eligible!==true` / stale
  (`>MAX_TOKEN_AGE_MS`) / `verdictHash` mismatch.
- Live-refresh failure preserves `source:'snapshot'` + prior `asOf`.

## 14. Risks / open items

- **DeFiLlama Blend metric** — confirm fees-vs-revenue and the exact `annualizedDistributed` window at
  snapshot capture; the Blend "ratio ≈ 1 → real" verdict must be **data-derived**, not asserted.
  Capture once off-stage and commit with `asOf`; record the metric choice in the snapshot note.
- **Pass-token (Slice 2)** — minimal internal struct; explicitly not a security boundary.
- **Weights/thresholds are judgment** — defensible defaults, labeled as judgment, never as objective.

## 15. Out of scope

- Wiring council/permission *enforcement* into the deposit path; real OJK/SEC legal classification;
  continuous post-deposit re-scoring (that's Lapis 2, already built); mainnet deposit; F9/F10.

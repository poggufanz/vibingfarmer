# Task 2 report: hide unproven yield

## Status

Complete. Task 2 is implemented on `fix/release-claim-truth` and committed. Flat catalog and DeFiLlama APYs remain reference/allocation data; only a fresh nested live execution-venue yield can produce a displayed or persisted APY.

## Files changed

- `frontend/src/strategy/venueTruth.js`
- `frontend/src/strategy/venueTruth.test.js`
- `frontend/src/components/strategy/PlanStage.jsx`
- `frontend/src/components/strategy/PlanStage.test.jsx`
- `frontend/src/components/OnboardingFlow.jsx`
- `frontend/src/components/OnboardingFlow.test.jsx`
- `frontend/src/components/VaultDetailPage.jsx`
- `frontend/src/components/VaultDetailPage.test.jsx`
- `frontend/src/history.js`
- `frontend/src/history.yield.test.js`
- `frontend/src/components/HistoryPanel.jsx`
- `frontend/src/components/HistoryPanel.test.jsx`
- `frontend/src/strategist.js`
- `frontend/src/components/WithdrawModal.jsx`

`defiLlama.js` was not modified. Existing untracked dependency symlinks/directories (`frontend/node_modules`, `keeper/node_modules`, `relayer/node_modules`) were preserved and not staged.

## RED

Exact command:

```bash
cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx
```

After adding the required router mock to the new HistoryPanel fixture, the pre-implementation run was RED: 6 test files failed, 13 tests failed, and 90 tests passed. Failures covered the missing history evidence field/APY normalization, catalog APY fallback in VaultDetailPage, static and live APY handling in OnboardingFlow, flat APY and estimate behavior in PlanStage, and HistoryPanel's unproven APY/static-data output. The initial fixture run also exposed the expected missing router context; the fixture was corrected before recording the implementation RED result.

## GREEN and verification

Exact focused command, after implementation:

```bash
cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx
```

Outcome: 6 test files passed, 103 tests passed. Vitest emitted the existing axe-test `HTMLCanvasElement.getContext()` jsdom warnings only.

Additional targeted regressions:

```bash
cd frontend && npx vitest run src/strategist.test.js src/strategist.crosschain.test.js
```

Outcome: 2 files passed, 34 tests passed.

```bash
cd frontend && npx vitest run src/components/WithdrawModal.test.jsx
```

Outcome: 1 file passed, 9 tests passed.

Prettier check on all changed JS/JSX files passed: all matched files use Prettier code style.

Targeted ESLint command:

```bash
cd frontend && npx eslint src/strategy/venueTruth.js src/strategy/venueTruth.test.js src/components/strategy/PlanStage.jsx src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.jsx src/components/VaultDetailPage.test.jsx src/history.js src/history.yield.test.js src/components/HistoryPanel.jsx src/components/HistoryPanel.test.jsx src/strategist.js src/components/WithdrawModal.jsx
```

Outcome: exit 0, 0 errors, 25 warnings. Warnings are existing unused React imports, console statements, and pre-existing hook/unused-symbol warnings; no new lint errors were introduced.

`git diff --check`: passed, both before and after staging.

## Self-review against requirements

- Added the exact flat-APY unavailable and nested fresh-live venue tests. Added the explicit boundary sentence: “Flat DeFiLlama APY is reference-market data, not live yield evidence for the Autofarm-to-Blend execution venue.” Kept the existing six-hour nested-live freshness guard and did not modify `defiLlama.js`.
- PlanStage now derives its estimate from `stellarYield.apy` only when `stellarYield.state === 'live'` and the amount is positive. Flat catalog APY shows `Yield unavailable` and does not render the 30-day estimate.
- Onboarding labels the section `Vault yield` until at least one row has nested live evidence. Static seed and flat fetched rows show names plus `Yield unavailable`; only nested fresh live rows render `ApyValue`. The wallet balance's `0.0% APY` remains explicitly a wallet-balance row. Reference APY history sparklines are also hidden unless the row is live.
- VaultDetailPage uses `venueYield(liveData || catalog)`, renders `Not available` for null APY, omits APY from position copy and the daily estimate, gates the APY chart, and removes `yv_prefill_apy` when no live APY exists. Nested fresh live data renders the APY, position copy, daily estimate, chart path, and prefill.
- Added `yieldEvidence` normalization to transaction, strategy, and reasoning history. `evidencedApy` persists finite APY only for explicit `live-venue`; otherwise APY and blended/selected-vault APY values are null. Legacy records remain readable but unavailable. `positionsFromHistory` no longer falls back to catalog APY.
- HistoryPanel gates transaction, strategy, and reasoning APY-derived text on stored live-venue evidence and replaces non-DeFiLlama `Static data` with `Yield unavailable`. DeFiLlama source labels are retained as source labels, never treated as evidence.
- Strategist passes live-venue evidence only when `venueYield(vault).state === 'live'`; current flat catalog/DeFiLlama and fallback records therefore persist null APY. WithdrawModal applies the same guard before transaction persistence.
- Staged only the 14 files named in the brief; no unrelated worktree changes were included.

## Commit

`bab3d59d50f5d898a263ae8943f5a2a75326e37c` — `fix(frontend): hide unproven yield`

## Concerns

- No current production feed supplies nested live execution-venue evidence, so current catalog/DeFiLlama-driven records intentionally show unavailable yield and persist null APY until such a feed is wired.
- Vitest retains the existing jsdom canvas warnings from accessibility tests, and targeted ESLint retains 25 warnings but no errors.

## Fix round 1

The follow-up review fixes keep persisted yield values tied to the execution venue. Strategist history now matches each selected vault to the catalog by case-insensitive address and protocol, reads APY only from a nested fresh live `yield` record, and never persists the model's `expected_apy`. Selected-vault APY, per-vault reasoning APY, and blended APY are all unavailable when any selected venue lacks that evidence. History normalization also keeps null, undefined, blank, and non-finite APY values unavailable even when a legacy record carries a `live-venue` label. Transaction detail display and strategy prefill require the same finite APY plus explicit live-venue evidence, clearing stale APY prefill otherwise.

Fresh verification in this fix round:

```bash
cd frontend && npx vitest run src/strategist.yield.test.js src/components/TxDetailPage.test.jsx src/history.yield.test.js
```

Outcome: 3 files passed, 7 tests passed.

```bash
cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx
```

Outcome: 6 files passed, 104 tests passed. The existing jsdom canvas warnings remain in the accessibility checks.

```bash
cd frontend && npx vitest run src/strategist.test.js src/strategist.crosschain.test.js src/components/WithdrawModal.test.jsx
```

Outcome: 3 files passed, 43 tests passed.

Targeted ESLint exited 0 with 0 errors and 20 existing warnings. Targeted Prettier checking passed. `git diff --check` passed. The untracked dependency directories were preserved and excluded from the commit.

The live APY path still depends on a producer supplying nested fresh execution-venue yield; flat catalog or DeFiLlama APY remains intentionally unavailable.

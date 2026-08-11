# Task 3 report: describe sponsored network fees

Status: `DONE_WITH_CONCERNS`

## Scope

Task 3 adds a deterministic, line-aware scanner for tracked public copy and replaces current
zero-fee/gas claims with the canonical Stellar/Base wording:

- `Network fee sponsored by fee-bump relay.`
- `Base network fee sponsored by relay.`

The scanner selects the root product documents, every `docs-site/` file, and the shipped JS/JSX
copy surfaces from the brief. It scans source comments on those surfaces, while leaving internal
implementation modules (including library identifiers such as `GaslessClient`) outside the public
surface predicate. It discovers inputs with `git ls-files`, reports `path:line`, pattern label, and
excerpt, and returns 0 for clean surfaces, 1 for findings, and 2 for discovery/read errors.

## Files changed

- `scripts/ci/public-claim-scan.mjs`: scanner patterns, public-surface predicate, tracked-file discovery, line-aware findings, and fail-closed CLI.
- `scripts/ci/public-claim-scan.test.mjs`: required case-insensitive fixtures, canonical/fallback clean fixtures, deterministic line ordering, and scope-selection tests.
- `frontend/src/components.jsx`, `frontend/src/agents.jsx`, `frontend/src/attestation.js`, `frontend/src/components/strategy/ProtectStage.jsx`, `frontend/src/components/strategy/PlanStage.jsx`, `frontend/src/components/SettingsPage.jsx`, `frontend/src/components/WithdrawModal.jsx`, `frontend/src/components/SkillEditModal.jsx`, `frontend/src/components/AgentActionPreview.jsx`, `frontend/src/components/LandingHero.jsx`, `frontend/src/screens.jsx`, `frontend/src/screens/Withdraw.jsx`, `frontend/src/components/money/WithdrawDialog.jsx`, `frontend/src/money/ownerActions.js`, `frontend/src/developers/OverviewSection.jsx`, `frontend/src/developers/KeysSection.jsx`, `frontend/src/developers/docsData.js`, `frontend/src/components/LandingFx.jsx`, `frontend/src/components/OnboardingFlow.jsx`, `frontend/src/components/EcosystemPage.jsx`, and `frontend/src/wallet/ui/classic/OnboardingScreen.jsx`: current UI copy and shipped source comments.
- `frontend/src/components/LandingHero.css`: stale relay animation comment.
- `frontend/src/components.sidebar.test.jsx`, `frontend/src/components/LandingHero.test.jsx`, `frontend/src/components/WithdrawModal.test.jsx`, `frontend/src/components/money/WithdrawDialog.test.jsx`, `frontend/src/money/ownerActions.test.js`, `frontend/src/components/strategy/ProtectStage.test.jsx`, and `frontend/src/components/strategy/PlanStage.test.jsx`: affected copy assertions.
- `README.md`, `prd.md`, `GETTING_STARTED.md`, `FEATURES.md`, `docs-site/architecture.md`, `docs-site/features.md`, `docs-site/how-it-works.md`, `docs-site/introduction.md`, `docs-site/quick-start.md`, and `docs-site/real-vs-demo.md`: canonical public documentation and truthful direct-fallback language.

The scanner also covered `docs-site/features.md` and the classic wallet onboarding comment called
out during audit. Internal Base/stellar implementation modules and the pre-existing untracked
dependency directories (`frontend/node_modules`, `keeper/node_modules`, `relayer/node_modules`)
were not staged.

## TDD RED

Initial required command, before the scanner module existed:

```bash
node --test scripts/ci/public-claim-scan.test.mjs
```

Result: failed as expected with `ERR_MODULE_NOT_FOUND` for
`scripts/ci/public-claim-scan.mjs`.

After adding regression fixtures for `gas-sponsored`, `fee-free`, and `fees covered`, the scanner
test failed again because those patterns were not yet defined. Adding the minimal definitions made
the suite green.

## Verification

Scanner unit tests:

```bash
node --test scripts/ci/public-claim-scan.test.mjs
```

Result: PASS, 1 test file / 5 subtests.

Required scanner CLI:

```bash
node scripts/ci/public-claim-scan.mjs
```

Result: PASS — `public-claim-scan OK: no banned claims in tracked public surfaces`.
The command required the approved elevated execution in this sandbox because Node's child `git`
process otherwise returned `spawnSync git EPERM`; the CLI itself returned 0 when run elevated.

Affected component suite:

```bash
cd frontend && npx vitest run src/components.sidebar.test.jsx src/components/LandingHero.test.jsx src/components/WithdrawModal.test.jsx src/components/money/WithdrawDialog.test.jsx src/money/ownerActions.test.js src/screens/Withdraw.test.jsx src/screens/Withdraw.unavailable.test.jsx src/components/strategy/ProtectStage.test.jsx src/components/strategy/PlanStage.test.jsx
```

Result: PASS, 9 files / 301 tests. Existing jsdom canvas, React Router future-flag, and reduced-
motion notices were emitted; no tests failed.

Targeted ESLint over changed frontend source/tests:

```bash
cd frontend && npx eslint src/components.jsx src/agents.jsx src/attestation.js src/components/AgentActionPreview.jsx src/components/EcosystemPage.jsx src/components/LandingFx.jsx src/components/LandingHero.jsx src/components/OnboardingFlow.jsx src/components/SettingsPage.jsx src/components/SkillEditModal.jsx src/components/WithdrawModal.jsx src/components/money/WithdrawDialog.jsx src/components/strategy/PlanStage.jsx src/components/strategy/ProtectStage.jsx src/developers/KeysSection.jsx src/developers/OverviewSection.jsx src/developers/docsData.js src/money/ownerActions.js src/screens.jsx src/screens/Withdraw.jsx src/wallet/ui/classic/OnboardingScreen.jsx src/components.sidebar.test.jsx src/components/LandingHero.test.jsx src/components/WithdrawModal.test.jsx src/components/money/WithdrawDialog.test.jsx src/money/ownerActions.test.js src/components/strategy/PlanStage.test.jsx src/components/strategy/ProtectStage.test.jsx
```

Result: exit 0, 0 errors and 18 existing warnings.

Targeted Prettier check over changed frontend/source scanner files:

```bash
cd frontend && npx prettier --check src/components.jsx src/agents.jsx src/attestation.js src/components/AgentActionPreview.jsx src/components/EcosystemPage.jsx src/components/LandingFx.jsx src/components/LandingHero.jsx src/components/OnboardingFlow.jsx src/components/SettingsPage.jsx src/components/SkillEditModal.jsx src/components/WithdrawModal.jsx src/components/money/WithdrawDialog.jsx src/components/strategy/PlanStage.jsx src/components/strategy/ProtectStage.jsx src/developers/KeysSection.jsx src/developers/OverviewSection.jsx src/developers/docsData.js src/money/ownerActions.js src/screens.jsx src/screens/Withdraw.jsx src/wallet/ui/classic/OnboardingScreen.jsx src/components.sidebar.test.jsx src/components/LandingHero.test.jsx src/components/WithdrawModal.test.jsx src/components/money/WithdrawDialog.test.jsx src/money/ownerActions.test.js src/components/strategy/PlanStage.test.jsx src/components/strategy/ProtectStage.test.jsx ../scripts/ci/public-claim-scan.mjs ../scripts/ci/public-claim-scan.test.mjs
```

Result: PASS — all matched files use Prettier code style.

```bash
git diff --check
```

Result: PASS with no whitespace errors.

## Concerns

- The scanner CLI's repository discovery is environment-sensitive only in this restricted sandbox;
  its required elevated run passed with exit 0. This does not alter scanner behavior or its
  fail-closed exit-2 path.
- Existing targeted-suite notices and lint warnings remain as documented above; there are no new
  test failures or lint errors.
- The public-surface predicate intentionally excludes CSS and internal chain/client modules per
  the brief. The one stale LandingHero CSS comment was corrected manually; internal implementation
  identifiers remain untouched.

## Commit

Final scoped commit:

```text
fix(copy): describe sponsored network fees
```

## Fix round 1

The follow-up closes the remaining payer-truth gaps. `docs-site/faq.md` now uses the exact
`Network fee sponsored by fee-bump relay.` sentence and explains the direct, wallet-paid grant
fallback, revoke kill switches, and classic-owner full-exit path (while keeping passkey full exits
relay-only and partial exits relay-backed). `SkillDetailModal` now renders the canonical
`Network fee` / `Sponsored by fee-bump relay` row. `TxDetailPage` derives its `Network fee` value
only from the persisted submission channel: relay → `Sponsored by fee-bump relay`, direct →
`Paid by wallet`, and missing legacy evidence → `Unavailable`; it never trusts a legacy
`gasPayedBy` string.

History no longer defaults an absent payer to the relay. It persists `channel` only when the
owner-authorization result proves `relay` or `direct`, maps those to `fee-bump-relayer` or
`wallet`, and maps missing/legacy evidence to `unavailable`. `partialWithdraw` returns its
relay-backed channel. Full sweeps carry per-agent channels from `stellar/exit.js` through
`agents/agentController.js`, and both the full-exit modal and emergency-exit history pass that
evidence to `saveTransaction`.

The scanner keeps discovery and reads rooted at `git rev-parse --show-toplevel`, reports root-
relative paths, rejects `You don't.`, `Fee-bump sponsored`, and `Network fee paid by`, and now has
fixture coverage for nested-cwd success (exit 0), finding/output details (exit 1), tracked-file
read failure, and discovery failure (exit 2).

### TDD RED

Before the payer propagation implementation, the focused frontend command was RED: 7 files,
11 failed tests, and 74 passed. Failures covered the history default, missing exit/sweep/partial
channels, controller propagation, modal history, and canonical Skill/Tx rows. The implementation
then made the same focused command green. Scanner follow-up fixtures were run against the existing
fail-closed scanner implementation; the first nested-cwd assertion exposed that the test itself
derived a second `frontend/` path when launched from the nested cwd, so it was corrected to resolve
the repository root before constructing the nested fixture.

### Verification

```text
node --test scripts/ci/public-claim-scan.test.mjs                         PASS — 11/11
node scripts/ci/public-claim-scan.mjs                                    PASS — exit 0, clean
cd frontend && node --test ../scripts/ci/public-claim-scan.test.mjs      PASS — 11/11
cd frontend && node ../scripts/ci/public-claim-scan.mjs                  PASS — exit 0, clean
```

Focused payer/channel suite:

```text
cd frontend && npx vitest run src/history.yield.test.js src/stellar/exit.test.js \
  src/stellar/partialWithdraw.test.js src/agents/agentController.test.js \
  src/components/SkillDetailModal.test.jsx src/components/TxDetailPage.test.jsx \
  src/components/WithdrawModal.test.jsx
```

Result: PASS, 7 files / 85 tests.

Original Task 3 affected suite:

```text
cd frontend && npx vitest run src/components.sidebar.test.jsx src/components/LandingHero.test.jsx \
  src/components/WithdrawModal.test.jsx src/components/money/WithdrawDialog.test.jsx \
  src/money/ownerActions.test.js src/screens/Withdraw.test.jsx \
  src/screens/Withdraw.unavailable.test.jsx src/components/strategy/ProtectStage.test.jsx \
  src/components/strategy/PlanStage.test.jsx
```

Result: PASS, 9 files / 302 tests. Existing jsdom canvas, React Router, and reduced-motion
notices remain; no tests failed.

Targeted ESLint: exit 0, 0 errors, 56 existing warnings. Targeted Prettier check: PASS. `git
diff --check`: PASS. Scanner commands required elevated execution in this restricted sandbox
because child `git` processes otherwise receive `spawnSync git EPERM`; the nested-cwd runs passed
with the approved elevation. The pre-existing untracked dependency directories were preserved and
not staged.

## Fix round 2

This follow-up closes the remaining public-copy and scanner gaps without changing the
fee-bump implementation. The grandmother metaphor now describes the courier stamping the
transaction before departure, followed by the exact canonical sentence `Network fee sponsored
by fee-bump relay.`. The scanner rejects claim-shaped third-party promises such as a relay or
courier paying gas/network fees so the user does not have to, while leaving ordinary operational
prose alone. The `network-fee-paid-by` pattern allows an explicit wallet payer (including the
canonical `Network fee paid by wallet`) but continues to reject the incomplete `Network fee paid
by` claim.

The scanner test now launches the real CLI in temporary fixtures and asserts exit 0 for clean
copy, exit 1 with a finding, and exit 2 for both a tracked-file read failure and repository
discovery failure. The fixture cases run from both a repository root and a nested `frontend`
directory where applicable; the pre-existing untracked dependency directories remain untouched.

### TDD RED/GREEN

The new courier fixture `A courier pays their bus fare (gas) so you don't have to.` initially
failed to match the narrower regex. The regex was then widened only between the actor, `pays`,
and gas/network-fee phrase, retaining the required `so you don't have to` claim shape. The
scanner suite then passed all 13 subtests, including the child-process status matrix.

### Verification

```text
node --test scripts/ci/public-claim-scan.test.mjs                         PASS — 13/13 (elevated; child git fixtures)
node scripts/ci/public-claim-scan.mjs                                    PASS — exit 0 from repository root
cd frontend && node ../scripts/ci/public-claim-scan.mjs                  PASS — exit 0 from frontend
cd frontend && ./node_modules/.bin/prettier --check ../scripts/ci/public-claim-scan.mjs ../scripts/ci/public-claim-scan.test.mjs
                                                                           PASS
git diff --check                                                           PASS
```

The unprivileged scanner test/CLI attempts were blocked by this sandbox's `spawnSync git EPERM`
restriction; the same commands passed with the approved elevated execution. No frontend runtime
suite was affected by this documentation/scanner-only follow-up.

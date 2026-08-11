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

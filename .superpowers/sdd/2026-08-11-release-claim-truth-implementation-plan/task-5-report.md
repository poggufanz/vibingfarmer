# Task 5 report — publish claim evidence and freeze features

## Implemented

- Added the checked-in machine-readable evidence matrix with the seven required proven claim IDs,
  exact `v1.15.0-beta` candidate metadata, active `feat` freeze, local evidence paths, commands,
  and stable candidate/preview locators.
- Added the human-readable [EVIDENCE_MATRIX.md](../../../EVIDENCE_MATRIX.md). It documents why
  the annotated tag is the candidate locator instead of a published GitHub Release: publishing a
  GitHub Release triggers the production Cloudflare Pages deployment.
- Added fail-closed `validateEvidenceMatrix`, `evaluateFeatureFreeze`, and
  `verifyCandidateIdentity` helpers. The CLI validates local evidence on every run, evaluates
  event commit ranges with `git log --format=%s BASE..HEAD`, requires all candidate identity
  variables together, and distinguishes policy exit 1 from unreadable/malformed exit 2.
- Added the root-level Node 22 `claim-evidence` workflow job with full history, the exact
  push/pull-request/merge-group range environment expressions, public scanner, validator tests,
  and aggregate release-gate dependency. `REQUIRED_JOBS` now includes `claim-evidence` and no
  workflow step uses `continue-on-error`.
- Linked the evidence matrix from README and updated the CI job count/description.

## TDD RED/GREEN

The initial focused run failed because `scripts/ci/claim-evidence.mjs` and the required workflow
job did not exist. After the minimal implementation and workflow wiring, the same tests passed.

## Verification

```text
node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs
  PASS — 77 tests, 0 failures
node scripts/ci/public-claim-scan.mjs
  PASS — no banned claims
node scripts/ci/claim-evidence.mjs
  PASS — matrix, freeze, and candidate checks passed
git diff --check
  PASS
targeted Prettier check (new Task 5 JS/JSON/Markdown files)
  PASS
```

The Node CLI checks were run with the sandbox's approved elevated process-spawn access because
unprivileged child `node`/`git` processes return `spawnSync ... EPERM` in this environment.

No push, deployment, GitHub Release, or tag was performed. The pre-existing untracked dependency
directories were preserved and not staged.

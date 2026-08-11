# Task 5 report — publish claim evidence and freeze features

## Implemented

- Added the checked-in machine-readable evidence matrix with the seven required proven claim IDs,
  exact `v1.15.1-beta` candidate metadata, active `feat` freeze, local evidence paths, commands,
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

## Fix round 1

- Replaced the candidate verification command in the JSON and human matrix with independent
  `CANDIDATE_TAG_SHA=$CANDIDATE_SHA`, `PREVIEW_COMMIT_SHA=$PREVIEW_SHA`, and
  `PREVIEW_URL=$CANDIDATE_PREVIEW_URL` inputs. The candidate section now explains that the
  preview SHA comes from the successful post-preview deployment metadata and must not be copied
  from the tag variable.
- Added the exact owner, verification command, minimum source/test evidence, and candidate
  locator contract for every required claim ID. The matrix now enumerates Task 1–4 permission,
  yield, payer/channel, Explorer, scanner, and release-gate evidence paths instead of accepting
  README-only proof. Candidate locators are exact HTTPS GitHub/Pages hosts and are checked both
  structurally and by URL parsing.
- Added a fail-closed release-event policy: when the checked-in candidate has
  `productionPublish: false`, `GITHUB_EVENT_NAME=release` exits `1`. Subprocess coverage and a
  workflow regression test prove the claim job runs for published releases, feeds
  `release-gate`, and leaves `deploy` dependent only on that aggregate gate.
- Evidence paths that are missing or outside the repository remain policy failures (`1`), while
  unreadable/non-file evidence is classified as malformed input (`2`), including deterministic
  mode-bit coverage when tests run as root.

### TDD RED/GREEN

The focused Node run first failed at module loading because `CLAIM_CONTRACTS` did not exist. After
the contract, event policy, locator, and unreadable-evidence implementation, the complete suite
passed.

### Verification

```text
node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs
  PASS — 67 subtests / 85 tests, 0 failures
node scripts/ci/public-claim-scan.mjs
  PASS — no banned claims
node scripts/ci/claim-evidence.mjs
  PASS — matrix, freeze, and candidate checks passed
GITHUB_EVENT_NAME=release node scripts/ci/claim-evidence.mjs
  PASS — policy failure, exit 1 (asserted by subprocess test)
./frontend/node_modules/.bin/prettier --check EVIDENCE_MATRIX.md release/evidence-matrix.json scripts/ci/claim-evidence.mjs scripts/ci/claim-evidence.test.mjs
  PASS — release-gate.test.mjs and README.md retain their repository baseline formatting to avoid mechanical churn
git diff --check
  PASS
```

No push, tag, GitHub Release, deployment, or production publish was performed. The pre-existing
untracked dependency directories remain untouched and unstaged.

# Release claim evidence matrix

Candidate: `v1.15.0-beta` targeting `dev` in the `vibing-farmer` Cloudflare Pages project.

The machine-readable source of truth is [`release/evidence-matrix.json`](release/evidence-matrix.json).
Every row is marked `proven`, names an owner, points to checked-in evidence, and includes the
command used to verify it. The CI `claim-evidence` job validates the matrix, scans public copy,
and evaluates the active feature freeze before the aggregate `release-gate` can pass.

## Candidate locator

The annotated Git tag `v1.15.0-beta` is the candidate locator. We intentionally use an annotated
tag instead of publishing a GitHub Release: in this repository, publishing a GitHub Release
triggers the production Cloudflare Pages deployment. The candidate tag and the successful
Cloudflare preview must resolve to the same commit; the release-time verifier accepts only
matching lowercase 40-character commit SHAs and an HTTPS `vibing-farmer.pages.dev` URL.

## Claims

| ID                        | Owner    | Evidence                                                                               | Verification                                                                                                                                                                                                                                             |
| ------------------------- | -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission-lifetime`     | strategy | [`permissionWindow.js`](frontend/src/strategy/permissionWindow.js), Protect flow tests | `cd frontend && npx vitest run src/strategy/permissionWindow.test.js src/strategy/flowState.test.js src/components/strategy/ProtectStage.test.jsx`                                                                                                       |
| `yield-availability`      | frontend | venue truth, Plan/onboarding/vault/history tests                                       | `cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx` |
| `sponsored-network-fee`   | copy     | public scanner and shipped UI/docs copy                                                | `node --test scripts/ci/public-claim-scan.test.mjs && node scripts/ci/public-claim-scan.mjs`                                                                                                                                                             |
| `stellar-explorer-counts` | explorer | deployment facts, Explorer tests, Stellar manifest                                     | `cd frontend && npx vitest run src/stellar/deploymentFacts.test.js src/components/ExplorerPage.test.jsx`                                                                                                                                                 |
| `candidate-same-commit`   | release  | design specification and workflow                                                      | `CANDIDATE_TAG_SHA=$CANDIDATE_SHA PREVIEW_COMMIT_SHA=$CANDIDATE_SHA PREVIEW_URL=$CANDIDATE_PREVIEW_URL node scripts/ci/claim-evidence.mjs`                                                                                                               |
| `required-checks`         | release  | workflow, aggregate gate, and CI tests                                                 | `node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs`                                                                                                                                  |
| `feature-freeze`          | release  | release plan/specification and freeze validator tests                                  | `node --test scripts/ci/claim-evidence.test.mjs && node scripts/ci/claim-evidence.mjs`                                                                                                                                                                   |

## Freeze policy

The freeze was activated on `2026-08-11`. Conventional `feat` subjects, including scoped
breaking subjects such as `feat(ui)!: ...`, are rejected in the event commit range. Fixes,
tests, documentation, CI, and release chores remain permitted. The validator reads the range
with `git log --format=%s BASE..HEAD`; a malformed or unreadable range fails closed with exit 2,
while a policy violation exits 1.

## Verification exit codes

- Exit `0`: all local claims and any supplied release identity/range checks pass.
- Exit `1`: a claim, freeze, or candidate identity policy is not proven.
- Exit `2`: the matrix, evidence input, or required environment/range input is unreadable or malformed.

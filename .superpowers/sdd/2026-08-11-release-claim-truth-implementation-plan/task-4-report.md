# Task 4 report — Explorer deployment facts

## Implemented

- Added `frontend/src/stellar/deploymentFacts.js`, importing the tracked Stellar manifest and
  freezing the seven source-crate names plus the eight ordered static deployment records.
- Derived first-party, external, and total address counts from record ownership/array length.
- Replaced Explorer's local three-contract list and contract-test claim with eight categorized
  address cards, ownership labels, the exact 7/6/2/8 deployment facts, and `N per run` agents.
- Updated README, PRD, Getting Started, FEATURES, and the docs-site contract/architecture/how-it-works
  pages. Current V2 router and current agent WASM value are identified correctly; the WASM value is
  described as a hash, not an address. Base Sepolia material remains in its own sections.

## Verification

- RED confirmed: focused Vitest run failed on the missing facts module and old Explorer copy.
- GREEN: `npx vitest run src/stellar/deploymentFacts.test.js src/components/ExplorerPage.test.jsx`
  — 4 tests passed.
- Targeted ESLint — 0 errors/warnings.
- Targeted Prettier check — passed.
- `git diff --check` — passed.
- `npm run build` — passed; existing Rollup chunk-size/dynamic-import warnings only.
- `node scripts/ci/public-claim-scan.mjs` — passed with no banned public claims.

No deployment, push, or unrelated-file changes were made.

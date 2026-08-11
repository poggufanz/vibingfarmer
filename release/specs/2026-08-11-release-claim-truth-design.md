# Release Claim Truth — Design

Date: 2026-08-11
Candidate: `v1.15.0-beta`
Target branch: `dev`

## Objective

Make the public product claims match the code and the live Stellar testnet deployment, publish the supporting evidence, and freeze feature expansion behind a fail-closed release gate. This candidate does not deploy new contracts or publish to production.

## Scope and invariants

- The user chooses one permission lifetime in Protect. That lifetime governs both the agent authorization and the SEP-41 allowance created by the grant.
- Numeric yield is shown only when a live data response supplies a finite APY. Catalog values remain allocation metadata, never live-yield evidence.
- Sponsored transactions are described as having a sponsored network fee. The product does not claim that a transaction has no gas or no fee.
- Explorer distinguishes source crates, first-party static deployments, external protocol contracts, and dynamic per-run agent accounts.
- The release candidate tag and Cloudflare preview must resolve to the same Git commit.
- A release may pass only when every matrix row names its evidence and every required verification succeeds.
- Once the freeze is active, conventional `feat` commits fail the release gate. Fixes, tests, documentation, CI, and release-evidence work remain allowed.

## 1. Permission lifetime

### User model

Protect remains the single place where the user selects a duration such as 24 hours or 7 days. The selected duration is bound when permission preflight begins. The UI calls this the permission lifetime and explains that Stellar represents it with two cutoffs.

### Data model

A pure helper binds a reviewed plan to a permission window:

1. Capture `checkedAt` once in Unix seconds.
2. Compute `expiresAt = checkedAt + durationSeconds`.
3. Replace every agent's timestamp `expiry` with `expiresAt`.
4. Recompute the plan fingerprint from the rebound plan.
5. Pass the same `checkedAt`, `durationSeconds`, rebound `AgentInit` values, and budgets into permission preflight.

The V2 grant keeps its existing contract representations:

- `AgentInit.expiry` is the exact Unix timestamp checked by `agent_account`.
- `durationSeconds` is converted by the router client into the SEP-41 allowance's ledger cutoff.

Those numbers are intentionally different units and are not presented as identical on-chain fields. They describe the same user-selected lifetime. The reviewed plan and permission decision must contain the same agent expiry, so the existing plan/permission equality guard continues to fail closed.

### State transition

The strategy-flow reducer accepts an explicit protect-stage plan-binding event before preflight success is recorded. The event replaces the reviewed plan and fingerprint atomically. The app also uses that rebound plan in the in-flight preflight call, avoiding reliance on asynchronous React state.

If rebinding or preflight fails, no permission decision is stored and execution remains blocked.

## 2. Yield truth

`venueTruth.js` remains the canonical live-data state model. Numeric APY, projected earnings, or yield-derived position values require an explicit finite APY from a live feed for the actual execution venue. The current flat DeFiLlama rows are reference-market inputs mapped to the single Stellar vault; they are not evidence of that vault's Blend APY and therefore remain unavailable for product-yield display.

The affected surfaces follow the same rules:

- Loading: show a loading label or skeleton, without a number.
- Live finite APY: show the APY and calculations derived from it.
- Unavailable, stale without an accepted live value, malformed, or failed request: show `Yield unavailable` or `Not available`; omit derived earnings.

Static catalog and flat DeFiLlama APYs may still be used internally for allocation heuristics where already required, but they must not be rendered as current execution-venue yield and must not be persisted into history as observed APY. History records without explicit live-venue evidence store `apy: null`.

## 3. Sponsored-fee copy

Public UI and tracked onboarding/product documentation use the canonical statement:

> Network fee sponsored by fee-bump relay.

Base-specific surfaces may say `Base network fee sponsored by relay.` Direct wallet-paid fallbacks remain explicit where they actually exist. Claims such as `gas 0`, `zero gas`, `gas-free`, `0 XLM`, or `0 USDC` as a gas cost are removed from current product surfaces.

A repository claim scanner rejects the banned public phrases in an allowlisted set of shipped UI and tracked public documentation. The scanner has unit tests over controlled fixtures so its matching and exemptions are deterministic.

## 4. Explorer facts

Explorer reads a single frontend deployment-facts module whose values are tested against `deployments/stellar-testnet.json`. It presents four separate facts:

- 7 Soroban source crates.
- 6 live first-party Stellar deployments: funding router V2, autofarm vault, Blend strategy, exit router, attestation, and registry.
- 2 external protocol contracts used by that stack: Blend pool and Stellar testnet USDC token.
- 8 total static addresses, plus dynamic agent accounts created per run.

The page lists all eight static addresses with ownership/type labels. It does not count a WASM hash as a deployed contract and does not mix Base Sepolia deployments into the Stellar Explorer. The drifting hard-coded contract-test count is replaced by the dynamic-agent fact.

## 5. Evidence matrix and freeze

The repository publishes:

- `release/evidence-matrix.json` as the machine-readable source of truth.
- `EVIDENCE_MATRIX.md` as the human-readable index linked from the README.
- `scripts/ci/claim-evidence.mjs` to validate schema, required rows, local evidence paths, freeze state, and candidate tag format.
- Unit tests for the validator and freeze decision.

Each claim row records an owner, status, verification command, and one or more evidence locators. No row may be `proven` with an empty command or missing local evidence. External release evidence is expressed through stable locators—the candidate tag and the Cloudflare deployment API/URL—and is verified at release time against the resolved commit rather than copied into a recursively changing source file.

The active freeze config rejects `feat` conventional commits in the event's candidate range. The workflow runs the claim scanner and evidence/freeze validator before the aggregate release gate can succeed.

## 6. Candidate publication

The work lands through a pull request into `dev`, because the existing workflow deploys previews only for `dev` pushes and never deploys pull requests. After the merge workflow succeeds:

1. Resolve the merge commit SHA.
2. Resolve the successful Cloudflare preview deployment for that exact SHA.
3. Create and push annotated tag `v1.15.0-beta` on that same merge commit.
4. Re-run the release-evidence verifier with the tag SHA and Cloudflare deployment SHA.

Only the tag is created; no GitHub Release is published because this repository intentionally maps a published GitHub Release to a production deployment.

## Verification strategy

- Test-first unit coverage for lifetime rebinding, reducer transition, yield-unavailable rendering/data shaping, Explorer deployment facts, claim scanning, matrix validation, and freeze decisions.
- Existing frontend unit, lint, formatting, brand, manifest, build, extension, visual, relayer, keeper, and Soroban checks remain required by CI.
- Local focused tests run during implementation; the full repository verification runs before merge.
- External verification records the GitHub workflow URL, candidate SHA/tag, and Cloudflare preview URL and confirms all three resolve to the same commit.

## Non-goals

- No new Soroban deployment or contract ABI.
- No Router V3/Agent V4 activation.
- No production Pages deployment or GitHub Release publication.
- No new product feature beyond truthfulness, evidence, and release controls.

# Release Claim Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align expiry, yield, fee, and Explorer claims with the live Stellar system, then publish a validated evidence matrix and activate a fail-closed feature freeze for `v1.15.2-beta`.

**Architecture:** Pure boundary helpers bind a reviewed plan to one permission window, while the existing venue-truth boundary permits numeric yield only for explicit evidence about the actual execution venue. Public deployment facts and release claims each get a checked-in source of truth with executable validators wired into the existing aggregate release gate. The final `dev` merge SHA is both the Cloudflare preview source and annotated candidate tag target.

**Tech Stack:** React 18, Vite 5, Vitest 2, Node 22 built-in test runner, Soroban/Stellar deployment JSON, GitHub Actions, Cloudflare Pages.

## Global Constraints

- Primary chain is Stellar testnet; Base Sepolia is optional and must not be counted on the Stellar Explorer.
- Do not add 1Shot dependencies, imports, copy, or environment variables.
- No contract ABI change, WASM upload, contract deployment, production Pages deploy, or GitHub Release publication.
- The permission presets remain exactly `1 hour`, `24 hours`, and `7 days`.
- One selected duration must produce both the agents' Unix `expiry` and the allowance ledger cutoff from the same captured `checkedAt`.
- Numeric yield requires explicit `state: 'live'` with a finite numeric `apy` for the actual execution venue; flat catalog and DeFiLlama reference-market `apy` values never qualify.
- Canonical Stellar copy is exactly `Network fee sponsored by fee-bump relay.`
- Canonical Base copy is exactly `Base network fee sponsored by relay.`
- Explorer counts are exactly 7 Soroban source crates, 6 first-party static Stellar deployments, 2 external protocol contracts, and 8 total static addresses; agent accounts are dynamic per run.
- Candidate tag is exactly `v1.15.2-beta`; target branch is `dev`; Cloudflare Pages project is `vibing-farmer`.
- Use test-first RED/GREEN cycles for behavior and validator changes. Documentation-only replacements do not require a new unit test.
- Preserve unrelated user changes and never edit the original dirty worktree.

---

## File structure

- `frontend/src/strategy/permissionWindow.js`: validates and binds a plan to one permission window.
- `frontend/src/strategy/permissionWindow.test.js`: pure expiry/fingerprint tests.
- `frontend/src/strategy/flowState.js` and `.test.js`: protect-stage plan replacement event.
- `frontend/src/app.jsx`: composes the bound plan into preflight with one captured time.
- `frontend/src/components/strategy/ProtectStage.jsx` and `.test.jsx`: truthful two-clock lifetime explanation.
- `frontend/src/components/{OnboardingFlow,VaultDetailPage,HistoryPanel}.jsx`: conditional yield rendering.
- `frontend/src/components/strategy/PlanStage.jsx`: live-yield-only estimates.
- `frontend/src/history.js` and its tests: persist and derive yield only with live evidence.
- `scripts/ci/public-claim-scan.mjs` and `.test.mjs`: deterministic sponsored-fee claim scanner.
- `frontend/src/stellar/deploymentFacts.js` and `.test.js`: checked-in Explorer facts verified against the deployment manifest.
- `frontend/src/components/ExplorerPage.jsx` and `.test.jsx`: render complete, categorized Stellar deployment facts.
- `release/evidence-matrix.json`: machine-readable claim evidence and freeze policy.
- `EVIDENCE_MATRIX.md`: public human-readable evidence index.
- `scripts/ci/claim-evidence.mjs` and `.test.mjs`: matrix, freeze-range, and independently
  resolved same-commit validators.
- `.github/workflows/frontend.yml`, `scripts/ci/release-gate.mjs`, and `.test.mjs`: make claim evidence a required job.

---

### Task 1: Bind one permission lifetime across UI and grant inputs

**Files:**

- Create: `frontend/src/strategy/permissionWindow.js`
- Create: `frontend/src/strategy/permissionWindow.test.js`
- Modify: `frontend/src/strategy/flowState.js`
- Modify: `frontend/src/strategy/flowState.test.js`
- Modify: `frontend/src/app.jsx`
- Modify: `frontend/src/components/strategy/ProtectStage.jsx`
- Modify: `frontend/src/components/strategy/ProtectStage.test.jsx`
- Modify: `README.md`
- Modify: `prd.md`
- Modify: `FEATURES.md`

**Interfaces:**

- Consumes: `hashStrategy(plan)` from `frontend/src/attestation.js`, `preflightPermission({... nowSec, durationSeconds, agentInits })`, and existing `AgentInit.expiry` Unix seconds.
- Produces: `bindPlanToPermissionWindow(plan, { checkedAt, durationSeconds }) -> reboundPlan` where every agent expiry equals `checkedAt + durationSeconds` and `reboundPlan.planFingerprint === hashStrategy(reboundPlan)`.
- Produces: reducer event `{ type: 'PERMISSION_WINDOW_BOUND', plan: reboundPlan }`, applicable only in `moment === 'protect'`.

- [ ] **Step 1: Write failing pure and reducer tests**

Add cases equivalent to:

```js
it("binds every agent and the fingerprint to the same selected lifetime", () => {
  const original = makePlan({ expiries: [101, 202] });
  const rebound = bindPlanToPermissionWindow(original, {
    checkedAt: 1_800_000_000,
    durationSeconds: 86_400,
  });
  expect(rebound.agents.map((agent) => agent.expiry)).toEqual([
    1_800_086_400, 1_800_086_400,
  ]);
  expect(rebound.planFingerprint).toBe(hashStrategy(rebound));
  expect(original.agents.map((agent) => agent.expiry)).toEqual([101, 202]);
});

it.each([0, -1, 1.5, Number.NaN])(
  "rejects invalid duration %s",
  (durationSeconds) => {
    expect(() =>
      bindPlanToPermissionWindow(makePlan(), {
        checkedAt: 1_800_000_000,
        durationSeconds,
      }),
    ).toThrow("durationSeconds must be a positive integer");
  },
);

it("replaces the protect plan and invalidates an older permission", () => {
  const before = {
    ...toProtect(),
    permission: decision(),
    permissionStatus: "preflight-ready",
  };
  const rebound = { ...before.plan, planFingerprint: "0xnew" };
  const after = strategyFlowReducer(before, {
    type: "PERMISSION_WINDOW_BOUND",
    plan: rebound,
  });
  expect(after.plan).toBe(rebound);
  expect(after.permission).toBeNull();
  expect(after.permissionStatus).toBe("idle");
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `cd frontend && npx vitest run src/strategy/permissionWindow.test.js src/strategy/flowState.test.js`

Expected: FAIL because `permissionWindow.js` and `PERMISSION_WINDOW_BOUND` do not exist.

- [ ] **Step 3: Implement the pure binder and reducer event**

Use this contract:

```js
import { hashStrategy } from "../attestation.js";

export function bindPlanToPermissionWindow(
  plan,
  { checkedAt, durationSeconds } = {},
) {
  if (!Number.isInteger(checkedAt) || checkedAt <= 0) {
    throw new Error("checkedAt must be a positive integer");
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error("durationSeconds must be a positive integer");
  }
  if (!plan || !Array.isArray(plan.agents))
    throw new Error("plan.agents must be an array");
  const expiry = checkedAt + durationSeconds;
  const rebound = {
    ...plan,
    agents: plan.agents.map((agent) => ({ ...agent, expiry })),
  };
  return { ...rebound, planFingerprint: hashStrategy(rebound) };
}
```

The reducer event must clear `permission`, reset `permissionStatus` to `idle`, clear `permissionError` and `protectMessage`, and set `retryable: false`. Return the original state for any non-Protect moment or invalid plan.

- [ ] **Step 4: Compose the exact same plan and time into preflight**

In `onRetryPreflight`, replace reads from the old plan with:

```js
const checkedAt = Math.floor(Date.now() / 1000);
const plan = bindPlanToPermissionWindow(strategyFlowRef.current.plan, {
  checkedAt,
  durationSeconds,
});
dispatchFlow({ type: "PERMISSION_WINDOW_BOUND", plan });
const agentInits = plan.agents.map((agent) =>
  planAgentToAgentInit(agent, baseKernel),
);
const reviewedBudgets = planReviewedBudgets(plan.agents);
```

Pass `nowSec: checkedAt` to `preflightPermission`. Compose the V3 decision and all plan fingerprints from this rebound `plan`, never `strategyFlowRef.current.plan` again inside the call.

- [ ] **Step 5: Add integration/copy assertions and implement the Protect explanation**

Update `ProtectStage.test.jsx` to select `7 days`, run permission check, and assert the callback receives `604800`. Assert the review renders both `Permission lifetime: 7 days` and this exact sentence:

```text
Stellar stores this as an agent timestamp and an allowance ledger cutoff derived from the same lifetime.
```

Keep ledger sequence values labeled as ledger numbers and Unix values formatted as time; never pass one to the other's formatter.

- [ ] **Step 6: Align tracked architecture narrative**

In README, PRD, and FEATURES, replace singular ambiguous expiry claims with this fact:

```text
One selected permission lifetime is encoded as an agent Unix expiry and a SEP-41 allowance ledger cutoff derived from the same captured start time.
```

Retain explicit statements that Router V3/Agent V4 are source-only and not live.

- [ ] **Step 7: Run focused tests and commit**

Run: `cd frontend && npx vitest run src/strategy/permissionWindow.test.js src/strategy/flowState.test.js src/components/strategy/ProtectStage.test.jsx`

Expected: PASS.

Commit:

```bash
git add frontend/src/strategy/permissionWindow.js frontend/src/strategy/permissionWindow.test.js frontend/src/strategy/flowState.js frontend/src/strategy/flowState.test.js frontend/src/app.jsx frontend/src/components/strategy/ProtectStage.jsx frontend/src/components/strategy/ProtectStage.test.jsx README.md prd.md FEATURES.md
git commit -m "fix(strategy): bind one permission lifetime"
```

---

### Task 2: Hide yield whenever live evidence is unavailable

**Files:**

- Modify: `frontend/src/strategy/venueTruth.js`
- Modify: `frontend/src/strategy/venueTruth.test.js`
- Modify: `frontend/src/components/strategy/PlanStage.jsx`
- Modify: `frontend/src/components/strategy/PlanStage.test.jsx`
- Modify: `frontend/src/components/OnboardingFlow.jsx`
- Create: `frontend/src/components/OnboardingFlow.test.jsx`
- Modify: `frontend/src/components/VaultDetailPage.jsx`
- Create: `frontend/src/components/VaultDetailPage.test.jsx`
- Modify: `frontend/src/history.js`
- Create: `frontend/src/history.yield.test.js`
- Modify: `frontend/src/components/HistoryPanel.jsx`
- Create: `frontend/src/components/HistoryPanel.test.jsx`
- Modify: `frontend/src/strategist.js`
- Modify: `frontend/src/components/WithdrawModal.jsx`

**Interfaces:**

- Consumes: `venueYield(raw) -> { state: 'live'|'none'|'unavailable', apy: number|null }`.
- Preserves: flat DeFiLlama and catalog APYs as reference/allocation inputs only; neither is promoted to `yield.state === 'live'`.
- Produces: persisted transaction/strategy/reasoning records with `yieldEvidence: 'live-venue' | null`; legacy or unproven numbers are treated as unavailable.

- [ ] **Step 1: Write failing live/unavailable tests**

Cover all of these exact cases:

```js
expect(venueYield({ ...stellar, apy: 4.8 })).toEqual({
  state: "unavailable",
  apy: null,
});
expect(
  venueYield({
    ...stellar,
    yield: { state: "live", apy: 4.8, asOf: Date.now() },
  }),
).toEqual({ state: "live", apy: 4.8 });
```

For each component, render a catalog APY without `yield.state === 'live'` and assert `Yield unavailable` or `Not available` is present while `4.8%`, `Estimated in 30 days`, and `USDC/day estimated` are absent. Render an explicit live yield and assert the number appears.

For history, persist one legacy/static row and one `yieldEvidence: 'live-venue'` row; assert only the evidenced row exposes APY and `positionsFromHistory` returns `apy: null` for the legacy row.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx
```

Expected: FAIL on static/fallback APY rendering and catalog fallback behavior.

- [ ] **Step 3: Preserve the actual-venue evidence boundary**

Update the `venueTruth.js` explanation and tests to make the current boundary explicit:

```text
Flat DeFiLlama APY is reference-market data, not live yield evidence for the Autofarm-to-Blend execution venue.
```

Do not add a nested `yield` object in `defiLlama.js`. Keep accepting a nested live shape in `venueTruth.js` for an actual future execution-venue feed, with the existing six-hour freshness check.

- [ ] **Step 4: Gate Plan, onboarding, and vault detail rendering**

Use `venueYield(...)` on each surface. The Plan estimate must use `stellarYield.apy`, not `stellarVenue.apy`:

```js
const estimate30d =
  stellarYield.state === "live" && estimateAmount > 0
    ? `${formatDollarNumber(estimateAmount * (stellarYield.apy / 100) * (30 / 365))} USDC`
    : null;
```

Onboarding's static seed and current flat fetched rows render names plus `Yield unavailable`; only a row carrying explicit nested live-venue evidence renders `ApyValue`. Label the section `Vault yield` instead of `Live vault rates` until at least one row is live. Wallet balance may remain `0.0% APY` because it is a non-yielding balance, not an unavailable vault rate.

Vault detail uses:

```js
const yieldState = venueYield(liveData || catalog);
const apy = yieldState.state === "live" ? yieldState.apy : null;
```

Render APY as `Not available` when null, omit the daily estimate, omit APY from the position sentence, and remove `yv_prefill_apy` from session storage when null.

- [ ] **Step 5: Make history evidence-aware**

Add `yieldEvidence` to transaction and reasoning inputs. Normalize persisted APY with:

```js
function evidencedApy(apy, yieldEvidence) {
  const value = Number(apy);
  return yieldEvidence === "live-venue" && Number.isFinite(value)
    ? value
    : null;
}
```

Do not use the existing `vaultDataSource === 'defiLlama'` flag as execution-venue yield evidence. Persist `blendedApy: null` and each selected vault's `apy: null` unless the caller supplies `yieldEvidence: 'live-venue'`. Pass live-venue evidence only when `venueYield(vault).state === 'live'`; current strategist and withdraw records therefore store null APY. Old records without the field remain unavailable. Remove the catalog APY fallback from `positionsFromHistory`.

HistoryPanel renders APY and yield-derived text only when the stored record carries evidence. Replace `Static data` with `Yield unavailable` for non-DeFiLlama strategy rows.

- [ ] **Step 6: Run focused tests and commit**

Run the command from Step 2 again.

Expected: PASS.

Commit:

```bash
git add frontend/src/strategy/venueTruth.js frontend/src/strategy/venueTruth.test.js frontend/src/components/strategy/PlanStage.jsx frontend/src/components/strategy/PlanStage.test.jsx frontend/src/components/OnboardingFlow.jsx frontend/src/components/OnboardingFlow.test.jsx frontend/src/components/VaultDetailPage.jsx frontend/src/components/VaultDetailPage.test.jsx frontend/src/history.js frontend/src/history.yield.test.js frontend/src/components/HistoryPanel.jsx frontend/src/components/HistoryPanel.test.jsx frontend/src/strategist.js frontend/src/components/WithdrawModal.jsx
git commit -m "fix(frontend): hide unproven yield"
```

---

### Task 3: Replace zero-gas claims and add a public-claim scanner

**Files:**

- Create: `scripts/ci/public-claim-scan.mjs`
- Create: `scripts/ci/public-claim-scan.test.mjs`
- Modify: `frontend/src/components.jsx`
- Modify: `frontend/src/components.sidebar.test.jsx`
- Modify: `frontend/src/agents.jsx`
- Modify: `frontend/src/attestation.js`
- Modify: `frontend/src/components/strategy/ProtectStage.jsx`
- Modify: `frontend/src/components/strategy/PlanStage.jsx`
- Modify: `frontend/src/components/SettingsPage.jsx`
- Modify: `frontend/src/components/WithdrawModal.jsx`
- Modify: `frontend/src/components/WithdrawModal.test.jsx`
- Modify: `frontend/src/components/SkillEditModal.jsx`
- Modify: `frontend/src/components/AgentActionPreview.jsx`
- Modify: `frontend/src/components/LandingHero.jsx`
- Modify: `frontend/src/components/LandingHero.test.jsx`
- Modify: `frontend/src/screens.jsx`
- Modify: `frontend/src/screens/Withdraw.jsx`
- Modify: `frontend/src/screens/Withdraw.test.jsx`
- Modify: `frontend/src/screens/Withdraw.unavailable.test.jsx`
- Modify: `frontend/src/components/money/WithdrawDialog.jsx`
- Modify: `frontend/src/components/money/WithdrawDialog.test.jsx`
- Modify: `frontend/src/money/ownerActions.js`
- Modify: `frontend/src/money/ownerActions.test.js`
- Modify: `frontend/src/developers/OverviewSection.jsx`
- Modify: `frontend/src/developers/KeysSection.jsx`
- Modify: `frontend/src/developers/docsData.js`
- Modify: `README.md`
- Modify: `prd.md`
- Modify: `GETTING_STARTED.md`
- Modify: `FEATURES.md`
- Modify: `docs-site/introduction.md`
- Modify: `docs-site/how-it-works.md`
- Modify: `docs-site/architecture.md`
- Modify: `docs-site/quick-start.md`
- Modify: `docs-site/real-vs-demo.md`

**Interfaces:**

- Produces: `findBannedPublicClaims(text) -> Array<{ pattern, line, excerpt }>`.
- Produces: CLI exit code 0 for clean tracked public surfaces, 1 for banned claims, and 2 for discovery/read errors.

- [ ] **Step 1: Write failing scanner tests**

Use controlled fixture strings and assert these are rejected case-insensitively:

```text
gas 0
zero gas
gas-free
gasless
0 XLM, fee-bump
gas cost to user: 0 USDC
Base gas — 0 ETH
network fees you pay: Zero
```

Assert these pass:

```text
Network fee sponsored by fee-bump relay.
Base network fee sponsored by relay.
Direct fallback transactions require the wallet to pay the displayed network fee.
```

- [ ] **Step 2: Run the scanner test and confirm RED**

Run: `node --test scripts/ci/public-claim-scan.test.mjs`

Expected: FAIL because the scanner module does not exist.

- [ ] **Step 3: Implement deterministic scanning**

Export regex definitions and a line-aware function. The CLI must discover tracked files with `git ls-files`, then scan root/docs copy and the shipped UI-copy modules (not internal APIs whose library identifiers legitimately use `GaslessClient`):

```js
const ROOT_DOCS = new Set([
  "README.md",
  "prd.md",
  "GETTING_STARTED.md",
  "FEATURES.md",
]);
const isPublicSurface = (file) =>
  ROOT_DOCS.has(file) ||
  file.startsWith("docs-site/") ||
  (/\.(?:js|jsx)$/.test(file) &&
    !/\.test\./.test(file) &&
    (file === "frontend/src/components.jsx" ||
      file === "frontend/src/agents.jsx" ||
      file === "frontend/src/screens.jsx" ||
      file === "frontend/src/app.jsx" ||
      file === "frontend/src/money/ownerActions.js" ||
      file.startsWith("frontend/src/components/") ||
      file.startsWith("frontend/src/screens/") ||
      file.startsWith("frontend/src/developers/") ||
      file.startsWith("frontend/src/wallet/ui/")));
```

Reserve exit 2 for inability to discover or read inputs. Print `path:line`, pattern label, and excerpt for each violation. Do not silently exempt source comments; stale product claims in shipped source must be corrected too.

- [ ] **Step 4: Replace public wording**

Use exactly `Network fee sponsored by fee-bump relay.` on Stellar surfaces and `Base network fee sponsored by relay.` on Base-specific surfaces. When a row label/value layout is required, use `Network fee` / `Sponsored by fee-bump relay` or `Base network fee` / `Sponsored by relay`.

Preserve truthful direct-fallback copy where the wallet really pays. Do not change historical descriptions that explicitly say an old stack was removed unless they contain a current zero-gas promise.

- [ ] **Step 5: Run scanner and affected component tests**

Run:

```bash
node --test scripts/ci/public-claim-scan.test.mjs
node scripts/ci/public-claim-scan.mjs
cd frontend && npx vitest run src/components.sidebar.test.jsx src/components/LandingHero.test.jsx src/components/WithdrawModal.test.jsx src/components/money/WithdrawDialog.test.jsx src/money/ownerActions.test.js src/screens/Withdraw.test.jsx src/screens/Withdraw.unavailable.test.jsx src/components/strategy/ProtectStage.test.jsx src/components/strategy/PlanStage.test.jsx
```

Expected: all commands PASS and the scanner reports zero banned claims.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/public-claim-scan.mjs scripts/ci/public-claim-scan.test.mjs frontend/src README.md prd.md GETTING_STARTED.md FEATURES.md docs-site
git commit -m "fix(copy): describe sponsored network fees"
```

---

### Task 4: Make Explorer match source and deployment facts

**Files:**

- Create: `frontend/src/stellar/deploymentFacts.js`
- Create: `frontend/src/stellar/deploymentFacts.test.js`
- Modify: `frontend/src/components/ExplorerPage.jsx`
- Create: `frontend/src/components/ExplorerPage.test.jsx`
- Modify: `README.md`
- Modify: `prd.md`
- Modify: `GETTING_STARTED.md`
- Modify: `FEATURES.md`
- Modify: `docs-site/contracts.md`
- Modify: `docs-site/architecture.md`
- Modify: `docs-site/how-it-works.md`

**Interfaces:**

- Produces: `SOROBAN_SOURCE_CRATES`, `STELLAR_STATIC_DEPLOYMENTS`, `FIRST_PARTY_DEPLOYMENT_COUNT`, `EXTERNAL_PROTOCOL_COUNT`, and `STATIC_ADDRESS_COUNT`.
- Consumes these manifest paths: `fundingRouter.addressV2`, `autofarmVault.address`, `strategy1.address`, `exitRouter.address`, `attestation`, `registry`, `strategy1.pool`, and `fundingRouter.token`.

- [ ] **Step 1: Write failing manifest and rendering tests**

The deployment-facts test must read `deployments/stellar-testnet.json` and assert exact equality in this order:

```js
[
  manifest.fundingRouter.addressV2,
  manifest.autofarmVault.address,
  manifest.strategy1.address,
  manifest.exitRouter.address,
  manifest.attestation,
  manifest.registry,
  manifest.strategy1.pool,
  manifest.fundingRouter.token,
];
```

Assert `SOROBAN_SOURCE_CRATES` equals:

```js
[
  "agent_account",
  "attestation",
  "autofarm_vault",
  "blend_strategy",
  "exit_router",
  "funding_router",
  "registry",
];
```

ExplorerPage rendering must assert `7`, `6`, `2`, `8 static addresses`, and `N per run`, and must find all eight manifest addresses. It must not render the agent WASM hash or the labels `Contract Tests` and `Every deployed contract`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd frontend && npx vitest run src/stellar/deploymentFacts.test.js src/components/ExplorerPage.test.jsx`

Expected: FAIL because the facts module/test page do not exist and Explorer lists only three contracts.

- [ ] **Step 3: Implement categorized facts**

Each deployment record has this shape:

```js
{
  id: 'funding-router-v2',
  name: 'Funding Router V2',
  address: 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE',
  ownership: 'first-party',
  role: 'Single-signature scoped grant and agent factory',
}
```

Use the eight exact manifest values named in Interfaces. Freeze exported arrays/records. Derive counts with filters and `.length`, not duplicated literals.

- [ ] **Step 4: Render the complete Stellar-only Explorer**

Replace the local three-item `CONTRACTS` and hard-coded test count. Render summary copy exactly:

```text
8 static Stellar testnet addresses: 6 Vibing Farmer deployments and 2 external protocol contracts. Agent accounts are created dynamically per run.
```

Use four stats: `Soroban source crates`, `VF deployments`, `Protocol contracts`, and `Dynamic agents`. Keep every address linked to Stellar Expert testnet. Label first-party and external records visibly.

- [ ] **Step 5: Correct tracked deployment tables**

Update public docs to the same 7/6/2/8 categorization. Replace active-router references to the retired `CCEWW…` generation with V2 `CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE`. Describe the agent WASM value as a hash, never a contract address. Keep Base deployment counts in their own explicitly Base Sepolia sections.

- [ ] **Step 6: Run focused tests, scanner, and commit**

Run:

```bash
cd frontend && npx vitest run src/stellar/deploymentFacts.test.js src/components/ExplorerPage.test.jsx
cd .. && node scripts/ci/public-claim-scan.mjs
```

Expected: PASS.

Commit:

```bash
git add frontend/src/stellar/deploymentFacts.js frontend/src/stellar/deploymentFacts.test.js frontend/src/components/ExplorerPage.jsx frontend/src/components/ExplorerPage.test.jsx README.md prd.md GETTING_STARTED.md FEATURES.md docs-site
git commit -m "fix(explorer): separate source and deployment counts"
```

---

### Task 5: Publish the evidence matrix and activate the release freeze

**Files:**

- Create: `release/evidence-matrix.json`
- Create: `EVIDENCE_MATRIX.md`
- Create: `scripts/ci/claim-evidence.mjs`
- Create: `scripts/ci/claim-evidence.test.mjs`
- Modify: `scripts/ci/release-gate.mjs`
- Modify: `scripts/ci/release-gate.test.mjs`
- Modify: `.github/workflows/frontend.yml`
- Modify: `README.md`

**Interfaces:**

- Produces: `validateEvidenceMatrix(matrix, repoRoot) -> { ok, failures }`.
- Produces: `evaluateFeatureFreeze(freeze, subjects) -> { ok, failures }`.
- Produces: `verifyCandidateIdentity({ tagSha, previewSha, previewUrl }) -> { ok, failures }`.
- Produces: required candidate mode that peels the annotated tag locally and resolves the
  successful Cloudflare preview commit/URL from the authenticated deployment API.
- Adds required CI job key `claim-evidence` to `REQUIRED_JOBS` and the aggregate `release-gate.needs` array.

- [ ] **Step 1: Write failing validator and workflow tests**

Test this minimum matrix shape:

```json
{
  "schemaVersion": 1,
  "candidate": {
    "tag": "v1.15.2-beta",
    "targetBranch": "dev",
    "cloudflareProject": "vibing-farmer",
    "productionPublish": false
  },
  "freeze": {
    "active": true,
    "activatedOn": "2026-08-11",
    "forbiddenCommitTypes": ["feat"]
  },
  "claims": []
}
```

Assert validation fails for a missing evidence path, empty verification command, non-`proven` claim, wrong candidate tag, inactive freeze, or `productionPublish: true`. Assert freeze rejects `feat: add pool`, `feat(ui)!: replace flow`, and accepts `fix: align expiry`, `test: cover unavailable yield`, `docs: publish evidence`, and `chore(release): cut candidate`.

Assert pure candidate identity accepts only matching lowercase 40-character SHA values and a
valid Pages URL; separately assert required mode resolves an annotated tag target and successful
Cloudflare deployment metadata rather than trusting caller-provided equal strings.

Extend release-gate workflow tests to require a `claim-evidence` job, require it in `release-gate.needs`, and forbid `continue-on-error`.

- [ ] **Step 2: Run validator/gate tests and confirm RED**

Run: `node --test scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs`

Expected: FAIL because the validator and required job do not exist.

- [ ] **Step 3: Implement fail-closed validators**

The matrix validator requires these claim IDs, non-empty `owner`, non-empty `verification`, and
existing local evidence paths. All rows except `candidate-same-commit` must have
`status: 'proven'`; that row is allowed to remain `pending` only before required candidate mode
has a successful preview to verify:

```js
[
  "permission-lifetime",
  "yield-availability",
  "sponsored-network-fee",
  "stellar-explorer-counts",
  "candidate-same-commit",
  "required-checks",
  "feature-freeze",
];
```

For CLI use, load `release/evidence-matrix.json`; run local validation unconditionally. The checked-in
`candidate-same-commit` row is `pending` until the preview exists, so ordinary PR/dev CI remains
green while reporting that identity verification is pending. The exact `v1.15.2-beta` tag-push
workflow is the authoritative promotion proof and automatically enters required candidate mode; a
manual dispatch is only an operator retry. If `FREEZE_BASE_SHA` and
`FREEZE_HEAD_SHA` are present, obtain subjects with `git log --format=%s BASE..HEAD` using
`execFileSync` and evaluate the freeze. Candidate inputs are rejected unless
`CANDIDATE_VERIFICATION_MODE=required` is explicit (and it is forced for the exact tag-push event).
In that mode, require the matrix tag name and Cloudflare account/token; a preview URL is optional
and only narrows the lookup. Resolve the annotated `github.ref_name` tag target from Git and
resolve the successful preview's branch, URL, and commit metadata from Cloudflare's deployment API. Any
caller SHA is an optional assertion only. Exit 1 for a failed policy and 2 for unreadable,
malformed, or missing candidate inputs.

- [ ] **Step 4: Publish machine and human evidence matrices**

Create seven rows using the IDs above. Each row names exact changed source/test evidence and the command that proves it. The same-commit row remains `pending` in static evidence; required candidate verification proves its stable locators at promotion time:

```json
{
  "id": "candidate-same-commit",
  "status": "pending",
  "owner": "release",
  "verification": "CANDIDATE_VERIFICATION_MODE=required CANDIDATE_TAG=$CANDIDATE_TAG CANDIDATE_PREVIEW_URL=$CANDIDATE_PREVIEW_URL CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN node scripts/ci/claim-evidence.mjs",
  "evidence": [
    "release/specs/2026-08-11-release-claim-truth-design.md",
    ".github/workflows/frontend.yml"
  ],
  "externalLocators": [
    "https://github.com/poggufanz/vibingfarmer/tree/v1.15.2-beta",
    "https://dev.vibing-farmer.pages.dev"
  ]
}
```

`CANDIDATE_TAG` and optional `CANDIDATE_PREVIEW_URL` are lookup inputs, not proof values. The verifier
peels the annotated tag from the local Git object database and resolves the successful post-preview
deployment's source commit and URL from Cloudflare metadata. Caller-supplied `CANDIDATE_TAG_SHA`
or `PREVIEW_COMMIT_SHA` values, when present, are checked only as assertions against those
independent sources.

In `EVIDENCE_MATRIX.md`, state that the annotated tag—not a published GitHub Release—is the candidate locator, because publishing a GitHub Release deploys production. Link README to this file.

- [ ] **Step 5: Wire the claim-evidence job into CI**

Add a root-working-directory job that checks out with `fetch-depth: 0`, sets Node 22, then runs:

```bash
node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs
node scripts/ci/public-claim-scan.mjs
node scripts/ci/claim-evidence.mjs
```

Pass event-range SHA variables for branch pushes, pull request, and merge group with this exact
environment block. For tag pushes both expressions resolve to an empty string, so the annotated
tag target is not reinterpreted as a zero/tag commit range:

```yaml
env:
  FREEZE_BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event_name == 'push' && github.ref_type == 'branch' && github.event.before || '' }}
  FREEZE_HEAD_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event_name == 'push' && github.ref_type == 'branch' && github.sha || '' }}
```

Add `claim-evidence` to `release-gate.needs` and `REQUIRED_JOBS`.

- [ ] **Step 6: Run validator, scanner, release-gate tests, and commit**

Run:

```bash
node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs
node scripts/ci/public-claim-scan.mjs
node scripts/ci/claim-evidence.mjs
git diff --check
```

Expected: PASS.

Commit:

```bash
git add release/evidence-matrix.json EVIDENCE_MATRIX.md scripts/ci/claim-evidence.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.mjs scripts/ci/release-gate.test.mjs .github/workflows/frontend.yml README.md
git commit -m "chore(release): publish claim evidence and freeze features"
```

---

## Controller verification and publication checklist

- [ ] Run `git diff --check`.
- [ ] Run `node --test scripts/ci/*.test.mjs`.
- [ ] Run `cd frontend && npm run lint:ci`.
- [ ] Run `cd frontend && npm run format:check`.
- [ ] Run `cd frontend && npm run brand:check`.
- [ ] Run `cd frontend && npm test`.
- [ ] Run `cd frontend && npm run build`.
- [ ] Run `cd frontend && npm run build:ext`.
- [ ] Run `cd frontend && npm run manifest:check`.
- [ ] Run `cd relayer && npm test`.
- [ ] Run `cd keeper && npm test`.
- [ ] Run `cd soroban && stellar contract build`.
- [ ] Run `cd soroban && cargo test --locked`.
- [ ] Run `cd soroban && cargo clippy --locked --all-targets -- -D warnings`.
- [ ] Dispatch a fresh Luna whole-branch reviewer and resolve every Critical/Important finding.
- [ ] Push the candidate branch and open a pull request to `dev`.
- [ ] Merge only after GitHub `release-gate` succeeds.
- [ ] Resolve the successful Cloudflare preview whose source SHA equals the `dev` merge SHA.
- [ ] Create annotated tag `v1.15.2-beta` on that exact merge SHA and push only the tag.
- [ ] Confirm the automatic tag-push `frontend.yml` run resolves the successful `dev` preview
      from Cloudflare metadata and passes the required candidate step. A manual dispatch with an
      optional preview URL can retry verification; neither path deploys the tag.
- [ ] Confirm no GitHub Release was published and no production Cloudflare deployment was created.

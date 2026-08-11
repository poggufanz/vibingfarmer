#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  accessSync,
  readFileSync,
  realpathSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "..", "..");
const matrixPath = path.join(
  defaultRepoRoot,
  "release",
  "evidence-matrix.json",
);

export const REQUIRED_CLAIM_IDS = Object.freeze([
  "permission-lifetime",
  "yield-availability",
  "sponsored-network-fee",
  "stellar-explorer-counts",
  "candidate-same-commit",
  "required-checks",
  "feature-freeze",
]);

const CANDIDATE_LOCATORS = Object.freeze([
  "https://github.com/poggufanz/vibingfarmer/tree/v1.15.1-beta",
  "https://dev.vibing-farmer.pages.dev",
]);

const CANDIDATE_CLAIM_ID = "candidate-same-commit";
const CANDIDATE_VERIFICATION_MODE = "required";
const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const CONTRACT_VERIFICATIONS = Object.freeze({
  "permission-lifetime":
    "cd frontend && npx vitest run src/strategy/permissionWindow.test.js src/strategy/flowState.test.js src/stellar/grant.test.js src/orchestrator.test.js src/orchestrator.router.test.js src/orchestrator.baseleg.test.js src/orchestrator.unavailable.test.js src/components/strategy/ProtectStage.test.jsx",
  "yield-availability":
    "cd frontend && npx vitest run src/strategy/venueTruth.test.js src/components/strategy/PlanStage.test.jsx src/components/OnboardingFlow.test.jsx src/components/VaultDetailPage.test.jsx src/history.yield.test.js src/components/HistoryPanel.test.jsx src/strategist.yield.test.js src/components/TxDetailPage.test.jsx",
  "sponsored-network-fee":
    "node --test scripts/ci/public-claim-scan.test.mjs && node scripts/ci/public-claim-scan.mjs && cd frontend && npx vitest run src/history.yield.test.js src/stellar/exit.test.js src/agents/agentController.test.js src/stellar/partialWithdraw.test.js src/components/TxDetailPage.test.jsx",
  "stellar-explorer-counts":
    "cd frontend && npx vitest run src/stellar/deploymentFacts.test.js src/components/ExplorerPage.test.jsx",
  "candidate-same-commit":
    "CANDIDATE_VERIFICATION_MODE=required CANDIDATE_TAG=$CANDIDATE_TAG CANDIDATE_PREVIEW_URL=$CANDIDATE_PREVIEW_URL CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN node scripts/ci/claim-evidence.mjs",
  "required-checks":
    "node --test scripts/ci/public-claim-scan.test.mjs scripts/ci/claim-evidence.test.mjs scripts/ci/release-gate.test.mjs",
  "feature-freeze":
    "node --test scripts/ci/claim-evidence.test.mjs && node scripts/ci/claim-evidence.mjs",
});

const CONTRACT_OWNERS = Object.freeze({
  "permission-lifetime": "strategy",
  "yield-availability": "frontend",
  "sponsored-network-fee": "copy",
  "stellar-explorer-counts": "explorer",
  "candidate-same-commit": "release",
  "required-checks": "release",
  "feature-freeze": "release",
});

const CONTRACT_EVIDENCE = Object.freeze({
  "permission-lifetime": Object.freeze([
    "frontend/src/strategy/permissionWindow.js",
    "frontend/src/strategy/permissionWindow.test.js",
    "frontend/src/strategy/flowState.js",
    "frontend/src/strategy/flowState.test.js",
    "frontend/src/stellar/grant.js",
    "frontend/src/stellar/grant.test.js",
    "frontend/src/orchestrator.js",
    "frontend/src/orchestrator.test.js",
    "frontend/src/orchestrator.router.test.js",
    "frontend/src/orchestrator.baseleg.test.js",
    "frontend/src/orchestrator.unavailable.test.js",
    "frontend/src/components/strategy/ProtectStage.jsx",
    "frontend/src/components/strategy/ProtectStage.test.jsx",
  ]),
  "yield-availability": Object.freeze([
    "frontend/src/strategy/venueTruth.js",
    "frontend/src/strategy/venueTruth.test.js",
    "frontend/src/components/strategy/PlanStage.jsx",
    "frontend/src/components/strategy/PlanStage.test.jsx",
    "frontend/src/components/OnboardingFlow.jsx",
    "frontend/src/components/OnboardingFlow.test.jsx",
    "frontend/src/components/VaultDetailPage.jsx",
    "frontend/src/components/VaultDetailPage.test.jsx",
    "frontend/src/history.js",
    "frontend/src/history.yield.test.js",
    "frontend/src/components/HistoryPanel.jsx",
    "frontend/src/components/HistoryPanel.test.jsx",
    "frontend/src/strategist.js",
    "frontend/src/strategist.yield.test.js",
    "frontend/src/components/TxDetailPage.jsx",
    "frontend/src/components/TxDetailPage.test.jsx",
  ]),
  "sponsored-network-fee": Object.freeze([
    "scripts/ci/public-claim-scan.mjs",
    "scripts/ci/public-claim-scan.test.mjs",
    "frontend/src/history.js",
    "frontend/src/history.yield.test.js",
    "frontend/src/stellar/exit.js",
    "frontend/src/stellar/exit.test.js",
    "frontend/src/agents/agentController.js",
    "frontend/src/agents/agentController.test.js",
    "frontend/src/stellar/partialWithdraw.js",
    "frontend/src/stellar/partialWithdraw.test.js",
    "frontend/src/components/TxDetailPage.jsx",
    "frontend/src/components/TxDetailPage.test.jsx",
  ]),
  "stellar-explorer-counts": Object.freeze([
    "frontend/src/stellar/deploymentFacts.js",
    "frontend/src/stellar/deploymentFacts.test.js",
    "frontend/src/components/ExplorerPage.jsx",
    "frontend/src/components/ExplorerPage.test.jsx",
    "deployments/stellar-testnet.json",
  ]),
  "candidate-same-commit": Object.freeze([
    "release/specs/2026-08-11-release-claim-truth-design.md",
    ".github/workflows/frontend.yml",
    "scripts/ci/claim-evidence.mjs",
    "scripts/ci/claim-evidence.test.mjs",
  ]),
  "required-checks": Object.freeze([
    ".github/workflows/frontend.yml",
    "scripts/ci/release-gate.mjs",
    "scripts/ci/release-gate.test.mjs",
    "scripts/ci/claim-evidence.mjs",
    "scripts/ci/claim-evidence.test.mjs",
  ]),
  "feature-freeze": Object.freeze([
    "release/2026-08-11-release-claim-truth-implementation-plan.md",
    "release/specs/2026-08-11-release-claim-truth-design.md",
    "scripts/ci/claim-evidence.mjs",
    "scripts/ci/claim-evidence.test.mjs",
  ]),
});

export const CLAIM_CONTRACTS = Object.freeze(
  Object.fromEntries(
    REQUIRED_CLAIM_IDS.map((id) => [
      id,
      Object.freeze({
        owner: CONTRACT_OWNERS[id],
        verification: CONTRACT_VERIFICATIONS[id],
        minimumEvidence: CONTRACT_EVIDENCE[id],
        ...(id === "candidate-same-commit"
          ? { externalLocators: CANDIDATE_LOCATORS }
          : {}),
      }),
    ]),
  ),
);

const EXPECTED_CANDIDATE = Object.freeze({
  tag: "v1.15.1-beta",
  targetBranch: "dev",
  cloudflareProject: "vibing-farmer",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function locatorMatches(locator, expected) {
  if (!nonEmptyString(locator) || locator !== expected) return false;
  try {
    const actual = new URL(locator);
    const target = new URL(expected);
    return (
      actual.protocol === "https:" &&
      actual.hostname === target.hostname &&
      actual.port === "" &&
      actual.username === "" &&
      actual.password === "" &&
      actual.pathname === target.pathname &&
      actual.search === target.search &&
      actual.hash === target.hash
    );
  } catch {
    return false;
  }
}

function hasReadableMode(stats) {
  return (stats.mode & 0o444) !== 0;
}

function evidenceIncludes(root, evidence, requiredEvidence) {
  if (!Array.isArray(evidence)) return false;
  const resolvedRoot = path.resolve(root);
  const expected = path.resolve(resolvedRoot, requiredEvidence);
  return evidence.some((candidate) => {
    if (!nonEmptyString(candidate)) return false;
    return path.resolve(resolvedRoot, candidate) === expected;
  });
}

function evidencePathFailure(root, evidencePath) {
  if (!nonEmptyString(evidencePath))
    return "evidence path must be a non-empty relative path";

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.isAbsolute(evidencePath)
    ? path.resolve(evidencePath)
    : path.resolve(resolvedRoot, evidencePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return `evidence path must remain inside repo root: ${evidencePath}`;
  }

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return `evidence path does not exist: ${evidencePath}`;
    }
    return `evidence path is unreadable: ${evidencePath}`;
  }

  try {
    accessSync(resolvedPath, fsConstants.R_OK);
    if (!hasReadableMode(stats))
      return `evidence path is unreadable: ${evidencePath}`;
    if (!stats.isFile())
      return `evidence path is not a readable file: ${evidencePath}`;
    const realRoot = realpathSync(resolvedRoot);
    const realPath = realpathSync(resolvedPath);
    const realRelative = path.relative(realRoot, realPath);
    if (
      realRelative === "" ||
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      return `evidence path resolves outside repo root: ${evidencePath}`;
    }
  } catch {
    return `evidence path is unreadable: ${evidencePath}`;
  }

  return null;
}

function validateEvidenceMatrixInternal(
  matrix,
  repoRoot,
  { requireCandidateProof = false } = {},
) {
  const failures = [];
  let malformed = false;
  const fail = (message, inputError = false) => {
    failures.push(message);
    malformed ||= inputError;
  };

  if (!isPlainObject(matrix)) {
    return {
      ok: false,
      failures: ["matrix must be a JSON object"],
      malformed: true,
    };
  }
  if (matrix.schemaVersion !== 1) {
    fail("matrix.schemaVersion must be 1", true);
  }

  if (!isPlainObject(matrix.candidate)) {
    fail("matrix.candidate must be an object", true);
  } else {
    for (const [key, expected] of Object.entries(EXPECTED_CANDIDATE)) {
      if (matrix.candidate[key] !== expected) {
        fail(`candidate.${key} must be ${JSON.stringify(expected)}`);
      }
    }
    if (matrix.candidate.productionPublish !== false) {
      fail("candidate.productionPublish must be false");
    }
  }

  if (!isPlainObject(matrix.freeze)) {
    fail("matrix.freeze must be an object", true);
  } else {
    if (matrix.freeze.active !== true) fail("freeze.active must be true");
    if (!nonEmptyString(matrix.freeze.activatedOn)) {
      fail("freeze.activatedOn must be a non-empty date", true);
    } else if (!Number.isFinite(Date.parse(matrix.freeze.activatedOn))) {
      fail("freeze.activatedOn must be a valid date", true);
    }
    if (!Array.isArray(matrix.freeze.forbiddenCommitTypes)) {
      fail("freeze.forbiddenCommitTypes must be an array", true);
    } else if (
      matrix.freeze.forbiddenCommitTypes.some((type) => !nonEmptyString(type))
    ) {
      fail("freeze.forbiddenCommitTypes must contain non-empty strings", true);
    } else if (!matrix.freeze.forbiddenCommitTypes.includes("feat")) {
      fail("freeze.forbiddenCommitTypes must include feat");
    }
  }

  if (!Array.isArray(matrix.claims)) {
    fail("matrix.claims must be an array", true);
    return { ok: false, failures, malformed };
  }

  const rowsById = new Map();
  for (const row of matrix.claims) {
    if (!isPlainObject(row)) {
      fail("each claim must be an object", true);
      continue;
    }
    if (!nonEmptyString(row.id)) {
      fail("each claim must have a non-empty id", true);
      continue;
    }
    if (rowsById.has(row.id)) {
      fail(`duplicate claim id: ${row.id}`);
      continue;
    }
    rowsById.set(row.id, row);
    if (!REQUIRED_CLAIM_IDS.includes(row.id)) {
      fail(`unknown claim id: ${row.id}`);
    }
  }

  const root =
    typeof repoRoot === "string" && repoRoot.trim() !== ""
      ? repoRoot
      : defaultRepoRoot;
  for (const id of REQUIRED_CLAIM_IDS) {
    const row = rowsById.get(id);
    if (!row) {
      fail(`missing required claim: ${id}`);
      continue;
    }
    const contract = CLAIM_CONTRACTS[id];
    const candidatePending =
      id === CANDIDATE_CLAIM_ID && row.status === "pending";
    if (id === CANDIDATE_CLAIM_ID && row.status === "proven") {
      fail(
        `${id}: status must remain pending until required candidate verification resolves external evidence`,
      );
    }
    if (
      row.status !== "proven" &&
      !(candidatePending && !requireCandidateProof)
    ) {
      fail(`${id}: status must be proven`);
    }
    if (!nonEmptyString(row.owner)) {
      fail(`${id}: owner must be non-empty`);
    } else if (row.owner !== contract.owner) {
      fail(`${id}: owner must be exactly ${contract.owner}`);
    }
    if (!nonEmptyString(row.verification)) {
      fail(`${id}: verification must be non-empty`);
    } else if (row.verification !== contract.verification) {
      fail(`${id}: verification command does not match the contract`);
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      fail(`${id}: evidence must contain at least one local path`);
      continue;
    }
    for (const requiredEvidence of contract.minimumEvidence) {
      if (!evidenceIncludes(root, row.evidence, requiredEvidence)) {
        fail(`${id}: missing required evidence path: ${requiredEvidence}`);
      }
    }
    for (const evidencePath of row.evidence) {
      const pathFailure = evidencePathFailure(root, evidencePath);
      if (pathFailure) {
        fail(
          `${id}: ${pathFailure}`,
          /evidence path is unreadable/.test(pathFailure),
        );
      }
    }
    if (contract.externalLocators) {
      if (!Array.isArray(row.externalLocators)) {
        fail(
          `${id}: externalLocators must contain the exact candidate locators`,
          true,
        );
      } else if (
        row.externalLocators.some((locator) => !nonEmptyString(locator))
      ) {
        fail(`${id}: externalLocators must contain URL strings`, true);
      } else {
        if (
          row.externalLocators.length !== contract.externalLocators.length ||
          row.externalLocators.some(
            (locator, index) =>
              !locatorMatches(locator, contract.externalLocators[index]),
          )
        ) {
          fail(
            `${id}: externalLocators must contain the exact HTTPS candidate locators`,
          );
        }
      }
    } else if (row.externalLocators !== undefined) {
      if (
        !Array.isArray(row.externalLocators) ||
        row.externalLocators.some((locator) => !nonEmptyString(locator))
      ) {
        fail(`${id}: externalLocators must contain non-empty strings`, true);
      }
    }
  }

  return { ok: failures.length === 0, failures, malformed };
}

export function validateEvidenceMatrix(
  matrix,
  repoRoot = defaultRepoRoot,
  options = {},
) {
  const { ok, failures } = validateEvidenceMatrixInternal(
    matrix,
    repoRoot,
    options,
  );
  return { ok, failures };
}

function conventionalCommitType(subject) {
  if (typeof subject !== "string") return null;
  const match = subject.trim().match(/^([a-z][\w-]*)(?:\([^)]*\))?!?:\s+\S/);
  return match?.[1] ?? null;
}

export function evaluateFeatureFreeze(freeze, subjects) {
  const failures = [];
  if (!isPlainObject(freeze)) {
    return { ok: false, failures: ["freeze must be an object"] };
  }
  if (freeze.active !== true) failures.push("freeze.active must be true");
  if (!Array.isArray(freeze.forbiddenCommitTypes)) {
    failures.push("freeze.forbiddenCommitTypes must be an array");
  }
  if (!Array.isArray(subjects)) {
    failures.push("freeze subjects must be an array");
    return { ok: false, failures };
  }
  const forbidden = Array.isArray(freeze.forbiddenCommitTypes)
    ? freeze.forbiddenCommitTypes
    : [];
  for (const subject of subjects) {
    const type = conventionalCommitType(subject);
    if (type && forbidden.includes(type)) {
      failures.push(`forbidden conventional commit subject: ${subject}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function isValidSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validTagName(value) {
  return (
    typeof value === "string" &&
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`unable to resolve candidate tag: ${error.message}`);
  }
}

/**
 * Resolve the target commit from the local annotated tag object. A caller-supplied SHA is only
 * ever an optional assertion; it is not the source of the candidate identity.
 */
export function resolveAnnotatedTagTarget(repoRoot, tagName) {
  if (!validTagName(tagName)) {
    throw new Error("candidate tag name is invalid");
  }
  const tagRef = `refs/tags/${tagName}`;
  const tagType = gitOutput(repoRoot, ["cat-file", "-t", tagRef]);
  if (tagType !== "tag") {
    throw new Error("candidate tag must be an annotated tag");
  }
  const tagObjectSha = gitOutput(repoRoot, ["rev-parse", "--verify", tagRef]);
  const targetSha = gitOutput(repoRoot, [
    "rev-parse",
    "--verify",
    `${tagRef}^{commit}`,
  ]);
  if (!isValidSha(tagObjectSha) || !isValidSha(targetSha)) {
    throw new Error("candidate tag did not resolve to a commit SHA");
  }
  return { tagName, tagRef, tagObjectSha, targetSha };
}

function previewUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("preview URL must be an HTTPS vibing-farmer.pages.dev URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !hostname.endsWith(".vibing-farmer.pages.dev") ||
    hostname === "vibing-farmer.pages.dev" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("preview URL must be an HTTPS vibing-farmer.pages.dev URL");
  }
  return parsed;
}

function deploymentCommitSha(deployment) {
  const metadata = deployment?.deployment_trigger?.metadata;
  const sourceConfig = deployment?.source?.config;
  return [
    metadata?.commit_hash,
    metadata?.commitHash,
    sourceConfig?.commit_hash,
    sourceConfig?.commitHash,
    deployment?.commit_hash,
    deployment?.commitHash,
  ].find(isValidSha);
}

function deploymentBranch(deployment) {
  const metadata = deployment?.deployment_trigger?.metadata;
  const sourceConfig = deployment?.source?.config;
  return (
    metadata?.branch ??
    metadata?.branch_name ??
    metadata?.branchName ??
    sourceConfig?.branch ??
    sourceConfig?.branch_name ??
    sourceConfig?.branchName
  );
}

function deploymentUrls(deployment) {
  const aliases = Array.isArray(deployment?.aliases) ? deployment.aliases : [];
  return [deployment?.url, ...aliases].filter(nonEmptyString);
}

function previewUrlsMatch(actual, expected) {
  try {
    const actualUrl = previewUrl(actual);
    const expectedUrl = previewUrl(expected);
    return (
      actualUrl.protocol === expectedUrl.protocol &&
      actualUrl.hostname.toLowerCase() === expectedUrl.hostname.toLowerCase() &&
      actualUrl.port === expectedUrl.port &&
      actualUrl.pathname === expectedUrl.pathname &&
      actualUrl.search === expectedUrl.search &&
      actualUrl.hash === expectedUrl.hash
    );
  } catch {
    return false;
  }
}

function successfulPreviewDeployment(deployment) {
  return (
    deployment?.environment === "preview" &&
    deployment?.latest_stage?.status === "success"
  );
}

/**
 * Resolve a preview's commit and URL from Cloudflare's deployment API. The URL supplied by the
 * operator only selects a deployment when present; otherwise the expected commit and branch select
 * a successful preview. The commit SHA is always read from Cloudflare metadata, never from a caller.
 */
export async function resolveCloudflarePreview({
  accountId,
  apiToken,
  projectName = "vibing-farmer",
  previewUrl: previewUrlInput,
  expectedBranch = "dev",
  expectedSha,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_CLOUDFLARE_API_BASE_URL,
} = {}) {
  if (!nonEmptyString(accountId) || !nonEmptyString(apiToken)) {
    throw new Error(
      "Cloudflare preview verification requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
    );
  }
  if (!nonEmptyString(projectName)) {
    throw new Error("Cloudflare Pages project name is required");
  }
  const requestedUrl = optionalPreviewUrlValue(previewUrlInput);
  if (!requestedUrl && !isValidSha(expectedSha)) {
    throw new Error(
      "Cloudflare preview verification requires a preview URL or expected candidate commit SHA",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Cloudflare preview verification requires fetch");
  }

  let endpoint;
  try {
    endpoint = new URL(
      `${String(apiBaseUrl).replace(/\/+$/, "")}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
    );
  } catch {
    throw new Error("Cloudflare API base URL is invalid");
  }
  endpoint.searchParams.set("per_page", "100");
  endpoint.searchParams.set("env", "preview");

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new Error(`unable to read Cloudflare deployments: ${error.message}`);
  }
  if (!response?.ok) {
    throw new Error(
      `Cloudflare deployments request failed with HTTP ${response?.status ?? "unknown"}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `Cloudflare deployments response was not JSON: ${error.message}`,
    );
  }
  if (payload?.success !== true || !Array.isArray(payload.result)) {
    throw new Error(
      "Cloudflare deployments response was unsuccessful or malformed",
    );
  }

  const deployment = payload.result.find((candidate) => {
    if (!successfulPreviewDeployment(candidate)) return false;
    const urls = deploymentUrls(candidate);
    if (
      requestedUrl &&
      !urls.some((url) => previewUrlsMatch(url, requestedUrl))
    )
      return false;
    const commitSha = deploymentCommitSha(candidate);
    if (!isValidSha(commitSha)) return false;
    if (expectedSha && commitSha !== expectedSha) return false;
    if (deploymentBranch(candidate) !== expectedBranch) return false;
    return urls.some((url) => {
      if (requestedUrl) return previewUrlsMatch(url, requestedUrl);
      try {
        previewUrl(url);
        return true;
      } catch {
        return false;
      }
    });
  });
  if (!deployment) {
    throw new Error(
      "no successful Cloudflare preview deployment matched the requested URL (when supplied), branch, and candidate commit",
    );
  }
  const resolvedUrl = deploymentUrls(deployment).find((url) => {
    if (requestedUrl) return previewUrlsMatch(url, requestedUrl);
    try {
      previewUrl(url);
      return true;
    } catch {
      return false;
    }
  });
  return {
    deploymentId: deployment.id ?? deployment.short_id ?? null,
    previewSha: deploymentCommitSha(deployment),
    previewUrl: resolvedUrl,
    branch: deploymentBranch(deployment),
  };
}

function previewUrlValue(value) {
  previewUrl(value);
  return String(value).trim();
}

function optionalPreviewUrlValue(value) {
  if (value === undefined || value === null || value === "") return null;
  return previewUrlValue(value);
}

export function verifyCandidateIdentity(input = {}) {
  const { tagSha, previewSha, previewUrl } = isPlainObject(input) ? input : {};
  const failures = [];
  if (!isValidSha(tagSha))
    failures.push("candidate tag SHA must be lowercase 40-character hex");
  if (!isValidSha(previewSha)) {
    failures.push("preview commit SHA must be lowercase 40-character hex");
  }
  if (isValidSha(tagSha) && isValidSha(previewSha) && tagSha !== previewSha) {
    failures.push("candidate tag SHA and preview commit SHA must be identical");
  }

  try {
    previewUrlValue(previewUrl);
  } catch {
    failures.push("preview URL must be an HTTPS vibing-farmer.pages.dev URL");
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Resolve and verify the candidate from independent sources. The local Git object database is the
 * source for the annotated tag target, and Cloudflare's authenticated deployment API is the source
 * for the preview commit and URL. Any SHA supplied through the environment is checked only as an
 * assertion against those independently resolved values.
 */
export async function verifyCandidateFromSources({
  matrix,
  repoRoot = defaultRepoRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (env.CANDIDATE_VERIFICATION_MODE !== CANDIDATE_VERIFICATION_MODE) {
    throw new Error(
      `candidate verification mode must be ${CANDIDATE_VERIFICATION_MODE}`,
    );
  }
  const tagName = env.CANDIDATE_TAG;
  const candidatePreviewUrl = optionalPreviewUrlValue(
    env.CANDIDATE_PREVIEW_URL,
  );
  const legacyPreviewUrl = optionalPreviewUrlValue(env.PREVIEW_URL);
  const requestedPreviewUrl = candidatePreviewUrl ?? legacyPreviewUrl;
  if (!nonEmptyString(tagName)) {
    throw new Error("candidate verification requires CANDIDATE_TAG");
  }
  if (
    candidatePreviewUrl !== null &&
    legacyPreviewUrl !== null &&
    candidatePreviewUrl !== legacyPreviewUrl
  ) {
    throw candidatePolicyError(
      "candidate preview URL inputs must be identical",
    );
  }
  if (!isPlainObject(matrix?.candidate)) {
    throw new Error("candidate matrix metadata is missing");
  }
  if (tagName !== matrix.candidate.tag) {
    throw candidatePolicyError(
      "candidate tag does not match the evidence matrix",
    );
  }

  const tag = resolveAnnotatedTagTarget(repoRoot, tagName);
  if (env.CANDIDATE_TAG_SHA !== undefined) {
    if (!isValidSha(env.CANDIDATE_TAG_SHA)) {
      throw new Error("CANDIDATE_TAG_SHA must be lowercase 40-character hex");
    }
    if (env.CANDIDATE_TAG_SHA !== tag.targetSha) {
      throw candidatePolicyError(
        "CANDIDATE_TAG_SHA does not match the annotated tag target",
      );
    }
  }

  let preview;
  try {
    preview = await resolveCloudflarePreview({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      projectName: matrix.candidate.cloudflareProject,
      previewUrl: requestedPreviewUrl,
      expectedBranch: matrix.candidate.targetBranch,
      expectedSha: tag.targetSha,
      fetchImpl,
      apiBaseUrl: DEFAULT_CLOUDFLARE_API_BASE_URL,
    });
  } catch (error) {
    if (error.message.startsWith("no successful Cloudflare preview")) {
      error.exitCode = 1;
    }
    throw error;
  }
  if (env.PREVIEW_COMMIT_SHA !== undefined) {
    if (!isValidSha(env.PREVIEW_COMMIT_SHA)) {
      throw new Error("PREVIEW_COMMIT_SHA must be lowercase 40-character hex");
    }
    if (env.PREVIEW_COMMIT_SHA !== preview.previewSha) {
      throw candidatePolicyError(
        "PREVIEW_COMMIT_SHA does not match Cloudflare deployment metadata",
      );
    }
  }

  const identity = verifyCandidateIdentity({
    tagSha: tag.targetSha,
    previewSha: preview.previewSha,
    previewUrl: preview.previewUrl,
  });
  if (!identity.ok) throw candidatePolicyError(identity.failures.join("; "));
  return { ...identity, tag, preview };
}

function getCommitSubjects(repoRoot, baseSha, headSha) {
  try {
    const output = execFileSync(
      "git",
      ["log", "--format=%s", `${baseSha}..${headSha}`],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    return output.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    throw new Error(`unable to read freeze commit range: ${error.message}`);
  }
}

function envPresence(name, env = process.env) {
  return env[name] !== undefined;
}

function candidatePolicyError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

async function run() {
  const configuredMatrixPath = process.env.CLAIM_EVIDENCE_MATRIX_PATH;
  const configuredRepoRoot = process.env.CLAIM_EVIDENCE_REPO_ROOT;
  const inputMatrixPath =
    typeof configuredMatrixPath === "string" &&
    configuredMatrixPath.trim() !== ""
      ? path.resolve(configuredMatrixPath)
      : matrixPath;
  const inputRepoRoot =
    typeof configuredRepoRoot === "string" && configuredRepoRoot.trim() !== ""
      ? path.resolve(configuredRepoRoot)
      : defaultRepoRoot;
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(inputMatrixPath, "utf8"));
  } catch (error) {
    console.error(
      `claim-evidence ERROR: unable to read or parse ${path.relative(defaultRepoRoot, inputMatrixPath)}: ${error.message}`,
    );
    process.exitCode = 2;
    return;
  }

  const matrixResult = validateEvidenceMatrixInternal(matrix, inputRepoRoot);
  if (!matrixResult.ok) {
    console.error(
      "claim-evidence FAILED — evidence matrix policy is not proven:",
    );
    for (const failure of matrixResult.failures)
      console.error(`  - ${failure}`);
    process.exitCode = matrixResult.malformed ? 2 : 1;
    return;
  }

  if (
    process.env.GITHUB_EVENT_NAME === "release" &&
    matrix.candidate.productionPublish === false
  ) {
    console.error(
      "claim-evidence FAILED — published GitHub Release is forbidden while candidate.productionPublish is false",
    );
    process.exitCode = 1;
    return;
  }

  const baseSha = process.env.FREEZE_BASE_SHA;
  const headSha = process.env.FREEZE_HEAD_SHA;
  const hasBase = baseSha !== undefined && baseSha !== "";
  const hasHead = headSha !== undefined && headSha !== "";
  if (hasBase !== hasHead) {
    console.error(
      "claim-evidence ERROR: FREEZE_BASE_SHA and FREEZE_HEAD_SHA must be provided together",
    );
    process.exitCode = 2;
    return;
  }
  if (hasBase && hasHead) {
    let subjects;
    try {
      subjects = getCommitSubjects(inputRepoRoot, baseSha, headSha);
    } catch (error) {
      console.error(`claim-evidence ERROR: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    const freezeResult = evaluateFeatureFreeze(matrix.freeze, subjects);
    if (!freezeResult.ok) {
      console.error(
        "claim-evidence FAILED — feature freeze rejected the commit range:",
      );
      for (const failure of freezeResult.failures)
        console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
  }

  const exactCandidateTagPush =
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REF_TYPE === "tag" &&
    process.env.GITHUB_REF_NAME === matrix.candidate?.tag;
  const candidateEnv = exactCandidateTagPush
    ? {
        ...process.env,
        CANDIDATE_VERIFICATION_MODE: CANDIDATE_VERIFICATION_MODE,
        CANDIDATE_TAG: process.env.GITHUB_REF_NAME,
        CANDIDATE_PREVIEW_URL: process.env.CANDIDATE_PREVIEW_URL ?? "",
      }
    : process.env;
  const candidateNames = [
    "CANDIDATE_TAG",
    "CANDIDATE_TAG_SHA",
    "PREVIEW_COMMIT_SHA",
    "CANDIDATE_PREVIEW_URL",
    "PREVIEW_URL",
  ];
  const presentCandidateNames = candidateNames.filter((name) =>
    envPresence(name, candidateEnv),
  );
  const candidateModePresent = envPresence(
    "CANDIDATE_VERIFICATION_MODE",
    candidateEnv,
  );
  let candidateVerified = false;
  if (candidateModePresent || presentCandidateNames.length > 0) {
    if (!candidateModePresent) {
      console.error(
        "claim-evidence ERROR: candidate identity environment inputs (all three sources) require candidate verification mode",
      );
      process.exitCode = 2;
      return;
    }
    try {
      await verifyCandidateFromSources({
        matrix,
        repoRoot: inputRepoRoot,
        env: candidateEnv,
      });
      candidateVerified = true;
    } catch (error) {
      console.error(
        `claim-evidence ${error?.exitCode === 1 ? "FAILED" : "ERROR"} — candidate identity is not proven: ${error.message}`,
      );
      process.exitCode = error?.exitCode ?? 2;
      return;
    }
  }

  if (candidateVerified) {
    console.log(
      "claim-evidence OK — matrix, freeze, and independently resolved candidate identity passed",
    );
  } else {
    console.log(
      "claim-evidence OK — local matrix and freeze checks passed; candidate identity verification pending",
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  run().catch((error) => {
    console.error(`claim-evidence ERROR: ${error.message}`);
    process.exitCode = error?.exitCode ?? 2;
  });
}

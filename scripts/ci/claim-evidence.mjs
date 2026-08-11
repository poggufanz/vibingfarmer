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
  "https://github.com/poggufanz/vibingfarmer/tree/v1.15.0-beta",
  "https://dev.vibing-farmer.pages.dev",
]);

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
    "CANDIDATE_TAG_SHA=$CANDIDATE_SHA PREVIEW_COMMIT_SHA=$PREVIEW_SHA PREVIEW_URL=$CANDIDATE_PREVIEW_URL node scripts/ci/claim-evidence.mjs",
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
  tag: "v1.15.0-beta",
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

function validateEvidenceMatrixInternal(matrix, repoRoot) {
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
    if (row.status !== "proven") fail(`${id}: status must be proven`);
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

export function validateEvidenceMatrix(matrix, repoRoot = defaultRepoRoot) {
  const { ok, failures } = validateEvidenceMatrixInternal(matrix, repoRoot);
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

  let url;
  try {
    url = new URL(previewUrl);
  } catch {
    failures.push("preview URL must be an HTTPS vibing-farmer.pages.dev URL");
  }
  if (url) {
    const hostname = url.hostname.toLowerCase();
    const allowedHost = hostname.endsWith(".vibing-farmer.pages.dev");
    if (
      url.protocol !== "https:" ||
      !allowedHost ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    ) {
      failures.push("preview URL must be an HTTPS vibing-farmer.pages.dev URL");
    }
  }
  return { ok: failures.length === 0, failures };
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

function envPresence(name) {
  return process.env[name] !== undefined;
}

function run() {
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

  const candidateNames = [
    "CANDIDATE_TAG_SHA",
    "PREVIEW_COMMIT_SHA",
    "PREVIEW_URL",
  ];
  const presentCandidateNames = candidateNames.filter(envPresence);
  if (presentCandidateNames.length > 0) {
    if (presentCandidateNames.length !== candidateNames.length) {
      console.error(
        "claim-evidence ERROR: candidate identity requires all three environment variables",
      );
      process.exitCode = 2;
      return;
    }
    const candidateResult = verifyCandidateIdentity({
      tagSha: process.env.CANDIDATE_TAG_SHA,
      previewSha: process.env.PREVIEW_COMMIT_SHA,
      previewUrl: process.env.PREVIEW_URL,
    });
    if (!candidateResult.ok) {
      console.error(
        "claim-evidence FAILED — candidate identity is not proven:",
      );
      for (const failure of candidateResult.failures)
        console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    "claim-evidence OK — matrix, freeze, and candidate checks passed",
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  run();
}

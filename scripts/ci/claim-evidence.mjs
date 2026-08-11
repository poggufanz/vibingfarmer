#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  accessSync,
  existsSync,
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

  if (!existsSync(resolvedPath))
    return `evidence path does not exist: ${evidencePath}`;

  try {
    accessSync(resolvedPath, fsConstants.R_OK);
    statSync(resolvedPath);
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
    if (row.status !== "proven") fail(`${id}: status must be proven`);
    if (!nonEmptyString(row.owner)) fail(`${id}: owner must be non-empty`);
    if (!nonEmptyString(row.verification))
      fail(`${id}: verification must be non-empty`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      fail(`${id}: evidence must contain at least one local path`);
      continue;
    }
    for (const evidencePath of row.evidence) {
      const pathFailure = evidencePathFailure(root, evidencePath);
      if (pathFailure) fail(`${id}: ${pathFailure}`);
    }
    if (row.externalLocators !== undefined) {
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

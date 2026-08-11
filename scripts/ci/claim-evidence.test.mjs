import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  evaluateFeatureFreeze,
  CLAIM_CONTRACTS,
  validateEvidenceMatrix,
  verifyCandidateIdentity,
} from "./claim-evidence.mjs";
import * as candidateEvidence from "./claim-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scriptPath = path.join(here, "claim-evidence.mjs");

const requiredIds = [
  "permission-lifetime",
  "yield-availability",
  "sponsored-network-fee",
  "stellar-explorer-counts",
  "candidate-same-commit",
  "required-checks",
  "feature-freeze",
];

function matrixWithClaims(overrides = {}) {
  const claims = requiredIds.map((id) => ({
    id,
    status: id === "candidate-same-commit" ? "pending" : "proven",
    owner: CLAIM_CONTRACTS[id].owner,
    verification: CLAIM_CONTRACTS[id].verification,
    evidence: [...CLAIM_CONTRACTS[id].minimumEvidence],
    ...(CLAIM_CONTRACTS[id].externalLocators
      ? { externalLocators: [...CLAIM_CONTRACTS[id].externalLocators] }
      : {}),
  }));
  return {
    schemaVersion: 1,
    candidate: {
      tag: "v1.15.0-beta",
      targetBranch: "dev",
      cloudflareProject: "vibing-farmer",
      productionPublish: false,
    },
    freeze: {
      active: true,
      activatedOn: "2026-08-11",
      forbiddenCommitTypes: ["feat"],
    },
    claims,
    ...overrides,
  };
}

function checkedInMatrix() {
  return JSON.parse(
    readFileSync(
      path.join(repoRoot, "release", "evidence-matrix.json"),
      "utf8",
    ),
  );
}

function failuresFor(matrix, root = repoRoot) {
  const result = validateEvidenceMatrix(matrix, root);
  assert.equal(result.ok, false);
  return result.failures;
}

function runCli(env = {}, cwd = repoRoot) {
  const mergedEnv = { ...process.env };
  for (const name of [
    "FREEZE_BASE_SHA",
    "FREEZE_HEAD_SHA",
    "CANDIDATE_VERIFICATION_MODE",
    "CANDIDATE_TAG",
    "CANDIDATE_TAG_SHA",
    "PREVIEW_COMMIT_SHA",
    "CANDIDATE_PREVIEW_URL",
    "PREVIEW_URL",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_BASE_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF_TYPE",
    "GITHUB_REF_NAME",
    "GITHUB_REF",
  ]) {
    delete mergedEnv[name];
  }
  Object.assign(mergedEnv, env);
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) delete mergedEnv[key];
  }
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: mergedEnv,
    encoding: "utf8",
  });
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "claim-evidence-test",
      GIT_AUTHOR_EMAIL: "claim-evidence-test@example.invalid",
      GIT_COMMITTER_NAME: "claim-evidence-test",
      GIT_COMMITTER_EMAIL: "claim-evidence-test@example.invalid",
    },
  }).trim();
}

function makeGitRange(subject) {
  const root = mkdtempSync(path.join(tmpdir(), "claim-evidence-range-"));
  mkdirSync(path.join(root, "release"), { recursive: true });
  const fixture = matrixWithClaims();
  const evidencePaths = new Set(
    fixture.claims.flatMap((claim) => claim.evidence),
  );
  for (const evidencePath of evidencePaths) {
    const source = path.join(repoRoot, evidencePath);
    const target = path.join(root, evidencePath);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
  writeFileSync(
    path.join(root, "release", "evidence-matrix.json"),
    JSON.stringify(fixture, null, 2),
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "claim-evidence-test"]);
  git(root, ["config", "user.email", "claim-evidence-test@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "chore: seed evidence fixture"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "change.txt"), "range fixture\n");
  git(root, ["add", "change.txt"]);
  git(root, ["commit", "-qm", subject]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

test("validateEvidenceMatrix: the minimum valid shape passes with ordinary claims proven and candidate pending", () => {
  const result = validateEvidenceMatrix(matrixWithClaims(), repoRoot);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("validateEvidenceMatrix: missing evidence path fails closed", () => {
  const matrix = matrixWithClaims();
  matrix.claims[0].evidence = ["does-not-exist.txt"];
  assert.match(
    failuresFor(matrix).join("\n"),
    /permission-lifetime.*evidence/i,
  );
});

test("validateEvidenceMatrix: empty verification command fails closed", () => {
  const matrix = matrixWithClaims();
  matrix.claims[0].verification = "   ";
  assert.match(failuresFor(matrix).join("\n"), /verification/i);
});

test("validateEvidenceMatrix: every required claim must be proven", () => {
  const matrix = matrixWithClaims();
  matrix.claims[0].status = "planned";
  assert.match(failuresFor(matrix).join("\n"), /permission-lifetime.*proven/i);
});

test("validateEvidenceMatrix: candidate tag, freeze, and production policy are exact", () => {
  const wrongTag = matrixWithClaims();
  wrongTag.candidate.tag = "v1.15.0";
  assert.match(failuresFor(wrongTag).join("\n"), /candidate.*tag/i);

  const inactiveFreeze = matrixWithClaims();
  inactiveFreeze.freeze.active = false;
  assert.match(failuresFor(inactiveFreeze).join("\n"), /freeze.*active/i);

  const productionPublish = matrixWithClaims();
  productionPublish.candidate.productionPublish = true;
  assert.match(failuresFor(productionPublish).join("\n"), /productionPublish/i);
});

test("validateEvidenceMatrix: evidence paths cannot escape the repository root", () => {
  const matrix = matrixWithClaims();
  matrix.claims[0].evidence = ["../outside.txt"];
  assert.match(failuresFor(matrix).join("\n"), /inside.*repo|evidence.*path/i);
});

test("validateEvidenceMatrix: an absolute evidence path is accepted only inside the repository root", () => {
  const matrix = matrixWithClaims();
  const minimumEvidence = matrix.claims[0].evidence;
  matrix.claims[0].evidence = [
    path.join(repoRoot, minimumEvidence[0]),
    ...minimumEvidence.slice(1),
  ];
  assert.equal(validateEvidenceMatrix(matrix, repoRoot).ok, true);
});

test("validateEvidenceMatrix: the checked-in matrix satisfies every contractual claim row", () => {
  const result = validateEvidenceMatrix(checkedInMatrix(), repoRoot);
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.deepEqual(
    Object.keys(CLAIM_CONTRACTS).sort(),
    [...requiredIds].sort(),
  );
});

test("validateEvidenceMatrix: replacing every claim's evidence with README is rejected", () => {
  const matrix = checkedInMatrix();
  for (const row of matrix.claims) row.evidence = ["README.md"];
  const result = validateEvidenceMatrix(matrix, repoRoot);
  assert.equal(result.ok, false);
  for (const id of requiredIds) {
    assert.ok(
      result.failures.some((failure) =>
        failure.startsWith(`${id}: missing required evidence`),
      ),
      `${id} must require its contractual evidence paths`,
    );
  }
});

test("validateEvidenceMatrix: owner and exact verification command are contractual", () => {
  for (const id of requiredIds) {
    const ownerMatrix = checkedInMatrix();
    ownerMatrix.claims.find((row) => row.id === id).owner = "untrusted";
    const ownerResult = validateEvidenceMatrix(ownerMatrix, repoRoot);
    assert.equal(ownerResult.ok, false, `${id} owner bypass`);

    const commandMatrix = checkedInMatrix();
    commandMatrix.claims.find((row) => row.id === id).verification +=
      " --tampered";
    const commandResult = validateEvidenceMatrix(commandMatrix, repoRoot);
    assert.equal(commandResult.ok, false, `${id} command bypass`);
  }
});

test("validateEvidenceMatrix: candidate locators are required, exact, HTTPS, and host-bound", () => {
  const missing = checkedInMatrix();
  delete missing.claims.find((row) => row.id === "candidate-same-commit")
    .externalLocators;
  assert.equal(validateEvidenceMatrix(missing, repoRoot).ok, false);

  for (const locator of [
    "https://github.com/attacker/vibingfarmer/tree/v1.15.0-beta",
    "https://github.com:443/poggufanz/vibingfarmer/tree/v1.15.0-beta",
    "https://dev.vibing-farmer.pages.dev.evil.example",
    "http://dev.vibing-farmer.pages.dev",
  ]) {
    const matrix = checkedInMatrix();
    const row = matrix.claims.find(
      (claim) => claim.id === "candidate-same-commit",
    );
    row.externalLocators = [locator, row.externalLocators[1]];
    assert.equal(validateEvidenceMatrix(matrix, repoRoot).ok, false, locator);
  }
});

test("evaluateFeatureFreeze: rejects conventional feat subjects including scoped breaking changes", () => {
  const freeze = matrixWithClaims().freeze;
  for (const subject of ["feat: add pool", "feat(ui)!: replace flow"]) {
    const result = evaluateFeatureFreeze(freeze, [subject]);
    assert.equal(result.ok, false, subject);
    assert.ok(result.failures.some((failure) => failure.includes(subject)));
  }
});

test("evaluateFeatureFreeze: allows fixes, tests, docs, and release chores", () => {
  const freeze = matrixWithClaims().freeze;
  const subjects = [
    "fix: align expiry",
    "test: cover unavailable yield",
    "docs: publish evidence",
    "chore(release): cut candidate",
  ];
  assert.deepEqual(evaluateFeatureFreeze(freeze, subjects), {
    ok: true,
    failures: [],
  });
});

test("verifyCandidateIdentity: accepts matching lowercase 40-hex SHAs and a Pages preview URL", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    verifyCandidateIdentity({
      tagSha: sha,
      previewSha: sha,
      previewUrl: "https://dev.vibing-farmer.pages.dev",
    }),
    { ok: true, failures: [] },
  );
});

test("verifyCandidateIdentity: rejects nonmatching, non-lowercase, and non-Pages identities", () => {
  const valid = "a".repeat(40);
  const cases = [
    {
      tagSha: valid,
      previewSha: "b".repeat(40),
      previewUrl: "https://dev.vibing-farmer.pages.dev",
    },
    {
      tagSha: valid.toUpperCase(),
      previewSha: valid,
      previewUrl: "https://dev.vibing-farmer.pages.dev",
    },
    {
      tagSha: valid,
      previewSha: valid,
      previewUrl: "http://dev.vibing-farmer.pages.dev",
    },
    {
      tagSha: valid,
      previewSha: valid,
      previewUrl: "https://vibing-farmer.pages.dev.evil.example",
    },
  ];
  for (const candidate of cases) {
    assert.equal(
      verifyCandidateIdentity(candidate).ok,
      false,
      JSON.stringify(candidate),
    );
  }
  assert.equal(verifyCandidateIdentity(null).ok, false);
});

test("CLI: validates the checked-in matrix locally and exits 0", () => {
  const result = runCli({
    FREEZE_BASE_SHA: "",
    FREEZE_HEAD_SHA: "",
    CANDIDATE_TAG_SHA: undefined,
    PREVIEW_COMMIT_SHA: undefined,
    PREVIEW_URL: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claim-evidence OK/);
});

test("CLI: candidate environment variables are all-or-none malformed input", () => {
  const result = runCli({ CANDIDATE_TAG_SHA: "a".repeat(40) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate.*environment|all three/i);
});

test("CLI: candidate inputs cannot opt into verification without required mode", () => {
  const result = runCli({
    CANDIDATE_TAG: "v1.15.0-beta",
    CANDIDATE_PREVIEW_URL: "https://dev.vibing-farmer.pages.dev",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate.*mode|verification.*required/i);
});

test("CLI: required candidate mode fails closed when candidate inputs are omitted", () => {
  const result = runCli({ CANDIDATE_VERIFICATION_MODE: "required" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate.*(tag|preview)|required/i);
});

test("checked-in matrix does not mark same-commit evidence proven before candidate verification", () => {
  const candidate = checkedInMatrix().claims.find(
    (claim) => claim.id === "candidate-same-commit",
  );
  assert.equal(candidate.status, "pending");
  assert.equal(
    validateEvidenceMatrix(checkedInMatrix(), repoRoot, {
      requireCandidateProof: true,
    }).ok,
    false,
  );
});

test("validateEvidenceMatrix: candidate-same-commit cannot be marked proven in static evidence", () => {
  const matrix = checkedInMatrix();
  matrix.claims.find((claim) => claim.id === "candidate-same-commit").status =
    "proven";
  const result = validateEvidenceMatrix(matrix, repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /candidate-same-commit.*pending/i);
});

test("candidate verifier exposes independent annotated-tag and Cloudflare resolvers", () => {
  assert.equal(typeof candidateEvidence.resolveAnnotatedTagTarget, "function");
  assert.equal(typeof candidateEvidence.resolveCloudflarePreview, "function");
});

test("resolveAnnotatedTagTarget rejects lightweight tags and peels annotated tags to commits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "claim-evidence-tag-"));
  writeFileSync(path.join(root, "seed.txt"), "candidate\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "claim-evidence-test"]);
  git(root, ["config", "user.email", "claim-evidence-test@example.invalid"]);
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "-qm", "chore: seed candidate tag"]);
  const targetSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v9.9.9-light"]);
  assert.throws(
    () => candidateEvidence.resolveAnnotatedTagTarget(root, "v9.9.9-light"),
    /annotated/i,
  );
  git(root, ["tag", "-a", "v9.9.9-beta", "-m", "candidate"]);
  assert.deepEqual(
    candidateEvidence.resolveAnnotatedTagTarget(root, "v9.9.9-beta"),
    {
      tagName: "v9.9.9-beta",
      tagRef: "refs/tags/v9.9.9-beta",
      tagObjectSha: git(root, ["rev-parse", "refs/tags/v9.9.9-beta"]),
      targetSha,
    },
  );
});

test("resolveCloudflarePreview reads commit metadata and URL from an authenticated successful deployment", async () => {
  const sha = "c".repeat(40);
  const resolved = await candidateEvidence.resolveCloudflarePreview({
    accountId: "account",
    apiToken: "token",
    previewUrl: "https://dev.vibing-farmer.pages.dev",
    expectedSha: sha,
    fetchImpl: async (url, init) => {
      assert.match(
        String(url),
        /\/client\/v4\/accounts\/account\/pages\/projects\/vibing-farmer\/deployments/,
      );
      assert.equal(init.headers.Authorization, "Bearer token");
      return {
        ok: true,
        async json() {
          return {
            success: true,
            result: [
              {
                id: "deployment-id",
                environment: "preview",
                url: "https://candidate-id.vibing-farmer.pages.dev/",
                aliases: ["https://dev.vibing-farmer.pages.dev/"],
                latest_stage: { status: "success" },
                deployment_trigger: {
                  metadata: { branch: "dev", commit_hash: sha },
                },
              },
            ],
          };
        },
      };
    },
  });
  assert.deepEqual(resolved, {
    deploymentId: "deployment-id",
    previewSha: sha,
    previewUrl: "https://dev.vibing-farmer.pages.dev/",
    branch: "dev",
  });
});

test("resolveCloudflarePreview can select a successful preview by commit and branch when URL is omitted", async () => {
  const sha = "d".repeat(40);
  const resolved = await candidateEvidence.resolveCloudflarePreview({
    accountId: "account",
    apiToken: "token",
    expectedBranch: "dev",
    expectedSha: sha,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          success: true,
          result: [
            {
              id: "wrong-deployment",
              environment: "preview",
              url: "https://wrong.vibing-farmer.pages.dev/",
              latest_stage: { status: "success" },
              deployment_trigger: {
                metadata: { branch: "dev", commit_hash: "e".repeat(40) },
              },
            },
            {
              id: "matching-deployment",
              environment: "preview",
              url: "https://candidate.vibing-farmer.pages.dev/",
              latest_stage: { status: "success" },
              deployment_trigger: {
                metadata: { branch: "dev", commit_hash: sha },
              },
            },
          ],
        };
      },
    }),
  });
  assert.deepEqual(resolved, {
    deploymentId: "matching-deployment",
    previewSha: sha,
    previewUrl: "https://candidate.vibing-farmer.pages.dev/",
    branch: "dev",
  });
});

test("verifyCandidateFromSources accepts an omitted preview URL but still binds Cloudflare metadata to the peeled tag SHA", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "claim-evidence-candidate-"));
  writeFileSync(path.join(root, "seed.txt"), "candidate\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "claim-evidence-test"]);
  git(root, ["config", "user.email", "claim-evidence-test@example.invalid"]);
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "-qm", "chore: seed candidate"]);
  const tagSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "-a", "v1.15.0-beta", "-m", "candidate"]);

  const result = await candidateEvidence.verifyCandidateFromSources({
    matrix: matrixWithClaims(),
    repoRoot: root,
    env: {
      CANDIDATE_VERIFICATION_MODE: "required",
      CANDIDATE_TAG: "v1.15.0-beta",
      CANDIDATE_PREVIEW_URL: "",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          success: true,
          result: [
            {
              id: "matching-deployment",
              environment: "preview",
              url: "https://candidate.vibing-farmer.pages.dev/",
              latest_stage: { status: "success" },
              deployment_trigger: {
                metadata: { branch: "dev", commit_hash: tagSha },
              },
            },
          ],
        };
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tag.targetSha, tagSha);
  assert.equal(result.preview.previewSha, tagSha);
});

test("CLI: the exact candidate tag push automatically enters required verification mode", () => {
  const result = runCli({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v1.15.0-beta",
    GITHUB_REF: "refs/tags/v1.15.0-beta",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate.*(tag|Cloudflare)|required/i);
});

test("CLI: legacy caller-provided identity values are rejected without required mode", () => {
  const result = runCli({
    CANDIDATE_TAG_SHA: "a".repeat(40),
    PREVIEW_COMMIT_SHA: "b".repeat(40),
    PREVIEW_URL: "https://dev.vibing-farmer.pages.dev",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate.*mode|verification.*required/i);
});

test("CLI: a published GitHub Release is a policy failure when production publishing is disabled", () => {
  const result = runCli({ GITHUB_EVENT_NAME: "release" });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /GitHub Release|production.*publish|release event/i,
  );
});

test("CLI: unreadable matrix input exits 2", () => {
  const root = mkdtempSync(path.join(tmpdir(), "claim-evidence-unreadable-"));
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: path.join(
        root,
        "release",
        "evidence-matrix.json",
      ),
    },
    root,
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matrix|read|release\/evidence-matrix/i);
});

test("CLI: malformed matrix JSON exits 2", () => {
  const root = mkdtempSync(path.join(tmpdir(), "claim-evidence-malformed-"));
  const releaseDir = path.join(root, "release");
  const matrix = path.join(releaseDir, "evidence-matrix.json");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(matrix, "{ not valid json");
  const result = runCli({ CLAIM_EVIDENCE_MATRIX_PATH: matrix }, root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matrix|parse|JSON/i);
});

test("CLI: unreadable existing evidence is malformed input exit 2", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "claim-evidence-unreadable-evidence-"),
  );
  const releaseDir = path.join(root, "release");
  const evidence = path.join(root, "evidence.md");
  const matrix = path.join(releaseDir, "evidence-matrix.json");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(evidence, "private evidence\n");
  chmodSync(evidence, 0);
  const fixture = matrixWithClaims();
  for (const row of fixture.claims) row.evidence = ["evidence.md"];
  writeFileSync(matrix, JSON.stringify(fixture, null, 2));
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: matrix,
      CLAIM_EVIDENCE_REPO_ROOT: root,
    },
    root,
  );
  chmodSync(evidence, 0o600);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreadable|evidence/i);
});

test("checked-in candidate verification resolves the preview SHA independently", () => {
  const matrix = checkedInMatrix();
  const row = matrix.claims.find(
    (claim) => claim.id === "candidate-same-commit",
  );
  assert.match(row.verification, /CANDIDATE_VERIFICATION_MODE=required/);
  assert.match(row.verification, /CANDIDATE_TAG=\$CANDIDATE_TAG/);
  assert.match(
    row.verification,
    /CANDIDATE_PREVIEW_URL=\$CANDIDATE_PREVIEW_URL/,
  );
  assert.doesNotMatch(row.verification, /PREVIEW_COMMIT_SHA=\$CANDIDATE_SHA/);
  const human = readFileSync(path.join(repoRoot, "EVIDENCE_MATRIX.md"), "utf8");
  assert.match(human, /CANDIDATE_VERIFICATION_MODE=required/);
  assert.match(human, /CANDIDATE_PREVIEW_URL=\$CANDIDATE_PREVIEW_URL/);
  assert.doesNotMatch(human, /PREVIEW_COMMIT_SHA=\$CANDIDATE_SHA/);
});

test("workflow has a mandatory manual candidate verification path distinct from ordinary CI", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "frontend.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /candidate_tag:/);
  assert.match(workflow, /candidate_preview_url:/);
  assert.match(workflow, /CANDIDATE_VERIFICATION_MODE: required/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(
    workflow,
    /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
});

test("CLI: evaluates an allowed commit range from FREEZE_BASE_SHA/FREEZE_HEAD_SHA", () => {
  const fixture = makeGitRange("fix: align expiry");
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: path.join(
        fixture.root,
        "release",
        "evidence-matrix.json",
      ),
      CLAIM_EVIDENCE_REPO_ROOT: fixture.root,
      FREEZE_BASE_SHA: fixture.baseSha,
      FREEZE_HEAD_SHA: fixture.headSha,
    },
    fixture.root,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claim-evidence OK/);
});

test("CLI: rejects a feat commit in the supplied freeze range as policy exit 1", () => {
  const fixture = makeGitRange("feat(ui)!: replace flow");
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: path.join(
        fixture.root,
        "release",
        "evidence-matrix.json",
      ),
      CLAIM_EVIDENCE_REPO_ROOT: fixture.root,
      FREEZE_BASE_SHA: fixture.baseSha,
      FREEZE_HEAD_SHA: fixture.headSha,
    },
    fixture.root,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /feature freeze|feat\(ui\)!/i);
});

test("CLI: rejects an unreadable freeze range as malformed exit 2", () => {
  const fixture = makeGitRange("fix: align expiry");
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: path.join(
        fixture.root,
        "release",
        "evidence-matrix.json",
      ),
      CLAIM_EVIDENCE_REPO_ROOT: fixture.root,
      FREEZE_BASE_SHA: "missing-base-sha",
      FREEZE_HEAD_SHA: fixture.headSha,
    },
    fixture.root,
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /freeze commit range|unable to read/i);
});

test("CLI: requires both freeze range environment variables together", () => {
  const fixture = makeGitRange("fix: align expiry");
  const result = runCli(
    {
      CLAIM_EVIDENCE_MATRIX_PATH: path.join(
        fixture.root,
        "release",
        "evidence-matrix.json",
      ),
      CLAIM_EVIDENCE_REPO_ROOT: fixture.root,
      FREEZE_BASE_SHA: fixture.baseSha,
    },
    fixture.root,
  );
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /FREEZE_BASE_SHA.*FREEZE_HEAD_SHA|provided together/i,
  );
});

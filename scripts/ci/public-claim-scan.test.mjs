import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BANNED_PUBLIC_CLAIM_PATTERNS,
  discoverTrackedPublicSurfaces,
  findBannedPublicClaims,
  isPublicSurface,
  main,
  resolveRepositoryRoot,
  scanTrackedPublicSurfaces,
} from "./public-claim-scan.mjs";

function makeGitFixture(text, { removeTrackedFile = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "public-claim-scan-"));
  writeFileSync(path.join(root, "README.md"), text);
  mkdirSync(path.join(root, "frontend"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "README.md"], { cwd: root });
  if (removeTrackedFile) rmSync(path.join(root, "README.md"));
  return root;
}

function captureOutput(run) {
  const output = { logs: [], errors: [] };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.logs.push(args.join(" "));
  console.error = (...args) => output.errors.push(args.join(" "));
  try {
    output.code = run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return output;
}

test("exports named, case-insensitive patterns for each banned zero-fee claim", () => {
  assert.ok(Array.isArray(BANNED_PUBLIC_CLAIM_PATTERNS));
  assert.ok(BANNED_PUBLIC_CLAIM_PATTERNS.length >= 7);
  for (const definition of BANNED_PUBLIC_CLAIM_PATTERNS) {
    assert.equal(typeof definition.label, "string");
    assert.ok(definition.regex instanceof RegExp);
    assert.equal(definition.regex.flags.includes("i"), true);
  }
});

test("findBannedPublicClaims rejects the required zero-fee claim fixtures", () => {
  const fixtures = [
    "gas 0",
    "ZERO GAS",
    "gas-free",
    "gas-sponsored",
    "Gasless",
    "fee-free",
    "fees covered",
    "0 XLM, fee-bump",
    "gas cost to user: 0 USDC",
    "Base gas — 0 ETH",
    "network fees you pay: Zero",
  ];

  for (const fixture of fixtures) {
    const findings = findBannedPublicClaims(fixture);
    assert.ok(findings.length > 0, `expected a finding for ${fixture}`);
    assert.equal(findings[0].line, 1);
    assert.equal(findings[0].excerpt, fixture);
    assert.equal(typeof findings[0].pattern, "string");
  }
});

test("findBannedPublicClaims rejects reachable noncanonical fee-payer claims", () => {
  const fixtures = ["You don't.", "Fee-bump sponsored", "Network fee paid by"];

  for (const fixture of fixtures) {
    const findings = findBannedPublicClaims(fixture);
    assert.ok(findings.length > 0, `expected a finding for ${fixture}`);
    assert.equal(findings[0].line, 1);
    assert.equal(findings[0].excerpt, fixture);
  }
});

test("findBannedPublicClaims is line-aware and deterministic", () => {
  const findings = findBannedPublicClaims(
    "Network fee sponsored by fee-bump relay.\n\nzero GAS now\n0 XLM, FEE-BUMP\n",
  );

  assert.deepEqual(
    findings.map(({ pattern, line, excerpt }) => ({ pattern, line, excerpt })),
    [
      { pattern: "zero-gas", line: 3, excerpt: "zero GAS now" },
      { pattern: "zero-XLM-fee-bump", line: 4, excerpt: "0 XLM, FEE-BUMP" },
    ],
  );
});

test("canonical sponsored copy and truthful direct fallback copy are clean", () => {
  const clean = [
    "Network fee sponsored by fee-bump relay.",
    "Base network fee sponsored by relay.",
    "Direct fallback transactions require the wallet to pay the displayed network fee.",
  ].join("\n");

  assert.deepEqual(findBannedPublicClaims(clean), []);
});

test("surface selection excludes internal library modules and test files", () => {
  assert.equal(isPublicSurface("frontend/src/base/paymaster.js"), false);
  assert.equal(isPublicSurface("frontend/src/stellar/GaslessClient.js"), false);
  assert.equal(
    isPublicSurface("frontend/src/components/WithdrawModal.test.jsx"),
    false,
  );
  assert.equal(
    isPublicSurface("frontend/src/components/WithdrawModal.jsx"),
    true,
  );
  assert.equal(
    isPublicSurface("frontend/src/wallet/ui/classic/OnboardingScreen.jsx"),
    true,
  );
  assert.equal(isPublicSurface("docs-site/features.md"), true);
});

test("tracked-surface discovery is stable when the caller starts in a nested directory", () => {
  const repoRoot = resolveRepositoryRoot();
  const nestedCwd = path.join(repoRoot, "frontend");

  assert.deepEqual(
    discoverTrackedPublicSurfaces(nestedCwd),
    discoverTrackedPublicSurfaces(repoRoot),
  );
  assert.deepEqual(
    scanTrackedPublicSurfaces(nestedCwd),
    scanTrackedPublicSurfaces(repoRoot),
  );
});

test("main returns 0 and reports clean output from a nested cwd", () => {
  const fixture = makeGitFixture(
    [
      "Network fee sponsored by fee-bump relay.",
      "Direct fallback transactions require the wallet to pay the displayed network fee.",
    ].join("\n"),
  );
  try {
    const result = captureOutput(() => main(path.join(fixture, "frontend")));
    assert.equal(result.code, 0);
    assert.deepEqual(result.errors, []);
    assert.match(result.logs.join("\n"), /public-claim-scan OK/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("main returns 1 and reports path, line, pattern, and excerpt for a finding", () => {
  const fixture = makeGitFixture("Fee-bump sponsored\n");
  try {
    const result = captureOutput(() => main(fixture));
    assert.equal(result.code, 1);
    assert.deepEqual(result.logs, []);
    assert.match(
      result.errors.join("\n"),
      /README\.md:1 fee-bump-sponsored: Fee-bump sponsored/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("main returns 2 and reports a tracked-file read error", () => {
  const fixture = makeGitFixture("Network fee sponsored by fee-bump relay.\n", {
    removeTrackedFile: true,
  });
  try {
    const result = captureOutput(() => main(fixture));
    assert.equal(result.code, 2);
    assert.deepEqual(result.logs, []);
    assert.match(result.errors.join("\n"), /public-claim-scan ERROR:/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("main reserves exit 2 and emits an error when repository discovery fails", () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.equal(main(path.join(process.cwd(), "missing-repository")), 2);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join("\n"), /public-claim-scan ERROR:/);
});

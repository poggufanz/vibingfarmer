import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANNED_PUBLIC_CLAIM_PATTERNS,
  findBannedPublicClaims,
  isPublicSurface,
} from "./public-claim-scan.mjs";

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

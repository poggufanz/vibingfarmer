#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DOCS = new Set([
  "README.md",
  "prd.md",
  "GETTING_STARTED.md",
  "FEATURES.md",
]);

// These are deliberately claim-shaped patterns.  They do not scan implementation modules
// outside the shipped copy surfaces, where names such as GaslessClient are internal APIs.
export const BANNED_PUBLIC_CLAIM_PATTERNS = Object.freeze([
  Object.freeze({ label: "zero-gas", regex: /\bzero\s+gas\b/i }),
  Object.freeze({ label: "zero-gas", regex: /\bgas\s*:\s*0\b/i }),
  Object.freeze({ label: "zero-gas", regex: /\bgas\s+0\b/i }),
  Object.freeze({ label: "gas-free", regex: /\bgas[-\s]?free\b/i }),
  Object.freeze({ label: "gas-sponsored", regex: /\bgas[-\s]?sponsored\b/i }),
  Object.freeze({ label: "gasless", regex: /\bgasless\b/i }),
  Object.freeze({ label: "fee-free", regex: /\bfee[-\s]?free\b/i }),
  Object.freeze({ label: "fees-covered", regex: /\bfees?\s+covered\b/i }),
  Object.freeze({ label: "zero-XLM-fee-bump", regex: /\b0\s*XLM\b/i }),
  Object.freeze({ label: "zero-ETH-fee", regex: /\b0\s*ETH\b/i }),
  Object.freeze({
    label: "zero-user-gas-cost",
    regex: /\bgas\s+cost\s+to\s+user\s*:\s*(?:0|zero)\s*(?:USDC|XLM|ETH)?\b/i,
  }),
  Object.freeze({
    label: "zero-network-fee",
    regex: /\bnetwork\s+fees?\s+you\s+pay\s*:\s*(?:0|zero)\b/i,
  }),
]);

export function isPublicSurface(file) {
  if (ROOT_DOCS.has(file) || file.startsWith("docs-site/")) return true;

  return (
    /\.(?:js|jsx)$/.test(file) &&
    !/\.test\./.test(file) &&
    (file === "frontend/src/components.jsx" ||
      file === "frontend/src/agents.jsx" ||
      file === "frontend/src/screens.jsx" ||
      file === "frontend/src/app.jsx" ||
      file === "frontend/src/money/ownerActions.js" ||
      file.startsWith("frontend/src/components/") ||
      file.startsWith("frontend/src/screens/") ||
      file.startsWith("frontend/src/developers/") ||
      file.startsWith("frontend/src/wallet/ui/"))
  );
}

export function findBannedPublicClaims(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");

  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { label, regex } of BANNED_PUBLIC_CLAIM_PATTERNS) {
      if (regex.test(line)) {
        findings.push({
          pattern: label,
          line: index + 1,
          excerpt: line.trim(),
        });
      }
    }
  }
  return findings;
}

export function discoverTrackedPublicSurfaces(repoRoot = process.cwd()) {
  const result = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`git ls-files failed: ${detail}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isPublicSurface)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function scanTrackedPublicSurfaces(repoRoot = process.cwd()) {
  const files = discoverTrackedPublicSurfaces(repoRoot);
  const findings = [];

  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    for (const finding of findBannedPublicClaims(text)) {
      findings.push({ file, ...finding });
    }
  }

  return findings;
}

export function main(repoRoot = process.cwd()) {
  try {
    const findings = scanTrackedPublicSurfaces(repoRoot);
    if (findings.length > 0) {
      for (const finding of findings) {
        console.error(
          `${finding.file}:${finding.line} ${finding.pattern}: ${finding.excerpt}`,
        );
      }
      return 1;
    }

    console.log(
      "public-claim-scan OK: no banned claims in tracked public surfaces",
    );
    return 0;
  } catch (error) {
    console.error(
      `public-claim-scan ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) process.exitCode = main();

#!/usr/bin/env node
// The single deterministic release gate. The workflow's `release-gate` job runs `if: always()`
// with `needs` on every stable check (frontend-unit-build, relayer, keeper, soroban,
// playwright), passes `${{ toJSON(needs) }}` in, and this script decides pass/fail. `deploy`
// then needs only `release-gate` — so no individual job's success/failure/skip can bypass it,
// and a job that never runs (skipped) fails the gate exactly like one that fails outright.
//
// Run: `node scripts/ci/release-gate.mjs` with NEEDS_CONTEXT set to the JSON needs context
// (or pass it as argv[2] for local/manual runs).
import { fileURLToPath } from 'node:url'

export const REQUIRED_JOBS = Object.freeze([
  'frontend-unit-build',
  'relayer',
  'keeper',
  'soroban',
  'playwright',
])

// Fail-closed: never throws on malformed input. A gate script that can crash on bad input is a
// gate that can accidentally be bypassed by whatever handles the crash upstream — instead every
// unexpected shape resolves to "this job did not succeed."
export function evaluateReleaseGate(needs) {
  const source = needs && typeof needs === 'object' && !Array.isArray(needs) ? needs : {}
  const failures = []
  for (const job of REQUIRED_JOBS) {
    const entry = source[job]
    const result = entry && typeof entry === 'object' ? entry.result : undefined
    if (result !== 'success') {
      failures.push(`${job}: ${result ?? 'missing'}`)
    }
  }
  return { ok: failures.length === 0, failures }
}

function main() {
  const raw = process.env.NEEDS_CONTEXT ?? process.argv[2]
  if (!raw) {
    console.error(
      'release-gate: no needs context provided — set NEEDS_CONTEXT or pass it as argv[2].'
    )
    process.exit(1)
    return
  }

  let needs
  try {
    needs = JSON.parse(raw)
  } catch (error) {
    console.error(`release-gate: failed to parse needs context as JSON: ${error.message}`)
    process.exit(1)
    return
  }

  const { ok, failures } = evaluateReleaseGate(needs)
  if (!ok) {
    console.error('release-gate FAILED — required jobs did not all succeed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
    return
  }

  console.log(`release-gate OK — all required jobs succeeded: ${REQUIRED_JOBS.join(', ')}`)
}

// Robust entrypoint guard: a hand-built `file://${argv[1]}` string comparison fails silently
// (main() never runs, script exits 0) whenever the checkout path contains a space or
// non-ASCII character, since import.meta.url is percent-encoded and argv[1] is not. Normalizing
// both sides through fileURLToPath keeps this working everywhere.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

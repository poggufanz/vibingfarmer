// CLI for the ESLint warning-fingerprint gate.
//
//   npm run lint:ci             — check mode: fail on any ESLint error, or any fingerprint
//                                  addition/multiplicity increase above frontend/scripts/eslint-warning-baseline.json.
//   npm run lint:warnings:update — regenerate the baseline from the tree as it stands. Refuses
//                                  when CI=true (see assertUpdateAllowed) — this is a reviewed,
//                                  local, human decision, never something CI does to itself.
//
// Uses the installed ESLint Node API directly (no new dependency), against the same flat config
// (frontend/eslint.config.js) and target (`.`) as `npm run lint`.
import { ESLint } from 'eslint'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildFingerprints,
  loadBaseline,
  serializeBaseline,
  compareToBaseline,
  assertUpdateAllowed,
} from './eslintWarningBaseline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'scripts', 'eslint-warning-baseline.json')

async function run() {
  const isUpdate = process.argv.includes('--update')

  if (isUpdate) {
    try {
      assertUpdateAllowed(process.env)
    } catch (error) {
      console.error(`lint:warnings:update FAILED — ${error.message}`)
      process.exitCode = 1
      return
    }
  }

  const eslint = new ESLint({ cwd: root })
  const results = await eslint.lintFiles(['.'])
  const { counts, errorCount, totalWarnings } = buildFingerprints(results, root)

  if (isUpdate) {
    writeFileSync(baselinePath, serializeBaseline(counts))
    console.log(
      `lint:warnings:update wrote ${counts.size} fingerprint(s) covering ${totalWarnings} warning(s) to ${path.relative(root, baselinePath)}`
    )
    return
  }

  if (errorCount > 0) {
    console.error(
      `lint:ci FAILED — ${errorCount} ESLint error(s) (errors always fail, regardless of the baseline).`
    )
    process.exitCode = 1
  }

  if (!existsSync(baselinePath)) {
    console.error(
      `lint:ci FAILED — no baseline at ${path.relative(root, baselinePath)}. Run \`npm run lint:warnings:update\` locally and commit the result.`
    )
    process.exitCode = 1
    return
  }

  const baseline = loadBaseline(readFileSync(baselinePath, 'utf8'))
  const { additions } = compareToBaseline(counts, baseline)

  if (additions.length > 0) {
    console.error(
      `lint:ci FAILED — ${additions.length} warning fingerprint(s) exceed the checked-in baseline:`
    )
    for (const addition of additions) {
      console.error(
        `  - ${addition.relativePath} [${addition.ruleId ?? '<no-rule>'}] baseline=${addition.baselineCount} current=${addition.currentCount} (+${addition.delta}): ${addition.message}`
      )
    }
    console.error(
      'If these are reviewed and intentional, run `npm run lint:warnings:update` locally and commit the updated baseline.'
    )
    process.exitCode = 1
    return
  }

  if (process.exitCode) return
  console.log(
    `lint:ci OK — ${totalWarnings} warning(s) across ${counts.size} fingerprint(s), within the checked-in baseline.`
  )
}

await run()

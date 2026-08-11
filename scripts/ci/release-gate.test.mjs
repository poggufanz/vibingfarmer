// RED-then-GREEN coverage for the release gate:
//   1. evaluateReleaseGate(needs) — the pure decision function the release-gate job runs.
//   2. Structural assertions against .github/workflows/frontend.yml itself, so the "always
//      triggered, nothing bypasses it" property is enforced by a real parse of the YAML
//      rather than a comment that claims it.
//
// No YAML parser is installed anywhere reachable from repo root (no root package.json /
// node_modules at all — confirmed before writing this). Rather than add a dependency for a
// handful of structural checks, this file carries a small hand-rolled parser for the exact
// GitHub Actions YAML subset this workflow is authored in (block mappings/sequences, literal
// block scalars for multi-line `path:` inputs, plus the simple flow collections already used
// for `on.push` and `needs: [...]`). The workflow avoids flow mappings that embed `${{ }}`
// expressions so this parser can stay small and honest instead of a re-implementation of full
// YAML.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { evaluateReleaseGate, REQUIRED_JOBS } from './release-gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'frontend.yml')
const releaseGateScript = path.join(here, 'release-gate.mjs')

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser (block mappings/sequences + simple flow collections).
// ---------------------------------------------------------------------------

function splitTopLevel(str, sepChar) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const ch of str) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === sepChar && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

function unquote(str) {
  const s = str.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseScalar(raw) {
  const s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~' || s === '') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

function parseFlowSequence(str) {
  const inner = str.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (inner.trim() === '') return []
  return splitTopLevel(inner, ',').map((item) => parseFlowValue(item))
}

function parseFlowMapping(str) {
  const inner = str.trim().replace(/^\{/, '').replace(/\}$/, '')
  const obj = {}
  if (inner.trim() === '') return obj
  for (const pair of splitTopLevel(inner, ',')) {
    const idx = pair.indexOf(':')
    const key = unquote(pair.slice(0, idx).trim())
    const value = pair.slice(idx + 1).trim()
    obj[key] = parseFlowValue(value)
  }
  return obj
}

function parseFlowValue(value) {
  const v = value.trim()
  if (v.startsWith('{')) return parseFlowMapping(v)
  if (v.startsWith('[')) return parseFlowSequence(v)
  return parseScalar(v)
}

function findTopLevelColon(content) {
  // Keys in this workflow are always plain identifiers (no embedded colons), so the
  // first colon on a mapping-entry line is always the key/value separator — even when
  // the value itself contains further colons (e.g. a `run:` line with a URL).
  return content.indexOf(':')
}

function tokenize(text) {
  const tokens = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    tokens.push({ indent, content: trimmed })
  }
  return tokens
}

function parseYamlSubset(text) {
  const tokens = tokenize(text)
  let pos = 0

  function parseBlock(indent) {
    if (pos >= tokens.length || tokens[pos].indent < indent) return null
    if (tokens[pos].content.startsWith('- ') || tokens[pos].content === '-') {
      return parseSequence(indent)
    }
    return parseMapping(indent)
  }

  function assignValue(obj, key, rest, indent) {
    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
      const style = rest[0]
      const lines = []
      while (pos < tokens.length && tokens[pos].indent > indent) {
        lines.push(tokens[pos].content)
        pos++
      }
      obj[key] = lines.join(style === '|' ? '\n' : ' ')
    } else if (rest === '') {
      if (pos < tokens.length && tokens[pos].indent > indent) {
        obj[key] = parseBlock(tokens[pos].indent)
      } else {
        obj[key] = null
      }
    } else if (rest.startsWith('{')) {
      obj[key] = parseFlowMapping(rest)
    } else if (rest.startsWith('[')) {
      obj[key] = parseFlowSequence(rest)
    } else {
      obj[key] = parseScalar(rest)
    }
  }

  function parseMapping(indent) {
    const result = {}
    while (
      pos < tokens.length &&
      tokens[pos].indent === indent &&
      !tokens[pos].content.startsWith('- ')
    ) {
      const { content } = tokens[pos]
      const colonIdx = findTopLevelColon(content)
      if (colonIdx === -1) {
        pos++
        continue
      }
      const key = unquote(content.slice(0, colonIdx).trim())
      const rest = content.slice(colonIdx + 1).trim()
      pos++
      assignValue(result, key, rest, indent)
    }
    return result
  }

  function parseSequence(indent) {
    const result = []
    while (
      pos < tokens.length &&
      tokens[pos].indent === indent &&
      tokens[pos].content.startsWith('- ')
    ) {
      const after = tokens[pos].content.slice(2).trim()
      const continuationIndent = indent + 2
      pos++
      if (after === '') {
        result.push(pos < tokens.length && tokens[pos].indent > indent ? parseBlock(tokens[pos].indent) : null)
        continue
      }
      const colonIdx = findTopLevelColon(after)
      if (colonIdx === -1) {
        result.push(parseFlowValue(after))
        continue
      }
      const obj = {}
      const key = unquote(after.slice(0, colonIdx).trim())
      const rest = after.slice(colonIdx + 1).trim()
      assignValue(obj, key, rest, continuationIndent)
      while (pos < tokens.length && tokens[pos].indent === continuationIndent) {
        const { content } = tokens[pos]
        const idx2 = findTopLevelColon(content)
        if (idx2 === -1) break
        const key2 = unquote(content.slice(0, idx2).trim())
        const rest2 = content.slice(idx2 + 1).trim()
        pos++
        assignValue(obj, key2, rest2, continuationIndent)
      }
      result.push(obj)
    }
    return result
  }

  return parseBlock(0)
}

function loadWorkflow() {
  return parseYamlSubset(readFileSync(workflowPath, 'utf8'))
}

// A trigger is "unfiltered" if it has no keys that would suppress the workflow from
// running on some subset of real events (types/paths/paths-ignore/branches-ignore/tags...).
// `branches` is a separate axis: for `push` it's intentional (selects which branch a push
// lands on, still every push to it runs) and stays allowed; for `pull_request`/`merge_group`
// it would silently stop the gate from ever evaluating PRs/merge-queue entries targeting an
// unlisted branch, which is exactly the kind of narrowing "unfiltered" is meant to rule out —
// so it is forbidden there too.
const NARROWING_KEYS = ['types', 'paths', 'paths-ignore', 'branches-ignore', 'tags', 'tags-ignore']

function assertUnfiltered(trigger, label, { allowBranches = false } = {}) {
  if (trigger === null || trigger === undefined) return // bare trigger — always unfiltered
  assert.equal(typeof trigger, 'object', `${label} trigger should be bare or a plain object`)
  const forbidden = allowBranches ? NARROWING_KEYS : [...NARROWING_KEYS, 'branches']
  for (const key of forbidden) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(trigger, key),
      false,
      `${label} trigger must not use narrowing key "${key}"`
    )
  }
}

// Asserts the `continue-on-error` key is entirely absent — not merely not `=== true`. A string
// expression like `continue-on-error: ${{ ... }}` would slip past a `=== true` check while
// still making the check soft-fail depending on the expression's runtime value.
function findAllContinueOnErrorKeys(node, hits = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAllContinueOnErrorKeys(item, hits)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'continue-on-error') hits.push(value)
      findAllContinueOnErrorKeys(value, hits)
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// evaluateReleaseGate — success/failure/cancelled/skipped/missing matrices.
// ---------------------------------------------------------------------------

function allSuccess() {
  const needs = {}
  for (const job of REQUIRED_JOBS) needs[job] = { result: 'success' }
  return needs
}

test('evaluateReleaseGate: all required jobs successful passes', () => {
  const { ok, failures } = evaluateReleaseGate(allSuccess())
  assert.equal(ok, true)
  assert.deepEqual(failures, [])
})

test('evaluateReleaseGate: fails when any single required job is not successful', async (t) => {
  for (const job of REQUIRED_JOBS) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      await t.test(`${job} -> ${result}`, () => {
        const needs = allSuccess()
        needs[job] = { result }
        const { ok, failures } = evaluateReleaseGate(needs)
        assert.equal(ok, false)
        assert.equal(failures.some((f) => f.includes(job)), true)
      })
    }
  }
})

test('evaluateReleaseGate: fails when a required job is entirely missing from needs', () => {
  const needs = allSuccess()
  delete needs.soroban
  const { ok, failures } = evaluateReleaseGate(needs)
  assert.equal(ok, false)
  assert.equal(failures.some((f) => f.includes('soroban')), true)
})

test('evaluateReleaseGate: reports every failing job, not just the first', () => {
  const needs = allSuccess()
  needs.relayer = { result: 'failure' }
  needs.keeper = { result: 'cancelled' }
  const { ok, failures } = evaluateReleaseGate(needs)
  assert.equal(ok, false)
  assert.equal(failures.length, 2)
})

test('evaluateReleaseGate: an unrelated extra job in needs does not affect the verdict', () => {
  const needs = allSuccess()
  needs['some-other-job'] = { result: 'failure' }
  const { ok } = evaluateReleaseGate(needs)
  assert.equal(ok, true)
})

test('evaluateReleaseGate: error handling — null/undefined/non-object needs fail closed, not throw', () => {
  for (const bad of [null, undefined, 'not-an-object', 42, []]) {
    assert.doesNotThrow(() => evaluateReleaseGate(bad))
    const { ok, failures } = evaluateReleaseGate(bad)
    assert.equal(ok, false)
    assert.equal(failures.length, REQUIRED_JOBS.length)
  }
})

test('evaluateReleaseGate: error handling — a required job entry missing `result` is treated as missing', () => {
  const needs = allSuccess()
  needs.playwright = {}
  const { ok, failures } = evaluateReleaseGate(needs)
  assert.equal(ok, false)
  assert.equal(failures.some((f) => f.includes('playwright')), true)
})

// ---------------------------------------------------------------------------
// Workflow structure assertions.
// ---------------------------------------------------------------------------

test('workflow: push, pull_request, and merge_group triggers are all present and unfiltered', () => {
  const workflow = loadWorkflow()
  assert.ok(workflow.on, 'workflow must declare `on`')
  assert.ok(Object.prototype.hasOwnProperty.call(workflow.on, 'push'), 'missing push trigger')
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on, 'pull_request'),
    'missing pull_request trigger'
  )
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on, 'merge_group'),
    'missing merge_group trigger'
  )
  assertUnfiltered(workflow.on.push, 'push', { allowBranches: true })
  assertUnfiltered(workflow.on.pull_request, 'pull_request')
  assertUnfiltered(workflow.on.merge_group, 'merge_group')
})

test('workflow: pull_request/merge_group narrowed by `branches` would not prove "unfiltered"', () => {
  // Regression guard for the assertion itself: a `branches` restriction on pull_request or
  // merge_group must be rejected even though the same key is fine on push.
  assert.throws(() => assertUnfiltered({ branches: ['main'] }, 'pull_request'))
  assert.throws(() => assertUnfiltered({ branches: ['main'] }, 'merge_group'))
  assert.doesNotThrow(() => assertUnfiltered({ branches: ['main', 'dev'] }, 'push', { allowBranches: true }))
})

test('workflow: every required job for the release gate exists and always reports (no job-level `if`)', () => {
  const workflow = loadWorkflow()
  for (const job of REQUIRED_JOBS) {
    assert.ok(workflow.jobs[job], `jobs.${job} must exist`)
    assert.equal(
      Object.prototype.hasOwnProperty.call(workflow.jobs[job], 'if'),
      false,
      `jobs.${job} must not have a job-level "if" — it must always report a result for the gate`
    )
  }
})

test('workflow: no blocking check anywhere uses the continue-on-error key at all', () => {
  const workflow = loadWorkflow()
  const hits = findAllContinueOnErrorKeys(workflow.jobs)
  assert.deepEqual(hits, [], 'no step or job in this workflow may use continue-on-error, in any form')
})

test('workflow: release-gate needs every required job, including claim evidence, and runs with if: always()', () => {
  const workflow = loadWorkflow()
  const releaseGate = workflow.jobs['release-gate']
  assert.ok(releaseGate, 'jobs.release-gate must exist')
  assert.equal(releaseGate.if, 'always()')
  assert.ok(Array.isArray(releaseGate.needs), 'release-gate.needs must be a list')
  assert.ok(REQUIRED_JOBS.includes('claim-evidence'), 'REQUIRED_JOBS must include claim-evidence')
  assert.deepEqual([...releaseGate.needs].sort(), [...REQUIRED_JOBS].sort())
})

test('workflow: claim-evidence runs at repository root with full history, Node 22, and no soft-fail escape', () => {
  const workflow = loadWorkflow()
  const job = workflow.jobs['claim-evidence']
  assert.ok(job, 'jobs.claim-evidence must exist')
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'defaults'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'if'), false)
  assert.equal(findAllContinueOnErrorKeys(job).length, 0)

  const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4')
  assert.ok(checkout, 'claim-evidence must check out the repository')
  assert.equal(checkout.with?.['fetch-depth'], 0)

  const setupNode = job.steps.find((step) => step.uses === 'actions/setup-node@v4')
  assert.ok(setupNode, 'claim-evidence must set up Node')
  assert.equal(setupNode.with?.['node-version'], 22)

  const testStep = job.steps.find(
    (step) => typeof step.run === 'string' && step.run.includes('claim-evidence.test.mjs')
  )
  assert.ok(testStep, 'claim-evidence must run its validator and gate tests')
  assert.match(testStep.run, /public-claim-scan\.test\.mjs/)
  assert.match(testStep.run, /release-gate\.test\.mjs/)

  assert.ok(
    job.steps.some((step) => step.run === 'node scripts/ci/public-claim-scan.mjs'),
    'claim-evidence must run the public claim scanner'
  )
  const claimStep = job.steps.find((step) => step.run === 'node scripts/ci/claim-evidence.mjs')
  assert.ok(claimStep, 'claim-evidence must run the claim validator')
  assert.deepEqual(claimStep.env, {
    FREEZE_BASE_SHA:
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event_name == 'push' && github.event.before || '' }}",
    FREEZE_HEAD_SHA:
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event_name == 'push' && github.sha || '' }}",
  })
})

test('workflow: deploy needs only release-gate — it cannot bypass the gate via any other job', () => {
  const workflow = loadWorkflow()
  const deploy = workflow.jobs.deploy
  assert.ok(deploy, 'jobs.deploy must exist')
  assert.equal(deploy.needs, 'release-gate')
})

test('workflow: deploy serializes concurrency without cancelling an in-flight deploy', () => {
  const workflow = loadWorkflow()
  const deploy = workflow.jobs.deploy
  assert.ok(deploy.concurrency, 'jobs.deploy.concurrency must be set')
  assert.ok(deploy.concurrency.group, 'jobs.deploy.concurrency.group must be set')
  assert.equal(deploy.concurrency['cancel-in-progress'], false)
})

test('workflow: production deploy targets a protected GitHub environment', () => {
  const workflow = loadWorkflow()
  const deploy = workflow.jobs.deploy
  assert.ok(deploy.environment, 'jobs.deploy.environment must be set')
  assert.ok(
    String(deploy.environment).includes('production'),
    'jobs.deploy.environment must resolve to "production" for the main branch'
  )
})

test('workflow: deploy runs a non-secret readiness step before the traffic-shifting deploy step', () => {
  const workflow = loadWorkflow()
  const deploy = workflow.jobs.deploy
  const steps = deploy.steps
  const wranglerIdx = steps.findIndex((s) => s.uses && s.uses.startsWith('cloudflare/wrangler-action'))
  assert.ok(wranglerIdx > 0, 'deploy must have a wrangler-action step')
  const readinessIdx = steps.findIndex(
    (s) => typeof s.run === 'string' && !s.env && /test -f|readiness/i.test(s.name ?? s.run)
  )
  assert.ok(readinessIdx !== -1 && readinessIdx < wranglerIdx, 'a non-secret readiness step must run before the wrangler deploy step')
})

test('workflow: deploy migrates each D1 environment before its matching Pages publish', () => {
  const workflow = loadWorkflow()
  const deploy = workflow.jobs.deploy
  const steps = deploy.steps
  const previewCondition = 'github.event_name == \'push\' && github.ref_name != \'main\''
  const productionCondition = 'github.event_name == \'release\' || github.ref_name == \'main\''

  // Keep the protected production approval boundary and the branch-to-environment mapping intact.
  assert.equal(
    deploy.environment,
    "${{ (github.event_name == 'release' || github.ref_name == 'main') && 'production' || 'preview' }}"
  )

  const previewMigrationIdx = steps.findIndex((step) => step.run === 'npm run d1:migrate:preview')
  const productionMigrationIdx = steps.findIndex((step) => step.run === 'npm run d1:migrate:production')
  const clearPreviewConfigIdx = steps.findIndex(
    (step) => step.run === 'node scripts/runtime-config.mjs clear-preview-config'
  )
  const previewDeployIdx = steps.findIndex(
    (step) =>
      step.uses?.startsWith('cloudflare/wrangler-action') &&
      step.if === previewCondition &&
      String(step.with?.command).startsWith('pages deploy ')
  )
  const productionDeployIdx = steps.findIndex(
    (step) =>
      step.uses?.startsWith('cloudflare/wrangler-action') &&
      step.if === productionCondition &&
      String(step.with?.command).startsWith('pages deploy ')
  )

  assert.ok(previewMigrationIdx !== -1, 'preview deploy must run npm run d1:migrate:preview')
  assert.ok(productionMigrationIdx !== -1, 'production deploy must run npm run d1:migrate:production')
  assert.equal(steps[previewMigrationIdx].if, previewCondition)
  assert.equal(steps[productionMigrationIdx].if, productionCondition)
  assert.ok(previewDeployIdx !== -1, 'preview deploy must publish Pages')
  assert.ok(productionDeployIdx !== -1, 'production deploy must publish Pages')
  assert.ok(clearPreviewConfigIdx !== -1, 'production deploy must clear preview config redirect')
  assert.ok(
    previewMigrationIdx < previewDeployIdx,
    'preview D1 migrations must finish before preview Pages Functions are published'
  )
  assert.ok(
    productionMigrationIdx < productionDeployIdx,
    'production D1 migrations must finish before production Pages Functions are published'
  )
  assert.ok(
    productionMigrationIdx < clearPreviewConfigIdx && clearPreviewConfigIdx < productionDeployIdx,
    'preview config redirect must be cleared inside the production deployment boundary'
  )

  assert.equal(steps[previewDeployIdx].if, previewCondition)
  assert.equal(steps[productionDeployIdx].if, productionCondition)
  assert.equal(steps[clearPreviewConfigIdx].if, productionCondition)
  assert.match(steps[previewDeployIdx].with.command, /--branch=\$\{\{ github\.ref_name \}\}/)
  assert.doesNotMatch(steps[previewDeployIdx].with.command, /(?:^|\s)--(?:config|env)(?:\s|=)/)
  assert.match(steps[productionDeployIdx].with.command, /--branch=main(?:\s|$)/)

  // The old single Wrangler migration action must not return as a bypass around the guarded
  // environment-specific scripts above.
  assert.equal(
    steps.some(
      (step) =>
        step.uses?.startsWith('cloudflare/wrangler-action') &&
        step.with?.command === 'd1 migrations apply vf-gate --remote'
    ),
    false
  )
})

test('workflow: playwright upload-artifact path is a scalar naming both report directories (not a YAML sequence)', () => {
  // Action inputs under `with:` become INPUT_* env vars — they must be scalar strings. A YAML
  // sequence there either invalidates the whole workflow file or silently resolves to nothing,
  // and `if-no-files-found: ignore` would swallow the latter without ever failing the job.
  const workflow = loadWorkflow()
  const playwrightJob = workflow.jobs.playwright
  const uploadStep = playwrightJob.steps.find(
    (s) => s.uses && s.uses.startsWith('actions/upload-artifact')
  )
  assert.ok(uploadStep, 'playwright job must have an upload-artifact step')
  const pathValue = uploadStep.with.path
  assert.equal(typeof pathValue, 'string', 'upload-artifact `path` input must be a scalar string, not a list')
  assert.ok(pathValue.includes('frontend/playwright-report'), 'path must include the Playwright HTML report dir')
  assert.ok(pathValue.includes('frontend/test-results'), 'path must include the Playwright test-results dir (screenshots/traces)')
})

// Final review, Fix 4: an uncached from-source `cargo install` of stellar-cli took ~15 min with no
// cache on the one job that blocks every merge, and its "Verify pinned toolchain versions" step
// printed all three versions while asserting none of them — the one place a drifted toolchain or
// stellar-cli would show, invisible in a green log.
test('workflow: soroban caches the stellar-cli install and actually asserts the pinned versions', () => {
  const workflow = loadWorkflow()
  const job = workflow.jobs.soroban
  const cacheStep = job.steps.find((s) => s.uses && s.uses.startsWith('actions/cache'))
  assert.ok(cacheStep, 'soroban must cache the cargo-installed stellar-cli binary')
  assert.ok(
    typeof cacheStep.with?.path === 'string' && cacheStep.with.path.includes('.cargo/bin'),
    'the cache must cover ~/.cargo/bin, where cargo install places the stellar-cli binary'
  )
  const installIdx = job.steps.findIndex(
    (s) => typeof s.run === 'string' && s.run.includes('cargo install')
  )
  const cacheIdx = job.steps.indexOf(cacheStep)
  assert.ok(cacheIdx !== -1 && cacheIdx < installIdx, 'the cache step must run before the install step')

  const verifyStep = job.steps.find(
    (s) => typeof s.run === 'string' && s.run.includes('rustc --version')
  )
  assert.ok(verifyStep, 'soroban must have a toolchain-version verification step')
  assert.ok(
    !/rustc --version\s*&&/.test(verifyStep.run),
    'the verification step must not be a bare print (the old `a && b && c` form asserted nothing)'
  )
  // Both pins are read back out of the job rather than repeated as literals here. Repeating them
  // made this test a second place to edit on every bump -- and it went red for the bump itself
  // (1.91.0 -> 1.93.0, forced by stellar-cli 26.1.0's own declared MSRV) rather than for the drift
  // it exists to catch. Derived, it still fails on exactly what it always guarded: a verify step
  // that greps a version the job doesn't actually install.
  const toolchainStep = job.steps.find(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('dtolnay/rust-toolchain@')
  )
  assert.ok(toolchainStep, 'soroban must install Rust via an exactly pinned dtolnay/rust-toolchain')
  const rustPin = toolchainStep.uses.split('@')[1]
  assert.match(rustPin, /^\d+\.\d+\.\d+$/, 'the Rust toolchain pin must be exact, never a channel')
  const cliPin = job.steps[installIdx].run.match(/--version\s+(\d+\.\d+\.\d+)/)?.[1]
  assert.ok(cliPin, 'the stellar-cli install must pin an exact version')
  // Per line, not over the whole script: a substring search across the whole `run` block passes as
  // long as ANY line mentions the pin, so a single drifted grep (rustc checked against a version
  // the job never installs, while the cargo line still carries the right one) slipped through.
  const verifyLines = verifyStep.run
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const [tool, pin] of [
    ['rustc', rustPin],
    ['cargo', rustPin],
    ['stellar', cliPin],
  ]) {
    const line = verifyLines.find((l) => l.startsWith(`${tool} --version`))
    assert.ok(line, `the verification step must check \`${tool} --version\``)
    assert.ok(
      line.includes(pin),
      `\`${tool} --version\` must be grepped for the version this job actually installs (${pin}), got: ${line}`
    )
  }
  assert.ok(
    typeof cacheStep.with?.key === 'string' && cacheStep.with.key.includes(cliPin),
    'the cache key must carry the pinned stellar-cli version so a bump cannot restore a stale binary'
  )
})

test('workflow: release-gate verifies its own tooling (node --test) before or independently of gate evaluation', () => {
  const workflow = loadWorkflow()
  const releaseGate = workflow.jobs['release-gate']
  const steps = releaseGate.steps
  const selfTestIdx = steps.findIndex(
    (s) => typeof s.run === 'string' && s.run.includes('node --test') && s.run.includes('release-gate.test.mjs')
  )
  const evaluateIdx = steps.findIndex(
    (s) => typeof s.run === 'string' && s.run.includes('release-gate.mjs') && !s.run.includes('--test')
  )
  assert.ok(selfTestIdx !== -1, 'release-gate must run `node --test scripts/ci/release-gate.test.mjs`')
  assert.ok(evaluateIdx !== -1, 'release-gate must still evaluate the gate itself')
  assert.ok(selfTestIdx < evaluateIdx, 'the self-test must run before gate evaluation, so a broken workflow structure fails loudly')
})

// ---------------------------------------------------------------------------
// CLI (main()) coverage — the one code path CI actually executes. The pure
// evaluateReleaseGate() tests above never touch process.argv/env/exit wiring.
// ---------------------------------------------------------------------------

function runCli(env) {
  return spawnSync(process.execPath, [releaseGateScript], { env, encoding: 'utf8' })
}

test('CLI: exits 0 when all required jobs succeed (via NEEDS_CONTEXT)', () => {
  const needs = Object.fromEntries(REQUIRED_JOBS.map((job) => [job, { result: 'success' }]))
  const result = runCli({ ...process.env, NEEDS_CONTEXT: JSON.stringify(needs) })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /release-gate OK/)
})

test('CLI: exits non-zero when a required job did not succeed', () => {
  const needs = Object.fromEntries(REQUIRED_JOBS.map((job) => [job, { result: 'success' }]))
  needs.soroban = { result: 'failure' }
  const result = runCli({ ...process.env, NEEDS_CONTEXT: JSON.stringify(needs) })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release-gate FAILED/)
})

test('CLI: exits non-zero when NEEDS_CONTEXT is missing entirely', () => {
  const env = { ...process.env }
  delete env.NEEDS_CONTEXT
  const result = runCli(env)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no needs context provided/)
})

test('CLI: exits non-zero when NEEDS_CONTEXT is unparseable JSON', () => {
  const result = runCli({ ...process.env, NEEDS_CONTEXT: '{ not valid json' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /failed to parse needs context/)
})

test('CLI: the entrypoint guard actually runs main() (regression guard for the fileURLToPath fix)', () => {
  // A prior version compared `import.meta.url === \`file://${argv[1]}\`` directly, which is
  // false whenever the two sides encode differently (e.g. a space or non-ASCII char in the
  // path) — main() silently never runs and the process exits 0 with no output at all. Running
  // the real script as a subprocess (rather than importing it) is what actually exercises this
  // guard the way CI does.
  const needs = Object.fromEntries(REQUIRED_JOBS.map((job) => [job, { result: 'success' }]))
  const result = runCli({ ...process.env, NEEDS_CONTEXT: JSON.stringify(needs) })
  assert.notEqual(result.stdout.trim(), '', 'main() must actually run and print something')
})

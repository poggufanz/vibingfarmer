// RED-then-GREEN coverage for the release gate:
//   1. evaluateReleaseGate(needs) — the pure decision function the release-gate job runs.
//   2. Structural assertions against .github/workflows/frontend.yml itself, so the "always
//      triggered, nothing bypasses it" property is enforced by a real parse of the YAML
//      rather than a comment that claims it.
//
// No YAML parser is installed anywhere reachable from repo root (no root package.json /
// node_modules at all — confirmed before writing this). Rather than add a dependency for a
// handful of structural checks, this file carries a small hand-rolled parser for the exact
// GitHub Actions YAML subset this workflow is authored in (block mappings/sequences, plus the
// simple flow collections already used for `on.push` and `needs: [...]`). The workflow is kept
// inside that subset deliberately (no multi-line block scalars, no flow mappings that embed
// `${{ }}` expressions) so this parser can stay small and honest instead of a re-implementation
// of full YAML.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { evaluateReleaseGate, REQUIRED_JOBS } from './release-gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'frontend.yml')

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
    if (rest === '') {
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
// A plain `branches` restriction is fine — it selects *which* branch, it does not skip the
// workflow based on file paths or event subtype the way `types`/`paths-ignore` would.
const NARROWING_KEYS = ['types', 'paths', 'paths-ignore', 'branches-ignore', 'tags', 'tags-ignore']

function assertUnfiltered(trigger, label) {
  if (trigger === null || trigger === undefined) return // bare trigger — always unfiltered
  assert.equal(typeof trigger, 'object', `${label} trigger should be bare or a plain object`)
  for (const key of NARROWING_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(trigger, key),
      false,
      `${label} trigger must not use narrowing key "${key}"`
    )
  }
}

function findAllContinueOnError(node, hits = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAllContinueOnError(item, hits)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'continue-on-error') hits.push(value)
      findAllContinueOnError(value, hits)
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
  assertUnfiltered(workflow.on.push, 'push')
  assertUnfiltered(workflow.on.pull_request, 'pull_request')
  assertUnfiltered(workflow.on.merge_group, 'merge_group')
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

test('workflow: no blocking check anywhere retains continue-on-error: true', () => {
  const workflow = loadWorkflow()
  const hits = findAllContinueOnError(workflow.jobs)
  assert.deepEqual(
    hits.filter((v) => v === true),
    [],
    'no step in this workflow may use continue-on-error: true'
  )
})

test('workflow: release-gate needs exactly the five required jobs and runs with if: always()', () => {
  const workflow = loadWorkflow()
  const releaseGate = workflow.jobs['release-gate']
  assert.ok(releaseGate, 'jobs.release-gate must exist')
  assert.equal(releaseGate.if, 'always()')
  assert.ok(Array.isArray(releaseGate.needs), 'release-gate.needs must be a list')
  assert.deepEqual([...releaseGate.needs].sort(), [...REQUIRED_JOBS].sort())
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

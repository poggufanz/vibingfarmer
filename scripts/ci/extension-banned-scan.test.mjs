import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const scanner = path.join(here, 'extension-banned-scan.mjs')
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'vf-extension-scan-'))

after(() => rmSync(fixtureRoot, { force: true, recursive: true }))

function runScanner(target) {
  return spawnSync(process.execPath, [scanner, target], { encoding: 'utf8' })
}

test('clean extension directory exits 0', () => {
  const target = path.join(fixtureRoot, 'clean')
  mkdirSync(path.join(target, 'assets'), { recursive: true })
  writeFileSync(path.join(target, 'index.js'), 'console.log("extension ready")\n')
  writeFileSync(path.join(target, 'assets', 'styles.css'), '@font-face { font-family: local; }\n')

  const result = runScanner(target)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /extension scan OK/)
})

test('a banned extension string exits 1 with a useful diagnostic', () => {
  const target = path.join(fixtureRoot, 'banned')
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, 'index.js'), 'window.executeAgentDeposit()\n')

  const result = runScanner(target)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /executeAgentDeposit/)
  assert.match(result.stderr, /index\.js/)
})

test('an unreadable scan target fails closed with exit 2', () => {
  const target = path.join(fixtureRoot, 'does-not-exist')

  const result = runScanner(target)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /extension scan ERROR/)
})

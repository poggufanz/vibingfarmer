import { describe, it, expect } from 'vitest'
import {
  computeRelativePath,
  fingerprintKey,
  parseFingerprintKey,
  buildFingerprints,
  loadBaseline,
  serializeBaseline,
  compareToBaseline,
  assertUpdateAllowed,
} from './eslintWarningBaseline.mjs'

// Fake ESLint `LintResult[]` shape — only the fields our code reads (filePath, messages[]).
function fakeResult(absPath, messages) {
  return { filePath: absPath, messages }
}

function warn(ruleId, messageId, message) {
  return { severity: 1, ruleId, messageId, message }
}

function err(ruleId, message) {
  return { severity: 2, ruleId, messageId: null, message }
}

describe('computeRelativePath', () => {
  it('is location-independent — same repo-relative path regardless of the absolute root', () => {
    const a = computeRelativePath(
      '/home/alice/repo/frontend/src/App.jsx',
      '/home/alice/repo/frontend'
    )
    const b = computeRelativePath(
      '/ci/runner/work/repo/frontend/src/App.jsx',
      '/ci/runner/work/repo/frontend'
    )
    expect(a).toBe('src/App.jsx')
    expect(b).toBe('src/App.jsx')
  })

  it('always uses forward slashes', () => {
    const p = computeRelativePath(
      '/root/frontend/src/components/Nested/Thing.jsx',
      '/root/frontend'
    )
    expect(p).not.toMatch(/\\/)
    expect(p).toBe('src/components/Nested/Thing.jsx')
  })
})

describe('fingerprintKey / parseFingerprintKey', () => {
  it('round-trips relativePath, ruleId, messageId, message', () => {
    const fp = {
      relativePath: 'src/App.jsx',
      ruleId: 'no-unused-vars',
      messageId: 'unusedVar',
      message: "'x' is defined but never used.",
    }
    const key = fingerprintKey(fp)
    expect(parseFingerprintKey(key)).toEqual(fp)
  })

  it('does not encode line/column — two messages differing only by location share a fingerprint', () => {
    const fpAtLine1 = {
      relativePath: 'src/App.jsx',
      ruleId: 'no-console',
      messageId: null,
      message: 'Unexpected console statement.',
    }
    const fpAtLine2 = {
      relativePath: 'src/App.jsx',
      ruleId: 'no-console',
      messageId: null,
      message: 'Unexpected console statement.',
    }
    expect(fingerprintKey(fpAtLine1)).toBe(fingerprintKey(fpAtLine2))
  })
})

describe('buildFingerprints', () => {
  const root = '/repo/frontend'

  it('counts warnings by fingerprint and reports total warnings', () => {
    const results = [
      fakeResult('/repo/frontend/src/a.js', [
        warn('no-console', null, 'Unexpected console statement.'),
      ]),
      fakeResult('/repo/frontend/src/b.js', [
        warn('no-unused-vars', 'unusedVar', "'y' is defined but never used."),
        warn('no-unused-vars', 'unusedVar', "'y' is defined but never used."), // same fingerprint, twice in one file
      ]),
    ]
    const { counts, errorCount, totalWarnings } = buildFingerprints(results, root)
    expect(errorCount).toBe(0)
    expect(totalWarnings).toBe(3)
    expect(counts.size).toBe(2) // two distinct fingerprints
    const dupKey = fingerprintKey({
      relativePath: 'src/b.js',
      ruleId: 'no-unused-vars',
      messageId: 'unusedVar',
      message: "'y' is defined but never used.",
    })
    expect(counts.get(dupKey)).toBe(2)
  })

  it('counts errors (severity 2) separately and excludes them from warning fingerprints', () => {
    const results = [
      fakeResult('/repo/frontend/src/a.js', [err('no-undef', "'x' is not defined.")]),
    ]
    const { counts, errorCount, totalWarnings } = buildFingerprints(results, root)
    expect(errorCount).toBe(1)
    expect(totalWarnings).toBe(0)
    expect(counts.size).toBe(0)
  })

  it('handles a clean file with zero messages', () => {
    const results = [fakeResult('/repo/frontend/src/clean.js', [])]
    const { counts, errorCount, totalWarnings } = buildFingerprints(results, root)
    expect(errorCount).toBe(0)
    expect(totalWarnings).toBe(0)
    expect(counts.size).toBe(0)
  })
})

describe('loadBaseline / serializeBaseline', () => {
  it('round-trips a counts map through JSON', () => {
    const counts = new Map()
    counts.set(
      fingerprintKey({
        relativePath: 'src/a.js',
        ruleId: 'no-console',
        messageId: null,
        message: 'm',
      }),
      2
    )
    counts.set(
      fingerprintKey({
        relativePath: 'src/b.js',
        ruleId: 'no-unused-vars',
        messageId: 'unusedVar',
        message: 'm2',
      }),
      1
    )
    const json = serializeBaseline(counts)
    const loaded = loadBaseline(json)
    expect(loaded).toEqual(counts)
  })

  it('produces deterministic (sorted) output so repeated updates do not thrash the diff', () => {
    const counts = new Map()
    counts.set(
      fingerprintKey({
        relativePath: 'src/z.js',
        ruleId: 'no-console',
        messageId: null,
        message: 'm',
      }),
      1
    )
    counts.set(
      fingerprintKey({
        relativePath: 'src/a.js',
        ruleId: 'no-console',
        messageId: null,
        message: 'm',
      }),
      1
    )
    const json1 = serializeBaseline(counts)
    const json2 = serializeBaseline(new Map([...counts].reverse()))
    expect(json1).toBe(json2)
  })
})

describe('compareToBaseline', () => {
  function baselineOf(entries) {
    const map = new Map()
    for (const [fp, count] of entries) map.set(fingerprintKey(fp), count)
    return map
  }

  const fpA = {
    relativePath: 'src/a.js',
    ruleId: 'no-console',
    messageId: null,
    message: 'Unexpected console statement.',
  }
  const fpB = {
    relativePath: 'src/b.js',
    ruleId: 'no-unused-vars',
    messageId: 'unusedVar',
    message: "'y' is defined but never used.",
  }

  it('passes when current warnings exactly match the baseline', () => {
    const baseline = baselineOf([
      [fpA, 2],
      [fpB, 1],
    ])
    const current = new Map(baseline)
    const { additions } = compareToBaseline(current, baseline)
    expect(additions).toEqual([])
  })

  it('a brand-new fingerprint not present in the baseline is an addition', () => {
    const baseline = baselineOf([[fpA, 2]])
    const current = baselineOf([
      [fpA, 2],
      [fpB, 1],
    ])
    const { additions } = compareToBaseline(current, baseline)
    expect(additions.length).toBe(1)
    expect(additions[0].relativePath).toBe('src/b.js')
  })

  it('multiplicity: more occurrences of an already-known fingerprint is still an addition', () => {
    const baseline = baselineOf([[fpA, 2]])
    const current = baselineOf([[fpA, 3]])
    const { additions } = compareToBaseline(current, baseline)
    expect(additions.length).toBe(1)
    expect(additions[0].delta).toBe(1)
  })

  it('removals pass — fewer occurrences, or the fingerprint vanishing entirely, is fine', () => {
    const baseline = baselineOf([
      [fpA, 2],
      [fpB, 1],
    ])
    const current = baselineOf([[fpA, 1]]) // fpA reduced, fpB gone entirely
    const { additions } = compareToBaseline(current, baseline)
    expect(additions).toEqual([])
  })
})

describe('assertUpdateAllowed', () => {
  it('refuses to run when CI=true', () => {
    expect(() => assertUpdateAllowed({ CI: 'true' })).toThrow()
  })

  it('allows running when CI is unset or falsy', () => {
    expect(() => assertUpdateAllowed({})).not.toThrow()
    expect(() => assertUpdateAllowed({ CI: 'false' })).not.toThrow()
  })
})

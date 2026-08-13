import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOUNDATION_FILES,
  runFoundationCheck,
  scanFoundationSource,
} from '../../scripts/check-pocket-crew-foundation.mjs'

const FRONTEND_ROOT = resolve(import.meta.dirname, '../..')

const findingCodes = (source, path = 'fixture.css') =>
  scanFoundationSource(source, path).map(({ code }) => code)

describe('Pocket Crew Primary Foundation boundary', () => {
  it('owns exactly the ten Foundation files and excludes route, Landing, console, and wallet CSS', () => {
    expect(FOUNDATION_FILES.map(([name]) => name)).toEqual([
      'pocket-crew.css',
      'pocket-crew-contract.js',
      'pocket-crew-foundation.js',
      'BrandLockup.jsx',
      'NetworkIdentity.jsx',
      'AgentMark.jsx',
      'Primitives.jsx',
      'RouteFocus.jsx',
      'components.jsx',
      'app.jsx',
    ])

    const paths = FOUNDATION_FILES.map(([, path]) => path.replaceAll('\\', '/'))
    expect(paths).toHaveLength(10)
    expect(
      paths.some((path) => /(?:\/strategy\/|\/my-money\/|\/crew\/)[^/]+\.css$/u.test(path))
    ).toBe(false)
    expect(
      paths.some((path) => /Landing(?:Hero|Fx)|console\.css|extension\/.*\.css$/iu.test(path))
    ).toBe(false)
    expect(paths.some((path) => path.endsWith('.json'))).toBe(false)
  })

  it.each([
    ['literal z-index', 'z-index: 1000;', 'LAYER_LITERAL'],
    ['money monospace', '.pc-money { font-family: var(--pc-font-mono); }', 'MONEY_MONO'],
    [
      'JSX className money with quoted mono style',
      '<span className="pc-money" style={{ fontFamily: \'monospace\' }} />',
      'MONEY_MONO',
    ],
    [
      'MoneyFigure with quoted fontFamily mono style',
      "<MoneyFigure style={{ fontFamily: 'JetBrains Mono' }} />",
      'MONEY_MONO',
    ],
    [
      'MoneyFigure with quoted font-family mono style',
      "<MoneyFigure style={{ 'font-family': 'monospace' }} />",
      'MONEY_MONO',
    ],
    ['linear gradient', '.pc-card { background: linear-gradient(red, blue); }', 'RETIRED_EFFECT'],
    ['keyframes', '@keyframes pulse { from { opacity: 0; } }', 'RETIRED_EFFECT'],
    ['legacy palette scope', "[data-palette='mono-slate'] { color: red; }", 'LEGACY_SCOPE'],
    ['spacing fallback', '.pc-card { padding: var(--pc-space-4, 1rem); }', 'RAW_SPACING'],
    ['unmanifested brand asset', "const src = '/brand/not-in-manifest.svg'", 'UNMANIFESTED_ASSET'],
    ['JSX quoted z-index', "<div style={{ zIndex: '1000' }} />", 'LAYER_LITERAL'],
    [
      'JSX quoted z-index with spacing/casing',
      "<div style={{ Z_INDEX: '1000' }} />",
      'LAYER_LITERAL',
    ],
    ['CSS token fallback z-index', 'z-index: var(--pc-z-dialog, 1000);', 'LAYER_LITERAL'],
  ])('reports %s with its deterministic code', (_label, source, code) => {
    expect(findingCodes(source)).toContain(code)
  })

  it('allows tokenized layers and numeric values that are not layer declarations', () => {
    expect(findingCodes('z-index: var(--pc-z-dialog);')).not.toContain('LAYER_LITERAL')
    expect(findingCodes('.pc-card { padding: 1000px; opacity: 1000; }')).not.toContain(
      'LAYER_LITERAL'
    )
  })

  it('does not treat unrelated JSX or prose strings as money/layer violations', () => {
    expect(findingCodes('<span className="label" style={{ fontFamily: "monospace" }} />')).toEqual(
      []
    )
    expect(
      findingCodes('<span className="not-pc-money" style={{ fontFamily: "monospace" }} />')
    ).toEqual([])
    expect(
      findingCodes(
        `const prose = '<span className="pc-money" style={{ fontFamily: "monospace", zIndex: "1000" }} />'`
      )
    ).toEqual([])
  })

  it('does not treat comments or quoted fixture text as active Foundation source', () => {
    const source = `
      /* z-index: 1000; linear-gradient(red, blue); @keyframes pulse {} */
      // [data-palette="mono-slate"] var(--pc-space-4, 1rem)
      const fixture = 'font-family: var(--pc-font-mono); z-index: 1000;'
    `
    expect(scanFoundationSource(source, 'fixture.js')).toEqual([])
  })

  it('passes the real Foundation tree and reports all ten files checked', () => {
    const result = runFoundationCheck({ root: FRONTEND_ROOT })

    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.filesChecked).toBe(10)
    expect(result.report).toContain('foundation files checked: 10')
  })

  it('reads the exact Foundation sources through the checker boundary', () => {
    for (const [, filePath] of FOUNDATION_FILES) {
      expect(readFileSync(filePath, 'utf8').length, filePath).toBeGreaterThan(0)
    }
  })
})

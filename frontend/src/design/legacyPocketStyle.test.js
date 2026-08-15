import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runWebCheck,
  WEB_EXCLUDED_PATHS,
  WEB_PRODUCTION_FILES,
} from '../../scripts/check-pocket-crew-web.mjs'
import {
  FOUNDATION_FILES,
  runFoundationCheck,
} from '../../scripts/check-pocket-crew-foundation.mjs'

const DESIGN_DIR = import.meta.dirname
const FRONTEND_ROOT = resolve(DESIGN_DIR, '../..')
const FOUNDATION_PATHS = FOUNDATION_FILES.map(([, path]) =>
  relative(FRONTEND_ROOT, path).replaceAll('\\', '/')
)

describe('Pocket Crew web scanner handoff', () => {
  it('runs the Foundation-owned check exactly once for all ten Foundation files', () => {
    const result = runFoundationCheck({ root: FRONTEND_ROOT })
    expect(result.ok, result.findings.map((finding) => finding.message).join('\n')).toBe(true)
    expect(result.filesChecked).toBe(10)
    expect(FOUNDATION_FILES).toHaveLength(10)
  })

  it('runs the Secondary web check for every non-Foundation production file', () => {
    const result = runWebCheck({ root: FRONTEND_ROOT })
    expect(result.ok, result.findings.map((finding) => finding.message).join('\n')).toBe(true)
    expect(result.filesChecked).toBe(WEB_PRODUCTION_FILES.length)
    expect(result.delegatedFoundationFiles).toEqual(FOUNDATION_PATHS)
  })

  it('keeps the two scanner boundaries disjoint and exclusions repo-root explicit', () => {
    const secondary = new Set(WEB_PRODUCTION_FILES)
    expect(FOUNDATION_PATHS.filter((path) => secondary.has(path))).toEqual([])
    expect(WEB_EXCLUDED_PATHS).toEqual(['frontend/src/wallet/**', 'frontend/extension/**'])
    expect(WEB_PRODUCTION_FILES.some((path) => path.includes('wallet'))).toBe(false)
    expect(WEB_PRODUCTION_FILES.some((path) => path.startsWith('extension/'))).toBe(false)
  })

  it('covers the landing sources through the same web inventory', () => {
    expect(WEB_PRODUCTION_FILES).toEqual(
      expect.arrayContaining([
        'src/components/LandingHero.css',
        'src/components/LandingHero.jsx',
        'src/components/LandingFx.jsx',
      ])
    )
  })
})

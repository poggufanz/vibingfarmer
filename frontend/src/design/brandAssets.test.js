// @vitest-environment jsdom
//
// Asset-contract tests for the Pocket Crew product mark (Foundation Task 3).
// These assert the *shape* of the brand asset system — file existence, SVG
// hygiene, raster dimensions, and manifest bookkeeping — not pixel content.
// Visual correctness (silhouette legible, V/slash distinct) is checked by the
// programmatic QA pass in the task report, not by this suite.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOUNDATION_ASSET_PATHS,
  assertFoundationAssetManifest,
  getFoundationAsset,
} from './brandAssets.js'
import { getNetworkMeta } from './networks.js'

const FRONTEND_DIR = resolve(import.meta.dirname, '../..')
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public')
const MANIFEST_PATH = resolve(PUBLIC_DIR, 'brand/assets.manifest.json')
const MANIFEST_PUBLIC_PATH = '/brand/assets.manifest.json'
const BUILD_SCRIPT = resolve(FRONTEND_DIR, 'scripts/build-brand-assets.mjs')
const CHECK_SCRIPT = resolve(FRONTEND_DIR, 'scripts/check-brand-assets.mjs')

const BUILDER_OWNED_PATHS = [
  '/brand/vibing-farmer-mark.svg',
  '/brand/vibing-farmer-mark-forest.svg',
  '/brand/vibing-farmer-mark-day.svg',
  '/brand/vibing-farmer-mark-mono.svg',
  '/brand/vibing-farmer-lockup-forest.svg',
  '/brand/vibing-farmer-lockup-day.svg',
  '/brand/vibing-farmer-lockup-mono.svg',
  '/brand/favicon.svg',
  '/brand/agents/sprout.svg',
  '/brand/agents/clover.svg',
  '/brand/agents/mochi.svg',
  '/brand/icon-192.png',
  '/brand/icon-512.png',
  '/brand/apple-touch-icon.png',
  '/brand/social-card.png',
]

const BUILDER_OUTPUT_PATHS = [
  '/brand/icon-192.png',
  '/brand/icon-512.png',
  '/brand/apple-touch-icon.png',
  '/brand/social-card.png',
  '/vibing_farmer.logo.svg',
  '/vibing_farmer.logo.png',
]

// Fixed pocket body path — must appear byte-identical in every mark variant.
// No chat tail, face, leaf, coin, gradient, blur, or network symbol allowed
// alongside it.
const POCKET_D = 'M8 11H21L25 17H39L43 11H56V50C56 55 52 59 47 59H17C12 59 8 55 8 50Z'

// V stays byte-identical; the slash was moved off it (geometry revision — the
// old slash's center-line was 10/sqrt(5) ~= 4.47 units from the V's right
// leg, overlapping by ~0.53 at the fixed 5px stroke width (2.5px half-width
// each side); the new slash's center-line is 14/sqrt(5) ~= 6.26 units away,
// clearing by ~1.26).
const V_D = 'M18 24L31 48L43 24'
const OLD_SLASH_D = 'M38 44L50 20'
const SLASH_D = 'M40 44L52 20'

// Stellar ships two SDF-approved fills (Black + White) of the SAME icon —
// geometry must never drift between them, only the fill.
const STELLAR_BLACK_PATH = 'brand/networks/stellar.svg'
const STELLAR_WHITE_PATH = 'brand/networks/stellar-white.svg'

// The compact mark family — every one of these is a 64x64 transparent canvas
// carrying the same fixed pocket/V/slash geometry, recolored per theme.
const MARK_FILES = [
  'brand/vibing-farmer-mark.svg',
  'brand/vibing-farmer-mark-forest.svg',
  'brand/vibing-farmer-mark-day.svg',
  'brand/vibing-farmer-mark-mono.svg',
  'brand/favicon.svg',
]

const LOCKUP_FILES = [
  'brand/vibing-farmer-lockup-forest.svg',
  'brand/vibing-farmer-lockup-day.svg',
  'brand/vibing-farmer-lockup-mono.svg',
]

const ALL_SVG_FILES = [...MARK_FILES, ...LOCKUP_FILES]

const RASTER_EXPECTATIONS = [
  ['brand/icon-192.png', 192, 192],
  ['brand/icon-512.png', 512, 512],
  ['brand/apple-touch-icon.png', 180, 180],
  ['brand/social-card.png', 1200, 630],
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Minimal PNG IHDR reader: width/height live at bytes 16-24 of any valid PNG.
function readPngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function snapshotFiles(paths) {
  return paths.map((path) => {
    const filePath = resolve(PUBLIC_DIR, path.replace(/^\//, ''))
    const stat = statSync(filePath, { bigint: true })
    return {
      path,
      bytes: readFileSync(filePath),
      mtimeNs: stat.mtimeNs,
    }
  })
}

function restoreFiles(snapshots) {
  const currentByPath = new Map(
    snapshotFiles(snapshots.map(({ path }) => path)).map((entry) => [entry.path, entry])
  )
  for (const { path, bytes, mtimeNs } of snapshots) {
    const filePath = resolve(PUBLIC_DIR, path.replace(/^\//, ''))
    const current = currentByPath.get(path)
    if (current && current.mtimeNs === mtimeNs && Buffer.compare(current.bytes, bytes) === 0) {
      continue
    }
    writeFileSync(filePath, bytes)
    const mtimeMs = Number(mtimeNs / 1_000_000n)
    utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
  }
}

describe('brand asset contract', () => {
  it('closes the five foundation assets with matching hashes and provenance', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

    expect(FOUNDATION_ASSET_PATHS).toEqual([
      '/brand/vibing-farmer-mark-forest.svg',
      '/brand/vibing-farmer-mark-day.svg',
      '/brand/vibing-farmer-mark-mono.svg',
      '/brand/networks/stellar.svg',
      '/brand/networks/base.svg',
    ])
    expect(assertFoundationAssetManifest(manifest, FOUNDATION_ASSET_PATHS)).toBe(true)

    for (const path of FOUNDATION_ASSET_PATHS) {
      const entry = getFoundationAsset(path, manifest)
      expect(entry, path).toEqual(
        expect.objectContaining({
          path,
          kind: expect.any(String),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          source: expect.any(String),
          sourceUrl: expect.any(String),
          retrievedAt: expect.any(String),
          trademarkTreatment: expect.any(String),
        })
      )
      const filePath = resolve(PUBLIC_DIR, path.replace(/^\//, ''))
      expect(sha256(readFileSync(filePath)), path).toBe(entry.sha256)
    }
  })

  it('rejects foundation entries missing sha256, sourceUrl, or trademarkTreatment with the asset path', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const targetPath = FOUNDATION_ASSET_PATHS[0]

    for (const field of ['sha256', 'sourceUrl', 'trademarkTreatment']) {
      const mutated = manifest.map((entry) => {
        if (entry.path !== targetPath) return entry
        const copy = { ...entry }
        delete copy[field]
        return copy
      })

      expect(
        () => assertFoundationAssetManifest(mutated, FOUNDATION_ASSET_PATHS),
        `missing ${field}`
      ).toThrow(new RegExp(targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  it.each([
    ['/brand/networks/stellar.svg', 'unrelated'],
    [FOUNDATION_ASSET_PATHS[0], 'foundation'],
  ])('rejects duplicate %s manifest records with a path-named error (%s)', (path) => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const entry = manifest.find((candidate) => candidate.path === path)
    expect(entry, `fixture must include ${path}`).toBeTruthy()

    expect(() =>
      assertFoundationAssetManifest([...manifest, { ...entry }], FOUNDATION_ASSET_PATHS)
    ).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('every manifest path exists on disk', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    expect(Array.isArray(manifest)).toBe(true)
    expect(manifest.length).toBeGreaterThan(0)
    for (const entry of manifest) {
      const filePath = resolve(PUBLIC_DIR, entry.path.replace(/^\//, ''))
      expect(existsSync(filePath), `${entry.path} should exist`).toBe(true)
    }
  })

  it('every SVG declares a viewBox, carries no external image/base64 payload, and parses as XML', () => {
    for (const rel of ALL_SVG_FILES) {
      const content = readFileSync(resolve(PUBLIC_DIR, rel), 'utf8')
      expect(content, rel).toMatch(/viewBox="[^"]+"/)
      expect(content, rel).not.toMatch(/<image[\s>]/i)
      expect(content, rel).not.toMatch(/base64/i)
      const doc = new DOMParser().parseFromString(content, 'image/svg+xml')
      expect(doc.querySelector('parsererror'), rel).toBeNull()
    }
  })

  it('the compact mark and favicon use viewBox="0 0 64 64"', () => {
    for (const rel of MARK_FILES) {
      const content = readFileSync(resolve(PUBLIC_DIR, rel), 'utf8')
      expect(content, rel).toMatch(/viewBox="0 0 64 64"/)
    }
  })

  it('PNG rasters are exactly the required dimensions', () => {
    for (const [rel, width, height] of RASTER_EXPECTATIONS) {
      const buffer = readFileSync(resolve(PUBLIC_DIR, rel))
      expect(readPngSize(buffer), rel).toEqual({ width, height })
    }
  })

  it('computed SHA-256 matches every manifest entry', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    for (const entry of manifest) {
      const buffer = readFileSync(resolve(PUBLIC_DIR, entry.path.replace(/^\//, '')))
      expect(sha256(buffer), `${entry.path} hash drifted from manifest`).toBe(entry.sha256)
    }
  })

  it('the manifest records kind, source, sourceUrl, retrievedAt, and trademark treatment', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    for (const entry of manifest) {
      expect(typeof entry.kind, entry.path).toBe('string')
      expect(entry.kind.length, entry.path).toBeGreaterThan(0)
      expect(typeof entry.source, entry.path).toBe('string')
      expect(entry.source.length, entry.path).toBeGreaterThan(0)
      expect(typeof entry.sourceUrl, entry.path).toBe('string')
      // Frozen per the Pocket Crew redesign build — every asset in this wave
      // was authored/rendered on the same date, never network-fetched.
      expect(entry.retrievedAt, entry.path).toBe('2026-07-22')
      expect(typeof entry.trademarkTreatment, entry.path).toBe('string')
      expect(entry.trademarkTreatment.length, entry.path).toBeGreaterThan(0)
    }
  })

  it('the product mark contains the fixed pocket body and no agent-tail path/class', () => {
    for (const rel of MARK_FILES) {
      const content = readFileSync(resolve(PUBLIC_DIR, rel), 'utf8')
      expect(content, rel).toContain(POCKET_D)
      expect(content, rel).not.toMatch(/tail/i)
    }
  })

  it('the legacy compatibility SVG hashes to the current compact mark content', () => {
    const legacy = readFileSync(resolve(PUBLIC_DIR, 'vibing_farmer.logo.svg'))
    const mark = readFileSync(resolve(PUBLIC_DIR, 'brand/vibing-farmer-mark.svg'))
    expect(sha256(legacy)).toBe(sha256(mark))
  })

  it('the pocket and V are unchanged and the Harvest slash uses the separated geometry', () => {
    for (const rel of ALL_SVG_FILES) {
      const content = readFileSync(resolve(PUBLIC_DIR, rel), 'utf8')
      expect(content, rel).toContain(V_D)
      expect(content, rel).toContain(SLASH_D)
      expect(content, rel).not.toContain(OLD_SLASH_D)
    }
  })

  it('the Stellar Black and White marks share identical geometry — only the fill differs', () => {
    const black = readFileSync(resolve(PUBLIC_DIR, STELLAR_BLACK_PATH), 'utf8')
    const white = readFileSync(resolve(PUBLIC_DIR, STELLAR_WHITE_PATH), 'utf8')
    const viewBoxOf = (s) => s.match(/viewBox="([^"]+)"/)[1]
    const pathsOf = (s) => [...s.matchAll(/<path\b[^>]*\sd="([^"]+)"[^>]*>/g)].map((m) => m[1])
    const fillsOf = (s) => [...s.matchAll(/<path\b[^>]*\sfill="([^"]+)"/g)].map((m) => m[1])

    expect(viewBoxOf(white)).toBe(viewBoxOf(black))
    expect(pathsOf(white)).toEqual(pathsOf(black))
    expect(pathsOf(black).length).toBeGreaterThan(0)
    expect(fillsOf(black)).toEqual(['#000000', '#000000'])
    expect(fillsOf(white)).toEqual(['#FFFFFF', '#FFFFFF'])
  })

  it('brand:build preserves every manifest entry it does not generate (no clobber)', () => {
    const before = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const unrelatedBefore = before.filter((entry) => !BUILDER_OWNED_PATHS.includes(entry.path))
    expect(
      unrelatedBefore.length,
      'fixture assumes hand-recorded unrelated entries exist'
    ).toBeGreaterThan(0)

    execFileSync('node', [BUILD_SCRIPT], { cwd: FRONTEND_DIR })

    const after = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    expect(after.length).toBe(before.length)
    expect(after.map((e) => e.path).sort()).toEqual(before.map((e) => e.path).sort())
    // Preserved verbatim — the build script doesn't own these files, so it must
    // not recompute/rewrite any unrelated manifest entry even if the file is unchanged.
    expect(after.filter((entry) => !BUILDER_OWNED_PATHS.includes(entry.path))).toEqual(
      unrelatedBefore
    )
  })

  it.each([
    ['an object', '{}\n'],
    ['null', 'null\n'],
  ])(
    'brand:build rejects a valid non-array manifest (%s) before writing any output',
    (_label, invalidManifest) => {
      const originalManifest = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]
      const outputBefore = snapshotFiles(BUILDER_OUTPUT_PATHS)
      try {
        writeFileSync(MANIFEST_PATH, invalidManifest)
        const invalidManifestSnapshot = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]

        expect(() =>
          execFileSync('node', [BUILD_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
        ).toThrow()
        expect(snapshotFiles([MANIFEST_PUBLIC_PATH])).toEqual([invalidManifestSnapshot])
        expect(snapshotFiles(BUILDER_OUTPUT_PATHS)).toEqual(outputBefore)
      } finally {
        restoreFiles([originalManifest])
        restoreFiles(outputBefore)
        expect(readFileSync(MANIFEST_PATH)).toEqual(originalManifest.bytes)
      }
    }
  )

  it.each([
    ['null entry', [null]],
    ['primitive entry', ['not-an-entry']],
    ['non-array object', {}],
    ['empty path', [{ path: '' }]],
    ['non-string path', [{ path: 123 }]],
  ])(
    'brand:build rejects malformed manifest entries (%s) before writing any output',
    (_label, invalidManifest) => {
      const originalManifest = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]
      const outputBefore = snapshotFiles(BUILDER_OUTPUT_PATHS)
      const invalidBytes = Buffer.from(`${JSON.stringify(invalidManifest, null, 2)}\n`)
      try {
        writeFileSync(MANIFEST_PATH, invalidBytes)
        const invalidManifestSnapshot = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]

        expect(() =>
          execFileSync('node', [BUILD_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
        ).toThrow()
        expect(snapshotFiles([MANIFEST_PUBLIC_PATH])).toEqual([invalidManifestSnapshot])
        expect(snapshotFiles(BUILDER_OUTPUT_PATHS)).toEqual(outputBefore)
      } finally {
        restoreFiles([originalManifest])
        restoreFiles(outputBefore)
        expect(readFileSync(MANIFEST_PATH)).toEqual(originalManifest.bytes)
      }
    }
  )

  it.each([
    [
      'duplicate unrelated path',
      (manifest) => [
        ...manifest,
        { ...manifest.find((entry) => !BUILDER_OWNED_PATHS.includes(entry.path)) },
      ],
    ],
    [
      'duplicate generated path',
      (manifest) => [
        ...manifest,
        { ...manifest.find((entry) => BUILDER_OWNED_PATHS.includes(entry.path)) },
      ],
    ],
  ])('brand:build rejects %s before writing any output', (_label, mutateManifest) => {
    const originalManifest = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]
    const outputBefore = snapshotFiles(BUILDER_OUTPUT_PATHS)
    const manifest = JSON.parse(originalManifest.bytes.toString('utf8'))
    const invalidBytes = Buffer.from(`${JSON.stringify(mutateManifest(manifest), null, 2)}\n`)
    try {
      writeFileSync(MANIFEST_PATH, invalidBytes)
      const invalidManifestSnapshot = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]

      expect(() =>
        execFileSync('node', [BUILD_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
      ).toThrow()
      expect(snapshotFiles([MANIFEST_PUBLIC_PATH])).toEqual([invalidManifestSnapshot])
      expect(snapshotFiles(BUILDER_OUTPUT_PATHS)).toEqual(outputBefore)
    } finally {
      restoreFiles([originalManifest])
      restoreFiles(outputBefore)
      expect(readFileSync(MANIFEST_PATH)).toEqual(originalManifest.bytes)
    }
  })

  it('brand:check fails when a public/brand file has no manifest entry', () => {
    const strayPath = resolve(PUBLIC_DIR, 'brand/__test-stray-no-manifest-entry.svg')
    writeFileSync(strayPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
    try {
      expect(() =>
        execFileSync('node', [CHECK_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
      ).toThrow()
    } finally {
      rmSync(strayPath, { force: true })
    }
  })

  it('brand:check rejects a duplicate foundation manifest path and names the path', () => {
    const originalManifest = snapshotFiles([MANIFEST_PUBLIC_PATH])[0]
    const manifest = JSON.parse(originalManifest.bytes.toString('utf8'))
    const targetPath = FOUNDATION_ASSET_PATHS[0]
    const entry = manifest.find((candidate) => candidate.path === targetPath)
    expect(entry, `fixture must include ${targetPath}`).toBeTruthy()
    writeFileSync(MANIFEST_PATH, `${JSON.stringify([...manifest, { ...entry }], null, 2)}\n`)

    try {
      let thrown
      try {
        execFileSync('node', [CHECK_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeTruthy()
      expect(thrown.stderr.toString()).toContain(targetPath)
    } finally {
      restoreFiles([originalManifest])
    }
  })

  it('unknown future networks remain visible as Unknown network without a mark', () => {
    expect(getNetworkMeta('future-chain')).toMatchObject({
      label: 'Unknown network',
      markPath: null,
    })
  })
})

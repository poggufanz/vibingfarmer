// @vitest-environment jsdom
//
// Asset-contract tests for the Pocket Crew product mark (Foundation Task 3).
// These assert the *shape* of the brand asset system — file existence, SVG
// hygiene, raster dimensions, and manifest bookkeeping — not pixel content.
// Visual correctness (silhouette legible, V/slash distinct) is checked by the
// programmatic QA pass in the task report, not by this suite.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_DIR = resolve(import.meta.dirname, '../..')
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public')
const MANIFEST_PATH = resolve(PUBLIC_DIR, 'brand/assets.manifest.json')
const BUILD_SCRIPT = resolve(FRONTEND_DIR, 'scripts/build-brand-assets.mjs')
const CHECK_SCRIPT = resolve(FRONTEND_DIR, 'scripts/check-brand-assets.mjs')

// Fixed pocket body path — must appear byte-identical in every mark variant.
// No chat tail, face, leaf, coin, gradient, blur, or network symbol allowed
// alongside it.
const POCKET_D = 'M8 11H21L25 17H39L43 11H56V50C56 55 52 59 47 59H17C12 59 8 55 8 50Z'

// V stays byte-identical; the slash was moved off it (geometry revision —
// the old slash overlapped the V's right leg by ~0.53 unit at the fixed
// 5px stroke width, new gap is 5.36 units).
const V_D = 'M18 24L31 48L43 24'
const OLD_SLASH_D = 'M38 44L50 20'
const SLASH_D = 'M40 44L52 20'

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

describe('brand asset contract', () => {
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

  it('brand:build preserves manifest entries it does not generate (no clobber)', () => {
    const before = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const networkEntryBefore = before.find((e) => e.path === '/brand/networks/stellar.svg')
    expect(networkEntryBefore, 'fixture assumes a hand-recorded network entry exists').toBeTruthy()

    execFileSync('node', [BUILD_SCRIPT], { cwd: FRONTEND_DIR })

    const after = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    expect(after.length).toBe(14)
    expect(after.map((e) => e.path).sort()).toEqual(before.map((e) => e.path).sort())
    // Preserved verbatim — the build script doesn't own these files, so it must
    // not recompute/rewrite their manifest entry even if the file is unchanged.
    expect(after.find((e) => e.path === '/brand/networks/stellar.svg')).toEqual(networkEntryBefore)
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
})

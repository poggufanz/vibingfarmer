// Verifies the Pocket Crew brand assets committed under public/brand/ match
// their assets.manifest.json record — catches hash drift (someone edited a
// raster or SVG by hand without rebuilding) and raster dimension drift.
// Read-only: never rewrites assets. Exits non-zero on any mismatch.
//
// Run: `npm run brand:check` from frontend/.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FOUNDATION_ASSET_PATHS,
  assertFoundationAssetManifest,
} from '../src/design/brandAssets.js'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '../public')
const brandDir = resolve(publicDir, 'brand')
const manifestPath = resolve(brandDir, 'assets.manifest.json')

// Fixed expected pixel size per raster kind (icon-192.png etc. are named
// after their own dimension, but apple-touch-icon and social-card are not).
const RASTER_DIMENSIONS = {
  'icon-192': [192, 192],
  'icon-512': [512, 512],
  'apple-touch-icon': [180, 180],
  'social-card': [1200, 630],
}

const REQUIRED_FIELDS = [
  'path',
  'kind',
  'sha256',
  'source',
  'sourceUrl',
  'retrievedAt',
  'trademarkTreatment',
]

const FOUNDATION_MARK_PATHS = new Set(FOUNDATION_ASSET_PATHS.slice(0, 3))
const POCKET_D = 'M8 11H21L25 17H39L43 11H56V50C56 55 52 59 47 59H17C12 59 8 55 8 50Z'
const V_D = 'M18 24L31 48L43 24'
const SLASH_D = 'M40 44L52 20'
const OLD_SLASH_D = 'M38 44L50 20'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function readPngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const errors = []

if (!existsSync(manifestPath)) {
  console.error(`brand:check FAILED — missing manifest at ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (!Array.isArray(manifest) || manifest.length === 0) {
  console.error('brand:check FAILED — manifest is not a non-empty array')
  process.exit(1)
}

try {
  assertFoundationAssetManifest(manifest, FOUNDATION_ASSET_PATHS)
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error))
}

for (const entry of manifest) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push('(unknown path): manifest entry must be an object')
    continue
  }

  const entryPath = typeof entry.path === 'string' ? entry.path : ''
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      // sourceUrl may legitimately be empty (original artwork, no external source).
      if (field === 'sourceUrl' && typeof entry[field] === 'string') continue
      errors.push(`${entryPath || '(unknown path)'}: missing/empty required field "${field}"`)
    }
  }

  if (entryPath.length === 0) continue

  const filePath = resolve(publicDir, entryPath.replace(/^\//, ''))
  if (!existsSync(filePath)) {
    errors.push(`${entryPath}: file does not exist`)
    continue
  }

  const buffer = readFileSync(filePath)
  const actualHash = sha256(buffer)
  if (actualHash !== entry.sha256) {
    errors.push(`${entryPath}: sha256 drift (manifest ${entry.sha256}, actual ${actualHash})`)
  }

  if (entryPath.endsWith('.svg')) {
    const svg = buffer.toString('utf8')
    if (!/<svg\b[^>]*\bviewBox="[^"]+"/i.test(svg)) {
      errors.push(`${entryPath}: SVG must declare a viewBox`)
    }
    if (/<image[\s>]/i.test(svg) || /base64/i.test(svg)) {
      errors.push(`${entryPath}: SVG must not embed image/base64 payloads`)
    }
    if (FOUNDATION_MARK_PATHS.has(entryPath)) {
      for (const [label, geometry] of [
        ['pocket body', POCKET_D],
        ['V', V_D],
        ['Harvest slash', SLASH_D],
      ]) {
        if (!svg.includes(geometry)) {
          errors.push(`${entryPath}: missing fixed ${label} geometry`)
        }
      }
      if (svg.includes(OLD_SLASH_D)) {
        errors.push(`${entryPath}: uses retired Harvest slash geometry`)
      }
    }
  }

  if (entryPath.endsWith('.png')) {
    const expected = RASTER_DIMENSIONS[entry.kind]
    if (expected) {
      const { width, height } = readPngSize(buffer)
      const [expectedWidth, expectedHeight] = expected
      if (width !== expectedWidth || height !== expectedHeight) {
        errors.push(
          `${entryPath}: dimension drift (expected ${expectedWidth}x${expectedHeight}, actual ${width}x${height})`
        )
      }
    }
  }
}

// Every file actually sitting under public/brand/ (recursive — covers
// subdirectories like networks/) must have a manifest entry. This is what
// catches a future build-script clobber before it ships silently: an asset
// can exist on disk with nobody recording its provenance/hash.
const manifestPaths = new Set(manifest.map((entry) => entry.path))
const brandFiles = readdirSync(brandDir, { recursive: true, withFileTypes: true }).filter((d) =>
  d.isFile()
)
for (const dirent of brandFiles) {
  const filePath = resolve(dirent.parentPath ?? dirent.path, dirent.name)
  if (filePath === manifestPath) continue // the manifest doesn't need a self-entry
  const relPath = `/brand/${relative(brandDir, filePath).split(sep).join('/')}`
  if (!manifestPaths.has(relPath)) {
    errors.push(`${relPath}: file exists under public/brand/ but has no manifest entry`)
  }
}

// The legacy compatibility SVG must stay byte-identical to the compact mark
// it replaced — this is the one drift check that isn't manifest-driven.
const legacyPath = resolve(publicDir, 'vibing_farmer.logo.svg')
const markPath = resolve(publicDir, 'brand/vibing-farmer-mark.svg')
if (existsSync(legacyPath) && existsSync(markPath)) {
  const legacyHash = sha256(readFileSync(legacyPath))
  const markHash = sha256(readFileSync(markPath))
  if (legacyHash !== markHash) {
    errors.push('vibing_farmer.logo.svg: no longer matches brand/vibing-farmer-mark.svg')
  }
} else {
  errors.push('vibing_farmer.logo.svg or brand/vibing-farmer-mark.svg is missing')
}

if (errors.length > 0) {
  console.error(`brand:check FAILED — ${errors.length} issue(s):`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(`brand:check OK — ${manifest.length} manifest entries verified`)

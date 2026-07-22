// Verifies the Pocket Crew brand assets committed under public/brand/ match
// their assets.manifest.json record — catches hash drift (someone edited a
// raster or SVG by hand without rebuilding) and raster dimension drift.
// Read-only: never rewrites assets. Exits non-zero on any mismatch.
//
// Run: `npm run brand:check` from frontend/.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '../public')
const manifestPath = resolve(publicDir, 'brand/assets.manifest.json')

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

for (const entry of manifest) {
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      // sourceUrl may legitimately be empty (original artwork, no external source).
      if (field === 'sourceUrl' && typeof entry[field] === 'string') continue
      errors.push(`${entry.path ?? '(unknown)'}: missing/empty required field "${field}"`)
    }
  }

  const filePath = resolve(publicDir, String(entry.path).replace(/^\//, ''))
  if (!existsSync(filePath)) {
    errors.push(`${entry.path}: file does not exist`)
    continue
  }

  const buffer = readFileSync(filePath)
  const actualHash = sha256(buffer)
  if (actualHash !== entry.sha256) {
    errors.push(`${entry.path}: sha256 drift (manifest ${entry.sha256}, actual ${actualHash})`)
  }

  if (entry.path.endsWith('.png')) {
    const expected = RASTER_DIMENSIONS[entry.kind]
    if (expected) {
      const { width, height } = readPngSize(buffer)
      const [expectedWidth, expectedHeight] = expected
      if (width !== expectedWidth || height !== expectedHeight) {
        errors.push(
          `${entry.path}: dimension drift (expected ${expectedWidth}x${expectedHeight}, actual ${width}x${height})`
        )
      }
    }
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

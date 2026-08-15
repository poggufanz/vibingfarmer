import { FOUNDATION_ASSET_PATHS } from './pocket-crew-contract.js'

export { FOUNDATION_ASSET_PATHS }

const REQUIRED_FIELDS = Object.freeze([
  'path',
  'kind',
  'sha256',
  'source',
  'sourceUrl',
  'retrievedAt',
  'trademarkTreatment',
])

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function pathLabel(path) {
  return typeof path === 'string' && path.length > 0 ? path : '(unknown path)'
}

function foundationAssetError(path, message) {
  return new Error(`Foundation asset ${pathLabel(path)}: ${message}`)
}

function assertManifestEntry(entry, expectedPath) {
  const path = entry && typeof entry === 'object' ? (entry.path ?? expectedPath) : expectedPath

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw foundationAssetError(path, 'manifest entry must be an object')
  }

  for (const field of REQUIRED_FIELDS) {
    if (!hasOwn(entry, field) || typeof entry[field] !== 'string') {
      throw foundationAssetError(path, `missing/invalid required field "${field}"`)
    }

    // Original artwork is intentionally local and records sourceUrl as an empty string. Every
    // other provenance field must carry a non-empty value.
    if (field !== 'sourceUrl' && entry[field].trim().length === 0) {
      throw foundationAssetError(path, `missing/invalid required field "${field}"`)
    }
  }

  if (entry.path !== expectedPath) {
    throw foundationAssetError(expectedPath, `manifest entry path is ${pathLabel(entry.path)}`)
  }

  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw foundationAssetError(expectedPath, 'sha256 must be a lowercase 64-character hex digest')
  }

  return entry
}

function manifestEntries(manifest) {
  if (!Array.isArray(manifest)) {
    throw new Error('Foundation asset manifest must be an array')
  }
  return manifest
}

function assertManifestEntryPaths(entries) {
  const seen = new Set()
  for (const [index, entry] of entries.entries()) {
    const entryPath =
      entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.path : null
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw foundationAssetError(entryPath ?? `entry ${index}`, 'manifest entry must be an object')
    }
    if (
      !hasOwn(entry, 'path') ||
      typeof entry.path !== 'string' ||
      entry.path.trim().length === 0
    ) {
      throw foundationAssetError(
        entryPath || `entry ${index}`,
        'manifest entry path must be a non-empty string'
      )
    }
    if (seen.has(entry.path)) {
      throw foundationAssetError(entry.path, 'duplicate manifest path')
    }
    seen.add(entry.path)
  }
}

/**
 * Resolve one manifest-backed foundation asset without reading from the filesystem.
 *
 * @param {string} path
 * @param {Array<Record<string, unknown>>} manifest
 * @returns {Record<string, unknown>}
 */
export function getFoundationAsset(path, manifest) {
  if (typeof path !== 'string' || path.length === 0) {
    throw foundationAssetError(path, 'path must be a non-empty string')
  }

  const entry = manifestEntries(manifest).find(
    (candidate) => candidate && typeof candidate === 'object' && candidate.path === path
  )
  if (!entry) {
    throw foundationAssetError(path, 'manifest entry is missing')
  }

  return assertManifestEntry(entry, path)
}

/**
 * Assert that every requested foundation path has a complete provenance record.
 * Filesystem existence, content hashes, and SVG geometry are deliberately checked by Node-only
 * tests/scripts; this module remains safe to import from browser components.
 *
 * @param {Array<Record<string, unknown>>} manifest
 * @param {readonly string[]} [paths=FOUNDATION_ASSET_PATHS]
 * @returns {true}
 */
export function assertFoundationAssetManifest(manifest, paths = FOUNDATION_ASSET_PATHS) {
  const entries = manifestEntries(manifest)
  assertManifestEntryPaths(entries)
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('Foundation asset paths must be a non-empty array')
  }

  const seen = new Set()
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) {
      throw foundationAssetError(path, 'path must be a non-empty string')
    }
    if (seen.has(path)) {
      throw foundationAssetError(path, 'path is duplicated')
    }
    seen.add(path)
    getFoundationAsset(path, entries)
  }

  return true
}

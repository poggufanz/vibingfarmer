import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { experimental_readRawConfig } from 'wrangler'

// fileURLToPath (not .pathname): .pathname yields "/C:/..." on Windows and resolve() then
// produces "C:\C:\...", which breaks every local preview command on win32.
const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url))
const TRACKED_WRANGLER_CONFIG = resolve(SCRIPTS_DIR, '..', 'wrangler.jsonc')
const { rawConfig: TRACKED_RAW_CONFIG } = await experimental_readRawConfig({
  config: TRACKED_WRANGLER_CONFIG,
})
const productionBinding = TRACKED_RAW_CONFIG.d1_databases?.find(
  (entry) => entry.binding === 'VF_DB'
)
if (!productionBinding?.database_id) throw new Error('tracked production VF_DB binding is missing')
// Read the production ID from the same Wrangler binding used by migrations/deploys; a copied
// literal here could drift and let preview validation mistake production for a distinct database.
export const PRODUCTION_D1_DATABASE_ID = String(productionBinding.database_id).toLowerCase()
// Deliberately unprovisioned UUID-shaped value so Wrangler's schema accepts the local config;
// preview remote commands must reject it before invoking Wrangler until a real ID is supplied.
export const PREVIEW_D1_SENTINEL = '00000000-0000-4000-8000-000000000001'
const FRONTEND_DIR = resolve(SCRIPTS_DIR, '..')
export const PREVIEW_WRANGLER_CONFIG = resolve(
  FRONTEND_DIR,
  '.wrangler/deploy/vibing-farmer-preview.jsonc'
)
export const PREVIEW_WRANGLER_REDIRECT = resolve(FRONTEND_DIR, '.wrangler/deploy/config.json')

export async function readRuntimeConfig(config = 'wrangler.jsonc') {
  return experimental_readRawConfig({ config })
}

export function validatePreviewDatabaseId(value) {
  if (!value) return { ok: false, reason: 'missing' }
  const normalized = String(value).trim().toLowerCase()
  if (normalized === PREVIEW_D1_SENTINEL) return { ok: false, reason: 'sentinel' }
  if (normalized === PRODUCTION_D1_DATABASE_ID) return { ok: false, reason: 'production-id' }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true }
}

/** Materialize a preview-only config behind Wrangler's supported deploy redirect. */
export async function writePreviewConfig(
  target = PREVIEW_WRANGLER_CONFIG,
  redirectTarget = PREVIEW_WRANGLER_REDIRECT
) {
  const validation = validatePreviewDatabaseId(process.env.PREVIEW_D1_DATABASE_ID)
  if (!validation.ok) throw new Error(`preview D1 is not provisioned (${validation.reason})`)
  const sourcePath = TRACKED_WRANGLER_CONFIG
  const { rawConfig } = await experimental_readRawConfig({ config: sourcePath })
  const preview = rawConfig.env?.preview
  const binding = preview?.d1_databases?.find((entry) => entry.binding === 'VF_DB')
  if (!binding) throw new Error('preview VF_DB binding is missing')
  const databaseId = String(process.env.PREVIEW_D1_DATABASE_ID).trim().toLowerCase()
  binding.database_id = databaseId
  binding.preview_database_id = databaseId
  // Generated Wrangler deploy configs must already target one environment and contain no
  // `env` sections. Pages selects preview vs production from `--branch`, not `--env`.
  const generated = { ...rawConfig, ...preview }
  delete generated.env
  generated.pages_build_output_dir = relative(
    dirname(target),
    resolve(FRONTEND_DIR, rawConfig.pages_build_output_dir)
  )
  // Keep migration discovery anchored to the checkout rather than the generated config path.
  binding.migrations_dir = resolve(SCRIPTS_DIR, '..', 'migrations')
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(dirname(redirectTarget), { recursive: true })
  writeFileSync(target, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 })
  // POSIX separators: Wrangler resolves configPath against the redirect file's directory, and
  // forward slashes are valid on every platform — backslash literals would differ from CI.
  const redirectConfig = relative(dirname(redirectTarget), target).split('\\').join('/')
  writeFileSync(
    redirectTarget,
    `${JSON.stringify({ configPath: redirectConfig }, null, 2)}\n`,
    { mode: 0o600 }
  )
  return target
}

export function clearPreviewConfig(
  target = PREVIEW_WRANGLER_CONFIG,
  redirectTarget = PREVIEW_WRANGLER_REDIRECT
) {
  rmSync(target, { force: true })
  rmSync(redirectTarget, { force: true })
}

// basename (not endsWith('/runtime-config.mjs')): on win32 argv[1] uses backslashes, so the
// slash form never matches and every CLI command silently no-ops.
const INVOKED_AS_SCRIPT = basename(process.argv[1] ?? '') === 'runtime-config.mjs'

if (INVOKED_AS_SCRIPT && process.argv[2] === 'clear-preview-config') {
  clearPreviewConfig()
}

if (INVOKED_AS_SCRIPT && process.argv[2] === 'assert-preview-d1') {
  const result = validatePreviewDatabaseId(process.env.PREVIEW_D1_DATABASE_ID)
  if (!result.ok) {
    console.error(
      `preview D1 is not provisioned (${result.reason}); set PREVIEW_D1_DATABASE_ID before Wrangler`
    )
    process.exit(1)
  }
}

if (INVOKED_AS_SCRIPT && process.argv[2] === 'write-preview-config') {
  try {
    await writePreviewConfig()
  } catch (error) {
    console.error(error?.message || 'preview config unavailable')
    process.exit(1)
  }
}

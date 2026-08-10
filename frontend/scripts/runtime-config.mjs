import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { experimental_readRawConfig } from 'wrangler'

const TRACKED_WRANGLER_CONFIG = resolve(new URL('../wrangler.jsonc', import.meta.url).pathname)
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
export const PREVIEW_WRANGLER_CONFIG = '/tmp/vibing-farmer-wrangler-preview.jsonc'

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

/** Materialize a temporary preview config with the externally provisioned ID. */
export async function writePreviewConfig(target = PREVIEW_WRANGLER_CONFIG) {
  const validation = validatePreviewDatabaseId(process.env.PREVIEW_D1_DATABASE_ID)
  if (!validation.ok) throw new Error(`preview D1 is not provisioned (${validation.reason})`)
  const sourcePath = TRACKED_WRANGLER_CONFIG
  const { rawConfig } = await experimental_readRawConfig({ config: sourcePath })
  const preview = rawConfig.env?.preview
  const binding = preview?.d1_databases?.find((entry) => entry.binding === 'VF_DB')
  if (!binding) throw new Error('preview VF_DB binding is missing')
  binding.database_id = String(process.env.PREVIEW_D1_DATABASE_ID).trim().toLowerCase()
  // The temporary config lives under /tmp, so keep migration discovery anchored to the checkout.
  binding.migrations_dir = resolve(new URL('../migrations', import.meta.url).pathname)
  writeFileSync(target, `${JSON.stringify(rawConfig, null, 2)}\n`, { mode: 0o600 })
  return target
}

if (process.argv[1]?.endsWith('/runtime-config.mjs') && process.argv[2] === 'assert-preview-d1') {
  const result = validatePreviewDatabaseId(process.env.PREVIEW_D1_DATABASE_ID)
  if (!result.ok) {
    console.error(
      `preview D1 is not provisioned (${result.reason}); set PREVIEW_D1_DATABASE_ID before Wrangler`
    )
    process.exit(1)
  }
}

if (
  process.argv[1]?.endsWith('/runtime-config.mjs') &&
  process.argv[2] === 'write-preview-config'
) {
  try {
    await writePreviewConfig()
  } catch (error) {
    console.error(error?.message || 'preview config unavailable')
    process.exit(1)
  }
}

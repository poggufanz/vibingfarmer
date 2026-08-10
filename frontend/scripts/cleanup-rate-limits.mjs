import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(SCRIPT_DIR, '..')
const PRODUCTION_DATABASE_NAME = 'vf-gate'
const PRODUCTION_CONFIG = 'wrangler.jsonc'
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 1_000

function boundedInteger(raw, { name, fallback, min, max }) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function readCleanupConfig(env = process.env) {
  if (env.RATE_LIMIT_CLEANUP_ENV !== 'production') {
    throw new Error('rate-limit retention cleanup is production-only')
  }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('production cleanup requires Cloudflare credentials')
  }
  return {
    apiToken: String(env.CLOUDFLARE_API_TOKEN),
    accountId: String(env.CLOUDFLARE_ACCOUNT_ID),
    retentionMs: boundedInteger(env.VF_RATE_LIMIT_RETENTION_MS, {
      name: 'VF_RATE_LIMIT_RETENTION_MS',
      fallback: DEFAULT_RETENTION_MS,
      min: 60 * 60 * 1000,
      max: 365 * 24 * 60 * 60 * 1000,
    }),
    batchSize: boundedInteger(env.VF_RATE_LIMIT_CLEANUP_BATCH, {
      name: 'VF_RATE_LIMIT_CLEANUP_BATCH',
      fallback: DEFAULT_BATCH_SIZE,
      min: 1,
      max: MAX_BATCH_SIZE,
    }),
  }
}

export function buildCleanupSql({ cutoffMs, batchSize }) {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
    throw new Error('cleanup cutoff must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`cleanup batch must be between 1 and ${MAX_BATCH_SIZE}`)
  }
  // One invocation removes at most batchSize stale rows. The scheduled job repeats this bounded
  // operation; it never scans/deletes the whole table in one request or run.
  return `DELETE FROM vf_cross_rate_limits WHERE rowid IN (SELECT rowid FROM vf_cross_rate_limits WHERE updated_at_ms < ${cutoffMs} ORDER BY updated_at_ms ASC LIMIT ${batchSize})`
}

export function cleanupWranglerArgs({ retentionMs, batchSize, nowMs = Date.now() }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('cleanup clock must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > nowMs) {
    throw new Error('cleanup retention is invalid for the current clock')
  }
  const sql = buildCleanupSql({ cutoffMs: nowMs - retentionMs, batchSize })
  return [
    'wrangler',
    'd1',
    'execute',
    PRODUCTION_DATABASE_NAME,
    '--config',
    PRODUCTION_CONFIG,
    '--remote',
    '--command',
    sql,
  ]
}

export function runCleanup(env = process.env, nowMs = Date.now(), execute = execFileSync) {
  const config = readCleanupConfig(env)
  const args = cleanupWranglerArgs({ ...config, nowMs })
  const commandArgs = args.slice(1)
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  return execute(executable, commandArgs, {
    cwd: FRONTEND_DIR,
    env: {
      ...env,
      CLOUDFLARE_API_TOKEN: config.apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    },
    stdio: 'inherit',
  })
}

if (process.argv[1]?.endsWith('/cleanup-rate-limits.mjs')) {
  try {
    runCleanup()
  } catch (error) {
    console.error(error?.message || 'rate-limit retention cleanup failed')
    process.exit(1)
  }
}

import { readFileSync, readdirSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parse as parseDotenv } from 'dotenv'
import { experimental_readRawConfig } from 'wrangler'
import {
  PREVIEW_D1_SENTINEL,
  validatePreviewDatabaseId,
  writePreviewConfig,
} from './runtime-config.mjs'
import { RATE_LIMIT_UPSERT_SQL } from '../api/durableRateLimit.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
function tokens(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
}

function migrationFiles() {
  return readdirSync(new URL('../migrations/', import.meta.url))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort()
}

function apply(db, files) {
  for (const name of files) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
}

describe('runtime commands and Wrangler bindings', () => {
  it('builds Pages first and exposes explicit local/preview/production D1 commands', async () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(tokens(scripts['pages:dev'])).toEqual(
      expect.arrayContaining(['npm', 'run', 'build', 'wrangler', 'pages', 'dev', '--port', '5173'])
    )
    expect(tokens(scripts['d1:migrate:local'])).toEqual(
      expect.arrayContaining(['wrangler', 'd1', 'migrations', 'apply', 'vf-gate', '--local'])
    )
    expect(tokens(scripts['d1:migrate:preview'])).toEqual(
      expect.arrayContaining(['--env', 'preview', '--remote'])
    )
    expect(tokens(scripts['d1:migrate:preview'])).not.toContain('--local')
    expect(tokens(scripts['d1:migrate:production'])).toEqual(
      expect.arrayContaining(['wrangler', 'd1', 'migrations', 'apply', 'vf-gate', '--remote'])
    )
    expect(tokens(scripts['d1:migrate:production'])).not.toContain('preview')
    expect(scripts['pages:deploy:preview']).toContain('d1:migrate:preview')
    expect(scripts['pages:deploy:preview']).toContain('--env preview')
    expect(scripts['pages:deploy:preview']).toContain(
      '--config /tmp/vibing-farmer-wrangler-preview.jsonc'
    )
    expect(scripts['pages:deploy:production']).toContain('d1:migrate:production')
    expect(scripts['pages:deploy:preview']).not.toContain('--branch=main')
    expect(scripts['pages:deploy:production']).toContain('--branch=main')
  })

  it('fails closed before Wrangler until an externally supplied distinct preview D1 ID exists', () => {
    expect(validatePreviewDatabaseId(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(validatePreviewDatabaseId(PREVIEW_D1_SENTINEL)).toEqual({ ok: false, reason: 'sentinel' })
    expect(validatePreviewDatabaseId('ec1a48cf-bd50-49a3-88b0-c07a12329fd8')).toEqual({
      ok: false,
      reason: 'production-id',
    })
    expect(validatePreviewDatabaseId('11111111-2222-4333-8444-555555555555')).toEqual({
      ok: true,
    })
  })

  it('materializes the externally supplied preview ID without changing the tracked config', async () => {
    const target = '/tmp/vf-task15-preview-config-test.jsonc'
    const old = process.env.PREVIEW_D1_DATABASE_ID
    process.env.PREVIEW_D1_DATABASE_ID = '11111111-2222-4333-8444-555555555555'
    try {
      await writePreviewConfig(target)
      const generated = JSON.parse(readFileSync(target, 'utf8'))
      expect(generated.env.preview.d1_databases[0].database_id).toBe(
        process.env.PREVIEW_D1_DATABASE_ID
      )
      expect(generated.env.preview.d1_databases[0].migrations_dir).toMatch(/migrations$/)
      expect(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).toContain(
        PREVIEW_D1_SENTINEL
      )
    } finally {
      rmSync(target, { force: true })
      if (old === undefined) delete process.env.PREVIEW_D1_DATABASE_ID
      else process.env.PREVIEW_D1_DATABASE_ID = old
    }
  })

  it('parses JSONC through Wrangler and repeats non-inheriting preview bindings safely', async () => {
    const { rawConfig } = await experimental_readRawConfig({ config: 'wrangler.jsonc' })
    const preview = rawConfig.env.preview
    expect(rawConfig.compatibility_flags).toEqual(['nodejs_compat'])
    expect(preview.compatibility_flags).toEqual(['nodejs_compat'])
    expect(rawConfig.d1_databases).toHaveLength(1)
    expect(preview.d1_databases).toHaveLength(1)
    expect(rawConfig.d1_databases[0].binding).toBe('VF_DB')
    expect(preview.d1_databases[0].binding).toBe('VF_DB')
    expect(rawConfig.d1_databases[0].database_id).not.toBe(preview.d1_databases[0].database_id)
    expect(preview.d1_databases[0].database_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(preview.d1_databases[0].database_id).toBe(PREVIEW_D1_SENTINEL)
    for (const key of ['RELAYER_ORIGIN', 'ALLOWED_ORIGIN', 'SOROBAN_RPC_URL']) {
      expect(rawConfig.vars[key]).toBeDefined()
      expect(preview.vars[key]).toBeDefined()
    }
    expect(JSON.stringify(rawConfig)).not.toMatch(/VITE_(?:RELAYER|ALLOWED_EXTENSION)/)
  })

  it('uses development localhost examples and keeps server secrets unprefixed', () => {
    const vars = parseDotenv(readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8'))
    const env = parseDotenv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'))
    expect(vars.NODE_ENV).toBe('development')
    expect(vars.ALLOWED_ORIGIN).toBe('http://localhost:5173')
    expect(vars.ALLOWED_EXTENSION_ORIGINS).toBe('')
    expect(vars.RELAYER_ORIGIN).toBe('http://localhost:8788')
    expect(Object.keys(vars)).not.toContain('VITE_RELAYER_PROXY_KEY')
    expect(Object.keys(vars)).not.toContain('VITE_ALLOWED_EXTENSION_ORIGINS')
    expect(Object.keys(env)).not.toContain('VITE_RELAYER_PROXY_KEY')
  })

  it('keeps preview CI migrations behind the external-ID gate and never runs production remote migration there', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/frontend.yml', import.meta.url), 'utf8')
    expect(workflow).toContain('runtime-config.mjs assert-preview-d1')
    expect(workflow).toContain('d1:migrate:preview')
    expect(workflow).toContain('d1:migrate:production')
    expect(workflow).not.toContain('command: d1 migrations apply vf-gate --remote')
    expect(workflow).toContain("if: github.event_name == 'push' && github.ref_name != 'main'")
    expect(workflow).toContain(
      'pages deploy ./dist --config /tmp/vibing-farmer-wrangler-preview.jsonc --project-name=vibing-farmer --env preview'
    )
    expect(workflow).toContain('--config /tmp/vibing-farmer-wrangler-preview.jsonc')
    expect(workflow).toContain('command: pages deploy ./dist --project-name=vibing-farmer --branch=main')
  })
})

describe('ordered migrations', () => {
  it('requires contiguous 0001 through 0010 and applies the real chain', () => {
    const files = migrationFiles()
    const numbers = files.map((name) => Number(name.slice(0, 4)))
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, index) => index + 1))
    const db = new DatabaseSync(':memory:')
    apply(db, files)
    const row = db
      .prepare(RATE_LIMIT_UPSERT_SQL)
      .get('vf-cross:GET /config', '198.51.100.7', 0, 10_000)
    expect(row.request_count).toBe(1)
  })

  it('keeps pre-0008 data while layering recovery and rate-limit migrations', () => {
    const files = migrationFiles()
    const db = new DatabaseSync(':memory:')
    apply(db, files.slice(0, 7))
    db.prepare(
      `INSERT INTO api_keys (id,key_hash,key_hint,owner,scopes,created_at)
       VALUES ('legacy','hash','hint','owner','read',1)`
    ).run()
    apply(db, files.slice(7))
    expect(db.prepare('SELECT owner FROM api_keys WHERE id = ?').get('legacy').owner).toBe('owner')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'base_child_recovery_leases'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vf_cross_rate_limits'").get()).toBeTruthy()
  })

  it('makes a pre-0010 database fail closed until migration 0010 is applied', async () => {
    const db = new DatabaseSync(':memory:')
    apply(db, migrationFiles().slice(0, 9))
    const d1 = {
      prepare(sql) {
        return { bind(...params) { return { first: async () => db.prepare(sql).get(...params) } } }
      },
    }
    const { createDurableRateLimiter } = await import('../api/durableRateLimit.js')
    const req = { env: { VF_DB: d1 }, headers: { 'cf-connecting-ip': '198.51.100.7' } }
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    expect(await createDurableRateLimiter({ now: () => 10_000 })(req, res, { max: 30, windowMs: 60_000 })).toBe(false)
    expect(res.statusCode).toBe(503)
  })
})

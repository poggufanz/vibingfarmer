import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildCleanupSql, cleanupWranglerArgs, readCleanupConfig } from './cleanup-rate-limits.mjs'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

describe('bounded production rate-limit retention', () => {
  it('requires explicit production credentials and rejects preview cleanup', () => {
    expect(() => readCleanupConfig({})).toThrow(/production-only/)
    expect(() => readCleanupConfig({ RATE_LIMIT_CLEANUP_ENV: 'production' })).toThrow(
      /production cleanup requires Cloudflare credentials/
    )
    expect(() =>
      readCleanupConfig({
        RATE_LIMIT_CLEANUP_ENV: 'preview',
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
      })
    ).toThrow(/production-only/)
  })

  it('builds only a bounded stale-row DELETE', () => {
    const sql = buildCleanupSql({ cutoffMs: 123_456, batchSize: 25 })
    expect(sql).toMatch(
      /^DELETE FROM vf_cross_rate_limits WHERE rowid IN \(SELECT rowid FROM vf_cross_rate_limits WHERE updated_at_ms < 123456 ORDER BY updated_at_ms ASC LIMIT 25\)$/
    )
    expect(sql).not.toMatch(/DROP|TRUNCATE|DELETE FROM (?!vf_cross_rate_limits)/i)
    expect(() => buildCleanupSql({ cutoffMs: 1, batchSize: 0 })).toThrow(/batch/i)
    expect(() => buildCleanupSql({ cutoffMs: 1, batchSize: 10_001 })).toThrow(/batch/i)
  })

  it('uses the migration index for stale-row selection', () => {
    const migration = readFileSync(
      new URL('../migrations/0010_vf_cross_rate_limits.sql', import.meta.url),
      'utf8'
    )
    const db = new DatabaseSync(':memory:')
    db.exec(migration)
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN DELETE FROM vf_cross_rate_limits WHERE rowid IN (SELECT rowid FROM vf_cross_rate_limits WHERE updated_at_ms < ? ORDER BY updated_at_ms ASC LIMIT ?)'
      )
      .all(123_456, 25)
      .map((row) => row.detail)
      .join(' ')
    expect(plan).toContain('vf_cross_rate_limits_updated_at_idx')
  })

  it('pins the cleanup invocation to the tracked production Wrangler config', () => {
    const config = readCleanupConfig({
      RATE_LIMIT_CLEANUP_ENV: 'production',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      VF_RATE_LIMIT_RETENTION_MS: '86400000',
      VF_RATE_LIMIT_CLEANUP_BATCH: '100',
    })
    expect(config).toMatchObject({ retentionMs: 86_400_000, batchSize: 100 })
    const args = cleanupWranglerArgs({ ...config, nowMs: 100_000_000 })
    expect(args).toEqual(
      expect.arrayContaining(['d1', 'execute', 'vf-gate', '--config', 'wrangler.jsonc', '--remote'])
    )
    expect(args).not.toContain('--env')
    expect(args.join(' ')).toContain('LIMIT 100')
    expect(args.join(' ')).toContain('updated_at_ms < 13600000')
  })

  it('ships a scheduled package command with production-only secrets', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    )
    expect(packageJson.scripts['d1:cleanup:rate-limits']).toContain(
      'scripts/cleanup-rate-limits.mjs'
    )
    const workflow = readFileSync(
      new URL('../../.github/workflows/frontend-rate-limit-retention.yml', import.meta.url),
      'utf8'
    )
    expect(workflow).toContain('cron:')
    expect(workflow).toContain('d1:cleanup:rate-limits')
    expect(workflow).toContain('environment: production')
    expect(workflow).toContain('RATE_LIMIT_CLEANUP_ENV: production')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(workflow).not.toContain('PREVIEW_D1_DATABASE_ID')
  })
})

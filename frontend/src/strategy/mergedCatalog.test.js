import { describe, it, expect, vi } from 'vitest'
import { buildMergedCatalog, checkRelayerHealth } from './mergedCatalog.js'
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'

describe('buildMergedCatalog', () => {
  it('returns only stellar entries when base unavailable', () => {
    const cat = buildMergedCatalog({ baseAvailable: false })
    expect(cat).toHaveLength(VAULT_CATALOG.length)
    expect(cat.every((v) => v.chain === 'stellar')).toBe(true)
  })
  it('appends chain-tagged base pools when available', () => {
    const cat = buildMergedCatalog({ baseAvailable: true })
    expect(cat).toHaveLength(VAULT_CATALOG.length + BASE_POOL_CATALOG.length)
    expect(cat.filter((v) => v.chain === 'base')).toHaveLength(BASE_POOL_CATALOG.length)
  })
  it('prefers liveVaults for the stellar side', () => {
    const live = [{ name: 'Live', protocol: 'aave-v3', address: 'CLIVE', apy: 5 }]
    const cat = buildMergedCatalog({ baseAvailable: false, liveVaults: live })
    expect(cat).toHaveLength(1)
    expect(cat[0]).toMatchObject({ address: 'CLIVE', chain: 'stellar' })
  })
})

describe('checkRelayerHealth', () => {
  it('healthy on 404 unknown-jobId', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 404, ok: false, json: async () => ({ error: 'unknown jobId' }) })
    expect(await checkRelayerHealth({ fetchImpl })).toBe(true)
  })
  it('unhealthy on 503 relayer-not-configured', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({
        status: 503,
        ok: false,
        json: async () => ({ error: 'relayer not configured' }),
      })
    expect(await checkRelayerHealth({ fetchImpl })).toBe(false)
  })
  it('unhealthy on network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await checkRelayerHealth({ fetchImpl })).toBe(false)
  })
})

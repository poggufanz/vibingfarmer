import { describe, it, expect } from 'vitest'
import { memoryStore, storeFrom } from './_db.js'

const row = (over = {}) => ({
  id: 'vfk_1',
  key_hash: 'h1',
  key_hint: 'vf_test_ab12',
  owner: 'GAAA',
  scopes: '["market"]',
  rate_limit: 60,
  expires_at: null,
  enabled: 1,
  created_at: 1000,
  last_used_at: null,
  ...over,
})

describe('memoryStore', () => {
  it('insert + getByHash roundtrip', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    const got = await s.keys.getByHash('h1')
    expect(got.id).toBe('vfk_1')
    expect(await s.keys.getByHash('nope')).toBeNull()
  })
  it('list returns only the owner rows, without key_hash', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    await s.keys.insert(row({ id: 'vfk_2', key_hash: 'h2', owner: 'GBBB' }))
    const mine = await s.keys.list('GAAA')
    expect(mine).toHaveLength(1)
    expect(mine[0].id).toBe('vfk_1')
    expect(mine[0].key_hash).toBeUndefined()
  })
  it('revoke disables only own key', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    expect(await s.keys.revoke('vfk_1', 'GBBB')).toBe(false)
    expect(await s.keys.revoke('vfk_1', 'GAAA')).toBe(true)
    expect((await s.keys.getByHash('h1')).enabled).toBe(0)
  })
  it('counters.bump post-increments per (key, window)', async () => {
    const s = memoryStore()
    expect(await s.counters.bump('vfk_1', 100)).toBe(1)
    expect(await s.counters.bump('vfk_1', 100)).toBe(2)
    expect(await s.counters.bump('vfk_1', 160)).toBe(1)
  })
  it('usage.log accumulates per (key, day, endpoint)', async () => {
    const s = memoryStore()
    await s.usage.log('vfk_1', '2026-07-02', 'prices')
    await s.usage.log('vfk_1', '2026-07-02', 'prices')
    expect(s._usage.get('vfk_1|2026-07-02|prices')).toBe(2)
  })
})

describe('storeFrom', () => {
  it('falls back to a shared memory store without VF_DB', () => {
    const a = storeFrom({ env: {} })
    const b = storeFrom({})
    expect(a).toBe(b) // singleton so dev-issued keys survive across requests
  })
})

describe('usage.listForOwner', () => {
  it('returns only own keys usage since day, sorted day desc', async () => {
    const s = memoryStore()
    await s.keys.insert({
      id: 'k1',
      key_hash: 'h1',
      key_hint: 'a…',
      owner: 'GA',
      scopes: '["market"]',
      rate_limit: 60,
      expires_at: null,
      enabled: 1,
      created_at: 1,
      last_used_at: null,
    })
    await s.keys.insert({
      id: 'k2',
      key_hash: 'h2',
      key_hint: 'b…',
      owner: 'GB',
      scopes: '["market"]',
      rate_limit: 60,
      expires_at: null,
      enabled: 1,
      created_at: 1,
      last_used_at: null,
    })
    await s.usage.log('k1', '2026-07-10', 'GET /prices')
    await s.usage.log('k1', '2026-07-10', 'GET /prices')
    await s.usage.log('k1', '2026-07-11', 'POST /scan')
    await s.usage.log('k1', '2026-06-01', 'GET /prices') // too old
    await s.usage.log('k2', '2026-07-11', 'GET /prices') // other owner
    const rows = await s.usage.listForOwner('GA', '2026-07-01')
    expect(rows).toEqual([
      { key_id: 'k1', day: '2026-07-11', endpoint: 'POST /scan', count: 1 },
      { key_id: 'k1', day: '2026-07-10', endpoint: 'GET /prices', count: 2 },
    ])
  })
})

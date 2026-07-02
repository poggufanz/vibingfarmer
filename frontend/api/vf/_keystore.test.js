import { describe, it, expect } from 'vitest'
import { memoryStore } from './_db.js'
import { generateKey, issueKey, verifyKey, revokeKey, sha256Hex, SCOPES } from './_keystore.js'

describe('generateKey', () => {
  it('prefixes by env and uses base62 payload', () => {
    const k = generateKey('test')
    expect(k).toMatch(/^vf_test_[0-9A-Za-z]{40,}$/)
    expect(generateKey('live')).toMatch(/^vf_live_/)
    expect(generateKey('test')).not.toBe(generateKey('test'))
  })
})

describe('issue / verify / revoke', () => {
  it('stores hash + hint, never plaintext', async () => {
    const s = memoryStore()
    const { id, key, hint } = await issueKey(s, {
      owner: 'GAAA', scopes: ['market'], rateLimit: 60, env: 'test', expiresAt: null,
    })
    expect(id).toMatch(/^vfk_/)
    expect(hint).toBe(key.slice(0, 12) + '…')
    const stored = await s.keys.getByHash(await sha256Hex(key))
    expect(stored).not.toBeNull()
    expect(JSON.stringify(stored)).not.toContain(key) // plaintext nowhere at rest
  })
  it('verify: ok with scopes/rateLimit; unknown/revoked/expired/malformed fail', async () => {
    const s = memoryStore()
    const now = Date.now()
    const { id, key } = await issueKey(s, {
      owner: 'GAAA', scopes: ['market', 'tx'], rateLimit: 10, env: 'test',
      expiresAt: Math.floor(now / 1000) + 3600,
    })
    const v = await verifyKey(s, key, now)
    expect(v).toMatchObject({ ok: true, keyId: id, rateLimit: 10 })
    expect(v.scopes).toEqual(['market', 'tx'])
    expect((await verifyKey(s, 'vf_test_notarealkey000000000000000000000000000', now)).reason).toBe('unknown')
    expect((await verifyKey(s, 'sk-wrong-prefix', now)).reason).toBe('malformed')
    expect((await verifyKey(s, key, now + 3601 * 1000 + 1)).reason).toBe('expired')
    await revokeKey(s, id, 'GAAA')
    expect((await verifyKey(s, key, now)).reason).toBe('revoked')
  })
})

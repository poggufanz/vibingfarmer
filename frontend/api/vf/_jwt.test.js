import { describe, it, expect } from 'vitest'
import { signJwt, verifyJwt } from './_jwt.js'

describe('HS256 JWT', () => {
  it('sign → verify roundtrip preserves claims', async () => {
    const t = await signJwt({ sub: 'GAAA' }, 'secret-0123456789', 3600)
    expect(t.split('.')).toHaveLength(3)
    const p = await verifyJwt(t, 'secret-0123456789')
    expect(p.sub).toBe('GAAA')
    expect(p.exp - p.iat).toBe(3600)
  })
  it('rejects wrong secret, tamper, expiry, garbage', async () => {
    const t = await signJwt({ sub: 'GAAA' }, 'right-secret-000000', 10)
    expect(await verifyJwt(t, 'wrong-secret-000000')).toBeNull()
    const [h, p, s] = t.split('.')
    expect(await verifyJwt(`${h}.${p}x.${s}`, 'right-secret-000000')).toBeNull()
    expect(await verifyJwt(t, 'right-secret-000000', Date.now() + 11_000)).toBeNull()
    expect(await verifyJwt('not.a.jwt', 'right-secret-000000')).toBeNull()
    expect(await verifyJwt('garbage', 'right-secret-000000')).toBeNull()
  })
})

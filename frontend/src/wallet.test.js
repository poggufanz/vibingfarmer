// frontend/src/wallet.test.js
import { describe, it, expect } from 'vitest'
import { parseGrantResult } from './wallet.js'

// The real ERC-7715 grant (requestERC7715Permission) requires MetaMask Flask + the SAK provider
// action — it cannot be meaningfully unit-tested headlessly, so we pin the pure result-parser
// that the grant (and the session layer) depend on. The stale Base-Sepolia "chain guard" + mock
// grant were removed (the redeem spike verified erc20-token-periodic IS supported on 84532).
describe('parseGrantResult', () => {
  it('keeps a real delegationManager + context (no mock substitution)', () => {
    const r = parseGrantResult([
      { context: '0xabc', delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' },
    ])
    expect(r.permissionContext).toBe('0xabc')
    expect(r.delegationManager).toBe('0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3')
  })

  it('extracts context + manager from an array result (SAK PermissionResponse[])', () => {
    const r = parseGrantResult([{ context: '0xCTX', delegationManager: '0xDM', dependencies: [] }])
    expect(r).toMatchObject({ permissionContext: '0xCTX', delegationManager: '0xDM' })
  })

  it('returns null delegationManager when the response omits it', () => {
    const r = parseGrantResult([{ context: '0xCTX' }])
    expect(r).toMatchObject({ permissionContext: '0xCTX', delegationManager: null })
  })

  it('preserves grantedPermissions as the raw array for non-array responses', () => {
    const r = parseGrantResult({ permissionContext: '0xCTX', grantedPermissions: [{ a: 1 }] })
    expect(r.grantedPermissions).toEqual([{ a: 1 }])
  })
})

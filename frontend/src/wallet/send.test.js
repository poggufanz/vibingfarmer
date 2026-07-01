// frontend/src/wallet/send.test.js
import { describe, it, expect } from 'vitest'
import { isKnownVault } from './send.js'
import { VAULT_CATALOG } from '../config.js'

describe('send — vault detection', () => {
  it('flags a known vault address and ignores a random one', () => {
    const vaultAddr = VAULT_CATALOG[0].address
    expect(isKnownVault(vaultAddr).hit).toBe(true)
    expect(isKnownVault(vaultAddr).vault.name).toBe(VAULT_CATALOG[0].name)
    expect(isKnownVault('GRANDOMADDRESSNOTAVAULT').hit).toBe(false)
  })
})

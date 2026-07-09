// frontend/src/stellar/config.network.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('stellar config per-network', () => {
  it('defaults to testnet with the current live values', async () => {
    const cfg = await import('./config.js')
    expect(cfg.STELLAR_NETWORK).toBe('testnet')
    expect(cfg.NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015')
    expect(cfg.SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org')
    expect(cfg.SOROBAN_ACTIVE_VAULT_ADDRESS).toBe('CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU')
  })

  it('per-address env override wins', async () => {
    vi.stubEnv('VITE_SOROBAN_VAULT_ADDRESS', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP')
    vi.resetModules()
    const cfg = await import('./config.js')
    expect(cfg.SOROBAN_VAULT_ADDRESS).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP')
  })

  it('selecting mainnet with unfilled addresses throws loudly at import', async () => {
    vi.stubEnv('VITE_STELLAR_NETWORK', 'mainnet')
    vi.resetModules()
    await expect(import('./config.js')).rejects.toThrow(/mainnet .*unfilled/i)
  })
})

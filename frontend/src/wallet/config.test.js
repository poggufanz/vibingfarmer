import { describe, it, expect } from 'vitest'
import { makeWalletConfig, RP_ID } from './config.js'

describe('wallet config', () => {
  it('inherits VF testnet network + relay path, never invents its own', () => {
    const c = makeWalletConfig()
    expect(c.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(c.rpcUrl).toBe('https://soroban-testnet.stellar.org')
    expect(c.relayerUrl).toBe('/api/stellar-relay')
    expect(c.rpId).toBe(RP_ID)
  })
  it('has wasm/verifier set to version-matched live testnet artifacts', () => {
    const c = makeWalletConfig()
    // Filled by Task 6 (reused bindings-0.1.2 testnet artifacts) — non-null now.
    expect(c.accountWasmHash).toMatch(/^[0-9a-f]{64}$/)
    expect(c.webauthnVerifierAddress).toMatch(/^C[A-Z0-9]{55}$/)
  })
})

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
  it('exposes wasm/verifier slots that must be set before use', () => {
    const c = makeWalletConfig()
    expect('accountWasmHash' in c).toBe(true)
    expect('webauthnVerifierAddress' in c).toBe(true)
  })
})

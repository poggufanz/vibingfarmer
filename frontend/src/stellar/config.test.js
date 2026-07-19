import { describe, it, expect, vi } from 'vitest'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  HORIZON_URL,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DEMO_AGENT,
  SOROBAN_DECIMALS,
  RELAY_PROXY_URL,
} from './config.js'

describe('stellar config', () => {
  it('pins the testnet passphrase exactly (a wrong passphrase silently fails every signature)', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015')
  })
  it('points at the soroban testnet RPC and Horizon', () => {
    expect(SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org')
    expect(HORIZON_URL).toBe('https://horizon-testnet.stellar.org')
  })
  it('matches the deployed contracts from deployments/stellar-testnet.json', () => {
    expect(SOROBAN_VAULT_ADDRESS).toBe('CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU')
    expect(SOROBAN_REGISTRY_ADDRESS).toBe(
      'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB'
    )
    expect(SOROBAN_TOKEN_ADDRESS).toBe('CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU')
    expect(SOROBAN_DEMO_AGENT).toBe('CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC')
  })
  it('live deposit target is the autofarm vault (cutover)', () => {
    expect(SOROBAN_ACTIVE_VAULT_ADDRESS).toBe(SOROBAN_AUTOFARM_VAULT_ADDRESS)
    expect(SOROBAN_ACTIVE_VAULT_ADDRESS).toBe(
      'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
    )
  })
  it('pins token/share decimals at 7 (the deployed SAC + vault metadata)', () => {
    expect(SOROBAN_DECIMALS).toBe(7)
  })
  it('routes to the stellar relay proxy (NOT the EVM /api/relay)', () => {
    expect(RELAY_PROXY_URL).toBe('/api/stellar-relay')
  })
  it('chrome-extension origin falls back to the deployed backend, never localhost (packed-build passkey bug)', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { protocol: 'chrome-extension:' } })
    try {
      const fresh = await import('./config.js')
      expect(fresh.RELAY_PROXY_URL).toBe('https://vibing-farmer.pages.dev/api/stellar-relay')
      expect(fresh.FAUCET_PROXY_URL).toBe('https://vibing-farmer.pages.dev/api/faucet')
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})

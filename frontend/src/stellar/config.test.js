import { describe, it, expect } from 'vitest'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  SOROBAN_VAULT_ADDRESS,
  RELAY_PROXY_URL,
} from './config.js'

describe('stellar config', () => {
  it('pins the testnet passphrase exactly (a wrong passphrase silently fails every signature)', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015')
  })
  it('points at the soroban testnet RPC', () => {
    expect(SOROBAN_RPC_URL).toBe('https://soroban-testnet.stellar.org')
  })
  it('matches the deployed vault from deployments/stellar-testnet.json', () => {
    expect(SOROBAN_VAULT_ADDRESS).toBe('CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF')
  })
  it('routes to the new stellar relay proxy (NOT the EVM /api/relay)', () => {
    expect(RELAY_PROXY_URL).toBe('/api/stellar-relay')
  })
})

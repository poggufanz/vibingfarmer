import { describe, it, expect } from 'vitest'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  HORIZON_URL,
  SOROBAN_VAULT_ADDRESS,
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
    expect(SOROBAN_VAULT_ADDRESS).toBe('CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5')
    expect(SOROBAN_REGISTRY_ADDRESS).toBe(
      'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
    )
    expect(SOROBAN_TOKEN_ADDRESS).toBe('CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4')
    expect(SOROBAN_DEMO_AGENT).toBe('CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K')
  })
  it('pins token/share decimals at 7 (the deployed SAC + vault metadata)', () => {
    expect(SOROBAN_DECIMALS).toBe(7)
  })
  it('routes to the stellar relay proxy (NOT the EVM /api/relay)', () => {
    expect(RELAY_PROXY_URL).toBe('/api/stellar-relay')
  })
})

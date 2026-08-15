import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PROTOCOL_COUNT,
  FIRST_PARTY_DEPLOYMENT_COUNT,
  SOROBAN_SOURCE_CRATES,
  STATIC_ADDRESS_COUNT,
  STELLAR_STATIC_DEPLOYMENTS,
} from './deploymentFacts.js'

const manifest = JSON.parse(
  readFileSync(new URL('../../../deployments/stellar-testnet.json', import.meta.url), 'utf8')
)

describe('deployment facts', () => {
  it('derives the eight static Stellar addresses from the live manifest in display order', () => {
    expect(STELLAR_STATIC_DEPLOYMENTS.map(({ address }) => address)).toEqual([
      manifest.fundingRouter.addressV2,
      manifest.autofarmVault.address,
      manifest.strategy1.address,
      manifest.exitRouter.address,
      manifest.attestation,
      manifest.registry,
      manifest.strategy1.pool,
      manifest.fundingRouter.token,
    ])
  })

  it('publishes the seven Soroban source crates and derives the category counts', () => {
    expect(SOROBAN_SOURCE_CRATES).toEqual([
      'agent_account',
      'attestation',
      'autofarm_vault',
      'blend_strategy',
      'exit_router',
      'funding_router',
      'registry',
    ])
    expect(FIRST_PARTY_DEPLOYMENT_COUNT).toBe(6)
    expect(EXTERNAL_PROTOCOL_COUNT).toBe(2)
    expect(STATIC_ADDRESS_COUNT).toBe(8)
  })

  it('freezes the public facts so rendering cannot drift them at runtime', () => {
    expect(Object.isFrozen(SOROBAN_SOURCE_CRATES)).toBe(true)
    expect(Object.isFrozen(STELLAR_STATIC_DEPLOYMENTS)).toBe(true)
    expect(STELLAR_STATIC_DEPLOYMENTS.every((record) => Object.isFrozen(record))).toBe(true)
  })
})

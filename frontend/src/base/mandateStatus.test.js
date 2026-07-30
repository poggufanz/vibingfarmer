import { describe, expect, it } from 'vitest'
import {
  isVerifiedBaseMandateStatus,
  materialBaseMandateStatusChange,
  publicBaseMandateEvidence,
  toMandateStatusAllocation,
} from './mandateStatus.js'

const active = (overrides = {}) => ({
  version: 2,
  status: 'active',
  reasonCodes: [],
  expected: {
    owner: 'GOWNER',
    kernelAddress: '0x0000000000000000000000000000000000000AA1',
    sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
    bindingId: 'binding-1',
    bindingHash: 'hash-1',
    policyDigest: 'policy-1',
  },
  observed: {
    blockNumber: '100',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTime: 2_000_000_000_000,
    implementation: '0x0000000000000000000000000000000000000CC3',
    permission: { digest: 'permission-1' },
    preparedCallDigest: 'prepared-1',
  },
  checks: {
    chain: true,
    owner: true,
    kernel: true,
    session: true,
    permission: true,
    policy: true,
    binding: true,
    origin: true,
    implementation: true,
    allocation: true,
    freshness: true,
    prepared: true,
  },
  ...overrides,
})

describe('Base mandate evidence gates', () => {
  it('accepts only active, complete read+prepare evidence', () => {
    expect(isVerifiedBaseMandateStatus(active())).toBe(true)
    for (const status of [
      'not_yet_valid',
      'expiring',
      'expired',
      'revoked',
      'mismatch',
      'unknown',
    ]) {
      expect(isVerifiedBaseMandateStatus(active({ status }))).toBe(false)
    }
    expect(
      isVerifiedBaseMandateStatus(active({ checks: { ...active().checks, prepared: false } }))
    ).toBe(false)
    expect(
      isVerifiedBaseMandateStatus(
        active({ observed: { ...active().observed, preparedCallDigest: null } })
      )
    ).toBe(false)
  })

  it('treats a revoke or evidence digest change as material, but not a newer confirming block', () => {
    const previous = active()
    expect(
      materialBaseMandateStatusChange(
        previous,
        active({
          observed: {
            ...previous.observed,
            blockNumber: '101',
            blockHash: `0x${'cd'.repeat(32)}`,
            blockTime: previous.observed.blockTime + 2_000,
          },
        })
      )
    ).toBe(false)
    expect(materialBaseMandateStatusChange(previous, active({ status: 'revoked' }))).toBe(true)
    expect(
      materialBaseMandateStatusChange(
        previous,
        active({
          observed: {
            ...previous.observed,
            permission: { ...previous.observed.permission, digest: 'permission-2' },
          },
        })
      )
    ).toBe(true)
    expect(
      materialBaseMandateStatusChange(
        previous,
        active({ expected: { ...previous.expected, bindingHash: 'hash-2' } })
      )
    ).toBe(true)
  })

  it('builds the exact durable allocation and rejects mutation fields', () => {
    expect(
      toMandateStatusAllocation({
        allocationId: 'run-1:bridge:aave-v3',
        poolAddress: '0x0000000000000000000000000000000000000AA1',
        units: 123n,
        minShares: 120n,
      })
    ).toEqual({
      allocationId: 'run-1:bridge:aave-v3',
      poolAddress: '0x0000000000000000000000000000000000000AA1',
      amount: { token: 'USDC', units: '123', decimals: 6 },
      minShares: '120',
    })
    expect(() =>
      toMandateStatusAllocation({
        poolAddress: '0x0000000000000000000000000000000000000AA1',
        units: 123n,
        minShares: 120n,
        paymaster: '0x0000000000000000000000000000000000000BB2',
      })
    ).toThrow(/unexpected/i)
  })

  it('persists/returns only public observation evidence and removes nested secrets', () => {
    const evidence = publicBaseMandateEvidence(
      active({
        sessionPrivateKey: 'TOP-SECRET',
        observed: {
          ...active().observed,
          relaySecret: 'RELAY-SECRET',
          nested: { ownerPrivateKey: 'OWNER-SECRET', safe: 'kept' },
        },
      })
    )
    expect(evidence.observed.nested.safe).toBe('kept')
    expect(JSON.stringify(evidence)).not.toMatch(/TOP-SECRET|RELAY-SECRET|OWNER-SECRET/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  isVerifiedBaseMandateStatus,
  materialBaseMandateStatusChange,
  normalizeBaseMandateStatus,
  publicBaseMandateEvidence,
} from './mandateStatus.js'

const USER_OP_HASH = `0x${'33'.repeat(32)}`
const TX_HASH = `0x${'44'.repeat(32)}`

const active = (overrides = {}) => ({
  version: 3,
  status: 'active',
  reasonCodes: [],
  validUntilSeconds: 2_000_007_200,
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
    activation: {
      userOpHash: USER_OP_HASH,
      txHash: TX_HASH,
      activatedAt: 2_000_000_000,
    },
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
    freshness: true,
    reconstruction: true,
    activation: true,
  },
  ...overrides,
})

describe('Base mandate evidence gates', () => {
  it('accepts only v3 active evidence with durable activation and every live check', () => {
    expect(isVerifiedBaseMandateStatus(active())).toBe(true)
    expect(isVerifiedBaseMandateStatus(active({ version: 2 }))).toBe(false)
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
      isVerifiedBaseMandateStatus(active({ checks: { ...active().checks, activation: false } }))
    ).toBe(false)
    expect(
      isVerifiedBaseMandateStatus(active({ observed: { ...active().observed, activation: null } }))
    ).toBe(false)
    expect(
      isVerifiedBaseMandateStatus(
        active({
          observed: {
            ...active().observed,
            activation: { ...active().observed.activation, userOpHash: `0x${'AA'.repeat(32)}` },
          },
        })
      )
    ).toBe(false)
  })

  it.each([
    'chain',
    'owner',
    'kernel',
    'session',
    'permission',
    'policy',
    'binding',
    'origin',
    'implementation',
    'freshness',
    'reconstruction',
    'activation',
  ])('rejects active evidence when the mandatory %s check is absent', (missing) => {
    const complete = { ...active().checks }
    delete complete[missing]

    expect(isVerifiedBaseMandateStatus(active({ checks: complete }))).toBe(false)
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

  it('normalizes only the v3 HTTP contract and fails closed otherwise', () => {
    expect(normalizeBaseMandateStatus(active())).toEqual(active())
    expect(normalizeBaseMandateStatus(active({ version: 2 }))).toEqual({
      version: 3,
      status: 'unknown',
      reasonCodes: ['EVIDENCE_MISSING'],
      expected: {},
      observed: {},
      checks: {},
    })
  })

  it('persists/returns only public observation evidence and removes nested secrets', () => {
    const evidence = publicBaseMandateEvidence(
      active({
        sessionPrivateKey: 'TOP-SECRET',
        serializedApproval: 'SERIALIZED-APPROVAL',
        approvalBlob: 'APPROVAL-BLOB',
        capability: 'CAPABILITY-SECRET',
        authorization: 'Bearer AUTHORIZATION-SECRET',
        cookie: '__Host-vf-mandate-secret=COOKIE-SECRET',
        observed: {
          ...active().observed,
          relaySecret: 'RELAY-SECRET',
          nested: {
            ownerPrivateKey: 'OWNER-SECRET',
            enableSignature: 'ENABLE-SIGNATURE',
            sessionMaterial: 'SESSION-MATERIAL',
            deeper: {
              serializedApproval: 'NESTED-APPROVAL',
              bearerToken: 'BEARER-SECRET',
              safe: 'kept',
            },
          },
        },
      })
    )
    expect(evidence.observed.nested.deeper.safe).toBe('kept')
    expect(JSON.stringify(evidence)).not.toMatch(
      /TOP-SECRET|SERIALIZED-APPROVAL|APPROVAL-BLOB|CAPABILITY-SECRET|AUTHORIZATION-SECRET|COOKIE-SECRET|RELAY-SECRET|OWNER-SECRET|ENABLE-SIGNATURE|SESSION-MATERIAL|NESTED-APPROVAL|BEARER-SECRET/
    )
  })
})

describe('v3 activation lifecycle normalization', () => {
  it.each(['pending_activation', 'activation_uncertain'])(
    'preserves the public %s lifecycle instead of collapsing it to unknown',
    (status) => {
      const evidence = {
        version: 3,
        mandateId: '11'.repeat(16),
        status,
        reasonCodes: status === 'activation_uncertain' ? ['ACTIVATION_RECEIPT_UNKNOWN'] : [],
        expected: {},
        observed: {},
        checks: {},
      }

      expect(normalizeBaseMandateStatus(evidence)).toEqual(evidence)
      expect(isVerifiedBaseMandateStatus(evidence)).toBe(false)
    }
  )
})

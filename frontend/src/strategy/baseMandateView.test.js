import { describe, expect, it } from 'vitest'
import { toBaseMandateView } from './baseMandateView.js'

const now = Math.floor(Date.now() / 1000)
const connection = {
  stellarOwner: 'GOWNER',
  kernelAddress: '0x0000000000000000000000000000000000000aA1',
  relayerOrigin: 'https://relayer.example',
}
const activeMandate = {
  version: 3,
  mandateId: '11'.repeat(16),
  stellarOwner: 'GOWNER',
  kernelAddress: '0x0000000000000000000000000000000000000AA1',
  sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
  relayerOrigin: 'https://relayer.example',
  validUntilSeconds: now + 3600,
  status: 'active',
  bindingId: 'binding-1',
  bindingHash: 'binding-hash-1',
  reasonCodes: [],
  expected: { chainId: 84532 },
  observed: {
    blockNumber: '101',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTime: now,
    implementation: '0x0000000000000000000000000000000000000CC3',
    permission: { digest: 'permission-digest' },
    activation: {
      userOpHash: `0x${'33'.repeat(32)}`,
      txHash: `0x${'44'.repeat(32)}`,
      activatedAt: now - 10,
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
}

describe('baseMandateView v3', () => {
  it('discloses the complete ready mandate boundary without changing the canonical record', () => {
    const original = { ...activeMandate }

    const view = toBaseMandateView({ mandate: original, ...connection })

    expect(view.status).toBe('ready')
    expect(view.ready).toBe(true)
    expect(view.primaryCopy).toBe(
      'For 7 days, the relayer-held key may repeatedly approve and deposit up to 10,000 USDC per call into allowlisted Base Sepolia custody proxies, while this smart account has funds. It cannot withdraw.'
    )
    expect(view.durationDays).toBe(7)
    expect(view.perCallCap).toMatchObject({
      usdc: '10,000',
      units: 10_000_000_000n,
      decimals: 6,
      cumulative: false,
      nonCumulative: true,
    })
    expect(view.repeatedCalls).toBe(true)
    expect(view.allowedActions).toEqual(['Circle USDC approve', 'YieldRouter deposit'])
    expect(view.destination).toBe('allowlisted Base Sepolia custody proxies')
    expect(view.sessionKeyAddress).toBe(activeMandate.sessionKeyAddress)
    expect(view.kernelAddress).toBe(activeMandate.kernelAddress)
    expect(view.validUntilSeconds).toBe(activeMandate.validUntilSeconds)
    expect(view.bindingId).toBe(activeMandate.bindingId)
    expect(view.bindingHash).toBe(activeMandate.bindingHash)
    expect(view.evidence).toEqual(activeMandate)
    expect(view.technicalDisclosure).toContain('application-level association')
    expect(view.technicalDisclosure).toContain('renew')
    expect(view.technicalDisclosure).toContain(
      'Deleting or revoking the VF relayer copy does not invalidate another copied key before the on-chain timestamp policy expires'
    )
    expect(view.technicalDisclosure).toContain('outage')
    expect(view).not.toHaveProperty('sessionPrivateKey')
    expect(original).toEqual(activeMandate)
  })

  it.each([
    ['missing', null, connection],
    ['missing', { ...activeMandate, status: 'missing' }, connection],
    ['expired', { ...activeMandate, validUntilSeconds: now - 1 }, connection],
    ['owner-mismatch', { ...activeMandate, stellarOwner: 'GOTHER' }, connection],
    [
      'kernel-mismatch',
      { ...activeMandate, kernelAddress: '0x0000000000000000000000000000000000000CC3' },
      connection,
    ],
    ['relayer-mismatch', { ...activeMandate, relayerOrigin: 'https://other.example' }, connection],
    ['revoked', { ...activeMandate, status: 'revoked' }, connection],
    ['unavailable', { ...activeMandate, status: 'pending_activation' }, connection],
    ['unavailable', { ...activeMandate, status: 'activation_uncertain' }, connection],
    ['unavailable', { ...activeMandate, bindingId: null }, connection],
    [
      'unavailable',
      activeMandate,
      { stellarOwner: 'GOWNER', kernelAddress: null, relayerOrigin: null },
    ],
  ])('fails closed as %s', (status, mandate, expectedConnection) => {
    const view = toBaseMandateView({ mandate, ...expectedConnection })

    expect(view.status).toBe(status)
    expect(view.ready).toBe(false)
  })

  it('never renders a local active record without remote evidence as ready', () => {
    const localOnly = {
      stellarOwner: connection.stellarOwner,
      kernelAddress: connection.kernelAddress,
      relayerOrigin: connection.relayerOrigin,
      status: 'active',
      validUntilSeconds: now + 3600,
      bindingId: 'local',
      bindingHash: 'local',
      sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
    }
    expect(toBaseMandateView({ mandate: localOnly, ...connection })).toMatchObject({
      status: 'unavailable',
      ready: false,
    })
  })

  it('does not revive a v2 expiresAt record when validUntilSeconds is absent', () => {
    const { validUntilSeconds: _removed, ...withoutV3Expiry } = activeMandate
    const legacy = { ...withoutV3Expiry, expiresAt: now + 3600 }

    expect(toBaseMandateView({ mandate: legacy, ...connection })).toMatchObject({
      status: 'unavailable',
      ready: false,
    })
  })
})

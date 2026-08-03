import { describe, expect, it } from 'vitest'
import { toBaseMandateView } from './baseMandateView.js'

const now = Math.floor(Date.now() / 1000)
const connection = {
  stellarOwner: 'GOWNER',
  kernelAddress: '0x0000000000000000000000000000000000000aA1',
  relayerOrigin: 'https://relayer.example',
}
const activeMandate = {
  version: 2,
  stellarOwner: 'GOWNER',
  kernelAddress: '0x0000000000000000000000000000000000000AA1',
  sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
  relayerOrigin: 'https://relayer.example',
  expiresAt: now + 3600,
  status: 'active',
  bindingId: 'binding-1',
  bindingHash: '0xabc123',
  reasonCodes: [],
  expected: { chainId: 84532 },
  observed: {
    blockNumber: '101',
    blockHash: '0xblock',
    blockTime: Date.now(),
    implementation: '0ximpl',
    permission: { digest: 'permission-digest' },
    preparedCallDigest: 'prepared-call-digest',
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
    reconstruction: true,
    prepared: true,
  },
}

describe('toBaseMandateView', () => {
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
    expect(view.expiresAt).toBe(activeMandate.expiresAt)
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
    ['expired', { ...activeMandate, expiresAt: now - 1 }, connection],
    ['owner-mismatch', { ...activeMandate, stellarOwner: 'GOTHER' }, connection],
    [
      'kernel-mismatch',
      { ...activeMandate, kernelAddress: '0x0000000000000000000000000000000000000CC3' },
      connection,
    ],
    ['relayer-mismatch', { ...activeMandate, relayerOrigin: 'https://other.example' }, connection],
    ['revoked', { ...activeMandate, status: 'revoked' }, connection],
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
      expiresAt: now + 3600,
      bindingId: 'local',
      bindingHash: 'local',
      sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
    }
    expect(toBaseMandateView({ mandate: localOnly, ...connection })).toMatchObject({
      status: 'unavailable',
      ready: false,
    })
  })
})

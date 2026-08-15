import { beforeEach, describe, expect, it } from 'vitest'
import { baseMandateStorageKey, readBaseMandate, validateBaseMandate } from './baseBinding.js'

const MANDATE_ID = '11'.repeat(16)
const OWNER_A = 'GOWNERA'
const OWNER_B = 'GOWNERB'
const KERNEL = '0x0000000000000000000000000000000000000aA1'
const SESSION = '0x0000000000000000000000000000000000000bB2'
const USER_OP_HASH = `0x${'33'.repeat(32)}`
const TX_HASH = `0x${'44'.repeat(32)}`
const NOW = 2_000_000_000

function activeRecord(overrides = {}) {
  return {
    version: 3,
    mandateId: MANDATE_ID,
    stellarOwner: OWNER_A,
    kernelAddress: KERNEL,
    sessionKeyAddress: SESSION,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: NOW + 7_200,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: 'binding-hash-1',
    reasonCodes: [],
    expected: {
      owner: OWNER_A,
      kernelAddress: KERNEL.toLowerCase(),
      sessionKeyAddress: SESSION.toLowerCase(),
      bindingId: 'binding-1',
      bindingHash: 'binding-hash-1',
    },
    observed: {
      blockNumber: '101',
      blockHash: `0x${'ab'.repeat(32)}`,
      blockTime: NOW,
      implementation: '0x0000000000000000000000000000000000000cc3',
      permission: { digest: 'permission-digest' },
      activation: {
        userOpHash: USER_OP_HASH,
        txHash: TX_HASH,
        activatedAt: NOW - 30,
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
  }
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const operations = []
  return {
    getItem(key) {
      operations.push(['get', key])
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      operations.push(['set', key])
      values.set(key, String(value))
    },
    removeItem(key) {
      operations.push(['remove', key])
      values.delete(key)
    },
    dump: () => Object.fromEntries(values),
    operations,
  }
}

let storage
beforeEach(() => {
  storage = fakeStorage()
  globalThis.localStorage = storage
})

describe('v3 mandate storage', () => {
  it('normalizes owner-scoped keys and refuses an empty owner', () => {
    expect(baseMandateStorageKey(`  ${OWNER_A}  `)).toBe(`vf_base_mandate_v3:${OWNER_A}`)
    expect(baseMandateStorageKey(OWNER_A)).not.toBe(baseMandateStorageKey(OWNER_B))
    expect(() => baseMandateStorageKey('   ')).toThrow(/stellarOwner/i)
    expect(() => baseMandateStorageKey()).toThrow(/stellarOwner/i)
  })

  it('round-trips only the exact public v3 allowlist', () => {
    const record = activeRecord()
    storage.setItem(baseMandateStorageKey(OWNER_A), JSON.stringify(record))

    expect(readBaseMandate(OWNER_A, storage)).toEqual(record)
    expect(Object.keys(readBaseMandate(OWNER_A, storage)).sort()).toEqual(
      [
        'version',
        'mandateId',
        'stellarOwner',
        'kernelAddress',
        'sessionKeyAddress',
        'relayerOrigin',
        'validUntilSeconds',
        'status',
        'bindingId',
        'bindingHash',
        'reasonCodes',
        'expected',
        'observed',
        'checks',
      ].sort()
    )
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['wrong version', JSON.stringify(activeRecord({ version: 2 }))],
    ['serialized approval', JSON.stringify(activeRecord({ serializedApproval: 'APPROVAL' }))],
    ['raw capability', JSON.stringify(activeRecord({ capability: '22'.repeat(32) }))],
    ['private key', JSON.stringify(activeRecord({ sessionPrivateKey: 'PRIVATE' }))],
    ['unexpected field', JSON.stringify(activeRecord({ createdAt: NOW }))],
  ])('removes %s instead of trusting or retaining it', (_label, raw) => {
    const key = baseMandateStorageKey(OWNER_A)
    storage.setItem(key, raw)

    expect(readBaseMandate(OWNER_A, storage)).toBeNull()
    expect(storage.getItem(key)).toBeNull()
    expect(storage.operations).toContainEqual(['remove', key])
  })

  it('actively deletes global and owner-scoped v2 keys without adopting either', () => {
    const v3Key = baseMandateStorageKey(OWNER_A)
    const legacyOwnerKey = `vf_base_mandate_v2:${OWNER_A}`
    storage = fakeStorage({
      vf_base_mandate: JSON.stringify({ serializedApproval: 'GLOBAL-APPROVAL' }),
      [legacyOwnerKey]: JSON.stringify({ version: 2, serializedApproval: 'OWNER-APPROVAL' }),
      [v3Key]: JSON.stringify(activeRecord()),
    })

    expect(readBaseMandate(OWNER_A, storage)).toEqual(activeRecord())
    expect(storage.getItem('vf_base_mandate')).toBeNull()
    expect(storage.getItem(legacyOwnerKey)).toBeNull()
    expect(JSON.stringify(storage.dump())).not.toMatch(/GLOBAL-APPROVAL|OWNER-APPROVAL/)
  })

  it('never falls back to another owner or a global mandate during a wallet switch', () => {
    storage = fakeStorage({
      vf_base_mandate: JSON.stringify(activeRecord()),
      [baseMandateStorageKey(OWNER_A)]: JSON.stringify(activeRecord()),
    })

    expect(readBaseMandate(OWNER_B, storage)).toBeNull()
    expect(readBaseMandate(OWNER_A, storage)).toEqual(activeRecord())
  })

  it('checks immutable binding before expiry and compares only EVM addresses case-insensitively', () => {
    const record = activeRecord({ validUntilSeconds: NOW - 1 })
    expect(
      validateBaseMandate(record, {
        stellarOwner: OWNER_A,
        kernelAddress: KERNEL.toLowerCase(),
        sessionKeyAddress: SESSION.toUpperCase(),
        relayerOrigin: 'https://relayer.example',
        now: NOW,
      })
    ).toBe('expired')
    expect(
      validateBaseMandate(record, {
        stellarOwner: OWNER_B,
        kernelAddress: KERNEL,
        now: NOW,
      })
    ).toBe('mismatched')
    expect(
      validateBaseMandate(activeRecord(), {
        stellarOwner: OWNER_A.toLowerCase(),
        kernelAddress: KERNEL,
        now: NOW,
      })
    ).toBe('mismatched')
  })

  it.each([
    ['pending_activation', 'unavailable'],
    ['activation_uncertain', 'unavailable'],
    ['revoked', 'revoked'],
    ['expired', 'expired'],
  ])('classifies %s as %s', (status, expected) => {
    expect(validateBaseMandate(activeRecord({ status }), { stellarOwner: OWNER_A, now: NOW })).toBe(
      expected
    )
  })

  it('requires remotely verified active evidence rather than a local active label', () => {
    const localOnly = {
      ...activeRecord(),
      observed: {},
      checks: {},
    }
    expect(validateBaseMandate(localOnly, { stellarOwner: OWNER_A, now: NOW })).toBe('unavailable')
    expect(validateBaseMandate(null, { stellarOwner: OWNER_A, now: NOW })).toBe('missing')
    expect(validateBaseMandate(activeRecord(), { stellarOwner: OWNER_A, now: NOW })).toBe('active')
  })

  it.each([
    [
      'activation hash',
      'unavailable',
      () => ({ observed: { ...activeRecord().observed, activation: null } }),
    ],
    [
      'mandatory check',
      'unavailable',
      () => ({ checks: { ...activeRecord().checks, activation: false } }),
    ],
    ['owner', 'mismatched', () => ({ stellarOwner: OWNER_B })],
    [
      'kernel',
      'mismatched',
      () => ({ kernelAddress: '0x0000000000000000000000000000000000000dd4' }),
    ],
  ])('stored %s mutation classifies exactly as %s', (_label, expected, mutate) => {
    const record = activeRecord(mutate())
    expect(
      validateBaseMandate(record, {
        stellarOwner: OWNER_A,
        kernelAddress: KERNEL,
        sessionKeyAddress: SESSION,
        relayerOrigin: 'https://relayer.example',
        now: NOW,
      })
    ).toBe(expected)
  })
})

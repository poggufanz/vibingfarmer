// frontend/src/wallet/baseBinding.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import {
  baseOwnerStorageKey,
  baseMandateStorageKey,
  readBaseOwner,
  readBaseMandate,
  validateBaseMandate,
} from './baseBinding.js'

// Repo pattern (mirrors wallet/passkeyBridge.test.js): vitest's default environment here is
// 'node', which has no global localStorage. Stub it with a plain object-backed fake.
const store = {}
beforeEach(() => {
  for (const k in store) delete store[k]
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
})

const OWNER_A = 'GOWNERA'
const OWNER_B = 'GOWNERB'
const KERNEL = '0x0000000000000000000000000000000000000AA1'

function seedOwner(stellarOwner, overrides = {}) {
  localStorage.setItem(
    baseOwnerStorageKey(stellarOwner),
    JSON.stringify({
      version: 2,
      stellarOwner,
      kernelAddress: KERNEL,
      passkeyName: 'vibing-farmer-base-x',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
  )
}

function seedMandate(stellarOwner, overrides = {}) {
  localStorage.setItem(
    baseMandateStorageKey(stellarOwner),
    JSON.stringify({
      version: 2,
      stellarOwner,
      kernelAddress: KERNEL,
      serializedApproval: 'APPROVAL',
      sessionKeyAddress: '0xSESSION',
      relayerOrigin: 'https://relayer.example',
      expiresAt: 9_999_999_999,
      status: 'active',
      bindingId: 'bind-1',
      bindingHash: 'hash-1',
      createdAt: 1,
      ...overrides,
    })
  )
}

describe('storage key builders', () => {
  it('scope keys by stellarOwner and refuse to build an unscoped key', () => {
    expect(baseOwnerStorageKey(OWNER_A)).toContain(OWNER_A)
    expect(baseMandateStorageKey(OWNER_A)).toContain(OWNER_A)
    expect(baseOwnerStorageKey(OWNER_A)).not.toBe(baseOwnerStorageKey(OWNER_B))
    expect(() => baseOwnerStorageKey()).toThrow(/stellarOwner/)
    expect(() => baseMandateStorageKey()).toThrow(/stellarOwner/)
  })
})

describe('owner A/B separation + wallet switch', () => {
  it('owner A never sees owner B record and vice versa', () => {
    seedOwner(OWNER_A, { kernelAddress: '0xAAA' })
    seedOwner(OWNER_B, { kernelAddress: '0xBBB' })
    expect(readBaseOwner(OWNER_A).kernelAddress).toBe('0xAAA')
    expect(readBaseOwner(OWNER_B).kernelAddress).toBe('0xBBB')
  })

  it('wallet switch: reading a mandate for a never-set-up owner returns null even though another owner has one', () => {
    seedMandate(OWNER_A)
    expect(readBaseMandate(OWNER_A)).not.toBeNull()
    expect(readBaseMandate(OWNER_B)).toBeNull()
  })

  it('readBaseOwner/readBaseMandate return null without a stellarOwner (never a global fallback)', () => {
    seedOwner(OWNER_A)
    expect(readBaseOwner(null)).toBeNull()
    expect(readBaseOwner(undefined)).toBeNull()
  })
})

describe('corrupt / legacy records self-heal to null', () => {
  it('malformed JSON at the v2 key reads as null, not a throw', () => {
    localStorage.setItem(baseOwnerStorageKey(OWNER_A), '{not valid json')
    localStorage.setItem(baseMandateStorageKey(OWNER_A), '{not valid json')
    expect(readBaseOwner(OWNER_A)).toBeNull()
    expect(readBaseMandate(OWNER_A)).toBeNull()
  })

  it('a pre-v2 (legacy-shaped) record without version:2 is not trusted', () => {
    localStorage.setItem(
      baseMandateStorageKey(OWNER_A),
      JSON.stringify({ serializedApproval: 'X', kernelAddress: KERNEL, expiry: 999 })
    )
    expect(readBaseMandate(OWNER_A)).toBeNull()
  })
})

describe('validateBaseMandate', () => {
  it('missing record -> "missing"', () => {
    expect(validateBaseMandate(null, {})).toBe('missing')
    expect(validateBaseMandate({ version: 1 }, {})).toBe('missing')
  })

  it('no binding expectations + not expired -> "active"', () => {
    seedMandate(OWNER_A)
    expect(validateBaseMandate(readBaseMandate(OWNER_A), {})).toBe('active')
  })

  it('owner mismatch -> "mismatched"', () => {
    seedMandate(OWNER_A)
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, { stellarOwner: OWNER_B })).toBe('mismatched')
  })

  it('kernel mismatch -> "mismatched"', () => {
    seedMandate(OWNER_A)
    const record = readBaseMandate(OWNER_A)
    expect(
      validateBaseMandate(record, { kernelAddress: '0x0000000000000000000000000000000000000BB2' })
    ).toBe('mismatched')
  })

  it('session-address mismatch -> "mismatched"', () => {
    seedMandate(OWNER_A)
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, { sessionKeyAddress: '0xNOTTHESAMESESSION' })).toBe(
      'mismatched'
    )
  })

  it('relayer-origin mismatch -> "mismatched"', () => {
    seedMandate(OWNER_A)
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, { relayerOrigin: 'https://evil.example' })).toBe(
      'mismatched'
    )
  })

  it('expired record -> "expired" (mismatch still wins over expiry when both are true)', () => {
    seedMandate(OWNER_A, { expiresAt: 1 })
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, { now: 1000 })).toBe('expired')
    expect(
      validateBaseMandate(record, {
        now: 1000,
        kernelAddress: '0x0000000000000000000000000000000000000BB2',
      })
    ).toBe('mismatched')
  })

  it('explicit revoked status -> "revoked", checked before expiry', () => {
    seedMandate(OWNER_A, { status: 'revoked', expiresAt: 9_999_999_999 })
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, {})).toBe('revoked')
  })

  it('an already-unknown stored status is never silently upgraded to active', () => {
    seedMandate(OWNER_A, { status: 'unknown' })
    const record = readBaseMandate(OWNER_A)
    expect(validateBaseMandate(record, {})).toBe('unknown')
  })

  it('case-normalized EVM address comparison: differently-cased kernel/session addresses still match', () => {
    seedMandate(OWNER_A, {
      kernelAddress: '0xAbCd000000000000000000000000000000AA1',
      sessionKeyAddress: '0xSeSsIoNaDdReSs',
    })
    const record = readBaseMandate(OWNER_A)
    expect(
      validateBaseMandate(record, {
        kernelAddress: '0xabcd000000000000000000000000000000aa1',
        sessionKeyAddress: '0xsessionaddress',
      })
    ).toBe('active')
  })
})

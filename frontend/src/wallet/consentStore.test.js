import { describe, it, expect } from 'vitest'
import {
  CONSENT_KEY,
  REQUEST_TTL_MS,
  consentId,
  readConsent,
  grantConsent,
  createRequestSnapshot,
  validateRequestSnapshot,
} from './consentStore.js'

function fakeStorage(seed = {}) {
  const store = { ...seed }
  return {
    store,
    storageLocal: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (obj) => Object.assign(store, obj),
    },
  }
}

const ORIGIN_A = 'https://a.example'
const ORIGIN_B = 'https://b.example'
const ACCOUNT_G = { id: 'stellar-testnet:G1', address: 'G1', kind: 'G', signer: 'classic-ed25519' }
const ACCOUNT_C = {
  id: 'stellar-testnet:C1',
  address: 'C1',
  kind: 'C',
  signer: 'passkey-secp256r1',
}

const SENDER = { origin: ORIGIN_A, tab: { id: 3 }, frameId: 0, documentId: 'doc-1' }

describe('consentId', () => {
  it('scopes by the (origin, accountId) pair, not origin alone', () => {
    expect(consentId(ORIGIN_A, ACCOUNT_G.id)).not.toBe(consentId(ORIGIN_A, ACCOUNT_C.id))
    expect(consentId(ORIGIN_A, ACCOUNT_G.id)).not.toBe(consentId(ORIGIN_B, ACCOUNT_G.id))
  })
})

describe('grantConsent / readConsent — origin+account scoping', () => {
  it('origin A / account G does not authorize origin A / account C', async () => {
    const { storageLocal } = fakeStorage()
    await grantConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1000 })
    await expect(
      readConsent({ origin: ORIGIN_A, account: ACCOUNT_C, storageLocal, now: 1001 })
    ).resolves.toBeNull()
  })

  it('origin A / account G does not authorize origin B / account G', async () => {
    const { storageLocal } = fakeStorage()
    await grantConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1000 })
    await expect(
      readConsent({ origin: ORIGIN_B, account: ACCOUNT_G, storageLocal, now: 1001 })
    ).resolves.toBeNull()
  })

  it('grants exactly the requested origin+account pair, readable back', async () => {
    const { storageLocal, store } = fakeStorage()
    const record = await grantConsent({
      origin: ORIGIN_A,
      account: ACCOUNT_G,
      storageLocal,
      now: 1000,
    })
    expect(record).toMatchObject({
      version: 2,
      origin: ORIGIN_A,
      accountId: ACCOUNT_G.id,
      accountAddress: 'G1',
      accountKind: 'G',
      capabilities: ['readAddress', 'requestSignatures'],
      expiresAt: null,
    })
    expect(store[CONSENT_KEY][consentId(ORIGIN_A, ACCOUNT_G.id)]).toEqual(record)
    await expect(
      readConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1001 })
    ).resolves.toEqual(record)
  })

  it('a granted record with a numeric expiresAt in the past is not readable back', async () => {
    const { storageLocal, store } = fakeStorage()
    await grantConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1000 })
    store[CONSENT_KEY][consentId(ORIGIN_A, ACCOUNT_G.id)].expiresAt = 500
    await expect(
      readConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1001 })
    ).resolves.toBeNull()
  })

  it('readConsent is null with no grant at all', async () => {
    const { storageLocal } = fakeStorage()
    await expect(
      readConsent({ origin: ORIGIN_A, account: ACCOUNT_G, storageLocal, now: 1 })
    ).resolves.toBeNull()
  })
})

describe('createRequestSnapshot', () => {
  it('captures Chrome-verified sender identity and a five-minute expiry', () => {
    const snap = createRequestSnapshot({
      rid: 'rid-1',
      method: 'signTransaction',
      params: { xdr: 'X' },
      sender: SENDER,
      account: ACCOUNT_C,
      now: 1000,
    })
    expect(snap).toEqual({
      version: 1,
      rid: 'rid-1',
      method: 'signTransaction',
      params: { xdr: 'X' },
      requester: { origin: ORIGIN_A, tabId: 3, frameId: 0, documentId: 'doc-1' },
      account: ACCOUNT_C,
      createdAt: 1000,
      expiresAt: 1000 + REQUEST_TTL_MS,
    })
  })
})

function baseSnapshot(overrides = {}) {
  return createRequestSnapshot({
    rid: 'rid-1',
    method: 'signTransaction',
    params: {},
    sender: SENDER,
    account: ACCOUNT_C,
    now: 1000,
    ...overrides,
  })
}

describe('validateRequestSnapshot', () => {
  it('accepts a fresh snapshot whose sender and active account still match', () => {
    const snap = baseSnapshot()
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: SENDER, now: 1001 })
    ).toEqual({ ok: true })
  })

  it('rejects a missing snapshot', () => {
    expect(validateRequestSnapshot(null, { activeAccount: ACCOUNT_C, now: 1 })).toMatchObject({
      ok: false,
      code: -3,
    })
  })

  it('rejects a malformed snapshot (wrong version, missing account)', () => {
    const snap = baseSnapshot()
    expect(
      validateRequestSnapshot({ ...snap, version: 2 }, { activeAccount: ACCOUNT_C, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
    expect(
      validateRequestSnapshot({ ...snap, account: null }, { activeAccount: ACCOUNT_C, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects an expired snapshot — a stale/replayed result past its TTL is never honored', () => {
    const snap = baseSnapshot()
    const pastExpiry = snap.expiresAt + 1
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: SENDER, now: pastExpiry })
    ).toMatchObject({ ok: false, code: -3, error: expect.stringMatching(/expired/i) })
  })

  it('rejects a changed origin', () => {
    const snap = baseSnapshot()
    const badSender = { ...SENDER, origin: ORIGIN_B }
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: badSender, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects a changed tab', () => {
    const snap = baseSnapshot()
    const badSender = { ...SENDER, tab: { id: 999 } }
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: badSender, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects a changed frame', () => {
    const snap = baseSnapshot()
    const badSender = { ...SENDER, frameId: 5 }
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: badSender, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects a changed document', () => {
    const snap = baseSnapshot()
    const badSender = { ...SENDER, documentId: 'doc-2' }
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: badSender, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects an account switch — the active account no longer matches the snapshot', () => {
    const snap = baseSnapshot()
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_G, sender: SENDER, now: 1001 })
    ).toMatchObject({ ok: false, code: -3, error: expect.stringMatching(/account changed/i) })
    expect(
      validateRequestSnapshot(snap, { activeAccount: null, sender: SENDER, now: 1001 })
    ).toMatchObject({ ok: false, code: -3 })
  })

  it('rejects a requested opts.address that disagrees with the snapshot account', () => {
    const snap = baseSnapshot({ params: { xdr: 'X', opts: { address: 'GNOTOURS' } } })
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: SENDER, now: 1001 })
    ).toMatchObject({ ok: false, code: -3, error: expect.stringMatching(/address/i) })
  })

  it('accepts a matching opts.address', () => {
    const snap = baseSnapshot({ params: { xdr: 'X', opts: { address: ACCOUNT_C.address } } })
    expect(
      validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, sender: SENDER, now: 1001 })
    ).toEqual({ ok: true })
  })

  it('skips sender/context checks when no sender is supplied (e.g. approve.js pre-sign check)', () => {
    const snap = baseSnapshot()
    expect(validateRequestSnapshot(snap, { activeAccount: ACCOUNT_C, now: 1001 })).toEqual({
      ok: true,
    })
  })
})

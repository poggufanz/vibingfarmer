// frontend/src/stellar/ownerAuthorization.test.js
// OwnerAuthorizationV1 matrix: G signs a classic envelope sourced by itself; C signs a Soroban
// auth entry on a transaction sourced by a funded relayer G. Never the other way round.
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Account, TransactionBuilder, BASE_FEE, Keypair } from '@stellar/stellar-sdk'

const submitViaRelayMock = vi.fn()
vi.mock('./relay.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, submitViaRelay: (...a) => submitViaRelayMock(...a) }
})

const submitUserTxMock = vi.fn()
vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, submitUserTx: (...a) => submitUserTxMock(...a) }
})

const signTransactionForContractMock = vi.fn()
vi.mock('../wallet/signGeneric.js', () => ({
  signTransactionForContract: (...a) => signTransactionForContractMock(...a),
}))

import { RelayRejectedError } from './relay.js'
import {
  OwnerActionSubmissionError,
  resolveOwnerTxModel,
  submitOwnerAuthorizedTx,
  signOwnerAuthEntry,
} from './ownerAuthorization.js'

const OWNER_G = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_C = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const RELAYER_G = Keypair.random().publicKey() // any well-formed G — never asserted by value
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'

beforeEach(() => {
  submitViaRelayMock.mockReset()
  submitUserTxMock.mockReset()
  signTransactionForContractMock.mockReset()
})

describe('resolveOwnerTxModel', () => {
  test('G account: source is the owner itself, the relay is never consulted', async () => {
    const getRelayerAddress = vi.fn()
    const model = await resolveOwnerTxModel({
      owner: OWNER_G,
      activeAccount: { kind: 'G', address: OWNER_G },
      getRelayerAddress,
    })
    expect(model).toMatchObject({ kind: 'G', source: OWNER_G })
    expect(getRelayerAddress).not.toHaveBeenCalled()
  })

  test('C account: source is the funded relayer G, never the C address itself', async () => {
    const getRelayerAddress = vi.fn(async () => RELAYER_G)
    const model = await resolveOwnerTxModel({
      owner: OWNER_C,
      activeAccount: { kind: 'C', address: OWNER_C },
      getRelayerAddress,
    })
    // The classic envelope source is ALWAYS a G address for a C owner — never the C contract id.
    expect(model.source).toBe(RELAYER_G)
    expect(model.source).not.toBe(OWNER_C)
    expect(model.kind).toBe('C')
    expect(model.contractId).toBe(OWNER_C)
  })

  test('C account with no funded relayer: fails BEFORE any ceremony, not-submitted', async () => {
    const getRelayerAddress = vi.fn(async () => null)
    let err
    try {
      await resolveOwnerTxModel({
        owner: OWNER_C,
        activeAccount: { kind: 'C', address: OWNER_C },
        getRelayerAddress,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OwnerActionSubmissionError)
    expect(err).toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE', submission: 'not-submitted' })
  })

  test('fails closed when the active account does not match the owner', async () => {
    await expect(
      resolveOwnerTxModel({
        owner: OWNER_G,
        activeAccount: { kind: 'G', address: 'GSOMEONEELSE' },
        getRelayerAddress: vi.fn(),
      })
    ).rejects.toThrow(/does not match/i)
  })
})

describe('submitOwnerAuthorizedTx — G, direct (revoke/exit/exit-signer/full-sweep)', () => {
  test('classicSubmission "direct" never touches the relay', async () => {
    submitUserTxMock.mockResolvedValue({ hash: 'HD', status: 'SUCCESS' })
    const model = { kind: 'G', source: OWNER_G, owner: OWNER_G }
    const build = vi.fn(async () => ({ xdr: 'UNSIGNED' }))
    const sign = vi.fn(async (built) => `SIGNED:${built.xdr}`)

    const out = await submitOwnerAuthorizedTx({
      model,
      build,
      sign,
      classicSubmission: 'direct',
    })

    expect(submitViaRelayMock).not.toHaveBeenCalled()
    expect(submitUserTxMock).toHaveBeenCalledWith(
      expect.objectContaining({ signedXdr: 'SIGNED:UNSIGNED' })
    )
    expect(out).toMatchObject({ hash: 'HD', status: 'SUCCESS', channel: 'direct' })
  })
})

describe('submitOwnerAuthorizedTx — G, prefer-relay (grant)', () => {
  test('relay success: returned as-is, direct never attempted', async () => {
    submitViaRelayMock.mockResolvedValue({ hash: 'HR', status: 'SUCCESS', relayer: RELAYER_G })
    const model = { kind: 'G', source: OWNER_G, owner: OWNER_G }
    const out = await submitOwnerAuthorizedTx({
      model,
      build: async () => ({ xdr: 'UNSIGNED' }),
      sign: async (built) => `SIGNED:${built.xdr}`,
      classicSubmission: 'prefer-relay',
    })
    expect(submitUserTxMock).not.toHaveBeenCalled()
    expect(out).toMatchObject({ hash: 'HR', status: 'SUCCESS', channel: 'relay' })
  })

  test('relay unreachable (null): safely falls back to a direct, user-paid submit', async () => {
    submitViaRelayMock.mockResolvedValue(null)
    submitUserTxMock.mockResolvedValue({ hash: 'HD', status: 'SUCCESS' })
    const model = { kind: 'G', source: OWNER_G, owner: OWNER_G }
    const out = await submitOwnerAuthorizedTx({
      model,
      build: async () => ({ xdr: 'UNSIGNED' }),
      sign: async (built) => `SIGNED:${built.xdr}`,
      classicSubmission: 'prefer-relay',
    })
    expect(submitUserTxMock).toHaveBeenCalledWith(
      expect.objectContaining({ signedXdr: 'SIGNED:UNSIGNED' })
    )
    expect(out).toMatchObject({ hash: 'HD', status: 'SUCCESS', channel: 'direct' })
  })

  test('relay explicit refusal: throws typed, never falls back to billing the user directly', async () => {
    submitViaRelayMock.mockRejectedValue(new RelayRejectedError('policy refused', 429))
    const model = { kind: 'G', source: OWNER_G, owner: OWNER_G }
    await expect(
      submitOwnerAuthorizedTx({
        model,
        build: async () => ({ xdr: 'UNSIGNED' }),
        sign: async (built) => `SIGNED:${built.xdr}`,
        classicSubmission: 'prefer-relay',
        label: 'grant',
      })
    ).rejects.toMatchObject({
      name: 'OwnerActionSubmissionError',
      code: 'VF_RELAY_REFUSED',
      submission: 'not-submitted',
    })
    expect(submitUserTxMock).not.toHaveBeenCalled()
  })
})

describe('submitOwnerAuthorizedTx — C, relay-only (every C owner action)', () => {
  test('submits via the relay even when classicSubmission says "direct" — C has no direct fallback', async () => {
    submitViaRelayMock.mockResolvedValue({ hash: 'HC', status: 'SUCCESS' })
    const model = { kind: 'C', source: RELAYER_G, owner: OWNER_C, contractId: OWNER_C }
    const build = vi.fn(async () => ({ tx: {}, xdr: 'UNSIGNED' }))
    const sign = vi.fn(async () => 'SIGNED_C')

    const out = await submitOwnerAuthorizedTx({
      model,
      build,
      sign,
      classicSubmission: 'direct', // must be ignored for C
    })

    expect(submitUserTxMock).not.toHaveBeenCalled()
    expect(submitViaRelayMock).toHaveBeenCalledWith({ xdr: 'SIGNED_C' })
    expect(out).toMatchObject({ hash: 'HC', status: 'SUCCESS', channel: 'relay' })
  })

  test('explicit relay refusal: typed not-submitted', async () => {
    submitViaRelayMock.mockRejectedValue(new RelayRejectedError('guard rejected', 403))
    const model = { kind: 'C', source: RELAYER_G, owner: OWNER_C, contractId: OWNER_C }
    await expect(
      submitOwnerAuthorizedTx({
        model,
        build: async () => ({ tx: {}, xdr: 'UNSIGNED' }),
        sign: async () => 'SIGNED_C',
      })
    ).rejects.toMatchObject({ code: 'VF_RELAY_REFUSED', submission: 'not-submitted' })
  })

  test('relay unreachable AFTER signing: unknown, not not-submitted — no automatic retry', async () => {
    submitViaRelayMock.mockResolvedValue(null)
    const model = { kind: 'C', source: RELAYER_G, owner: OWNER_C, contractId: OWNER_C }
    const sign = vi.fn(async () => 'SIGNED_C')
    await expect(
      submitOwnerAuthorizedTx({
        model,
        build: async () => ({ tx: {}, xdr: 'UNSIGNED' }),
        sign,
      })
    ).rejects.toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    expect(sign).toHaveBeenCalled() // the ceremony DID run — this is why it can't be "not-submitted"
  })
})

describe('signOwnerAuthEntry — C ceremony: sign the entry, then re-simulate from a fresh parse', () => {
  test('delegates entry-signing to signGeneric, then re-prepares a fresh parse of the signed XDR', async () => {
    // A real, parseable (if auth-free) envelope — signOwnerAuthEntry must round-trip it through
    // TransactionBuilder.fromXDR, so a stub string is not enough for this half of the ceremony.
    const account = new Account(RELAYER_G, '5')
    const realTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(30)
      .build()
    const realXdr = realTx.toEnvelope().toXDR('base64')
    signTransactionForContractMock.mockResolvedValue(realXdr)

    const prepareTransaction = vi.fn(async (tx) => tx)
    const fakeServer = { prepareTransaction }
    const inputTx = { operations: [] } // opaque to signOwnerAuthEntry itself; passed straight through

    const out = await signOwnerAuthEntry({
      tx: inputTx,
      contractId: OWNER_C,
      server: fakeServer,
      kit: { signAuthEntry: vi.fn() },
    })

    expect(signTransactionForContractMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx: inputTx, contractId: OWNER_C })
    )
    expect(prepareTransaction).toHaveBeenCalledTimes(1)
    expect(out).toBe(realXdr) // fakeServer.prepareTransaction is an identity passthrough here
  })
})

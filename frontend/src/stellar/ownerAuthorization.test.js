// frontend/src/stellar/ownerAuthorization.test.js
// OwnerAuthorizationV1 matrix: G signs a classic envelope sourced by itself; C signs a Soroban
// auth entry on a transaction sourced by a funded relayer G. Never the other way round.
import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  Account,
  Address,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

const walletMocks = vi.hoisted(() => ({ readSelectedWallet: vi.fn() }))
vi.mock('./walletKit.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readSelectedWallet: walletMocks.readSelectedWallet }
})

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
const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
const activeV1 = (kind = 'G', address = OWNER_G, epoch = 1) =>
  Object.freeze({
    version: 1,
    kind,
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
    connectorId: kind === 'C' ? 'vf-wallet' : 'freighter',
    epoch,
  })

beforeEach(() => {
  submitViaRelayMock.mockReset()
  submitUserTxMock.mockReset()
  signTransactionForContractMock.mockReset()
  walletMocks.readSelectedWallet.mockReset()
})

function authEntryFor(contractId) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: 'revoke',
        args: [nativeToScVal(1, { type: 'u32' })],
      })
    ),
    subInvocations: [],
  })
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(contractId).toScAddress(),
    nonce: xdr.Int64.fromString('1'),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
    rootInvocation: invocation,
  })
}

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

  test('rejects an execution-network mismatch before resolving a relayer or ceremony', async () => {
    const getRelayerAddress = vi.fn(async () => RELAYER_G)
    await expect(
      resolveOwnerTxModel({
        owner: OWNER_C,
        activeAccount: Object.freeze({
          ...activeV1('C', OWNER_C, 9),
          networkPassphrase: PUBLIC_NETWORK_PASSPHRASE,
        }),
        getRelayerAddress,
        getCurrentActiveAccount: () =>
          Object.freeze({
            ...activeV1('C', OWNER_C, 9),
            networkPassphrase: PUBLIC_NETWORK_PASSPHRASE,
          }),
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(getRelayerAddress).not.toHaveBeenCalled()
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

  test.each(['build', 'sign', 'submit'])(
    'rejects C1→C2 during %s before any later boundary or stale completion',
    async (stage) => {
      const captured = activeV1('C', OWNER_C, 11)
      let current = captured
      const changed = activeV1('C', 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5', 12)
      const model = {
        kind: 'C',
        source: RELAYER_G,
        owner: OWNER_C,
        contractId: OWNER_C,
      }
      const build = vi.fn(async () => {
        if (stage === 'build') current = changed
        return { tx: {}, xdr: 'UNSIGNED' }
      })
      const sign = vi.fn(async () => {
        if (stage === 'sign') current = changed
        return 'SIGNED_C'
      })
      submitViaRelayMock.mockImplementation(async () => {
        if (stage === 'submit') current = changed
        return { hash: 'HC', status: 'SUCCESS' }
      })

      const expectedError =
        stage === 'submit'
          ? { code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' }
          : { code: 'ACTIVE_ACCOUNT_CHANGED' }
      await expect(
        submitOwnerAuthorizedTx({
          model,
          build,
          sign,
          activeAccount: captured,
          getCurrentActiveAccount: () => current,
        })
      ).rejects.toMatchObject(expectedError)
      if (stage === 'build') expect(sign).not.toHaveBeenCalled()
      if (stage !== 'submit') expect(submitViaRelayMock).not.toHaveBeenCalled()
    }
  )

  test('checks the capability at the transport boundary and passes its abort signal', async () => {
    const captured = activeV1('C', OWNER_C, 14)
    const controller = new AbortController()
    submitViaRelayMock.mockResolvedValue({ hash: 'HC', status: 'SUCCESS' })

    await submitOwnerAuthorizedTx({
      model: { kind: 'C', source: RELAYER_G, owner: OWNER_C, contractId: OWNER_C },
      build: async () => ({ tx: {}, xdr: 'UNSIGNED' }),
      sign: async () => 'SIGNED_C',
      activeAccount: captured,
      getCurrentActiveAccount: () => captured,
      signal: controller.signal,
    })

    expect(submitViaRelayMock).toHaveBeenCalledWith({
      xdr: 'SIGNED_C',
      signal: controller.signal,
    })
  })

  test('aborts after a C auth ceremony and never reaches relay submission', async () => {
    const captured = activeV1('C', OWNER_C, 21)
    const controller = new AbortController()
    const sign = vi.fn(async () => {
      controller.abort()
      return 'SIGNED_C'
    })

    await expect(
      submitOwnerAuthorizedTx({
        model: { kind: 'C', source: RELAYER_G, owner: OWNER_C, contractId: OWNER_C },
        build: async () => ({ tx: {}, xdr: 'UNSIGNED' }),
        sign,
        activeAccount: captured,
        getCurrentActiveAccount: () => captured,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })
})

describe('signOwnerAuthEntry — C ceremony: sign the entry, then re-simulate from a fresh parse', () => {
  test('V1 C signs through the exact selected module and returns a freshly prepared envelope', async () => {
    const activeAccount = activeV1('C', OWNER_C, 31)
    const account = new Account(RELAYER_G, '5')
    const realTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .setTimeout(30)
      .build()
    const realXdr = realTx.toEnvelope().toXDR('base64')
    const signAuthEntry = vi.fn(async (entry) => ({
      signedAuthEntry: entry,
      signerAddress: OWNER_C,
    }))
    const module = { productId: 'vf-wallet', signAuthEntry }
    const binding = { getSelectedModule: () => module }
    walletMocks.readSelectedWallet.mockResolvedValue({
      binding,
      module,
      connectorId: 'vf-wallet',
      address: OWNER_C,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    const prepareTransaction = vi.fn(async (tx) => tx)
    const tx = {
      operations: [{ auth: [authEntryFor(OWNER_C)] }],
      toEnvelope: () => ({ toXDR: () => realXdr }),
    }

    await expect(
      signOwnerAuthEntry({
        tx,
        contractId: OWNER_C,
        server: { prepareTransaction },
        activeAccount,
        getCurrentActiveAccount: () => activeAccount,
      })
    ).resolves.toBe(realXdr)
    expect(signAuthEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        address: OWNER_C,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
    )
  })

  test('delegates entry-signing to signGeneric, then re-prepares a fresh parse of the signed XDR', async () => {
    // A real, parseable (if auth-free) envelope — signOwnerAuthEntry must round-trip it through
    // TransactionBuilder.fromXDR, so a stub string is not enough for this half of the ceremony.
    const account = new Account(RELAYER_G, '5')
    const realTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
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

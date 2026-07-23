// frontend/src/wallet/exitKey.test.js
// registerExitSigner is an owner action routed through OwnerAuthorizationV1 — the model-selection
// and submission-channel matrix itself is covered in stellar/ownerAuthorization.test.js; this file
// proves exitKey.js wires it correctly. generateExitKey/save/load/clear already have coverage in
// strategy/autoExit/exitKey.test.js (same module) — not duplicated here.
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('../stellar/walletKit.js', () => ({ signTxXdr: vi.fn(async () => 'SIGNED') }))
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('../stellar/relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
  RelayRejectedError: class RelayRejectedError extends Error {},
}))
const signOwnerAuthEntryMock = vi.fn()
vi.mock('../stellar/ownerAuthorization.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, signOwnerAuthEntry: (...a) => signOwnerAuthEntryMock(...a) }
})
// submitUserTx underlies the direct channel inside the real (unmocked) ownerAuthorization.js.
vi.mock('../stellar/client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ tx: {}, xdr: 'UNSIGNED' })),
  submitUserTx: vi.fn(async () => ({ hash: 'rh1', status: 'SUCCESS' })),
  rpcServer: vi.fn(),
}))

import { Keypair } from '@stellar/stellar-sdk'
import { registerExitSigner } from './exitKey.js'
import { buildInvokeTx, submitUserTx } from '../stellar/client.js'
import { signTxXdr } from '../stellar/walletKit.js'

const OWNER_G = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_C = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
// A syntactically valid ed25519 public key strkey — registerExitSigner only decodes it, never
// asserted on by value here.
const EXIT_PUBKEY = Keypair.random().publicKey()

beforeEach(() => {
  buildInvokeTx.mockClear()
  submitUserTx.mockReset()
  submitUserTx.mockResolvedValue({ hash: 'rh1', status: 'SUCCESS' })
  signTxXdr.mockClear()
  submitViaRelayMock.mockReset()
  getRelayerAddressMock.mockReset()
  signOwnerAuthEntryMock.mockReset()
})

describe('registerExitSigner — G owner (default, direct)', () => {
  test('signs the envelope and submits directly; the relay is never consulted', async () => {
    const res = await registerExitSigner({
      owner: OWNER_G,
      agentAddress: AGENT,
      exitPublicKey: EXIT_PUBKEY,
    })
    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({ source: OWNER_G, contract: AGENT, method: 'set_exit_signer' })
    )
    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    expect(submitViaRelayMock).not.toHaveBeenCalled()
    expect(res).toMatchObject({ hash: 'rh1', status: 'SUCCESS' })
  })
})

describe('registerExitSigner — C owner (passkey, relay-only)', () => {
  test('sources from the relayer, signs a passkey auth entry, submits relay-only', async () => {
    getRelayerAddressMock.mockResolvedValue('GRELAYER')
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C')
    submitViaRelayMock.mockResolvedValue({ hash: 'rc1', status: 'SUCCESS' })

    const res = await registerExitSigner({
      owner: OWNER_C,
      agentAddress: AGENT,
      exitPublicKey: EXIT_PUBKEY,
      activeAccount: { kind: 'C', address: OWNER_C },
    })

    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'GRELAYER', contract: AGENT, method: 'set_exit_signer' })
    )
    expect(signOwnerAuthEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: OWNER_C })
    )
    expect(submitUserTx).not.toHaveBeenCalled()
    expect(res).toMatchObject({ hash: 'rc1', status: 'SUCCESS' })
  })

  test('fails BEFORE the passkey ceremony when no relayer is funded', async () => {
    getRelayerAddressMock.mockResolvedValue(null)
    await expect(
      registerExitSigner({
        owner: OWNER_C,
        agentAddress: AGENT,
        exitPublicKey: EXIT_PUBKEY,
        activeAccount: { kind: 'C', address: OWNER_C },
      })
    ).rejects.toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE' })
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
    expect(buildInvokeTx).not.toHaveBeenCalled()
  })
})

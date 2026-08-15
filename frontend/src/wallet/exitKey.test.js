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
import {
  registerExitSigner,
  saveManualExitKey,
  loadManualExitKey,
  clearManualExitKey,
  saveExitKey,
} from './exitKey.js'
import { buildInvokeTx, submitUserTx } from '../stellar/client.js'
import { signTxXdr } from '../stellar/walletKit.js'

const OWNER_G = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_C = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
// A syntactically valid ed25519 public key strkey — registerExitSigner only decodes it, never
// asserted on by value here.
const EXIT_PUBKEY = Keypair.random().publicKey()

const store = {}
beforeEach(() => {
  buildInvokeTx.mockClear()
  submitUserTx.mockReset()
  submitUserTx.mockResolvedValue({ hash: 'rh1', status: 'SUCCESS' })
  signTxXdr.mockClear()
  submitViaRelayMock.mockReset()
  getRelayerAddressMock.mockReset()
  signOwnerAuthEntryMock.mockReset()
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

// v2 owner-scoped MANUAL partial-exit key namespace (Pocket Crew "My money" Task 9). The legacy
// yv_exit_key_* cache above is agent-only; these tests prove the v2 cache is owner+agent scoped
// and fails closed on every form of untrustworthy stored data, per the task brief's literal
// requirement list: account switch, owner mismatch, corrupt secret/public-key mismatch, agent
// mismatch, and never falling back to reading the legacy namespace.
describe('saveManualExitKey / loadManualExitKey / clearManualExitKey — v2 owner-scoped', () => {
  const OWNER_A = 'GOWNERA'
  const OWNER_B = 'GOWNERB'
  const AGENT_1 = 'CAGENT1'
  const AGENT_2 = 'CAGENT2'
  // A real ed25519 keypair (test.rs-style fixture) so Keypair.fromSecret's derived public key can
  // be asserted against — a syntactically valid but arbitrary strkey, never asserted by value.
  const REAL = Keypair.random()

  test('round-trips: what is saved is what is loaded, for the same owner+agent', async () => {
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: REAL.publicKey(),
      secret: REAL.secret(),
    })
    const loaded = await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })
    expect(loaded).toEqual({ publicKey: REAL.publicKey(), secret: REAL.secret() })
  })

  test('account switch: a different owner reads nothing, never the previous owner’s key', async () => {
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: REAL.publicKey(),
      secret: REAL.secret(),
    })
    expect(await loadManualExitKey({ owner: OWNER_B, agent: AGENT_1 })).toBeNull()
  })

  test('agent mismatch: the same owner reading a different agent finds nothing', async () => {
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: REAL.publicKey(),
      secret: REAL.secret(),
    })
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_2 })).toBeNull()
  })

  test('owner mismatch INSIDE the stored payload fails closed even under the right storage key', async () => {
    // Simulate corruption/collision: the payload's own `owner` field disagrees with what this
    // storage key is supposed to hold. Never trust a value that doesn't vouch for itself.
    const key = `vf.manualExitKey.v2|stellar-testnet|${OWNER_A}|${AGENT_1}`
    localStorage.setItem(
      key,
      JSON.stringify({
        owner: 'GSOMEONEELSE',
        agent: AGENT_1,
        publicKey: REAL.publicKey(),
        secret: REAL.secret(),
      })
    )
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).toBeNull()
  })

  test('agent mismatch INSIDE the stored payload fails closed', async () => {
    const key = `vf.manualExitKey.v2|stellar-testnet|${OWNER_A}|${AGENT_1}`
    localStorage.setItem(
      key,
      JSON.stringify({
        owner: OWNER_A,
        agent: 'CSOMEOTHERAGENT',
        publicKey: REAL.publicKey(),
        secret: REAL.secret(),
      })
    )
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).toBeNull()
  })

  test('corrupt/undecodable secret fails closed rather than throwing', async () => {
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: REAL.publicKey(),
      secret: 'NOT_A_REAL_SECRET',
    })
    await expect(loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).resolves.toBeNull()
  })

  test('secret/public-key mismatch fails closed', async () => {
    const OTHER = Keypair.random()
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: OTHER.publicKey(),
      secret: REAL.secret(),
    })
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).toBeNull()
  })

  test('never reads the legacy yv_exit_key_* namespace as a v2 manual key', async () => {
    // Legacy, agent-only key present — but loadManualExitKey must look ONLY at its own v2,
    // owner-scoped storage key and never fall back to this one.
    saveExitKey(AGENT_1, { publicKey: REAL.publicKey(), secret: REAL.secret() })
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).toBeNull()
  })

  test('clearManualExitKey removes only the v2 entry, leaving the legacy cache untouched', async () => {
    saveManualExitKey({
      owner: OWNER_A,
      agent: AGENT_1,
      publicKey: REAL.publicKey(),
      secret: REAL.secret(),
    })
    saveExitKey(AGENT_1, { publicKey: 'GLEGACY', secret: 'SLEGACY' })
    clearManualExitKey({ owner: OWNER_A, agent: AGENT_1 })
    expect(await loadManualExitKey({ owner: OWNER_A, agent: AGENT_1 })).toBeNull()
    expect(localStorage.getItem(`yv_exit_key_${AGENT_1.toLowerCase()}`)).not.toBeNull()
  })

  test('absent key: null, no throw', async () => {
    expect(await loadManualExitKey({ owner: 'GNOBODY', agent: 'CNOBODY' })).toBeNull()
  })
})

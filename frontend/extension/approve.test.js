import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  screenModel,
  rejectionResult,
  screenKind,
  verifyStillValid,
  approveSignClassic,
} from './approve.js'
import { installChromeMock } from '../src/wallet/testUtils.js'
import { createRequestSnapshot } from '../src/wallet/consentStore.js'
import { importFromSecret } from '../src/wallet/classicAccount.js'
import { Account, TransactionBuilder, Operation } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'

const ORIGIN = 'https://vibing-farmer.pages.dev'

describe('approve — screen model', () => {
  it('no wallet stored → no-wallet variant with an onboarding CTA', () => {
    const m = screenModel({ method: 'getAddress', params: {}, origin: ORIGIN }, { address: null })
    expect(m.variant).toBe('no-wallet')
    expect(m.origin).toBe(ORIGIN)
    expect(m.approveLabel).toBe('Open VF Wallet')
  })

  it('getAddress → connect variant showing account + network', () => {
    const m = screenModel(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'CDLVXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXK3QP' }
    )
    expect(m.variant).toBe('connect')
    expect(m.title).toBe('Connection request')
    expect(m.approveLabel).toBe('Connect')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
    expect(m.rows.find(([k]) => k === 'Account')[1]).toMatch(/^CDLV…K3QP$/)
  })

  it('signTransaction with a decoded summary → sign variant with contract/function/args rows', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5',
          contractLabel: 'funding router',
          fn: 'grant',
          args: ['CDLV…K3QP', '5000000 (0.5)'],
          signer: null,
        },
      }
    )
    expect(m.variant).toBe('sign')
    expect(m.title).toBe('Signature request')
    expect(m.approveLabel).toBe('Approve')
    expect(m.raw).toBe('RAWXDR')
    expect(m.rows).toContainEqual(['Function', 'grant'])
    expect(m.rows.find(([k]) => k === 'Contract')[1]).toContain('funding router')
    expect(m.rows.filter(([k]) => k === 'Args' || k === '')).toHaveLength(2)
  })

  it('signAuthEntry with a null summary still renders a sign screen with the raw entry', () => {
    const m = screenModel(
      { method: 'signAuthEntry', params: { authEntry: 'RAWENTRY' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    expect(m.variant).toBe('sign')
    expect(m.raw).toBe('RAWENTRY')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
  })

  it('classic wallet, locked, sign request → needsPassword: true', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    expect(m.variant).toBe('sign')
    expect(m.needsPassword).toBe(true)
  })

  it('classic wallet sign request → note asks for wallet password, not Face ID', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: false }
    )
    expect(m.note).toBe('Approving asks for your wallet password.')
  })

  it('classic wallet, already unlocked, sign request → no needsPassword', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic', unlocked: true }
    )
    expect(m.variant).toBe('sign')
    expect(m.needsPassword).toBeFalsy()
  })

  it('classic wallet address (no passkey) on getAddress → connect variant, not no-wallet', () => {
    const m = screenModel(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'GCLASSIC', kind: 'classic' }
    )
    expect(m.variant).toBe('connect')
    expect(m.rows.find(([k]) => k === 'Account')[1]).toBe('GCLASSIC')
  })

  it('rejectionResult is the exact SEP-43 -4 CEREMONY_RESULT', () => {
    expect(rejectionResult('rid-9')).toEqual({
      type: 'CEREMONY_RESULT',
      rid: 'rid-9',
      ok: false,
      code: -4,
      error: 'User rejected the request',
    })
  })
})

describe('screenKind', () => {
  it('maps ActiveAccountV1 kind to the screen vocabulary', () => {
    expect(screenKind('G')).toBe('classic')
    expect(screenKind('C')).toBe('passkey')
    expect(screenKind(undefined)).toBeNull()
  })
})

// The reviewer's gate item on VFW2: approve.js must never re-derive an account locally (that was
// the "passkey wins" bug in the old resolveWallet()) — it must only trust resolveActiveAccount(),
// same resolver as background.js/popup.jsx, and fail closed when it can't produce one unambiguous
// answer. verifyStillValid is the function this task replaced resolveWallet with.
describe('verifyStillValid — pre-sign account re-check (resolveWallet demotion)', () => {
  beforeEach(() => {
    installChromeMock()
  })

  const G1 = 'GAAA1111111111111111111111111111111111111111111111111'
  const C1 = 'CCCC1111111111111111111111111111111111111111111111111'

  function snapshotFor(account) {
    return createRequestSnapshot({
      rid: 'rid-1',
      method: 'signTransaction',
      params: { xdr: 'X' },
      sender: { origin: ORIGIN, tab: { id: 1 } },
      account,
      now: Date.now(),
    })
  }

  it('accepts when the sole wallet on the device matches the snapshot account', async () => {
    await globalThis.chrome.storage.local.set({ vf_wallet_contract: C1 })
    const account = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(snapshotFor(account), globalThis.chrome.storage.local)
    expect(check).toEqual({ ok: true })
  })

  it('fails closed (never silently picks the passkey account) when both a classic and a passkey wallet exist and neither is the persisted active selection', async () => {
    await globalThis.chrome.storage.local.set({
      vf_wallet_contract: C1,
      vf_classic_wallets: { [G1]: { publicKey: G1, createdAt: 1 } },
    })
    const passkeyAccount = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(
      snapshotFor(passkeyAccount),
      globalThis.chrome.storage.local
    )
    expect(check).toMatchObject({ ok: false, code: -3 })
  })

  it('fails closed when the active account switched away from the snapshot account', async () => {
    await globalThis.chrome.storage.local.set({ vf_wallet_contract: 'COTHER' })
    const staleAccount = {
      id: `stellar-testnet:${C1}`,
      address: C1,
      kind: 'C',
      signer: 'passkey-secp256r1',
    }
    const check = await verifyStillValid(snapshotFor(staleAccount), globalThis.chrome.storage.local)
    expect(check).toMatchObject({
      ok: false,
      code: -3,
      error: expect.stringMatching(/account changed/i),
    })
  })

  it('honors an explicit persisted active-account selection over the other wallet', async () => {
    await globalThis.chrome.storage.local.set({
      vf_wallet_contract: C1,
      vf_classic_wallets: { [G1]: { publicKey: G1, createdAt: 1 } },
      vf_active_account_v1: {
        version: 1,
        id: `stellar-testnet:${G1}`,
        network: 'stellar-testnet',
        address: G1,
        kind: 'G',
        signer: 'classic-ed25519',
        selectedAt: 1,
      },
    })
    const classicAccount = {
      id: `stellar-testnet:${G1}`,
      address: G1,
      kind: 'G',
      signer: 'classic-ed25519',
    }
    const check = await verifyStillValid(
      snapshotFor(classicAccount),
      globalThis.chrome.storage.local
    )
    expect(check).toEqual({ ok: true })
  })
})

// verifyStillValid checks the ACTIVE ACCOUNT, not the classic wallet's unlocked SESSION KEY —
// a device can have multiple vf_classic_wallets entries, so a session left unlocked for a
// different G-address must never be used to sign on behalf of the snapshot's account.
// approveSignClassic pins withSecret's expectedPublicKey to that exact address.
describe('approveSignClassic — session-key pinned to the snapshot address', () => {
  beforeEach(() => {
    installChromeMock()
    // approveSignClassic's setStatus() touches document.getElementById — stub the minimum
    // instead of switching this file to the jsdom environment (jsdom's crypto/Buffer shims break
    // the real @stellar/stellar-sdk keypair generation importFromSecret needs below).
    vi.stubGlobal('document', { getElementById: () => null })
  })

  function unsignedTxXdr(sourcePublicKey) {
    return new TransactionBuilder(new Account(sourcePublicKey, '1'), {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build()
      .toXDR()
  }

  it('fails closed when the unlocked session belongs to a different G-address than the snapshot', async () => {
    await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'unlocked one',
    })
    const req = { method: 'signTransaction', params: { xdr: 'unused — never parsed' } }
    await expect(
      approveSignClassic(req, 'rid-1', 'GSOMEOTHERACCOUNTENTIRELYDIFFERENTFROMUNLOCKED')
    ).rejects.toThrow(/locked/i)
  })

  it('proceeds and signs when the unlocked session matches the snapshot address', async () => {
    const { publicKey } = await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'unlocked one',
    })
    const req = { method: 'signTransaction', params: { xdr: unsignedTxXdr(publicKey) } }
    const result = await approveSignClassic(req, 'rid-1', publicKey)
    expect(result).toMatchObject({
      type: 'CEREMONY_RESULT',
      rid: 'rid-1',
      ok: true,
      address: publicKey,
    })
    expect(result.signedTxXdr).toBeTruthy()
  })
})

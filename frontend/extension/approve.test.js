import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rejectionResult, screenKind, verifyStillValid, approveSignClassic } from './approve.js'
import { installChromeMock } from '../src/wallet/testUtils.js'
import { createRequestSnapshot } from '../src/wallet/consentStore.js'
import { importFromSecret } from '../src/wallet/classicAccount.js'
import { Account, TransactionBuilder, Operation } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'

const ORIGIN = 'https://vibing-farmer.pages.dev'
const here = path.dirname(fileURLToPath(import.meta.url))

// VF Wallet Task 12 -- the pure view-model/DOM-rendering concerns this describe block used to
// cover (screenModel, grantRows) moved wholesale to approvalView.js/approvalView.test.js: this
// file is now orchestration-only (chrome messaging, the sign/unlock ceremonies, and the pre-sign
// snapshot re-check). See approvalView.test.js for buildApprovalView/grant-decode coverage.

describe('rejectionResult', () => {
  it('is the exact SEP-43 -4 CEREMONY_RESULT', () => {
    expect(rejectionResult('rid-9')).toEqual({
      type: 'CEREMONY_RESULT',
      rid: 'rid-9',
      ok: false,
      code: -4,
      error: 'User rejected the request',
    })
  })
})

// ---------------------------------------------------------------------------------------------
// VF Wallet Task 12 -- structural, mutation-provable guards on approve.html/approve.js source
// text. Real Chromium (per this task's A1 sweep) proves layout at 320px; these prove two things a
// pixel measurement cannot: (a) Cancel/Reject is never absent or reordered after Confirm/Approve
// in the static markup approve.js wires up, and (b) the generic dapp signTransaction/
// signAuthEntry ceremony this file drives never claims a Submitted/Confirmed/reconciled state it
// structurally cannot back (no internal flow here owns real submission + a tx hash).
// ---------------------------------------------------------------------------------------------
describe('approve.html — Cancel/Reject is present before (or alongside) Confirm/Approve, never after', () => {
  it('the reject button appears before the approve button in document order', () => {
    const html = readFileSync(path.resolve(here, './approve.html'), 'utf8')
    const rejectIdx = html.indexOf('id="reject"')
    const approveIdx = html.indexOf('id="approve"')
    expect(rejectIdx).toBeGreaterThan(-1)
    expect(approveIdx).toBeGreaterThan(-1)
    expect(rejectIdx).toBeLessThan(approveIdx)
  })

  it("mutation-proof: swapping the two buttons' order would fail the check above", () => {
    const html = readFileSync(path.resolve(here, './approve.html'), 'utf8')
    const mutated = html
      .replace('id="reject"', '__TMP__')
      .replace('id="approve"', 'id="reject"')
      .replace('__TMP__', 'id="approve"')
    const rejectIdx = mutated.indexOf('id="reject"')
    const approveIdx = mutated.indexOf('id="approve"')
    expect(rejectIdx).toBeGreaterThan(approveIdx) // RED on the mutated markup
  })

  it('neither button carries autofocus — Confirm is never pre-selected as the easy/default action', () => {
    const html = readFileSync(path.resolve(here, './approve.html'), 'utf8')
    expect(html).not.toMatch(/autofocus/i)
  })
})

describe('approve.js — never claims a submission/confirmation state this ceremony cannot back', () => {
  // The generic dapp ceremony (this file's only caller today) ends at "Signed and returned" —
  // see approvalView.js's DAPP_REACHABLE_STATES. It must never literally set the page's status to
  // one of the internal-flow-only states, which would falsely claim a completed, reconciled
  // on-chain outcome for a request this extension never submitted anywhere. Checked against the
  // text actually passed to setStatus() calls specifically (not the whole file, which legitimately
  // *discusses* these reserved states in comments) — a substring match against a doc comment would
  // be a false positive, not a real defect.
  const FORBIDDEN = [/\bSubmitted\b/, /\bConfirmed\b/, /\bChecking status\b/, /\bNot submitted\b/]

  function setStatusArgs(source) {
    return [...source.matchAll(/setStatus\(([^)]*)\)/g)].map((m) => m[1])
  }

  it('no setStatus(...) call anywhere in the file passes one of the internal-flow-only labels', () => {
    const source = readFileSync(path.resolve(here, './approve.js'), 'utf8')
    for (const arg of setStatusArgs(source)) {
      for (const pattern of FORBIDDEN) expect(arg).not.toMatch(pattern)
    }
  })

  it('mutation-proof: injecting one of those literal strings into a setStatus call would fail the check above', () => {
    const mutatedSource = "setStatus('Submitted')"
    const args = setStatusArgs(mutatedSource)
    expect(args.some((arg) => FORBIDDEN.some((pattern) => pattern.test(arg)))).toBe(true) // RED
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

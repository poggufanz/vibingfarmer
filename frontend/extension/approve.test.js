import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  rejectionResult,
  screenKind,
  verifyStillValid,
  approveSignClassic,
  wireAcknowledgmentGate,
} from './approve.js'
import { installChromeMock } from '../src/wallet/testUtils.js'
import { createRequestSnapshot } from '../src/wallet/consentStore.js'
import { importFromSecret } from '../src/wallet/classicAccount.js'
import { Account, TransactionBuilder, Operation } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'
import { SUBMISSION_STATE, DAPP_REACHABLE_STATES } from './approvalView.js'

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

// ---------------------------------------------------------------------------------------------
// Review fix round 1 -- I3. The prior guard here (`FORBIDDEN` word-boundary regexes matched
// against a naive `[^)]*` capture of each setStatus(...) argument) was a BLOCKLIST: it could only
// catch the exact literal string it was written against. The reviewer neutered it three ways
// without touching the literal:
//   setStatus(submissionStatusText(SUBMISSION_STATE.SUBMITTED))   -- the uppercase enum name misses
//                                                                     the \bSubmitted\b regex
//   const done = 'Submitted'; setStatus(done)                     -- a named constant, no literal
//                                                                     text at the call site at all
//   setStatus(statusFor(state, { tx: hash }))                     -- an opaque helper the regex
//                                                                     has no way to evaluate
// All three passed GREEN. This is now an ALLOWLIST instead: every setStatus(...) call must be
// either one of the handful of literal strings this file legitimately uses outside the submission
// vocabulary (Connected., the password retry prompt, the pre-screen expiry message), or
// `submissionStatusText(SUBMISSION_STATE.<X>, ...)` where <X> is a member of DAPP_REACHABLE_STATES.
// Anything else -- a bare literal that slipped past the allowlist, a differently-named helper, a
// non-dapp-reachable state -- fails by construction, because it simply isn't the one recognized
// good shape. This closes all three of the reviewer's mutations plus the original literal.
describe('approve.js — every setStatus(...) call is either an allowlisted literal or a dapp-reachable submissionStatusText(...) call', () => {
  const ALLOWED_LITERALS = new Set([
    'Connected.',
    'Request expired: close this window and retry from the site.',
  ])

  // Extracts each setStatus(...) call's full argument text with BALANCED paren matching -- the
  // old `[^)]*` capture silently truncated at the first `)`, which would have mis-parsed this
  // task's own `submissionStatusText(SUBMISSION_STATE.X, { detail: '...' })` nested calls.
  function setStatusArgs(source) {
    const args = []
    const callRe = /setStatus\(/g
    let m
    while ((m = callRe.exec(source))) {
      let depth = 1
      let i = m.index + m[0].length
      const start = i
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth++
        else if (source[i] === ')') depth--
        i++
      }
      args.push(source.slice(start, i - 1))
    }
    return args
  }

  // The single recognized-good shape. Anything that doesn't match this, and isn't an allowlisted
  // literal, is rejected -- including a bare 'Submitted' literal, a named constant standing in for
  // one, or a completely different helper function.
  function isAllowedSetStatusArg(arg) {
    const trimmed = arg.trim()
    const literal = trimmed.replace(/^['"`]|['"`]$/g, '')
    if (ALLOWED_LITERALS.has(literal)) return true
    if (!/^submissionStatusText\(/.test(trimmed)) return false
    // A ternary picking between two states (e.g. WAITING_PASSWORD/WAITING_PASSKEY by account kind)
    // is legitimate -- collect every SUBMISSION_STATE.<X> reference inside the call and require
    // ALL of them to be dapp-reachable, not just the first.
    const stateRefs = [...trimmed.matchAll(/SUBMISSION_STATE\.(\w+)/g)].map((m) => m[1])
    if (stateRefs.length === 0) return false
    return stateRefs.every((name) => {
      const state = SUBMISSION_STATE[name]
      return state != null && DAPP_REACHABLE_STATES.includes(state)
    })
  }

  it('every real setStatus(...) call in the file matches the allowlist', () => {
    const source = readFileSync(path.resolve(here, './approve.js'), 'utf8')
    const args = setStatusArgs(source)
    expect(args.length).toBeGreaterThan(0) // sanity: the extractor actually found calls
    for (const arg of args) {
      expect(isAllowedSetStatusArg(arg), `disallowed setStatus argument: ${arg}`).toBe(true)
    }
  })

  it('mutation-proof (reviewer #1): setStatus(submissionStatusText(SUBMISSION_STATE.SUBMITTED)) is rejected', () => {
    expect(isAllowedSetStatusArg('submissionStatusText(SUBMISSION_STATE.SUBMITTED)')).toBe(false) // RED
  })

  it('mutation-proof (reviewer #2): a named constant standing in for the literal is rejected', () => {
    // `const done = 'Submitted'; setStatus(done)` -- the argument at the call site is just `done`.
    expect(isAllowedSetStatusArg('done')).toBe(false) // RED
  })

  it('mutation-proof (reviewer #3): an opaque helper wrapper is rejected', () => {
    expect(isAllowedSetStatusArg('statusFor(state, {tx: hash})')).toBe(false) // RED
  })

  it('the original literal the old guard injected is still rejected', () => {
    expect(isAllowedSetStatusArg("'Submitted'")).toBe(false) // RED (still caught, as before)
  })

  it('positive control: the allowlist is not vacuous -- a dapp-reachable state and an allowed literal both pass', () => {
    expect(
      isAllowedSetStatusArg('submissionStatusText(SUBMISSION_STATE.FAILED, { detail: e.message })')
    ).toBe(true)
    expect(isAllowedSetStatusArg("'Connected.'")).toBe(true)
  })
})

// I2: submissionStatusText's own copy says "Signed and returned to X" (no trailing period); before
// this fix approve.js hand-wrote "Signed and returned to X." (WITH a trailing period) instead of
// calling the module it imports from -- the two had already diverged. Pins the fix directly rather
// than relying on the allowlist test above (which only checks the *shape* of the call, not that
// the hand-written duplicate is actually gone).
describe('approve.js — SIGNED_RETURNED status text is sourced from submissionStatusText, not duplicated', () => {
  it('the file calls submissionStatusText(SUBMISSION_STATE.SIGNED_RETURNED, ...) and no longer hand-writes the string', () => {
    const source = readFileSync(path.resolve(here, './approve.js'), 'utf8')
    expect(source).toMatch(/submissionStatusText\(\s*SUBMISSION_STATE\.SIGNED_RETURNED/)
    expect(source).not.toMatch(/setStatus\(\s*`Signed and returned/)
  })
})

// ---------------------------------------------------------------------------------------------
// Review fix round 1 -- I1. A schema-mismatch consequence (`view.needsAcknowledgment`) must not
// let Confirm go through for free -- it stays disabled until the user opens the raw
// technical-details disclosure. Tested with bare fake DOM-like objects (addEventListener/disabled/
// open) rather than a full jsdom environment or chrome mock, since wireAcknowledgmentGate takes
// its elements as plain injected arguments.
// ---------------------------------------------------------------------------------------------
describe('wireAcknowledgmentGate — Confirm stays disabled until the raw details are opened (I1)', () => {
  function fakeDetails() {
    const listeners = []
    return {
      open: false,
      addEventListener(type, cb) {
        listeners.push([type, cb])
      },
      fire(type) {
        for (const [t, cb] of listeners) if (t === type) cb()
      },
    }
  }

  it('disables Confirm immediately when the view needs acknowledgment', () => {
    const approveBtn = { disabled: false }
    wireAcknowledgmentGate({ needsAcknowledgment: true }, { approveBtn, detailsEl: fakeDetails() })
    expect(approveBtn.disabled).toBe(true)
  })

  it('re-enables Confirm once the technical details are opened', () => {
    const approveBtn = { disabled: false }
    const details = fakeDetails()
    wireAcknowledgmentGate({ needsAcknowledgment: true }, { approveBtn, detailsEl: details })
    expect(approveBtn.disabled).toBe(true)
    details.open = true
    details.fire('toggle')
    expect(approveBtn.disabled).toBe(false)
  })

  it('does nothing on the happy path (no warning) -- Confirm is never disabled it did not already need to be', () => {
    const approveBtn = { disabled: false }
    wireAcknowledgmentGate({ needsAcknowledgment: false }, { approveBtn, detailsEl: fakeDetails() })
    expect(approveBtn.disabled).toBe(false)
  })

  it('mutation-proof: a differently-written gate that disables via `hidden` instead of `disabled` leaves Confirm clickable', () => {
    function brokenGate(view, { approveBtn }) {
      if (view.needsAcknowledgment) approveBtn.hidden = true // wrong property -- still clickable
    }
    const approveBtn = { disabled: false, hidden: false }
    brokenGate({ needsAcknowledgment: true }, { approveBtn })
    expect(approveBtn.disabled).toBe(false) // RED: the real assertion above requires `true`
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

// frontend/extension/popup.test.jsx
// Pure decision tests for resolveEntryScreen — the popup's account-resolution routing (Task 1,
// activeAccount.js). Mirrors approve.test.js's screenModel pattern: exercise the exported pure
// function directly rather than rendering the full popup (which pulls in the passkey kit, every
// classic screen component, etc.) — importing popup.jsx is safe because its only DOM-touching
// top-level statement (mounting into #root) is guarded, same discipline as approve.js.
import { describe, it, expect } from 'vitest'
import { resolveEntryScreen } from './popup.jsx'

const G_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:GCLASSIC',
  network: 'stellar-testnet',
  address: 'GCLASSIC',
  kind: 'G',
  signer: 'classic-ed25519',
  selectedAt: 1,
}
const C_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:CPASSKEY',
  network: 'stellar-testnet',
  address: 'CPASSKEY',
  kind: 'C',
  signer: 'passkey-secp256r1',
  selectedAt: 1,
}
const CW_LOCKED = { ready: true, hasWallet: true, publicKey: 'GCLASSIC', unlocked: false, needsBackup: false }
const CW_UNLOCKED = { ready: true, hasWallet: true, publicKey: 'GCLASSIC', unlocked: true, needsBackup: false }
const CW_NONE = { ready: true, hasWallet: false, publicKey: null, unlocked: false, needsBackup: false }

describe('resolveEntryScreen — popup routing off the resolution matrix', () => {
  it('empty, no legacy hint -> classic onboarding (fresh-install default, unchanged)', () => {
    expect(resolveEntryScreen({ status: 'empty' }, CW_NONE, null)).toEqual({
      screen: 'classic-onboarding',
    })
  })

  it('empty, legacy vf_wallet_type=passkey -> welcome (preserves prior passkey-preference UX)', () => {
    expect(resolveEntryScreen({ status: 'empty' }, CW_NONE, 'passkey')).toEqual({
      screen: 'welcome',
    })
  })

  it('one usable C selects C -> home with its contractId', () => {
    const entry = resolveEntryScreen({ status: 'ready', account: C_ACCOUNT }, CW_NONE)
    expect(entry).toEqual({ screen: 'home', contractId: 'CPASSKEY' })
  })

  it('one usable G, unlocked -> classic-home', () => {
    const entry = resolveEntryScreen({ status: 'ready', account: G_ACCOUNT }, CW_UNLOCKED)
    expect(entry.screen).toBe('classic-home')
  })

  it('one usable G, locked -> classic-unlock', () => {
    const entry = resolveEntryScreen({ status: 'ready', account: G_ACCOUNT }, CW_LOCKED)
    expect(entry.screen).toBe('classic-unlock')
  })

  it('one usable G, pending backup -> classic-unlock even if technically unlocked', () => {
    const entry = resolveEntryScreen(
      { status: 'ready', account: G_ACCOUNT },
      { ...CW_UNLOCKED, needsBackup: true }
    )
    expect(entry.screen).toBe('classic-unlock')
  })

  it('explicit persisted G remains G (routes classic even though a C exists elsewhere in storage)', () => {
    // resolveActiveAccount already resolved the persisted G — resolveEntryScreen only sees the
    // final 'ready' account, proving the popup layer never re-litigates a settled selection.
    const entry = resolveEntryScreen({ status: 'ready', account: G_ACCOUNT }, CW_UNLOCKED)
    expect(entry.screen).toBe('classic-home')
  })

  it('explicit persisted C remains C', () => {
    const entry = resolveEntryScreen({ status: 'ready', account: C_ACCOUNT }, CW_LOCKED)
    expect(entry).toEqual({ screen: 'home', contractId: 'CPASSKEY' })
  })

  it('both without a valid preference require selection — surfaces a chooser, not a default screen', () => {
    const entry = resolveEntryScreen(
      { status: 'selection-required', accounts: [G_ACCOUNT, C_ACCOUNT] },
      CW_UNLOCKED
    )
    expect(entry.screen).toBe('select-account')
    expect(entry.accounts).toEqual([G_ACCOUNT, C_ACCOUNT])
  })

  it('no code path silently prefers C because a passkey record exists — ambiguous never resolves to home', () => {
    const entry = resolveEntryScreen(
      { status: 'selection-required', accounts: [G_ACCOUNT, C_ACCOUNT] },
      CW_UNLOCKED
    )
    expect(entry.screen).not.toBe('home')
    expect(entry.screen).not.toBe('classic-home')
  })
})

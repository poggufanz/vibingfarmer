// frontend/src/wallet/ui/AccountPicker.test.jsx
// VF Wallet Task 9.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AccountPicker } from './AccountPicker.jsx'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
// Comments stripped first (see WalletShell.test.jsx for why) so this file's own documentation
// can never accidentally fail its own guard.
const SOURCE = fs
  .readFileSync(path.resolve(here, './AccountPicker.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

// The real shape resolveActiveAccount emits for status 'selection-required'
// (frontend/src/wallet/activeAccount.js:21-23 accountShape, :114 selection-required branch) --
// public fields only, never secret material.
const G_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:GCLASSICWALLETADDRESSXXXXXX',
  network: 'stellar-testnet',
  address: 'GCLASSICWALLETADDRESSXXXXXX',
  kind: 'G',
  signer: 'classic-ed25519',
}
const C_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:CPASSKEYWALLETADDRESSXXXXXX',
  network: 'stellar-testnet',
  address: 'CPASSKEYWALLETADDRESSXXXXXX',
  kind: 'C',
  signer: 'passkey-secp256r1',
}

describe('AccountPicker — both-account state', () => {
  it('renders one row per account with its type and a shortened (not full) address', () => {
    render(<AccountPicker accounts={[G_ACCOUNT, C_ACCOUNT]} onSelect={vi.fn()} />)
    expect(screen.getByText('Standard')).toBeTruthy()
    expect(screen.getByText('Passkey')).toBeTruthy()
    expect(screen.getByText('GCLASS…XXXX')).toBeTruthy()
    expect(screen.queryByText(G_ACCOUNT.address)).toBeNull()
  })

  it('calls onSelect with the exact account object for the row clicked, once per click', () => {
    const onSelect = vi.fn()
    render(<AccountPicker accounts={[G_ACCOUNT, C_ACCOUNT]} onSelect={onSelect} />)
    const buttons = screen.getAllByRole('button', { name: 'Use this wallet' })
    fireEvent.click(buttons[1])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(C_ACCOUNT)
  })
})

describe('AccountPicker — secret material cannot reach this component (structural)', () => {
  it('never renders any field beyond the public account shape, even if one is present on the object', () => {
    const tainted = {
      ...G_ACCOUNT,
      secretKey: 'SSECRETSECRETSECRETSECRETSECRETSECRETSECRETS',
      mnemonic: 'abandon abandon abandon abandon abandon abandon',
    }
    render(<AccountPicker accounts={[tainted]} onSelect={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/SSECRETSECRETSECRET/)
    expect(document.body.textContent).not.toMatch(/abandon abandon/)
  })

  it('the component source never references seed/secret/password/session-key identifiers', () => {
    const forbidden = /\b(mnemonic|seedPhrase|secretKey|privateKey|sessionKey|password)\b/i
    expect(SOURCE).not.toMatch(forbidden)
  })
})

describe('AccountPicker — rejection-checklist items 6/7 (source-parse, mutation-provable)', () => {
  it('defines no keyframes, animation, or gradient declarations, and no inline style', () => {
    expect(SOURCE).not.toMatch(/@keyframes/i)
    expect(SOURCE).not.toMatch(/\banimation(-name)?\s*:/i)
    expect(SOURCE).not.toMatch(/gradient/i)
    expect(SOURCE).not.toMatch(/style\s*=\s*\{/i)
  })
})

// frontend/src/wallet/ui/WalletShell.test.jsx
// VF Wallet Task 9. WalletShell is the shared 360px onboarding/account-choice shell: a small
// product lockup, visible "Stellar testnet", a current-account chip, one heading, predictable
// back placement, and a polite status region.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WalletShell } from './WalletShell.jsx'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const RAW_SOURCE = fs.readFileSync(path.resolve(here, './WalletShell.jsx'), 'utf8')
// Structural/checklist guards below check the SHIPPED CODE, not this file's own header comment
// (which legitimately names the properties it structurally lacks, e.g. "no password prop") --
// comments are stripped first so documentation can never accidentally fail its own guard.
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('WalletShell — trust anchor, network text, heading, account chip', () => {
  it('renders exactly one h1 with the given heading', () => {
    render(<WalletShell heading="Create or restore a wallet">content</WalletShell>)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create or restore a wallet' })
    ).toBeTruthy()
    expect(document.querySelectorAll('h1').length).toBe(1)
  })

  it('always shows the literal Stellar testnet network text', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
  })

  it('shows a small product lockup naming VF Wallet', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.getByText('VF Wallet')).toBeTruthy()
  })

  it('shows no account chip before any account is selected', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.queryByTestId('wallet-account-chip')).toBeNull()
  })

  it('shows the account type and a shortened (not full) address once an account is known', () => {
    render(
      <WalletShell heading="x" account={{ kind: 'G', address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ' }}>
        content
      </WalletShell>
    )
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toContain('Standard')
    expect(chip.textContent).toContain('GABCDE')
    expect(chip.textContent).not.toContain('GABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })

  it('labels a passkey (C) account as Passkey, not the raw kind code', () => {
    render(
      <WalletShell heading="x" account={{ kind: 'C', address: 'CZYXWVUTSRQPONMLKJIHGFEDCBA' }}>
        content
      </WalletShell>
    )
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Passkey')
    expect(screen.getByTestId('wallet-account-chip').textContent).not.toMatch(/\bC\b/)
  })
})

describe('WalletShell — predictable back placement', () => {
  it('renders no back control by default', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('renders a Back button that fires onBack exactly once per click', () => {
    const onBack = vi.fn()
    render(
      <WalletShell heading="x" onBack={onBack}>
        content
      </WalletShell>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('WalletShell — polite status region', () => {
  it('always renders a polite live region, even with nothing to say', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('shows a status message and marks the error tone', () => {
    render(
      <WalletShell heading="x" status={{ tone: 'error', message: 'Wrong password.' }}>
        content
      </WalletShell>
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Wrong password.')
    expect(status.getAttribute('data-tone')).toBe('error')
  })
})

describe('WalletShell — secret material cannot reach this component (structural)', () => {
  it('renders whatever children it is given without inspecting or transforming them', () => {
    render(
      <WalletShell heading="x">
        <p data-testid="child">just a child</p>
      </WalletShell>
    )
    expect(screen.getByTestId('child')).toBeTruthy()
  })

  // Structural, not behavioral: the real component signature (read from source, not mocked) has
  // no prop shaped to carry a phrase/secret/session key at all -- `account` is fixed to the public
  // activeAccount.js shape (activeAccount.js:21-23: version/id/network/address/kind/signer),
  // which never includes any of those fields, so there is nowhere for one to travel through.
  it('the component source never references seed/secret/password/session-key identifiers', () => {
    const forbidden = /\b(mnemonic|seedPhrase|secretKey|privateKey|sessionKey|password)\b/i
    expect(SOURCE).not.toMatch(forbidden)
  })
})

describe('WalletShell — rejection-checklist items 6/7 (source-parse, mutation-provable)', () => {
  // jsdom always reports getComputedStyle(...).animationName as "none" for the animation
  // SHORTHAND regardless of the declared value (same finding MyMoneyRoute.test.jsx's/
  // PlanStage.test.jsx's I6 guards document) -- a jsdom computed-style assertion cannot see an
  // entry animation or an infinite button animation here. This reads the real shipped source
  // text instead, the same mechanism those guards use. WalletOnboarding.test.jsx additionally
  // proves this in a real Chromium instance.
  it('defines no keyframes, animation, or gradient declarations', () => {
    expect(SOURCE).not.toMatch(/@keyframes/i)
    // `animation: none !important` (the documented, non-load-bearing [data-pocket-critical]
    // reset) is explicitly allowed; any OTHER animation value is not. Extracting and trimming the
    // actual declared value (rather than a `(?!none)` lookahead, which a greedy `\s*` right before
    // it can backtrack around) is what makes this check reliable.
    const nonNoneAnimations = [...SOURCE.matchAll(/\banimation(?:-name)?\s*:\s*([^;}]+)/gi)]
      .map((m) =>
        m[1]
          .replace(/!important/i, '')
          .trim()
          .toLowerCase()
      )
      .filter((value) => value !== 'none')
    expect(nonNoneAnimations).toEqual([])
    expect(SOURCE).not.toMatch(/gradient/i)
  })

  it('never sets an inline style attribute', () => {
    expect(SOURCE).not.toMatch(/style=/i)
  })
})

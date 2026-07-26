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

// M5 (VF Wallet Task 9 fix loop 2): the drift guard used through fix loop 1 (and the reviewer's
// own re-check of it) compared VALUES against a list of previously-flagged drifts. That shape
// structurally cannot catch a rule the port omits entirely -- which is exactly how the
// font-family and color-scheme rules below went unnoticed through two review passes: both checks
// re-verified the thirteen values already known to be wrong and reported clean, while two whole
// rules were simply never ported. This guard is built the other way around: CONTRACT_PORTED_RULES
// enumerates every contract-anchored selector this file's header claims to port (the file's own
// claimed source of truth), independent of whether that selector was ever previously flagged, and
// each `it.each` case fails BY NAME when the port has no counterpart for it -- so a future
// deletion of any one of them (not just these two) goes red naming exactly which rule vanished.
// The contract file itself (docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css) is
// local-only/gitignored and will not exist in a clean CI checkout (see
// src/design/contractTokens.test.js's identical tradeoff note), so the expected text is pinned by
// hand from the contract rather than re-read from it at test time -- the only way this guard can
// actually run in CI. Selectors this file invents itself (no contract counterpart to omit --
// .pc-wallet-back, .pc-wallet-account-chip, .pc-wallet-status, .pc-backup-warning,
// .pc-standard-form, .pc-account-picker, .pc-choice*, .pc-backup-step/-progress, .bk-prog-*,
// .pc-backup-phrase, .pc-backup-check) are deliberately excluded: there is nothing in the contract
// for them to have a counterpart to.
//
// Mutation-proof (see the fix loop 2 report for the actual red run): deleting any one entry's rule
// from the STYLE template literal above turns exactly that `it.each` case red, naming the deleted
// selector -- verified by hand for the two new entries (deleting either the font-family or the
// color-scheme declaration during development reproduced the exact bug this loop fixes) and for
// one pre-existing entry (`.pc-wallet-shell`) chosen at random.
describe('WalletShell — contract drift guard: every ported selector has a shipped counterpart (VF Wallet Task 9 fix loop 2, M5)', () => {
  const normalize = (text) => text.replace(/\s+/g, ' ').trim()
  const normalizedSource = normalize(RAW_SOURCE)

  const CONTRACT_PORTED_RULES = [
    // The two rules fix loop 2 adds -- I2 (re-opened).
    {
      name: 'global form-control font-family (contract :199-207)',
      block: `.pc-wallet :where(h1, h2, h3, button, input, select, textarea) {
          font-family: var(--pc-font-body);
        }`,
    },
    {
      name: "color-scheme: dark (contract :39, :root/:root[data-theme='forest'])",
      block: 'color-scheme: dark;',
    },
    // Pre-existing ported rules (fix loop 1's census subject) -- included so this guard protects
    // the whole slice, not just the two rules this loop happened to find missing.
    {
      name: 'box-sizing reset (contract global *, *::before, *::after)',
      block:
        '.pc-wallet, .pc-wallet *, .pc-wallet *::before, .pc-wallet *::after { box-sizing: border-box; }',
    },
    {
      name: '.pc-wallet h1 (contract :733-739, VF-wallet-specific override)',
      block: `.pc-wallet h1 {
        max-width: 12ch;
        margin: 0 0 var(--pc-space-3);
        font-size: 28px;
        font-weight: 700;
        line-height: 1.12;
        letter-spacing: -0.03em;
      }`,
    },
    {
      name: '.pc-wallet-shell (contract :712-716)',
      block: `.pc-wallet-shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-height: 560px;
      }`,
    },
    {
      name: '.pc-wallet-header (contract :718-726, byte-identical)',
      block: `.pc-wallet-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 56px;
        padding: 0 18px;
        border-bottom: 1px solid var(--pc-line);
      }`,
    },
    {
      name: '.pc-wallet-main (contract :727-732)',
      block: `.pc-wallet-main {
        display: grid;
        align-content: start;
        gap: var(--pc-space-6);
        padding: 20px 18px 24px;
      }`,
    },
    {
      name: '.pc-brand-lockup img base 24px (contract :442-447)',
      block: '.pc-brand-lockup img { display: block; width: 24px; height: 24px; flex: none; }',
    },
    {
      name: '.pc-brand-lockup--compact img 20px (contract :450-453)',
      block: '.pc-brand-lockup--compact img { width: 20px; height: 20px; }',
    },
    {
      name: '.pc-network-badge (contract :456-464)',
      block: `.pc-network-badge {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 28px;
        color: inherit;
        font-size: var(--pc-type-label);
        font-weight: 620;
        white-space: nowrap;
      }`,
    },
    {
      name: '.pc-route-intro (contract :288-290)',
      block:
        '.pc-route-intro { margin-bottom: 0; color: var(--pc-muted); font-size: var(--pc-type-body); }',
    },
    {
      name: 'code, pre, .pc-technical (contract :233-236, byte-identical)',
      block: `code, pre, .pc-technical {
        font-family: var(--pc-font-mono);
        font-size: var(--pc-type-technical);
      }`,
    },
    {
      name: '.pc-button (contract :345-364, byte-identical)',
      block: `.pc-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: max-content;
        min-height: var(--pc-control-height);
        padding: 0 var(--pc-space-6);
        border: 1px solid transparent;
        border-radius: var(--pc-radius-control);
        font-size: var(--pc-type-body-small);
        font-weight: 700;
        line-height: 1;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
        transition:
          transform var(--pc-duration-fast) var(--pc-ease-standard),
          background-color var(--pc-duration-fast) var(--pc-ease-standard),
          border-color var(--pc-duration-fast) var(--pc-ease-standard);
      }`,
    },
    {
      name: '.pc-button--primary (byte-identical)',
      block: '.pc-button--primary { background: var(--pc-harvest); color: var(--pc-harvest-ink); }',
    },
    {
      name: '.pc-button--secondary (byte-identical)',
      block:
        '.pc-button--secondary { border-color: var(--pc-line-strong); background: transparent; color: currentcolor; }',
    },
    {
      name: '.pc-button:active:not(:disabled) (byte-identical)',
      block: '.pc-button:active:not(:disabled) { transform: translateY(1px) scale(0.99); }',
    },
    {
      name: ".pc-button:disabled/[aria-disabled='true'] (byte-identical)",
      block:
        ".pc-button:disabled, .pc-button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.58; }",
    },
    {
      name: '.pc-field (byte-identical)',
      block: '.pc-field { display: grid; gap: var(--pc-space-2); }',
    },
    {
      name: '.pc-field > label (byte-identical)',
      block: '.pc-field > label { font-size: var(--pc-type-label); font-weight: 650; }',
    },
    {
      name: '.pc-input padding (contract :403-411)',
      block: `.pc-input {
        width: 100%;
        min-height: var(--pc-control-height);
        border: 1px solid var(--pc-line-strong);
        border-radius: var(--pc-radius-control);
        padding: 0 var(--pc-space-4);
        background: transparent;
        color: currentcolor;
        font-size: var(--pc-type-body);
      }`,
    },
    {
      name: '.pc-field-help, .pc-field-error (byte-identical)',
      block: '.pc-field-help, .pc-field-error { margin: 0; font-size: var(--pc-type-label); }',
    },
    {
      name: '.pc-row (byte-identical)',
      block: `.pc-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: var(--pc-space-4);
        align-items: center;
        min-height: 68px;
        padding-block: var(--pc-space-4);
        border-bottom: 1px solid var(--pc-line);
      }`,
    },
    {
      name: '.pc-row:last-child (byte-identical)',
      block: '.pc-row:last-child { border-bottom: 0; }',
    },
    {
      name: ':focus-visible (contract :428-432, byte-identical)',
      block: `:where(a, button, input, select, textarea, summary):focus-visible {
        outline: 3px solid var(--pc-focus);
        outline-offset: 3px;
        box-shadow: 0 0 0 5px var(--pc-focus-contrast);
      }`,
    },
    {
      name: '359px media query (contract :916-925, byte-identical)',
      block: `@media (max-width: 359px) {
        .pc-wallet { width: 100vw; min-width: 320px; }
        .pc-wallet-main { padding-inline: 16px; }
      }`,
    },
    {
      name: 'prefers-reduced-motion: all five resets (contract :933-946)',
      block: `scroll-behavior: auto !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        transition-delay: 0ms !important;`,
    },
  ]

  it.each(CONTRACT_PORTED_RULES)('ports $name', ({ block }) => {
    expect(normalizedSource.includes(normalize(block)), 'expected block not found verbatim').toBe(
      true
    )
  })
})

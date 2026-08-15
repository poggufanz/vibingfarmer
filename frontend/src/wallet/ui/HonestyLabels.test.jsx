// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { HonestyLabels } from './HonestyLabels.jsx'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const RAW_SOURCE = fs.readFileSync(path.resolve(here, './HonestyLabels.jsx'), 'utf8')
// Comments (including this file's own explanation of the item-5 regression, which necessarily
// says "mono") are stripped first so documentation can never accidentally fail its own guard --
// same approach as WalletShell.test.jsx/WalletOnboarding.test.jsx.
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('HonestyLabels', () => {
  it('renders testnet + protocol labels in global scope', () => {
    render(<HonestyLabels scope="global" />)
    const el = screen.getByTestId('honesty-global')
    expect(el.textContent).toMatch(/testnet-grade/)
    expect(el.textContent).toMatch(/mainnet-live at the protocol layer/)
  })

  it('renders the app-layer label in deposit scope', () => {
    render(<HonestyLabels scope="deposit" />)
    expect(screen.getByTestId('honesty-deposit').textContent).toMatch(/app-layer/)
  })

  it('renders the VF-custodied label in recovery scope', () => {
    render(<HonestyLabels scope="recovery" />)
    expect(screen.getByTestId('honesty-recovery').textContent).toMatch(/VF-custodied/)
  })

  it('defaults to global scope when prop is omitted', () => {
    render(<HonestyLabels />)
    expect(screen.getByTestId('honesty-global')).toBeTruthy()
  })

  it('renders the agent cap label in agent scope', () => {
    render(<HonestyLabels scope="agent" />)
    expect(screen.getByTestId('honesty-agent').textContent).toMatch(/not yet enforced on-chain/)
  })

  it('renders the in-memory session-key label in session-key scope', () => {
    render(<HonestyLabels scope="session-key" />)
    expect(screen.getByTestId('honesty-session-key').textContent).toMatch(
      /chrome\.storage\.session/
    )
  })

  it('shows only the model-appropriate recovery warning', () => {
    const { rerender } = render(<HonestyLabels scope="session-key" />)
    expect(screen.getByText(/chrome\.storage\.session/i)).toBeTruthy()
    rerender(<HonestyLabels scope="recovery" />)
    expect(screen.getByText(/VF-custodied recovery/i)).toBeTruthy()
    expect(screen.queryByText(/chrome\.storage\.session/i)).toBeNull()
  })
})

describe('HonestyLabels — rejection-checklist item 5 (source-parse, mutation-provable)', () => {
  // jsdom's getComputedStyle cannot resolve font-family reliably (documented across this wave --
  // see WalletShell.test.jsx/WalletOnboarding.test.jsx), so this guards the source text directly:
  // none of the six labels may be given a mono/JetBrains font-family, because none of them is
  // technical data (an address or a hash) -- all six are plain-English safety prose. VF Wallet
  // Task 9 fix loop 1 found this exact regression live in Chromium on 5 of 8 onboarding states.
  // Mutation-proof: reinstating `fontFamily: '"JetBrains Mono", ui-monospace, monospace'` in the
  // shared `s` style object immediately fails this test.
  it('never sets a mono/monospace font-family anywhere in this file', () => {
    expect(SOURCE).not.toMatch(/font-?family/i)
    expect(SOURCE).not.toMatch(/mono/i)
  })

  it('uses the external honesty-label class rather than inline styles', () => {
    expect(SOURCE).toMatch(/pc-honesty-label/)
    expect(SOURCE).not.toMatch(/style\s*=\s*\{/i)
  })
})

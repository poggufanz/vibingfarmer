// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import {
  Dialog,
  MoneyFigure,
  StageShell,
  StatusNotice,
  TechnicalDetails,
  VenueTruth,
} from './Primitives.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

// ---------------------------------------------------------------------------
// MoneyFigure
// ---------------------------------------------------------------------------

describe('MoneyFigure', () => {
  it('loading state never renders a numeric figure', () => {
    render(<MoneyFigure state="loading" value={null} currency="USDC" />)
    expect(screen.queryByText(/^0/)).toBeNull()
    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('current state renders the real value, including a legitimate zero balance', () => {
    render(<MoneyFigure state="current" value={0} currency="USDC" />)
    expect(screen.getByText(/0/)).toBeTruthy()
    expect(screen.getByText(/USDC/)).toBeTruthy()
  })

  it('current state with a numeric value formats it with the currency', () => {
    render(<MoneyFigure state="current" value={1234.5} currency="USDC" />)
    expect(screen.getByText(/1,234.5/)).toBeTruthy()
  })

  it('current state NEVER coerces a null value to 0', () => {
    render(<MoneyFigure state="current" value={null} currency="USDC" />)
    expect(screen.queryByText('0 USDC')).toBeNull()
    expect(screen.queryByText(/^0$/)).toBeNull()
  })

  it('stale state renders the value plus a stale cue distinct from current', () => {
    render(<MoneyFigure state="stale" value={42} currency="USDC" freshness="5m ago" />)
    expect(screen.getByText(/42/)).toBeTruthy()
    expect(screen.getByText(/stale/i)).toBeTruthy()
  })

  it('empty state shows no balance rather than a coerced zero', () => {
    render(<MoneyFigure state="empty" value={null} currency="USDC" />)
    expect(screen.getByText(/no balance/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('error state never shows a numeric figure', () => {
    render(<MoneyFigure state="error" value={null} currency="USDC" />)
    expect(screen.getByText(/could not load/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('unknown state never shows a numeric figure', () => {
    render(<MoneyFigure state="unknown" value={undefined} currency="USDC" />)
    expect(screen.getByText(/unknown/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// StatusNotice
// ---------------------------------------------------------------------------

describe('StatusNotice', () => {
  it('renders a title and children', () => {
    render(
      <StatusNotice state="info" title="Heads up">
        Something to know.
      </StatusNotice>
    )
    expect(screen.getByText('Heads up')).toBeTruthy()
    expect(screen.getByText('Something to know.')).toBeTruthy()
  })

  it('danger state uses an alert role so it is announced', () => {
    render(
      <StatusNotice state="danger" title="Failed">
        The deposit failed.
      </StatusNotice>
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('has zero axe violations', async () => {
    const { container } = render(
      <StatusNotice state="info" title="Heads up">
        Something to know.
      </StatusNotice>
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// TechnicalDetails
// ---------------------------------------------------------------------------

describe('TechnicalDetails', () => {
  it('uses native details/summary and starts closed by default', () => {
    const { container } = render(<TechnicalDetails>raw payload</TechnicalDetails>)
    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details.hasAttribute('open')).toBe(false)
    expect(container.querySelector('summary').textContent).toBe('Technical details')
  })

  it('is keyboard operable via native details/summary toggling', () => {
    const { container } = render(
      <TechnicalDetails summary="Raw scopes">raw payload</TechnicalDetails>
    )
    const details = container.querySelector('details')
    const summary = container.querySelector('summary')
    expect(details.open).toBe(false)
    // jsdom implements the native click-to-toggle behavior for <summary>; this is the same
    // activation Enter/Space triggers on a focused summary in a real browser.
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

  it('respects an explicit open=true', () => {
    const { container } = render(<TechnicalDetails open>raw payload</TechnicalDetails>)
    expect(container.querySelector('details').open).toBe(true)
  })

  it('has zero axe violations', async () => {
    const { container } = render(<TechnicalDetails>raw payload</TechnicalDetails>)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// VenueTruth
// ---------------------------------------------------------------------------

describe('VenueTruth', () => {
  it('renders live Autofarm -> Blend venue copy for kind=stellar-live', () => {
    render(<VenueTruth kind="stellar-live" venue="Autofarm Vault" />)
    expect(screen.getByText(/Autofarm Vault/)).toBeTruthy()
    expect(screen.getByText(/Blend/)).toBeTruthy()
  })

  it('shows an APY figure when state is live', () => {
    render(
      <VenueTruth kind="stellar-live" venue="Autofarm Vault" apy={{ state: 'live', value: 8.2 }} />
    )
    expect(screen.getByText(/8.2/)).toBeTruthy()
    expect(screen.getByText(/APY/)).toBeTruthy()
  })

  it('shows an estimated APY only when a source or freshness accompanies it', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        apy={{ state: 'estimated', value: 5, source: 'DeFiLlama' }}
      />
    )
    expect(screen.getByText(/5/)).toBeTruthy()
  })

  it('suppresses an unsourced estimated APY', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        apy={{ state: 'estimated', value: 5 }}
      />
    )
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('suppresses APY entirely when no apy input is given', () => {
    render(<VenueTruth kind="stellar-live" venue="Autofarm Vault" />)
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('renders the Base custody proxy sentence for kind=base-proxy and always suppresses APY', () => {
    render(<VenueTruth kind="base-proxy" apy={{ state: 'live', value: 99 }} />)
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
    expect(screen.queryByText(/99/)).toBeNull()
  })

  it('the proxy copy contains no em/en dash and at most one middle dot', () => {
    render(<VenueTruth kind="base-proxy" />)
    const text = screen.getByText(/Base Sepolia proxy/).textContent
    expect(text).not.toMatch(/[–—]/)
    expect((text.match(/·/g) || []).length).toBeLessThanOrEqual(1)
  })

  it('renders stellar-live and base-proxy with distinct root classes (rendered separately)', () => {
    const live = render(<VenueTruth kind="stellar-live" venue="Autofarm Vault" />)
    const proxy = render(<VenueTruth kind="base-proxy" />)
    expect(live.container.firstChild.className).not.toBe(proxy.container.firstChild.className)
  })

  it('has zero axe violations for the live venue', async () => {
    const { container } = render(
      <VenueTruth kind="stellar-live" venue="Autofarm Vault" apy={{ state: 'live', value: 8.2 }} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for the base proxy', async () => {
    const { container } = render(<VenueTruth kind="base-proxy" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// StageShell
// ---------------------------------------------------------------------------

describe('StageShell', () => {
  it('renders exactly one h1 carrying the title', () => {
    const { container } = render(
      <StageShell eyebrow="Strategy" title="Review your grant" description="One signature.">
        <p>Body</p>
      </StageShell>
    )
    const h1s = container.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0].textContent).toBe('Review your grant')
  })

  it('renders one dominant surface, not a repeated card grid', () => {
    const { container } = render(
      <StageShell title="Review your grant">
        <p>Body</p>
      </StageShell>
    )
    expect(container.querySelectorAll('.pc-stage-shell-surface')).toHaveLength(1)
    expect(container.querySelectorAll('.pc-card')).toHaveLength(0)
  })

  it('has zero axe violations', async () => {
    const { container } = render(
      <StageShell eyebrow="Strategy" title="Review your grant" description="One signature.">
        <p>Body</p>
      </StageShell>
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function DialogHarness({ mode, useInitialFocus = false }) {
  const [open, setOpen] = useState(false)
  const confirmRef = useRef(null)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        open={open}
        title="Confirm withdrawal"
        description="Are you sure?"
        onClose={() => setOpen(false)}
        mode={mode}
        initialFocusRef={useInitialFocus ? confirmRef : undefined}
        actions={
          <button type="button" ref={confirmRef} data-testid="confirm-btn">
            Confirm
          </button>
        }
      >
        <button type="button" data-testid="cancel-btn">
          Cancel
        </button>
      </Dialog>
    </div>
  )
}

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<DialogHarness />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a labelled modal dialog when open', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('Confirm withdrawal')).toBeTruthy()
  })

  it('moves focus inside on open (first focusable by default)', () => {
    render(<DialogHarness />)
    const opener = screen.getByText('Open dialog')
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByTestId('cancel-btn'))
  })

  it('honors an explicit initialFocusRef', () => {
    render(<DialogHarness useInitialFocus />)
    fireEvent.click(screen.getByText('Open dialog'))
    expect(document.activeElement).toBe(screen.getByTestId('confirm-btn'))
  })

  it('traps Tab forward through the focusable set and wraps around', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    const cancel = screen.getByTestId('cancel-btn')
    const confirm = screen.getByTestId('confirm-btn')
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })

  it('traps Shift+Tab backward and wraps around', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    const cancel = screen.getByTestId('cancel-btn')
    const confirm = screen.getByTestId('confirm-btn')
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })

  it('closes on Escape only through onClose, and restores trigger focus', () => {
    render(<DialogHarness />)
    const opener = screen.getByText('Open dialog')
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('closes on a backdrop click but not a click inside the panel', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    fireEvent.click(screen.getByText('Are you sure?'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders identical dialog semantics whether mode is dialog or sheet', () => {
    const desktop = render(<DialogHarness mode="dialog" />)
    fireEvent.click(desktop.getByText('Open dialog'))
    const desktopDlg = desktop.getByRole('dialog')
    expect(desktopDlg.getAttribute('aria-modal')).toBe('true')
    expect(desktopDlg.className).toContain('pc-dialog--dialog')
    desktop.unmount()

    const sheet = render(<DialogHarness mode="sheet" />)
    fireEvent.click(sheet.getByText('Open dialog'))
    const sheetDlg = sheet.getByRole('dialog')
    expect(sheetDlg.getAttribute('aria-modal')).toBe('true')
    expect(sheetDlg.className).toContain('pc-dialog--sheet')
    sheet.unmount()
  })

  it('carries the full-coverage overlay class that CSS uses to block background interaction', () => {
    render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    expect(screen.getByRole('dialog').className).toContain('pc-dialog')
  })

  it('has zero axe violations while open', async () => {
    const { container } = render(<DialogHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    expect(await axe(container)).toHaveNoViolations()
  })
})

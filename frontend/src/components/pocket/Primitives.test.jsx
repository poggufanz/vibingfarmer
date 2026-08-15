// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { normalizeAmount, normalizeFact } from '../../design/pocket-crew-foundation.js'
import {
  Dialog,
  MoneyFigure,
  StageShell,
  StatusNotice,
  TechnicalDetails,
  VenueTruth,
} from './Primitives.jsx'

expect.extend(axeMatchers)

afterEach(() => {
  cleanup()
  // Dialog isolation owns this while a dialog is mounted. Reset the jsdom host between tests so
  // a deliberately failing RED assertion cannot poison a later test's body-style baseline.
  document.body.removeAttribute('style')
})

const amount = normalizeAmount({ token: 'USDC', units: '9007199254740993', decimals: 7 })
const currentFact = normalizeFact({
  phase: 'submitted',
  state: 'current',
  value: amount,
  source: 'Stellar RPC',
  checkedAt: '2026-08-11T00:00:00.000Z',
  staleAfterMs: 900000,
  confirmedLedger: '123456',
  confirmedBlock: '789012',
})
const blockedFact = normalizeFact({
  phase: 'submitted',
  state: 'blocked',
  value: amount,
  source: 'Council eligibility gate',
  checkedAt: '2026-08-11T00:00:00.000Z',
  staleAfterMs: 900000,
  confirmedLedger: '123456',
  confirmedBlock: '789012',
  consequence: 'Signing is blocked until the evidence is refreshed.',
  safeNextAction: 'Refresh the council evidence before signing.',
})

// ---------------------------------------------------------------------------
// MoneyFigure
// ---------------------------------------------------------------------------

describe('MoneyFigure', () => {
  it('loading state never renders a numeric figure', () => {
    render(<MoneyFigure state="loading" amount={null} />)
    expect(screen.queryByText(/^0/)).toBeNull()
    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('current state renders the real value, including a legitimate zero balance', () => {
    render(
      <MoneyFigure
        state="current"
        amount={normalizeAmount({ token: 'USDC', units: '0', decimals: 7 })}
      />
    )
    expect(screen.getByText(/0/)).toBeTruthy()
    expect(screen.getByText(/USDC/)).toBeTruthy()
  })

  it('current state formats the canonical string-unit DTO without precision loss', () => {
    render(<MoneyFigure state="current" amount={amount} />)
    expect(screen.getByText('900,719,925.4740993 USDC')).toBeTruthy()
  })

  it('groups a formatter string whose integer portion exceeds MAX_SAFE_INTEGER without coercion', () => {
    render(
      <MoneyFigure
        state="current"
        amount={normalizeAmount({
          token: 'USDC',
          units: '90071992547409931234567890',
          decimals: 7,
        })}
      />
    )
    expect(screen.getByText('9,007,199,254,740,993,123.456789 USDC')).toBeTruthy()
  })

  it('accepts amount as the only money input and ignores a legacy floating-point value', () => {
    render(<MoneyFigure state="current" value={1234.5} currency="USDC" />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/1,234.5/)).toBeNull()
  })

  it('current state with no amount renders Unavailable rather than zero', () => {
    render(<MoneyFigure state="current" amount={null} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('stale state renders the value plus a stale cue distinct from current', () => {
    render(
      <MoneyFigure
        state="stale"
        amount={normalizeAmount({ token: 'USDC', units: '420000000', decimals: 7 })}
        freshness="5m ago"
      />
    )
    expect(screen.getByText(/42/)).toBeTruthy()
    expect(screen.getByText(/stale/i)).toBeTruthy()
  })

  it('empty state shows no balance rather than a coerced zero', () => {
    render(<MoneyFigure state="empty" amount={null} />)
    expect(screen.getByText(/no balance/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('error state never shows a numeric figure', () => {
    render(<MoneyFigure state="error" amount={null} />)
    expect(screen.getByText(/could not load/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('unknown state never shows a numeric figure', () => {
    render(<MoneyFigure state="unknown" amount={undefined} />)
    expect(screen.getByText(/unknown/i)).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it.each([
    { token: 'USDC', units: 1, decimals: 7 },
    { token: 'USDC', units: '1', decimals: 39 },
    { token: '', units: '1', decimals: 7 },
    { token: 'USDC', units: '1', decimals: 7, extra: true },
  ])('fails closed for a non-canonical amount %#', (invalidAmount) => {
    render(<MoneyFigure state="current" amount={invalidAmount} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/^0/)).toBeNull()
  })

  it('fails closed for accessor-backed amount DTOs', () => {
    const amountWithGetter = {}
    Object.defineProperties(amountWithGetter, {
      token: { configurable: true, enumerable: true, value: 'USDC' },
      units: {
        configurable: true,
        enumerable: true,
        get: () => '1',
      },
      decimals: { configurable: true, enumerable: true, value: 7 },
    })

    render(<MoneyFigure state="current" amount={amountWithGetter} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('fails closed for custom-prototype amount DTOs', () => {
    const amountWithCustomPrototype = Object.create({ inherited: true })
    Object.assign(amountWithCustomPrototype, { token: 'USDC', units: '1', decimals: 7 })

    render(<MoneyFigure state="current" amount={amountWithCustomPrototype} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('fails closed for an amount proxy whose prototype trap is hostile', () => {
    const amountProxy = new Proxy(
      { token: 'USDC', units: '1', decimals: 7 },
      {
        getPrototypeOf: () => {
          throw new Error('hostile prototype read')
        },
      }
    )

    expect(() => render(<MoneyFigure state="current" amount={amountProxy} />)).not.toThrow()
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('fails closed for a revoked amount proxy without propagating reflection errors', () => {
    const revocable = Proxy.revocable({ token: 'USDC', units: '1', decimals: 7 }, {})
    revocable.revoke()

    expect(() => render(<MoneyFigure state="current" amount={revocable.proxy} />)).not.toThrow()
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('accepts a frozen canonical DTO and a null-prototype data DTO', () => {
    const nullPrototypeAmount = Object.create(null)
    Object.assign(nullPrototypeAmount, { token: 'USDC', units: '1', decimals: 7 })

    const { unmount } = render(<MoneyFigure state="current" amount={amount} />)
    expect(screen.getByText('900,719,925.4740993 USDC')).toBeTruthy()
    unmount()

    render(<MoneyFigure state="current" amount={nullPrototypeAmount} />)
    expect(screen.getByText('0.0000001 USDC')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// StatusNotice
// ---------------------------------------------------------------------------

describe('StatusNotice', () => {
  it('maps one source-owned Fact to canonical tone, label, consequence, and safe next action', () => {
    render(
      <StatusNotice
        fact={blockedFact}
        title="Eligibility review"
        action={<button type="button">Review evidence</button>}
      >
        Legacy caller detail.
      </StatusNotice>
    )
    const notice = screen.getByRole('alert')
    expect(notice.className).toContain('pc-status-notice--warning')
    expect(screen.getByText('Eligibility review')).toBeTruthy()
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(screen.getByText(blockedFact.consequence)).toBeTruthy()
    expect(screen.getByText(blockedFact.safeNextAction)).toBeTruthy()
    expect(screen.getByText(blockedFact.source)).toBeTruthy()
    expect(screen.getByText(blockedFact.checkedAt)).toBeTruthy()
    expect(screen.getByText('Legacy caller detail.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review evidence' })).toBeTruthy()
  })

  it('danger state uses an alert role so it is announced', () => {
    render(
      <StatusNotice state="danger" title="Failed">
        The deposit failed.
      </StatusNotice>
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('Fact state wins over contradictory scalar compatibility state', () => {
    render(<StatusNotice fact={blockedFact} state="error" title="Eligibility review" />)
    expect(screen.getByRole('alert').className).toContain('pc-status-notice--warning')
    expect(screen.getByRole('alert').className).not.toContain('pc-status-notice--danger')
  })

  it('has zero axe violations', async () => {
    const { container } = render(<StatusNotice fact={blockedFact} title="Eligibility review" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// TechnicalDetails
// ---------------------------------------------------------------------------

describe('TechnicalDetails', () => {
  it('uses native details/summary and starts closed by default', () => {
    const { container } = render(
      <TechnicalDetails fact={currentFact}>raw payload</TechnicalDetails>
    )
    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details.hasAttribute('open')).toBe(false)
    expect(container.querySelector('summary').textContent).toBe('Technical details')
  })

  it('exposes the same Fact phase, state, freshness, and decimal-string anchors', () => {
    const { container } = render(
      <TechnicalDetails fact={currentFact} summary="Evidence" open>
        raw payload
      </TechnicalDetails>
    )
    const text = container.querySelector('.pc-technical-details-body').textContent
    expect(text).toContain(`Phase${currentFact.phase}`)
    expect(text).toContain(`State${currentFact.state}`)
    expect(text).toContain(`Source${currentFact.source}`)
    expect(text).toContain(`Checked at${currentFact.checkedAt}`)
    expect(text).toContain(`Stale after${currentFact.staleAfterMs}`)
    expect(text).toContain(`Confirmed ledger${currentFact.confirmedLedger}`)
    expect(text).toContain(`Confirmed block${currentFact.confirmedBlock}`)
    expect(text).toContain('raw payload')
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
    const { container } = render(
      <TechnicalDetails fact={currentFact}>raw payload</TechnicalDetails>
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------
// VenueTruth
// ---------------------------------------------------------------------------

describe('VenueTruth', () => {
  it('renders live Autofarm -> Blend venue copy for kind=stellar-live', () => {
    render(<VenueTruth kind="stellar-live" venue="Autofarm Vault" fact={currentFact} />)
    expect(screen.getByText(/Autofarm Vault/)).toBeTruthy()
    expect(screen.getByText(/Blend/)).toBeTruthy()
  })

  it('shows an APY figure when state is live', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        fact={currentFact}
        apy={{ state: 'live', value: 8.2 }}
      />
    )
    expect(screen.getByText(/8.2/)).toBeTruthy()
    expect(screen.getByText(/APY/)).toBeTruthy()
  })

  it('shows live APY with the Fact source and freshness metadata', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        fact={currentFact}
        apy={{ state: 'live', value: 8.2 }}
      />
    )
    expect(screen.getByText(/8.2/)).toBeTruthy()
    expect(screen.getByText(/APY/)).toBeTruthy()
    expect(screen.getByText(currentFact.source)).toBeTruthy()
    expect(screen.getByText(currentFact.checkedAt)).toBeTruthy()
  })

  it('keeps Fact provenance exclusive when APY metadata contradicts it', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        fact={currentFact}
        apy={{
          state: 'live',
          value: 8.2,
          source: 'Untrusted APY source',
          freshness: 'Untrusted APY timestamp',
        }}
      />
    )
    expect(screen.getByText(currentFact.source)).toBeTruthy()
    expect(screen.getByText(currentFact.checkedAt)).toBeTruthy()
    expect(screen.queryByText('Untrusted APY source')).toBeNull()
    expect(screen.queryByText('Untrusted APY timestamp')).toBeNull()
  })

  it('suppresses an estimated APY even when a source accompanies it', () => {
    render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        apy={{ state: 'estimated', value: 5, source: 'DeFiLlama' }}
      />
    )
    expect(screen.queryByText(/5/)).toBeNull()
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

  it.each([undefined, null, 'live', 'toString', 'constructor', {}])(
    'fails closed for an invalid venue kind %#',
    (kind) => {
      render(
        <VenueTruth
          kind={kind}
          venue="Autofarm Vault"
          apy={{ state: 'live', value: 8.2, source: 'Fake source', freshness: 'Fake time' }}
        />
      )
      expect(screen.getByText('Unknown venue')).toBeTruthy()
      expect(screen.queryByText(/supplies to Blend/)).toBeNull()
      expect(screen.queryByText(/APY/)).toBeNull()
    }
  )

  it('suppresses a throwing APY getter without propagating the error', () => {
    const apyWithGetter = {}
    Object.defineProperty(apyWithGetter, 'state', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('hostile APY getter')
      },
    })

    expect(() => render(<VenueTruth kind="stellar-live" apy={apyWithGetter} />)).not.toThrow()
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('suppresses a hostile APY proxy without propagating the trap error', () => {
    const apyProxy = new Proxy(
      { state: 'live', value: 8.2, source: 'Fake source', freshness: 'Fake time' },
      {
        ownKeys: () => {
          throw new Error('hostile APY keys')
        },
      }
    )

    expect(() => render(<VenueTruth kind="stellar-live" apy={apyProxy} />)).not.toThrow()
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('suppresses a revoked APY proxy without propagating reflection errors', () => {
    const revocable = Proxy.revocable(
      { state: 'live', value: 8.2, source: 'Fake source', freshness: 'Fake time' },
      {}
    )
    revocable.revoke()

    expect(() => render(<VenueTruth kind="stellar-live" apy={revocable.proxy} />)).not.toThrow()
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('suppresses object-valued APY provenance without rendering object text', () => {
    const malformedApy = {
      state: 'live',
      value: 8.2,
      source: { toString: () => 'unsafe source' },
      freshness: { checkedAt: 'unsafe time' },
    }

    expect(() => render(<VenueTruth kind="stellar-live" apy={malformedApy} />)).not.toThrow()
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
    const live = render(
      <VenueTruth kind="stellar-live" venue="Autofarm Vault" fact={currentFact} />
    )
    const proxy = render(<VenueTruth kind="base-proxy" />)
    expect(live.container.firstChild.className).not.toBe(proxy.container.firstChild.className)
  })

  it('has zero axe violations for the live venue', async () => {
    const { container } = render(
      <VenueTruth
        kind="stellar-live"
        venue="Autofarm Vault"
        fact={currentFact}
        apy={{ state: 'live', value: 8.2 }}
      />
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

  it('labels and describes one dominant stage without uppercasing the h1', () => {
    const { container } = render(
      <StageShell
        eyebrow="Review"
        title="Review your grant"
        description="One signature."
        state="blocked"
      />
    )
    const section = container.querySelector('section')
    const h1 = section.querySelector('h1')
    const description = section.querySelector('.pc-stage-description')
    expect(h1.textContent).toBe('Review your grant')
    expect(h1.textContent).not.toBe(h1.textContent.toUpperCase())
    expect(section.dataset.state).toBe('blocked')
    expect(section.getAttribute('aria-labelledby')).toBe(h1.id)
    expect(section.getAttribute('aria-describedby')).toBe(description.id)
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

describe('Pocket Crew dialog geometry contract', () => {
  it('uses the exact bounded desktop and safe-area mobile sheet geometry', () => {
    const css = readFileSync(
      resolve(globalThis.process.cwd(), 'src/design/pocket-crew.css'),
      'utf8'
    )
    expect(css).toMatch(/\.pc-dialog\s*\{[\s\S]*?display:\s*grid;/)
    expect(css).toMatch(/\.pc-dialog\s*\{[\s\S]*?z-index:\s*var\(--pc-z-overlay\);/)
    expect(css).toMatch(/\.pc-dialog-panel\s*\{[\s\S]*?z-index:\s*var\(--pc-z-dialog\);/)
    expect(css).toMatch(/\.pc-dialog-panel\s*\{[\s\S]*?width:\s*min\(100%,\s*480px\);/)
    expect(css).toMatch(
      /\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\(760px,\s*calc\(100dvh\s*-\s*32px\)\);/
    )
    expect(css).toMatch(
      /\.pc-dialog--sheet\s+\.pc-dialog-panel\s*\{[\s\S]*?border-radius:\s*var\(--pc-radius-dominant\)\s+var\(--pc-radius-dominant\)\s+0\s+0;/
    )
    expect(css).toMatch(
      /\.pc-dialog--sheet\s+\.pc-dialog-panel\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--pc-space-6\)\s*\+\s*env\(safe-area-inset-bottom\)\);/
    )
  })

  it('caps auto and sheet panels against the scaled overlay box at 200% zoom', () => {
    const css = readFileSync(
      resolve(globalThis.process.cwd(), 'src/design/pocket-crew.css'),
      'utf8'
    )

    // `dvh` stays in the unscaled layout viewport while documentElement.style.zoom scales the
    // painted panel. The percentage mirror is relative to the fixed overlay's actual box, so
    // it remains a visual-viewport bound and still resolves to the locked 88dvh at normal zoom.
    expect(css).toMatch(
      /\.pc-dialog\.pc-dialog--auto\s+\.pc-dialog-panel,[\s\S]*?\.pc-dialog\.pc-dialog--dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\([\s\S]*?760px,[\s\S]*?calc\(100dvh\s*-\s*var\(--pc-space-8\)\),[\s\S]*?calc\(100%\s*-\s*var\(--pc-space-8\)\)\s*\)\s*;/
    )
    expect(css).toMatch(
      /\.pc-dialog\.pc-dialog--sheet\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\(88dvh,\s*88%\);/
    )
    expect(css).toMatch(
      /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pc-dialog\.pc-dialog--auto\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\(88dvh,\s*88%\);/
    )
  })

  it('stacks every Foundation dialog action and expands its buttons below the mobile breakpoint', () => {
    const css = readFileSync(
      resolve(globalThis.process.cwd(), 'src/design/pocket-crew.css'),
      'utf8'
    )

    // The base rule must stay flex so desktop dialogs retain their end-aligned action row. At the
    // narrow breakpoint, a one-column grid plus a zero intrinsic minimum keeps long labels inside
    // the scaled panel instead of making `justify-content: flex-end` paint the first action left
    // of the visible viewport.
    expect(css).toMatch(/\.pc-dialog-actions\s*\{[\s\S]*?display:\s*flex;/)
    expect(css).toMatch(
      /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pc-dialog-actions\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?gap:\s*var\(--pc-space-3\);/
    )
    expect(css).toMatch(
      /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pc-dialog-actions\s+\.pc-button\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/
    )
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
  it('locks body scroll through the raw style attribute rather than the live CSSOM', () => {
    const source = readFileSync(
      resolve(globalThis.process.cwd(), 'src/components/pocket/Primitives.jsx'),
      'utf8'
    )
    expect(source).not.toMatch(/\bbody\.style\b/)
  })

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

  // Regression (review fix, Important 3): a normal controlled-input pattern re-renders the
  // parent -- and therefore passes Dialog a brand-new inline `onClose` -- on every keystroke.
  // The focus trap must not treat that as "the dialog re-opened": it must not move focus off the
  // input (to the trigger, then back to the first focusable element) on every render.
  function ReRenderHarness() {
    const [open, setOpen] = useState(false)
    const [text, setText] = useState('')
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        {/* A fresh arrow function every render, on purpose -- the normal, idiomatic pattern. */}
        <Dialog
          open={open}
          title="Edit note"
          onClose={() => setOpen(false)}
          actions={
            <button type="button" data-testid="confirm-btn">
              Save
            </button>
          }
        >
          {/* A decoy focusable BEFORE the input: if the trap wrongly re-runs and re-applies its
              "focus the first focusable element" logic on every keystroke, focus lands here
              instead of staying on the input -- that's what this test catches. */}
          <button type="button" data-testid="decoy-btn">
            Decoy
          </button>
          <input data-testid="note-input" value={text} onChange={(e) => setText(e.target.value)} />
        </Dialog>
      </div>
    )
  }

  it('keeps focus on a parent-controlled input inside the dialog across parent re-renders', () => {
    render(<ReRenderHarness />)
    fireEvent.click(screen.getByText('Open dialog'))
    const input = screen.getByTestId('note-input')
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'h' } })
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'hi' } })
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('hi')
  })

  it('isolates every background sibling with inert and aria-hidden while the fallback dialog is open', () => {
    render(
      <div data-testid="dialog-host">
        <section data-testid="background-section">
          <button type="button">Background action</button>
        </section>
        <div data-testid="dialog-ancestor">
          <Dialog
            open
            title="Isolation test"
            description="Background must be unavailable."
            onClose={() => {}}
          >
            <button type="button">Dialog action</button>
          </Dialog>
        </div>
      </div>
    )

    const dialog = screen.getByRole('dialog')
    const background = screen.getByTestId('background-section')
    const ancestor = screen.getByTestId('dialog-ancestor')

    expect(dialog.tagName).toBe('DIV')
    expect(background.hasAttribute('inert')).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('true')
    expect(ancestor.hasAttribute('inert')).toBe(false)
    expect(ancestor.hasAttribute('aria-hidden')).toBe(false)
  })

  it('locks body scrolling and restores preexisting body and background attributes exactly on close', () => {
    const originalBodyStyle = 'overflow: auto; color: rgb(9, 8, 7);'
    document.body.setAttribute('style', originalBodyStyle)

    function RestoreHarness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <section data-testid="restore-background" inert="" aria-hidden="false">
            <button type="button">Background</button>
          </section>
          <button type="button" onClick={() => setOpen(true)}>
            Open restore dialog
          </button>
          <Dialog
            open={open}
            title="Restore test"
            onClose={() => setOpen(false)}
            actions={
              <button type="button" onClick={() => setOpen(false)}>
                Close restore dialog
              </button>
            }
          />
        </div>
      )
    }

    render(<RestoreHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open restore dialog' }))
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('restore-background').getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Close restore dialog' }))
    expect(document.body.getAttribute('style')).toBe(originalBodyStyle)
    expect(screen.getByTestId('restore-background').getAttribute('inert')).toBe('')
    expect(screen.getByTestId('restore-background').getAttribute('aria-hidden')).toBe('false')
  })

  it('reference-counts sequential dialog locks so closing one cannot unlock another', () => {
    const originalBodyStyle = 'overflow: scroll; overscroll-behavior: contain;'
    document.body.setAttribute('style', originalBodyStyle)

    function MultipleDialogHarness() {
      const [firstOpen, setFirstOpen] = useState(false)
      const [secondOpen, setSecondOpen] = useState(false)
      return (
        <div>
          <section data-testid="multiple-background">
            <button type="button">Background action</button>
          </section>
          <button type="button" onClick={() => setFirstOpen(true)}>
            Open first dialog
          </button>
          <Dialog
            open={firstOpen}
            title="First dialog"
            onClose={() => setFirstOpen(false)}
            children={
              <>
                <button type="button" onClick={() => setSecondOpen(true)}>
                  Open second dialog
                </button>
                <Dialog
                  open={secondOpen}
                  title="Second dialog"
                  onClose={() => setSecondOpen(false)}
                  actions={
                    <button type="button" onClick={() => setSecondOpen(false)}>
                      Close second dialog
                    </button>
                  }
                />
              </>
            }
            actions={
              <button type="button" onClick={() => setFirstOpen(false)}>
                Close first dialog
              </button>
            }
          />
        </div>
      )
    }

    render(<MultipleDialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open first dialog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open second dialog' }))
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Close second dialog' }))
    expect(screen.getByRole('dialog', { name: 'First dialog' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('multiple-background').hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('multiple-background').getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByText('Close first dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.getAttribute('style')).toBe(originalBodyStyle)
    expect(screen.getByTestId('multiple-background').hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('multiple-background').hasAttribute('aria-hidden')).toBe(false)
  })

  it('keeps a controlled dialog isolated when its close request is refused', () => {
    const originalBodyStyle = 'overflow: scroll; color: rgb(9, 8, 7);'
    document.body.setAttribute('style', originalBodyStyle)
    let closeRequests = 0

    function RefusingDialogHarness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <section data-testid="refusing-background">Background</section>
          <button type="button" onClick={() => setOpen(true)}>
            Open refusing dialog
          </button>
          <Dialog
            open={open}
            title="Refusing dialog"
            onClose={() => {
              closeRequests += 1
            }}
            actions={<button type="button">Keep open</button>}
          />
        </div>
      )
    }

    render(<RefusingDialogHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open refusing dialog' }))
    const dialog = screen.getByRole('dialog', { name: 'Refusing dialog' })
    const background = screen.getByTestId('refusing-background')
    expect(document.body.style.overflow).toBe('hidden')
    expect(background.getAttribute('inert')).toBe('')
    expect(background.getAttribute('aria-hidden')).toBe('true')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeRequests).toBe(1)
    expect(screen.getByRole('dialog', { name: 'Refusing dialog' })).toBe(dialog)
    expect(document.body.style.overflow).toBe('hidden')
    expect(background.getAttribute('inert')).toBe('')
    expect(background.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(dialog)
    expect(closeRequests).toBe(2)
    expect(screen.getByRole('dialog', { name: 'Refusing dialog' })).toBe(dialog)
    expect(document.body.style.overflow).toBe('hidden')
    expect(background.getAttribute('inert')).toBe('')
    expect(background.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it.each([
    ['first', 'second'],
    ['second', 'first'],
  ])(
    'keeps concurrent sibling dialogs and their ancestors visible while closing %s then %s',
    (firstToClose, secondToClose) => {
      const originalBodyStyle = 'overflow: scroll; color: rgb(9, 8, 7);'
      document.body.setAttribute('style', originalBodyStyle)

      function SiblingDialogHarness() {
        const [firstOpen, setFirstOpen] = useState(false)
        const [secondOpen, setSecondOpen] = useState(false)
        return (
          <div data-testid="sibling-host">
            <section data-testid="sibling-background" inert="" aria-hidden="false">
              Background content
            </section>
            <button type="button" onClick={() => setFirstOpen(true)}>
              Open first sibling
            </button>
            <button type="button" onClick={() => setSecondOpen(true)}>
              Open second sibling
            </button>
            <Dialog
              open={firstOpen}
              title="First sibling dialog"
              onClose={() => setFirstOpen(false)}
              actions={
                <button type="button" onClick={() => setFirstOpen(false)}>
                  Close first sibling
                </button>
              }
            >
              <p>First sibling content</p>
            </Dialog>
            <Dialog
              open={secondOpen}
              title="Second sibling dialog"
              onClose={() => setSecondOpen(false)}
              actions={
                <button type="button" onClick={() => setSecondOpen(false)}>
                  Close second sibling
                </button>
              }
            >
              <p>Second sibling content</p>
            </Dialog>
          </div>
        )
      }

      render(<SiblingDialogHarness />)
      // Open both in one state transition so both dialogs are concurrently active before either
      // isolation effect can settle. Directly firing the background second opener is intentional:
      // the test exercises the registry's concurrent state, not user reachability through inert.
      fireEvent.click(screen.getByRole('button', { name: 'Open first sibling' }))
      fireEvent.click(screen.getByText('Open second sibling'))

      const first = screen.getByRole('dialog', { name: 'First sibling dialog' })
      const second = screen.getByRole('dialog', { name: 'Second sibling dialog' })
      const background = screen.getByTestId('sibling-background')
      expect(first.hasAttribute('inert')).toBe(false)
      expect(first.hasAttribute('aria-hidden')).toBe(false)
      expect(second.hasAttribute('inert')).toBe(false)
      expect(second.hasAttribute('aria-hidden')).toBe(false)
      expect(background.hasAttribute('inert')).toBe(true)
      expect(background.getAttribute('aria-hidden')).toBe('true')

      fireEvent.click(screen.getByText(`Close ${firstToClose} sibling`))
      const remaining = screen.getByRole('dialog', {
        name: `${secondToClose[0].toUpperCase()}${secondToClose.slice(1)} sibling dialog`,
      })
      expect(remaining.hasAttribute('inert')).toBe(false)
      expect(remaining.hasAttribute('aria-hidden')).toBe(false)
      expect(background.hasAttribute('inert')).toBe(true)
      expect(background.getAttribute('aria-hidden')).toBe('true')

      fireEvent.click(screen.getByText(`Close ${secondToClose} sibling`))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.body.getAttribute('style')).toBe(originalBodyStyle)
      expect(background.getAttribute('inert')).toBe('')
      expect(background.getAttribute('aria-hidden')).toBe('false')
    }
  )

  it('dispatches one Escape close request to the topmost sibling only', () => {
    const closeRequests = []

    function SiblingEscapeHarness() {
      const [firstOpen, setFirstOpen] = useState(true)
      const [secondOpen, setSecondOpen] = useState(true)
      return (
        <div>
          <section data-testid="escape-sibling-background">Background</section>
          <Dialog
            open={firstOpen}
            title="First Escape sibling"
            onClose={() => {
              closeRequests.push('first')
              setFirstOpen(false)
            }}
          />
          <Dialog
            open={secondOpen}
            title="Second Escape sibling"
            onClose={() => {
              closeRequests.push('second')
              setSecondOpen(false)
            }}
          />
        </div>
      )
    }

    render(<SiblingEscapeHarness />)
    expect(screen.getByRole('dialog', { name: 'First Escape sibling' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Second Escape sibling' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(closeRequests).toEqual(['second'])
    expect(screen.getByRole('dialog', { name: 'First Escape sibling' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Second Escape sibling' })).toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('escape-sibling-background').getAttribute('inert')).toBe('')
  })

  it('closes a nested topmost dialog once, restores focus to its parent, then closes the parent', () => {
    const closeRequests = []
    const originalBodyStyle = 'overflow: scroll; color: rgb(9, 8, 7);'
    document.body.setAttribute('style', originalBodyStyle)

    function NestedEscapeHarness() {
      const [outerOpen, setOuterOpen] = useState(false)
      const [innerOpen, setInnerOpen] = useState(false)
      return (
        <div>
          <section data-testid="nested-escape-background">Background</section>
          <button type="button" onClick={() => setOuterOpen(true)}>
            Open outer Escape dialog
          </button>
          <Dialog
            open={outerOpen}
            title="Outer Escape dialog"
            onClose={() => {
              closeRequests.push('outer')
              setOuterOpen(false)
            }}
            actions={
              <button type="button" onClick={() => setOuterOpen(false)}>
                Close outer Escape dialog
              </button>
            }
          >
            <button type="button" onClick={() => setInnerOpen(true)}>
              Open inner Escape dialog
            </button>
            <Dialog
              open={innerOpen}
              title="Inner Escape dialog"
              onClose={() => {
                closeRequests.push('inner')
                setInnerOpen(false)
              }}
              actions={
                <button type="button" onClick={() => setInnerOpen(false)}>
                  Close inner Escape dialog
                </button>
              }
            />
          </Dialog>
        </div>
      )
    }

    render(<NestedEscapeHarness />)
    const outerOpener = screen.getByRole('button', { name: 'Open outer Escape dialog' })
    outerOpener.focus()
    fireEvent.click(outerOpener)
    const innerOpener = screen.getByRole('button', { name: 'Open inner Escape dialog' })
    fireEvent.click(innerOpener)
    expect(screen.getByRole('dialog', { name: 'Inner Escape dialog' })).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(closeRequests).toEqual(['inner'])
    expect(screen.getByRole('dialog', { name: 'Outer Escape dialog' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Inner Escape dialog' })).toBeNull()
    expect(document.activeElement).toBe(innerOpener)
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('nested-escape-background').getAttribute('inert')).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Close outer Escape dialog' }))
    expect(closeRequests).toEqual(['inner'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(outerOpener)
    expect(document.body.getAttribute('style')).toBe(originalBodyStyle)
    expect(screen.getByTestId('nested-escape-background').hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('nested-escape-background').hasAttribute('aria-hidden')).toBe(false)
  })

  it('does not broadcast Escape when the topmost sibling refuses its close request', () => {
    const closeRequests = []

    function RefusingSiblingHarness() {
      const [firstOpen, setFirstOpen] = useState(true)
      const [secondOpen] = useState(true)
      return (
        <div>
          <section data-testid="refusing-sibling-background">Background</section>
          <Dialog
            open={firstOpen}
            title="First refusing sibling"
            onClose={() => {
              closeRequests.push('first')
              setFirstOpen(false)
            }}
          />
          <Dialog
            open={secondOpen}
            title="Top refusing sibling"
            onClose={() => {
              closeRequests.push('top')
            }}
          />
        </div>
      )
    }

    render(<RefusingSiblingHarness />)
    const first = screen.getByRole('dialog', { name: 'First refusing sibling' })
    const top = screen.getByRole('dialog', { name: 'Top refusing sibling' })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(closeRequests).toEqual(['top'])
    expect(screen.getByRole('dialog', { name: 'First refusing sibling' })).toBe(first)
    expect(screen.getByRole('dialog', { name: 'Top refusing sibling' })).toBe(top)
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('refusing-sibling-background').getAttribute('inert')).toBe('')
    expect(screen.getByTestId('refusing-sibling-background').getAttribute('aria-hidden')).toBe(
      'true'
    )
  })

  it('cleans isolation on unmount, including a StrictMode effect replay', () => {
    const originalBodyStyle = 'overflow: auto;'
    document.body.setAttribute('style', originalBodyStyle)

    const { unmount } = render(
      <div>
        <section data-testid="unmount-background">Background</section>
        <Dialog open title="Unmount test" onClose={() => {}} />
      </div>,
      { reactStrictMode: true }
    )

    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByTestId('unmount-background').hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('unmount-background').getAttribute('aria-hidden')).toBe('true')

    unmount()
    expect(document.body.getAttribute('style')).toBe(originalBodyStyle)
  })
})

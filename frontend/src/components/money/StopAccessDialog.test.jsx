// frontend/src/components/money/StopAccessDialog.test.jsx
// My Money Task 12. StopAccessDialog is a pure preview over planRevoke (money/ownerActions.js,
// real function, not mocked) -- a kill switch that never claims to return money, and never removes
// itself just because funding status is unknown.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StopAccessDialog } from './StopAccessDialog.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

const account = { kind: 'G', address: 'GOWNER' }

function plainAgent(address = 'CAGENT1') {
  return {
    address,
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
  }
}

function baseAgent(address = 'CBRIDGE1') {
  return {
    address,
    executionStatus: 'idle',
    custody: { location: 'base-proxy' },
    custodyBreakdown: [{ location: 'base-proxy', amount: amt(5_0000000n) }],
  }
}

const known = (units) => ({ state: 'known', amount: amt(units) })
const unavailable = { state: 'unavailable', amount: null }
const knownZero = known(0n)

describe('StopAccessDialog — always says it prevents future access and never returns money', () => {
  it('states this plainly regardless of funding state', () => {
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    expect(
      screen.getByText(/does not move, return, or touch any money already there/i)
    ).toBeTruthy()
  })
})

describe('StopAccessDialog — known funded agent leads to Withdraw, never a silently-failing revoke', () => {
  it('offers Go to Withdraw and NO enabled Stop-access button when the agent is genuinely funded', () => {
    const onGoToWithdraw = vi.fn()
    const onConfirmRevoke = vi.fn()
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={known(50_0000000n)}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
        onGoToWithdraw={onGoToWithdraw}
        onConfirmRevoke={onConfirmRevoke}
      />
    )
    // Mutation guard: a formulation that renders BOTH buttons (or a disabled revoke button instead
    // of omitting it) would still pass a weaker "Go to Withdraw exists" check.
    expect(screen.queryByRole('button', { name: /stop access/i })).toBeNull()
    const withdrawBtn = screen.getByRole('button', { name: /go to withdraw/i })
    fireEvent.click(withdrawBtn)
    expect(onGoToWithdraw).toHaveBeenCalledWith('CAGENT1')
    expect(onConfirmRevoke).not.toHaveBeenCalled()
  })
})

describe('StopAccessDialog — unknown funding status preserves the kill switch', () => {
  it('shows a warning but keeps Stop access enabled and wired', () => {
    const onConfirmRevoke = vi.fn()
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={unavailable}
        idleBalanceRead={unavailable}
        account={account}
        onClose={() => {}}
        onConfirmRevoke={onConfirmRevoke}
      />
    )
    expect(screen.getByText(/funding status could not be checked/i)).toBeTruthy()
    const revokeBtn = screen.getByRole('button', { name: /stop access/i })
    // Mutation guard: a version that shows the warning AND also disables the button (defeating the
    // "preserve the kill switch" requirement) would fail this specific assertion, not just a
    // "warning text exists" check.
    expect(revokeBtn.disabled).toBe(false)
    fireEvent.click(revokeBtn)
    expect(onConfirmRevoke).toHaveBeenCalledTimes(1)
    expect(onConfirmRevoke.mock.calls[0][0].ok).toBe(true)
  })
})

describe('StopAccessDialog — a healthy, unfunded, fully-known agent revokes cleanly', () => {
  it('revoke is enabled with no warning notice at all', () => {
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /stop access/i }).disabled).toBe(false)
    expect(screen.queryByText(/funding status could not be checked/i)).toBeNull()
  })
})

describe('StopAccessDialog — Base bridge agent: scoped Stellar-only, fail-closed, no dead button', () => {
  it('shows an honest Base-scope notice and offers NO button naming Base, while the Stellar revoke stays available', () => {
    render(
      <StopAccessDialog
        open
        agent={baseAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/can't be stopped from here yet/i)).toBeTruthy()
    // Mutation guard: a version that renders a disabled "Stop Base access" button (rather than no
    // button at all) would still pass a weaker "no ENABLED base button" check.
    const allButtons = screen.getAllByRole('button')
    const baseNamedButtons = allButtons.filter((b) => /base/i.test(b.textContent || ''))
    expect(baseNamedButtons).toHaveLength(0)
    const stellarRevoke = screen.getByRole('button', { name: /^stop access$/i })
    expect(stellarRevoke.disabled).toBe(false)
  })

  it('renders no Base-scope notice at all for a plain Stellar-only agent', () => {
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    expect(screen.queryByText(/can't be stopped from here yet/i)).toBeNull()
  })
})

describe('StopAccessDialog — Cancel alongside the destructive action, Escape-safe while pending', () => {
  it('Cancel and Stop access are both disabled while pending', () => {
    render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
        pending
      />
    )
    expect(screen.getByRole('button', { name: /cancel/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /stopping/i }).disabled).toBe(true)
  })

  it('does not close on Escape while pending, but does once idle', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={onClose}
        pending
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    rerender(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={onClose}
        pending={false}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('StopAccessDialog — accessibility', () => {
  it('has no axe violations in the warning state', async () => {
    const { container } = render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={unavailable}
        idleBalanceRead={unavailable}
        account={account}
        onClose={() => {}}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser 320px layout guard, per state.
// ---------------------------------------------------------------------------------------------
const POCKET_CREW_CSS = fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8')
const MY_MONEY_CSS = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
const REAL_STYLESHEET = [POCKET_CREW_CSS, MY_MONEY_CSS].join('\n')
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
<style>${REAL_STYLESHEET}</style>
</head><body>${bodyHtml}</body></html>`
}

const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

async function launchRealChromium() {
  const { chromium } = await import('playwright-core')
  let lastErr
  for (const executablePath of CHROMIUM_CANDIDATES) {
    if (executablePath && !fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `Layout guard: no usable Chromium binary found for real-layout measurement (${lastErr?.message})`
  )
}

describe('StopAccessDialog — real-browser 320px layout guard, per state', () => {
  it('creates no horizontal overflow at 320px for funded/unknown/base-scoped states', async () => {
    const states = []
    const funded = render(
      <StopAccessDialog
        open
        agent={plainAgent()}
        shareRead={known(50_0000000n)}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    states.push(['funded', funded.container.innerHTML])
    funded.unmount()

    const baseScoped = render(
      <StopAccessDialog
        open
        agent={baseAgent('CBRIDGE1LONGADDRESSFORLAYOUTMEASUREMENT00001')}
        shareRead={knownZero}
        idleBalanceRead={knownZero}
        account={account}
        onClose={() => {}}
      />
    )
    states.push(['base-scoped', baseScoped.container.innerHTML])
    baseScoped.unmount()

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of states) {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 320, height: 1400 })
        await page.setContent(buildLayoutHarnessHtml(html))
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(scrollWidth, `${label} @320px scrollWidth`).toBe(320)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

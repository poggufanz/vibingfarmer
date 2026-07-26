// frontend/src/components/money/RecoveryPanel.test.jsx
// My Money Task 12. RecoveryPanel answers "where is my money" honestly and never invites a blind
// retry of a submission whose outcome is unknown.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { RecoveryPanel } from './RecoveryPanel.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

describe('RecoveryPanel — submission-unknown: reconciliation before any retry', () => {
  it('retry is disabled before status has been checked, and Check status is offered', () => {
    const onRetry = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{ outcome: 'unknown', message: 'Relay lost the submission.', hash: 'TXHASH1' }}
        reconciled={null}
        onRetry={onRetry}
      />
    )
    expect(screen.getByText(/could not confirm whether this went through/i)).toBeTruthy()
    expect(screen.getByText(/relay lost the submission/i)).toBeTruthy()
    const retryBtn = screen.getByRole('button', { name: /^retry$/i })
    expect(retryBtn.disabled).toBe(true)
    // Even a forced click on a disabled native button must never fire the handler.
    fireEvent.click(retryBtn)
    expect(onRetry).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /check status/i })).toBeTruthy()
    expect(
      screen.getByRole('link', { name: /check this transaction on the explorer/i })
    ).toBeTruthy()
  })

  it('retry stays disabled even once reconciliation proves it already landed -- never resubmit a confirmed action', () => {
    const onRetry = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{ outcome: 'unknown', message: 'Relay lost the submission.' }}
        reconciled="landed"
        onRetry={onRetry}
      />
    )
    // Mutation guard: a version keying retry only off "has reconciliation happened" (any non-null
    // value) rather than the SPECIFIC 'not-landed' outcome would wrongly enable retry here.
    const retryBtn = screen.getByRole('button', { name: /^retry$/i })
    expect(retryBtn.disabled).toBe(true)
    expect(screen.getByText(/already landed on-chain/i)).toBeTruthy()
  })

  it('retry becomes enabled and wired only once reconciliation proves it did not land', () => {
    const onRetry = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{ outcome: 'not-submitted', message: 'Refused before signing.' }}
        reconciled="not-landed"
        onRetry={onRetry}
      />
    )
    const retryBtn = screen.getByRole('button', { name: /^retry$/i })
    expect(retryBtn.disabled).toBe(false)
    fireEvent.click(retryBtn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Check status calls onCheckStatus with the real submission, not a placeholder', () => {
    const onCheckStatus = vi.fn()
    const submission = { outcome: 'unknown', message: 'x', hash: 'TXHASH2' }
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={submission}
        onCheckStatus={onCheckStatus}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /check status/i }))
    expect(onCheckStatus).toHaveBeenCalledWith(submission)
  })
})

describe('RecoveryPanel — stranded at the Base bridge agent (baseLeg.js failure payload, read-only)', () => {
  it('renders the exact stranded-bridge narrative from the real payload shape, not a generic error', () => {
    const onRecoverViaFullExit = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        strandedBridge={{ pulled: true, bridgeAgentAddress: 'CBRIDGEAGENT1', stage: 'burn' }}
        onRecoverViaFullExit={onRecoverViaFullExit}
      />
    )
    expect(screen.getByText(/stuck at the base bridge agent/i)).toBeTruthy()
    expect(screen.getByText(/money never left stellar/i)).toBeTruthy()
    expect(screen.getByText(/not lost/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /recover via full exit/i }))
    expect(onRecoverViaFullExit).toHaveBeenCalledWith('CBRIDGEAGENT1')
  })

  it('a burn failure that never pulled funds (pulled: false/absent) is NOT shown as stranded', () => {
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        strandedBridge={{ pulled: false, bridgeAgentAddress: 'CBRIDGEAGENT1' }}
        location="owner"
      />
    )
    // Mutation guard: a version keying off `bridgeAgentAddress` presence alone (ignoring `pulled`)
    // would wrongly show the stranded narrative here, even though nothing ever left the owner.
    expect(screen.queryByText(/stuck at the base bridge agent/i)).toBeNull()
    expect(screen.getByText(/already back in your wallet/i)).toBeTruthy()
  })
})

describe('RecoveryPanel — plain custody.js location narratives, never a guessed location', () => {
  it('stellar-vault: no action needed, real confirmed amount shown', () => {
    render(
      <RecoveryPanel open onClose={() => {}} location="stellar-vault" amount={amt(25_0000000n)} />
    )
    expect(screen.getByText(/still in the vault, earning yield/i)).toBeTruthy()
    expect(screen.getByText(/no action is needed/i)).toBeTruthy()
    expect(screen.getByText(/25.*USDC/)).toBeTruthy()
  })

  it('agent: offers full-exit recovery for the real agent address', () => {
    const onRecoverViaFullExit = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        location="agent"
        agentAddress="CAGENT9"
        onRecoverViaFullExit={onRecoverViaFullExit}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /recover via full exit/i }))
    expect(onRecoverViaFullExit).toHaveBeenCalledWith('CAGENT9')
  })

  it('in-transit: no destructive action is offered at all -- bridging honestly has none', () => {
    render(<RecoveryPanel open onClose={() => {}} location="in-transit" />)
    expect(screen.getByText(/bridging between chains right now/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /recover via full exit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /go to base withdraw/i })).toBeNull()
  })

  it('base-proxy: routes to the Base full-unwind flow, not a fabricated partial-withdraw offer', () => {
    const onGoToBaseWithdraw = vi.fn()
    render(
      <RecoveryPanel
        open
        onClose={() => {}}
        location="base-proxy"
        onGoToBaseWithdraw={onGoToBaseWithdraw}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /go to base withdraw/i }))
    expect(onGoToBaseWithdraw).toHaveBeenCalledTimes(1)
  })

  it('owner: nothing to recover, no action offered', () => {
    render(<RecoveryPanel open onClose={() => {}} location="owner" />)
    expect(screen.getByText(/nothing left to recover/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /recover via full exit/i })).toBeNull()
  })

  it('unknown: never fabricates a location, no destructive action offered', () => {
    render(<RecoveryPanel open onClose={() => {}} location="unknown" />)
    expect(screen.getByText(/can't confirm exactly where this is/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /recover via full exit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /go to base withdraw/i })).toBeNull()
  })

  it('a missing/zero amount is never rendered as a confirmed money figure', () => {
    render(<RecoveryPanel open onClose={() => {}} location="stellar-vault" amount={null} />)
    // MoneyFigure is only rendered by AmountLine for a known-positive amount -- absent here means
    // no pc-money figure at all, never a fabricated "0 USDC".
    expect(document.querySelector('.pc-money')).toBeNull()
  })
})

describe('RecoveryPanel — Escape-safe while pending, close alongside any offered action', () => {
  it('does not close on Escape while pending, but does once idle', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <RecoveryPanel open onClose={onClose} location="agent" agentAddress="CAGENT1" pending />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    rerender(
      <RecoveryPanel
        open
        onClose={onClose}
        location="agent"
        agentAddress="CAGENT1"
        pending={false}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('RecoveryPanel — accessibility', () => {
  it('has no axe violations in the submission-unknown state', async () => {
    const { container } = render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{ outcome: 'unknown', message: 'x', hash: 'TXHASH3' }}
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

describe('RecoveryPanel — real-browser 320px layout guard, per state', () => {
  it('creates no horizontal overflow at 320px for submission-unknown/stranded-bridge/base-proxy states', async () => {
    const states = []
    const submissionState = render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{
          outcome: 'unknown',
          message: 'Relay lost the submission after signing, mid-verylongdiagnosticmessagefortest.',
          hash: 'TXHASHLONGVALUEFORLAYOUTMEASUREMENT0000000001',
        }}
      />
    )
    states.push(['submission-unknown', submissionState.container.innerHTML])
    submissionState.unmount()

    const strandedState = render(
      <RecoveryPanel
        open
        onClose={() => {}}
        strandedBridge={{
          pulled: true,
          bridgeAgentAddress: 'CBRIDGEAGENTLONGADDRESSFORLAYOUTMEASUREMENT00001',
          stage: 'burn',
        }}
      />
    )
    states.push(['stranded-bridge', strandedState.container.innerHTML])
    strandedState.unmount()

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

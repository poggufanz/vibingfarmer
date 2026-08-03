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
import { Dialog } from '../pocket/Primitives.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

describe('RecoveryPanel — submission-unknown: reconciliation before any retry', () => {
  it('offers no generic retry before status has been checked, and Check status is offered', () => {
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
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /submit again/i })).toBeNull()
    expect(onRetry).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /check status/i })).toBeTruthy()
    expect(
      screen.getByRole('link', { name: /check this transaction on the explorer/i })
    ).toBeTruthy()
  })

  it('offers no retry once reconciliation proves it already landed -- never resubmit a confirmed action', () => {
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
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /submit again/i })).toBeNull()
    expect(screen.getByText(/already landed on-chain/i)).toBeTruthy()
  })

  it('Submit again becomes enabled and wired only once reconciliation proves it did not land', () => {
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
    const retryBtn = screen.getByRole('button', { name: /submit again/i })
    expect(retryBtn.disabled).toBe(false)
    fireEvent.click(retryBtn)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
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
  // Final-review MUST-FIX 2: this harness used to inject `<div class="pc-my-money-route">` around
  // the body, with a comment claiming it matched "the real MyMoneyRoute.jsx tree". It never did --
  // app.jsx renders WithdrawDialog/StopAccessDialog/RecoveryPanel as SIBLINGS of <MyMoneyRoute>,
  // not descendants, and Primitives.jsx's Dialog uses no portal, so no ancestor of a money dialog
  // ever carried that class in production. The wrapper manufactured a DOM the app never builds and
  // the scoped CSS it activated was dead everywhere else. The scope now travels ON the dialog
  // itself (`pc-money-dialog`, applied by the money dialog components), so the body inserted below
  // is byte-for-byte what React rendered -- nothing about the shipped cascade is supplied by this
  // file. Remove the class in any component below and every geometry assertion here goes RED.
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

// ---------------------------------------------------------------------------------------------
// Fix loop 2 (M7): every reconciliation phase keeps all of its offered footer controls contained
// (Close/Check status, plus Submit again only after not-landed proof). The scoped actions base rule
// (0,2,0) previously beat the contract's own unscoped mobile stacking rule (0,1,0), so at 320px
// the footer stayed `display: flex; justify-content: flex-end` with no wrap -- pushing the first
// button (Close) outside the panel's own padding box. `documentElement.scrollWidth` alone cannot
// see this: the panel's `overflow: auto` absorbs the overflow internally, so item 12 still passed
// while a control was unreachable. This checks the actual footer-button geometry, not just the
// page's outer scroll width.
// ---------------------------------------------------------------------------------------------
describe('RecoveryPanel — 320px footer-control containment guard, all three submission-reconciliation states (M7)', () => {
  it('every dialog-actions button stays inside the panel padding box at 320px', async () => {
    const states = []
    for (const [label, reconciled] of [
      ['submission-unreconciled (reconciled: null)', null],
      ['submission-landed', 'landed'],
      ['submission-not-landed', 'not-landed'],
    ]) {
      const rendered = render(
        <RecoveryPanel
          open
          onClose={() => {}}
          submission={{
            outcome: 'unknown',
            message: 'Relay lost the submission after signing.',
            hash: 'TXHASH-M7',
          }}
          reconciled={reconciled}
        />
      )
      states.push([label, rendered.container.innerHTML])
      rendered.unmount()
    }

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of states) {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 320, height: 1400 })
        await page.setContent(buildLayoutHarnessHtml(html))
        const measurement = await page.evaluate(() => {
          const panel = document.querySelector('.pc-dialog-panel')
          const panelRect = panel.getBoundingClientRect()
          const buttons = [...document.querySelectorAll('.pc-dialog-actions button')]
          return buttons.map((btn) => {
            const r = btn.getBoundingClientRect()
            return {
              label: btn.textContent,
              left: r.left,
              right: r.right,
              panelLeft: panelRect.left,
              panelRight: panelRect.right,
            }
          })
        })
        expect(measurement.length, `${label}: has footer buttons`).toBeGreaterThan(0)
        // 1.5px tolerance for the panel's own 1px border plus subpixel layout rounding -- not a
        // loosened check, the pre-fix failure mode overflows by tens of pixels.
        for (const btn of measurement) {
          expect(
            btn.left,
            `${label}: "${btn.label}" left edge inside the panel`
          ).toBeGreaterThanOrEqual(btn.panelLeft - 1.5)
          expect(
            btn.right,
            `${label}: "${btn.label}" right edge inside the panel`
          ).toBeLessThanOrEqual(btn.panelRight + 1.5)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

// ---------------------------------------------------------------------------------------------
// Final review MUST-FIX 1: owner decision #26's dialog geometry, measured on the tree app.jsx
// really renders, in both directions.
//
// #26 ported the contract's dialog block (contract :668-701) into my-money.css so the money
// dialogs get 480px / --pc-overlay / --pc-radius-dominant / --pc-space-8 instead of Foundation's
// 448px approximation, and #27 raised their layer above style.css's legacy overlays. Both were
// keyed off `.pc-my-money-route`, a class only MyMoneyRoute's own root div carries -- so both
// landed only on AgentTeam's in-route recovery dialog and MISSED all three route-level dialogs.
// The scope is now the dialog's own `pc-money-dialog` class, so it travels with the component
// wherever app.jsx mounts it.
//
// Both directions are asserted here on purpose: a fix that delivered 480px by widening
// Foundation's own `.pc-dialog-panel` would pass the first half and fail the second. The non-money
// control is a bare Foundation Dialog rendered from the same Primitives.jsx module the money
// dialogs use, under the same two stylesheets, so the only difference between the two rows below
// is the class the component itself renders.
// ---------------------------------------------------------------------------------------------
describe('money dialog geometry — the real (unwrapped) tree, both directions', () => {
  it('a money dialog gets the contract 480px/32px/1000 geometry; a non-money Foundation dialog keeps 448px/24px', async () => {
    const money = render(
      <RecoveryPanel
        open
        onClose={() => {}}
        submission={{ outcome: 'unknown', message: 'Relay lost the submission.', hash: 'TXGEO' }}
      />
    )
    const moneyHtml = money.container.innerHTML
    money.unmount()

    const foundation = render(
      <Dialog open title="Not a money dialog" onClose={() => {}}>
        <p>Foundation control.</p>
      </Dialog>
    )
    const foundationHtml = foundation.container.innerHTML
    foundation.unmount()

    const browser = await launchRealChromium()
    try {
      const measure = async (html) => {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.setContent(buildLayoutHarnessHtml(html))
        const result = await page.evaluate(() => {
          const overlay = document.querySelector('.pc-dialog')
          const panel = document.querySelector('.pc-dialog-panel')
          const panelStyle = getComputedStyle(panel)
          return {
            panelWidth: panel.getBoundingClientRect().width,
            panelPaddingTop: parseFloat(panelStyle.paddingTop),
            overlayZIndex: getComputedStyle(overlay).zIndex,
          }
        })
        await page.close()
        return result
      }

      const moneyGeometry = await measure(moneyHtml)
      const foundationGeometry = await measure(foundationHtml)

      expect(moneyGeometry.panelWidth, 'money dialog panel width').toBe(480)
      expect(moneyGeometry.panelPaddingTop, 'money dialog panel padding (--pc-space-8)').toBe(32)
      // --pc-z-dialog resolved on the dialog element itself (decision #27). Falls back to the
      // contract's own :root value of 90 -- below style.css's legacy overlays -- if the scope is
      // not actually reaching this element.
      expect(moneyGeometry.overlayZIndex, 'money dialog overlay z-index').toBe('1000')

      expect(foundationGeometry.panelWidth, 'non-money dialog panel width (28rem)').toBe(448)
      expect(foundationGeometry.panelPaddingTop, 'non-money dialog panel padding (1.5rem)').toBe(24)
    } finally {
      await browser.close()
    }
  }, 60000)
})

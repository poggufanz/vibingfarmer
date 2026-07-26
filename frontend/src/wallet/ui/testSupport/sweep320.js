// frontend/src/wallet/ui/testSupport/sweep320.js
// VF Wallet Task 12, Part A1 (owner-directed systemic fix). This wave hand-fixed SIX separate
// long-identifier/long-label overflows at the 320px popup width, one at a time, four of them
// missed on a first pass: Strategy T10's 325px Connect button, Receive's 450.6px address
// blowout, SendScreen's 465.47px confirm-card blowout, VFW9's 288px onboarding headroom, and
// VFW11's 350px "Manage Base testnet" link. The recurring mechanism is `.pc-button`'s
// `white-space: nowrap` + `min-width: max-content` meeting a long label, or an untruncated
// technical string (address/hash) with no word-break -- neither is catchable by a label-length
// lint; both are only visible to real layout. WalletOnboarding.test.jsx, WalletSettings.test.jsx,
// and WalletAdvanced.test.jsx each independently hand-rolled an IDENTICAL launchRealChromium /
// buildHarnessHtml / render-loop trio to catch this class of bug per-surface. This module is the
// one shared version every wallet AND approval suite (extension/approve*, a vanilla-DOM surface
// with no React render step at all) calls instead.
//
// STRONGER than the per-file guards it replaces, not just a dedupe: those asserted
// `document.documentElement.scrollWidth <= 320` (two of the three also checked `.pc-wallet`'s own
// scrollWidth <= 320) -- both are CONTAINER-level metrics. A `position: fixed`/`position:
// absolute` element's overflow contributes to NEITHER an ancestor's scrollWidth NOR the
// document's, so a genuinely off-screen element could still slip past both old checks. This walks
// every element's own `getBoundingClientRect().right` and fails if ANY exceeds 320.5px (the extra
// half-pixel is sub-pixel layout rounding tolerance, not a loophole) -- and reports the worst
// offender's tag/class so a failure is diagnosable without re-running by hand.
//
// `document.documentElement.scrollWidth` is asserted to equal the viewport width exactly, not
// merely <=: a bare `<body>` always floors at the viewport's width regardless of its content
// (confirmed empirically -- a 200px-wide, non-overflowing fixture still reports scrollWidth 320),
// so an equality check never rejects legitimate content; it is simply the same failure condition
// as `<=` stated more precisely, kept because it reads as one fewer inequality to reason about
// when a failure is reported. The real, demonstrated improvement over the guards this replaces is
// the per-element `maxRight` check below.
import { expect } from 'vitest'
import fs from 'node:fs'

export const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

export async function launchRealChromium() {
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

export function buildHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${bodyHtml}</body></html>`
}

// React-render convenience for React-based wallet suites: turns [label, ReactNode][] into
// [label, html][] via an injected `render` (usually @testing-library/react's) -- the exact dance
// WalletOnboarding/WalletSettings/WalletAdvanced each hand-rolled as their own local
// `renderStates`. `render` is injected rather than imported here so this module carries no hard
// dependency on @testing-library/react and stays usable from vanilla-DOM suites (extension/
// approvalView.test.js builds [label, html] pairs directly and never calls this).
export function renderStatesToHtml(states, render) {
  const results = []
  for (const [label, node] of states) {
    const { container, unmount } = render(node)
    results.push([label, container.innerHTML])
    unmount()
  }
  return results
}

/**
 * The one 320px sweep every wallet/approval suite should call instead of hand-rolling its own.
 * @param {[string, string][]} states  [label, bodyHtml] pairs, already rendered to HTML strings.
 * @param {{logPrefix?: string, viewport?: {width:number,height:number}}} [opts]
 */
export async function sweep320(
  states,
  { logPrefix = '', viewport = { width: 320, height: 900 } } = {}
) {
  const browser = await launchRealChromium()
  try {
    for (const [label, html] of states) {
      const page = await browser.newPage()
      await page.setViewportSize(viewport)
      await page.setContent(buildHarnessHtml(html))
      const { docScrollWidth, maxRight, culprit } = await page.evaluate(() => {
        // Inlined (not imported) -- page.evaluate runs serialized in the browser context and
        // cannot close over this module's outer scope.
        function describeCulprit(el) {
          const cls =
            el.className && typeof el.className === 'string' && el.className.trim()
              ? `.${el.className.trim().split(/\s+/).join('.')}`
              : ''
          return `${el.tagName.toLowerCase()}${cls}`
        }
        let maxR = 0
        let worst = null
        for (const el of document.querySelectorAll('*')) {
          const right = el.getBoundingClientRect().right
          if (right > maxR) {
            maxR = right
            worst = describeCulprit(el)
          }
        }
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          maxRight: maxR,
          culprit: worst,
        }
      })
      const prefix = logPrefix ? `${logPrefix}/` : ''
      // eslint-disable-next-line no-console -- reported numbers requested by the task brief
      console.log(
        `[320px] ${prefix}${label}: docScrollWidth=${docScrollWidth} maxElementRight=${maxRight.toFixed(2)}${culprit ? ` (${culprit})` : ''}`
      )
      expect(docScrollWidth, `${prefix}${label} @320px document scrollWidth`).toBe(viewport.width)
      expect(
        maxRight,
        `${prefix}${label} @320px widest element right edge (${culprit})`
      ).toBeLessThanOrEqual(viewport.width + 0.5)
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

// Guards for defects the visual harness is STRUCTURALLY BLIND TO.
//
// Every other spec in this directory drives `/visual/?fixture=...`, which mounts `.pc-route`
// standalone. The real app mounts the same route inside the legacy shell (`.app > .main`), and
// that shell has its own layout rules. On 2026-07-28 all three bugs the owner hit on /strategy
// were invisible to the twelve frozen Strategy baselines for exactly this reason:
//
//   * `style.css:350-356` set `.main { overflow: hidden }` -- fine for the legacy routes it was
//     written for, fatal for a Pocket Crew route. Measured 723.7px of /strategy and 1734.4px of
//     /agent inside a 629px `.main`, with no scrollable ancestor at all. 162px and 1105px of real
//     content were unreachable. The harness has no `.main`, so no baseline could ever show it.
//   * `.pc-strategy-stage-nav` carried `max-width: 560px`, a constant unrelated to the decision
//     card it sits above (measured 530.3px), so the nav overhung its own content by 29.7px.
//
// These tests therefore navigate the REAL routes. They assert behaviour, not implementation: a
// route's bottom must be reachable, whatever mechanism gets it there.

import { test, expect } from '@playwright/test'

const POCKET_CREW_ROUTES = ['/strategy', '/agent']

// `/strategy` and `/agent` render nothing until the app has an address: with no wallet, app.jsx
// falls through to the landing (`!skipLanding && !realAddress`) and then to the onboarding
// "Get started" screen. `src/dev/viewAs.js` already provides the read-only affordance for exactly
// this -- a `?as=G...` query param, gated on `import.meta.env.DEV` and validated against
// /^G[A-Z2-7]{55}$/. The webServer in playwright.config.js runs `vite dev`, so DEV is true here.
// Against a production build the param is ignored and these tests fail loudly on the missing
// `.pc-route` rather than passing vacuously, which is the correct direction to fail.
const VIEW_AS = 'GCREALSHELLGUARD' + '2'.repeat(56 - 'GCREALSHELLGUARD'.length)

/** Settle the SPA: the route element exists and has stopped growing between two frames. */
async function waitForRoute(page) {
  await page.waitForSelector('.pc-route', { timeout: 15000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.pc-route')
      if (!el) return false
      const h = el.getBoundingClientRect().height
      if (window.__lastH === h) return true
      window.__lastH = h
      return false
    },
    { timeout: 15000, polling: 250 }
  )
}

test.describe('real app shell (not the visual harness)', () => {
  // A fresh browser context has no localStorage, and the app has TWO first-visit gates in front of
  // any route: `app.jsx:3322` renders the marketing landing while `!skipLanding && !realAddress`,
  // and `yv_onboarded` (app.jsx:852) then holds the "Get started" screen. Both must be satisfied or
  // the specs below time out on `.pc-route` and read like a routing bug rather than a gate. These
  // two flags are the app's own persisted state, not a test-only backdoor.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('yv_skip_landing', 'true')
        localStorage.setItem('yv_onboarded', 'true')
      } catch {
        /* storage blocked — the assertions below will report the real failure */
      }
    })
  })

  for (const path of POCKET_CREW_ROUTES) {
    test(`${path}: the bottom of the route is reachable`, async ({ page }) => {
      // Force a viewport SHORTER than the route so the precondition below is guaranteed rather than
      // incidental. The project heights (800/1000) happen to exceed /strategy's ~724px, which would
      // make this guard pass without ever exercising the clip — and the owner met the real bug in a
      // 629px-tall window, which is an ordinary browser with its chrome. Width stays per-project.
      const { width } = page.viewportSize()
      await page.setViewportSize({ width, height: 600 })

      await page.goto(`${path}?as=${VIEW_AS}`)
      await waitForRoute(page)

      const before = await page.evaluate(() => {
        const route = document.querySelector('.pc-route')
        return {
          routeBottom: route.getBoundingClientRect().bottom,
          viewportH: window.innerHeight,
        }
      })

      // Only meaningful when the route is actually taller than the viewport. If it fits, there is
      // nothing to reach and nothing to prove -- say so rather than passing vacuously.
      expect(
        before.routeBottom,
        `${path}: route fits the viewport, so this guard proved nothing — pick a taller fixture`
      ).toBeGreaterThan(before.viewportH)

      // Scroll with a REAL wheel gesture, never `element.scrollTop`. This distinction is the whole
      // guard: `overflow: hidden` blocks the user but leaves the element programmatically
      // scrollable, so a scrollTop-based version of this test passed against the very defect it was
      // written to catch — verified by injecting `overflow-y: hidden` back and watching it stay
      // green. A wheel event goes through the same path a person does.
      await page.mouse.move(page.viewportSize().width / 2, 300)
      for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 500)
      await page.waitForTimeout(400)

      const after = await page.evaluate(() => {
        const route = document.querySelector('.pc-route')
        return {
          routeBottom: route.getBoundingClientRect().bottom,
          viewportH: window.innerHeight,
        }
      })

      expect(
        after.routeBottom,
        `${path}: after 40 wheel gestures the route still ends ` +
          `${Math.round(after.routeBottom - after.viewportH)}px below the fold — ` +
          `an ancestor is clipping it (this is the style.css .main{overflow:hidden} class)`
      ).toBeLessThanOrEqual(after.viewportH + 1)
    })
  }

  test('/strategy: the stage nav and the decision card share a right edge', async ({ page }) => {
    await page.goto(`/strategy?as=${VIEW_AS}`)
    await waitForRoute(page)

    const edges = await page.evaluate(() => {
      const nav = document.querySelector('.pc-strategy-stage-nav')
      const card = document.querySelector('.pc-strategy-decision')
      if (!nav || !card) return null
      const n = nav.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      return { navRight: n.right, cardRight: c.right, navLeft: n.left, cardLeft: c.left }
    })

    expect(edges, '/strategy: stage nav or decision card missing').not.toBeNull()
    // Sub-pixel tolerance only. A whole pixel of drift means the two are derived from different
    // numbers again, which is the defect: nav 560px hardcoded vs card 530.3px from the grid.
    expect(Math.abs(edges.navLeft - edges.cardLeft)).toBeLessThan(1)
    expect(
      Math.abs(edges.navRight - edges.cardRight),
      `stage nav right edge ${edges.navRight.toFixed(1)} vs card ${edges.cardRight.toFixed(1)}`
    ).toBeLessThan(1)
  })
})

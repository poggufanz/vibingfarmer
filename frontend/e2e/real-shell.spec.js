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

// Task 10 (IA remap) fix round 1, F5: `/agent` used to be My Money here (the "1734.4px of /agent"
// measurement above is from THAT route, still historically accurate for when it was captured) --
// it is now Task 9's CrewRoute, and dropped from this specific overflow guard. The `.main {
// overflow: hidden }` fix this guard protects is a SHELL-LEVEL style (style.css, not per-route),
// so one tall `.pc-route` still proves it holds for any of them; the reason /agent is not ALSO
// re-proven here is a fixture limitation, not a narrowed guard: CrewRoute's only reachable state
// via the synthetic read-only `VIEW_AS` address below is its empty-crew branch (no real deployed
// agents exist for a guard-only dummy address on testnet), measured at 369px tall against the
// 600px forced viewport -- shorter than the viewport, so the guard's own "route fits the viewport,
// so this guard proved nothing" assertion fires correctly rather than a real clipping regression.
// Re-add '/agent' here if a fixture ever provides it a real, taller (non-empty) crew state.
//
// Task 11 (re-verified 2026-07-28 against current HEAD): re-ran the /agent case by hand with the
// guard's own debug fields exposed -- still measures routeBottom=369.296875 against a forced
// viewportH=600, i.e. unchanged from Task 10's figure. The fixture limitation is real today, not
// stale.
//
// Fix round 1, M1: the previous version of this comment claimed there was "no other way to hand a
// synthetic address a non-empty crew" than mocking the Soroban RPC. That is wrong -- there IS one,
// using a mechanism this very file already relies on: `app.jsx:441`'s `loadMoneyCache(owner)`
// reads `localStorage['yv_my_money_cache_' + owner.toLowerCase()]` (key at app.jsx:437) and
// `app.jsx:2139-2142` pushes it into `setMoneyRead` synchronously on mount, before any network
// call -- CrewRoute's branch predicate is only `if (!agents.length)` (CrewRoute.jsx:67), fed by
// `agents={moneyRead?.agents ?? []}` (app.jsx:3513), so seeding that cache key in this file's own
// `addInitScript` WOULD reach the non-empty branch with no RPC mocking at all.
// The conclusion (/agent stays out of the OVERFLOW list) still holds, but for the real reason:
// `app.jsx:2152` fires `refreshMoney(realAddress)` immediately on mount (plus a 30s interval), and
// its `onCommit` (app.jsx:2096-2098) calls `setMoneyRead(snapshot.money)` -- overwriting the seed
// with the live (empty, for this never-deployed synthetic address) read shortly after paint. An
// overflow guard built on the cache seed would therefore race that network call rather than
// reliably reaching a non-empty state -- reachable, but transient, not a hard "impossible."
// Blocking the RPC to make the seed stick would mean intercepting network requests, which again
// crosses into inventing app state this guard has no business creating.
//
// Task 11 also adds '/home': it is where the historically overflow-prone content (My Money, the
// very route the 1734.4px figure above was measured on) now lives post-remap, and unlike /agent it
// is NOT gated behind an empty-state branch -- MyMoneyRoute always renders its full six sections
// regardless of agent count. Re-measured today: routeBottom=1802.078125 against viewportH=600, a
// real, current overflow this guard can actually catch a regression in.
// This does NOT restore /agent's dropped coverage -- it re-proves the same SHELL-LEVEL rule
// (pocket-crew.css:846, `.main:has(.pc-route) { overflow-y: auto }`) on a second, taller route.
// What stays uncovered by every test in this file is a CrewRoute-LOCAL clipping regression: an
// `overflow: hidden` or fixed height added to `.pc-crew-route` or its stats/lanes containers would
// be invisible here, since /agent never appears in this array.
const POCKET_CREW_ROUTES = ['/strategy', '/home']

// `/strategy` and `/agent` render nothing until the app has an address: with no wallet, app.jsx
// falls through to the landing (`!skipLanding && !realAddress`) and then to the onboarding
// "Get started" screen. `src/dev/viewAs.js` already provides the read-only affordance for exactly
// this -- a `?as=G...` query param, gated on `import.meta.env.DEV` and validated against
// /^G[A-Z2-7]{55}$/. The webServer in playwright.config.js runs `vite dev`, so DEV is true here.
// Against a production build the param is ignored and these tests fail loudly on the missing
// `.pc-route` rather than passing vacuously, which is the correct direction to fail.
const VIEW_AS = 'GCREALSHELLGUARD' + '2'.repeat(56 - 'GCREALSHELLGUARD'.length)

// Route-identity guard (Task 11): pins that each route in the remapped IA renders ITS OWN <h1>,
// so a future routing regression (e.g. two routes pointed at the same component, or a copy-paste
// wrong-import) fails here instead of silently reading as "the page rendered something". Deliberately
// a SEPARATE list from POCKET_CREW_ROUTES above: identity does not depend on content height, so it
// covers /agent too even though CrewRoute's empty-crew branch (the only state this fixture reaches)
// is too short to ever prove the overflow guard. Verified against the real rendered source, not the
// brief that first proposed these three lines -- all three matched on inspection:
//   - '/strategy' -> StrategyRoute.jsx:88          `<h1 className="pc-route-title">Hire a crew, once.</h1>`
//   - '/agent'    -> CrewRoute.jsx:72 AND :87       both mutually-exclusive branches render the
//                     IDENTICAL text `<h1 className="pc-route-title">The crew, live.</h1>` -- so
//                     this assertion holds regardless of which branch the fixture happens to reach.
//   - '/home'     -> MyMoneyRoute.jsx:50            `<h1>My money</h1>`
const ROUTE_H1 = {
  '/strategy': /hire a crew, once/i,
  '/agent': /the crew, live/i,
  '/home': /my money/i,
}

// Fix round 1, M2: was duplicated verbatim (minus this comment) in a second `test.describe`'s own
// `beforeEach` -- if a third first-visit gate is ever added and only one copy gets updated, the
// other describe's specs fail with a bare `.pc-route` timeout that reads like a routing bug, not
// a gate (see the gate explanation below). One helper, called from both describes, removes that
// trap. A fresh browser context has no localStorage, and the app has TWO first-visit gates in
// front of any route: `app.jsx:3322` renders the marketing landing while
// `!skipLanding && !realAddress`, and `yv_onboarded` (app.jsx:852) then holds the "Get started"
// screen. Both must be satisfied or specs time out on `.pc-route`. These two flags are the app's
// own persisted state, not a test-only backdoor.
async function skipFirstVisitGates(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('yv_skip_landing', 'true')
      localStorage.setItem('yv_onboarded', 'true')
    } catch {
      /* storage blocked — the assertions below will report the real failure */
    }
  })
}

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
  test.beforeEach(async ({ page }) => {
    await skipFirstVisitGates(page)
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
      // Deferred (Task 11 fix round 1 review): /home's content comes from `moneyRead`, which
      // `refreshMoney` (app.jsx) populates asynchronously and re-polls every 30s -- a commit
      // landing during this fixed 400ms wait could grow the route and fail spuriously. Graded low
      // probability (a never-deployed synthetic address renders nothing either way) and NOT worth
      // restructuring the test for now. If this ever flakes, replace the fixed wait with
      // `await waitForRoute(page)` here to re-settle on real DOM stability instead of a clock.
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

test.describe('route identity', () => {
  test.beforeEach(async ({ page }) => {
    await skipFirstVisitGates(page)
  })

  for (const route of Object.keys(ROUTE_H1)) {
    test(`${route} renders its own h1`, async ({ page }) => {
      await page.goto(`${route}?as=${VIEW_AS}`)
      await waitForRoute(page)

      // Fix round 1, F1 (plan-mandated, overrides the brief's `.first()` snippet): the plan's
      // binding constraint is "exactly one h1 per route," but `.first()` alone silently discards a
      // second h1 instead of pinning its absence -- a route that grows one, or a shell that adds
      // one, would still pass every other assertion here. This is the only shell-aware guard in
      // the repo (the unit harness structurally cannot see `.app > .main`), so if this file doesn't
      // pin the count, nothing does.
      const h1s = page.locator('.pc-route h1')
      await expect(h1s, `${route}: expected exactly one h1 inside .pc-route`).toHaveCount(1)
      await expect(h1s, `${route}: h1 text mismatch`).toHaveText(ROUTE_H1[route])

      // Page-level count: the version the unit harness structurally cannot write (it never mounts
      // the real shell), and free to assert here since we already have the page open.
      await expect(
        page.locator('h1'),
        `${route}: expected exactly one h1 on the whole page (shell chrome must not add one)`
      ).toHaveCount(1)
    })
  }
})

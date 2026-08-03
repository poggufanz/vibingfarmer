// frontend/e2e/vf-wallet.visual.spec.js
// VF Wallet Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze -- LAST of the three shared-
// harness fixtures). Declares exactly three baselines, per the task brief:
//   vf-wallet-forest-360x600-mobile-360.png   -- VfWalletHomeFixture, forest
//   vf-wallet-forest-360x800-mobile-360.png   -- VfWalletApprovalFixture, forest
//   vf-wallet-day-field-360x800-mobile-360.png -- VfWalletApprovalFixture, day-field
//
// Every `toHaveScreenshot()` call is gated to the `mobile-360` project only (`page.setViewportSize()`
// supplies the declared height itself, per Foundation's own established pattern) -- that call MUST
// be gated this way or Playwright's snapshotPathTemplate emits one file per configured project, not
// the three the brief declares (My Money's own precedent, `MOBILE_PROJECTS`/`WIDE_PROJECTS` skip
// gates, :148-306 of pocket-crew.visual.spec.js). VFW14 fix round 1 (I-1): the GEOMETRY assertions
// (overflow/vertical-trap/44px) are no longer screenshot-gated the same way -- they also run on
// `mobile-320` (My Money's own `MOBILE_PROJECTS` convention), since rejection-checklist item 12
// names 320px explicitly and the screenshot/measurement gating needs are no longer the same claim.
//
// Two composites, never on the same page load -- see visual/main.jsx's own header comment
// (VfWalletHomeFixture/VfWalletApprovalFixture) for the two independently-verified reasons (CSS
// isolation, Day Field support) this split exists. 600 captures the Home family (Onboarding/Home/
// Activity/Advanced/Settings, self-contained WalletShell styling, Forest-only -- WalletShell.jsx
// has no Day Field port at all, confirmed by reading its inline STYLE in full); 800 captures the
// Approval family (consent/grant/ceremony, extension/approval.css, which DOES support Day Field).
//
// extension/vibing_farmer.logo.svg is referenced as a same-directory-relative path by both
// WalletShell.jsx's own header and this file's approve.html/ceremony.html-mirroring markup
// (VfwApprovalCard/VfwCeremonyCard in visual/main.jsx) -- correct from the extension's own
// popup.html/approve.html location, 404 from this harness's `/visual/` location. The real file is
// unmodified; this route only redirects the REQUEST for that one filename back to the real
// on-disk asset, so no fixture ever freezes a broken-image icon into a baseline.
//
// VFW14 fix round 1 (independent review). Four changes, none touching the three frozen PNGs'
// pixels except where a real production defect required it (I-1, HonestyLabels token, WalletSettings
// touch target -- each re-frozen and re-opened, see the report):
//   I-1: the geometry assertions below now ALSO run on `mobile-320` (not screenshotted -- the
//        brief declares exactly 3 PNGs, all mobile-360 -- just measured), deriving rejection-
//        checklist item 12 at 320px as well as 360px. The real 320px overflow this caught
//        (WalletAdvanced.jsx's "Enable deposits" button, 161px in a 138px track) is fixed in
//        WalletShell.jsx (`.pc-wallet-actions` stacks to one column below 360px), not routed
//        around here.
//   I-2: `decorativeMotionOffenders` now walks the ENTIRE fixture subtree, not just
//        `[data-pocket-critical]` roots -- see that function's own comment for why the narrower
//        scope silently missed the Settings/Advanced screens Step 3 names.
//   I-3: `assert44pxControls` no longer exempts `display: inline` -- it measures every interactive
//        element's tallest client-rect fragment instead, so a brand-new inline touch target can no
//        longer ship invisible (own comment below; the one real 17px link this used to hide is
//        fixed in WalletSettings.jsx, owner decision #42).
//   I-4: the overflow/vertical-trap/44px sweeps each gained a positive control, and all three now
//        include the fixture ROOT itself (previously descendants-only, so a defect on the root
//        element was structurally unobservable).
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/vibing_farmer.logo.svg', (route) =>
    route.fulfill({ path: 'extension/vibing_farmer.logo.svg' })
  )
})

test.describe('Pocket Crew VF Wallet', () => {
  // The 360px viewport this whole file uses represents a real touch phone -- Foundation's own
  // 44px touch-target rule is gated behind `@media (hover: none), (pointer: coarse)`
  // (WalletShell.jsx/approval.css both carry it verbatim), which a bare Chromium context does NOT
  // satisfy by default (headless Chromium reports `hover: hover`/`pointer: fine`, a desktop mouse,
  // even at a 360px viewport -- confirmed empirically: playwright.config.js's `mobile-360` project
  // sets only `viewport`, no `hasTouch`/`isMobile`, so this media query has never actually been
  // exercised by Foundation/Strategy/My Money's own tests either). `hasTouch` alone (not
  // `isMobile`, which also rewrites the user-agent/viewport-meta handling more broadly than this
  // one media feature needs) is the surgical emulation for it.
  test.use({ hasTouch: true })

  // VFW14 fix round 1 (I-1): the brief's own hard-gate item 12 names 320px explicitly
  // ("...or mobile creates horizontal scrolling at 320px") -- `playwright.config.js`'s
  // `mobile-320` project already exists but was never reached (every test used to skip everything
  // except `mobile-360`). Geometry assertions below now run on both; only `mobile-360` still
  // captures a screenshot (the brief declares exactly 3 PNGs, all at 360).
  const MOBILE_PROJECTS = ['mobile-320', 'mobile-360']

  // G4-equivalent (rejection checklist item 12): mobile width must show no horizontal overflow,
  // checked both via documentElement.scrollWidth AND every descendant's own bounding rect --
  // `document.documentElement.scrollWidth === viewportWidth` alone is NOT a valid overflow check
  // on its own (body carries `overflow-x: hidden`/`.pc-wallet` carries `overflow-x: clip` in
  // force, so the number can stay put while real overflow is hidden rather than removed -- the
  // exact trap this project's own brief names as having shipped twice); the per-element sweep
  // catches that. VFW14 fix round 1 (I-4): the selector now includes the fixture ROOT itself, not
  // only its descendants -- a defect on the root element was previously unobservable by this
  // guard (review issue 7). Measurement is split from assertion (`overflowMeasurements` /
  // `assertNoOverflowAtMobileWidth`) so a positive control can inspect the raw numbers directly,
  // the same shape `decorativeMotionOffenders` already established below.
  async function overflowMeasurements(page, fixtureAttr) {
    return page.evaluate((attr) => {
      const viewportWidth = document.documentElement.clientWidth
      let maxRight = 0
      for (const el of document.querySelectorAll(
        `[data-fixture="${attr}"], [data-fixture="${attr}"] *`
      )) {
        maxRight = Math.max(maxRight, el.getBoundingClientRect().right)
      }
      return { scrollWidth: document.documentElement.scrollWidth, viewportWidth, maxRight }
    }, fixtureAttr)
  }

  async function assertNoOverflowAtMobileWidth(page, fixtureAttr) {
    const overflow = await overflowMeasurements(page, fixtureAttr)
    expect([320, 360], 'a mobile viewport width').toContain(overflow.viewportWidth)
    expect(
      overflow.maxRight,
      `no descendant rect (or the fixture root itself) may exceed the viewport, even under overflow-x:clip/hidden (got ${overflow.maxRight} at vw=${overflow.viewportWidth})`
    ).toBeLessThanOrEqual(overflow.viewportWidth + 0.5)
  }

  // The vertical form of the same trap (Strategy Task 14's own finding): a starved narrow column
  // can wrap a long identifier to 1-2 characters per line with ZERO horizontal overflow, so the
  // guard above is structurally blind to it. This fixture's accounts/addresses/XDR are all
  // real-length (56-char strkeys, a long base64 placeholder) specifically so this guard has
  // something real to catch if the long-identifier grid fix (contract:883-895,
  // `grid-template-columns: auto minmax(0, 1fr)`) is ever missing where it's needed. VFW14 fix
  // round 1 (I-4): root included, same reasoning as the overflow sweep above; split into
  // measurement + assertion for the same positive-control reason.
  async function verticalTrapHits(page, fixtureAttr) {
    return page.evaluate((attr) => {
      const hits = []
      for (const el of document.querySelectorAll(
        `[data-fixture="${attr}"], [data-fixture="${attr}"] *`
      )) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.width < 100 && rect.height > 150) {
          hits.push({ tag: el.tagName, cls: el.className, width: rect.width, height: rect.height })
        }
      }
      return hits
    }, fixtureAttr)
  }

  async function assertNoVerticalTextTrap(page, fixtureAttr) {
    const trapped = await verticalTrapHits(page, fixtureAttr)
    expect(
      trapped,
      `narrow+tall element(s) -- vertical text trap: ${JSON.stringify(trapped)}`
    ).toEqual([])
  }

  // Step 2 (44px controls). Real per-element rects -- jsdom (WalletA11y.test.jsx) cannot compute
  // these at all (no layout engine), so this is the ONLY place this claim is checked. The
  // selector matches every interactive element type Foundation's own coarse-pointer rule targets
  // (button/[role=button]/a[href]/summary/input/select/textarea); a 0.5px tolerance absorbs
  // subpixel layout rounding, never a real shortfall. Requires a touch-capable context (see this
  // describe block's own `test.use({ hasTouch: true })`) -- the rule this checks
  // (`@media (hover: none), (pointer: coarse) { min-height: var(--pc-touch-target) }`) never
  // applies under a bare desktop-mouse Chromium context at all.
  //
  // VFW14 fix round 1 (I-3, reviewer finding): the previous `display === 'inline'` blanket skip
  // meant a brand-new inline touch target produced zero hits -- `display: inline` is itself part
  // of the defect class this guard exists to catch (a non-replaced inline box cannot honor
  // `min-height`, but it can still be a real, too-short tap target), so exempting it by `display`
  // made the guard structurally blind to the exact shape of bug it discovered (WalletSettings.jsx's
  // 17px link, mutation-proven below). Fixed by MEASURING instead of skipping: `getClientRects()`
  // (not `getBoundingClientRect()`) gives one rect per line box, so an inline element that wraps
  // across several lines is judged by its tallest single fragment -- the real tappable strip a
  // fingertip meets -- rather than either a misleadingly short first-fragment read or an inflated
  // multi-line bounding-box sum. For a single-line inline element (today's one real case) this is
  // numerically identical to `getBoundingClientRect().height`. The one link this used to exempt
  // now genuinely has to pass, and does -- fixed in WalletSettings.jsx (owner decision #42).
  async function shortControls(page, fixtureAttr) {
    return page.evaluate((attr) => {
      const sel = 'button, [role="button"], a[href], summary, input, select, textarea'
      const hits = []
      for (const el of document.querySelectorAll(`[data-fixture="${attr}"] ${sel}`)) {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue // display:none branch, not on screen
        const rects = [...el.getClientRects()]
        const height = rects.length ? Math.max(...rects.map((r) => r.height)) : rect.height
        if (height < 43.5) {
          hits.push({ tag: el.tagName, text: el.textContent?.slice(0, 40), height })
        }
      }
      return hits
    }, fixtureAttr)
  }

  async function assert44pxControls(page, fixtureAttr) {
    const short = await shortControls(page, fixtureAttr)
    expect(short, `control(s) under the 44px touch target: ${JSON.stringify(short)}`).toEqual([])
  }

  // VFW14 fix round 2 (N-1, reviewer finding): vf-wallet-home's very first `fullPage` capture on a
  // freshly-loaded page measures 9199px; every later capture on the SAME page measures 9327px (the
  // frozen baseline's own height). Not a font-LOAD race -- `document.fonts.ready` had already
  // resolved and text widths probe identically at both heights -- it is a metrics-application
  // RELAYOUT: 32 `.pc-button`s sit clamped at the coarse-pointer 44px floor until it runs, then grow
  // to their natural 48px (`--pc-control-height`), exactly 4px x 32 = 128px = 9327-9199. Waiting on
  // `fonts.ready` or polling `scrollHeight` across animation frames does NOT trigger it (confirmed
  // empirically: a plain rAF poll reports "stable" at 9199 forever) -- only a genuine full-document
  // layout pass does, and a `fullPage` screenshot is itself what forces one (a viewport-only
  // screenshot does not). So this takes throwaway `fullPage` captures -- discarding the buffers --
  // until two consecutive ones agree on `document.documentElement.scrollHeight`, before the REAL,
  // asserted capture ever runs. Verified under synthetic 4-core CPU saturation (the same contention
  // the reviewer used to reproduce the flake on demand): 25/25 raw captures landed on the stable
  // 9327px height with this wait in place, vs 0/20 without it (every cold page's first capture is
  // unconditionally the short one) -- see the report for the full repeat-run log.
  // VFW14 fix round 3 (reviewer finding: silent exhaustion). Six throwaway captures never
  // converging degraded to exactly the pre-fix behaviour with zero diagnostic -- indistinguishable
  // from "this surface has no relayout to wait for" in the test output. Throwing would turn a slow
  // machine into a red build for what might still be a harmless capture, so this stays non-fatal,
  // but exhaustion is now recorded where a human (or CI log scraper) will actually see it:
  // `testInfo.annotations` (shows up in the HTML report against this exact test) plus a console
  // warning. Ceiling this does NOT close: the two-agree check has no ground truth, so a surface
  // that needed a THIRD capture to trigger its real relayout would read the same (still-wrong)
  // height twice, declare itself settled, and return with no warning at all -- this only fires
  // when captures never agree within maxAttempts, not when they agree too early on a wrong value.
  async function waitForFullPageLayoutSettle(page, testInfo, maxAttempts = 6) {
    let previous = null
    for (let i = 0; i < maxAttempts; i++) {
      await page.screenshot({ fullPage: true })
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      if (height === previous) return
      previous = height
    }
    const message = `waitForFullPageLayoutSettle: scrollHeight never agreed across ${maxAttempts} full-page captures (last=${previous}px) -- proceeding anyway, capture may be unstable`
    testInfo?.annotations.push({ type: 'warning', description: message })
    console.warn(message)
  }

  test('forest theme -- vf-wallet-home (360x600, +320px geometry)', async ({ page }, testInfo) => {
    test.skip(
      !MOBILE_PROJECTS.includes(testInfo.project.name),
      'screenshot is mobile-360 only; geometry (checklist item 12) also runs on mobile-320'
    )
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    // VFW14 fix round 3 (owner decision #44): the same explicit `data-fixture-pending` wait
    // every `vf-wallet-approval` test already uses, now that `VfWalletHomeFixture` (visual/main.jsx)
    // carries the identical marker -- this capture no longer depends on incidental delay from the
    // geometry sweeps below to have settled past first paint.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, 'vf-wallet-home')
    await assertNoVerticalTextTrap(page, 'vf-wallet-home')
    await assert44pxControls(page, 'vf-wallet-home')
    if (testInfo.project.name === 'mobile-360') {
      await waitForFullPageLayoutSettle(page, testInfo)
      await expect(page).toHaveScreenshot('vf-wallet-forest-360x600.png', { fullPage: true })
    }
  })

  test('forest theme -- vf-wallet-approval (360x800, +320px geometry)', async ({
    page,
  }, testInfo) => {
    test.skip(
      !MOBILE_PROJECTS.includes(testInfo.project.name),
      'screenshot is mobile-360 only; geometry (checklist item 12) also runs on mobile-320'
    )
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    // approval.css is dynamically imported (visual/main.jsx's own comment explains why a static
    // import would contaminate every other fixture on this shared page) -- wait for the SAME
    // `data-fixture-pending="true"` convention Strategy/My Money already use, so this never races
    // the stylesheet actually applying.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, 'vf-wallet-approval')
    await assertNoVerticalTextTrap(page, 'vf-wallet-approval')
    await assert44pxControls(page, 'vf-wallet-approval')
    if (testInfo.project.name === 'mobile-360') {
      await waitForFullPageLayoutSettle(page, testInfo)
      await expect(page).toHaveScreenshot('vf-wallet-forest-360x800.png', { fullPage: true })
    }
  })

  test('day-field theme -- vf-wallet-approval (360x800, +320px geometry)', async ({
    page,
  }, testInfo) => {
    test.skip(
      !MOBILE_PROJECTS.includes(testInfo.project.name),
      'screenshot is mobile-360 only; geometry (checklist item 12) also runs on mobile-320'
    )
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=day-field')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, 'vf-wallet-approval')
    await assertNoVerticalTextTrap(page, 'vf-wallet-approval')
    await assert44pxControls(page, 'vf-wallet-approval')
    if (testInfo.project.name === 'mobile-360') {
      await waitForFullPageLayoutSettle(page, testInfo)
      await expect(page).toHaveScreenshot('vf-wallet-day-field-360x800.png', { fullPage: true })
    }
  })

  // VFW14 fix round 1 (I-4). Positive controls for the three geometry sweeps above -- each
  // asserted zero/empty result previously had no proof it could discriminate a real defect from
  // an absent one. Runs on both mobile widths (the claims above do); a fresh element is injected
  // via `page.evaluate` (never a production file), then removed implicitly by each test's own
  // fresh `page.goto()` -- nothing persists across tests.
  test('CONTROL: an oversized injected element is caught by the overflow sweep', async ({
    page,
  }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), 'overflow is a mobile-width claim')
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.cssText = 'width: 900px; height: 10px;'
      document.querySelector('[data-fixture="vf-wallet-home"]').appendChild(el)
    })
    const overflow = await overflowMeasurements(page, 'vf-wallet-home')
    expect(
      overflow.maxRight,
      'positive control: a 900px-wide injected element must be measured past the viewport'
    ).toBeGreaterThan(overflow.viewportWidth)
  })

  test('CONTROL: a narrow+tall injected element is caught by the vertical-trap sweep', async ({
    page,
  }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), 'measured at both mobile widths')
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      // Deliberately a different shape from the fixture's own real 56-char strkeys -- a
      // fixed-size box, not a wrapped identifier -- so this control cannot be satisfied by
      // something the fixture already happened to render.
      const el = document.createElement('div')
      el.style.cssText = 'width: 40px; height: 168px; overflow: hidden;'
      el.textContent = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX'
      document.querySelector('[data-fixture="vf-wallet-home"]').appendChild(el)
    })
    const trapped = await verticalTrapHits(page, 'vf-wallet-home')
    expect(
      trapped.length,
      'positive control: a 40x168 injected element must be caught as a vertical text trap'
    ).toBeGreaterThan(0)
  })

  test('CONTROL: the de-blinded 44px sweep catches a new inline link and a logical-property-sized button', async ({
    page,
  }, testInfo) => {
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), 'measured at both mobile widths')
    const width = testInfo.project.name === 'mobile-320' ? 320 : 360
    await page.setViewportSize({ width, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      // m-2 (self-caught, real-Chromium run before this passed): appending straight to the fixture
      // ROOT (a `display: grid` container, visual/main.jsx) auto-BLOCKIFIES any in-flow child per
      // the CSS Display spec, so an appended `display: inline` element computes to `block` there --
      // never reproducing the real bug's shape (a non-replaced INLINE box, immune to min-height).
      // A `<section>` is normal flow, so a child left at the CSS default `display: inline` stays
      // genuinely inline, matching WalletSettings.jsx's real link exactly.
      const section = document.querySelector('[data-fixture="vf-wallet-home"] section')
      // (a) The exact shape I-3 names: a brand-new interactive element left at the CSS default
      // `display: inline`, no explicit sizing -- the old blanket skip made this permanently
      // invisible regardless of how short it rendered.
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = 'new inline link'
      section.appendChild(a)
      // (b) A DIFFERENT formulation from the literal `rect.height` the fixture's own real defect
      // was measured with -- a logical property (`block-size`, not `height`) on an otherwise
      // ordinary block-level button, proving the sweep discriminates the CLAIM (rendered height),
      // not one specific CSS property spelling of it. `min-height: 0 !important` is necessary and
      // documented, not incidental: pocket-crew.css's OWN global coarse-pointer/narrow-viewport
      // rule (`:where(button, ...) { min-height: 44px }`, unscoped, active at every mobile width
      // regardless of `hasTouch`) would otherwise floor this control back up to 44px, silently
      // passing it -- a positive control has to genuinely defeat every ambient guarantee, not
      // accidentally lean on one.
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = 'short button'
      btn.style.cssText =
        'display: block; block-size: 20px; inline-size: 80px; min-height: 0 !important;'
      section.appendChild(btn)
    })
    const short = await shortControls(page, 'vf-wallet-home')
    expect(
      short.some((h) => h.text?.includes('new inline link')),
      'positive control: a brand-new inline <a> touch target must be caught, not exempted by display'
    ).toBe(true)
    expect(
      short.some((h) => h.text?.includes('short button')),
      'positive control: a block-size-sized (logical property) short button must be caught'
    ).toBe(true)
  })

  // -----------------------------------------------------------------------------------------
  // Step 2 -- logical tab order, real sequential focus navigation (page.keyboard.press('Tab')),
  // never a jsdom tabIndex sweep alone (that lives in WalletA11y.test.jsx; this is the stronger,
  // real-browser claim that VISUAL top-to-bottom order and TAB order agree, which a DOM-order-only
  // check cannot see -- a CSS `order`/grid-placement property could decouple the two without
  // tripping a tabIndex sweep at all).
  // -----------------------------------------------------------------------------------------
  test('tab order follows visual top-to-bottom order on the exposed onboarding screen', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)

    // Only the FIRST section is exposed to the accessibility tree (every other section carries
    // `aria-hidden="true"`, the same MM14 convention visual/main.jsx's own Section() applies --
    // see that file's header) -- Chromium excludes an aria-hidden subtree from sequential focus
    // navigation, so Tab from the top of the document reaches this section's own two buttons next,
    // in DOM order, with nothing hidden in between to skip past.
    // m-1 (self-caught, real-Chromium run before review): `getBoundingClientRect().top` is
    // VIEWPORT-relative, not document-absolute -- this fixture's composite is ~9000px tall at a
    // 600px-tall viewport, so focusing the second (further-down) button legitimately auto-scrolls
    // it into view, which can make its viewport-relative `top` SMALLER than the first button's
    // (both are now near the top of a shorter visible window) even though it is genuinely further
    // down the DOCUMENT. Adding the accumulated scroll offset recovers the absolute position,
    // which is the actual claim being tested (tab order agrees with document order, not with
    // "whichever element the browser most recently scrolled to").
    const tops = []
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Tab')
      const active = page.locator(':focus')
      const text = await active.textContent()
      const absoluteTop = await active.evaluate(
        (el) => el.getBoundingClientRect().top + window.scrollY
      )
      tops.push({ text: text.trim(), top: absoluteTop })
    }
    expect(tops.map((t) => t.text)).toEqual(['Use a Standard wallet', 'Use a Passkey wallet'])
    // The stronger claim: each successively-focused element is also further DOWN the page than
    // the last -- tab order and visual order genuinely agree, not just DOM order by coincidence.
    expect(tops[1].top).toBeGreaterThan(tops[0].top)
  })

  // CONTROL for the tab-order claim above: a positive tabIndex reorders the SAME two buttons out
  // of visual order -- proves the assertion actually discriminates a real regression rather than
  // passing on anything. Injected via page.evaluate (never a production file edit).
  test('CONTROL: a positive tabIndex breaks the tab-order assertion above', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-fixture="vf-wallet-home"] button')]
      const passkeyBtn = buttons.find((b) => b.textContent.trim() === 'Use a Passkey wallet')
      passkeyBtn.tabIndex = 1 // jumps the queue ahead of the Standard button (tabIndex 0/absent)
    })
    const texts = []
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Tab')
      texts.push((await page.locator(':focus').textContent()).trim())
    }
    expect(texts[0]).toBe('Use a Passkey wallet') // proves the mutation is live
    expect(texts).not.toEqual(['Use a Standard wallet', 'Use a Passkey wallet'])
  })

  // -----------------------------------------------------------------------------------------
  // Step 2 -- focus containment/restoration, real browser. The technical-details disclosure is
  // the one interactive toggle this surface has; a real Chromium click must never move focus
  // somewhere else on toggle (native <details>/<summary> behavior).
  // -----------------------------------------------------------------------------------------
  test('technical-details disclosure keeps focus on its own summary across open/close', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    // Section 1 (Connection consent) has no disclosure; the decoded-grant section (2) does, and is
    // aria-hidden -- summaries inside an aria-hidden subtree are still real, clickable DOM nodes
    // (aria-hidden only affects the ACCESSIBILITY tree, never pointer/focus reachability by
    // direct .click()/.focus() calls, only by Tab from elsewhere), so this test reaches it
    // directly rather than relying on Tab traversal.
    const summary = page.locator('[data-fixture="vf-wallet-approval"] #raw-details summary').first()
    await summary.click()
    await expect(
      page.locator('[data-fixture="vf-wallet-approval"] #raw-details').first()
    ).toHaveJSProperty('open', false)
    // The grant section's disclosure starts OPEN (openRawDetails, visual/main.jsx) -- clicking it
    // once closes it; assert focus stayed on the summary itself both before and after.
    await expect(summary).toBeFocused()
    await summary.click()
    await expect(
      page.locator('[data-fixture="vf-wallet-approval"] #raw-details').first()
    ).toHaveJSProperty('open', true)
    await expect(summary).toBeFocused()
  })

  // -----------------------------------------------------------------------------------------
  // Step 2 -- no duplicate accessible logo names. The approval composite stacks eight real
  // approve.html/ceremony.html-style headers (alt="Vibing Farmer", non-empty) on one page --
  // sections 2-8 carry `aria-hidden="true"` (visual/main.jsx's Section()) specifically so this
  // never becomes eight identically-named images in the accessibility tree, the exact shape a
  // real single approve.html/ceremony.html page could never produce (each is its own separate MV3
  // document, never more than one header at a time) and which would give a false-clean read to
  // any future a11y tool scanning this harness page.
  // -----------------------------------------------------------------------------------------
  test('exactly one accessible "Vibing Farmer" logo name on the approval composite', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await expect(page.getByRole('img', { name: 'Vibing Farmer' })).toHaveCount(1)
    // The raw DOM still carries all eight (aria-hidden hides from the ACCESSIBILITY tree, never
    // removes the element) -- this is the differential proof that aria-hidden, not some accidental
    // single mount, is what makes the accessible count 1.
    const rawCount = await page.evaluate(
      () =>
        document.querySelectorAll('[data-fixture="vf-wallet-approval"] img[alt="Vibing Farmer"]')
          .length
    )
    expect(rawCount).toBe(8)
  })

  // CONTROL: proves the accessible-name count assertion actually discriminates -- removing
  // aria-hidden from one more section raises the accessible count to 2.
  test('CONTROL: removing aria-hidden from a second section raises the accessible logo count', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => {
      const sections = document.querySelectorAll('[data-fixture="vf-wallet-approval"] section')
      sections[1].removeAttribute('aria-hidden')
    })
    await expect(page.getByRole('img', { name: 'Vibing Farmer' })).toHaveCount(2)
  })

  // -----------------------------------------------------------------------------------------
  // Step 3 -- zero decorative critical-screen motion, under BOTH normal and reduced-motion
  // settings, derived per-element in real Chromium -- NEVER relying on the contract's own
  // `[data-pocket-critical] { animation: none !important }` rule (contract:783-788), which is
  // element-scoped, not descendant-scoped, so marking a root does not stop a CHILD from animating.
  //
  // VFW14 fix round 1 (I-2, reviewer finding): this used to walk only `[data-pocket-critical]`
  // roots and their descendants. The Home fixture marks exactly ONE of its 11 sections that way
  // (WalletOnboarding's seed-backup screen) -- the brief's Step 3 also names consent/signing/
  // recovery/mandate screens, and this file's own Settings/Advanced sections carry no
  // `data-pocket-critical` marker at all, so the old scope never swept them -- a looping animation
  // on either would have passed silently. The fix is NOT to mark more roots with
  // `data-pocket-critical` (only the owner may amend the locked contract this attribute anchors
  // to, and the attribute's own contract rule is element- not descendant-scoped regardless -- see
  // above). Instead this walks the ENTIRE fixture subtree -- every section, marked or not -- so
  // "zero decorative motion on the critical screens Step 3 names" is derived over the whole
  // surface those screens live on, not just the one root that happened to carry an attribute.
  // -----------------------------------------------------------------------------------------
  async function decorativeMotionOffenders(page, fixtureAttr) {
    return page.evaluate((attr) => {
      const hits = []
      const root = document.querySelector(`[data-fixture="${attr}"]`)
      if (!root) return hits
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const style = getComputedStyle(el)
        if (style.animationName !== 'none') {
          hits.push({ tag: el.tagName, cls: el.className, animationName: style.animationName })
        }
        // getAnimations() also catches a Web Animations API (WAAPI) tween that never touched
        // the `animation` CSS property at all -- a CSS-only sweep is structurally blind to it.
        if (el.getAnimations && el.getAnimations().length > 0) {
          hits.push({ tag: el.tagName, cls: el.className, waapi: el.getAnimations().length })
        }
      }
      return hits
    }, fixtureAttr)
  }

  test('critical wallet screens carry zero decorative motion, normal and reduced motion alike', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )

    // Positive control FIRST -- proves this exact sweep can actually see a real animation before
    // trusting it to report "none" honestly. Injected via page.addStyleTag (never a production
    // file), targeting the FIRST critical root specifically (a `[data-pocket-critical]` element
    // itself, not a descendant -- proving the sweep also catches motion on the root, the one shape
    // the broken contract rule (being element-scoped) would have hidden from a naive "check the
    // attribute fired" test).
    await page.addStyleTag({
      content:
        '[data-fixture="vf-wallet-approval"] [data-pocket-critical]:first-of-type ' +
        '{ animation: vfw-fake-spin 500ms linear infinite; } ' +
        '@keyframes vfw-fake-spin { from { opacity: 1 } to { opacity: 0.5 } }',
    })
    const positiveControl = await decorativeMotionOffenders(page, 'vf-wallet-approval')
    expect(
      positiveControl.length,
      'positive control: the injected animation must be detected'
    ).toBeGreaterThan(0)
    // Remove the injected control before the real assertion -- a `<style>` tag added via
    // addStyleTag has no id here, so reload the fixture instead of trying to pick it back out.
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    // Real finding (self-caught by this exact sweep before review): approval.css's own
    // `[data-pocket-critical]` rule is a VERBATIM port of the locked contract's
    // `border-color`/`background-color` transition (contract:783-788, the same rule whose
    // `animation: none !important` half this task's brief already calls out as broken) -- on
    // every fresh mount, Chromium legitimately starts a real, one-shot, 120ms
    // (`--pc-duration-fast`) `background-color` transition on `.pc-wallet-shell` itself, visible
    // to `getAnimations()` for a brief window after mount. This is not the "looping or ornamental
    // tween" Step 3 forbids (it never repeats, and it settles well under a fifth of a second) --
    // only the owner may amend the locked contract, so it is reported here and waited past, never
    // silently special-cased out of the sweep itself. 300ms (2.5x the 120ms duration) is the
    // margin; anything genuinely decorative or looping is, by definition, STILL running at this
    // mark and this sweep still catches it.
    await page.waitForTimeout(300)

    const normal = await decorativeMotionOffenders(page, 'vf-wallet-approval')
    expect(normal, `decorative motion under normal settings: ${JSON.stringify(normal)}`).toEqual([])

    // VFW14 fix round 1 (reviewer Minor, "Also fix" list): switching the media query on the
    // ALREADY-mounted, already-300ms-settled page (the previous code here) means the sweep
    // re-reads styles that were never going to move -- the one-shot mount transition finished
    // long ago either way, so that could never actually prove reduced motion SKIPS it, only that
    // nothing is running 300ms after any load. A fresh browser-level media emulation set BEFORE
    // navigation, sampled immediately after mount, is the real claim: if the reduced-motion
    // override ever broke, the transition would still be genuinely running in this early window
    // (independently verified: under `no-preference` the same early sample shows the expected
    // 120ms transitions; under `reduce` it does not).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    // Same 300ms margin as the normal-motion arm above, not a shorter one: empirically, a fresh
    // mount under `transition-duration: 0.01ms !important` still produces several genuinely
    // ONE-SHOT, sub-millisecond CSS transitions across freshly-inserted elements (the reduced-
    // motion override's own blanket rule has no `transition-property`, so it defaults to `all`,
    // meaning any property's first computed value on mount can register as a "transition") -- these
    // take a real, if brief, number of frames for Chromium to retire from `getAnimations()`, and a
    // 50ms sample caught them mid-retirement (self-caught RED during this fix, see the report). None
    // of this is looping or ornamental (each is `iterations: 1`, `duration: 0.01ms`); 300ms is the
    // same proven-sufficient settle window the normal-motion arm already uses.
    await page.waitForTimeout(300)
    const reduced = await decorativeMotionOffenders(page, 'vf-wallet-approval')
    expect(reduced, `decorative motion under reduced motion: ${JSON.stringify(reduced)}`).toEqual(
      []
    )
  })

  // Same sweep, same discipline, over the Home family's own critical screen (seed backup warning
  // -- WalletOnboarding's `critical` prop, WalletShell.jsx's own `data-pocket-critical` marker).
  test('the seed-backup screen (Home family) carries zero decorative motion, both motion settings', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)

    await page.addStyleTag({
      content:
        '[data-fixture="vf-wallet-home"] [data-pocket-critical] ' +
        '{ animation: vfw-fake-pulse 400ms ease-in-out infinite; } ' +
        '@keyframes vfw-fake-pulse { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.02) } }',
    })
    const positiveControl = await decorativeMotionOffenders(page, 'vf-wallet-home')
    expect(
      positiveControl.length,
      'positive control: the injected animation must be detected'
    ).toBeGreaterThan(0)
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    // Same settle margin as the approval-family test above, kept even though WalletShell.jsx's
    // own inline STYLE (read in full) declares no `[data-pocket-critical]`-scoped transition of
    // its own (only per-button transform/color transitions, unconditional on every `.pc-button`,
    // not specific to a critical mount) -- defense in depth against the identical class of
    // transient mount artifact, not evidence one exists here.
    await page.waitForTimeout(300)

    const normal = await decorativeMotionOffenders(page, 'vf-wallet-home')
    expect(normal, `decorative motion under normal settings: ${JSON.stringify(normal)}`).toEqual([])

    // Same fresh-mount fix as the approval-family test above (reviewer Minor, "Also fix" list),
    // and the same 300ms settle margin -- this fixture mounts NINE WalletShell instances at once
    // (one per section) instead of the approval fixture's one, so the same transient mount-noise
    // transitions the approval test's own comment documents take even longer to clear here
    // (self-caught RED at 50ms during this fix: dozens of one-shot, 0.01ms transitions still
    // mid-retirement from `getAnimations()` across several sections). 300ms clears all of them.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    const reduced = await decorativeMotionOffenders(page, 'vf-wallet-home')
    expect(reduced, `decorative motion under reduced motion: ${JSON.stringify(reduced)}`).toEqual(
      []
    )
  })

  // Guards must not pass vacuously on an empty set (this project's own binding lesson). Since the
  // I-2 fix above, `decorativeMotionOffenders` no longer depends on `[data-pocket-critical]` at
  // all (it walks the whole fixture, marked or not) -- its own non-vacuity is now trivial (the
  // fixture root itself always exists and always has descendants, asserted implicitly by every
  // other test in this file passing). This test is kept as a docs-anchored sanity check that
  // WalletShell.jsx's/VfwApprovalCard's/VfwCeremonyCard's own `critical`/`data-pocket-critical`
  // marker is still present where the source says it should be, independent of what the motion
  // sweep does with it.
  test('both fixtures genuinely contain at least one [data-pocket-critical] root (sweep is not vacuous)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-360', 'measured once, not per viewport')
    await page.setViewportSize({ width: 360, height: 600 })
    await page.goto('/visual/?fixture=vf-wallet-home&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    const homeCount = await page.evaluate(
      () =>
        document.querySelectorAll('[data-fixture="vf-wallet-home"] [data-pocket-critical]').length
    )
    expect(homeCount).toBeGreaterThan(0)

    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/visual/?fixture=vf-wallet-approval&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    const approvalCount = await page.evaluate(
      () =>
        document.querySelectorAll('[data-fixture="vf-wallet-approval"] [data-pocket-critical]')
          .length
    )
    expect(approvalCount).toBeGreaterThan(0)
  })

  // VFW14 fix round 1 (owner decision #42): the "KNOWN GAP" test that used to live here asserted
  // `height < 44` on WalletSettings.jsx's Base-mandate link -- an assertion that a real defect
  // PERSISTS, which reddens the suite the day someone fixes it and freezes the violation as a
  // requirement (reviewer Minor). The de-blinded `assert44pxControls` above now covers this link
  // like any other control (it passes, because WalletSettings.jsx fixes it), so a dedicated test
  // asserting the opposite would be a direct, permanent contradiction of that guard. Deleted, not
  // widened.
})

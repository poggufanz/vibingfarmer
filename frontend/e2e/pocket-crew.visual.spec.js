import { expect, test } from '@playwright/test'

// Task 12 fix round 1, M3: the overflow/vertical-text-trap pair below was hand-copied a THIRD
// time for the crew block (the brief said to reuse the shared helpers exactly as the my-money
// block does) -- ~50 lines differing only in the `[data-fixture="..."]` selector string, meaning
// a threshold improvement had to be made three times or would silently diverge. One factory,
// closed over the fixture name, used at all three describe blocks below (Strategy/My money/crew).
// `mobileProjects` defaults to the pair every block already used; Strategy's own prior
// `assertNoOverflowAt320` only ever ran at mobile-320 and asserted the LITERAL width 320 -- folding
// it into this shared shape (asserting against the real `viewportWidth` instead) is a strict
// generalization: at mobile-320 that viewportWidth IS 320, so the assertion is unchanged there,
// and it now also covers mobile-360 for Strategy, which had no overflow guard at all before this
// (verified green in the full run recorded in the fix-round-1 report; mutation-verified below to
// still fail red when the thing it pins breaks).
// Waits out the shared GSAP entrance (design/usePocketTransition.js) after a fixture mounts:
// `toHaveScreenshot`'s `animations: 'disabled'` covers CSS/Web animations only, not gsap's
// rAF-driven inline styles, so without this the capture races the 0.32s+stagger wave and freezes
// mid-flight opacities (found 2026-08-02: my-money baselines regenerated mid-wave, then failed
// the very next run once the wave settled). The check is "no inline opacity/transform LEFT", not
// "opacity ~= 1": the hook now clearProps-es on completion, and an opacity-only check can pass on
// the tween's penultimate frame -- leaving a sub-pixel inline translate that re-anchors the
// fixed recovery sheet and anti-aliases its edges differently on the next run (found same day,
// mobile-360 forest flake). Reduced-motion runs never animate and pass immediately.
async function waitForPocketEnterSettled(page) {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-pocket-enter]')].every((el) => {
          const style = el.getAttribute('style') || ''
          return !style.includes('opacity') && !style.includes('transform')
        }),
      null,
      { timeout: 10000 }
    )
    .catch(() => {})
}

// First-navigation raster warm-up (found 2026-08-02, chasing a my-money flake that survived the
// settle wait above): the FIRST page load in a cold browser process rasterizes the open recovery
// sheet subtly differently from every later load (measured: first-load capture 609105 bytes,
// same page reloaded 609253, then byte-identical forever after; dialog geometry identical
// throughout). With Playwright's parallel workers, whether a my-money theme test lands
// first-in-worker is scheduling luck, which is exactly the pass/fail flapping observed. One
// reload flips the renderer to its stable state -- the captured content itself is unchanged.
async function gotoWarmed(page, url) {
  await page.goto(url)
  await page.reload({ waitUntil: 'load' })
}

function makeFixtureGuards(fixtureName, mobileProjects = ['mobile-320', 'mobile-360']) {
  const selector = `[data-fixture="${fixtureName}"]`

  async function assertNoOverflowAtMobileWidth(page, testInfo) {
    if (!mobileProjects.includes(testInfo.project.name)) return
    const overflow = await page.evaluate((sel) => {
      const viewportWidth = document.documentElement.clientWidth
      let maxRight = 0
      for (const el of document.querySelectorAll(`${sel} *`)) {
        maxRight = Math.max(maxRight, el.getBoundingClientRect().right)
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth,
        maxDescendantRight: maxRight,
      }
    }, selector)
    expect(overflow.scrollWidth, `${testInfo.project.name}: documentElement.scrollWidth`).toBe(
      overflow.viewportWidth
    )
    expect(
      overflow.maxDescendantRight,
      `${testInfo.project.name}: no descendant rect may exceed the viewport, even under overflow-x:clip`
    ).toBeLessThanOrEqual(overflow.viewportWidth + 0.5)
  }

  async function assertNoVerticalTextTrap(page, testInfo) {
    if (!mobileProjects.includes(testInfo.project.name)) return
    const trapped = await page.evaluate((sel) => {
      const hits = []
      for (const el of document.querySelectorAll(`${sel} *`)) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.width < 100 && rect.height > 150) {
          hits.push({ tag: el.tagName, cls: el.className, width: rect.width, height: rect.height })
        }
      }
      return hits
    }, selector)
    expect(
      trapped,
      `narrow+tall element(s) -- vertical text trap: ${JSON.stringify(trapped)}`
    ).toEqual([])
  }

  return { assertNoOverflowAtMobileWidth, assertNoVerticalTextTrap }
}

test('visual harness loads', async ({ page }) => {
  await page.goto('/visual/?fixture=foundation&theme=forest')

  await expect(page.getByRole('heading', { name: 'Pocket Crew visual harness' })).toBeVisible()
})

// Foundation Task 7 -- frozen baselines for the deterministic `foundation` fixture. Snapshot
// names resolve through playwright.config.js's snapshotPathTemplate to the twelve exact files
// `foundation-{variant}-{projectName}.png` across the four configured viewport projects.
test.describe('Pocket Crew foundation', () => {
  test('forest theme', async ({ page }) => {
    await page.goto('/visual/?fixture=foundation&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot('foundation-forest.png', { fullPage: true })
  })

  test('day-field theme', async ({ page }) => {
    await page.goto('/visual/?fixture=foundation&theme=day-field')
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot('foundation-day-field.png', { fullPage: true })
  })

  test('forest theme with prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/visual/?fixture=foundation&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot('foundation-reduced-motion.png', { fullPage: true })
  })
})

// Strategy Task 14 -- frozen baselines for the deterministic `strategy` fixture (Plan input,
// safe-default generating/review, mixed Stellar/Base truth review, Protect fresh/reuse/rejected,
// Start queued/partial-failure/in-transit, all-success and mixed-partial receipts, long
// address/technical details). Same snapshotPathTemplate mechanism as Foundation above resolves
// these three base names to the twelve `strategy-{variant}-{projectName}.png` files.
//
// `[data-fixture-pending="true"]` is set by visual/main.jsx's `AutopilotSection` for every state
// reached through real driven interaction (Plan review, Protect decisions) and cleared once that
// interaction has genuinely settled -- waiting for zero remaining markers means the screenshot
// never races a still-in-flight click/await chain. The fixed 500ms wait afterward is not a
// substitute for that: it only lets StartStage's one-shot, non-looping usePocketTransition GSAP
// entrance (duration 320ms) finish, since Playwright's `animations: 'disabled'` config only forces
// CSS animations/transitions, not JS/rAF-driven ones. Skipped entirely under reduced motion, where
// usePocketTransition takes its `gsap.set(...)` (no-animation) branch instead.
test.describe('Pocket Crew Strategy', () => {
  // G4 (rejection checklist item 12, this task's own binding constraint 4): mobile viewports must
  // show no horizontal overflow, checked BOTH via documentElement.scrollWidth AND every
  // descendant's own bounding rect -- scrollWidth alone stays put even when `overflow-x: clip` is
  // hiding real overflow rather than removing it (the exact trap recorded to have shipped twice on
  // this project), so a rect that quietly exceeds the viewport is still caught here.
  //
  // I-2 (fix round 1, reviewer finding): a fixed-width action column can starve a sibling content
  // track down to a few px WITHOUT ever creating horizontal overflow -- the guard above measures
  // scrollWidth/rect-right and cannot see this at all (verified: it stayed green through the whole
  // defect). assertNoVerticalTextTrap checks the vertical form directly: real content (e.g. a
  // 64-char tx hash) forced into a track under 100px wide wraps to one-to-two characters per line,
  // producing an element taller than 150px at that width -- a shape no legitimate narrow element
  // in this fixture takes (icons/marks are narrow AND short). Runs on both mobile projects, not
  // just 320, since the starved-track defect this guards was never exclusive to exactly 320px.
  const { assertNoOverflowAtMobileWidth, assertNoVerticalTextTrap } = makeFixtureGuards('strategy')

  test('forest theme', async ({ page }, testInfo) => {
    await page.goto('/visual/?fixture=strategy&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('strategy-forest.png', { fullPage: true })
  })

  test('day-field theme', async ({ page }, testInfo) => {
    await page.goto('/visual/?fixture=strategy&theme=day-field')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('strategy-day-field.png', { fullPage: true })
  })

  test('forest theme with prefers-reduced-motion', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/visual/?fixture=strategy&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('strategy-reduced-motion.png', { fullPage: true })
  })
})

// My Money Task 14 -- frozen baselines for the deterministic `my-money` fixture (recovery dialog
// open / active-three-agents-dialog-closed / partial-discovery / no-position-empty, all mounting
// the real /agent composition root, MyMoneyRoute). Declared as exactly FOUR baselines, not the
// naive eight a theme x all-four-projects test would generate: forest is captured only at the two
// mobile projects, day-field only at tablet/desktop -- each test below skips outside its own
// declared projects via testInfo.project.name, the same mechanism the disconnected-compatibility
// group above already establishes (:171-176), not a new one.
//
// `[data-fixture-pending="true"]` (AutopilotSection, visual/main.jsx) is only used by the FIRST
// section here (opening the recovery dialog via a real click) -- MyMoneyRoute itself is a pure,
// static composition with no internal "review" phase, unlike Strategy's PlanStage/ProtectStage, so
// every other section renders synchronously and needs no driven wait at all.
test.describe('Pocket Crew My money', () => {
  const MOBILE_PROJECTS = ['mobile-320', 'mobile-360']
  const WIDE_PROJECTS = ['tablet-768', 'desktop-1440']

  // Same two traps Strategy's own block guards against (:12-58, the shared makeFixtureGuards
  // factory -- fix round 1, M3), scoped to this fixture's own root and to the projects where each
  // is meaningful.
  const { assertNoOverflowAtMobileWidth, assertNoVerticalTextTrap } = makeFixtureGuards(
    'my-money',
    MOBILE_PROJECTS
  )

  // MM14 fix round 1 (I-2, reviewer finding). Generalizes past the one reported row: for every
  // `.pc-position-row`/`.pc-crew-row` list, each row's CONTENT column (its 2nd child) must start
  // roughly at the same x as every sibling row in that same list, whether or not that particular row
  // also carries a trailing full-width nested list (`.pc-position-row-children`/`.pc-crew-row-
  // recovery`). A row whose state label auto-places into the wrong column widens column 1 and shifts
  // every row's content start right -- exactly the needs-recovery defect, caught here by per-element
  // rect, not by overflow (my-money.css:355-358's old `:last-child` bug produced zero horizontal
  // overflow and sat above `assertNoVerticalTextTrap`'s 100px width threshold, so neither existing
  // guard saw it). `TOLERANCE_PX` is deliberately looser than pixel-exact: each `.pc-position-row`/
  // `.pc-crew-row` is its OWN independent grid (not a shared subgrid), so column 1's `auto` track
  // width legitimately varies a few px row to row with its own icon/badge's intrinsic width (e.g.
  // "Base Sepolia" vs "Stellar testnet" -- confirmed live, an 8px legitimate difference on the
  // fixture's own idle-Base row) -- real content-column starvation from a mis-column companion rule
  // moves this by 70px (measured `32px` vs `102px` on the reported row), an order of magnitude past
  // this tolerance. Verified by mutation: temporarily reverted my-money.css's `:nth-child(3)` fix
  // back to `:last-child`, ran this test, got RED (`170px` measured vs `240px` on sibling rows);
  // restored the fix, GREEN again.
  async function assertGridRowContentAligns(page, testInfo) {
    if (!MOBILE_PROJECTS.includes(testInfo.project.name)) return
    const TOLERANCE_PX = 20
    const misaligned = await page.evaluate((tolerance) => {
      const results = []
      for (const sel of ['.pc-position-row', '.pc-crew-row']) {
        const rows = [...document.querySelectorAll(`[data-fixture="my-money"] ${sel}`)]
        if (rows.length < 2) continue
        const lefts = rows.map((row) => row.children[1]?.getBoundingClientRect().left ?? null)
        const reference = lefts.find((l) => l !== null)
        rows.forEach((row, i) => {
          if (lefts[i] !== null && Math.abs(lefts[i] - reference) > tolerance) {
            results.push({ sel, index: i, left: lefts[i], expected: reference })
          }
        })
      }
      return results
    }, TOLERANCE_PX)
    expect(
      misaligned,
      `sibling rows' content column must start within ${TOLERANCE_PX}px of each other: ${JSON.stringify(misaligned)}`
    ).toEqual([])
  }

  // MM14 fix round 1 (I-3, reviewer finding). The contract-mandated mobile safe-area bottom gutter
  // (contract:845-848) must be present on My Money's own `.pc-route` -- a real production gap, not
  // just the harness cascade conflict it was originally misdiagnosed as (see visual/main.jsx's own
  // corrected comment). Verified by mutation: temporarily removed the new rule from my-money.css,
  // ran this test, got RED (16px measured); restored it, GREEN again (80px, env(safe-area-inset-
  // bottom) is 0 in this headless Chromium so the computed value collapses to exactly --pc-space-20).
  async function assertMobileRouteBottomGutter(page, testInfo) {
    if (!MOBILE_PROJECTS.includes(testInfo.project.name)) return
    const paddingBottom = await page.evaluate(() => {
      const route = document.querySelector('[data-fixture="my-money"] .pc-route')
      return route ? parseFloat(getComputedStyle(route).paddingBottom) : null
    })
    expect(paddingBottom, 'expected [data-fixture="my-money"] .pc-route to exist').not.toBeNull()
    expect(
      paddingBottom,
      `My Money .pc-route must carry the contract-mandated 80px mobile bottom gutter, got ${paddingBottom}px`
    ).toBeGreaterThanOrEqual(80)
  }

  // MM14 fix round 1 (I-1, reviewer finding). The recovery dialog panel must be horizontally
  // centered at >=768px (the mobile bottom-sheet override legitimately left-aligns/full-widths it
  // below that, so this only runs on WIDE_PROJECTS). Per-element rect: measures the real left/right
  // gap around the panel rather than trusting a screenshot. Verified by mutation: temporarily added
  // back `justify-items: stretch` to my-money.css's `.pc-my-money-route .pc-dialog`, ran this test,
  // got RED (`left=16, right=944`); removed it, GREEN again (`left==right`).
  async function assertDialogPanelCentered(page, testInfo) {
    if (!WIDE_PROJECTS.includes(testInfo.project.name)) return
    const centering = await page.evaluate(() => {
      const panel = document.querySelector('[data-fixture="my-money"] .pc-dialog-panel')
      if (!panel) return null
      const rect = panel.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth
      return { left: rect.left, right: viewportWidth - rect.right }
    })
    expect(centering, 'expected an open dialog panel to measure').not.toBeNull()
    expect(
      Math.abs(centering.left - centering.right),
      `dialog panel must be horizontally centered -- left gap ${centering.left}, right gap ${centering.right}`
    ).toBeLessThan(1)
  }

  test('forest theme', async ({ page }, testInfo) => {
    test.skip(
      !MOBILE_PROJECTS.includes(testInfo.project.name),
      "My money forest is captured mobile-only (see the brief's four declared baselines)"
    )
    await gotoWarmed(page, '/visual/?fixture=my-money&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await waitForPocketEnterSettled(page)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await assertGridRowContentAligns(page, testInfo)
    await assertMobileRouteBottomGutter(page, testInfo)
    // maxDiffPixelRatio 0.005, documented necessity (measured 2026-08-02): section 1's OPEN
    // recovery sheet is a fixed-position panel with the dominant 24px/60px soft shadow over a
    // 62% backdrop, and Chromium's full-page rasterization of exactly that region varies
    // ~0.1-0.3% of pixels across runs even with identical layout (reproduced by hand: same page,
    // same geometry, bytes shift after unrelated GPU churn). No in-page control exists for it
    // (reload/warm-up does not stabilize it across processes). The dialog's CONTENT remains
    // guarded pixel-exactly by everything else on this page and by the targeted geometry /
    // reduced-motion / axe-open-dialog tests; 0.5% covers the observed raster noise with margin
    // while any real layout/copy regression here stays far above it.
    await expect(page).toHaveScreenshot('my-money-forest.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.005,
    })
  })

  test('day-field theme', async ({ page }, testInfo) => {
    test.skip(
      !WIDE_PROJECTS.includes(testInfo.project.name),
      "My money day-field is captured tablet/desktop-only (see the brief's four declared baselines)"
    )
    await gotoWarmed(page, '/visual/?fixture=my-money&theme=day-field')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await waitForPocketEnterSettled(page)
    await assertDialogPanelCentered(page, testInfo)
    // Same documented raster-noise tolerance as the forest capture directly above (open fixed
    // sheet + dominant soft shadow + backdrop, ~0.1-0.3% GPU raster variance across processes).
    await expect(page).toHaveScreenshot('my-money-day-field.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.005,
    })
  })

  // Step 3 (motion, real Chromium only -- jsdom reports animationName:"none" regardless of what's
  // declared and computes no geometry at all, so this cannot be a vitest guard). Measured once,
  // not per-viewport: neither assertion below depends on width.
  test('reduced motion forces an injected dialog/disclosure transition back to instant', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'measured once, not per viewport')
    await page.goto('/visual/?fixture=my-money&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    // Positive control: My Money's own Dialog/TechnicalDetails declare NO transition at all today
    // (Foundation's shared Primitives.jsx pops them in/out instantly, confirmed by reading
    // pocket-crew.css/my-money.css) -- so proving pocket-crew.css's global reduced-motion override
    // (`*, *::before, *::after { transition-duration: 0.01ms !important }`) actually WINS requires
    // first giving it something real to override. This injects a plausible future transition onto
    // exactly the two elements Step 3 names.
    await page.addStyleTag({
      content:
        '.pc-dialog-panel, .pc-technical-details-body { transition: opacity 600ms, transform 600ms; }',
    })
    const panel = page.locator('.pc-dialog-panel').first()
    await expect(panel).toBeVisible()
    const normalDuration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(normalDuration, 'the injected transition must be honored under normal motion').toMatch(
      /0\.6s/
    )

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedDuration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
    // pocket-crew.css's own literal override value (0.01ms == 0.00001s), not a hand-picked
    // threshold -- any value that isn't ~600ms proves the override fired.
    expect(
      parseFloat(reducedDuration),
      `reduced motion must force the transition back near-instant, got ${reducedDuration}`
    ).toBeLessThan(0.001)
  })

  // Step 3, "graph animation pauses when disclosure closes" -- My Money Task 14's own scoped
  // exception (src/graph/PixiSwarmGraph.jsx's new `paused` prop, src/components/money/
  // TechnicalMoneyDetails.jsx's native `toggle` listener; see that file's own header comment).
  // `data-graph-paused` only reflects the wiring's OWN React prop, which is necessary but not
  // sufficient proof -- a regression could leave that attribute correct while the ticker keeps
  // running underneath it. `data-ticker-started` is different: PixiSwarmGraph.jsx sets it from
  // Pixi's OWN `ticker.started` property, read fresh every time the effect runs, so it can only
  // ever say "true" if the real ticker is actually running (found empirically that a page-wide
  // requestAnimationFrame counter is far too noisy for this -- Pixi's texture-GC/interaction
  // systems and other page activity call it continuously regardless of any one graph's state).
  // Real motion while open is proven separately by an actual canvas screenshot diff, which a
  // static ticker could never produce two different frames for.
  test('graph animation pauses when its disclosure closes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'measured once, not per viewport')
    await page.goto('/visual/?fixture=my-money&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )

    // The fixture's own first section has the recovery dialog open by design (AutopilotSection,
    // on mount) -- Primitives.jsx's Dialog is a real, viewport-covering top-layer overlay (found
    // empirically: it blocks a click ANYWHERE on the page, not just its own section, exactly the
    // focus-trap behavior a modal is supposed to have). Dismiss it the same way a real user would
    // -- its own Close button -- before interacting with anything else on the page.
    await page.locator('dialog, [role="dialog"]').getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('dialog, [role="dialog"]')).toHaveCount(0)

    const summary = page
      .locator(
        '[data-fixture="my-money"] .pc-technical-details summary:has-text("Agent network graph (advanced)")'
      )
      .first()
    const graph = page.locator('[data-fixture="my-money"] .agent-graph').first()

    // Closed by default: the ticker has never started.
    await expect(graph).toHaveAttribute('data-ticker-started', 'false')

    await summary.click()
    await expect(graph).toHaveAttribute('data-graph-paused', 'false')
    await expect(graph).toHaveAttribute('data-ticker-started', 'true')
    await page.waitForSelector('[data-fixture="my-money"] .agent-graph canvas')

    // Real motion, not just a property: two frames half a second apart while genuinely running
    // must differ (dust drift/corona pulse, scene.js's own continuous per-frame advance).
    const frame1 = await graph.screenshot()
    await page.waitForTimeout(500)
    const frame2 = await graph.screenshot()
    expect(
      frame1.equals(frame2),
      'expected the running graph to render at least one different frame'
    ).toBe(false)

    await summary.click()
    await expect(graph).toHaveAttribute('data-graph-paused', 'true')
    await expect(graph).toHaveAttribute('data-ticker-started', 'false')
  })

  // Owner decision #41 (first clause): the brief's "Disclosure/dialog transitions use opacity/
  // transform and become instant under reduced motion" is vacuously true today -- My Money declares
  // no such transition at all (confirmed by reading Primitives.jsx/my-money.css), and decision #41
  // forbids inventing a production transition just to exercise the clause. This is the PERMANENT
  // guard instead: it sweeps every real (non-injected) dialog/disclosure element for a live
  // transition and, for any it finds, requires that transition to still collapse under reduced
  // motion. Today the sweep finds nothing and this passes vacuously, honestly -- but it is
  // mutation-proven to catch the realistic regression this clause exists to prevent: a future
  // component-scoped `transition-duration: ... !important` declaration, which (unlike the plain
  // injected transition the positive-control test above proves the global override wins over) has
  // enough specificity to beat pocket-crew.css's universal `*, *::before, *::after {transition-
  // duration: 0.01ms !important}` override -- CSS's cascade only falls back to specificity/order
  // among declarations of equal importance, and a class selector always outranks the universal one.
  // Verified by mutation: temporarily added `.pc-dialog-panel { transition-duration: 600ms
  // !important }` via page.addStyleTag, ran this test, got RED (600ms still measured under reduced
  // motion); removed the injection, GREEN again.
  test('no dialog/disclosure transition on My Money escapes the reduced-motion override', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'measured once, not per viewport')
    await page.goto('/visual/?fixture=my-money&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )

    const selectors = [
      '.pc-dialog',
      '.pc-dialog-panel',
      '.pc-dialog-actions',
      '.pc-technical-details',
      '.pc-technical-details-body',
      'details',
      'summary',
    ]
    const sweep = (thresholdMs) =>
      page.evaluate(
        ({ sels, threshold }) => {
          const out = []
          for (const sel of sels) {
            for (const el of document.querySelectorAll(`[data-fixture="my-money"] ${sel}`)) {
              const durationMs = parseFloat(getComputedStyle(el).transitionDuration) * 1000
              if (durationMs > threshold) out.push({ sel, className: el.className, durationMs })
            }
          }
          return out
        },
        { sels: selectors, threshold: thresholdMs }
      )

    const liveUnderNormalMotion = await sweep(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const stillAnimatingUnderReducedMotion = await sweep(1)

    expect(
      stillAnimatingUnderReducedMotion,
      `dialog/disclosure element(s) whose transition does NOT collapse under reduced motion: ` +
        `${JSON.stringify(stillAnimatingUnderReducedMotion)} (${liveUnderNormalMotion.length} live ` +
        `transition(s) found under normal motion: ${JSON.stringify(liveUnderNormalMotion)})`
    ).toEqual([])
  })

  // Owner decision #41 (second clause): "Money changes crossfade only after a new confirmed
  // revision" is also vacuously true today -- MoneyFigure declares no transition/animation at all
  // (Primitives.jsx), so nothing crossfades, ever, let alone on a same-revision re-render. Same
  // discipline as the guard above: no invented production transition, but a real-browser, positive-
  // controlled check that a same-revision re-render (a NEW `model` object reference with byte-
  // identical fields -- the shape a poll tick returning unchanged chain state would produce, driven
  // via the harness-only `MoneySameRevisionHarness`, visual/main.jsx) never visibly changes the
  // money figure.
  test('money values crossfade only after a new confirmed revision, not on a same-revision re-render', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'measured once, not per viewport')
    await page.goto('/visual/?fixture=my-money&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    // Same race as the screenshot rows above: the harness's own MyMoneyRoute plays the entrance
    // on mount, and the positive control's pulse can land on a mid-tween frame.
    await waitForPocketEnterSettled(page)

    const moneyFigure = page
      .locator('[data-testid="mm-same-revision-harness"] .pc-dominant--owned .pc-money')
      .first()
    await expect(moneyFigure).toBeVisible()

    // Positive control: prove the screenshot-diff technique below can actually detect a visible
    // change on this exact element before trusting it to report "no change" for real.
    const pulse = await page.addStyleTag({
      content:
        '[data-testid="mm-same-revision-harness"] .pc-money { animation: mm-fake-pulse 300ms infinite; } ' +
        '@keyframes mm-fake-pulse { from { opacity: 1 } to { opacity: 0.35 } }',
    })
    const pulseFrame1 = await moneyFigure.screenshot()
    await page.waitForTimeout(150)
    const pulseFrame2 = await moneyFigure.screenshot()
    expect(
      pulseFrame1.equals(pulseFrame2),
      'positive control: the injected pulse must be visibly detected by this screenshot diff'
    ).toBe(false)
    await pulse.evaluate((el) => el.remove())

    // Real assertion: a same-revision re-render must not change the money figure at all.
    const before = await moneyFigure.screenshot()
    // `.pc-visually-hidden` (deliberate -- this button must never appear in a frozen baseline)
    // fails Playwright's normal actionability check ("element is outside of the viewport"), since
    // the clip-rect trick leaves nothing for scrollIntoView to target. `dispatchEvent` fires the
    // real DOM click React's onClick listens for without requiring visibility/viewport actionability.
    await page.getByTestId('mm-force-same-revision-rerender').dispatchEvent('click')
    const justAfter = await moneyFigure.screenshot()
    await page.waitForTimeout(150)
    const settledAfter = await moneyFigure.screenshot()

    expect(
      before.equals(justAfter),
      'a same-revision re-render must not change the money figure at all'
    ).toBe(true)
    expect(
      justAfter.equals(settledAfter),
      'no crossfade should still be mid-flight after a same-revision re-render'
    ).toBe(true)
  })
})

// Task 12 (visual harness fixtures + snapshot regeneration) -- frozen baselines for the
// deterministic `crew` fixture (armed/two Sprout children, alarm-only/mandate-lapsed,
// one-agent-cancelled, empty), all mounting the real `/agent` composition root's own CrewRoute
// (src/components/crew/CrewRoute.jsx). Declared as exactly FOUR baselines, not a naive eight,
// mirroring My Money's own declared-project split immediately above (:149-153): forest captured
// only at the two mobile projects, day-field only at tablet/desktop.
//
// `[data-fixture-pending="true"]` is used here even though CrewFixture drives no
// AutopilotSection of its own -- CrewRoute is `lazy()`-loaded in visual/main.jsx for the same
// CSS-cascade reason MyMoneyRoute is (its own crew.css re-declares `.pc-route`'s padding
// shorthand, the same defect class My Money's own header comment there documents), so the wait
// still matters: the fixture is genuinely pending until that dynamic import resolves, exactly as
// My Money's own header comment (:144-147) explains for its own lazy-loaded route.
test.describe('Pocket Crew crew', () => {
  const MOBILE_PROJECTS = ['mobile-320', 'mobile-360']
  const WIDE_PROJECTS = ['tablet-768', 'desktop-1440']

  // Same two traps Strategy's/My Money's own blocks guard against, via the shared
  // makeFixtureGuards factory (:12-58 -- fix round 1, M3: this was a third hand-copied verbatim
  // pair before this fix), scoped to this fixture's own root.
  const { assertNoOverflowAtMobileWidth, assertNoVerticalTextTrap } = makeFixtureGuards(
    'crew',
    MOBILE_PROJECTS
  )

  async function assertPersistentPersonaFixture(page) {
    const shape = await page.evaluate(() => {
      const firstRoute = document.querySelector('[data-fixture="crew"] .pc-crew-route')
      const cards = [...(firstRoute?.querySelectorAll('[data-persona-id]') || [])]
      return cards.map((card) => ({
        id: card.dataset.personaId,
        children: card.querySelectorAll('[data-child-address]').length,
      }))
    })
    expect(shape).toEqual([
      { id: 'sprout', children: 2 },
      { id: 'clover', children: 0 },
      { id: 'mochi', children: 0 },
    ])
  }

  test('forest theme', async ({ page }, testInfo) => {
    test.skip(
      !MOBILE_PROJECTS.includes(testInfo.project.name),
      "Crew forest is captured mobile-only (mirrors My money's own declared four baselines)"
    )
    await page.goto('/visual/?fixture=crew&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await waitForPocketEnterSettled(page)
    await assertPersistentPersonaFixture(page)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('crew-forest.png', { fullPage: true })
  })

  test('day-field theme', async ({ page }, testInfo) => {
    test.skip(
      !WIDE_PROJECTS.includes(testInfo.project.name),
      "Crew day-field is captured tablet/desktop-only (mirrors My money's own declared four baselines)"
    )
    await page.goto('/visual/?fixture=crew&theme=day-field')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await waitForPocketEnterSettled(page)
    await assertPersistentPersonaFixture(page)
    await expect(page).toHaveScreenshot('crew-day-field.png', { fullPage: true })
  })

  // Step 3 (motion, real Chromium only -- jsdom reports animationName:"none" regardless of what's
  // declared, same reasoning as My Money's own equivalent test above). CrewGuard.jsx's
  // `.pc-crew-radar-sweep` runs `pc-crew-sweep 5.5s linear infinite` in every guard phase
  // (crew.css:218-227) and is forced to `animation: none` under reduced motion, unconditionally
  // (crew.css:260-263) -- not phase-scoped, so this needs no positive/negative phase selection,
  // only the fixture's first (armed, fully-exposed) section's own sweep element.
  test('reduced motion forces the radar sweep animation off', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'measured once, not per viewport')
    await page.goto('/visual/?fixture=crew&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    const sweep = page.locator('[data-fixture="crew"] .pc-crew-radar-sweep').first()
    await expect(sweep).toBeVisible()

    // Positive control: prove the sweep is genuinely animating under normal motion before trusting
    // "none" to mean anything once reduced motion is emulated.
    const normalName = await sweep.evaluate((el) => getComputedStyle(el).animationName)
    expect(normalName, 'the radar sweep must be animated under normal motion').toBe('pc-crew-sweep')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedName = await sweep.evaluate((el) => getComputedStyle(el).animationName)
    expect(reducedName, 'the radar sweep animation must collapse under reduced motion').toBe('none')
  })
})

// Foundation Task 8 -- compact compatibility smoke over the six disconnected/shared routes, real
// app (not the /visual/ fixture harness), desktop-1440 only. Named "disconnected compatibility"
// (not "Pocket Crew foundation") so Step 5's `--grep "Pocket Crew foundation"` gate does not also
// re-run this group -- Step 4 is its only capture/verify pass in this task. Each route uses a
// `position:fixed; inset:0; overflow-y:auto` inner scroller, so `fullPage:true` below only ever
// captures the 1440x1000 viewport, never content past the fold (e.g. Explorer's Vault TVL).
const disconnectedRoutes = Object.freeze([
  { id: 'landing', path: '/', skipLanding: false },
  { id: 'home', path: '/home', skipLanding: true },
  { id: 'history', path: '/history', skipLanding: true },
  { id: 'settings', path: '/settings', skipLanding: true },
  { id: 'explorer', path: '/explorer', skipLanding: false },
  { id: 'developers', path: '/developers', skipLanding: false },
])
const compatibilityThemes = Object.freeze(['forest', 'day-field'])

// The most stable visible landmark per route. History/Settings render no semantic <h1> yet
// (a pre-existing gap outside this task's file list) so a blanket heading-role query would miss
// them -- each entry names the actual visible connect/page/landing text instead. Home's own
// button-text landmark predates Task 10's IA remap (My money is `/home` now, HomePage retired) --
// MyMoneyRoute DOES carry a real `<h1>My money</h1>` today (a heading-role query would work), but
// the button text is left as the landmark unchanged: it is still the most specific evidence that
// the real disconnected-CTA content rendered (not just an empty shell with a heading), and this
// was re-verified against the real disconnected /home render (both themes) as part of that task's
// fix round rather than assumed still valid.
// /developers currently redirects a disconnected visitor to the same Landing takeover as "/"
// (app.jsx's `!skipLanding && !realAddress` gate runs before the /developers route ever mounts,
// and app.jsx is not in this task's file list) -- this asserts what genuinely renders today, not
// a fixed IA.
const ROUTE_LANDMARKS = Object.freeze({
  landing: { role: 'heading', name: /One signature/i },
  home: { role: 'button', name: 'Connect Wallet' },
  // 2026-08-02 polish: /history now has a real h1 (the old mono-eyebrow gap is closed), so the
  // landmark upgrades to the semantic heading the a11y rules always wanted here.
  history: { role: 'heading', name: 'History', exact: true },
  settings: { text: 'Agent Configuration' },
  explorer: { role: 'heading', name: 'Explorer' },
  developers: { role: 'heading', name: /One signature/i },
})

test.describe('Pocket Crew disconnected compatibility', () => {
  for (const theme of compatibilityThemes) {
    for (const route of disconnectedRoutes) {
      test(`${route.id} -- ${theme}`, async ({ page }, testInfo) => {
        test.skip(
          testInfo.project.name !== 'desktop-1440',
          'disconnected compatibility group is desktop-1440 only'
        )

        if (route.skipLanding) {
          // ONLY these two flags -- never an address/wallet/position/grant/balance, so the
          // captured state is genuinely the disconnected/no-wallet experience.
          await page.addInitScript(() => {
            localStorage.setItem('yv_skip_landing', 'true')
            localStorage.setItem('yv_onboarded', 'true')
          })
        }

        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(String(err)))
        const failedImages = []
        page.on('response', (res) => {
          if (res.request().resourceType() === 'image' && !res.ok()) {
            failedImages.push(`${res.status()} ${res.url()}`)
          }
        })
        page.on('requestfailed', (req) => {
          if (req.resourceType() === 'image') {
            failedImages.push(`${req.failure()?.errorText || 'failed'} ${req.url()}`)
          }
        })

        await page.goto(route.path)
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        // Step 0b (My Money Task 14) root-cause fix, found while re-justifying the 5 stale
        // baselines: BrandLockup's compact mark (Sidebar's top-left `.sb-logo-mark`) resolves its
        // <img src> from the DOM theme attribute synchronously at React render time and does not
        // re-render on an external attribute mutation -- production only ever reaches a theme
        // change through a real React state update (PalettePicker's setTweak), never a raw
        // setAttribute. This test forces the theme by raw DOM mutation (the line above), so the
        // mark only self-corrects on whichever incidental app re-render happens to land next
        // (e.g. the per-route money-model effect, ~90ms after mount) -- a genuine race against the
        // screenshot below, not a stale/flaky baseline. Wait for it explicitly rather than betting
        // on that race; a no-op on routes with no sidebar mark (landing/developers redirect there).
        const expectedMarkFile = theme === 'day-field' ? 'mark-day.svg' : 'mark-forest.svg'
        await page.waitForFunction((file) => {
          const img = document.querySelector('.sb-logo-mark img')
          return !img || img.getAttribute('src')?.endsWith(file)
        }, expectedMarkFile)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.evaluate(() => document.fonts.ready)

        expect(pageErrors, `pageerror on ${route.id}/${theme}`).toEqual([])
        expect(failedImages, `missing brand/network image on ${route.id}/${theme}`).toEqual([])

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
        expect(overflow, `horizontal overflow on ${route.id}/${theme}`).toBeLessThanOrEqual(0)

        const landmark = ROUTE_LANDMARKS[route.id]
        const locator = landmark.role
          ? page.getByRole(landmark.role, { name: landmark.name })
          : page.getByText(landmark.text)
        await expect(locator.first()).toBeVisible()

        if (route.id !== 'landing') {
          const lavaButtonCount = await page.evaluate(
            () =>
              Array.from(document.querySelectorAll('button, a')).filter((el) =>
                getComputedStyle(el)
                  .animationName.split(',')
                  .map((s) => s.trim())
                  .includes('btn-lava')
              ).length
          )
          expect(lavaButtonCount, `btn-lava animation computed on ${route.id}/${theme}`).toBe(0)
        }

        // snapshotPathTemplate appends "-{projectName}" itself (see playwright.config.js), so the
        // arg here is the exact `compat-<id>-<theme>-desktop-1440.png` baseline minus that suffix.
        await expect(page).toHaveScreenshot(`compat-${route.id}-${theme}.png`, {
          fullPage: true,
        })
      })
    }
  }
})

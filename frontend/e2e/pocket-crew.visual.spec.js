import { expect, test } from '@playwright/test'

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
  // G4 (rejection checklist item 12, this task's own binding constraint 4): 320px must show no
  // horizontal overflow, checked BOTH via documentElement.scrollWidth AND every descendant's own
  // bounding rect -- scrollWidth alone stays 320 even when `overflow-x: clip` is hiding real
  // overflow rather than removing it (the exact trap recorded to have shipped twice on this
  // project), so a rect that quietly exceeds the viewport is still caught here.
  async function assertNoOverflowAt320(page, testInfo) {
    if (testInfo.project.name !== 'mobile-320') return
    const overflow = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth
      let maxRight = 0
      for (const el of document.querySelectorAll('[data-fixture="strategy"] *')) {
        maxRight = Math.max(maxRight, el.getBoundingClientRect().right)
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth,
        maxDescendantRight: maxRight,
      }
    })
    expect(overflow.scrollWidth, '320px: documentElement.scrollWidth').toBe(320)
    expect(
      overflow.maxDescendantRight,
      '320px: no descendant rect may exceed the viewport, even under overflow-x:clip'
    ).toBeLessThanOrEqual(overflow.viewportWidth + 0.5)
  }

  // I-2 (fix round 1, reviewer finding): a fixed-width action column can starve a sibling content
  // track down to a few px WITHOUT ever creating horizontal overflow -- the guard above measures
  // scrollWidth/rect-right and cannot see this at all (verified: it stayed green through the whole
  // defect). This checks the vertical form directly: real content (e.g. a 64-char tx hash) forced
  // into a track under 100px wide wraps to one-to-two characters per line, producing an element
  // taller than 150px at that width -- a shape no legitimate narrow element in this fixture takes
  // (icons/marks are narrow AND short). Runs on both mobile projects, not just 320, since the
  // starved-track defect this guards was never exclusive to exactly 320px.
  async function assertNoVerticalTextTrap(page, testInfo) {
    if (!['mobile-320', 'mobile-360'].includes(testInfo.project.name)) return
    const trapped = await page.evaluate(() => {
      const hits = []
      for (const el of document.querySelectorAll('[data-fixture="strategy"] *')) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.width < 100 && rect.height > 150) {
          hits.push({ tag: el.tagName, cls: el.className, width: rect.width, height: rect.height })
        }
      }
      return hits
    })
    expect(
      trapped,
      `narrow+tall element(s) -- vertical text trap: ${JSON.stringify(trapped)}`
    ).toEqual([])
  }

  test('forest theme', async ({ page }, testInfo) => {
    await page.goto('/visual/?fixture=strategy&theme=forest')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-fixture-pending="true"]').length === 0
    )
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await assertNoOverflowAt320(page, testInfo)
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
    await assertNoOverflowAt320(page, testInfo)
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

// The most stable visible landmark per route. Home/History/Settings render no semantic <h1> yet
// (a pre-existing gap outside this task's file list) so a blanket heading-role query would miss
// them -- each entry names the actual visible connect/page/landing text instead.
// /developers currently redirects a disconnected visitor to the same Landing takeover as "/"
// (app.jsx's `!skipLanding && !realAddress` gate runs before the /developers route ever mounts,
// and app.jsx is not in this task's file list) -- this asserts what genuinely renders today, not
// a fixed IA.
const ROUTE_LANDMARKS = Object.freeze({
  landing: { role: 'heading', name: /One signature/i },
  home: { role: 'button', name: 'Connect Wallet' },
  history: { text: 'History, on-chain explorer' },
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

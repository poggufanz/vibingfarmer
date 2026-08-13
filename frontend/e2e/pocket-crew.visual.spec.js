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
      const exposed = (element) => {
        if (element.getClientRects().length === 0) return false
        if (element.closest('[aria-hidden="true"], [inert], [hidden]')) return false
        const closedDetails = element.closest('details:not([open])')
        return !closedDetails || Boolean(element.closest('summary'))
      }
      for (const el of document.querySelectorAll(`${sel} *`)) {
        const rect = el.getBoundingClientRect()
        if (exposed(el) && rect.width > 0 && rect.width < 100 && rect.height > 150) {
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

// Task 11 Core atlas contract.  Core routes are intentionally captured as a complete WEB-12
// matrix: each owned fixture runs Forest, Day Field, and reduced Forest across all four fixed
// Playwright projects.  Keep this table explicit so a missing class, an excluded CAP-17 drawer,
// or an accidental extra capture cannot hide in a loop over whatever happens to be mounted.
const CORE_FIXTURE_CLASSES = Object.freeze([
  { id: 'core-money', label: 'My money', title: 'Pocket Crew My money' },
  { id: 'core-strategy', label: 'Strategy', title: 'Pocket Crew Strategy' },
  { id: 'core-crew', label: 'crew', title: 'Pocket Crew crew' },
  { id: 'core-settings', label: 'Settings', title: 'Pocket Crew Settings' },
  { id: 'core-dialog', label: 'Dialog', title: 'Pocket Crew Dialog' },
  { id: 'core-base-withdraw', label: 'Base', title: 'Pocket Crew Base' },
])

const CORE_CAPTURE_VARIANTS = Object.freeze([
  { name: 'forest', title: 'forest', theme: 'forest', reducedMotion: false },
  { name: 'day-field', title: 'day-field', theme: 'day-field', reducedMotion: false },
  // Keep the file/snapshot name contract while avoiding the functional-gate keyword in the
  // capture test title. This keeps the screenshot grep and non-snapshot grep disjoint.
  { name: 'reduced-motion', title: 'motion-safe field', theme: 'forest', reducedMotion: true },
])

const CORE_PROJECT_NAMES = Object.freeze(['mobile-320', 'mobile-360', 'tablet-768', 'desktop-1440'])

// I1 browser style contract.  The static CSS test proves ownership and token spelling, while
// this table proves that every Core route actually mounts each canonical selector group.  Keep
// groups deliberately route-specific: querying a shared class alone would let a route disappear
// behind a stale wrapper while an unrelated screen satisfies the check.
const CORE_STYLE_GROUPS = Object.freeze({
  'core-money': [
    { id: 'route', selector: '.pc-my-money-route', padding: true },
    { id: 'section', selector: '.pc-money-section' },
    { id: 'dominant', selector: '.pc-dominant', background: true, radius: true },
    { id: 'button', selector: '.pc-button', radius: true },
  ],
  'core-strategy': [
    { id: 'route', selector: '.pc-route', padding: true },
    { id: 'stage-nav', selector: '.pc-strategy-stage-nav', display: 'grid' },
    { id: 'decision', selector: '.pc-strategy-decision', background: true, radius: true },
    { id: 'button', selector: '.pc-button', radius: true },
  ],
  'core-crew': [
    { id: 'route', selector: '.pc-crew-route', padding: true },
    { id: 'stats', selector: '.pc-crew-stats', display: 'grid' },
    { id: 'guard', selector: '.pc-crew-guard', background: true, radius: true },
    // Activity is a canonical grid primitive; its production rule intentionally has no radius.
    // Keep the computed-style/measurement/mutation guard without inventing a token requirement.
    { id: 'activity', selector: '.pc-crew-activity' },
    { id: 'button', selector: '.pc-button', radius: true },
  ],
  'core-settings': [
    { id: 'page', selector: '.pc-settings' },
    { id: 'tabs', selector: '.pc-settings-tabs', display: 'flex' },
    { id: 'section', selector: '.pc-settings-section' },
    { id: 'card', selector: '.pc-settings-card', background: true, radius: true },
    { id: 'button', selector: '.pc-settings-button', radius: true },
  ],
  'core-dialog': [
    { id: 'dialog', selector: '.pc-dialog', background: true },
    { id: 'panel', selector: '.pc-dialog-panel', background: true, radius: true },
    {
      id: 'actions',
      selector: '.pc-dialog-actions',
      display: 'flex',
      mobileDisplay: 'grid',
    },
    { id: 'button', selector: '.pc-button', radius: true },
  ],
  'core-base-withdraw': [
    { id: 'dialog', selector: '.pc-dialog', background: true },
    { id: 'panel', selector: '.pc-dialog-panel', background: true, radius: true },
    { id: 'scroll', selector: '.pc-base-withdraw-scroll' },
    { id: 'body', selector: '.pc-base-withdraw-body' },
    // The receipt is an unboxed data region by design; its canonical rule has no fill or radius.
    // Keep the mount/measurement/mutation guard without imposing the panel token on it.
    { id: 'receipt', selector: '.pc-base-withdraw-receipt' },
    { id: 'button', selector: '.pc-button', radius: true },
  ],
})

// Network badges are part of the route contract, not incidental copy.  Keep the expected visible
// set keyed by fixture state so a stale badge in a hidden atlas section, a route-level text match,
// or an incorrect Base/Stellar label cannot satisfy the guard by accident.
const CORE_NETWORK_LABELS = Object.freeze({
  'core-money': Object.freeze(
    Object.fromEntries(
      [
        'disconnected',
        'loading',
        'current',
        'stale',
        'empty',
        'partial-discovery',
        'problem',
        'unavailable',
        'disarmed',
        'recovery-opener',
      ].map((state) => [state, ['Stellar testnet']])
    )
  ),
  'core-strategy': Object.freeze(
    Object.fromEntries(
      [
        'plan',
        'protect',
        'start',
        'receipt',
        'yield-unavailable',
        'permission-fresh',
        'permission-reuse-verified',
        'permission-rejected',
        'permission-reuse-unavailable',
        'queued',
        'partial',
      ]
        .map((state) => [state, ['Stellar testnet']])
        .concat([
          ['in-transit', ['Base Sepolia', 'Stellar testnet']],
          ['base-custody', ['Base Sepolia', 'Stellar testnet']],
        ])
    )
  ),
  'core-crew': Object.freeze(
    Object.fromEntries(
      ['armed', 'alarm-only', 'cancelled', 'stable-child-marks']
        .map((state) => [state, ['Stellar testnet']])
        .concat([
          ['unknown', []],
          ['empty', []],
        ])
    )
  ),
  'core-settings': Object.freeze({
    default: [],
    wallet: ['Base Sepolia', 'Stellar testnet'],
    'mandate-ready': ['Base Sepolia', 'Stellar testnet'],
    'mandate-missing': ['Base Sepolia', 'Stellar testnet'],
    'mandate-expired': ['Base Sepolia', 'Stellar testnet'],
    'mandate-revoked': ['Base Sepolia', 'Stellar testnet'],
    'mandate-disconnected': ['Base Sepolia', 'Stellar testnet'],
    'mandate-unavailable': ['Base Sepolia', 'Stellar testnet'],
    'mandate-busy': ['Base Sepolia', 'Stellar testnet'],
  }),
  'core-dialog': Object.freeze(
    Object.fromEntries(
      [
        'plan-edit',
        'plan-reset',
        'withdraw',
        'stop-access',
        'recovery',
        'settings-clear',
        'invalid',
        'submitting',
        'confirmed',
        'failed',
        'unknown',
      ].map((state) => [state, []])
    )
  ),
  'core-base-withdraw': Object.freeze(
    Object.fromEntries(
      [
        'idle',
        'submitting',
        'relaying',
        'polling',
        'confirmed',
        'failed',
        'submission-unknown',
        'in-transit',
      ].map((state) => [state, ['Base Sepolia', 'Stellar testnet']])
    )
  ),
})

const CORE_CREW_RADAR_MOTION = Object.freeze(new Set(['armed', 'stable-child-marks']))
const CORE_CREW_RADAR_ABSENT = Object.freeze(new Set(['unknown', 'empty']))

function coreFixtureSelector(fixtureId) {
  return `[data-fixture="${fixtureId}"]`
}

function coreFixtureUrl(fixtureId, theme, state) {
  const query = new URLSearchParams({ fixture: fixtureId, theme })
  if (state) query.set('state', state)
  return `/visual/?${query.toString()}`
}

async function waitForCoreFixture(page, fixtureId) {
  const selector = coreFixtureSelector(fixtureId)
  await page.waitForSelector(selector, { state: 'attached' })
  await page.waitForFunction((sel) => {
    const root = document.querySelector(sel)
    if (!root || root.matches('[data-fixture-pending="true"]')) return false
    const error = root.querySelector('[data-fixture-error]')
    if (error) {
      throw new Error(
        `${sel}: fixture autopilot failed: ${error.getAttribute('data-fixture-error')}`
      )
    }
    return root.querySelectorAll('[data-fixture-pending="true"]').length === 0
  }, selector)
  await page.evaluate(() => document.fonts.ready)
  await waitForPocketEnterSettled(page)
}

function makeCoreFixtureGuards(fixtureId) {
  const selector = coreFixtureSelector(fixtureId)

  async function assertMountedAndLandmarked(page) {
    if (['core-dialog', 'core-base-withdraw'].includes(fixtureId)) {
      await page.waitForFunction(
        (sel) => {
          const root = document.querySelector(sel)
          const dialog = [...(root?.querySelectorAll('.pc-dialog') || [])].find(
            (element) => element.getClientRects().length > 0
          )
          return Boolean(dialog && dialog.contains(document.activeElement))
        },
        selector,
        { timeout: 3000 }
      )
    }
    const shape = await page.evaluate(
      ({ sel, fixtureId: id }) => {
        const root = document.querySelector(sel)
        if (!root) return null
        const activeAtlasContent = (element) =>
          !element.closest('[data-core-state][aria-hidden="true"], [data-core-state][hidden]')
        const visible = (element) =>
          element.getClientRects().length > 0 &&
          activeAtlasContent(element) &&
          !element.closest('[aria-hidden="true"], [inert], [hidden]')
        // A modal legitimately makes its route background inert, but that route h1 must still be a
        // real h1 in the DOM. Counting the dialog's h2 as an h1 made overlay-only callers falsely
        // green while no route had mounted at all.
        const headings = [...root.querySelectorAll('h1')].filter(activeAtlasContent)
        const dialogs = [...root.querySelectorAll('.pc-dialog')].filter(visible)
        const dialogDetails = dialogs.map((dialog) => {
          const labelledBy = dialog.getAttribute('aria-labelledby')
          const title = labelledBy ? document.getElementById(labelledBy) : null
          const titleNodes = [...dialog.querySelectorAll('.pc-dialog-title')].filter(visible)
          const descriptionNodes = [...dialog.querySelectorAll('.pc-dialog-description')].filter(
            visible
          )
          const active = document.activeElement
          return {
            tag: dialog.tagName,
            modal: dialog.getAttribute('aria-modal'),
            labelledBy,
            name: title?.textContent?.trim() || '',
            titleCount: titleNodes.length,
            titleTags: titleNodes.map((node) => node.tagName),
            descriptionCount: descriptionNodes.length,
            descriptionText: descriptionNodes.map((node) => node.textContent?.trim() || ''),
            focusInside: Boolean(active && dialog.contains(active)),
          }
        })
        const mains = [...document.querySelectorAll('main')].filter((main) => root.contains(main))
        const actions = [...root.querySelectorAll('button, a, input, select, textarea')].filter(
          (element) => visible(element) && !element.hasAttribute('disabled')
        )
        return {
          rootVisible: root.getClientRects().length > 0,
          h1Count: headings.length,
          h1Text: headings.map((heading) => heading.textContent?.trim()).filter(Boolean),
          mainCount: mains.length,
          actionCount: actions.length,
          dialogCount: dialogs.length,
          dialogs: dialogDetails,
          expectsDialog: ['core-dialog', 'core-base-withdraw'].includes(id),
        }
      },
      { sel: selector, fixtureId }
    )
    expect(shape, `${fixtureId} must mount its real fixture root`).not.toBeNull()
    expect(shape.rootVisible, `${fixtureId} root must be visible`).toBe(true)
    expect(shape.h1Count, `${fixtureId} must mount exactly one genuine route h1 in the DOM`).toBe(1)
    expect(shape.h1Text, `${fixtureId} route h1 must have an accessible name`).toHaveLength(1)
    expect(shape.h1Text[0], `${fixtureId} route h1 must not be empty`).not.toBe('')
    expect(shape.mainCount, `${fixtureId} must expose a main landmark`).toBeGreaterThanOrEqual(1)
    expect(shape.dialogCount, `${fixtureId}: visible dialog count`).toBe(
      shape.expectsDialog ? 1 : 0
    )
    for (const dialog of shape.dialogs) {
      expect(dialog.modal, `${fixtureId}: Dialog must be modal`).toBe('true')
      expect(dialog.name, `${fixtureId}: Dialog must resolve aria-labelledby`).not.toBe('')
      expect(dialog.titleCount, `${fixtureId}: Dialog must expose one visible title`).toBe(1)
      expect(dialog.titleTags, `${fixtureId}: Dialog title must be the Foundation h2`).toEqual([
        'H2',
      ])
      expect(
        dialog.descriptionCount,
        `${fixtureId}: Dialog must expose one visible description`
      ).toBe(1)
      expect(
        dialog.descriptionText[0],
        `${fixtureId}: Dialog description must not be empty`
      ).not.toBe('')
      expect(
        dialog.focusInside,
        `${fixtureId}: initial focus must be contained by Dialog (${JSON.stringify(dialog)})`
      ).toBe(true)
    }
    expect(
      shape.actionCount,
      `${fixtureId} must expose at least one reachable action`
    ).toBeGreaterThan(0)
  }

  async function assertNoOverflowAtAnyWidth(page) {
    const overflow = await page.evaluate((sel) => {
      const viewportWidth = document.documentElement.clientWidth
      const root = document.querySelector(sel)
      if (!root) return null
      const exposed = (element) => {
        if (element.getClientRects().length === 0) return false
        if (element.closest('[aria-hidden="true"], [inert], [hidden]')) return false
        const closedDetails = element.closest('details:not([open])')
        return !closedDetails || Boolean(element.closest('summary'))
      }
      let maxRight = root.getBoundingClientRect().right
      const outOfBounds = []
      const scrollContainerFor = (element) => {
        let parent = element.parentElement
        while (parent && parent !== root) {
          const style = getComputedStyle(parent)
          const rect = parent.getBoundingClientRect()
          if (
            ['auto', 'scroll'].includes(style.overflowX) &&
            parent.scrollWidth > parent.clientWidth + 0.5 &&
            rect.left >= -0.5 &&
            rect.right <= viewportWidth + 0.5
          ) {
            return parent
          }
          parent = parent.parentElement
        }
        return null
      }
      for (const element of root.querySelectorAll('*')) {
        if (!exposed(element)) continue
        const rect = element.getBoundingClientRect()
        const inScrollContainer = scrollContainerFor(element)
        if (inScrollContainer) {
          // The descendant is intentionally reachable by scrolling within an in-viewport
          // horizontal tab/strip scrollport. Do not treat its offscreen content as route overflow;
          // the scrollport itself was already measured and remains subject to the viewport bound.
          continue
        }
        maxRight = Math.max(maxRight, rect.right)
        if (rect.right > viewportWidth + 0.5) {
          // A tab strip is an intentional horizontal scroller at 200%: its tab labels may be
          // wider than the viewport, but the scrollport itself must remain fully reachable. This
          // exception is structural (computed overflow + measured scrollWidth + in-viewport
          // scrollport), so it cannot mask Crew's unbreakable grid content or a fixed dialog.
          outOfBounds.push({
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            right: rect.right,
            width: rect.width,
          })
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth,
        maxRight,
        outOfBounds: outOfBounds.slice(0, 12),
      }
    }, selector)
    expect(overflow, `${fixtureId} must remain mounted for geometry checks`).not.toBeNull()
    expect(
      overflow.scrollWidth,
      `${fixtureId}: documentElement horizontal overflow`
    ).toBeLessThanOrEqual(overflow.viewportWidth)
    expect(
      overflow.maxRight,
      `${fixtureId}: every visible descendant must fit the viewport`
    ).toBeLessThanOrEqual(overflow.viewportWidth + 0.5)
    expect(
      overflow.outOfBounds,
      `${fixtureId}: out-of-bounds descendants ${JSON.stringify(overflow.outOfBounds)}`
    ).toEqual([])
  }

  async function assertNoVerticalTextTrap(page) {
    const trapped = await page.evaluate((sel) => {
      const hits = []
      const exposed = (element) => {
        if (element.getClientRects().length === 0) return false
        if (element.closest('[aria-hidden="true"], [inert], [hidden]')) return false
        const closedDetails = element.closest('details:not([open])')
        return !closedDetails || Boolean(element.closest('summary'))
      }
      for (const element of document.querySelectorAll(`${sel} *`)) {
        if (!exposed(element)) continue
        const rect = element.getBoundingClientRect()
        if (rect.width > 0 && rect.width < 100 && rect.height > 150) {
          hits.push({
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            width: rect.width,
            height: rect.height,
          })
        }
      }
      return hits
    }, selector)
    expect(trapped, `${fixtureId}: no narrow/tall vertical text trap`).toEqual([])
  }

  async function assertNetworkLabels(page) {
    const expectedByState = CORE_NETWORK_LABELS[fixtureId]
    expect(expectedByState, `${fixtureId}: network label contract must be registered`).toBeDefined()
    const report = await page.evaluate(
      ({ sel, fixtureId: id }) => {
        const root = document.querySelector(sel)
        if (!root) return null
        const visible = (element) => {
          if (
            element.getClientRects().length === 0 ||
            element.closest('[aria-hidden="true"], [inert], [hidden]')
          ) {
            return false
          }
          const closedDetails = element.closest('details:not([open])')
          return !closedDetails || Boolean(element.closest('summary'))
        }
        const sections = [...root.querySelectorAll('[data-core-state]')].filter(
          (section) =>
            !section.hasAttribute('hidden') && section.getAttribute('aria-hidden') !== 'true'
        )
        return sections.map((section) => {
          const labels = [...section.querySelectorAll('.network-badge-label')]
          // Strategy's empty-plan state has no NetworkBadge yet; its visible provenance line is the
          // route's canonical Stellar identity. Keep this explicit selector state-scoped rather than
          // accepting arbitrary route textContent, so hidden atlas states cannot satisfy the guard.
          if (id === 'core-strategy') {
            labels.push(...section.querySelectorAll('.pc-provenance > span:first-child'))
          }
          return {
            state: section.getAttribute('data-core-state'),
            labels: [
              ...new Set(
                labels
                  .filter(visible)
                  .map((label) => label.textContent?.trim())
                  .filter(Boolean)
              ),
            ].sort(),
          }
        })
      },
      { sel: selector, fixtureId }
    )
    expect(report, `${fixtureId}: route must remain mounted for network checks`).not.toBeNull()
    expect(report, `${fixtureId}: exactly one atlas state must be exposed`).toHaveLength(1)
    const state = report[0].state
    const expected = expectedByState[state]
    expect(
      expected,
      `${fixtureId}/${state}: state network contract must be registered`
    ).toBeDefined()
    expect(
      report[0].labels,
      `${fixtureId}/${state}: visible NetworkBadge labels must match the real route contract`
    ).toEqual([...expected].sort())
  }

  async function assertKeyboardAndLiveRegions(page) {
    const report = await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      if (!root) return null
      const visible = (element) => {
        if (
          element.getClientRects().length === 0 ||
          element.closest('[aria-hidden="true"], [inert], [hidden]')
        ) {
          return false
        }
        const closedDetails = element.closest('details:not([open])')
        return !closedDetails || Boolean(element.closest('summary'))
      }
      const focusable = [
        ...root.querySelectorAll(
          'button, a[href], input, select, textarea, summary, [role="tab"], [tabindex]'
        ),
      ].filter((element) => {
        if (!visible(element) || element.hasAttribute('disabled')) return false
        return element.getAttribute('tabindex') !== '-1'
      })
      const focusFailures = []
      for (const element of focusable.slice(0, 16)) {
        element.focus()
        if (document.activeElement !== element && !element.contains(document.activeElement)) {
          focusFailures.push({
            tag: element.tagName,
            text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
          })
        }
      }
      const liveRegions = [...root.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
        .filter(visible)
        .map((element) => ({
          role: element.getAttribute('role'),
          live: element.getAttribute('aria-live'),
          text: element.textContent?.trim() || '',
        }))
      const transitionSignals = [
        ...root.querySelectorAll('[aria-busy="true"], [data-progress], [role="alert"]'),
      ].filter(visible)
      const liveFailures = liveRegions.filter(
        (region) =>
          !['status', 'alert'].includes(region.role) &&
          !['polite', 'assertive', 'off'].includes(region.live)
      )
      return {
        focusableCount: focusable.length,
        focusFailures,
        liveRegions,
        transitionSignals: transitionSignals.length,
        liveFailures,
      }
    }, selector)
    expect(report, `${fixtureId}: route must remain mounted for keyboard checks`).not.toBeNull()
    expect(
      report.focusableCount,
      `${fixtureId}: at least one keyboard-reachable control is required`
    ).toBeGreaterThan(0)
    expect(
      report.focusFailures,
      `${fixtureId}: visible controls must accept programmatic keyboard focus`
    ).toEqual([])
    expect(
      report.liveFailures,
      `${fixtureId}: live regions must expose an explicit live setting or status/alert semantics`
    ).toEqual([])
    if (report.transitionSignals > 0) {
      expect(
        report.liveRegions.length,
        `${fixtureId}: loading/error state changes must have an announced live region`
      ).toBeGreaterThan(0)
    }

    // This is intentionally a real browser keyboard event rather than another element.focus()
    // probe: it exercises the page's tab order and the Foundation dialog focus manager. Seed the
    // event from the first reachable control so a finite non-modal route is not judged by whether
    // Chromium chooses BODY after its last control; modal focus containment is checked separately.
    await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      const visible = (element) =>
        element.getClientRects().length > 0 &&
        !element.closest('[aria-hidden="true"], [inert], [hidden]')
      const first = [
        ...(root?.querySelectorAll(
          'button, a[href], input, select, textarea, summary, [role="tab"], [tabindex]'
        ) || []),
      ].find(
        (element) =>
          visible(element) &&
          !element.hasAttribute('disabled') &&
          element.getAttribute('tabindex') !== '-1'
      )
      first?.focus()
    }, selector)
    await page.keyboard.press('Tab')
    const tabResult = await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      const active = document.activeElement
      if (!root || !active) return null
      return {
        withinRoot: root.contains(active),
        visible: active.getClientRects().length > 0,
        tag: active.tagName,
        label: active.textContent?.trim() || active.getAttribute('aria-label') || '',
      }
    }, selector)
    expect(tabResult, `${fixtureId}: Tab must land on a real element`).not.toBeNull()
    if (['core-dialog', 'core-base-withdraw'].includes(fixtureId)) {
      expect(
        tabResult.withinRoot,
        `${fixtureId}: Tab must stay inside the modal route surface (${JSON.stringify(tabResult)})`
      ).toBe(true)
    }
    expect(tabResult.visible, `${fixtureId}: Tab target must be visible`).toBe(true)
    await page.evaluate(() => document.activeElement?.blur())
  }

  async function assertStickyActions(page) {
    const offenders = await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      if (!root) return null
      const viewportWidth = document.documentElement.clientWidth
      return [...root.querySelectorAll('*')]
        .filter((element) => {
          if (element.getClientRects().length === 0 || element.closest('[aria-hidden="true"]')) {
            return false
          }
          const style = getComputedStyle(element)
          if (!['fixed', 'sticky'].includes(style.position)) return false
          return (
            element.matches('button, a, [role="button"]') ||
            element.querySelector('button, a, [role="button"]')
          )
        })
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            className: typeof element.className === 'string' ? element.className : '',
            right: rect.right,
            left: rect.left,
            bottom: rect.bottom,
          }
        })
        .filter((rect) => rect.left < -0.5 || rect.right > viewportWidth + 0.5 || rect.bottom < 0)
    }, selector)
    expect(
      offenders,
      `${fixtureId}: sticky/fixed actions must stay in the visual viewport`
    ).not.toBeNull()
    expect(offenders, `${fixtureId}: sticky/fixed action geometry`).toEqual([])
  }

  async function assertCrewMotion(page, reducedMotion) {
    if (fixtureId !== 'core-crew') return
    const report = await page.evaluate(
      ({ sel, reduced }) => {
        const root = document.querySelector(sel)
        if (!root) return null
        return [...root.querySelectorAll('[data-core-state]')].map((section) => {
          const state = section.getAttribute('data-core-state')
          const sweep = section.querySelector('.pc-crew-radar-sweep')
          const guard = section.querySelector('.pc-crew-guard')
          return {
            state,
            phase: guard?.getAttribute('data-guard-phase') || null,
            animation: sweep ? getComputedStyle(sweep).animationName : null,
            activeClass: Boolean(sweep?.classList.contains('pc-crew-radar-sweep--active')),
            reduced,
          }
        })
      },
      { sel: selector, reduced: reducedMotion }
    )
    expect(report, 'core-crew: radar states must mount').not.toBeNull()
    expect(report, 'core-crew: every source state must expose one real radar').toHaveLength(6)
    for (const row of report) {
      const shouldAnimate =
        !reducedMotion && CORE_CREW_RADAR_MOTION.has(row.state) && row.phase === 'armed'
      if (row.animation === null) {
        expect(
          CORE_CREW_RADAR_ABSENT.has(row.state),
          `core-crew/${row.state}: absent radar is only valid for empty/unknown source states`
        ).toBe(true)
      } else {
        expect(row.animation, `core-crew/${row.state}: radar animation truth`).toBe(
          shouldAnimate ? 'pc-crew-sweep' : 'none'
        )
      }
      expect(row.activeClass, `core-crew/${row.state}: radar active class truth`).toBe(
        shouldAnimate
      )
    }
  }

  async function assertStyleGroups(page) {
    const groups = CORE_STYLE_GROUPS[fixtureId]
    expect(groups, `${fixtureId}: style groups must be registered`).toBeDefined()
    const report = await page.evaluate(
      ({ sel, styleGroups }) => {
        const root = document.querySelector(sel)
        if (!root) return null
        const visible = (element) =>
          element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]')
        const firstMatch = (selector) => {
          const candidates = root.matches(selector)
            ? [root, ...root.querySelectorAll(selector)]
            : [...root.querySelectorAll(selector)]
          return candidates.find(visible) || null
        }
        return styleGroups.map((group) => {
          const element = firstMatch(group.selector)
          if (!element) return { id: group.id, selector: group.selector, missing: true }
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            id: group.id,
            selector: group.selector,
            missing: false,
            viewportWidth: window.innerWidth,
            rect: { width: rect.width, height: rect.height, right: rect.right },
            computed: {
              display: style.display,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
              color: style.color,
              backgroundColor: style.backgroundColor,
              borderRadius: style.borderRadius,
              paddingLeft: style.paddingLeft,
              paddingRight: style.paddingRight,
            },
          }
        })
      },
      { sel: selector, styleGroups: groups }
    )
    expect(report, `${fixtureId}: style pass root must exist`).not.toBeNull()
    for (const row of report) {
      expect(
        row.missing,
        `${fixtureId}: missing style selector group ${row.id} (${row.selector})`
      ).toBe(false)
      expect(row.rect.width, `${fixtureId}/${row.id}: measured width`).toBeGreaterThan(0)
      expect(row.rect.height, `${fixtureId}/${row.id}: measured height`).toBeGreaterThan(0)
      expect(row.computed.fontFamily, `${fixtureId}/${row.id}: computed font`).not.toBe('')
      expect(
        parseFloat(row.computed.fontSize),
        `${fixtureId}/${row.id}: computed font size`
      ).toBeGreaterThan(0)
      const group = groups.find((candidate) => candidate.id === row.id)
      if (group.padding) {
        expect(
          parseFloat(row.computed.paddingLeft),
          `${fixtureId}/${row.id}: left token padding`
        ).toBeGreaterThan(0)
        expect(
          parseFloat(row.computed.paddingRight),
          `${fixtureId}/${row.id}: right token padding`
        ).toBeGreaterThan(0)
      }
      if (group.radius) {
        expect(row.computed.borderRadius, `${fixtureId}/${row.id}: canonical radius`).not.toBe(
          '0px'
        )
      }
      if (group.background) {
        expect(row.computed.backgroundColor, `${fixtureId}/${row.id}: canonical surface`).not.toBe(
          'rgba(0, 0, 0, 0)'
        )
      }
      if (group.display) {
        const expectedDisplay =
          group.mobileDisplay && row.viewportWidth <= 767 ? group.mobileDisplay : group.display
        expect(row.computed.display, `${fixtureId}/${row.id}: layout display`).toBe(expectedDisplay)
      }
    }

    // Positive mutation sensitivity: every assertion above must be attached to a live browser
    // node, not merely a selector that happens to parse. Mutate the actual asserted property for
    // each group, prove that its computed value changes, and restore the exact inline declaration
    // before the page can be used for a screenshot. A custom property would only prove that
    // getComputedStyle reflects arbitrary inline declarations; it would not catch a regression in
    // the radius/background/display/padding contract itself.
    const mutation = await page.evaluate(
      async ({ sel, styleGroups }) => {
        const root = document.querySelector(sel)
        const visible = (element) =>
          element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]')
        const finishTransitions = async (element) => {
          // Reduced motion deliberately keeps a 0.01ms transition instead of disabling motion
          // entirely. Force style resolution, then let that real transition finish before the
          // mutation probe reads or restores the asserted property.
          void getComputedStyle(element).opacity
          const transitions = element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.constructor?.name === 'CSSTransition')
          await Promise.allSettled(transitions.map((transition) => transition.finished))
        }
        const mutationFor = (group, style) => {
          if (group.padding) {
            const before = style.paddingLeft
            return {
              cssProperty: 'padding-left',
              computedProperty: 'paddingLeft',
              value: before === '1px' ? '2px' : '1px',
            }
          }
          if (group.radius) {
            const before = style.borderRadius
            return {
              cssProperty: 'border-radius',
              computedProperty: 'borderRadius',
              value: before === '0px' ? '1px' : '0px',
            }
          }
          if (group.background) {
            const before = style.backgroundColor
            return {
              cssProperty: 'background-color',
              computedProperty: 'backgroundColor',
              value: before === 'rgb(1, 2, 3)' ? 'rgb(2, 3, 4)' : 'rgb(1, 2, 3)',
            }
          }
          if (group.display) {
            const before = style.display
            return {
              cssProperty: 'display',
              computedProperty: 'display',
              value: before === 'block' ? 'inline-block' : 'block',
            }
          }
          const before = style.fontSize
          return {
            cssProperty: 'font-size',
            computedProperty: 'fontSize',
            value: before === '1px' ? '2px' : '1px',
          }
        }
        const results = []
        for (const group of styleGroups) {
          const candidates = root.matches(group.selector)
            ? [root, ...root.querySelectorAll(group.selector)]
            : [...root.querySelectorAll(group.selector)]
          const element = candidates.find(visible)
          if (!element) {
            results.push({ id: group.id, changed: false })
            continue
          }
          await finishTransitions(element)
          const style = getComputedStyle(element)
          const mutation = mutationFor(group, style)
          const prior = element.style.getPropertyValue(mutation.cssProperty)
          const priority = element.style.getPropertyPriority(mutation.cssProperty)
          const before = style[mutation.computedProperty]
          element.style.setProperty(mutation.cssProperty, mutation.value, 'important')
          await finishTransitions(element)
          const after = getComputedStyle(element)[mutation.computedProperty]
          if (prior) element.style.setProperty(mutation.cssProperty, prior, priority)
          else element.style.removeProperty(mutation.cssProperty)
          await finishTransitions(element)
          const restored = getComputedStyle(element)[mutation.computedProperty]
          results.push({
            id: group.id,
            property: mutation.cssProperty,
            before,
            after,
            restored,
            changed: before !== after,
            restoredExactly: restored === before,
          })
        }
        return results
      },
      { sel: selector, styleGroups: groups }
    )
    for (const row of mutation) {
      expect(
        row.changed,
        `${fixtureId}/${row.id}: asserted ${row.property} must be mutation-sensitive`
      ).toBe(true)
      expect(
        row.restoredExactly,
        `${fixtureId}/${row.id}: ${row.property} must restore before capture (${row.before} -> ${row.restored})`
      ).toBe(true)
    }
  }

  async function assertCoreZoomReflow(page) {
    // The Core contract uses a 640px layout viewport plus CSS zoom=2 so the browser exercises
    // both responsive geometry and the actual enlarged paint surface.  Keep the descendant
    // right-edge check below: scrollWidth alone can hide a canvas or fixed panel that paints past
    // the viewport.
    await page.setViewportSize({ width: 640, height: 1000 })
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2'
    })
    try {
      await page.waitForFunction(() => document.fonts.status === 'loaded')
      // Deep-link hashes (Settings' Base mandate tab and dialog callers) are useful for the source
      // state sweeps but must not turn the initial zoom assertion into an anchor-position test.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await assertNoOverflowAtAnyWidth(page)
      const zoomReport = await page.evaluate((sel) => {
        const root = document.querySelector(sel)
        if (!root) return null
        const viewportWidth = document.documentElement.clientWidth
        const viewportHeight = window.innerHeight
        const exposed = (element) => {
          if (
            element.getClientRects().length === 0 ||
            element.closest('[aria-hidden="true"], [inert], [hidden]')
          ) {
            return false
          }
          const closedDetails = element.closest('details:not([open])')
          return !closedDetails || Boolean(element.closest('summary'))
        }
        const rectFor = (element) => {
          const rect = element.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
        }
        const horizontalScrollContainerFor = (element) => {
          let parent = element.parentElement
          while (parent && parent !== root) {
            const style = getComputedStyle(parent)
            if (
              ['auto', 'scroll'].includes(style.overflowX) &&
              parent.scrollWidth > parent.clientWidth + 0.5
            ) {
              return parent
            }
            parent = parent.parentElement
          }
          return null
        }
        const candidates = [
          ...root.querySelectorAll(
            'h1, h2, [role="status"], [role="alert"], button, a[href], input, select, textarea'
          ),
        ].filter((element) => exposed(element) && !element.hasAttribute('disabled'))
        const initialTargets = []
        const dialog = [...root.querySelectorAll('.pc-dialog')].find(exposed)
        const panel = dialog?.querySelector('.pc-dialog-panel')
        if (panel) panel.scrollTop = 0
        const initialTitle = dialog?.querySelector('.pc-dialog-title') || root.querySelector('h1')
        for (const element of [panel, initialTitle].filter(Boolean)) {
          if (exposed(element)) initialTargets.push({ element, rect: rectFor(element) })
        }
        const initialFailures = initialTargets
          .filter(
            ({ rect }) =>
              rect.left < -0.5 ||
              rect.right > viewportWidth + 0.5 ||
              rect.top < -0.5 ||
              rect.bottom > viewportHeight + 0.5
          )
          .map(({ element, rect }) => ({
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            rect,
          }))

        // Check every scrollport at both ends. Fixed dialogs often lock the page itself, so the
        // panel's own scrollport is included instead of exempting all dialog descendants.
        const scrollports = [document.scrollingElement, ...root.querySelectorAll('*')]
          .filter((element, index, all) => element && all.indexOf(element) === index)
          .filter((element) => {
            if (element === document.scrollingElement) {
              return element.scrollHeight > element.clientHeight + 0.5
            }
            const style = getComputedStyle(element)
            return (
              ['auto', 'scroll'].includes(style.overflowY) &&
              element.scrollHeight > element.clientHeight + 0.5
            )
          })
        const scrollFailures = []
        for (const scrollport of scrollports) {
          const isDocument = scrollport === document.scrollingElement
          const max = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
          if (isDocument) window.scrollTo({ top: 0, behavior: 'instant' })
          else scrollport.scrollTop = 0
          const top = isDocument ? window.scrollY : scrollport.scrollTop
          if (top > 0.5) {
            scrollFailures.push({
              type: 'top',
              className:
                typeof scrollport.className === 'string' ? scrollport.className : 'document',
              offset: top,
            })
          }
          if (isDocument) window.scrollTo({ top: max, behavior: 'instant' })
          else scrollport.scrollTop = max
          const bottom = isDocument ? window.scrollY : scrollport.scrollTop
          if (max > 0.5 && bottom < max - 0.5) {
            scrollFailures.push({
              type: 'bottom',
              className:
                typeof scrollport.className === 'string' ? scrollport.className : 'document',
              offset: bottom,
              max,
            })
          }
        }

        // Reset all scrollports before the per-element sweep. Every heading/status/action must be
        // reachable by scrolling the nearest real scrollport; fixed-dialog geometry is never an
        // excuse to skip an offscreen target.
        window.scrollTo({ top: 0, behavior: 'instant' })
        for (const scrollport of scrollports) {
          if (scrollport !== document.scrollingElement) scrollport.scrollTop = 0
        }
        const rightEdgeFailures = []
        const unreachable = []
        const overlapFailures = []
        const stickyActions = [...root.querySelectorAll('*')].filter((element) => {
          if (!exposed(element)) return false
          const style = getComputedStyle(element)
          if (!['fixed', 'sticky'].includes(style.position)) return false
          if (element.matches('.pc-dialog, .pc-dialog-panel')) return false
          return (
            element.matches('button, a, [role="button"]') ||
            element.matches('[class*="action"], [class*="footer"]') ||
            element.querySelector('button, a, [role="button"]')
          )
        })
        for (const element of candidates) {
          const before = rectFor(element)
          if (before.right > viewportWidth + 0.5 && !horizontalScrollContainerFor(element)) {
            rightEdgeFailures.push({
              tag: element.tagName,
              text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
              rect: before,
            })
          }
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          if ('focus' in element && element.matches('button, a[href], input, select, textarea')) {
            element.focus({ preventScroll: true })
          }
          const after = rectFor(element)
          if (
            after.left < -0.5 ||
            after.right > viewportWidth + 0.5 ||
            after.top < -0.5 ||
            after.bottom > viewportHeight + 0.5
          ) {
            unreachable.push({
              tag: element.tagName,
              text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
              rect: after,
            })
          }
          for (const sticky of stickyActions) {
            if (sticky === element || sticky.contains(element) || element.contains(sticky)) continue
            const stickyRect = sticky.getBoundingClientRect()
            const overlaps =
              after.left < stickyRect.right &&
              after.right > stickyRect.left &&
              after.top < stickyRect.bottom &&
              after.bottom > stickyRect.top
            if (overlaps) {
              overlapFailures.push({
                target: element.textContent?.trim() || element.getAttribute('aria-label') || '',
                sticky: typeof sticky.className === 'string' ? sticky.className : '',
              })
            }
          }
        }
        const documentOverflow = {
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth,
        }
        return {
          viewportWidth,
          viewportHeight,
          candidateCount: candidates.length,
          initialFailures,
          rightEdgeFailures,
          unreachable,
          scrollFailures,
          overlapFailures,
          documentOverflow,
          initial: initialTargets.map(({ element, rect }) => ({
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            rect,
          })),
        }
      }, selector)
      expect(zoomReport, `${fixtureId}: zoom report must mount the real route`).not.toBeNull()
      expect(
        zoomReport.candidateCount,
        `${fixtureId}: zoom must expose reachable content`
      ).toBeGreaterThan(0)
      expect(
        zoomReport.initialFailures,
        `${fixtureId}: initial title/panel must fit 200% viewport`
      ).toEqual([])
      expect(
        zoomReport.rightEdgeFailures,
        `${fixtureId}: every target right edge must fit`
      ).toEqual([])
      expect(
        zoomReport.unreachable,
        `${fixtureId}: every heading/status/action must be reachable at 200%`
      ).toEqual([])
      expect(
        zoomReport.scrollFailures,
        `${fixtureId}: scrollports must reach top and bottom`
      ).toEqual([])
      expect(
        zoomReport.overlapFailures,
        `${fixtureId}: sticky actions must not cover focused content at 200%`
      ).toEqual([])
      expect(
        zoomReport.documentOverflow.scrollWidth,
        `${fixtureId}: document overflow at 200%`
      ).toBeLessThanOrEqual(zoomReport.documentOverflow.viewportWidth + 0.5)
    } finally {
      await page.evaluate(() => {
        document.documentElement.style.zoom = ''
      })
    }
  }

  return {
    assertMountedAndLandmarked,
    assertNoOverflowAtAnyWidth,
    assertNoVerticalTextTrap,
    assertNetworkLabels,
    assertKeyboardAndLiveRegions,
    assertStickyActions,
    assertCrewMotion,
    assertStyleGroups,
    assertCoreZoomReflow,
  }
}

// Functional parity is deliberately separate from pixel snapshots.  In particular, the
// reduced Day Field run must prove that motion preferences do not remove a state, action, label,
// or focusable control.  It is kept as one small route signature rather than a second screenshot
// matrix, so WEB-12 remains exactly twelve image cells per Core class.
async function coreFunctionalSignature(page, fixtureId) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return null
    const visible = (element) => {
      if (
        element.getClientRects().length === 0 ||
        element.closest('[aria-hidden="true"], [inert], [hidden]')
      ) {
        return false
      }
      const closedDetails = element.closest('details:not([open])')
      return !closedDetails || Boolean(element.closest('summary'))
    }
    return {
      headings: [...root.querySelectorAll('h1, h2')]
        .filter(visible)
        .map((element) => element.textContent?.trim()),
      statuses: [...root.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
        .filter(visible)
        .map((element) => element.textContent?.trim()),
      actions: [...root.querySelectorAll('button, a, input, select, textarea')]
        .filter(visible)
        .map((element) => ({
          tag: element.tagName,
          text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
          disabled: element.hasAttribute('disabled'),
        })),
      focusOrder: [
        ...root.querySelectorAll(
          'button, a[href], input, select, textarea, summary, [role="tab"], [tabindex]'
        ),
      ]
        .filter(
          (element) =>
            visible(element) &&
            !element.hasAttribute('disabled') &&
            element.getAttribute('tabindex') !== '-1'
        )
        .map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || ''),
      liveRegions: [...root.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
        .filter(visible)
        .map((element) => ({
          role: element.getAttribute('role'),
          live: element.getAttribute('aria-live'),
          text: element.textContent?.trim() || '',
        })),
      networkText:
        [...root.querySelectorAll('body, [role="main"], main')]
          .map((element) => element.textContent || '')
          .join(' ')
          .match(/Stellar testnet|Base Sepolia|Unknown network/gu)
          ?.sort() || [],
    }
  }, coreFixtureSelector(fixtureId))
}

for (const core of CORE_FIXTURE_CLASSES) {
  test.describe(core.title, () => {
    const guards = makeCoreFixtureGuards(core.id)

    for (const variant of CORE_CAPTURE_VARIANTS) {
      test(`${core.label} -- ${variant.title}`, async ({ page }, testInfo) => {
        expect(CORE_PROJECT_NAMES).toContain(testInfo.project.name)
        if (variant.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(coreFixtureUrl(core.id, variant.theme))
        await waitForCoreFixture(page, core.id)
        await guards.assertMountedAndLandmarked(page)
        await guards.assertNoOverflowAtAnyWidth(page)
        await guards.assertNoVerticalTextTrap(page)
        await guards.assertNetworkLabels(page)
        await guards.assertKeyboardAndLiveRegions(page)
        await guards.assertStickyActions(page)
        await guards.assertStyleGroups(page)
        await expect(page).toHaveScreenshot(`${core.id}-${variant.name}.png`, { fullPage: true })
      })
    }

    test(`${core.label} -- reduced Day Field preserves functional surface`, async ({ page }) => {
      await page.goto(coreFixtureUrl(core.id, 'day-field'))
      await waitForCoreFixture(page, core.id)
      const normal = await coreFunctionalSignature(page, core.id)
      expect(normal, `${core.id}: normal Day Field fixture must mount`).not.toBeNull()

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.reload()
      await waitForCoreFixture(page, core.id)
      const reduced = await coreFunctionalSignature(page, core.id)
      expect(reduced, `${core.id}: reduced Day Field fixture must mount`).not.toBeNull()
      expect(reduced).toEqual(normal)
    })

    test(`${core.label} -- 200 percent zoom reflows without clipping`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'desktop-1440',
        'one deterministic desktop 200% zoom sweep per fixture'
      )
      await page.goto(coreFixtureUrl(core.id, 'forest'))
      await waitForCoreFixture(page, core.id)
      await guards.assertCoreZoomReflow(page)
    })
  })
}

// Functional-only Core matrix.  This loop intentionally has no screenshot assertion and its test
// titles carry the exact `core` grep token, so the required gate exercises every class/theme/width
// guard independently of whether a caller requested baseline updates.
test.describe('Pocket Crew Core functional guard matrix', () => {
  for (const core of CORE_FIXTURE_CLASSES) {
    const guards = makeCoreFixtureGuards(core.id)
    for (const variant of CORE_CAPTURE_VARIANTS) {
      test(`${core.id} core functional guard -- ${variant.name}`, async ({ page }, testInfo) => {
        expect(CORE_PROJECT_NAMES).toContain(testInfo.project.name)
        if (variant.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(coreFixtureUrl(core.id, variant.theme))
        await waitForCoreFixture(page, core.id)
        await guards.assertMountedAndLandmarked(page)
        await guards.assertNoOverflowAtAnyWidth(page)
        await guards.assertNoVerticalTextTrap(page)
        await guards.assertNetworkLabels(page)
        await guards.assertKeyboardAndLiveRegions(page)
        await guards.assertStickyActions(page)
        await guards.assertCrewMotion(page, variant.reducedMotion)
      })
    }
  }
})

// Keep the browser style pass independently runnable from snapshot generation.  This is the
// evidence gate for I1; it must remain useful while the 72 PNG baselines are intentionally absent
// during fixture review.
test.describe('Pocket Crew Core browser style contract', () => {
  for (const fixture of CORE_FIXTURE_CLASSES) {
    test(`${fixture.id} exposes every canonical selector group`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'one real-Chromium style pass')
      // CAP16's default plan-edit state is intentionally exercised by the source-state sweep
      // below. Use the independent withdraw caller for this style-only contract so a missing
      // Plan fixture read cannot hide whether Foundation's real dialog primitives are styled.
      const styleState = fixture.id === 'core-dialog' ? 'withdraw' : undefined
      await page.goto(coreFixtureUrl(fixture.id, 'forest', styleState))
      await waitForCoreFixture(page, fixture.id)
      await makeCoreFixtureGuards(fixture.id).assertStyleGroups(page)
    })
  }
})

test.describe('Pocket Crew Core dialog geometry', () => {
  for (const fixtureId of ['core-dialog', 'core-base-withdraw']) {
    test(`${fixtureId} keeps Dialog within the visual viewport`, async ({ page }, testInfo) => {
      await page.goto(coreFixtureUrl(fixtureId, 'forest'))
      await waitForCoreFixture(page, fixtureId)
      const dialog = page.locator(`${coreFixtureSelector(fixtureId)} .pc-dialog-panel`).first()
      await expect(dialog, `${fixtureId}: real Foundation Dialog must be mounted`).toBeVisible()
      const geometry = await dialog.evaluate((panel) => {
        const rect = panel.getBoundingClientRect()
        const style = getComputedStyle(panel)
        return {
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
          maxWidth: style.maxWidth,
          maxHeight: style.maxHeight,
        }
      })
      expect(geometry.right).toBeLessThanOrEqual(testInfo.project.use.viewport.width + 0.5)
      expect(geometry.bottom).toBeLessThanOrEqual(testInfo.project.use.viewport.height + 0.5)
      if (testInfo.project.name === 'desktop-1440') {
        expect(geometry.width, `${fixtureId}: desktop Dialog width`).toBeLessThanOrEqual(480.5)
      }
      if (testInfo.project.name === 'mobile-320' || testInfo.project.name === 'mobile-360') {
        expect(geometry.height, `${fixtureId}: mobile sheet height`).toBeLessThanOrEqual(
          testInfo.project.use.viewport.height * 0.88 + 0.5
        )
      }
    })
  }
})

test.describe('Pocket Crew Core dialog caller states', () => {
  const states = [
    'plan-edit',
    'plan-reset',
    'withdraw',
    'stop-access',
    'recovery',
    'settings-clear',
    'invalid',
    'submitting',
    'confirmed',
    'failed',
    'unknown',
  ]
  for (const state of states) {
    test(`core-dialog mounts the real ${state} caller`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'one source-state caller sweep')
      await page.goto(coreFixtureUrl('core-dialog', 'forest', state))
      await waitForCoreFixture(page, 'core-dialog')
      const section = page.locator(`[data-fixture="core-dialog"] [data-core-state="${state}"]`)
      await expect(section, `core-dialog ${state} atlas section must mount`).toBeVisible()
      await expect(
        section.locator('.pc-dialog-panel').first(),
        `core-dialog ${state} must expose the real Foundation dialog`
      ).toBeVisible()
    })
  }
})

test.describe('Pocket Crew Core Settings deep-link states', () => {
  const states = [
    'default',
    'wallet',
    'mandate-ready',
    'mandate-missing',
    'mandate-expired',
    'mandate-revoked',
    'mandate-disconnected',
    'mandate-unavailable',
    'mandate-busy',
  ]
  for (const state of states) {
    test(`core-settings selects the real ${state} source view`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'one source-state Settings sweep')
      await page.goto(coreFixtureUrl('core-settings', 'forest', state))
      await waitForCoreFixture(page, 'core-settings')
      const section = page.locator(`[data-fixture="core-settings"] [data-core-state="${state}"]`)
      await expect(section, `core-settings ${state} atlas section must mount`).toBeVisible()
      await expect(section.locator('.pc-settings').first()).toBeVisible()
      await expect(section.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1)
    })
  }

  test('core-settings tabs activate through real Tab and Space input', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'one keyboard tab interaction sweep')
    await page.goto(coreFixtureUrl('core-settings', 'forest', 'default'))
    await waitForCoreFixture(page, 'core-settings')
    const tabs = page.locator('[data-fixture="core-settings"] [role="tab"]')
    const first = tabs.first()
    await first.focus()
    await page.keyboard.press('Tab')
    const focusedLabel = await page.evaluate(
      () => document.activeElement?.textContent?.trim() || ''
    )
    expect(focusedLabel, 'Tab should advance to the next Settings tab').toBe('Strategy')
    await page.keyboard.press('Space')
    await expect(tabs.filter({ hasText: 'Strategy' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Pocket Crew Core Base withdrawal states', () => {
  const states = [
    'idle',
    'submitting',
    'relaying',
    'polling',
    'confirmed',
    'failed',
    'submission-unknown',
    'in-transit',
  ]
  for (const state of states) {
    test(`core-base-withdraw mounts the real ${state} seam state`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'one deterministic CAP-18 state sweep')
      await page.goto(coreFixtureUrl('core-base-withdraw', 'forest', state))
      await waitForCoreFixture(page, 'core-base-withdraw')
      const section = page.locator(
        `[data-fixture="core-base-withdraw"] [data-core-state="${state}"]`
      )
      await expect(section, `core-base-withdraw ${state} atlas section must mount`).toBeVisible()
      await expect(section.locator('.pc-dialog-panel').first()).toBeVisible()
    })
  }
})

test.describe('Pocket Crew Core crew motion truth', () => {
  test('armed Guard sweep is the only moving radar in normal motion', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'one computed-motion check')
    await page.goto(coreFixtureUrl('core-crew', 'forest'))
    await waitForCoreFixture(page, 'core-crew')
    const sweep = page
      .locator('[data-fixture="core-crew"] [data-guard-phase="armed"] .pc-crew-radar-sweep')
      .first()
    await expect(sweep, 'the armed Core crew atlas must expose its real Guard sweep').toBeVisible()
    await expect(sweep).toHaveCSS('animation-name', 'pc-crew-sweep')

    const normalPhases = await page
      .locator('[data-fixture="core-crew"] [data-core-state] .pc-crew-radar-sweep')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          phase: node.closest('.pc-crew-guard')?.getAttribute('data-guard-phase'),
          animation: getComputedStyle(node).animationName,
        }))
      )
    for (const row of normalPhases) {
      expect(
        row.animation,
        `${row.phase} radar must be static unless its real Guard phase is armed`
      ).toBe(row.phase === 'armed' ? 'pc-crew-sweep' : 'none')
    }

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedAnimations = await page
      .locator('[data-fixture="core-crew"] [data-core-state] .pc-crew-radar-sweep')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName))
    expect(reducedAnimations, 'reduced motion must pause every Core crew radar').toEqual(
      Array.from({ length: reducedAnimations.length }, () => 'none')
    )
  })
})

test('canonical foundation atlas loads', async ({ page }) => {
  await page.goto('/visual/?fixture=foundation&theme=forest')

  await expect(page.getByRole('heading', { name: 'Pocket Crew foundation atlas' })).toBeVisible()
})

// Foundation Task 10 -- frozen baselines for the deterministic `foundation` fixture. Snapshot
// names resolve through playwright.config.js's snapshotPathTemplate to the twelve exact files
// `foundation-{variant}-{projectName}.png` across the four configured viewport projects.
test.describe('Pocket Crew foundation', () => {
  const { assertNoOverflowAtMobileWidth, assertNoVerticalTextTrap } =
    makeFixtureGuards('foundation')

  test('forest theme', async ({ page }, testInfo) => {
    await page.goto('/visual/?fixture=foundation&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('foundation-forest.png', { fullPage: true })
  })

  test('day-field theme', async ({ page }, testInfo) => {
    await page.goto('/visual/?fixture=foundation&theme=day-field')
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
    await expect(page).toHaveScreenshot('foundation-day-field.png', { fullPage: true })
  })

  test('motion-safe forest theme', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/visual/?fixture=foundation&theme=forest')
    await page.evaluate(() => document.fonts.ready)
    await assertNoOverflowAtMobileWidth(page, testInfo)
    await assertNoVerticalTextTrap(page, testInfo)
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
test.describe('Pocket Crew legacy Strategy', () => {
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

  test('motion-safe forest theme', async ({ page }, testInfo) => {
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
test.describe('Pocket Crew legacy My money', () => {
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
test.describe('Pocket Crew legacy crew', () => {
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
      return {
        cards: cards.map((card) => ({
          id: card.dataset.personaId,
          children: card.querySelectorAll('[data-child-address]').length,
        })),
        amountTexts: [...(firstRoute?.querySelectorAll('.pc-crew-amount-list li') || [])].map(
          (row) => row.textContent
        ),
      }
    })
    expect(shape.cards).toEqual([
      { id: 'sprout', children: 2 },
      { id: 'clover', children: 0 },
      { id: 'mochi', children: 0 },
    ])
    expect(shape.amountTexts).toContain('17014118346046923173168730371588.4105727 USDC')
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

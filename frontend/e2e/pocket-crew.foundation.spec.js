import { expect, test } from '@playwright/test'

const FOUNDATION_URL = (theme) => `/visual/?fixture=foundation&theme=${theme}`

async function openFoundation(page, theme) {
  await page.goto(FOUNDATION_URL(theme))
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('[data-fixture="foundation"]')).toBeVisible()
}

async function measureOverflow(page) {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    const descendants = [...document.querySelectorAll('[data-fixture="foundation"] *')]
    const rightmost = descendants.reduce(
      (right, element) => Math.max(right, element.getBoundingClientRect().right),
      0
    )
    return {
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      rightmost,
    }
  })
}

async function expectNoOverflow(page) {
  const measured = await measureOverflow(page)
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.viewport)
  expect(measured.rightmost).toBeLessThanOrEqual(measured.viewport + 0.5)
}

test.describe('Pocket Crew foundation acceptance', () => {
  test('320px has no overflow and wraps long display values locally', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-320', 'CAP-01 320px geometry')
    await openFoundation(page, 'forest')
    await expectNoOverflow(page)

    const longValue = page.locator('.pc-foundation-atlas-long-value').first()
    const geometry = await longValue.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      }
    })
    expect(geometry.width).toBeLessThanOrEqual(288)
    expect(geometry.height).toBeGreaterThan(geometry.lineHeight)
  })

  test('768px uses compact shell geometry and 44px controls', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'tablet-768', 'CAP-01 tablet geometry')
    await openFoundation(page, 'forest')
    const geometry = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector('[data-foundation-sidebar]')).width,
      topbar: getComputedStyle(document.querySelector('[data-foundation-topbar]')).height,
      controls: [...document.querySelectorAll('.pc-foundation-atlas-control')].map(
        (element) => element.getBoundingClientRect().height
      ),
    }))
    expect(geometry.sidebar).toBe('80px')
    expect(geometry.topbar).toBe('64px')
    expect(geometry.controls.every((height) => height >= 44)).toBe(true)
    await expectNoOverflow(page)
  })

  test('1440px uses expanded 248px sidebar and 64px top bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'CAP-01 desktop geometry')
    await openFoundation(page, 'forest')
    const geometry = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector('[data-foundation-sidebar]')).width,
      topbar: getComputedStyle(document.querySelector('[data-foundation-topbar]')).height,
    }))
    expect(geometry.sidebar).toBe('248px')
    expect(geometry.topbar).toBe('64px')
    await expectNoOverflow(page)
  })

  test('Dialog traps focus, closes on Escape, and restores the trigger', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-320', 'CAP-01 dialog interaction')
    await openFoundation(page, 'forest')
    const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
    await trigger.focus()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Foundation evidence dialog' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('Dialog isolates background siblings and restores body scroll and attributes', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-320', 'CAP-01 dialog isolation')
    await openFoundation(page, 'forest')
    const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
    const baselineBodyStyle = await page.evaluate(() => document.body.getAttribute('style'))
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Foundation evidence dialog' })
    await expect(dialog).toBeVisible()

    const openState = await page.evaluate(() => {
      const node = document.querySelector('dialog, [role="dialog"]')
      const background = []
      let pathNode = node
      let parent = node?.parentElement
      while (parent) {
        for (const sibling of parent.children) {
          if (sibling !== pathNode) background.push(sibling)
        }
        if (parent === document.body) break
        pathNode = parent
        parent = parent.parentElement
      }
      return {
        native: node instanceof HTMLDialogElement,
        bodyOverflow: document.body.style.overflow,
        everySiblingInert: background.every((element) => element.hasAttribute('inert')),
        everySiblingHidden: background.every(
          (element) => element.getAttribute('aria-hidden') === 'true'
        ),
        dialogInert: node?.hasAttribute('inert'),
        dialogHidden: node?.hasAttribute('aria-hidden'),
      }
    })

    expect(openState.native).toBe(true)
    expect(openState.bodyOverflow).toBe('hidden')
    expect(openState.everySiblingInert).toBe(true)
    expect(openState.everySiblingHidden).toBe(true)
    expect(openState.dialogInert).toBe(false)
    expect(openState.dialogHidden).toBe(false)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    const closedState = await page.evaluate(() => ({
      bodyStyle: document.body.getAttribute('style'),
      triggerInert: document
        .querySelector('[data-foundation-section="Dialog"] button')
        ?.hasAttribute('inert'),
      triggerHidden: document
        .querySelector('[data-foundation-section="Dialog"] button')
        ?.hasAttribute('aria-hidden'),
    }))
    expect(closedState.bodyStyle).toBe(baselineBodyStyle)
    expect(closedState.triggerInert).toBe(false)
    expect(closedState.triggerHidden).toBe(false)
  })

  test('native Dialog closes before isolation release and opener focus restoration', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-320', 'CAP-01 native dialog lifecycle')
    await openFoundation(page, 'forest')
    const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
    const baselineBodyStyle = await page.evaluate(() => document.body.getAttribute('style'))
    await trigger.click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible()

    await page.evaluate(() => {
      const events = []
      const originalClose = HTMLDialogElement.prototype.close
      HTMLDialogElement.prototype.close = function patchedClose(...args) {
        events.push({
          type: 'native-close',
          bodyStyle: document.body.getAttribute('style'),
          bodyOverflow: document.body.style.overflow,
        })
        const result = originalClose.apply(this, args)
        events.push({
          type: 'native-close-return',
          bodyStyle: document.body.getAttribute('style'),
          bodyOverflow: document.body.style.overflow,
        })
        return result
      }
      const opener = document.querySelector('[data-foundation-section="Dialog"] button')
      const onFocusIn = (event) => {
        if (event.target !== opener) return
        events.push({
          type: 'opener-focus',
          bodyStyle: document.body.getAttribute('style'),
          bodyOverflow: document.body.style.overflow,
        })
      }
      document.addEventListener('focusin', onFocusIn)
      window.__pocketCrewDialogLifecycle = {
        events,
        restore() {
          HTMLDialogElement.prototype.close = originalClose
          document.removeEventListener('focusin', onFocusIn)
        },
      }
    })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    const events = await page.evaluate(() => window.__pocketCrewDialogLifecycle.events)
    const nativeCloseIndex = events.findIndex((event) => event.type === 'native-close')
    const openerFocusIndex = events.findIndex((event) => event.type === 'opener-focus')
    expect(nativeCloseIndex).toBeGreaterThanOrEqual(0)
    expect(openerFocusIndex).toBeGreaterThan(nativeCloseIndex)
    expect(events[nativeCloseIndex].bodyOverflow).toBe('hidden')
    expect(events[openerFocusIndex].bodyStyle).toBe(baselineBodyStyle)
    await page.evaluate(() => window.__pocketCrewDialogLifecycle.restore())
  })

  test('Dialog keeps forward and reverse Tab focus inside the panel', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-320', 'CAP-01 dialog focus containment')
    await openFoundation(page, 'forest')
    const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
    await trigger.click()
    const close = page.getByRole('button', { name: 'Close dialog' })
    await expect(close).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(close).toBeFocused()
  })

  test('reduced motion keeps immediate durations in Forest and Day Field', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'CAP-01 reduced-motion contract')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const theme of ['forest', 'day-field']) {
      await openFoundation(page, theme)
      const durations = await page.evaluate(() => {
        const atlas = document.querySelector('.pc-foundation-atlas')
        const control = document.querySelector('.pc-foundation-atlas-control')
        const style = getComputedStyle(atlas)
        const controlStyle = getComputedStyle(control)
        return {
          transitionMs:
            Number.parseFloat(style.transitionDuration) *
            (style.transitionDuration.endsWith('s') ? 1000 : 1),
          animationMs:
            Number.parseFloat(style.animationDuration) *
            (style.animationDuration.endsWith('s') ? 1000 : 1),
          controlTransitionMs:
            Number.parseFloat(controlStyle.transitionDuration) *
            (controlStyle.transitionDuration.endsWith('s') ? 1000 : 1),
        }
      })
      expect(durations.transitionMs).toBeCloseTo(0.01, 5)
      expect(durations.animationMs).toBeCloseTo(0.01, 5)
      expect(durations.controlTransitionMs).toBeCloseTo(0.01, 5)

      const details = page.locator('details').first()
      await expect(details).toHaveAttribute('open', '')
      await details.locator('summary').click()
      await expect(details).not.toHaveAttribute('open', '')
      await details.locator('summary').click()
      await expect(details).toHaveAttribute('open', '')

      const liveRegion = page.locator('[aria-live="polite"]')
      await expect(liveRegion).toContainText('Confirmed')
      await page.getByRole('button', { name: 'Show stale status' }).click()
      await expect(page.locator('[data-fixture="foundation"]')).toHaveAttribute(
        'data-foundation-state',
        'stale'
      )
      await expect(liveRegion).toContainText('Stale')

      const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
      await trigger.click()
      const close = page.getByRole('button', { name: 'Close dialog' })
      await expect(close).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  })

  test('200% browser zoom reflows both themes, keeps focus visible, wraps values, and keeps sheet actions reachable', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'tablet-768', 'CAP-01 zoom/reflow matrix')
    // Playwright viewports are CSS pixels. A 768x1024 tablet viewport viewed at 200% has a
    // 384x512 CSS layout viewport. Halving both dimensions exercises real breakpoint/reflow at a
    // still-usable >=320px width without CDP pinch/page-scale emulation (which changes visual
    // scale, not CSS layout). The measured innerWidth/innerHeight below are the assertion bounds.
    const zoomedViewport = { width: 384, height: 512 }
    await page.setViewportSize(zoomedViewport)

    for (const theme of ['forest', 'day-field']) {
      await openFoundation(page, theme)
      await expectNoOverflow(page)

      const focusableCount = await page.locator('a[href], button, summary').count()
      for (let index = 0; index < focusableCount; index += 1) {
        await page.keyboard.press('Tab')
        const focus = await page.evaluate(() => {
          const element = document.activeElement
          if (!element || !element.matches('a[href], button, summary')) return null
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        })
        expect(focus).not.toBeNull()
        expect(focus.left).toBeGreaterThanOrEqual(-0.5)
        const layoutViewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }))
        expect(focus.right).toBeLessThanOrEqual(layoutViewport.width + 0.5)
        expect(focus.top).toBeGreaterThanOrEqual(-0.5)
        expect(focus.bottom).toBeLessThanOrEqual(layoutViewport.height + 0.5)
      }

      const longValue = await page
        .locator('.pc-foundation-atlas-long-value')
        .first()
        .evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            width: rect.width,
            height: rect.height,
            lineHeight: Number.parseFloat(style.lineHeight),
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
          }
        })
      const layoutViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(longValue.width).toBeLessThanOrEqual(layoutViewport.width)
      expect(longValue.height).toBeGreaterThan(longValue.lineHeight)
      expect(longValue.overflowWrap).toBe('anywhere')
      expect(longValue.wordBreak).toBe('break-word')

      const trigger = page.getByRole('button', { name: 'Open evidence dialog' })
      await trigger.click()
      const sheet = page.locator('.pc-dialog-panel')
      const sheetGeometry = await sheet.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { bottom: rect.bottom, viewport: innerHeight, paddingBottom: style.paddingBottom }
      })
      expect(sheetGeometry.bottom).toBeLessThanOrEqual(sheetGeometry.viewport + 0.5)
      expect(sheetGeometry.paddingBottom).not.toBe('0px')
      await page.keyboard.press('Escape')
    }
  })
})

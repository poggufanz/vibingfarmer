import { expect, test } from '@playwright/test'

// This is intentionally isolated from pocket-crew.visual.spec.js.  It exercises the real CAP18
// production Dialog caller at the mandated zoom and does not alter the shared atlas guards.
test.describe('Foundation Dialog zoom reflow', () => {
  test('keeps the initial title and end-of-scroll actions reachable at 200% zoom', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-1440',
      'one deterministic 640x1000 real-Chromium Dialog regression'
    )

    await page.setViewportSize({ width: 640, height: 1000 })
    await page.goto('/visual/?fixture=core-base-withdraw&theme=forest&state=idle')
    const dialog = page.locator(
      '[data-fixture="core-base-withdraw"] [data-core-state="idle"] .pc-dialog'
    )
    const panel = dialog.locator('.pc-dialog-panel')
    await expect(panel).toBeVisible()
    await page.waitForFunction(() => document.fonts.status === 'loaded')

    await page.evaluate(() => {
      document.documentElement.style.zoom = '2'
    })

    const measure = async () =>
      panel.evaluate((panelElement) => {
        const dialogElement = panelElement.closest('.pc-dialog')
        const title = panelElement.querySelector('.pc-dialog-title')
        const actions = panelElement.querySelector('.pc-dialog-actions')
        const panelRect = panelElement.getBoundingClientRect()
        const titleRect = title?.getBoundingClientRect()
        const actionsRect = actions?.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const mode = [...(dialogElement?.classList || [])].find((name) =>
          name.startsWith('pc-dialog--')
        )
        return {
          mode,
          viewport: { width: viewportWidth, height: viewportHeight },
          panel: {
            left: panelRect.left,
            top: panelRect.top,
            right: panelRect.right,
            bottom: panelRect.bottom,
            clientHeight: panelElement.clientHeight,
            scrollHeight: panelElement.scrollHeight,
            scrollTop: panelElement.scrollTop,
            overflowY: getComputedStyle(panelElement).overflowY,
            maxHeight: getComputedStyle(panelElement).maxHeight,
          },
          title: titleRect
            ? { top: titleRect.top, bottom: titleRect.bottom, right: titleRect.right }
            : null,
          actions: actionsRect
            ? { top: actionsRect.top, bottom: actionsRect.bottom, right: actionsRect.right }
            : null,
          actionCount: actions?.querySelectorAll('button, a').length || 0,
        }
      })

    await panel.evaluate((panelElement) => {
      panelElement.scrollTop = 0
    })
    const initial = await measure()
    expect(initial.mode).toBe('pc-dialog--auto')
    expect(initial.panel.overflowY).toBe('auto')
    expect(initial.panel.scrollHeight).toBeGreaterThan(initial.panel.clientHeight)
    expect(initial.panel.left).toBeGreaterThanOrEqual(-0.5)
    expect(initial.panel.top).toBeGreaterThanOrEqual(-0.5)
    expect(initial.panel.right).toBeLessThanOrEqual(initial.viewport.width + 0.5)
    expect(initial.panel.bottom).toBeLessThanOrEqual(initial.viewport.height + 0.5)
    expect(initial.title?.top).toBeGreaterThanOrEqual(-0.5)
    expect(initial.title?.bottom).toBeLessThanOrEqual(initial.viewport.height + 0.5)

    await panel.evaluate((panelElement) => {
      panelElement.scrollTop = panelElement.scrollHeight
    })
    await expect.poll(async () => (await measure()).panel.scrollTop).toBeGreaterThan(0)
    const atEnd = await measure()
    expect(atEnd.actions?.top).toBeGreaterThanOrEqual(-0.5)
    expect(atEnd.actions?.bottom).toBeLessThanOrEqual(atEnd.viewport.height + 0.5)
    expect(atEnd.actions?.right).toBeLessThanOrEqual(atEnd.viewport.width + 0.5)
    expect(atEnd.actionCount).toBeGreaterThan(0)

    // The real CAP18 caller is Foundation's default `auto` mode.  The explicit `sheet` and
    // `dialog` modes share the same production panel and cascade; toggle only the mode class in
    // this browser probe and repeat the reachability assertions against the same mounted panel.
    for (const mode of ['sheet', 'dialog']) {
      await dialog.evaluate((dialogElement, nextMode) => {
        dialogElement.classList.remove('pc-dialog--auto', 'pc-dialog--sheet', 'pc-dialog--dialog')
        dialogElement.classList.add(`pc-dialog--${nextMode}`)
      }, mode)
      await panel.evaluate((panelElement) => {
        panelElement.scrollTop = 0
      })
      const modeInitial = await measure()
      expect(modeInitial.mode).toBe(`pc-dialog--${mode}`)
      expect(modeInitial.panel.overflowY).toBe('auto')
      expect(modeInitial.panel.scrollHeight).toBeGreaterThan(modeInitial.panel.clientHeight)
      expect(modeInitial.panel.left).toBeGreaterThanOrEqual(-0.5)
      expect(modeInitial.panel.top).toBeGreaterThanOrEqual(-0.5)
      expect(modeInitial.panel.right).toBeLessThanOrEqual(modeInitial.viewport.width + 0.5)
      expect(modeInitial.panel.bottom).toBeLessThanOrEqual(modeInitial.viewport.height + 0.5)
      expect(modeInitial.title?.top).toBeGreaterThanOrEqual(-0.5)
      expect(modeInitial.title?.bottom).toBeLessThanOrEqual(modeInitial.viewport.height + 0.5)

      await panel.evaluate((panelElement) => {
        panelElement.scrollTop = panelElement.scrollHeight
      })
      await expect.poll(async () => (await measure()).panel.scrollTop).toBeGreaterThan(0)
      const modeAtEnd = await measure()
      expect(modeAtEnd.actions?.top).toBeGreaterThanOrEqual(-0.5)
      expect(modeAtEnd.actions?.bottom).toBeLessThanOrEqual(modeAtEnd.viewport.height + 0.5)
      expect(modeAtEnd.actions?.right).toBeLessThanOrEqual(modeAtEnd.viewport.width + 0.5)
      expect(modeAtEnd.actionCount).toBeGreaterThan(0)
    }

    await dialog.evaluate((dialogElement) => {
      dialogElement.classList.remove('pc-dialog--sheet', 'pc-dialog--dialog')
      dialogElement.classList.add('pc-dialog--auto')
    })
  })
})

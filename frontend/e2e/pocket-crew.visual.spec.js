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

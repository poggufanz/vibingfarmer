import process from 'node:process'

const runningInVitest = process.env.VITEST === 'true'
const { expect, test } = runningInVitest ? await import('vitest') : await import('@playwright/test')
const visualTest = runningInVitest ? test.skip : test

visualTest('visual harness loads', async ({ page }) => {
  await page.goto('/visual/?fixture=foundation&theme=forest')

  await expect(page.getByRole('heading', { name: 'Pocket Crew visual harness' })).toBeVisible()
})

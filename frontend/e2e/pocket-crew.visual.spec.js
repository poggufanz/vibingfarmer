import { expect, test } from '@playwright/test'

test('visual harness loads', async ({ page }) => {
  await page.goto('/visual/?fixture=foundation&theme=forest')

  await expect(page.getByRole('heading', { name: 'Pocket Crew visual harness' })).toBeVisible()
})

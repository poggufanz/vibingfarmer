import { defineConfig } from '@playwright/test'
import process from 'node:process'

const projects = [
  ['mobile-320', 320, 800],
  ['mobile-360', 360, 800],
  ['tablet-768', 768, 1024],
  ['desktop-1440', 1440, 1000],
]

export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
  },
  webServer: {
    command: 'vite dev --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/visual/',
    reuseExistingServer: !process.env.CI,
  },
  projects: projects.map(([name, width, height]) => ({
    name,
    use: {
      viewport: { width, height },
    },
  })),
})

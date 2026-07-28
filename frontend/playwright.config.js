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
  forbidOnly: Boolean(process.env.CI),
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    // Fix round 1 -- I-1 (reviewer finding): PlanStage.jsx's Intl.DateTimeFormat/RelativeTimeFormat
    // (Strategy Task 14 fix loop, item 4) renders through the runtime's locale/timezone, which this
    // config never pinned -- the frozen "Expires ..." baselines rendered whatever TZ/locale
    // happened to be on the machine that froze them (measured: Jakarta/en-US "4:00 PM" vs UTC/en-US
    // "9:00 AM" vs de-DE "in 1 Stunde (15.01.2027, 16:00)" -- same code, three different glyph runs
    // and widths). Same determinism class visual/main.jsx's own Date.now() freeze already exists to
    // guard against; pinning both here closes it for real time-of-day/locale formatting the same
    // way that freeze closes it for elapsed time.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    command: 'vite dev --host 127.0.0.1 --port 4173 --strictPort',
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

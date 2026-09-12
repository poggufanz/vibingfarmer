import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const cssPath = path.resolve(process.cwd(), 'src/components/settings/settings.css')

const OWNED_CLASSES = [
  '.pc-settings',
  '.pc-settings-header',
  '.pc-settings-title',
  '.pc-settings-tabs',
  '.pc-settings-tab',
  '.pc-settings-tab--active',
  '.pc-settings-scroll',
  '.pc-settings-content',
  '.pc-settings-section',
  '.pc-settings-eyebrow',
  '.pc-settings-card',
  '.pc-settings-divider',
  '.pc-settings-label',
  '.pc-settings-row',
  '.pc-settings-row-copy',
  '.pc-settings-row-control',
  '.pc-settings-toggle',
  '.pc-settings-toggle-option',
  '.pc-settings-radio',
  '.pc-settings-number',
  '.pc-settings-api-key',
  '.pc-settings-contract-row',
  '.pc-settings-data-row',
  '.pc-settings-confirm',
  '.pc-settings-about',
  '.pc-settings-manager',
]

describe('Settings route CSS contract', () => {
  it('owns every route class with Pocket Crew tokenized presentation', async () => {
    const css = await readFile(cssPath, 'utf8')
    for (const className of OWNED_CLASSES) expect(css).toContain(className)
    expect(css).toMatch(/var\(--pc-[^)]+\)/)
    expect(css).not.toMatch(/gradient|glow|shimmer|keyframes|animation/i)
    expect(css).not.toMatch(/z-index\s*:\s*\d/)
  })

  it('keeps settings layout responsive without introducing raw visual layers', async () => {
    const css = await readFile(cssPath, 'utf8')
    expect(css).toMatch(/@media\s*\([^)]*max-width/i)
    expect(css).toMatch(/border-radius:\s*var\(--pc-/)
    expect(css).toMatch(/color:\s*var\(--pc-/)
    expect(css).toMatch(/background(?:-color)?:\s*var\(--pc-/)
  })

  it('preserves the Pocket Crew focus geometry and contrasting guard ring', async () => {
    const css = await readFile(cssPath, 'utf8')
    expect(css).toMatch(/outline:\s*3px solid var\(--pc-focus\)/)
    expect(css).toMatch(/outline-offset:\s*3px/)
    expect(css).toMatch(/box-shadow:\s*0 0 0 5px var\(--pc-focus-contrast\)/)
  })
})

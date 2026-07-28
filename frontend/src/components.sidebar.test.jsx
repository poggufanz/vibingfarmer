// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Sidebar, TopBar } from './components.jsx'

afterEach(cleanup)

// Strategy Task 14 fix loop N -- owner report item 10 (app shell top bar, not Strategy's own
// files). jsdom draws no layout/cascade-paint at all, so a real Chromium binary is launched here,
// the same technique PlanStage.test.jsx's own G1/item-1/2/5/9 guards already use in this repo.
const here = path.dirname(fileURLToPath(import.meta.url))
// style.css ships with a leading UTF-8 BOM (harmless for the real app -- Vite serves it as an
// external stylesheet, and browsers strip a BOM during charset detection for those). Concatenated
// as raw text into an INLINE <style> tag for this synthetic harness, that BOM becomes a literal
// stray character before the first rule and silently broke the whole `:root` block's custom
// properties in a real Chromium parse (measured: `--bg-base`/`--text-muted` both read back as ''
// with the BOM present, resolving correctly once stripped) -- a test-harness embedding hazard,
// not a production defect, so the fix is here, not in the shipped file.
const LEGACY_STYLESHEET = fs
  .readFileSync(path.resolve(here, '../style.css'), 'utf8')
  .replace(/^\uFEFF/, '')
const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

async function launchRealChromium() {
  const { chromium } = await import('playwright-core')
  let lastErr
  for (const executablePath of CHROMIUM_CANDIDATES) {
    if (executablePath && !fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`item 10 contrast guard: no usable Chromium binary found (${lastErr?.message})`)
}

function contrastFromRgb(rgbA, rgbB) {
  const toLum = (rgbStr) => {
    const [r, g, b] = rgbStr.match(/[\d.]+/g).map(Number)
    const lin = (c) => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const l1 = toLum(rgbA)
  const l2 = toLum(rgbB)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Sidebar', () => {
  it('keeps collapse state and current-page semantics available to assistive technology', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended={false} onToggle={onToggle} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: 'My money' }).getAttribute('aria-current')).toBe(
      'page'
    )
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(onToggle).toHaveBeenCalledOnce()

    rerender(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={onToggle} />
      </MemoryRouter>
    )
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('renders the "Put it to work" label routing to /strategy, current when active', () => {
    render(
      <MemoryRouter initialEntries={['/strategy']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    const item = screen.getByRole('button', { name: 'Put it to work' })
    expect(item.getAttribute('aria-current')).toBe('page')
  })

  it('navigates to /strategy when "Put it to work" is activated', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Put it to work' }))
    // aria-current flips to the newly active item once React Router's location updates.
    expect(
      screen.getByRole('button', { name: 'Put it to work' }).getAttribute('aria-current')
    ).toBe('page')
  })

  it('renders the "The crew" label routing to /agent, current when active', () => {
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    const item = screen.getByRole('button', { name: 'The crew' })
    expect(item.getAttribute('aria-current')).toBe('page')
  })

  it('navigates to /agent when "The crew" is activated', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'The crew' }))
    expect(screen.getByRole('button', { name: 'The crew' }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  // Task 10 (IA remap) -- brief's own Step 1 test, plus the zero-count/absence side.
  it('renders the pocket-crew sidebar labels with the crew badge', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} agentCount={3} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: /my money/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /put it to work/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /the crew/i }).textContent).toContain('3')
    expect(screen.queryByRole('button', { name: /new deposit/i })).toBeNull()
  })

  // Fix round 1, F6: the count must be announced as part of the BUTTON's own accessible name --
  // a bare aria-label on the descendant <span> is never read (an author aria-label on the button
  // wins the accname computation over all descendant content), and the digit itself is
  // aria-hidden so it is never announced twice.
  it('folds the active-agent count into the crew button\'s own accessible name, and hides the digit from assistive tech', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} agentCount={3} />
      </MemoryRouter>
    )
    const crew = screen.getByRole('button', { name: 'The crew, 3 active' })
    expect(crew.querySelector('.sb-badge').getAttribute('aria-hidden')).toBe('true')
  })

  it('renders no badge on "The crew" when there are zero active agents', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} agentCount={0} />
      </MemoryRouter>
    )
    const crew = screen.getByRole('button', { name: /the crew/i })
    expect(crew.querySelector('.sb-badge')).toBeNull()
    expect(crew.textContent).not.toMatch(/\d/)
  })

  it('no longer renders the retired inline logo image / old labels', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    expect(document.querySelector('img[src="/vibing_farmer.logo.svg"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Strategy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dashboard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New deposit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull()
  })

  it('renders a compact BrandLockup for the sidebar mark', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    expect(container.querySelector('.pc-brand-lockup--compact')).toBeTruthy()
  })
})

describe('TopBar', () => {
  const baseProps = { onReset: () => {}, railCollapsed: false, onToggleRail: () => {} }

  it('renders a NetworkBadge with the visible "Stellar testnet" label', () => {
    render(<TopBar {...baseProps} />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
  })

  it('renders the brand as a BrandLockup', () => {
    const { container } = render(<TopBar {...baseProps} />)
    expect(container.querySelector('.pc-brand-lockup')).toBeTruthy()
  })

  it('renames the flow-restart icon button so it never collides with the Sidebar\'s "New deposit" navigation label', () => {
    const onReset = vi.fn()
    render(<TopBar {...baseProps} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'New deposit' })).toBeNull()
    const startOver = screen.getByRole('button', { name: 'Start over' })
    fireEvent.click(startOver)
    expect(onReset).toHaveBeenCalledOnce()
  })

  it(
    // Fix round 1 (reviewer finding): style.css defines --text-muted/--bg-canvas in FOUR palettes
    // (:root default + [data-palette='mono-slate'/'liquid-mint'/'bone-paper']) -- this guard only
    // ever renders the default :root palette, so the title says so rather than implying full
    // palette coverage it doesn't have.
    'item 10 (owner report), :root palette only: "Relayer fee-bump, user gas 0" reads at >=4.5:1 ' +
      "against the bar's real painted background, measured in a real Chromium layout engine",
    async () => {
      const { container } = render(<TopBar {...baseProps} />)
      const browser = await launchRealChromium()
      try {
        const page = await browser.newPage()
        // Real ancestor chain (app.jsx): `.app` > `main.main` > `.topbar` -- `.topbar` itself
        // paints no background (only a border-bottom), so the bar's real painted background comes
        // from `.main` (`background: var(--bg-canvas)`), not the outer `.app`/`--bg-base`.
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${LEGACY_STYLESHEET}</style></head>` +
            `<body><div class="app sb-minimized"><main class="main">${container.innerHTML}</main></div></body></html>`
        )
        const { color, background } = await page.evaluate(() => {
          const meta = document.querySelector('.topbar-meta')
          let el = meta
          let bg = 'rgba(0, 0, 0, 0)'
          while (el) {
            const c = getComputedStyle(el).backgroundColor
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
              bg = c
              break
            }
            el = el.parentElement
          }
          return { color: getComputedStyle(meta).color, background: bg }
        })
        expect(contrastFromRgb(color, background)).toBeGreaterThanOrEqual(4.5)
      } finally {
        await browser.close()
      }
    },
    20000
  )
})

// frontend/src/components/HomePage.pocket.test.jsx
// My Money Task 13 (Pocket Crew redesign, Wave 5), Step 4. `/home` is reduced to a compact
// launcher -- these tests prove the shrink actually happened (no independent APY math, market
// pulse, withdraw, Base recovery, agent controls, or protection controls survive), that exactly
// one freshness-labeled summary/connection entry renders alongside the two required links, and
// (rejection-checklist item 12) that the new `.pc-route` layout has no horizontal scroll at 320px
// and stays within the 1240px desktop content cap at 1440px -- the same real-Chromium
// playwright-core technique StrategyRoute.test.jsx / MyMoneyRoute.test.jsx already use, because
// jsdom never runs layout.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import HomePage from './HomePage.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amount(units, decimals = 7, token = 'USDC') {
  return { token, units: String(units), decimals }
}

describe('HomePage — disconnected', () => {
  it('shows a connection entry and Connect wallet, plus both required links', () => {
    const onConnect = vi.fn()
    render(
      <HomePage
        userAddress={null}
        onConnect={onConnect}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    expect(screen.getByText('Not connected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    expect(onConnect).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'New deposit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My money' })).toBeTruthy()
  })
})

describe('HomePage — connected: exactly one freshness-labeled summary entry', () => {
  it('current state renders the label and total in ONE status entry, plus last confirmed', () => {
    render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{
          state: 'current',
          total: amount(1_234_560_0000n),
          lastConfirmed: 10_000,
        }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].textContent).toMatch(/Current/)
    expect(statuses[0].textContent).toMatch(/1234\.56|1,234\.56/)
    expect(statuses[0].textContent).toMatch(/confirmed/)
  })

  // Rejection-checklist item 4: Rice (the `.pc-dominant--owned` surface below) must never hold
  // unconfirmed money without an ADJACENT stale/unknown state -- proves the freshness word and the
  // figure are the SAME entry, not a number rendered on its own with staleness buried elsewhere.
  it('stale state labels the SAME line "Stale", never a bare number', () => {
    render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{ state: 'stale', total: amount(500_0000000n), lastConfirmed: 10_000 }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    expect(screen.getByRole('status').textContent).toMatch(/Stale/)
  })

  it('unavailable/loading/problem states never fabricate a total', () => {
    for (const state of ['loading', 'unavailable', 'problem', 'empty', 'partial-discovery']) {
      const { unmount } = render(
        <HomePage
          userAddress="GUSER"
          moneyProjection={{ state, total: null, lastConfirmed: null }}
          onStartStrategy={vi.fn()}
          onOpenAgent={vi.fn()}
        />
      )
      const status = screen.getByRole('status')
      expect(status.textContent).not.toMatch(/undefined|NaN|\$0\.00/)
      unmount()
    }
  })

  it('an unrecognized/garbage state string degrades to Unavailable, never a raw dump', () => {
    render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{ state: 'not-a-real-state', total: null, lastConfirmed: null }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    expect(screen.getByRole('status').textContent).toMatch(/Unavailable/)
  })

  it('missing moneyProjection entirely still renders Unavailable, not a crash', () => {
    render(<HomePage userAddress="GUSER" onStartStrategy={vi.fn()} onOpenAgent={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toMatch(/Unavailable/)
  })
})

describe('HomePage — navigation links', () => {
  it('New deposit calls onStartStrategy, My money calls onOpenAgent', () => {
    const onStartStrategy = vi.fn()
    const onOpenAgent = vi.fn()
    render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{ state: 'current', total: null, lastConfirmed: null }}
        onStartStrategy={onStartStrategy}
        onOpenAgent={onOpenAgent}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'New deposit' }))
    expect(onStartStrategy).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'My money' }))
    expect(onOpenAgent).toHaveBeenCalledOnce()
  })
})

describe('HomePage — no independent portfolio surfaces survive (Step 4)', () => {
  it('renders none of the retired market/APY/withdraw/Base/agent-control affordances', () => {
    render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{ state: 'current', total: amount(100_0000000n), lastConfirmed: 1 }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    // Market Pulse / vault table / sort-filter chrome
    expect(screen.queryByText(/Market Pulse/i)).toBeNull()
    expect(screen.queryByText(/Stablecoin avg APY/i)).toBeNull()
    expect(screen.queryByText(/Top Movers/i)).toBeNull()
    // Yield estimator
    expect(screen.queryByText(/Projected Yearly Yield/i)).toBeNull()
    // Withdraw / agent controls
    expect(screen.queryByRole('button', { name: /withdraw/i })).toBeNull()
    expect(screen.queryByText(/Monitoring|Stopped/)).toBeNull()
    // Base recovery / positions
    expect(screen.queryByText(/Recover Base positions/i)).toBeNull()
    expect(screen.queryByText(/Base positions/i)).toBeNull()
    // Vault protection copy (that's MyMoneyRoute's VaultProtection section, not Home's)
    expect(screen.queryByText(/vault protection/i)).toBeNull()
  })

  it('never imports the retired data modules (defiLlama/apyHistory/sparkline/positionsStore)', () => {
    const src = fs.readFileSync(path.resolve(here, './HomePage.jsx'), 'utf8')
    expect(src).not.toMatch(/defiLlama|apyHistory|sparkline|positionsStore|WithdrawModal/i)
  })

  it('accepts no basePositions/scopes/positions/alerts props at all (source-level -- Step 4 forbids a second model)', () => {
    const src = fs.readFileSync(path.resolve(here, './HomePage.jsx'), 'utf8')
    // Checks the DESTRUCTURED PROP NAMES in the component signature specifically -- not prose
    // (this file's own header comment legitimately says "active-positions" while explaining what
    // was retired).
    const signature = src.slice(
      src.indexOf('export default function HomePage('),
      src.indexOf(') {')
    )
    expect(signature).not.toMatch(
      /basePositions|onBaseWithdraw|onBaseRecover|\bscopes\b|\bpositions\b|\balerts\b|\bvaultMeta\b/
    )
  })
})

describe('HomePage — accessibility', () => {
  it('has no obvious axe violations, connected and disconnected', async () => {
    const { container: disconnected } = render(<HomePage userAddress={null} onConnect={vi.fn()} />)
    expect(await axe(disconnected)).toHaveNoViolations()
    cleanup()
    const { container: connected } = render(
      <HomePage
        userAddress="GUSER"
        moneyProjection={{ state: 'current', total: amount(1_0000000n), lastConfirmed: 1 }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    )
    expect(await axe(connected)).toHaveNoViolations()
  })
})

// Rejection-checklist item 12 (real-browser layout guard -- jsdom never runs layout, so
// scrollWidth/bounding-rect widths are inert there; mirrors StrategyRoute.test.jsx's own harness).
// Home is deliberately NOT on the `.pc-route`/pocket-crew.css contract (see HomePage.jsx's own
// header comment) -- only the pre-existing LEGACY stylesheet is loaded here, matching what Home
// actually renders against in production (main.jsx loads both globally; pocket-crew.css has no
// rule this component's markup uses).
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
</head><body>${bodyHtml}</body></html>`
}

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
  throw new Error(`Home layout guard: no usable Chromium binary found (${lastErr?.message})`)
}

async function measureHomeAt(bodyHtml) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setContent(buildLayoutHarnessHtml(bodyHtml))
    await page.setViewportSize({ width: 320, height: 900 })
    const scrollWidth320 = await page.evaluate(() => document.documentElement.scrollWidth)
    await page.setViewportSize({ width: 1440, height: 900 })
    // `.home-shell` is Home's own pre-existing content wrapper (maxWidth: 820, unchanged by this
    // task) -- not the pocket-crew `.pc-route-stack`/1240px token, since Home isn't on that
    // contract (see HomePage.jsx's header comment). 820px is well inside the 1240px cap that would
    // apply if it were.
    const homeContentWidth1440 = await page.evaluate(() => {
      const el = document.querySelector('.home-shell')
      return el.getBoundingClientRect().width
    })
    return { scrollWidth320, homeContentWidth1440 }
  } finally {
    await browser.close()
  }
}

describe('HomePage — item 12 (rejection checklist): 320px no overflow, bounded desktop width', () => {
  const STATES = {
    disconnected: <HomePage userAddress={null} onConnect={vi.fn()} />,
    connected: (
      <HomePage
        userAddress="GUSER"
        moneyProjection={{
          state: 'current',
          total: amount(1_234_560_0000n),
          lastConfirmed: 10_000,
        }}
        onStartStrategy={vi.fn()}
        onOpenAgent={vi.fn()}
      />
    ),
  }
  for (const [label, el] of Object.entries(STATES)) {
    it(`${label}: 320px creates no horizontal scroll and content stays at its own 820px cap at 1440px`, async () => {
      const { container } = render(el)
      const { scrollWidth320, homeContentWidth1440 } = await measureHomeAt(container.innerHTML)
      expect(scrollWidth320).toBe(320)
      expect(homeContentWidth1440).toBeLessThanOrEqual(1240) // well inside the pocket-crew cap too
      expect(homeContentWidth1440).toBeCloseTo(820, 0)
    }, 20000)
  }
})

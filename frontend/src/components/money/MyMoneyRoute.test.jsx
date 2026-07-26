// frontend/src/components/money/MyMoneyRoute.test.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). MyMoneyRoute is the /agent route's composition
// root -- this file is the ONE place that exercises the full six-section hierarchy end to end
// (VaultProtection/HowMoneyWorks/TechnicalMoneyDetails have no dedicated test file per the brief's
// Files list; their assertions live here), plus the rejection-checklist verdicts and the real-
// browser 320px/1440px layout guards across every route state this task builds.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { MyMoneyRoute } from './MyMoneyRoute.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const NOW = 10_000_000_000

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

function baseModel(overrides = {}) {
  return {
    state: 'current',
    owner: 'GOWNER',
    confirmedTotal: { state: 'known', amount: amt(500_0000000n) },
    yield: { state: 'live', apy: 8.2 },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: { 'stellar-vault': '5000000000' },
    agentCount: 2,
    problemAgentCount: 0,
    freshness: 'current',
    checkedAt: NOW,
    confirmedLedger: null,
    confirmedBlock: null,
    source: null,
    problemAgents: [],
    protection: {
      state: 'armed',
      authority: 'GOWNER',
      mandateExpiry: NOW / 1000 + 100000,
      urgentRenewal: false,
      ownerIsAuthority: true,
    },
    automation: null,
    hasKnownVaultMoney: true,
    ...overrides,
  }
}

function stellarVaultAgent(address = 'CAGENT1', units = 300_0000000n) {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true } },
    vaultShares: { state: 'known', amount: amt(units) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(units),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

function splitAgent(address = 'CBRIDGE1') {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true } },
    vaultShares: { state: 'known', amount: amt(30_0000000n) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(50_0000000n),
    executionStatus: 'succeeded',
    custody: { location: 'unknown' },
    custodyBreakdown: [
      { location: 'stellar-vault', amount: amt(30_0000000n) },
      { location: 'base-proxy', amount: amt(20_0000000n) },
    ],
    problems: [],
  }
}

function revokedFundedAgent(address = 'CREVOKED1') {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: true, expiry: 0, authorized: true } },
    vaultShares: { state: 'known', amount: amt(0n) },
    idleToken: { state: 'known', amount: amt(50_0000000n) },
    amount: amt(50_0000000n),
    executionStatus: 'idle',
    custody: { location: 'agent' },
    custodyBreakdown: [],
    problems: ['scope-revoked'],
  }
}

const SECTION_HEADINGS = [
  'Your money',
  'Your position',
  'Your agent team',
  'Vault protection',
  'How your money is working',
  'Technical details',
]

describe('MyMoneyRoute — heading and exact hierarchy order (Step 2)', () => {
  it('renders the literal "My money" h1', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[stellarVaultAgent()]} />)
    expect(screen.getByRole('heading', { level: 1, name: 'My money' })).toBeTruthy()
  })

  it('renders exactly the six approved section headings, in the approved order, no more no less', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[stellarVaultAgent()]} />)
    const h2s = [...document.querySelectorAll('h2')].map((el) => el.textContent)
    expect(h2s).toEqual(SECTION_HEADINGS)
  })
})

describe('MyMoneyRoute — checklist item 1: no 3+ equal rounded cards', () => {
  it('has exactly ONE dominant rounded surface (the Rice hero), not a wall of equal cards', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[stellarVaultAgent(), revokedFundedAgent()]} />)
    expect(document.querySelectorAll('.pc-dominant').length).toBe(1)
    expect(document.querySelector('.pc-dominant--owned')).toBeTruthy()
  })
})

describe('MyMoneyRoute — checklist item 4: Rice never holds unconfirmed money without an adjacent stale/unknown state', () => {
  it('a stale total inside Rice carries its own visible stale flag', () => {
    render(<MyMoneyRoute model={baseModel({ state: 'stale', freshness: 'stale' })} agents={[stellarVaultAgent()]} />)
    const rice = document.querySelector('.pc-dominant--owned')
    expect(within(rice).getByText('(stale)')).toBeTruthy()
  })

  it('an unavailable total inside Rice renders the literal Unavailable marker, never a bare number', () => {
    const model = baseModel({ state: 'unavailable', confirmedTotal: null, freshness: 'unavailable' })
    render(<MyMoneyRoute model={model} agents={[]} />)
    const rice = document.querySelector('.pc-dominant--owned')
    expect(within(rice).getByText('Unavailable')).toBeTruthy()
  })

  it('a disconnected total inside Rice renders the literal Unavailable marker', () => {
    const model = baseModel({ state: 'disconnected', owner: null, confirmedTotal: null })
    render(<MyMoneyRoute model={model} agents={[]} />)
    const rice = document.querySelector('.pc-dominant--owned')
    expect(within(rice).getByText('Unavailable')).toBeTruthy()
  })
})

describe('MyMoneyRoute — Vault protection is Vault-wide and gates renewal to the configured authority', () => {
  it('states the literal "Vault-wide" fact', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[]} />)
    expect(screen.getByText(/Vault-wide/)).toBeTruthy()
  })

  it('shows Renew vault protection only when the connected owner IS the configured authority', () => {
    const model = baseModel({
      protection: { state: 'armed', authority: 'GOWNER', mandateExpiry: NOW / 1000 + 10, urgentRenewal: true, ownerIsAuthority: true },
    })
    render(<MyMoneyRoute model={model} agents={[]} onRenewProtection={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Renew vault protection' })).toBeTruthy()
  })

  it('never offers renewal when the connected owner is NOT the configured authority, even while urgent', () => {
    const model = baseModel({
      protection: { state: 'armed', authority: 'GSOMEONEELSE', mandateExpiry: NOW / 1000 + 10, urgentRenewal: true, ownerIsAuthority: false },
    })
    render(<MyMoneyRoute model={model} agents={[]} />)
    expect(screen.queryByRole('button', { name: 'Renew vault protection' })).toBeNull()
    expect(screen.getByText(/only the configured authority/)).toBeTruthy()
  })
})

describe('MyMoneyRoute — recoverable funded/revoked agent stays visible end to end', () => {
  it('shows Needs recovery for a revoked-funded agent inside the full route composition', () => {
    render(<MyMoneyRoute model={baseModel({ problemAgents: ['CREVOKED1'] })} agents={[stellarVaultAgent(), revokedFundedAgent('CREVOKED1')]} />)
    expect(screen.getByText('Needs recovery')).toBeTruthy()
    // Address shows up in both the position row and the agent-team row -- both are real, expected.
    expect(screen.getAllByText('CREVOKED1').length).toBeGreaterThanOrEqual(1)
  })
})

describe('MyMoneyRoute — mixed Stellar/Base custody', () => {
  it('shows the Stellar position, the nested Base child, and the agent team row together', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[splitAgent('CBRIDGE1')]} />)
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
    expect(screen.getAllByText('CBRIDGE1').length).toBeGreaterThanOrEqual(1) // position row + agent team row
  })
})

describe('MyMoneyRoute — DOM lists contain every position/agent before the optional graph disclosure', () => {
  it('renders the full position list and agent list before the graph disclosure appears in the DOM', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[stellarVaultAgent(), splitAgent('CBRIDGE1')]} />)
    const positionList = document.querySelector('ul.pc-position-list')
    const crewList = document.querySelector('ul.pc-crew-list')
    const graphDisclosure = screen.getByText('Agent network graph (advanced)').closest('details')
    expect(positionList).toBeTruthy()
    expect(crewList).toBeTruthy()
    expect(graphDisclosure).toBeTruthy()
    // DOCUMENT_POSITION_FOLLOWING: the graph disclosure comes AFTER both real lists.
    expect(positionList.compareDocumentPosition(graphDisclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(crewList.compareDocumentPosition(graphDisclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The graph disclosure never REPLACES the lists -- both still have real rows.
    expect(positionList.querySelectorAll(':scope > li').length).toBeGreaterThan(0)
    expect(crewList.querySelectorAll(':scope > li').length).toBeGreaterThan(0)
  })
})

describe('MyMoneyRoute — action-pending state', () => {
  it('disables the primary action and never fires it twice while pending', () => {
    const onAction = vi.fn()
    render(<MyMoneyRoute model={baseModel()} agents={[]} onAction={onAction} actionPending />)
    const btn = screen.getByRole('button', { name: /Working…/ })
    fireEvent.click(btn)
    expect(onAction).not.toHaveBeenCalled()
  })
})

describe('MyMoneyRoute — authoritative empty and loading never show a coerced zero', () => {
  it('empty: shows the friendly No balance yet text, not a bare 0', () => {
    render(<MyMoneyRoute model={baseModel({ state: 'empty', confirmedTotal: { state: 'known', amount: amt(0n) } })} agents={[]} />)
    expect(screen.getByText('No balance yet')).toBeTruthy()
    expect(screen.queryByText(/^0\s*USDC/)).toBeNull()
  })

  it('loading: shows Loading, never a placeholder number', () => {
    render(<MyMoneyRoute model={baseModel({ state: 'loading', confirmedTotal: null, checkedAt: null })} agents={[]} />)
    expect(screen.getByText('Loading')).toBeTruthy()
  })
})

describe('MyMoneyRoute — partial discovery exposes coverage adjacent to totals/actions', () => {
  it('renders the Partial discovery notice inside the same hero section as the total and the action', () => {
    const model = baseModel({ state: 'partial-discovery', agentCount: 1, problemAgentCount: 0 })
    render(<MyMoneyRoute model={model} agents={[stellarVaultAgent()]} onAction={vi.fn()} />)
    const hero = screen.getByRole('heading', { name: 'Your money' }).closest('section')
    expect(within(hero).getByText('Partial discovery')).toBeTruthy()
    expect(within(hero).getByRole('button')).toBeTruthy()
  })
})

describe('MyMoneyRoute — accessibility', () => {
  const states = [
    ['current', baseModel(), [stellarVaultAgent()]],
    ['disconnected', baseModel({ state: 'disconnected', owner: null, confirmedTotal: null }), []],
    ['problem', baseModel({ state: 'problem', problemAgents: ['CREVOKED1'] }), [revokedFundedAgent('CREVOKED1')]],
    ['mixed custody', baseModel(), [splitAgent('CBRIDGE1')]],
  ]
  for (const [label, model, agents] of states) {
    it(`has zero axe violations for the ${label} state`, async () => {
      const { container } = render(<MyMoneyRoute model={model} agents={agents} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  }
})

describe('MyMoneyRoute — no forbidden motion/gradient across the whole shipped surface (rejection checklist item 6)', () => {
  const FILES = [
    'MyMoneyRoute.jsx',
    'MoneyHero.jsx',
    'PositionList.jsx',
    'AgentTeam.jsx',
    'VaultProtection.jsx',
    'HowMoneyWorks.jsx',
    'TechnicalMoneyDetails.jsx',
  ]

  it('no component in this surface sets an inline style or an inline animation', () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.resolve(here, `./${file}`), 'utf8')
      expect(source, `${file} must not contain style=/animation`).not.toMatch(/style=|animation/i)
    }
  })

  // Mutation-provable: reading the real shipped CSS text, same mechanism PlanStage.test.jsx's I6
  // guard uses (jsdom cannot see the `animation` SHORTHAND at all -- verified there: it always
  // reports animationName:"none" regardless of the declared value).
  it('my-money.css defines no keyframes, animation, or gradient declarations', () => {
    const css = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
    expect(css).not.toMatch(/@keyframes/i)
    expect(css).not.toMatch(/\banimation(-name)?\s*:/i)
    expect(css).not.toMatch(/gradient/i)
  })
})

describe('MyMoneyRoute — checklist item 10: AgentMark identity is never seeded from list index', () => {
  it('AgentTeam.jsx never derives AgentMark identity from a map index or array position', () => {
    const source = fs.readFileSync(path.resolve(here, './AgentTeam.jsx'), 'utf8')
    // A real regression would look like `identity={index}` or `identity={String(i)}` -- assert the
    // only `identity=` usage present is keyed off `agent.address`.
    const identityUsages = [...source.matchAll(/identity=\{([^}]+)\}/g)].map((m) => m[1].trim())
    expect(identityUsages.length).toBeGreaterThan(0)
    for (const usage of identityUsages) expect(usage).toBe('agent.address')
  })
})

describe('MyMoneyRoute — checklist item 9: every network mark carries visible environment text', () => {
  it('every rendered network badge shows Stellar testnet or Base Sepolia as real text, never an icon alone', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[splitAgent('CBRIDGE1')]} />)
    const badges = document.querySelectorAll('.network-badge')
    expect(badges.length).toBeGreaterThan(0)
    for (const badge of badges) {
      const label = badge.querySelector('.network-badge-label')?.textContent
      expect(['Stellar testnet', 'Base Sepolia']).toContain(label)
    }
  })

  // A weaker version of this guard (iterating only `.network-badge` elements) cannot see a
  // DIFFERENT regression: a network mark rendered by bypassing NetworkBadge entirely (a bare
  // `<img src="/brand/networks/*.svg">` with no accompanying label). This scans every network mark
  // image on the page, by its real src path, and requires each one to sit inside a `.network-badge`
  // wrapper -- the only structure that guarantees the accompanying visible label text.
  it('no network mark image ever renders outside the NetworkBadge wrapper that carries its label', () => {
    render(<MyMoneyRoute model={baseModel()} agents={[splitAgent('CBRIDGE1')]} />)
    const marks = document.querySelectorAll('img[src*="/brand/networks/"]')
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) expect(mark.closest('.network-badge')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser layout guards (320px / 1440px), across every route state this task builds.
// Same launch mechanism PlanStage.test.jsx's G1 guard already uses (jsdom never runs layout --
// scrollWidth/getBoundingClientRect are inert there) -- reused verbatim rather than re-invented.
// ---------------------------------------------------------------------------------------------
const POCKET_CREW_CSS = fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8')
const MY_MONEY_CSS = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
const REAL_STYLESHEET = [POCKET_CREW_CSS, MY_MONEY_CSS].join('\n')
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF = 'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
<style>${REAL_STYLESHEET}</style>
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
      return await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] })
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Layout guard: no usable Chromium binary found for real-layout measurement (${lastErr?.message})`)
}

const LAYOUT_STATES = [
  ['disconnected', baseModel({ state: 'disconnected', owner: null, confirmedTotal: null }), []],
  ['loading', baseModel({ state: 'loading', confirmedTotal: null, checkedAt: null }), []],
  ['current-mixed-custody', baseModel(), [stellarVaultAgent(), splitAgent('CBRIDGE1')]],
  ['stale', baseModel({ state: 'stale', freshness: 'stale' }), [stellarVaultAgent()]],
  ['partial-discovery', baseModel({ state: 'partial-discovery' }), [stellarVaultAgent()]],
  ['needs-recovery', baseModel({ problemAgents: ['CREVOKED1'] }), [stellarVaultAgent(), revokedFundedAgent('CREVOKED1')]],
]

describe('MyMoneyRoute — real-browser 320px / 1440px layout guards, per route state', () => {
  it(
    'creates no horizontal overflow at 320px, and stays within the 1240px content cap at 1440px, for every state built',
    async () => {
      const results = []
      for (const [label, model, agents] of LAYOUT_STATES) {
        const { container, unmount } = render(<MyMoneyRoute model={model} agents={agents} />)
        results.push([label, container.innerHTML])
        unmount()
      }

      const browser = await launchRealChromium()
      try {
        for (const [label, html] of results) {
          const page = await browser.newPage()
          await page.setViewportSize({ width: 320, height: 1400 })
          await page.setContent(buildLayoutHarnessHtml(html))
          const at320 = await page.evaluate(() => document.documentElement.scrollWidth)
          expect(at320, `${label} @320px scrollWidth`).toBe(320)

          await page.setViewportSize({ width: 1440, height: 1400 })
          await page.setContent(buildLayoutHarnessHtml(html))
          const at1440 = await page.evaluate(() => {
            const route = document.querySelector('.pc-route')
            return {
              scrollWidth: document.documentElement.scrollWidth,
              routeWidth: route ? route.getBoundingClientRect().width : null,
            }
          })
          expect(at1440.scrollWidth, `${label} @1440px scrollWidth`).toBe(1440)
          // Content cap: --pc-shell-max (1240px) + 2 * the desktop gutter (clamp(20px,4vw,48px),
          // clamped to 48px at this width) = 1336px -- the outer .pc-route box is legitimately
          // this wide (gutter sits OUTSIDE the cap, per the contract's own note); it must never
          // exceed it.
          expect(at1440.routeWidth, `${label} @1440px .pc-route width`).toBeLessThanOrEqual(1336.5)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    },
    60000
  )
})

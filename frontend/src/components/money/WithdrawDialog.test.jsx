// frontend/src/components/money/WithdrawDialog.test.jsx
// My Money Task 12. WithdrawDialog is a pure preview -- it plans (money/ownerActions.js's
// planFullExit/planPartialExit, real functions, not mocked) and calls the caller's
// onConfirmFull/onConfirmPartial/onConfirmBase; it never touches the chain itself.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { WithdrawDialog } from './WithdrawDialog.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

// A real OwnerDiscoveryV1-shaped envelope (ownerDiscovery.js), the exact shape planFullExit reads
// (discovery.status/agents[].address/scopeReadStatus/revoked/expiry) -- not a hand-waved stub.
function discoveryWith(rows, status = 'complete') {
  return { status, agents: rows }
}

function activeRow(address) {
  return { address, scopeReadStatus: 'ok', revoked: false, expiry: 0 }
}

function revokedFundedRow(address) {
  return { address, scopeReadStatus: 'ok', revoked: true, expiry: 0 }
}

function positionAgent(address, units, location = 'stellar-vault') {
  return {
    address,
    amount: amt(units),
    custody: { location },
    custodyBreakdown: [{ location, amount: amt(units) }],
  }
}

const gAccount = { kind: 'G', address: 'GOWNER' }
const cAccount = { kind: 'C', address: 'COWNERCONTRACT' }

describe('WithdrawDialog — full exit, exact known-vs-partial target set', () => {
  it('lists every target agent with its real state, never a flattened "all active" set', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), revokedFundedRow('CAGENT2')])
    const agents = [positionAgent('CAGENT1', 100_0000000n), positionAgent('CAGENT2', 50_0000000n)]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    const list = screen.getByRole('list', { name: /agents in this exit/i })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // Mutation guard: a formulation that labels every row identically (e.g. always "active") would
    // still pass a weaker "2 items rendered" check -- this asserts the SPECIFIC, DIFFERENT state
    // text ownerActions.js's targetState() computes for each real row.
    expect(items[0].textContent).toMatch(/CAGE.*1/i)
    expect(items[0].textContent).toMatch(/active/i)
    expect(items[1].textContent).toMatch(/CAGE.*2/i)
    expect(items[1].textContent).toMatch(/revoked, still holds a confirmed balance/i)
  })

  it('never under-counts the known total: one target with an unread amount demotes the WHOLE total to Unavailable', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), activeRow('CAGENT2')])
    // CAGENT2 carries no `.amount` at all (an unread balance) -- the sum must not silently skip it.
    const agents = [
      positionAgent('CAGENT1', 100_0000000n),
      { address: 'CAGENT2', custody: { location: 'stellar-vault' }, custodyBreakdown: [] },
    ]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a formulation that sums only the KNOWN rows (silently treating the missing
    // one as 0) would render "100 USDC" here -- a confident-looking but wrong under-count. This
    // requires the honest "Unavailable" instead.
    expect(screen.getByText(/known amount across every target agent: unavailable/i)).toBeTruthy()
  })

  it('a partial-discovery envelope shows the honest "known agents only" limitation, not a false "exit all"', () => {
    const discovery = discoveryWith([activeRow('CAGENT1')], 'partial')
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /exit known agents/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^exit all$/i })).toBeNull()
    expect(screen.getByText(/not a guaranteed full-account sweep/i)).toBeTruthy()
  })
})

describe('WithdrawDialog — G-direct vs C-sponsored fee language, and hedged confirmation counts', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])
  const agents = [positionAgent('CAGENT1', 10_0000000n)]

  it('a G owner is told they sign and pay the fee themselves', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(
      screen.getByText(/you sign and submit directly.*pay the small network fee/i)
    ).toBeTruthy()
    expect(screen.queryByText(/relay sponsors the network fee/i)).toBeNull()
  })

  it('a C owner is told the relay sponsors the fee, never that they pay it', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={cAccount}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/relay sponsors the network fee -- 0 xlm from you/i)).toBeTruthy()
    expect(screen.queryByText(/pay the small network fee yourself/i)).toBeNull()
  })

  it('never states an exact, unhedged confirmation count -- only a floor', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a formulation that drops the "at least"/"can split" hedge while keeping the
    // same number would still satisfy a bare `/1 wallet confirmation/` match -- this requires the
    // hedge phrase to be present too.
    expect(screen.getByText(/at least 1 wallet confirmation/i)).toBeTruthy()
    expect(screen.getByText(/can still split it into more/i)).toBeTruthy()
  })
})

describe('WithdrawDialog — Cancel alongside the destructive action, disabled while pending', () => {
  it('renders Cancel and the primary exit button together, and disables both while pending', () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    const { rerender } = render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        pending={false}
      />
    )
    const cancel = screen.getByRole('button', { name: /cancel/i })
    const confirm = screen.getByRole('button', { name: /exit all/i })
    expect(cancel).toBeTruthy()
    expect(confirm.disabled).toBe(false)

    rerender(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        pending
      />
    )
    expect(screen.getByRole('button', { name: /cancel/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /withdrawing/i }).disabled).toBe(true)
  })

  it('does not close on Escape while pending (submission in flight), but does once idle', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <WithdrawDialog
        open
        agents={[]}
        discovery={discoveryWith([])}
        account={gAccount}
        onClose={onClose}
        pending
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <WithdrawDialog
        open
        agents={[]}
        discovery={discoveryWith([])}
        account={gAccount}
        onClose={onClose}
        pending={false}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('confirming calls the real plan through, never a fabricated substitute', () => {
    const onConfirmFull = vi.fn()
    const discovery = discoveryWith([activeRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmFull={onConfirmFull}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /exit all/i }))
    expect(onConfirmFull).toHaveBeenCalledTimes(1)
    const plan = onConfirmFull.mock.calls[0][0]
    expect(plan.ok).toBe(true)
    expect(plan.targets.map((t) => t.address)).toEqual(['CAGENT1'])
  })
})

describe('WithdrawDialog — partial exit, delegates its correctness gate to planPartialExit', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])

  it('an amount over the confirmed balance is rejected with the real max, not silently allowed', async () => {
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '11' } })
    expect(screen.getByText(/exceeds this agent's confirmed balance \(10 usdc\)/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /withdraw this amount/i })).toBeNull()
  })

  it('a revoked agent falls back to full exit, offered explicitly rather than silently blocked', async () => {
    const revokedDiscovery = discoveryWith([revokedFundedRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={revokedDiscovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } })
    expect(screen.getByText(/exit-signer can no longer act on it/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /use full exit instead/i })).toBeTruthy()
  })

  it("a valid amount confirms through planPartialExit's own real output", async () => {
    const onConfirmPartial = vi.fn()
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmPartial={onConfirmPartial}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))
    expect(onConfirmPartial).toHaveBeenCalledTimes(1)
    const plan = onConfirmPartial.mock.calls[0][0]
    expect(plan.ok).toBe(true)
    expect(plan.mode).toBe('partial')
    expect(plan.agentAddress).toBe('CAGENT1')
  })
})

describe('WithdrawDialog — Base full unwind: honest known set + allowedPool-skip caveat, full-unwind only', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])
  const agents = [positionAgent('CAGENT1', 1_0000000n)]

  it('no Base tab at all when basePlan is absent -- fails closed, no dead button', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(screen.queryByRole('tab', { name: /base/i })).toBeNull()
  })

  it('surfaces the allowedPool skip limitation honestly, and never claims a full sweep guarantee', () => {
    const basePlan = {
      available: true,
      positions: [{ pool: '0xPOOL1', poolName: 'Aave USDC', assets: 5_000000 }],
    }
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        basePlan={basePlan}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    expect(screen.getByText(/aave usdc/i)).toBeTruthy()
    expect(screen.getByText(/5\.00 usdc/i)).toBeTruthy()
    // Mutation guard: a version that describes the skip as loss ("funds are lost"/"balance becomes
    // zero") instead of "stays on Base, untouched" would fail this -- not just presence of the word
    // "skip".
    expect(screen.getByText(/skips that pool/i)).toBeTruthy()
    expect(screen.getByText(/not shown as zero/i)).toBeTruthy()
    expect(screen.getByText(/stays on base, untouched/i)).toBeTruthy()
    expect(screen.queryByText(/partial base withdrawal isn't available/i)).toBeTruthy()
  })

  it('confirming Base calls onConfirmBase with no arguments claiming a guaranteed amount', () => {
    const onConfirmBase = vi.fn()
    const basePlan = { available: true, positions: [{ pool: '0xPOOL1', assets: 1_000000 }] }
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        basePlan={basePlan}
        onConfirmBase={onConfirmBase}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    fireEvent.click(screen.getByRole('button', { name: /withdraw everything from base/i }))
    expect(onConfirmBase).toHaveBeenCalledTimes(1)
  })
})

describe('WithdrawDialog — accessibility', () => {
  it('has no axe violations in the full-exit state', async () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    const { container } = render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser 320px layout guard, per dialog state -- same launch mechanism MyMoneyRoute.test.jsx
// already uses (jsdom never runs layout; scrollWidth/getBoundingClientRect are inert there).
// ---------------------------------------------------------------------------------------------
const POCKET_CREW_CSS = fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8')
const MY_MONEY_CSS = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
const REAL_STYLESHEET = [POCKET_CREW_CSS, MY_MONEY_CSS].join('\n')
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

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
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `Layout guard: no usable Chromium binary found for real-layout measurement (${lastErr?.message})`
  )
}

describe('WithdrawDialog — real-browser 320px layout guard, per state', () => {
  it('creates no horizontal overflow at 320px for full/partial/base states', async () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), revokedFundedRow('CAGENT2')])
    const agents = [positionAgent('CAGENT1', 100_0000000n), positionAgent('CAGENT2', 50_0000000n)]
    const basePlan = {
      available: true,
      positions: [
        {
          pool: '0xLONGPOOLADDRESSFORLAYOUT00000000000000001',
          poolName: 'Aave USDC',
          assets: 5_000000,
        },
      ],
    }

    const states = []
    const full = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    states.push(['full', full.container.innerHTML])
    full.unmount()

    const partial = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(screen.getByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
    states.push(['partial', partial.container.innerHTML])
    partial.unmount()

    const withBase = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={cAccount}
        onClose={() => {}}
        basePlan={basePlan}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    states.push(['base', withBase.container.innerHTML])
    withBase.unmount()

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of states) {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 320, height: 1400 })
        await page.setContent(buildLayoutHarnessHtml(html))
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(scrollWidth, `${label} @320px scrollWidth`).toBe(320)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

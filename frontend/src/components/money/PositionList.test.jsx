// frontend/src/components/money/PositionList.test.jsx
// My Money Task 11. PositionList renders WHERE confirmed money sits -- see the component's own
// header comment for the exact readOwnerMoney.js row shape (file:line cited there) these fixtures
// mirror.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { PositionList } from './PositionList.jsx'
import { MyMoneyRoute } from './MyMoneyRoute.jsx'
import { toMoneyFactView } from './MoneyHero.jsx'
import { buildMyMoneyModel } from '../../money/myMoneyModel.js'

expect.extend(axeMatchers)
afterEach(cleanup)

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

// Mirrors readOwnerMoney.js:317-327's readOneAgentMoney() return shape exactly.
function stellarVaultAgent(address = 'CAGENT1', units = 100_0000000n) {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
    },
    vaultShares: { state: 'known', amount: amt(units) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(units),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

// Mirrors a split agent: a known-positive Stellar leg AND a settled Base association --
// custody.js:41-43 collapses `custody.location` to 'unknown' for this exact shape, so the per-leg
// custodyBreakdown (custodyBreakdownForAgent, custody.js:79-95) is what a consumer must read.
function splitAgent(address = 'CBRIDGE1') {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
    },
    vaultShares: { state: 'known', amount: amt(30_0000000n) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(50_0000000n), // 30 vault + 20 base, canonicalized
    executionStatus: 'succeeded',
    custody: { location: 'unknown' },
    custodyBreakdown: [
      { location: 'stellar-vault', amount: amt(30_0000000n) },
      { location: 'base-proxy', amount: amt(20_0000000n) },
    ],
    problems: [],
  }
}

// Task 10: an agent with TWO distinct Base children (two different kernel/pool positions -- the
// exact shape readOwnerMoney.js's readOneAgentMoney now produces once `latestBaseChild` stopped
// discarding siblings). Each base-flavored custodyBreakdown leg carries a real identity
// (kernelAddress + poolAddress), the fix for PositionList.jsx's old `${agent.address}:${location}`
// key collision.
function twoBaseChildrenAgent(address = 'CTWOBASE1') {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
    },
    vaultShares: { state: 'known', amount: amt(0n) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(70_0000000n),
    executionStatus: 'succeeded',
    custody: { location: 'unknown' },
    custodyBreakdown: [
      {
        location: 'base-proxy',
        amount: amt(50_0000000n),
        kernelAddress: '0xkernel1',
        poolAddress: '0xpoolaaaa',
        asset: 'usdc',
        poolName: 'Aave v3 USDC (Base)',
        coverageReason: null,
      },
      {
        location: 'base-proxy',
        amount: amt(20_0000000n),
        kernelAddress: '0xkernel1',
        poolAddress: '0xpoolbbbb',
        asset: 'usdc',
        poolName: 'Morpho Blue USDC (Base)',
        coverageReason: 'stale',
      },
    ],
    problems: [],
  }
}

describe('PositionList — two Base children on one agent render as distinguishable rows (Task 10)', () => {
  it('renders both Base legs, each with its own amount, never collapsed onto a duplicate key', () => {
    render(<PositionList agents={[twoBaseChildrenAgent()]} />)
    const parentRow = document.querySelector('.pc-position-row')
    const childRows = parentRow.querySelectorAll('.pc-position-row-children > li')
    expect(childRows).toHaveLength(2)
    expect(screen.getByText(/50/)).toBeTruthy()
    expect(screen.getByText(/20/)).toBeTruthy()
  })

  it('gives each Base leg a real, distinct React key derived from kernel+pool identity (no duplicate-key warning)', () => {
    // React strips `key` from the rendered DOM, so a stale/colliding key can't be read back off
    // an <li> after the fact -- the one observable symptom is React's own
    // "Encountered two children with the same key" console.error during render. Old
    // `legDisplay` built `key = ${agent.address}:${location}` -- identical for both legs here
    // (both 'base-proxy' on the same agent) -- so this genuinely distinguishes the fix from the bug.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PositionList agents={[twoBaseChildrenAgent()]} />)
    const duplicateKeyWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('same key')
    )
    errorSpy.mockRestore()
    expect(duplicateKeyWarning).toBe(false)
  })

  it('renders the affected leg coverage reason next to that leg only, never on its sibling', () => {
    render(<PositionList agents={[twoBaseChildrenAgent()]} />)
    expect(screen.getByText(/Confirmed evidence is a little older than usual/)).toBeTruthy()
    const parentRow = document.querySelector('.pc-position-row')
    const childRows = [...parentRow.querySelectorAll('.pc-position-row-children > li')]
    const staleRow = childRows.find((li) => /20/.test(li.textContent))
    const freshRow = childRows.find((li) => /50/.test(li.textContent))
    expect(staleRow.textContent).toMatch(/older than usual/)
    expect(freshRow.textContent).not.toMatch(/older than usual/)
  })

  // Review round 1, finding 8: identity reaching the React key fixes React's own reconciliation,
  // not the USER's ability to tell two positions apart. Two children with the SAME amount would
  // render byte-identical DOM/screen-reader text before this fix -- the second half of the bug.
  it("prints each Base leg's own pool name and kernel address, so equal-amount legs are still distinguishable to the user", () => {
    const equalAmounts = {
      ...twoBaseChildrenAgent('CEQUALAMOUNTS'),
      amount: amt(40_0000000n),
      custodyBreakdown: [
        {
          location: 'base-proxy',
          amount: amt(20_0000000n),
          kernelAddress: '0xkernel1',
          poolAddress: '0xpoolaaaa',
          asset: 'usdc',
          poolName: 'Aave v3 USDC (Base)',
          coverageReason: null,
        },
        {
          location: 'base-proxy',
          amount: amt(20_0000000n), // SAME amount as the leg above
          kernelAddress: '0xkernel1',
          poolAddress: '0xpoolbbbb',
          asset: 'usdc',
          poolName: 'Morpho Blue USDC (Base)',
          coverageReason: null,
        },
      ],
    }
    render(<PositionList agents={[equalAmounts]} />)
    const parentRow = document.querySelector('.pc-position-row')
    const childRows = [...parentRow.querySelectorAll('.pc-position-row-children > li')]
    expect(childRows).toHaveLength(2)
    // both rows show the same 20 USDC, but their OWN text must still differ (pool name/kernel)
    expect(childRows[0].textContent).not.toBe(childRows[1].textContent)
    expect(screen.getByText(/Aave v3 USDC \(Base\)/)).toBeTruthy()
    expect(screen.getByText(/Morpho Blue USDC \(Base\)/)).toBeTruthy()
  })

  // Review round 1, finding 7: leg identity used to carry only kernelAddress+poolAddress while the
  // grouping layer's own key also includes `asset` -- two groups differing only by asset produced
  // two legs with an IDENTICAL React key.
  it('gives two legs sharing the same kernel+pool but differing only by asset distinct keys and rows', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const distinctAssets = {
      ...twoBaseChildrenAgent('CDISTINCTASSET'),
      amount: amt(30_0000000n),
      custodyBreakdown: [
        {
          location: 'base-proxy',
          amount: amt(10_0000000n),
          kernelAddress: '0xkernel1',
          poolAddress: '0xpoolaaaa',
          asset: 'usdc',
          poolName: 'Aave v3 USDC (Base)',
          coverageReason: null,
        },
        {
          location: 'base-proxy',
          amount: amt(20_0000000n),
          kernelAddress: '0xkernel1',
          poolAddress: '0xpoolaaaa', // SAME kernel+pool as above
          asset: 'eurc', // differs ONLY by asset
          poolName: 'Aave v3 USDC (Base)',
          coverageReason: null,
        },
      ],
    }
    render(<PositionList agents={[distinctAssets]} />)
    const duplicateKeyWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('same key')
    )
    errorSpy.mockRestore()
    expect(duplicateKeyWarning).toBe(false)
    const parentRow = document.querySelector('.pc-position-row')
    expect(parentRow.querySelectorAll('.pc-position-row-children > li')).toHaveLength(2)
  })
})

describe('PositionList — exact Core amount boundary', () => {
  it('keeps a huge canonical unit string exact in the rendered amount', () => {
    render(<PositionList agents={[stellarVaultAgent('CHUGE', '9007199254740993')]} />)
    expect(screen.getByText(/900,719,925\.4740993 USDC/)).toBeTruthy()
  })
})

describe('PositionList — deployed identity fails closed without hiding healthy siblings', () => {
  it('renders Agent identity unavailable and omits the unidentified row money/custody/action', () => {
    render(
      <PositionList
        agents={[
          stellarVaultAgent('CAGENT1', 25_0000000n),
          {
            address: '',
            amount: amt('9007199254740993'),
            scope: { state: 'known', value: { revoked: false, expiry: 0 } },
            executionStatus: 'succeeded',
            custody: { location: 'stellar-vault' },
            custodyBreakdown: [],
            problems: [],
          },
        ]}
      />
    )

    expect(screen.getByText('Agent identity unavailable')).toBeTruthy()
    const rows = [...document.querySelectorAll('ul.pc-position-list > li')]
    const unidentified = rows.find((row) => row.textContent.includes('Agent identity unavailable'))
    expect(unidentified).toBeTruthy()
    expect(unidentified.querySelector('.pc-money')).toBeNull()
    expect(unidentified.querySelector('.network-badge')).toBeNull()
    expect(unidentified.querySelector('button')).toBeNull()
    expect(unidentified.querySelector('.pc-agent-mark')).toBeNull()
    expect(screen.getByText('Autofarm Vault to Blend Capital v2')).toBeTruthy()
    expect(document.querySelectorAll('.pc-agent-mark')).toHaveLength(1)
  })

  it('keeps multiple identity-unavailable rows visible with unique fallback keys and no React warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <PositionList
        agents={[
          {
            address: '',
            amount: amt('1000000000'),
            scope: { state: 'known', value: { revoked: false, expiry: 0 } },
            custody: { location: 'stellar-vault' },
            custodyBreakdown: [],
          },
          stellarVaultAgent('CVALID', 25_0000000n),
          {
            address: null,
            amount: amt('2000000000'),
            scope: { state: 'known', value: { revoked: false, expiry: 0 } },
            custody: { location: 'stellar-vault' },
            custodyBreakdown: [],
          },
        ]}
      />
    )

    const rows = [...document.querySelectorAll('ul.pc-position-list > li')]
    const unavailableRows = rows.filter((row) =>
      row.textContent.includes('Agent identity unavailable')
    )
    expect(unavailableRows).toHaveLength(2)
    expect(new Set(unavailableRows.map((row) => row.getAttribute('data-row-key'))).size).toBe(2)
    for (const row of unavailableRows) {
      expect(row.querySelector('.pc-money')).toBeNull()
      expect(row.querySelector('.network-badge')).toBeNull()
      expect(row.querySelector('.pc-agent-mark')).toBeNull()
      expect(row.querySelector('button')).toBeNull()
    }
    expect(screen.getByText('Autofarm Vault to Blend Capital v2')).toBeTruthy()
    expect(document.querySelectorAll('.pc-agent-mark')).toHaveLength(1)
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('same key'))).toBe(false)
    errorSpy.mockRestore()
  })
})

describe('PositionList — Stellar vault destination and network truth', () => {
  it('shows the exact Autofarm -> Blend destination string and a visible Stellar testnet badge', () => {
    render(<PositionList agents={[stellarVaultAgent()]} />)
    expect(screen.getByText('Autofarm Vault to Blend Capital v2')).toBeTruthy()
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
  })

  it('uses the assigned branded persona icon for the position owner', () => {
    render(
      <PositionList
        agents={[stellarVaultAgent('CAGENT1')]}
        personaByAddress={{ CAGENT1: { id: 'clover' } }}
      />
    )
    const avatar = screen.getByRole('img', { name: /Clover agent/ })
    expect(avatar.getAttribute('src')).toBe('/brand/agents/clover.svg')
  })

  it('renders the real position amount, not a placeholder', () => {
    render(<PositionList agents={[stellarVaultAgent('CAGENT1', 250_0000000n)]} />)
    expect(screen.getByText(/250/)).toBeTruthy()
  })
})

describe('PositionList — Base children are separate nested rows under their Stellar-hosted parent', () => {
  it('nests the Base leg under the same row as the Stellar leg, both visible', () => {
    render(<PositionList agents={[splitAgent()]} />)
    const parentRow = document.querySelector('.pc-position-row')
    expect(within(parentRow).getByText('Stellar testnet')).toBeTruthy()
    expect(within(parentRow).getByText('Base Sepolia')).toBeTruthy()
    // Custody-only truth, verbatim (see this file's header + PositionList.jsx's header for why
    // this exact sentence form, not the brief's own two-middle-dot example, is what ships).
    expect(
      within(parentRow).getByText('Base Sepolia proxy. Custody only. No protocol yield.')
    ).toBeTruthy()
  })

  it('shows both real leg amounts (30 vault + 20 base), never a collapsed single figure', () => {
    render(<PositionList agents={[splitAgent()]} />)
    expect(screen.getByText(/30/)).toBeTruthy()
    expect(screen.getByText(/20/)).toBeTruthy()
  })

  it('nested Base rows use NetworkBadge (settled custody), not NetworkRoute', () => {
    render(<PositionList agents={[splitAgent()]} />)
    // NetworkRoute renders an accessible arrow (role="img", name "to"); a settled base-proxy leg
    // must not render one.
    expect(screen.queryByRole('img', { name: 'to' })).toBeNull()
  })

  it('keeps independently-known Stellar and Base legs visible while live APY comes only from nested yield evidence', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [{ address: 'CBRIDGE1' }] },
      money: {
        status: 'complete',
        confirmedTotal: { state: 'known', amount: amt(50_0000000n) },
        yield: {
          state: 'live',
          apy: 8.2,
          asOf: '2026-08-11T00:00:00.000Z',
          source: 'defillama',
          checkedAt: '2026-08-11T00:01:00.000Z',
        },
        earned: { state: 'unavailable', amount: null },
        custodyBreakdown: { 'stellar-vault': '3000000000', 'base-proxy': '2000000000' },
        unattributed: {},
        executionBreakdown: {},
        agentCount: 1,
        problemAgentCount: 0,
        agents: [splitAgent()],
        checkedAt: Date.parse('2026-08-11T00:01:00.000Z'),
        confirmedLedger: '12345',
        confirmedBlock: '67890',
        source: 'soroban-rpc',
      },
      now: Date.parse('2026-08-11T00:02:00.000Z'),
    })
    render(
      <MyMoneyRoute
        model={model}
        agents={[splitAgent()]}
        venue={{
          name: 'Autofarm Vault',
          yield: {
            state: 'live',
            apy: 99.9,
            asOf: '2026-08-11T00:00:00.000Z',
            source: 'untrusted-venue-override',
            checkedAt: '2026-08-11T00:01:00.000Z',
          },
        }}
      />
    )
    const parentRow = document.querySelector('.pc-position-row')
    expect(within(parentRow).getByText(/30/)).toBeTruthy()
    expect(within(parentRow).getByText(/20/)).toBeTruthy()
    expect(
      within(parentRow).getByText('Base Sepolia proxy. Custody only. No protocol yield.')
    ).toBeTruthy()
    expect(screen.getAllByText('Earning 8.2% APY').length).toBeGreaterThan(0)
    expect(screen.queryByText(/99\.9% APY/)).toBeNull()
  })
})

describe('PositionList — route freshness is shared with the model fact', () => {
  it('keeps a source-current funded leg Current during partial discovery', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z')
    const agent = stellarVaultAgent('CPARTIALCURRENT', 30_0000000n)
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'partial', agents: [{ address: agent.address }] },
      money: {
        ...stateMoneySnapshotForPartial(agent, now),
        checkedAt: now,
      },
      now,
    })

    expect(model.state).toBe('partial-discovery')
    expect(model.freshness).toBe('current')
    render(<MyMoneyRoute model={model} agents={[agent]} />)
    const position = document.querySelector('ul.pc-position-list .pc-money')
    expect(position).toBeTruthy()
    expect(position.className).toContain('pc-money--current')
    expect(position.className).not.toContain('pc-money--stale')
    expect(position.getAttribute('data-freshness')).toBe('Partial')
  })

  it('marks a real cached position stale instead of presenting it as current', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z')
    const agent = stellarVaultAgent('CSTALE', 30_0000000n)
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [{ address: agent.address }] },
      money: {
        status: 'complete',
        confirmedTotal: { state: 'known', amount: amt(30_0000000n) },
        yield: { state: 'unavailable', apy: null },
        earned: { state: 'unavailable', amount: null },
        custodyBreakdown: { 'stellar-vault': '3000000000' },
        unattributed: {},
        executionBreakdown: {},
        agentCount: 1,
        problemAgentCount: 0,
        agents: [agent],
        checkedAt: now - 30 * 24 * 60 * 60 * 1000,
        confirmedLedger: '12345',
        confirmedBlock: '67890',
        source: 'soroban-rpc',
      },
      now,
    })
    render(<MyMoneyRoute model={model} agents={[agent]} />)
    const position = document.querySelector('ul.pc-position-list .pc-money')
    expect(position).toBeTruthy()
    expect(position.className).toContain('pc-money--stale')
    expect(position.textContent).toMatch(/stale/i)
  })

  it('keeps a known unattributed Base balance stale when the real model is stale', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z')
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [] },
      money: {
        status: 'complete',
        confirmedTotal: { state: 'known', amount: amt(30_0000000n) },
        yield: { state: 'unavailable', apy: null },
        earned: { state: 'unavailable', amount: null },
        custodyBreakdown: {},
        unattributed: {
          '0xkernel1': {
            state: 'known',
            amount: amt(30_0000000n),
            checkedAt: now - 30 * 24 * 60 * 60 * 1000,
          },
        },
        executionBreakdown: {},
        agentCount: 0,
        problemAgentCount: 0,
        agents: [],
        checkedAt: now - 30 * 24 * 60 * 60 * 1000,
        confirmedLedger: '12345',
        confirmedBlock: '67890',
        source: 'soroban-rpc',
      },
      now,
    })
    render(
      <PositionList
        agents={[]}
        unattributed={model.unattributed}
        collectionState={model.state}
        factView={toMoneyFactView(model)}
      />
    )
    const position = document.querySelector('ul.pc-position-list .pc-money')
    expect(position).toBeTruthy()
    expect(position.className).toContain('pc-money--stale')
  })

  it('renders an unsafe-integer-sized Stellar position exactly, without Number coercion', () => {
    render(<PositionList agents={[stellarVaultAgent('CPRECISION', '9007199254740993')]} />)
    expect(screen.getByText('900,719,925.4740993 USDC')).toBeTruthy()
    expect(screen.queryByText('900719925.4740992 USDC')).toBeNull()
  })
})

function stateMoneySnapshotForPartial(agent, checkedAt) {
  return {
    status: 'complete',
    confirmedTotal: { state: 'known', amount: amt(30_0000000n) },
    yield: { state: 'unavailable', apy: null },
    earned: { state: 'unavailable', amount: null },
    custodyBreakdown: { 'stellar-vault': '3000000000' },
    unattributed: {},
    executionBreakdown: {},
    agentCount: 1,
    problemAgentCount: 0,
    agents: [agent],
    checkedAt,
    confirmedLedger: '12345',
    confirmedBlock: '67890',
    source: 'soroban-rpc',
  }
}

describe('PositionList — an in-transit leg uses NetworkRoute, never a settled badge', () => {
  it('renders a truthful bridge-in-progress route for an in-transit-only leg', () => {
    const agent = {
      address: 'CBRIDGE2',
      scope: {
        state: 'known',
        value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
      },
      vaultShares: { state: 'known', amount: amt(0n) },
      idleToken: { state: 'known', amount: amt(0n) },
      amount: amt(40_0000000n),
      executionStatus: 'executing',
      custody: { location: 'unknown' },
      custodyBreakdown: [{ location: 'in-transit', amount: amt(40_0000000n) }],
      problems: [],
    }
    render(<PositionList agents={[agent]} />)
    expect(screen.getByRole('img', { name: 'to' })).toBeTruthy()
    expect(screen.getByText('Bridge status unknown')).toBeTruthy()
  })
})

describe('PositionList — unattributed Base money never renders as absent', () => {
  it('shows an unavailable unattributed balance as a real row, not silence', () => {
    render(
      <PositionList
        agents={[]}
        unattributed={{ '0xkernel1': { state: 'unavailable', amount: null, checkedAt: null } }}
      />
    )
    expect(screen.getByText(/Unattributed Base balance/)).toBeTruthy()
    expect(screen.getByText(/Unavailable/)).toBeTruthy()
  })

  it('shows a known-zero unattributed balance as a real confirmed zero, not hidden', () => {
    render(
      <PositionList
        agents={[]}
        unattributed={{ '0xkernel1': { state: 'known', amount: amt(0n), checkedAt: 1 } }}
      />
    )
    expect(screen.getByText(/Unattributed Base balance/)).toBeTruthy()
  })
})

describe('PositionList — no confirmed money means an honest empty state, not a fabricated row', () => {
  it('renders a plain honest message when nothing is confirmed anywhere', () => {
    render(
      <PositionList
        agents={[
          { address: 'CX', amount: null, custody: { location: 'unknown' }, custodyBreakdown: [] },
        ]}
      />
    )
    expect(screen.getByText('No confirmed positions yet.')).toBeTruthy()
  })
})

describe('PositionList — DOM list ordering (every position before any disclosure)', () => {
  it('renders every position row as a real <li> in a plain <ul>, not inside a <details>', () => {
    render(<PositionList agents={[stellarVaultAgent(), splitAgent('CBRIDGE1')]} />)
    const list = document.querySelector('ul.pc-position-list')
    expect(list).toBeTruthy()
    expect(list.closest('details')).toBeNull()
    expect(list.querySelectorAll(':scope > li').length).toBe(2)
  })
})

describe('PositionList — accessibility', () => {
  it('has zero axe violations with a mixed Stellar/Base position set', async () => {
    const { container } = render(
      <PositionList agents={[stellarVaultAgent(), splitAgent('CBRIDGE1')]} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

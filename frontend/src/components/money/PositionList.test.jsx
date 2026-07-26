// frontend/src/components/money/PositionList.test.jsx
// My Money Task 11. PositionList renders WHERE confirmed money sits -- see the component's own
// header comment for the exact readOwnerMoney.js row shape (file:line cited there) these fixtures
// mirror.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { PositionList } from './PositionList.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

// Mirrors readOwnerMoney.js:317-327's readOneAgentMoney() return shape exactly.
function stellarVaultAgent(address = 'CAGENT1', units = 100_0000000n) {
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

// Mirrors a split agent: a known-positive Stellar leg AND a settled Base association --
// custody.js:41-43 collapses `custody.location` to 'unknown' for this exact shape, so the per-leg
// custodyBreakdown (custodyBreakdownForAgent, custody.js:79-95) is what a consumer must read.
function splitAgent(address = 'CBRIDGE1') {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true } },
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

describe('PositionList — Stellar vault destination and network truth', () => {
  it('shows the exact Autofarm -> Blend destination string and a visible Stellar testnet badge', () => {
    render(<PositionList agents={[stellarVaultAgent()]} />)
    expect(screen.getByText('Autofarm Vault → Blend Capital v2')).toBeTruthy()
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
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
    expect(within(parentRow).getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
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
})

describe('PositionList — an in-transit leg uses NetworkRoute, never a settled badge', () => {
  it('renders a truthful bridge-in-progress route for an in-transit-only leg', () => {
    const agent = {
      address: 'CBRIDGE2',
      scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true } },
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
    render(<PositionList agents={[{ address: 'CX', amount: null, custody: { location: 'unknown' }, custodyBreakdown: [] }]} />)
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
    const { container } = render(<PositionList agents={[stellarVaultAgent(), splitAgent('CBRIDGE1')]} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// frontend/src/components/money/AgentTeam.test.jsx
// My Money Task 11. AgentTeam renders one row per deployed agent, keyed by stable address -- see
// the component's own header comment for the exact readOwnerMoney.js row shape and the Cap
// investigation (why Cap always renders "Unavailable", cited file:line there).
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { AgentTeam } from './AgentTeam.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

function healthyAgent(address = 'CAGENT1') {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 4102444800, authorized: true },
    },
    vaultShares: { state: 'known', amount: amt(100_0000000n) },
    idleToken: { state: 'known', amount: amt(0n) },
    amount: amt(100_0000000n),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

function revokedFundedAgent(address = 'CREVOKED1') {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: true, expiry: 0, authorized: true },
    },
    vaultShares: { state: 'known', amount: amt(0n) },
    idleToken: { state: 'known', amount: amt(50_0000000n) },
    amount: amt(50_0000000n),
    executionStatus: 'idle',
    custody: { location: 'agent' },
    custodyBreakdown: [],
    problems: ['scope-revoked'],
  }
}

describe('AgentTeam — real stable identity, never list index', () => {
  it("seeds each AgentMark from the real address: reordering the array never changes either address's fill", () => {
    // A list-index-seeded regression (`identity={index}` or any positional string) would still
    // pass a weaker version of this test that only checks "some fill exists" -- the real proof is
    // that CAGENT1's fill is IDENTICAL whether it renders first or second, and likewise for
    // CAGENT2's, which only holds if the fill is a pure function of the address.
    const { unmount: unmountFirst } = render(
      <AgentTeam agents={[healthyAgent('CAGENT1'), healthyAgent('CAGENT2')]} problemAgents={[]} />
    )
    const marksInOrder = document.querySelectorAll('.pc-agent-mark')
    const cagent1FillAtIndex0 = marksInOrder[0].querySelector('path').getAttribute('fill')
    const cagent2FillAtIndex1 = marksInOrder[1].querySelector('path').getAttribute('fill')
    unmountFirst()

    const { unmount: unmountReversed } = render(
      <AgentTeam agents={[healthyAgent('CAGENT2'), healthyAgent('CAGENT1')]} problemAgents={[]} />
    )
    const reorderedMarks = document.querySelectorAll('.pc-agent-mark')
    const cagent2FillAtIndex0 = reorderedMarks[0].querySelector('path').getAttribute('fill')
    const cagent1FillAtIndex1 = reorderedMarks[1].querySelector('path').getAttribute('fill')
    unmountReversed()

    expect(cagent1FillAtIndex1).toBe(cagent1FillAtIndex0) // CAGENT1: index 0 -> index 1, same fill
    expect(cagent2FillAtIndex0).toBe(cagent2FillAtIndex1) // CAGENT2: index 1 -> index 0, same fill
  })

  it('renders the real full address as an explorer link', () => {
    render(<AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} />)
    const link = screen.getByRole('link', { name: 'CAGENT1' })
    expect(link.getAttribute('href')).toBe(
      'https://stellar.expert/explorer/testnet/account/CAGENT1'
    )
  })
})

describe('AgentTeam — Cap and Expiry', () => {
  it('always renders Cap as an honest Unavailable (no producer emits a real cap at this layer)', () => {
    render(<AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} />)
    expect(screen.getByText('Cap: Unavailable')).toBeTruthy()
  })

  it('renders the real expiry when the scope is known', () => {
    render(<AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} />)
    // 4102444800 (this fixture's expiry) is exactly 2100-01-01T00:00:00.000Z.
    expect(screen.getByText(/^Expires: 2100-01-01/)).toBeTruthy()
  })

  it('renders Expires: Unavailable when the scope could not be read', () => {
    const agent = { ...healthyAgent('CAGENT1'), scope: { state: 'unavailable', value: null } }
    render(<AgentTeam agents={[agent]} problemAgents={[]} />)
    expect(screen.getByText('Expires: Unavailable')).toBeTruthy()
  })
})

describe('AgentTeam — revoked-funded rows stay visible as Needs recovery', () => {
  it('shows the literal "Needs recovery" label for a confirmed-problem agent, never dropped from the list', () => {
    render(
      <AgentTeam
        agents={[healthyAgent('CAGENT1'), revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
      />
    )
    expect(screen.getByText('CREVOKED1')).toBeTruthy() // still in the DOM
    expect(screen.getByText('Needs recovery')).toBeTruthy()
  })

  it('never labels a revoked agent with NO confirmed funds as "Needs recovery" (nothing urgent to recover)', () => {
    const emptyRevoked = {
      ...revokedFundedAgent('CREVOKED2'),
      amount: amt(0n),
      idleToken: { state: 'known', amount: amt(0n) },
    }
    render(<AgentTeam agents={[emptyRevoked]} problemAgents={[]} />)
    expect(screen.queryByText('Needs recovery')).toBeNull()
    expect(screen.getByText('Revoked')).toBeTruthy()
  })

  it('opens a recovery dialog explaining owner withdrawal is always allowed', () => {
    render(<AgentTeam agents={[revokedFundedAgent('CREVOKED1')]} problemAgents={['CREVOKED1']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Owner withdrawal is always allowed/)).toBeTruthy()
  })

  it('fires onRecoverAgent with the target address on confirm', () => {
    const onRecoverAgent = vi.fn()
    render(
      <AgentTeam
        agents={[revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
        onRecoverAgent={onRecoverAgent}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    fireEvent.click(screen.getByRole('button', { name: 'Exit all' }))
    expect(onRecoverAgent).toHaveBeenCalledWith('CREVOKED1', null)
  })

  it('shows a real planFullExit preview once discovery and account are supplied', () => {
    const discovery = {
      status: 'complete',
      agents: [{ address: 'CREVOKED1', scopeReadStatus: 'ok', revoked: true, expiry: 0 }],
    }
    const account = { kind: 'G', address: 'GOWNER' }
    render(
      <AgentTeam
        agents={[revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
        discovery={discovery}
        account={account}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    expect(screen.getByRole('button', { name: 'Exit all' })).toBeTruthy()
  })
})

describe('AgentTeam — actual state is shown for healthy agents', () => {
  it('labels a funded vault agent as Earning in vault', () => {
    render(<AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} />)
    expect(screen.getByText('Earning in vault')).toBeTruthy()
  })

  it('labels a bridging agent honestly', () => {
    const bridging = {
      ...healthyAgent('CBRIDGE1'),
      executionStatus: 'executing',
      custody: { location: 'in-transit' },
    }
    render(<AgentTeam agents={[bridging]} problemAgents={[]} />)
    expect(screen.getByText('Bridging in progress')).toBeTruthy()
  })
})

describe('AgentTeam — DOM list ordering (every agent before any disclosure)', () => {
  it('renders every agent as a real <li> in a plain <ul>, not inside a <details>', () => {
    render(
      <AgentTeam
        agents={[healthyAgent('CAGENT1'), revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
      />
    )
    const list = document.querySelector('ul.pc-crew-list')
    expect(list).toBeTruthy()
    expect(list.closest('details')).toBeNull()
    expect(list.querySelectorAll(':scope > li').length).toBe(2)
  })
})

describe('AgentTeam — accessibility', () => {
  it('has zero axe violations with a mixed healthy/needs-recovery team', async () => {
    const { container } = render(
      <AgentTeam
        agents={[healthyAgent('CAGENT1'), revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('AgentTeam — no forbidden motion/gradient (rejection checklist item 6)', () => {
  it("renders no inline style/animation in this component's own JSX", () => {
    const source = fs.readFileSync(path.resolve(here, './AgentTeam.jsx'), 'utf8')
    expect(source).not.toMatch(/style=|animation/i)
  })
})

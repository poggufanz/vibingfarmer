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
  // My Money Task 13 Part B item 6: `discovery` is now the real source of `cap` (carried through
  // ownerDiscovery.js's addCandidate from RouterDeployedEvent). This test no longer supplies
  // `discovery` at all, so the honest fallback below is because the caller genuinely has nothing to
  // look up yet -- not because "no producer emits a real cap at this layer" (that premise is now
  // false; see the two tests immediately after this one).
  it('renders Cap: Unavailable when no discovery is supplied for this agent', () => {
    render(<AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} />)
    expect(screen.getByText('Cap: Unavailable')).toBeTruthy()
  })

  it('renders the real cap once discovery supplies one for this address', () => {
    const discovery = {
      status: 'complete',
      agents: [{ address: 'CAGENT1', cap: String(500_0000000n) }],
    }
    render(
      <AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} discovery={discovery} />
    )
    expect(screen.getByText('Cap: 500 USDC')).toBeTruthy()
  })

  // Mutation guard: a truthy check (`if (cap)`) instead of `cap != null` would collapse a genuine
  // zero cap into the same branch as "no cap at all" -- the same class of bug ownerDiscovery.test.js
  // already guards on the producer side (cap != null vs a truthy check).
  it('renders a literal zero cap as "0 USDC", never coerced into Unavailable', () => {
    const discovery = { status: 'complete', agents: [{ address: 'CAGENT1', cap: '0' }] }
    render(
      <AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} discovery={discovery} />
    )
    expect(screen.getByText('Cap: 0 USDC')).toBeTruthy()
  })

  // Mutation guard mirrors WithdrawDialog.jsx's own fix loop 2 (M6): `BigInt('')` returns `0n`
  // without throwing, so a blank/whitespace-only cap string must be rejected before the parse
  // attempt, or an unreadable cap renders as a confident (and wrong) "0 USDC".
  it('renders Cap: Unavailable for a blank/whitespace cap string, never a coerced zero', () => {
    const discovery = { status: 'partial', agents: [{ address: 'CAGENT1', cap: '   ' }] }
    render(
      <AgentTeam agents={[healthyAgent('CAGENT1')]} problemAgents={[]} discovery={discovery} />
    )
    expect(screen.getByText('Cap: Unavailable')).toBeTruthy()
  })

  // Mutation guard: a hardcoded `/ 1e7` here would silently misreport this by two orders of
  // magnitude for any non-7-decimal amount -- 5000000 base units at 6dp is 5 USDC, not 0.5.
  it("scales the cap by the agent's own amount decimals, never a hardcoded 7", () => {
    const sixDpAgent = {
      ...healthyAgent('CAGENT1'),
      amount: { token: 'USDC', units: '1', decimals: 6 },
    }
    const discovery = { status: 'complete', agents: [{ address: 'CAGENT1', cap: '5000000' }] }
    render(<AgentTeam agents={[sixDpAgent]} problemAgents={[]} discovery={discovery} />)
    expect(screen.getByText('Cap: 5 USDC')).toBeTruthy()
    expect(screen.queryByText('Cap: 0.5 USDC')).toBeNull()
  })

  // When this agent's own amount is unread (null), there is no per-row decimals to trust yet --
  // falls back to the network's canonical SOROBAN_DECIMALS constant, not a bare literal.
  it('falls back to the canonical decimals when this agent has no amount read yet', () => {
    const noAmountAgent = { ...healthyAgent('CAGENT1'), amount: null }
    const discovery = {
      status: 'complete',
      agents: [{ address: 'CAGENT1', cap: String(500_0000000n) }],
    }
    render(<AgentTeam agents={[noAmountAgent]} problemAgents={[]} discovery={discovery} />)
    expect(screen.getByText('Cap: 500 USDC')).toBeTruthy()
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

  it('shows a real planFullExit preview once discovery and account are supplied, including the partial-sweep limitation (I2)', () => {
    // discovery.status: 'complete' would return planFullExit's `label: 'Exit all'` -- BYTE-
    // IDENTICAL to this component's own null-plan fallback (`{plan?.label || 'Exit all'}`,
    // AgentTeam.jsx:197), so a test built on 'complete' cannot tell a real plan from `const plan =
    // null`. 'partial' genuinely diverges: planFullExit (ownerActions.js:156-157) returns
    // `known: false`, `label: 'Exit known agents'`, and a real `limitation` sentence -- proven
    // below by setting `const plan = null` in AgentTeam.jsx and confirming this test goes red
    // (fix loop 2, I2).
    const discovery = {
      status: 'partial',
      agents: [{ address: 'CREVOKED1', scopeReadStatus: 'ok', revoked: true, expiry: 0 }],
    }
    const account = { kind: 'G', address: 'GOWNER' }
    const onRecoverAgent = vi.fn()
    render(
      <AgentTeam
        agents={[revokedFundedAgent('CREVOKED1')]}
        problemAgents={['CREVOKED1']}
        discovery={discovery}
        account={account}
        onRecoverAgent={onRecoverAgent}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    expect(screen.getByRole('button', { name: 'Exit known agents' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Exit all' })).toBeNull()
    // plan.limitation -- the "only known agents, not a guaranteed full sweep" disclosure -- had
    // ZERO coverage before this loop. This is the exact sentence an owner needs before signing a
    // recovery sweep on partial discovery.
    expect(
      screen.getByText(
        /this exits only the agents currently known, not a guaranteed full-account sweep/
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Exit known agents' }))
    expect(onRecoverAgent).toHaveBeenCalledWith(
      'CREVOKED1',
      expect.objectContaining({ kind: 'full-exit', known: false })
    )
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

// Fix loop 1, I1. Mirrors PositionList.test.jsx's own `splitAgent` fixture exactly (same file
// header there cites custody.js:41-43/79-95 for why this exact shape is what a genuine
// Stellar+Base split actually produces) -- a known-positive vault leg AND a settled Base
// association, which collapses `custody.location` to 'unknown' by design.
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

describe('AgentTeam — split-custody agents get a truthful label, not the generic fallback (I1)', () => {
  it('names both real legs for a genuine Stellar+Base split, never the generic "Active"', () => {
    // A regression to reading `agent.custody?.location` directly would hit 'unknown', match no
    // branch, and fall through to 'Active' -- exactly the bug this guards against.
    render(<AgentTeam agents={[splitAgent()]} problemAgents={[]} />)
    expect(screen.queryByText('Active')).toBeNull()
    expect(screen.getByText('Split: vault + Base')).toBeTruthy()
  })

  // Task 10: readOwnerMoney.js can now report TWO distinct Base legs for one agent (two separate
  // positions, both custody 'base-proxy') -- naming every leg individually used to print the
  // literal duplicate "Split: vault + Base + Base".
  it('never repeats the same place twice in the split label when two Base legs exist (Task 10)', () => {
    const twoBaseLegs = {
      ...splitAgent('CBRIDGE2'),
      custodyBreakdown: [
        { location: 'stellar-vault', amount: amt(30_0000000n) },
        {
          location: 'base-proxy',
          amount: amt(12_0000000n),
          kernelAddress: '0xk',
          poolAddress: '0xpa',
        },
        {
          location: 'base-proxy',
          amount: amt(8_0000000n),
          kernelAddress: '0xk',
          poolAddress: '0xpb',
        },
      ],
    }
    render(<AgentTeam agents={[twoBaseLegs]} problemAgents={[]} />)
    expect(screen.getByText('Split: vault + Base')).toBeTruthy()
    expect(screen.queryByText('Split: vault + Base + Base')).toBeNull()
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

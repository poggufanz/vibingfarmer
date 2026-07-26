// frontend/src/components/strategy/StartStage.test.jsx
// Strategy Task 12 (Pocket Crew redesign, Wave 5). Start shows REAL agent execution progress --
// no lane may advance without the matching orchestrator event/milestone, pending chains stay
// pending indefinitely (never resolved by a timer), successful siblings stay confirmed when a
// sibling fails, and the bridge lane carries every Base child inside ONE mark. Every fixture below
// uses the REAL event names/shapes read directly off the producers (orchestrator.js, worker.js,
// baseLeg.js, crossChainFarm.js) -- see StartStage.jsx's own header comment for file:line citations
// per event, the same discipline ProtectStage.test.jsx's header describes for its own fixtures.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StartStage, depositLanePhase, bridgeLanePhase } from './StartStage.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

expect.extend(axeMatchers)

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

const NOW = 1_800_000_000
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CDCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UB'
// Real-LENGTH tx hash (64 hex chars) -- a short placeholder fits at 320px regardless of whether
// overflow-wrap is present, which would leave a 320px guard built on it unable to see its own
// regression (see StrategyReceipt.test.jsx's identical fix and its own red-then-green note).
const REAL_TX_HASH = 'a1b2c3d4'.repeat(8)

function amount(token, units, decimals = 7) {
  return { token, units, decimals }
}

const PLAN_TWO_DEPOSITS = Object.freeze({
  runId: 'run-1',
  planFingerprint: '0xplan1',
  amount: amount('USDC', '2000000000'),
  agents: [
    {
      allocationId: 'run-1:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(TOKEN_ADDR, '1000000000'),
      cap: amount(TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
    {
      allocationId: 'run-1:deposit:1',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(TOKEN_ADDR, '1000000000'),
      cap: amount(TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
  ],
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: false },
})

const PLAN_WITH_BRIDGE = Object.freeze({
  runId: 'run-2',
  planFingerprint: '0xplan2',
  amount: amount('USDC', '2000000000'),
  agents: [
    {
      allocationId: 'run-2:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(TOKEN_ADDR, '1000000000'),
      cap: amount(TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
    {
      allocationId: 'run-2:bridge:base',
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(BRIDGE_TOKEN_ADDR, '1000000000'),
      cap: amount(BRIDGE_TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Base Sepolia bridge',
      children: [
        { allocationId: 'run-2:bridge:aave-v3', proxyTarget: 'aave-v3', destination: 'aave-v3', allocation: amount('USDC', '600000', 6) },
        { allocationId: 'run-2:bridge:moonwell', proxyTarget: 'moonwell', destination: 'moonwell', allocation: amount('USDC', '400000', 6) },
      ],
    },
  ],
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: true },
})

const PERMISSION_FRESH = Object.freeze({
  mode: 'fresh',
  txHash: '0xgrant1',
  grantReceiptFingerprint: '0xreceiptfp',
  expiryLedger: 9001,
  agentAddresses: [AGENT_1, AGENT_2],
  confirmationCount: 1,
})

const PERMISSION_REUSE = Object.freeze({
  mode: 'reuse',
  txHash: null,
  grantReceiptFingerprint: '0xreceiptfp',
  expiryLedger: 9001,
  agentAddresses: [AGENT_1, AGENT_2],
  confirmationCount: 0,
})

function evt(name, data) {
  return { name, data }
}

// Real per-allocation event sequence, byte-identical to what orchestrator.js/worker.js actually
// emit for one successful Stellar deposit worker (see StartStage.jsx's header for file:line
// citations). `queueIndex` mirrors the real forEach-index the orchestrator assigns.
function depositQueuedThenStarted(allocationId, agentId, queueIndex) {
  return [
    evt('worker-queued', { allocationId, agentId, agent: agentId, queueIndex }),
    evt('worker-started', { allocationId, agentId, agent: agentId, queueIndex }),
    evt('started', { agentId, vault: 'CVAULT', allocationId }),
    evt('step', { step: 'key-setup', status: 'pending', agentId, allocationId }),
    evt('step', { step: 'key-setup', status: 'done', address: 'GSESSION', agentId, allocationId }),
    evt('step', { step: 'swap', status: 'skipped', reason: 'no swap', agentId, allocationId }),
    evt('step', { step: 'deposit', status: 'pending', agentId, allocationId }),
  ]
}
function depositCompleted(allocationId, agentId) {
  return evt('completed', { agentId, vault: 'CVAULT', txHash: REAL_TX_HASH, gasMethod: 'relayer', allocationId })
}
function depositFailed(allocationId, agentId, error = 'The Stellar relay returned FAILED.') {
  return evt('failed', { agentId, vault: 'CVAULT', error, allocationId })
}

function receiptFor({ allocations, permission = PERMISSION_FRESH, runId = 'run-1', planFingerprint = '0xplan1' }) {
  return {
    version: 1,
    runId,
    planFingerprint,
    permission: {
      mode: permission.mode,
      status: permission.mode === 'reuse' ? 'reused' : 'confirmed',
      confirmationCount: permission.confirmationCount,
      txHash: permission.txHash,
      grantReceiptFingerprint: permission.grantReceiptFingerprint,
      expiryLedger: permission.expiryLedger,
      agentAddresses: permission.agentAddresses,
    },
    branches: { stellar: { status: 'partial', results: allocations }, base: { status: 'not-planned', results: [] } },
    allocations,
  }
}

function succeededAllocation(allocationId, token = TOKEN_ADDR, decimals = 7, units = '1000000000') {
  return {
    allocationId,
    amount: { token, units, decimals },
    networkContext: { executionNetwork: 'stellar-testnet', currentCustodyNetwork: 'stellar-testnet', transit: false },
    executionStatus: 'succeeded',
    custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW },
    txHash: REAL_TX_HASH,
    error: null,
    evidence: { allocationId, depositTxHash: REAL_TX_HASH },
  }
}

function failedAllocation(allocationId, { heldInAgent = false, token = TOKEN_ADDR, decimals = 7, units = '1000000000' } = {}) {
  return {
    allocationId,
    amount: { token, units, decimals },
    networkContext: { executionNetwork: 'stellar-testnet', currentCustodyNetwork: null, transit: false },
    executionStatus: 'failed',
    custody: heldInAgent
      ? { location: 'agent', confirmed: true, checkedAt: NOW }
      : { location: 'unknown', confirmed: false, checkedAt: null },
    txHash: null,
    error: 'The Stellar relay returned FAILED.',
    evidence: { allocationId },
  }
}

describe('depositLanePhase (pure adapter)', () => {
  it('fresh mode starts at "creating" with no events at all', () => {
    expect(depositLanePhase('a', 'fresh', [])).toBe('creating')
  })

  it('reuse mode starts at "pending" (the agent already existed) with no events at all', () => {
    expect(depositLanePhase('a', 'reuse', [])).toBe('pending')
  })

  it('never advances on an event for a different allocationId', () => {
    const events = [evt('worker-queued', { allocationId: 'other' }), evt('completed', { allocationId: 'other' })]
    expect(depositLanePhase('a', 'fresh', events)).toBe('creating')
  })

  it('advances exactly one step per matching real event, in order', () => {
    const events = depositQueuedThenStarted('a', 'agent-a', 0)
    expect(depositLanePhase('a', 'fresh', events.slice(0, 1))).toBe('queued')
    expect(depositLanePhase('a', 'fresh', events.slice(0, 2))).toBe('moving')
    expect(depositLanePhase('a', 'fresh', events)).toBe('depositing')
    expect(depositLanePhase('a', 'fresh', [...events, depositCompleted('a', 'agent-a')])).toBe('working')
  })

  it('failure is terminal -- no later event un-fails a lane', () => {
    const events = [...depositQueuedThenStarted('a', 'agent-a', 0), depositFailed('a', 'agent-a')]
    expect(depositLanePhase('a', 'fresh', events)).toBe('failed')
    expect(depositLanePhase('a', 'fresh', [...events, depositCompleted('a', 'agent-a')])).toBe('failed')
  })
})

describe('bridgeLanePhase (pure adapter)', () => {
  it('starts at "ready" with no events', () => {
    expect(bridgeLanePhase([])).toBe('ready')
  })

  it('advances through burning -> awaiting-attestation -> minting -> confirmed on the REAL crossChainFarm.js event names', () => {
    expect(bridgeLanePhase([evt('farm-burn-started', {})])).toBe('burning')
    expect(bridgeLanePhase([evt('farm-burn-started', {}), evt('farm-burn-confirmed', {})])).toBe(
      'awaiting-attestation'
    )
    expect(
      bridgeLanePhase([evt('farm-burn-started', {}), evt('farm-burn-confirmed', {}), evt('farm-relay-dispatched', {})])
    ).toBe('minting')
    expect(
      bridgeLanePhase([
        evt('farm-burn-started', {}),
        evt('farm-burn-confirmed', {}),
        evt('farm-relay-dispatched', {}),
        evt('farm-completed', { status: 'done' }),
      ])
    ).toBe('confirmed')
  })

  it('a farm-completed with status "error" fails the lane, never silently completes it', () => {
    expect(
      bridgeLanePhase([evt('farm-burn-started', {}), evt('farm-burn-confirmed', {}), evt('farm-completed', { status: 'error' })])
    ).toBe('failed')
  })

  it('farm-failed and baseleg-failed both fail the lane', () => {
    expect(bridgeLanePhase([evt('farm-burn-started', {}), evt('farm-failed', { stage: 'relay' })])).toBe('failed')
    expect(bridgeLanePhase([evt('baseleg-failed', { stage: 'mandate' })])).toBe('failed')
  })

  it('a farm-completed with status "pending" (poll exhausted) never advances to confirmed or failed', () => {
    expect(
      bridgeLanePhase([
        evt('farm-burn-started', {}),
        evt('farm-burn-confirmed', {}),
        evt('farm-relay-dispatched', {}),
        evt('farm-completed', { status: 'pending' }),
      ])
    ).toBe('minting')
  })
})

describe('StartStage -- no lane advances without the matching event/milestone', () => {
  it('stays at "Creating" with zero events, even after real time passes -- never a timer', () => {
    vi.useFakeTimers()
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} />)
    expect(screen.getAllByText('Creating')).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(screen.getAllByText('Creating')).toHaveLength(2)
    vi.useRealTimers()
  })

  it('an event for one allocation never advances its sibling', () => {
    const events = depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0)
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    expect(screen.getByText('Depositing')).toBeTruthy()
    expect(screen.getByText('Creating')).toBeTruthy() // sibling untouched
  })
})

describe('StartStage -- queue order is visible and not simultaneous', () => {
  it('one worker reaching "moving" while its sibling is still only "queued" renders both, distinctly', () => {
    const events = [
      evt('worker-queued', { allocationId: 'run-1:deposit:0', queueIndex: 0 }),
      evt('worker-queued', { allocationId: 'run-1:deposit:1', queueIndex: 1 }),
      evt('worker-started', { allocationId: 'run-1:deposit:0', queueIndex: 0 }),
    ]
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    expect(screen.getByText('Moving allocation')).toBeTruthy()
    expect(screen.getByText('Queued')).toBeTruthy()
  })
})

describe('StartStage -- successful siblings remain confirmed when one fails', () => {
  it('agent 0 completes, agent 1 fails afterward -- agent 0 stays Working', () => {
    const events = [
      ...depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0),
      depositCompleted('run-1:deposit:0', 'agent-0'),
      ...depositQueuedThenStarted('run-1:deposit:1', 'agent-1', 1),
      depositFailed('run-1:deposit:1', 'agent-1'),
    ]
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('a receipt confirming one allocation succeeded and the other failed keeps both distinct, never regressing the succeeded one', () => {
    const receipt = receiptFor({
      allocations: [succeededAllocation('run-1:deposit:0'), failedAllocation('run-1:deposit:1')],
    })
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Unmoved')).toBeTruthy()
  })

  it('a held (stranded-in-agent) failure shows "Held", never "Unmoved"', () => {
    const receipt = receiptFor({
      allocations: [succeededAllocation('run-1:deposit:0'), failedAllocation('run-1:deposit:1', { heldInAgent: true })],
    })
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(screen.getByText('Held')).toBeTruthy()
    expect(screen.queryByText('Unmoved')).toBeNull()
  })
})

describe('StartStage -- retry only appears when system state supports it', () => {
  it('offers no Retry while the run is only live (no receipt yet), even for a failed lane', () => {
    const events = [...depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0), depositFailed('run-1:deposit:0', 'agent-0')]
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry with the exact failed allocationId and reconciled custody once the receipt confirms failure', () => {
    const onRetryAllocation = vi.fn()
    const receipt = receiptFor({
      allocations: [succeededAllocation('run-1:deposit:0'), failedAllocation('run-1:deposit:1', { heldInAgent: true })],
    })
    render(
      <StartStage
        plan={PLAN_TWO_DEPOSITS}
        permission={PERMISSION_FRESH}
        events={[]}
        receipt={receipt}
        onRetryAllocation={onRetryAllocation}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryAllocation).toHaveBeenCalledWith('run-1:deposit:1', { location: 'agent', confirmed: true, checkedAt: NOW })
  })

  it('never offers Retry for a succeeded allocation', () => {
    const receipt = receiptFor({ allocations: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')] })
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('StartStage -- bridge lane: one mark, all Base child destinations, correct network route/custody', () => {
  it('shows one AgentMark for the bridge leg and lists every child destination inside it', () => {
    render(<StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[]} />)
    expect(screen.getAllByRole('img', { name: /^B agent/ })).toHaveLength(1)
    expect(screen.getByText(/aave-v3/)).toBeTruthy()
    expect(screen.getByText(/moonwell/)).toBeTruthy()
  })

  it('advances the bridge lane through the real crossChainFarm.js sequence, showing the matching network-route transit copy at each step', () => {
    const { rerender } = render(<StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[]} />)
    expect(screen.getByText('Ready')).toBeTruthy()

    rerender(<StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[evt('farm-burn-started', {})]} />)
    expect(screen.getByText('Burning on Stellar')).toBeTruthy()
    expect(screen.getByText(/Bridging from Stellar testnet/)).toBeTruthy()

    rerender(
      <StartStage
        plan={PLAN_WITH_BRIDGE}
        permission={PERMISSION_FRESH}
        events={[evt('farm-burn-started', {}), evt('farm-burn-confirmed', {})]}
      />
    )
    // Both the lane's own phase label AND NetworkIdentity.jsx's transit copy say "Awaiting
    // attestation" verbatim (NetworkIdentity.jsx:65) -- a deliberate, honest duplication, not a
    // defect, so this asserts on the count rather than a single unique match.
    expect(screen.getAllByText('Awaiting attestation').length).toBeGreaterThanOrEqual(1)

    rerender(
      <StartStage
        plan={PLAN_WITH_BRIDGE}
        permission={PERMISSION_FRESH}
        events={[evt('farm-burn-started', {}), evt('farm-burn-confirmed', {}), evt('farm-relay-dispatched', {})]}
      />
    )
    expect(screen.getByText('Minting on Base')).toBeTruthy()
    expect(screen.getByText(/Minting on Base Sepolia/)).toBeTruthy()

    rerender(
      <StartStage
        plan={PLAN_WITH_BRIDGE}
        permission={PERMISSION_FRESH}
        events={[
          evt('farm-burn-started', {}),
          evt('farm-burn-confirmed', {}),
          evt('farm-relay-dispatched', {}),
          evt('farm-completed', { status: 'done' }),
        ]}
      />
    )
    expect(screen.getByText('Proxy custody')).toBeTruthy()
    expect(screen.getByText(/Arrived on Base Sepolia/)).toBeTruthy()
  })

  it('a bridge failure keeps a per-child Retry action with the exact failed child allocationId', () => {
    const onRetryAllocation = vi.fn()
    const receipt = receiptFor({
      runId: 'run-2',
      planFingerprint: '0xplan2',
      allocations: [
        {
          allocationId: 'run-2:bridge:aave-v3',
          amount: { token: 'USDC', units: '600000', decimals: 6 },
          networkContext: { executionNetwork: 'stellar-testnet', destinationNetwork: 'base-sepolia', currentCustodyNetwork: 'base-sepolia', transit: false },
          executionStatus: 'succeeded',
          custody: { location: 'base-proxy', confirmed: true, checkedAt: NOW },
          txHash: '0xmint-a',
          error: null,
          evidence: {},
        },
        {
          allocationId: 'run-2:bridge:moonwell',
          amount: { token: 'USDC', units: '400000', decimals: 6 },
          networkContext: { executionNetwork: 'stellar-testnet', destinationNetwork: 'base-sepolia', currentCustodyNetwork: null, transit: false },
          executionStatus: 'failed',
          custody: { location: 'agent', confirmed: true, checkedAt: NOW },
          txHash: null,
          error: 'Base leg failed.',
          evidence: {},
        },
      ],
    })
    render(
      <StartStage
        plan={PLAN_WITH_BRIDGE}
        permission={PERMISSION_FRESH}
        events={[]}
        receipt={receipt}
        onRetryAllocation={onRetryAllocation}
      />
    )
    expect(screen.getByText('Failed')).toBeTruthy() // the bridge lane's own aggregate phase label
    expect(screen.getByText('Recovery available')).toBeTruthy() // moonwell held in the bridge agent
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryAllocation).toHaveBeenCalledWith('run-2:bridge:moonwell', { location: 'agent', confirmed: true, checkedAt: NOW })
  })

  it('an in-transit (still-pending) child never claims Proxy custody', () => {
    const receipt = receiptFor({
      runId: 'run-2',
      planFingerprint: '0xplan2',
      allocations: [
        {
          allocationId: 'run-2:bridge:aave-v3',
          amount: { token: 'USDC', units: '600000', decimals: 6 },
          networkContext: {},
          executionStatus: 'pending',
          custody: { location: 'in-transit', confirmed: false, checkedAt: null },
          txHash: null,
          error: null,
          evidence: {},
        },
        {
          allocationId: 'run-2:bridge:moonwell',
          amount: { token: 'USDC', units: '400000', decimals: 6 },
          networkContext: {},
          executionStatus: 'succeeded',
          custody: { location: 'base-proxy', confirmed: true, checkedAt: NOW },
          txHash: '0xmint-b',
          error: null,
          evidence: {},
        },
      ],
    })
    render(<StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(screen.getByText('In transit')).toBeTruthy()
    expect(screen.queryByText('Proxy custody')).toBeNull()
  })
})

describe('StartStage -- live region batches updates rather than announcing every micro-event', () => {
  it('the announcement text does not change across worker.js sub-steps that stay in the same coarse phase', () => {
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[evt('worker-queued', { allocationId: 'run-1:deposit:0' }), evt('worker-started', { allocationId: 'run-1:deposit:0' })]} />)
    const region = document.querySelector('[role="status"][aria-live="polite"]')
    const firstText = region.textContent
    // Two more sub-events (key-setup done, swap skipped) that both stay inside the SAME coarse
    // 'moving' bucket -- the announcement must not change for either.
    const { rerender } = render(<div />)
    rerender(
      <StartStage
        plan={PLAN_TWO_DEPOSITS}
        permission={PERMISSION_FRESH}
        events={[
          evt('worker-queued', { allocationId: 'run-1:deposit:0' }),
          evt('worker-started', { allocationId: 'run-1:deposit:0' }),
          evt('step', { step: 'key-setup', status: 'done', allocationId: 'run-1:deposit:0' }),
          evt('step', { step: 'swap', status: 'skipped', allocationId: 'run-1:deposit:0' }),
        ]}
      />
    )
    const region2 = document.querySelector('[role="status"][aria-live="polite"]')
    expect(region2.textContent).toBe(firstText)
  })
})

describe('StartStage -- once settled, composes StrategyReceipt with the primary/secondary actions', () => {
  it('renders View my money as primary and Make another deposit as secondary once the receipt exists', () => {
    const receipt = receiptFor({ allocations: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')] })
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} runId="run-1" />)
    const primary = screen.getByRole('button', { name: 'View my money' })
    const secondary = screen.getByRole('button', { name: 'Make another deposit' })
    expect(primary.className).toContain('pc-button--primary')
    expect(secondary.className).toContain('pc-button--secondary')
  })

  it('shows no receipt/actions while the run is still live', () => {
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} />)
    expect(screen.queryByRole('button', { name: 'View my money' })).toBeNull()
  })
})

describe('StartStage -- grant/agent explorer links stay inside Technical details, not the friendly lane copy', () => {
  it('a completed lane shows no raw tx hash outside its own collapsed Technical details', () => {
    const events = [...depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0), depositCompleted('run-1:deposit:0', 'agent-0')]
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    // The hash lives inside a <details> (closed by default). jsdom applies no layout, so the
    // structural presence check that matters is: no element's OWN text is the bare hash outside
    // the disclosure (it only ever appears as part of a longer "Transaction: <hash>" line) --
    // opening the disclosure and matching the fuller string proves it is genuinely there.
    expect(screen.queryByText(REAL_TX_HASH)).toBeNull()
    fireEvent.click(screen.getByText('Agent 1 technical details'))
    expect(screen.getByText(new RegExp(REAL_TX_HASH))).toBeTruthy()
  })
})

describe('StartStage -- reuse mode never claims agent creation', () => {
  it('reuse mode starts lanes at "Preparing", never "Creating"', () => {
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_REUSE} events={[]} />)
    expect(screen.getAllByText('Preparing')).toHaveLength(2)
    expect(screen.queryByText('Creating')).toBeNull()
  })
})

describe('StartStage -- no inline style or inline animation (rejection checklist item 6)', () => {
  it('the JSX source has zero inline style/animation', () => {
    const source = fs.readFileSync(path.resolve(here, './StartStage.jsx'), 'utf8')
    expect(source).not.toMatch(/style=/)
    // 'animation' does appear as an English word in comments about GSAP/CSS transitions is fine in
    // strategy.css, but the JSX source itself must never set an inline animation.
    expect(source).not.toMatch(/style\s*=\s*\{\{[^}]*animation/i)
  })

  it('strategy.css defines no NEW @keyframes or gradient declarations', () => {
    const css = fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8')
    expect(css).not.toMatch(/@keyframes/i)
    expect(css).not.toMatch(/gradient/i)
  })
})

describe('StartStage -- reduced motion', () => {
  it('renders correctly with prefers-reduced-motion (vitest.setup.js already stubs matchMedia to non-matching by default; this asserts the surface still renders every lane)', () => {
    render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} />)
    expect(screen.getAllByText('Creating')).toHaveLength(2)
  })
})

describe('StartStage -- axe', () => {
  it('has zero violations mid-run', async () => {
    const events = depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0)
    const { container } = render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on partial failure', async () => {
    const receipt = receiptFor({ allocations: [succeededAllocation('run-1:deposit:0'), failedAllocation('run-1:deposit:1')] })
    const { container } = render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations once complete with the receipt shown', async () => {
    const receipt = receiptFor({ allocations: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')] })
    const { container } = render(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on the mixed bridge run', async () => {
    const { container } = render(<StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[evt('farm-burn-started', {})]} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// Real-layout 320px guard -- same mechanism as ProtectStage.test.jsx's guard (jsdom never runs
// layout: no scrollWidth, no grid-track sizing, no min-content). Launches a real Chromium binary
// against the REAL shipped style.css + pocket-crew.css + strategy.css. Measured separately for
// every DISTINCT Start/receipt state (Task 10 lost a round to a 320px overflow measured in the
// wrong phase; Task 11 shipped two more from long identifiers -- this file renders agent addresses,
// allocationIds, and explorer links, so every state gets its own real-browser measurement).
const REAL_STYLESHEET = [
  fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8'),
  fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8'),
].join('\n')
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
  throw new Error(`320px layout guard: no usable Chromium binary found (${lastErr?.message})`)
}

async function measureScrollWidthAt320(bodyHtml) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 320, height: 1400 })
    await page.setContent(buildLayoutHarnessHtml(bodyHtml))
    return await page.evaluate(() => document.documentElement.scrollWidth)
  } finally {
    await browser.close()
  }
}

function renderInRoute(node) {
  return render(
    <div className="pc-route">
      <div className="pc-route-stack">{node}</div>
    </div>
  )
}

describe('StartStage -- 320px real layout guard', () => {
  it(
    'G: two deposit lanes mid-run, at DIFFERENT phases simultaneously (queued + moving), create no horizontal overflow at 320px',
    async () => {
      const events = [
        evt('worker-queued', { allocationId: 'run-1:deposit:0', queueIndex: 0 }),
        evt('worker-queued', { allocationId: 'run-1:deposit:1', queueIndex: 1 }),
        evt('worker-started', { allocationId: 'run-1:deposit:0', queueIndex: 0 }),
      ]
      const { container } = renderInRoute(<StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} />)
      const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
      expect(scrollWidth).toBe(320)
    },
    20000
  )

  it(
    'G: a partial-failure state (one Held custody lane, one completed lane with expanded Technical details showing a real tx hash) creates no horizontal overflow at 320px',
    async () => {
      const events = [...depositQueuedThenStarted('run-1:deposit:0', 'agent-0', 0), depositCompleted('run-1:deposit:0', 'agent-0')]
      const receipt = receiptFor({
        allocations: [succeededAllocation('run-1:deposit:0'), failedAllocation('run-1:deposit:1', { heldInAgent: true })],
      })
      const { container } = renderInRoute(
        <StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={events} receipt={receipt} />
      )
      fireEvent.click(screen.getByText('Agent 1 technical details'))
      const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
      expect(scrollWidth).toBe(320)
    },
    20000
  )

  it(
    'G: the bridge lane with every child destination listed AND a failed child\'s Recovery action creates no horizontal overflow at 320px',
    async () => {
      const receipt = receiptFor({
        runId: 'run-2',
        planFingerprint: '0xplan2',
        allocations: [
          {
            allocationId: 'run-2:bridge:aave-v3',
            amount: { token: 'USDC', units: '600000', decimals: 6 },
            networkContext: {},
            executionStatus: 'succeeded',
            custody: { location: 'base-proxy', confirmed: true, checkedAt: NOW },
            txHash: '0x' + 'a1b2c3d4'.repeat(8),
            error: null,
            evidence: {},
          },
          {
            allocationId: 'run-2:bridge:moonwell',
            amount: { token: 'USDC', units: '400000', decimals: 6 },
            networkContext: {},
            executionStatus: 'failed',
            custody: { location: 'agent', confirmed: true, checkedAt: NOW },
            txHash: null,
            error: 'Base leg failed.',
            evidence: {},
          },
        ],
      })
      const { container } = renderInRoute(
        <StartStage plan={PLAN_WITH_BRIDGE} permission={PERMISSION_FRESH} events={[]} receipt={receipt} />
      )
      const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
      expect(scrollWidth).toBe(320)
    },
    20000
  )

  it(
    'G: the fully-complete state (lanes + composed StrategyReceipt, Technical details expanded with a full agent address) creates no horizontal overflow at 320px',
    async () => {
      const receipt = receiptFor({
        allocations: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')],
      })
      const { container } = renderInRoute(
        <StartStage plan={PLAN_TWO_DEPOSITS} permission={PERMISSION_FRESH} events={[]} receipt={receipt} runId="run-1" />
      )
      fireEvent.click(document.querySelector('.pc-technical-details summary'))
      const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
      expect(scrollWidth).toBe(320)
    },
    20000
  )
})

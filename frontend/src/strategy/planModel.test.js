import { describe, it, expect } from 'vitest'
import {
  RISK_PROFILES,
  normalizeStrategyPlan,
  expandAgentSlots,
  buildStrategyViewModel,
  toDispatchStrategy,
} from './planModel.js'
import { normalizeVenue } from './venueTruth.js'

const STELLAR_DESTINATION = normalizeVenue({}).destination
const U = (usdc) => BigInt(Math.round(usdc * 1e7)) // Stellar 7dp base units
const B = (usdc) => BigInt(Math.round(usdc * 1e6)) // Base 6dp base units

const baseChild = (over = {}) => ({
  address: '0x389250872044368759D3db5C09b2706A6628d4e0',
  proxyTarget: 'aave-v3',
  factSlug: 'aave-v3-base',
  chain: 'base',
  units: B(40),
  decimals: 6,
  ...over,
})

describe('RISK_PROFILES', () => {
  it('matches the exact required shape', () => {
    expect(RISK_PROFILES).toEqual({
      low: { label: 'Steady', targetSlots: 1 },
      med: { label: 'Balanced', targetSlots: 2 },
      high: { label: 'Adventurous', targetSlots: 3 },
    })
  })
})

describe('expandAgentSlots', () => {
  // Required test 1
  it('creates 1/2/3 independently scoped deposit agents for Steady/Balanced/Adventurous, all at the one Autofarm address', () => {
    for (const [risk, expected] of [
      ['low', 1],
      ['med', 2],
      ['high', 3],
    ]) {
      const agents = expandAgentSlots({
        runId: 'run-1',
        risk,
        stellarUnits: U(300),
        destination: STELLAR_DESTINATION,
      })
      expect(agents).toHaveLength(expected)
      agents.forEach((a) => {
        expect(a.kind).toBe('deposit')
        expect(a.destination).toBe(STELLAR_DESTINATION)
        expect(a.hostNetworkId).toBe('stellar-testnet')
      })
      // independently scoped: distinct allocationIds
      expect(new Set(agents.map((a) => a.allocationId)).size).toBe(expected)
    }
  })

  // Required test 2
  it('sums allocations exactly to the input units with deterministic remainder assignment; no agent receives zero', () => {
    const total = U(100) + 1n // deliberately not evenly divisible by 3
    const agents = expandAgentSlots({ runId: 'run-2', risk: 'high', stellarUnits: total })
    expect(agents).toHaveLength(3)
    const sum = agents.reduce((s, a) => s + BigInt(a.allocation.units), 0n)
    expect(sum).toBe(total)
    agents.forEach((a) => expect(BigInt(a.allocation.units)).toBeGreaterThan(0n))
    // remainder goes to the earliest stable IDs (slot 0 first)
    const units = agents.map((a) => BigInt(a.allocation.units))
    expect(units[0]).toBeGreaterThanOrEqual(units[units.length - 1])
  })

  // Required test 3
  it('collapses one or more Base destination allocations into one real bridge agent with N children', () => {
    const agents = expandAgentSlots({
      runId: 'run-3',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [
        baseChild({
          proxyTarget: 'aave-v3',
          address: '0x389250872044368759D3db5C09b2706A6628d4e0',
        }),
        baseChild({
          proxyTarget: 'morpho-blue',
          address: '0x5E843A639F0555E2A6669601621befC887Bdb479',
        }),
      ],
    })
    const bridges = agents.filter((a) => a.kind === 'bridge')
    expect(bridges).toHaveLength(1)
    expect(bridges[0].children).toHaveLength(2)
  })

  // Required test 4
  it('a mixed three-slot Adventurous plan uses one bridge slot and at most two Stellar agents', () => {
    const agents = expandAgentSlots({
      runId: 'run-4',
      risk: 'high',
      stellarUnits: U(600),
      baseAllocations: [baseChild()],
    })
    const bridges = agents.filter((a) => a.kind === 'bridge')
    const deposits = agents.filter((a) => a.kind === 'deposit')
    expect(bridges).toHaveLength(1)
    expect(deposits.length).toBeLessThanOrEqual(2)
    expect(agents.length).toBeLessThanOrEqual(3)
  })

  // Required test 5
  it('a Base-only plan has one real bridge agent, not three decorative workers', () => {
    const agents = expandAgentSlots({
      runId: 'run-5',
      risk: 'high', // targetSlots = 3
      stellarUnits: 0n,
      baseAllocations: [baseChild()],
    })
    expect(agents).toHaveLength(1)
    expect(agents[0].kind).toBe('bridge')
  })

  // Required test 7 (stable IDs)
  it('derives stable IDs from plan/run inputs and destination kind, not array render order', () => {
    const a = baseChild({
      proxyTarget: 'aave-v3',
      address: '0xAAA0000000000000000000000000000000000a',
    })
    const b = baseChild({
      proxyTarget: 'morpho-blue',
      address: '0xBBB0000000000000000000000000000000000b',
    })

    const forward = expandAgentSlots({
      runId: 'run-7',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [a, b],
    })
    const reversed = expandAgentSlots({
      runId: 'run-7',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [b, a],
    })

    const idFor = (agents, proxyTarget) =>
      agents[0].children.find((c) => c.proxyTarget === proxyTarget).allocationId

    expect(idFor(forward, 'aave-v3')).toBe(idFor(reversed, 'aave-v3'))
    expect(idFor(forward, 'morpho-blue')).toBe(idFor(reversed, 'morpho-blue'))
    expect(idFor(forward, 'aave-v3')).not.toBe(idFor(forward, 'morpho-blue'))

    // same run/plan inputs -> same IDs (determinism); a different runId -> different IDs.
    const again = expandAgentSlots({
      runId: 'run-7',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [a, b],
    })
    expect(idFor(again, 'aave-v3')).toBe(idFor(forward, 'aave-v3'))
    const otherRun = expandAgentSlots({
      runId: 'run-7b',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [a, b],
    })
    expect(idFor(otherRun, 'aave-v3')).not.toBe(idFor(forward, 'aave-v3'))
  })

  // Required test 8
  it('Base child records always carry proxy/no-yield truth', () => {
    const agents = expandAgentSlots({
      runId: 'run-8',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [baseChild()],
    })
    const child = agents[0].children[0]
    expect(child.venueKind).toBe('base-custody-proxy')
    expect(child.yield).toEqual({ state: 'none', apy: null })
    expect(child.disclosure).toMatch(/custody/i)
  })

  it('never creates more deposit agents than there are units to give each at least one', () => {
    const agents = expandAgentSlots({ runId: 'run-tiny', risk: 'high', stellarUnits: 2n })
    expect(agents).toHaveLength(2)
    agents.forEach((a) => expect(BigInt(a.allocation.units)).toBeGreaterThan(0n))
  })
})

describe('normalizeStrategyPlan', () => {
  // Required test 6
  it('crew count (truth.agentIsolationCount) equals the actual AgentInit count, not the raw targetSlots', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-6',
      risk: 'high', // targetSlots = 3
      stellarUnits: 0n,
      baseAllocations: [baseChild()],
    })
    expect(plan.agents).toHaveLength(1) // Base-only -> one bridge agent
    expect(plan.truth.agentIsolationCount).toBe(1)
    expect(plan.truth.agentIsolationCount).toBe(plan.agents.length)
  })

  it('produces the canonical StrategyPlan shape', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-shape',
      source: 'fallback',
      sourceState: 'deterministic',
      risk: 'med',
      stellarUnits: U(200),
      destination: STELLAR_DESTINATION,
    })
    expect(plan).toMatchObject({
      runId: 'run-shape',
      planFingerprint: null,
      source: 'fallback',
      sourceState: 'deterministic',
      amount: { token: 'USDC', units: U(200).toString(), decimals: 7 },
    })
    expect(plan.truth).toEqual({
      agentIsolationCount: 2,
      stellarVenueCount: 1,
      baseUsesProxyVaults: false,
    })
  })

  it('normalizeStrategyPlan preserves review verbatim', () => {
    const review = { candidates: [{ protocol: 'X', chain: 'stellar', eligible: true, reasons: [] }] }
    // reuse the file's existing minimal valid normalize input fixture, spread review onto it
    const plan = normalizeStrategyPlan({
      runId: 'run-shape',
      source: 'fallback',
      sourceState: 'deterministic',
      risk: 'med',
      stellarUnits: U(200),
      destination: STELLAR_DESTINATION,
      review,
    })
    expect(plan.review).toBe(review)
  })

  it('amount is derived from the expanded agents, so it can never drift from what the crew actually spends', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-derive',
      risk: 'high',
      stellarUnits: U(100) + 1n,
      baseAllocations: [baseChild()],
    })
    const sum = plan.agents.reduce((s, a) => s + BigInt(a.allocation.units), 0n)
    expect(BigInt(plan.amount.units)).toBe(sum)
  })
})

describe('buildStrategyViewModel', () => {
  it('projects canonical units into display-decimal agent rows', () => {
    const plan = normalizeStrategyPlan({ runId: 'run-vm', risk: 'low', stellarUnits: U(150) })
    const vm = buildStrategyViewModel({
      plan,
      risk: 'low',
      stellarVenue: {
        name: 'Vibing Farmer Autofarm',
        protocol: 'blend-usdc',
        apy: 4.8,
        risk: 'low',
      },
    })
    expect(vm.total).toBe(150)
    expect(vm.agents).toHaveLength(1)
    expect(vm.agents[0].allocation).toBe(150)
    expect(vm.agents[0].vault.name).toBe('Vibing Farmer Autofarm')
    expect(vm.agents[0].id).toBe(plan.agents[0].allocationId)
  })

  it('bridge rows carry display-decimal children', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-vm-bridge',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [baseChild()],
    })
    const vm = buildStrategyViewModel({ plan, risk: 'low' })
    expect(vm.agents).toHaveLength(1)
    expect(vm.agents[0].kind).toBe('bridge')
    expect(vm.agents[0].children[0].allocation).toBe(40)
  })
})

describe('toDispatchStrategy', () => {
  it('drops an ineligible agent and recomputes truth counts', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-dispatch',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [baseChild()],
    })
    const bridgeId = plan.agents[0].allocationId
    const dispatch = toDispatchStrategy(plan, { [bridgeId]: { eligible: false } })
    expect(dispatch.agents).toHaveLength(0)
    expect(dispatch.truth).toEqual({
      agentIsolationCount: 0,
      stellarVenueCount: 0,
      baseUsesProxyVaults: false,
    })
  })

  it('keeps an agent whose verdict is missing (defaults eligible)', () => {
    const plan = normalizeStrategyPlan({
      runId: 'run-dispatch-2',
      risk: 'low',
      stellarUnits: U(10),
    })
    const dispatch = toDispatchStrategy(plan, {})
    expect(dispatch.agents).toHaveLength(1)
  })
})

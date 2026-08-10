import { describe, expect, it } from 'vitest'
import { buildCrewPersonas } from './buildCrewPersonas.js'

const ADDRESS_A = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const ADDRESS_B = 'CAVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCVLQ3'
const ADDRESS_C = `C${'C'.repeat(55)}`
const ADDRESS_D = `C${'D'.repeat(55)}`
const ADDRESS_E = `C${'E'.repeat(55)}`

function amount(units, token = 'USDC', decimals = 7) {
  return { token, units, decimals }
}

function indexedRow(address, runOrdinal, overrides = {}) {
  return {
    address,
    creator: 'CINDEXEDCREATOR',
    createdLedger: 100 + (Number.isSafeInteger(runOrdinal) ? runOrdinal : 0),
    createdTxHash: `creation-${address}`,
    runId: `run-${address}`,
    runOrdinal,
    grantTxHash: `grant-${address}`,
    provenance: {
      source: 'router-event',
      providerId: 'live-rpc',
      endpointClass: 'live',
      generation: 'agent-v3',
    },
    discoverySources: ['agent-index-api'],
    scopeReadStatus: 'ok',
    vault: 'CVAULT',
    revoked: false,
    expiry: 0,
    authorized: true,
    cap: amount('9999999999'),
    ...overrides,
  }
}

function hintRow(address, overrides = {}) {
  return {
    address,
    creator: null,
    createdLedger: null,
    createdTxHash: null,
    runId: null,
    runOrdinal: null,
    grantTxHash: null,
    provenance: null,
    discoverySources: ['rpc-router-events'],
    scopeReadStatus: 'ok',
    vault: 'CVAULT',
    revoked: false,
    expiry: 0,
    authorized: true,
    cap: null,
    ...overrides,
  }
}

function discovery(agents, status = 'complete') {
  return {
    status,
    networkId: 'stellar-testnet',
    owner: 'GOWNER',
    agents,
    coverage: null,
    hints: {
      localCacheCount: 0,
      rpcEventCount: 0,
      registryCount: 0,
      vaultVerifiedCount: 0,
      unverifiedCandidateCount: 0,
    },
  }
}

function moneyAgent(address, overrides = {}) {
  const oneUsdc = amount('10000000')
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
      checkedAt: 1,
    },
    vaultShares: { state: 'known', amount: oneUsdc, checkedAt: 1 },
    idleToken: { state: 'known', amount: amount('0'), checkedAt: 1 },
    amount: oneUsdc,
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [{ location: 'stellar-vault', amount: oneUsdc }],
    problems: [],
    ...overrides,
  }
}

function stellarLeg(units, token = 'USDC', decimals = 7) {
  return { location: 'stellar-vault', amount: amount(units, token, decimals) }
}

function baseLeg(units, overrides = {}) {
  return {
    location: 'base-proxy',
    amount: units == null ? null : amount(units),
    kernelAddress: '0xKeRnEl',
    poolAddress: '0xPoOl',
    asset: '0xUSDC',
    poolName: 'Aave v3',
    coverageReason: null,
    ...overrides,
  }
}

function childAddresses(persona) {
  return persona.children.map((child) => child.agent.address)
}

function moneyEnvelope(agents, overrides = {}) {
  return {
    status: 'complete',
    owner: 'GOWNER',
    networkId: 'stellar-testnet',
    agents,
    baseGroups: [],
    associationCoverage: { state: 'complete', reasons: [] },
    baseSourceCoverage: { state: 'complete' },
    basePositionCoverage: { state: 'complete', reasons: [] },
    ...overrides,
  }
}

describe('buildCrewPersonas — indexed grouping', () => {
  it('1. creates exactly the three catalog personas for indexed ordinals 0, 1, and 2', () => {
    const out = buildCrewPersonas({
      discovery: discovery([
        indexedRow(ADDRESS_A, 0),
        indexedRow(ADDRESS_B, 1),
        indexedRow(ADDRESS_C, 2),
      ]),
      moneyAgents: [moneyAgent(ADDRESS_A), moneyAgent(ADDRESS_B), moneyAgent(ADDRESS_C)],
    })

    expect(
      out.personas.map(({ id, children }) => ({ id, addresses: childAddresses({ children }) }))
    ).toEqual([
      { id: 'sprout', addresses: [ADDRESS_A] },
      { id: 'clover', addresses: [ADDRESS_B] },
      { id: 'mochi', addresses: [ADDRESS_C] },
    ])
    expect(out.personas).toHaveLength(3)
    expect(out.productiveAgentCount).toBe(3)
    expect(out.activeCount).toBe(3)
  })

  it('2. wraps ordinals 3 and 4 to Sprout and Clover without creating extra cards', () => {
    const rows = [
      indexedRow(ADDRESS_A, 0),
      indexedRow(ADDRESS_B, 1),
      indexedRow(ADDRESS_C, 2),
      indexedRow(ADDRESS_D, 3),
      indexedRow(ADDRESS_E, 4),
    ]
    const out = buildCrewPersonas({
      discovery: discovery(rows),
      moneyAgents: rows.map((row) => moneyAgent(row.address)),
    })

    expect(out.personas).toHaveLength(3)
    expect(childAddresses(out.personas[0])).toEqual([ADDRESS_A, ADDRESS_D])
    expect(childAddresses(out.personas[1])).toEqual([ADDRESS_B, ADDRESS_E])
    expect(childAddresses(out.personas[2])).toEqual([ADDRESS_C])
  })

  it('3. keeps the literal address-to-persona mapping stable when both inputs are reordered', () => {
    const rows = [indexedRow(ADDRESS_A, 4), indexedRow(ADDRESS_B, 2), indexedRow(ADDRESS_C, 3)]
    const out = buildCrewPersonas({
      discovery: discovery([...rows].reverse()),
      moneyAgents: [moneyAgent(ADDRESS_B), moneyAgent(ADDRESS_C), moneyAgent(ADDRESS_A)],
    })
    const mapping = Object.fromEntries(
      out.personas.flatMap((persona) =>
        persona.children.map((child) => [child.agent.address, persona.id])
      )
    )

    expect(mapping).toEqual({
      [ADDRESS_A]: 'clover',
      [ADDRESS_B]: 'mochi',
      [ADDRESS_C]: 'sprout',
    })
  })
})

describe('buildCrewPersonas — exact productive totals', () => {
  it('4. sums two Sprout Stellar legs with exact integer units', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0), indexedRow(ADDRESS_D, 3)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('1000000000'),
          vaultShares: { state: 'known', amount: amount('1000000000'), checkedAt: 1 },
          custodyBreakdown: [stellarLeg('1000000000')],
        }),
        moneyAgent(ADDRESS_D, {
          amount: amount('500000000'),
          vaultShares: { state: 'known', amount: amount('500000000'), checkedAt: 1 },
          custodyBreakdown: [stellarLeg('500000000')],
        }),
      ],
    })

    expect(out.personas[0].totals).toEqual([{ token: 'USDC', units: '1500000000', decimals: 7 }])
    expect(out.totals).toEqual([{ token: 'USDC', units: '1500000000', decimals: 7 }])
  })

  it('5. retains a failed execution with productive custody and excludes failed agent custody', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0), indexedRow(ADDRESS_B, 1)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('700000000'),
          executionStatus: 'failed',
          custodyBreakdown: [stellarLeg('700000000')],
        }),
        moneyAgent(ADDRESS_B, {
          amount: amount('900000000'),
          executionStatus: 'failed',
          custody: { location: 'agent' },
          custodyBreakdown: [{ location: 'agent', amount: amount('900000000') }],
        }),
      ],
    })

    expect(childAddresses(out.personas[0])).toEqual([ADDRESS_A])
    expect(childAddresses(out.personas[1])).toEqual([])
    expect(out.productiveAgentCount).toBe(1)
    expect(out.activeCount).toBe(1)
    expect(out.totals).toEqual([{ token: 'USDC', units: '700000000', decimals: 7 }])
  })

  it('6. totals only a split child’s productive legs and exposes its idle agent balance', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('9000000000'),
          custody: { location: 'unknown' },
          custodyBreakdown: [
            stellarLeg('1000000000'),
            { location: 'agent', amount: amount('250000000') },
            baseLeg('500000000'),
          ],
        }),
      ],
    })
    const child = out.personas[0].children[0]

    expect(child.workingLegs.map((leg) => leg.location)).toEqual(['stellar-vault', 'base-proxy'])
    expect(child.workingTotals).toEqual([{ token: 'USDC', units: '1500000000', decimals: 7 }])
    expect(child.idleAmount).toEqual({ token: 'USDC', units: '250000000', decimals: 7 })
    expect(child.hasWithdrawableStellar).toBe(true)
    expect(out.totals).toEqual([{ token: 'USDC', units: '1500000000', decimals: 7 }])
  })

  it('keeps token/decimal disagreements as separate exact totals', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0), indexedRow(ADDRESS_D, 3)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('123456789', 'USDC', 7),
          custodyBreakdown: [stellarLeg('123456789', 'USDC', 7)],
        }),
        moneyAgent(ADDRESS_D, {
          amount: amount('7654321', 'USDC', 6),
          custodyBreakdown: [stellarLeg('7654321', 'USDC', 6)],
        }),
      ],
    })

    expect(out.personas[0].totals).toEqual([
      { token: 'USDC', units: '7654321', decimals: 6 },
      { token: 'USDC', units: '123456789', decimals: 7 },
    ])
  })
})

describe('buildCrewPersonas — global Base deduplication', () => {
  it('7. counts a shared Base position once on the oldest indexed child across personas', () => {
    const out = buildCrewPersonas({
      discovery: discovery([
        indexedRow(ADDRESS_A, 0, { createdLedger: 200 }),
        indexedRow(ADDRESS_B, 1, { createdLedger: 100 }),
      ]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('700000000'),
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('700000000')],
        }),
        moneyAgent(ADDRESS_B, {
          amount: amount('700000000'),
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('700000000')],
        }),
      ],
    })
    const newer = out.personas[0].children[0].workingLegs[0]
    const oldest = out.personas[1].children[0].workingLegs[0]

    expect(newer.key).toBe('stellar-testnet:base:0xkernel:0xpool:0xUSDC')
    expect(newer).toMatchObject({ shared: true, counted: false })
    expect(oldest).toMatchObject({ shared: true, counted: true })
    expect(out.personas[0].totals).toEqual([])
    expect(out.personas[1].totals).toEqual([{ token: 'USDC', units: '700000000', decimals: 7 }])
    expect(out.totals).toEqual([{ token: 'USDC', units: '700000000', decimals: 7 }])
  })

  it('uses a valid ordinal before an address tie-break when ledgers are equal', () => {
    const out = buildCrewPersonas({
      discovery: discovery([
        indexedRow(ADDRESS_A, null, { createdLedger: 100 }),
        indexedRow(ADDRESS_B, 1, { createdLedger: 100 }),
      ]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('800000000')],
        }),
        moneyAgent(ADDRESS_B, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('800000000')],
        }),
      ],
    })
    const countedAddress = out.personas
      .flatMap((persona) => persona.children)
      .find((child) => child.workingLegs[0].counted).agent.address

    expect(countedAddress).toBe(ADDRESS_B)
  })

  it('uses the exact address as the final shared-Base owner tie-break', () => {
    const out = buildCrewPersonas({
      discovery: discovery([
        indexedRow(ADDRESS_B, null, { createdLedger: 100 }),
        indexedRow(ADDRESS_A, null, { createdLedger: 100 }),
      ]),
      moneyAgents: [
        moneyAgent(ADDRESS_B, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('600000000')],
        }),
        moneyAgent(ADDRESS_A, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('600000000')],
        }),
      ],
    })
    const countedAddress = out.personas
      .flatMap((persona) => persona.children)
      .find((child) => child.workingLegs[0].counted).agent.address

    expect(countedAddress).toBe(ADDRESS_A)
  })

  it('uses the owner-wide 100 USDC group once instead of summing or choosing its 30/70 reports', () => {
    const agents = [
      moneyAgent(ADDRESS_A, {
        amount: amount('300000000'),
        custody: { location: 'base-proxy' },
        custodyBreakdown: [baseLeg('300000000', { asset: 'USDC' })],
      }),
      moneyAgent(ADDRESS_B, {
        amount: amount('700000000'),
        custody: { location: 'base-proxy' },
        custodyBreakdown: [baseLeg('700000000', { asset: 'USDC' })],
      }),
    ]
    const out = buildCrewPersonas({
      discovery: discovery([
        indexedRow(ADDRESS_A, 0, { createdLedger: 200 }),
        indexedRow(ADDRESS_B, 1, { createdLedger: 100 }),
      ]),
      moneyRead: moneyEnvelope(agents, {
        basePositionCoverage: { state: 'unknown', reasons: ['unavailable'] },
        baseGroups: [
          {
            groupKey: '84532:0xkernel:0xpool:usdc',
            kernelAddress: '0xkernel',
            poolAddress: '0xpool',
            asset: 'usdc',
            amount: amount('1000000000'),
            coverage: { state: 'partial', problems: ['base-read-unavailable'] },
          },
        ],
      }),
    })
    const newer = out.personas[0].children[0].workingLegs[0]
    const oldest = out.personas[1].children[0].workingLegs[0]

    expect(newer).toMatchObject({ shared: true, counted: false, amount: amount('300000000') })
    expect(oldest).toMatchObject({
      shared: true,
      counted: true,
      amount: amount('1000000000'),
    })
    expect(out.personas[0].totals).toEqual([])
    expect(out.personas[1].totals).toEqual([amount('1000000000')])
    expect(out.totals).toEqual([amount('1000000000')])
    expect(out.status).toBe('partial')
    expect(out.personas.map((persona) => persona.totalState)).toEqual([
      'partial',
      'partial',
      'partial',
    ])
  })

  it.each([
    ['associationCoverage', { state: 'unknown', reasons: ['unavailable'] }],
    ['baseSourceCoverage', { state: 'unknown' }],
    ['basePositionCoverage', { state: 'partial', reasons: ['unavailable'] }],
  ])(
    'keeps the known group value but fails Crew and persona totals closed on %s',
    (axis, value) => {
      const agent = moneyAgent(ADDRESS_A, {
        amount: amount('500000000'),
        custody: { location: 'base-proxy' },
        custodyBreakdown: [baseLeg('500000000', { asset: 'USDC' })],
      })
      const out = buildCrewPersonas({
        discovery: discovery([indexedRow(ADDRESS_A, 0)]),
        moneyRead: moneyEnvelope([agent], {
          [axis]: value,
          baseGroups: [
            {
              groupKey: '84532:0xkernel:0xpool:usdc',
              kernelAddress: '0xkernel',
              poolAddress: '0xpool',
              asset: 'usdc',
              amount: amount('500000000'),
              coverage: { state: 'complete', problems: [] },
            },
          ],
        }),
      })

      expect(out.totals).toEqual([amount('500000000')])
      expect(out.status).toBe('partial')
      expect(out.personas.map((persona) => persona.totalState)).toEqual([
        'partial',
        'partial',
        'partial',
      ])
    }
  )

  it('never substitutes per-agent Base reports when authoritative group evidence is missing', () => {
    const agent = moneyAgent(ADDRESS_A, {
      amount: amount('500000000'),
      custody: { location: 'base-proxy' },
      custodyBreakdown: [baseLeg('500000000', { asset: 'USDC' })],
    })
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyRead: moneyEnvelope([agent]),
    })

    expect(out.personas[0].children[0].workingLegs[0]).toMatchObject({
      amount: amount('500000000'),
      counted: false,
    })
    expect(out.personas[0].totals).toEqual([])
    expect(out.totals).toEqual([])
    expect(out.status).toBe('partial')
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('fails closed on internally inconsistent authoritative group coverage', () => {
    const agent = moneyAgent(ADDRESS_A, {
      amount: amount('500000000'),
      custody: { location: 'base-proxy' },
      custodyBreakdown: [baseLeg('500000000', { asset: 'USDC' })],
    })
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyRead: moneyEnvelope([agent], {
        baseGroups: [
          {
            groupKey: '84532:0xkernel:0xpool:usdc',
            kernelAddress: '0xkernel',
            poolAddress: '0xpool',
            asset: 'usdc',
            amount: amount('500000000'),
            // A complete valuation cannot simultaneously carry a read-incomplete problem.
            coverage: { state: 'complete', problems: ['base-read-unavailable'] },
          },
        ],
      }),
    })

    expect(out.personas[0].children[0].workingLegs[0].counted).toBe(false)
    expect(out.totals).toEqual([])
    expect(out.status).toBe('partial')
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('treats an unmatched complete known-zero Base group as non-productive, not incomplete', () => {
    const zero = amount('0')
    const agent = moneyAgent(ADDRESS_A, {
      amount: zero,
      vaultShares: { state: 'known', amount: zero, checkedAt: 1 },
      idleToken: { state: 'known', amount: zero, checkedAt: 1 },
      custody: { location: 'base-proxy' },
      custodyBreakdown: [baseLeg('0', { asset: 'USDC' })],
    })
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyRead: moneyEnvelope([agent], {
        baseGroups: [
          {
            groupKey: '84532:0xkernel:0xpool:usdc',
            kernelAddress: '0xkernel',
            poolAddress: '0xpool',
            asset: 'usdc',
            amount: zero,
            coverage: { state: 'complete', problems: [] },
          },
        ],
      }),
    })

    expect(out.productiveAgentCount).toBe(0)
    expect(out.activeCount).toBe(0)
    expect(out.totals).toEqual([])
    expect(out.status).toBe('complete')
    expect(out.personas.map((persona) => persona.totalState)).toEqual(['known', 'known', 'known'])
  })

  it.each([
    [null, { state: 'unavailable', problems: ['base-read-unavailable'] }],
    [amount('500000000'), { state: 'complete', problems: [] }],
  ])(
    'keeps an unmatched unavailable/positive owner group unresolved and partial',
    (value, coverage) => {
      const out = buildCrewPersonas({
        discovery: discovery([indexedRow(ADDRESS_A, 0)]),
        moneyRead: moneyEnvelope(
          [
            moneyAgent(ADDRESS_A, {
              amount: null,
              custody: { location: 'base-proxy' },
              custodyBreakdown: [baseLeg(null, { asset: 'USDC' })],
              problems: ['base-read-unavailable'],
            }),
          ],
          {
            baseGroups: [
              {
                groupKey: '84532:0xkernel:0xpool:usdc',
                kernelAddress: '0xkernel',
                poolAddress: '0xpool',
                asset: 'usdc',
                amount: value,
                coverage,
              },
            ],
          }
        ),
      })

      expect(out.productiveAgentCount).toBe(0)
      expect(out.totals).toEqual([])
      expect(out.status).toBe('partial')
      expect(out.personas[0].totalState).toBe('partial')
    }
  )

  it('downgrades Crew when the money envelope is partial even if discovery is complete', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyRead: moneyEnvelope([moneyAgent(ADDRESS_A)], { status: 'partial' }),
    })

    expect(out.totals).toEqual([amount('10000000')])
    expect(out.status).toBe('partial')
    expect(out.personas.map((persona) => persona.totalState)).toEqual([
      'partial',
      'partial',
      'partial',
    ])
  })
})

describe('buildCrewPersonas — pending and incomplete evidence', () => {
  it.each(['scope-read-failed', 'unexpected-error'])(
    'keeps a complete discovery partial when its joined money row has %s and is non-productive',
    (problem) => {
      const out = buildCrewPersonas({
        discovery: discovery([indexedRow(ADDRESS_A, 0)]),
        moneyAgents: [
          moneyAgent(ADDRESS_A, {
            scope: { state: 'unavailable', value: null, checkedAt: 1 },
            vaultShares: { state: 'unavailable', amount: null, checkedAt: 1 },
            idleToken: { state: 'unavailable', amount: null, checkedAt: 1 },
            amount: null,
            executionStatus: 'unknown',
            custody: { location: 'unknown' },
            custodyBreakdown: [],
            problems: [problem],
          }),
        ],
      })

      expect(out.status).toBe('partial')
      expect(out.productiveAgentCount).toBe(0)
      expect(out.pendingAssignments).toEqual([])
      expect(out.personas.every((persona) => persona.children.length === 0)).toBe(true)
      expect(out.personas.map((persona) => persona.totalState)).toEqual([
        'partial',
        'known',
        'known',
      ])
      expect(out.totals).toEqual([])
    }
  )

  it('8. exposes a hint-only productive row as pending without guessing a persona', () => {
    const out = buildCrewPersonas({
      discovery: discovery([hintRow(ADDRESS_A)], 'partial'),
      moneyAgents: [moneyAgent(ADDRESS_A)],
    })

    expect(out.personas.every((persona) => persona.children.length === 0)).toBe(true)
    expect(out.pendingAssignments).toHaveLength(1)
    expect(out.pendingAssignments[0].agent.address).toBe(ADDRESS_A)
    expect(out.pendingAssignments[0].workingTotals).toEqual([
      { token: 'USDC', units: '10000000', decimals: 7 },
    ])
    expect(out.productiveAgentCount).toBe(1)
    expect(out.activeCount).toBe(0)
    expect(out.totals).toEqual([{ token: 'USDC', units: '10000000', decimals: 7 }])
  })

  it('counts a shared Base leg once when its other association is pending', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0), hintRow(ADDRESS_B)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('700000000')],
        }),
        moneyAgent(ADDRESS_B, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('700000000')],
        }),
      ],
    })
    const assignedLeg = out.personas[0].children[0].workingLegs[0]
    const pendingLeg = out.pendingAssignments[0].workingLegs[0]

    expect(assignedLeg).toMatchObject({ shared: true, counted: true })
    expect(pendingLeg).toMatchObject({ shared: true, counted: false })
    expect(out.personas[0].totals).toEqual([{ token: 'USDC', units: '700000000', decimals: 7 }])
    expect(out.totals).toEqual([{ token: 'USDC', units: '700000000', decimals: 7 }])
  })

  it('9. marks every persona total partial when discovery coverage is partial', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)], 'partial'),
      moneyAgents: [moneyAgent(ADDRESS_A)],
    })

    expect(out.status).toBe('partial')
    expect(out.personas.map((persona) => persona.totalState)).toEqual([
      'partial',
      'partial',
      'partial',
    ])
    expect(out.personas[0].totals).toEqual([{ token: 'USDC', units: '10000000', decimals: 7 }])
  })

  it('9. preserves a known productive amount but marks its total partial on unreadable evidence', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('500000000'),
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('500000000')],
          vaultShares: { state: 'unavailable', amount: null, checkedAt: 1 },
          problems: ['vault-shares-unavailable'],
        }),
      ],
    })

    expect(out.personas[0].totals).toEqual([{ token: 'USDC', units: '500000000', decimals: 7 }])
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('marks a readable stale Base association partial', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg('500000000', { coverageReason: 'stale' })],
        }),
      ],
    })

    expect(out.totals).toEqual([{ token: 'USDC', units: '500000000', decimals: 7 }])
    expect(out.status).toBe('partial')
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('9. retains an unreadable productive leg as evidence without inventing units', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: amount('400000000'),
          custody: { location: 'unknown' },
          custodyBreakdown: [stellarLeg('400000000'), baseLeg(null)],
          problems: ['base-read-unavailable'],
        }),
      ],
    })
    const child = out.personas[0].children[0]

    expect(child.workingLegs[1]).toMatchObject({
      location: 'base-proxy',
      amount: null,
      counted: false,
    })
    expect(child.workingTotals).toEqual([{ token: 'USDC', units: '400000000', decimals: 7 }])
    expect(out.productiveAgentCount).toBe(1)
    expect(out.status).toBe('partial')
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('excludes an unreadable-only productive row from children, productive count, and active count', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          amount: null,
          custody: { location: 'base-proxy' },
          custodyBreakdown: [baseLeg(null)],
          problems: ['base-read-unavailable'],
        }),
      ],
    })

    expect(out.personas[0].children).toEqual([])
    expect(out.productiveAgentCount).toBe(0)
    expect(out.activeCount).toBe(0)
    expect(out.totals).toEqual([])
    expect(out.status).toBe('partial')
    expect(out.personas[0].totalState).toBe('partial')
  })

  it('rejects unsafe numeric productive units instead of converting them through BigInt', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A, {
          custodyBreakdown: [stellarLeg(9007199254740992)],
        }),
      ],
    })
    expect(out.personas[0].children).toEqual([])
    expect(out.productiveAgentCount).toBe(0)
    expect(out.activeCount).toBe(0)
    expect(out.totals).toEqual([])
    expect(out.status).toBe('partial')
  })
})

describe('buildCrewPersonas — exact membership join', () => {
  it('10. never joins lowercase or malformed lookalikes and never substitutes the next row', () => {
    const out = buildCrewPersonas({
      discovery: discovery([indexedRow(ADDRESS_A, 0), indexedRow(ADDRESS_B, 1)]),
      moneyAgents: [
        moneyAgent(ADDRESS_A.toLowerCase(), {
          amount: amount('999000000'),
          custodyBreakdown: [stellarLeg('999000000')],
        }),
        moneyAgent(`${ADDRESS_A} `, {
          amount: amount('888000000'),
          custodyBreakdown: [stellarLeg('888000000')],
        }),
        moneyAgent(ADDRESS_B, {
          amount: amount('222000000'),
          custodyBreakdown: [stellarLeg('222000000')],
        }),
      ],
    })

    expect(out.productiveAgentCount).toBe(1)
    expect(childAddresses(out.personas[0])).toEqual([])
    expect(childAddresses(out.personas[1])).toEqual([ADDRESS_B])
    expect(out.totals).toEqual([{ token: 'USDC', units: '222000000', decimals: 7 }])
  })
})

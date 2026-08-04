import { describe, expect, it } from 'vitest'
import {
  assignCrewPersona,
  CREW_PERSONAS,
  legacyPersonaSlot,
  personaForOrdinal,
} from './personas.js'

const ADDRESS_A = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const ADDRESS_B = 'CAVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCVLQ3'

describe('CREW_PERSONAS', () => {
  it('provides the frozen literal persona catalog', () => {
    expect(CREW_PERSONAS).toEqual([
      { id: 'sprout', name: 'Sprout', ordinal: 0, avatar: '/brand/agents/sprout.svg' },
      { id: 'clover', name: 'Clover', ordinal: 1, avatar: '/brand/agents/clover.svg' },
      { id: 'mochi', name: 'Mochi', ordinal: 2, avatar: '/brand/agents/mochi.svg' },
    ])
    expect(Object.isFrozen(CREW_PERSONAS)).toBe(true)
    expect(CREW_PERSONAS.every(Object.isFrozen)).toBe(true)
  })
})

describe('personaForOrdinal', () => {
  it('wraps valid ordinals through the catalog', () => {
    expect(personaForOrdinal(0)).toBe(CREW_PERSONAS[0])
    expect(personaForOrdinal(4)).toBe(CREW_PERSONAS[1])
    expect(personaForOrdinal(5)).toBe(CREW_PERSONAS[2])
  })

  it.each([-1, 1.5, NaN, '1', Number.MAX_SAFE_INTEGER + 1])(
    'rejects the non-ordinal value %s',
    (ordinal) => {
      expect(personaForOrdinal(ordinal)).toBeNull()
    }
  )
})

describe('assignCrewPersona', () => {
  it('uses an indexed run ordinal without hashing the agent address', () => {
    expect(
      assignCrewPersona({
        networkId: 'stellar-testnet',
        discoveryRow: { address: ADDRESS_A, discoverySources: ['agent-index-api'], runOrdinal: 4 },
      })
    ).toEqual({
      state: 'assigned',
      persona: CREW_PERSONAS[1],
      source: 'run-ordinal',
      runOrdinal: 4,
    })
  })

  it('uses the hand-checked UTF-8 FNV-1a legacy slots for D1-proven addresses', () => {
    expect(legacyPersonaSlot('stellar-testnet', ADDRESS_A)).toBe(2)
    expect(legacyPersonaSlot('stellar-testnet', ADDRESS_B)).toBe(0)

    expect(
      assignCrewPersona({
        networkId: 'stellar-testnet',
        discoveryRow: {
          address: ADDRESS_A,
          discoverySources: ['agent-index-api'],
          runOrdinal: null,
        },
      })
    ).toEqual({
      state: 'assigned',
      persona: CREW_PERSONAS[2],
      source: 'legacy-fnv1a',
      runOrdinal: null,
    })
  })

  it('allows the legacy fallback for validated indexed creator and creation evidence', () => {
    expect(
      assignCrewPersona({
        networkId: 'stellar-testnet',
        discoveryRow: {
          address: ADDRESS_B,
          creator: 'CINDEXEDCREATOR',
          createdLedger: 0,
          createdTxHash: 'creation-tx',
          runOrdinal: null,
        },
      })
    ).toEqual({
      state: 'assigned',
      persona: CREW_PERSONAS[0],
      source: 'legacy-fnv1a',
      runOrdinal: null,
    })
  })

  it('keeps hint-only, scope-only, and cache-only rows pending instead of hashing them', () => {
    for (const discoverySources of [
      [],
      ['rpc-router-events'],
      ['local-cache'],
      ['agent-index-api '],
    ]) {
      expect(
        assignCrewPersona({
          networkId: 'stellar-testnet',
          discoveryRow: { address: ADDRESS_A, discoverySources, runOrdinal: null },
        })
      ).toEqual({ state: 'pending', reason: 'unverified-discovery-row' })
    }
  })

  it.each([-1, 1.5, NaN, '1', Number.MAX_SAFE_INTEGER + 1])(
    'keeps an indexed row with invalid run ordinal %s pending rather than coercing it',
    (runOrdinal) => {
      expect(
        assignCrewPersona({
          networkId: 'stellar-testnet',
          discoveryRow: {
            address: ADDRESS_A,
            discoverySources: ['agent-index-api'],
            runOrdinal,
          },
        })
      ).toEqual({ state: 'pending', reason: 'invalid-run-ordinal' })
    }
  )
})

// @vitest-environment jsdom
// Functional Secondary handoff contracts. Pixel/screenshot ownership is intentionally absent;
// this file proves the frozen input boundary, exact CAP split, and route composition inventory.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_HEX_FIXTURES,
  SECONDARY_AMOUNTS,
  SECONDARY_CLASS_ROUTES,
  SECONDARY_FIXTURE_PAYLOADS,
  SECONDARY_FIXTURE_STATES,
  SECONDARY_FACT_METADATA,
  SECONDARY_LOADERS,
  SECONDARY_NOW,
  SECONDARY_OWNED_CLASSES,
  SECONDARY_ROUTE_FIXTURES,
  STELLAR_C_FIXTURES,
  STELLAR_G_FIXTURE,
  createSecondaryLoaders,
} from '../../visual/secondaryFixtures.js'

const frontendRoot = globalThis.process.cwd()
const fixtureSource = readFileSync(resolve(frontendRoot, 'visual/secondaryFixtures.js'), 'utf8')
const visualSource = readFileSync(resolve(frontendRoot, 'visual/main.jsx'), 'utf8')

const EXPECTED_CLASSES = [
  'CAP-02',
  'CAP-03',
  'CAP-04',
  'CAP-05',
  'CAP-06',
  'CAP-07',
  'CAP-11',
  'CAP-13',
  'CAP-14',
  'CAP-15',
  'CAP-17',
  'CAP-19',
]

const EXPECTED_BRANCHES = [
  'landing',
  'onboarding',
  'explorer',
  'ecosystem',
  'replay',
  'history',
  'vault',
  'tx',
  'developers',
  'developer-keys',
  'developer-usage',
  'developer-docs',
  'skill-drawer',
  'dev-panel',
]

const ALL_STATES = ['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable']
const FORBIDDEN_KEYS = [
  'address',
  'owner',
  'account',
  'custody',
  'signer',
  'secret',
  'private',
  'bearer',
  'capability',
  'sessionkey',
  'authorization',
  'cookie',
]

function expectDeepFrozen(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
  if (seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if ('value' in descriptor) expectDeepFrozen(descriptor.value, seen)
  }
}

function expectPublicFixtureKeys(value, path = '$', seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
  if (seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key).toBe('string')
    const normalized = String(key)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
    expect(
      FORBIDDEN_KEYS.some((part) => normalized.includes(part)),
      `${path}.${String(key)}`
    ).toBe(false)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) {
      expectPublicFixtureKeys(descriptor.value, `${path}.${String(key)}`, seen)
    }
  }
}

describe('Secondary deterministic fixture contract', () => {
  it('publishes frozen identity casing, canonical metadata, and the exact CAP ownership split', () => {
    expect(SECONDARY_NOW).toBe('2026-08-11T00:00:00.000Z')
    expect(SECONDARY_OWNED_CLASSES).toEqual(EXPECTED_CLASSES)
    expect(Object.keys(SECONDARY_CLASS_ROUTES)).toEqual(EXPECTED_CLASSES)
    expect(SECONDARY_CLASS_ROUTES['CAP-07']).toBe('landing')
    expect(SECONDARY_OWNED_CLASSES).not.toEqual(expect.arrayContaining(['CAP-16', 'CAP-18']))
    expect(Object.keys(SECONDARY_ROUTE_FIXTURES)).toEqual(EXPECTED_BRANCHES)

    expect(STELLAR_G_FIXTURE).toMatch(/^G[A-Z2-7]{55}$/)
    expect(STELLAR_C_FIXTURES).toHaveLength(4)
    for (const value of STELLAR_C_FIXTURES) expect(value).toMatch(/^C[A-Z2-7]{55}$/)
    for (const value of BASE_HEX_FIXTURES) {
      expect(value).toMatch(/^0x[0-9a-f]{40}$/)
      expect(value).toBe(value.toLowerCase())
      expect(value).not.toMatch(/^[GC]/)
    }

    expect(SECONDARY_AMOUNTS.balance).toEqual({
      token: 'USDC',
      units: '1250000000',
      decimals: 7,
    })
    expect(SECONDARY_FACT_METADATA).toMatchObject({
      source: 'secondary-fixture',
      checkedAt: '2026-08-10T23:59:00.000Z',
      staleAfterMs: 86400000,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
  })

  it('covers every read state for every injected route and keeps the graph display-only', () => {
    for (const route of Object.keys(SECONDARY_FIXTURE_PAYLOADS)) {
      expect(Object.keys(SECONDARY_FIXTURE_PAYLOADS[route])).toEqual(ALL_STATES)
      for (const state of ALL_STATES) {
        expect(SECONDARY_FIXTURE_PAYLOADS[route][state]).toBeTruthy()
        expectDeepFrozen(SECONDARY_FIXTURE_PAYLOADS[route][state])
      }
    }
    expect(Object.keys(SECONDARY_FIXTURE_STATES)).toEqual(ALL_STATES)
    expectDeepFrozen(SECONDARY_FIXTURE_PAYLOADS)
    expectDeepFrozen(SECONDARY_FIXTURE_STATES)
    expectDeepFrozen(SECONDARY_LOADERS)
    expectPublicFixtureKeys(SECONDARY_FIXTURE_PAYLOADS)

    const loaders = createSecondaryLoaders('stale')
    for (const route of Object.keys(SECONDARY_FIXTURE_PAYLOADS)) {
      expect(loaders[route]()).toBe(SECONDARY_FIXTURE_PAYLOADS[route].stale)
    }

    // Keep this source boundary easy to audit: only the visual entrypoint installs browser guards.
    expect(fixtureSource).not.toMatch(/\bfetch\s*\(/u)
    expect(fixtureSource).not.toMatch(/\bDate\.now\b/u)
    expect(fixtureSource).not.toMatch(/\bMath\.random\b/u)
    expect(visualSource).toContain('data-fixture-pending="false"')
    for (const branch of EXPECTED_BRANCHES) expect(visualSource).toContain(`'${branch}'`)
    for (const component of [
      'LandingHero',
      'OnboardingFlow',
      'ExplorerPage',
      'EcosystemPage',
      'ReplayPage',
      'HistoryPanel',
      'VaultDetailPage',
      'TxDetailPage',
      'DevelopersLayout',
      'SkillDrawer',
      'TweaksPanel',
    ]) {
      expect(visualSource).toContain(component)
    }
  })
})

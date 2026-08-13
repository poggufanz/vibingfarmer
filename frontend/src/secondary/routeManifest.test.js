import { describe, expect, it } from 'vitest'
import { SECONDARY_ROUTE_MANIFEST } from './routeManifest.js'

describe('secondary route manifest', () => {
  it('enumerates each visual route composition without becoming a router', () => {
    expect(Object.isFrozen(SECONDARY_ROUTE_MANIFEST)).toBe(true)
    expect(SECONDARY_ROUTE_MANIFEST).toHaveLength(8)

    const expected = [
      ['onboarding', '/onboarding', 'onboarding'],
      ['explorer', '/explorer', 'public'],
      ['ecosystem', '/ecosystem', 'public'],
      ['replay', '/replay', 'public'],
      ['history', '/history', 'authenticated'],
      ['vault', '/vault/:protocol', 'authenticated'],
      ['tx', '/tx/:txHash', 'authenticated'],
      ['developers', '/developers/*', 'authenticated'],
    ]

    expect(SECONDARY_ROUTE_MANIFEST.map(({ id, path, gate }) => [id, path, gate])).toEqual(expected)
    expect(new Set(SECONDARY_ROUTE_MANIFEST.map((entry) => entry.visualClass)).size).toBe(8)
    for (const entry of SECONDARY_ROUTE_MANIFEST) {
      expect(entry).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          path: expect.any(String),
          gate: expect.any(String),
          heading: expect.any(String),
          visualClass: expect.any(String),
        })
      )
      expect(Object.isFrozen(entry)).toBe(true)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { resolveDocumentTitle } from './appShellTitle.js'

describe('resolveDocumentTitle', () => {
  it('gives the standalone public pages their own title for a fresh, not-yet-connected, not-skipped-landing visitor', () => {
    // This is exactly the bug: App renders /explorer regardless of skipLanding/realAddress (it's
    // checked before those gates), so the title must not fall through to the landing overlay's
    // "Welcome" title just because the visitor happens to be fresh.
    const base = { skipLanding: false, realAddress: null, onboarded: false }
    expect(resolveDocumentTitle({ ...base, pathname: '/explorer' })).toBe(
      'Explorer · Vibing Farmer'
    )
    expect(resolveDocumentTitle({ ...base, pathname: '/ecosystem' })).toBe(
      'Ecosystem · Vibing Farmer'
    )
    expect(resolveDocumentTitle({ ...base, pathname: '/replay' })).toBe('Replay · Vibing Farmer')
  })

  it('still gives the standalone public pages their title for a returning, connected, onboarded visitor', () => {
    const base = { skipLanding: true, realAddress: 'GADDRESS', onboarded: true }
    expect(resolveDocumentTitle({ ...base, pathname: '/explorer' })).toBe(
      'Explorer · Vibing Farmer'
    )
  })

  it('falls to the landing overlay title only for a real (non-public-page) route', () => {
    expect(
      resolveDocumentTitle({
        pathname: '/home',
        skipLanding: false,
        realAddress: null,
        onboarded: false,
      })
    ).toBe('Welcome · Vibing Farmer')
  })

  it('falls to the onboarding overlay title only for a real (non-public-page) route', () => {
    expect(
      resolveDocumentTitle({
        pathname: '/home',
        skipLanding: true,
        realAddress: 'GADDRESS',
        onboarded: false,
      })
    ).toBe('Get started · Vibing Farmer')
  })

  it('resolves every other route via routeTitle once past both gates', () => {
    // Task 10 (IA remap): /agent is now the crew route, not My money (moved to /home).
    expect(
      resolveDocumentTitle({
        pathname: '/agent',
        skipLanding: true,
        realAddress: 'GADDRESS',
        onboarded: true,
      })
    ).toBe('The crew · Vibing Farmer')
  })
})

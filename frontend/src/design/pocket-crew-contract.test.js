import { describe, expect, it } from 'vitest'
import {
  FOUNDATION_ASSET_PATHS,
  FOUNDATION_BREAKPOINTS,
  FOUNDATION_CREW_TOKENS,
  FOUNDATION_LAYERS,
  FOUNDATION_MOBILE_OVERRIDES,
  FOUNDATION_MOTION,
  FOUNDATION_SHARED_TOKENS,
  FOUNDATION_THEMES,
  NETWORK_MARK_GAP,
  POCKET_CREW_CONTRACT,
  POCKET_CREW_CONTRACT_VERSION,
  WALLET_GAP,
} from './pocket-crew-contract.js'

const assertDeepFrozen = (value) => {
  expect(Object.isFrozen(value)).toBe(true)
  if (!value || typeof value !== 'object') return
  Object.values(value).forEach(assertDeepFrozen)
}

const EXPECTED_FOREST_THEME = {
  '--pc-field': '#17251F',
  '--pc-grove': '#20342B',
  '--pc-harvest': '#DFF56C',
  '--pc-rice': '#F2F5EF',
  '--pc-canvas': '#17251F',
  '--pc-workspace': '#20342B',
  '--pc-owned': '#F2F5EF',
  '--pc-ink': '#F2F5EF',
  '--pc-muted': '#A8B5AD',
  '--pc-faint': '#8C9B93',
  '--pc-owned-ink': '#17251F',
  '--pc-owned-muted': '#536159',
  '--pc-harvest-ink': '#17251F',
  '--pc-danger': '#E26E67',
  '--pc-danger-ink': '#17251F',
  '--pc-danger-on-light': '#A8403C',
  '--pc-warning': '#E8A33D',
  '--pc-focus': '#DFF56C',
  '--pc-focus-contrast': '#17251F',
  '--pc-line': 'rgb(242 245 239 / 16%)',
  '--pc-line-strong': '#8C9B93',
  '--pc-overlay': 'rgb(7 15 11 / 62%)',
  '--pc-shadow-color': 'rgb(7 15 11 / 28%)',
}

const EXPECTED_DAY_FIELD_THEME = {
  '--pc-field': '#17251F',
  '--pc-grove': '#20342B',
  '--pc-harvest': '#DFF56C',
  '--pc-rice': '#F2F5EF',
  '--pc-canvas': '#E9EEE8',
  '--pc-workspace': '#F7F9F5',
  '--pc-owned': '#F2F5EF',
  '--pc-ink': '#17251F',
  '--pc-muted': '#536159',
  '--pc-faint': '#5F6C65',
  '--pc-owned-ink': '#17251F',
  '--pc-owned-muted': '#536159',
  '--pc-harvest-ink': '#17251F',
  '--pc-danger': '#A8403C',
  '--pc-danger-ink': '#F2F5EF',
  '--pc-danger-on-light': '#A8403C',
  '--pc-warning': '#8A5A00',
  '--pc-focus': '#17251F',
  '--pc-focus-contrast': '#F2F5EF',
  '--pc-line': 'rgb(23 37 31 / 16%)',
  '--pc-line-strong': '#5F6C65',
  '--pc-overlay': 'rgb(23 37 31 / 48%)',
  '--pc-shadow-color': 'rgb(23 37 31 / 16%)',
}

const EXPECTED_CREW_TOKENS = {
  forest: {
    '--pc-crew-1': '#8FBF8A',
    '--pc-crew-2': '#6FA8DC',
    '--pc-crew-3': '#E0B84B',
    '--pc-crew-4': '#C9967B',
    '--pc-crew-5': '#5FD3BC',
    '--pc-crew-6': '#D98BA8',
  },
  'day-field': {
    '--pc-crew-1': '#569D50',
    '--pc-crew-2': '#3E72A8',
    '--pc-crew-3': '#B18220',
    '--pc-crew-4': '#8C5A3E',
    '--pc-crew-5': '#229C85',
    '--pc-crew-6': '#A8446B',
  },
}

const EXPECTED_SHARED_TOKENS = {
  '--pc-font-display': "'Geist Variable', 'Geist', system-ui, sans-serif",
  '--pc-font-body': "'Geist Variable', 'Geist', system-ui, sans-serif",
  '--pc-font-mono': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  '--pc-font-wordmark': "'Newsreader Variable', 'Newsreader', Georgia, serif",
  '--pc-space-1': '4px',
  '--pc-space-2': '8px',
  '--pc-space-3': '12px',
  '--pc-space-4': '16px',
  '--pc-space-5': '20px',
  '--pc-space-6': '24px',
  '--pc-space-8': '32px',
  '--pc-space-10': '40px',
  '--pc-space-12': '48px',
  '--pc-space-16': '64px',
  '--pc-space-20': '80px',
  '--pc-radius-control': '12px',
  '--pc-radius-support': '16px',
  '--pc-radius-dominant': '24px',
  '--pc-radius-round': '999px',
  '--pc-sidebar-width': '248px',
  '--pc-sidebar-compact-width': '80px',
  '--pc-topbar-height': '64px',
  '--pc-shell-max': '1240px',
  '--pc-route-gutter': 'clamp(20px, 4vw, 48px)',
  '--pc-route-gap': 'clamp(32px, 5vw, 64px)',
  '--pc-dominant-padding': 'clamp(24px, 4vw, 48px)',
  '--pc-control-height': '48px',
  '--pc-touch-target': '44px',
  '--pc-type-money': 'clamp(48px, 7vw, 76px)',
  '--pc-type-page': 'clamp(34px, 4.4vw, 52px)',
  '--pc-type-stage': 'clamp(28px, 3.2vw, 40px)',
  '--pc-type-section': 'clamp(21px, 2vw, 28px)',
  '--pc-type-body': '16px',
  '--pc-type-body-small': '14px',
  '--pc-type-label': '13px',
  '--pc-type-technical': '12px',
  '--pc-leading-tight': '1.05',
  '--pc-leading-title': '1.12',
  '--pc-leading-body': '1.55',
}

const EXPECTED_MOBILE_OVERRIDES = {
  '--pc-type-money': 'clamp(44px, 15vw, 60px)',
  '--pc-type-page': 'clamp(32px, 10vw, 42px)',
  '--pc-route-gutter': '16px',
  '--pc-route-gap': '36px',
  '--pc-dominant-padding': '24px',
}

describe('Pocket Crew machine-readable foundation contract', () => {
  it('publishes exactly Forest and Day Field semantic themes', () => {
    expect(POCKET_CREW_CONTRACT_VERSION).toBe('2026-08-11')
    expect(Object.keys(FOUNDATION_THEMES)).toEqual(['forest', 'day-field'])
    expect(FOUNDATION_THEMES.forest).toEqual(EXPECTED_FOREST_THEME)
    expect(FOUNDATION_THEMES['day-field']).toEqual(EXPECTED_DAY_FIELD_THEME)
  })

  it('publishes the fixed six-color crew palettes', () => {
    expect(FOUNDATION_CREW_TOKENS).toEqual(EXPECTED_CREW_TOKENS)
  })

  it('publishes shared typography, spacing, shape, shell, and control tokens', () => {
    expect(FOUNDATION_SHARED_TOKENS).toEqual(EXPECTED_SHARED_TOKENS)
  })

  it('publishes mobile overrides, responsive boundaries, motion, layers, and asset paths', () => {
    expect(FOUNDATION_MOBILE_OVERRIDES).toEqual(EXPECTED_MOBILE_OVERRIDES)
    expect(FOUNDATION_BREAKPOINTS).toEqual({
      mobileMax: 767,
      tabletMin: 768,
      tabletMax: 1023,
      desktopMin: 1024,
    })
    expect(FOUNDATION_MOTION).toEqual({
      '--pc-duration-fast': '120ms',
      '--pc-duration-base': '220ms',
      '--pc-duration-enter': '320ms',
      '--pc-stagger': '40ms',
      '--pc-ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
      '--pc-ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
    })
    expect(FOUNDATION_LAYERS).toEqual({
      '--pc-z-base': 0,
      '--pc-z-sticky': 20,
      '--pc-z-popover': 40,
      '--pc-z-overlay': 80,
      '--pc-z-dialog': 90,
      '--pc-z-skip-link': 100,
    })
    expect(FOUNDATION_ASSET_PATHS).toEqual([
      '/brand/vibing-farmer-mark-forest.svg',
      '/brand/vibing-farmer-mark-day.svg',
      '/brand/vibing-farmer-mark-mono.svg',
      '/brand/networks/stellar.svg',
      '/brand/networks/base.svg',
    ])
    expect(NETWORK_MARK_GAP).toBe('7px')
    expect(WALLET_GAP).toBe('18px')
  })

  it('assembles the stable contract from the published foundation records', () => {
    expect(POCKET_CREW_CONTRACT).toEqual({
      version: '2026-08-11',
      themes: FOUNDATION_THEMES,
      sharedTokens: FOUNDATION_SHARED_TOKENS,
      crewTokens: FOUNDATION_CREW_TOKENS,
      mobileOverrides: FOUNDATION_MOBILE_OVERRIDES,
      breakpoints: FOUNDATION_BREAKPOINTS,
      motion: FOUNDATION_MOTION,
      layers: FOUNDATION_LAYERS,
      assetPaths: FOUNDATION_ASSET_PATHS,
    })
    expect('Fact' in POCKET_CREW_CONTRACT).toBe(false)
    expect('toFreshnessView' in POCKET_CREW_CONTRACT).toBe(false)
  })

  it('deeply freezes every exported record and child', () => {
    ;[
      FOUNDATION_THEMES,
      FOUNDATION_SHARED_TOKENS,
      FOUNDATION_CREW_TOKENS,
      FOUNDATION_MOBILE_OVERRIDES,
      FOUNDATION_BREAKPOINTS,
      FOUNDATION_MOTION,
      FOUNDATION_LAYERS,
      FOUNDATION_ASSET_PATHS,
      POCKET_CREW_CONTRACT,
    ].forEach(assertDeepFrozen)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { BrandLockup } from './BrandLockup.jsx'

expect.extend(axeMatchers)

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('BrandLockup', () => {
  it('full variant shows the visible wordmark as real DOM text and a decorative mark', () => {
    const { container } = render(<BrandLockup variant="full" />)
    expect(screen.getByText('vibing / farmer')).toBeTruthy()
    const img = container.querySelector('img')
    expect(img.getAttribute('alt')).toBe('')
    expect(container.firstElementChild.dataset.variant).toBe('full')
    expect(container.firstElementChild.dataset.tone).toBe('auto')
  })

  it('compact variant carries the accessible name on the mark itself (no visible wordmark text)', () => {
    render(<BrandLockup variant="compact" />)
    expect(screen.getByRole('img', { name: 'vibing / farmer' })).toBeTruthy()
    expect(screen.queryByText('vibing / farmer')).toBeNull()
  })

  it('full and compact each expose exactly one accessible name for the lockup', () => {
    const full = render(<BrandLockup variant="full" />)
    expect(screen.getAllByText('vibing / farmer')).toHaveLength(1)
    full.unmount()
    render(<BrandLockup variant="compact" />)
    expect(screen.getAllByRole('img', { name: 'vibing / farmer' })).toHaveLength(1)
  })

  it('defaults to the forest mark when no theme is set', () => {
    const { container } = render(<BrandLockup />)
    expect(container.querySelector('img').getAttribute('src')).toBe(
      '/brand/vibing-farmer-mark-forest.svg'
    )
  })

  it('reads the day-field mark from the DOM data-theme attribute in auto mode', () => {
    document.documentElement.setAttribute('data-theme', 'day-field')
    const { container } = render(<BrandLockup tone="auto" />)
    expect(container.querySelector('img').getAttribute('src')).toBe(
      '/brand/vibing-farmer-mark-day.svg'
    )
    expect(container.firstElementChild.dataset.tone).toBe('auto')
  })

  it('an explicit tone overrides the DOM theme', () => {
    document.documentElement.setAttribute('data-theme', 'day-field')
    const { container } = render(<BrandLockup tone="forest" />)
    expect(container.querySelector('img').getAttribute('src')).toBe(
      '/brand/vibing-farmer-mark-forest.svg'
    )
  })

  it("tone='mono' always uses the mono source regardless of theme", () => {
    document.documentElement.setAttribute('data-theme', 'day-field')
    const { container } = render(<BrandLockup tone="mono" />)
    expect(container.querySelector('img').getAttribute('src')).toBe(
      '/brand/vibing-farmer-mark-mono.svg'
    )
    expect(container.firstElementChild.dataset.tone).toBe('mono')
  })

  it.each([
    ['null', null],
    ['object', {}],
    ['string', 'not-a-manifest'],
  ])(
    'rejects an explicitly supplied malformed non-array asset manifest (%s)',
    (_label, manifest) => {
      expect(() => render(<BrandLockup assetManifest={manifest} />)).toThrow(
        /Foundation asset manifest must be an array/
      )
    }
  )

  it('keeps the official mark path on every variant/tone combination', () => {
    for (const variant of ['full', 'compact']) {
      for (const tone of ['forest', 'day-field', 'mono']) {
        const { container, unmount } = render(<BrandLockup variant={variant} tone={tone} />)
        const src = container.querySelector('img').getAttribute('src')
        expect(src).toMatch(/^\/brand\/vibing-farmer-mark-(forest|day|mono)\.svg$/)
        expect(container.firstElementChild.dataset.variant).toBe(variant)
        expect(container.firstElementChild.dataset.tone).toBe(tone)
        unmount()
      }
    }
  })

  it('has zero axe violations (full)', async () => {
    const { container } = render(<BrandLockup variant="full" />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations (compact)', async () => {
    const { container } = render(<BrandLockup variant="compact" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

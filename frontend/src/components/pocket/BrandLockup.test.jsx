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
    expect(screen.getByText('Vibing Farmer')).toBeTruthy()
    const img = container.querySelector('img')
    expect(img.getAttribute('alt')).toBe('')
  })

  it('compact variant carries the accessible name on the mark itself (no visible wordmark text)', () => {
    render(<BrandLockup variant="compact" />)
    expect(screen.getByRole('img', { name: 'Vibing Farmer' })).toBeTruthy()
    expect(screen.queryByText('Vibing Farmer')).toBeNull()
  })

  it('full and compact each expose exactly one accessible name for the lockup', () => {
    const full = render(<BrandLockup variant="full" />)
    expect(screen.getAllByText('Vibing Farmer')).toHaveLength(1)
    full.unmount()
    render(<BrandLockup variant="compact" />)
    expect(screen.getAllByRole('img', { name: 'Vibing Farmer' })).toHaveLength(1)
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

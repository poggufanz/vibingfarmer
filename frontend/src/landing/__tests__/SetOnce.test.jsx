// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SetOnce from '../sections/SetOnce.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
afterEach(cleanup)

describe('SetOnce', () => {
  it('is the how-it-works anchor and states the one decision', () => {
    const { container } = render(<SetOnce />)
    const section = container.querySelector('[data-landing-section="SetOnce"]')
    expect(section.id).toBe('how-it-works')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'One decision.Made properly.'
    )
  })

  it('labels the intent card as an example and keeps the review path in order', () => {
    const { container } = render(<SetOnce />)
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.getByText('500 USDC')).toBeTruthy()
    const steps = [...container.querySelectorAll('.vf-review__step h3')].map((h) => h.textContent)
    expect(steps).toEqual(['Strategist', 'Council', 'Eligibility gate', 'You approve'])
  })

  it('collapses eight manual signatures into one', () => {
    const { container } = render(<SetOnce />)
    expect(container.querySelectorAll('.vf-sigs__glyph')).toHaveLength(8)
    expect(screen.getByText('Manual cycle: 8+ signatures')).toBeTruthy()
    expect(screen.getByText('Vibing Farmer: 1 to start · 0 to repeat')).toBeTruthy()
  })

  it('runs its motion branch without throwing', () => {
    setMotion({ reduce: false })
    const { container } = render(<SetOnce />)
    expect(container.querySelectorAll('.vf-sigs__glyph')).toHaveLength(8)
  })
})

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollTrigger, gsap } from '../motion/gsap.js'
import SetOnce from '../sections/SetOnce.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SetOnce', () => {
  it('is the how-it-works anchor and states the one decision', () => {
    const { container } = render(<SetOnce />)
    const section = container.querySelector('[data-landing-section="SetOnce"]')
    expect(section.id).toBe('how-it-works')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'One decision. Made properly.'
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

  // SVG elements have no offsetLeft; measuring with it made every x NaN and the collapse froze.
  it('scrubs every manual signature onto the first one', () => {
    setMotion({ reduce: false })
    const box = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (!this.classList.contains('vf-sigs__glyph')) return box.call(this)
      const left = [...this.parentNode.children].indexOf(this) * 40
      return { left, right: left + 36, top: 0, bottom: 24, width: 36, height: 24, x: left, y: 0 }
    })
    const { container } = render(<SetOnce />)
    const glyphs = [...container.querySelectorAll('.vf-sigs__glyph')]
    const collapse = ScrollTrigger.getAll().find((st) => st.trigger.classList.contains('vf-sigs'))
    collapse.animation.progress(1)
    glyphs.slice(1).forEach((glyph, i) => expect(gsap.getProperty(glyph, 'x')).toBe(-(i + 1) * 40))
  })
})

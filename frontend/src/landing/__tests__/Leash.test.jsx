// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gsap } from '../motion/gsap.js'
import Leash from '../sections/Leash.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
afterEach(cleanup)

describe('Leash', () => {
  it('lists the four on-chain bounds in order', () => {
    const { container } = render(<Leash />)
    const bounds = [...container.querySelectorAll('.vf-bound h3')].map((h) => h.textContent)
    expect(bounds).toEqual(['Budget', 'One vault', 'Expiry', 'Revoke'])
    expect(screen.getByText(/AI proposes\. Soroban enforces\./)).toBeTruthy()
  })

  it('revoke demo closes and restores the leash', () => {
    render(<Leash />)
    const toggle = screen.getByRole('button', { name: /revoke \(demo\)/i })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('leash-allowance').textContent).toBe('500 USDC')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('leash-allowance').textContent).toBe('0 USDC')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('leash-allowance').textContent).toBe('500 USDC')
  })

  it('runs the revoke choreography with motion without losing the final text', () => {
    setMotion({ reduce: false })
    render(<Leash />)
    const toggle = screen.getByRole('button', { name: /revoke \(demo\)/i })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('leash-allowance').textContent).toBe('0 USDC')
  })

  // Stacked counts write the same text node from opposite directions and flicker.
  it('runs one allowance count at a time when the toggle is clicked repeatedly', () => {
    setMotion({ reduce: false })
    render(<Leash />)
    const toggle = screen.getByRole('button', { name: /revoke \(demo\)/i })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    const counts = gsap.globalTimeline
      .getChildren(true, true, false)
      .filter((tween) => tween.targets()[0]?.constructor === Object)
    expect(counts).toHaveLength(1)
    expect(screen.getByTestId('leash-allowance').textContent).toBe('0 USDC')
  })
})

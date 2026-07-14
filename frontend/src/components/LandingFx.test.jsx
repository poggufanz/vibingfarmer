// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LandingHero from './LandingHero.jsx'

let reduceMotion = false

beforeEach(() => {
  reduceMotion = false
  window.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    get matches() {
      return query.includes('prefers-reduced-motion') ? reduceMotion : false
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

afterEach(cleanup)

function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingHero onStart={() => {}} />
    </MemoryRouter>
  )
}

describe('LandingFx intro gate', () => {
  it('shows the gate and locks the landing scroller until dismissed', () => {
    const { container } = renderLanding()

    expect(screen.getByLabelText('Welcome')).toBeTruthy()
    // SplitText wraps every character in a span, so query textContent instead.
    expect(container.querySelector('.vf-intro__ready').textContent).toBe('READY OR NOT?')
    // Gate is dismissed by scroll/click/key — it must not render any button.
    expect(container.querySelector('.vf-intro button')).toBeNull()
    expect(container.querySelector('.vf-landing').style.overflow).toBe('hidden')
  })

  it('is skipped entirely under prefers-reduced-motion', () => {
    reduceMotion = true
    const { container } = renderLanding()

    expect(screen.queryByLabelText('Welcome')).toBeNull()
    expect(container.querySelector('.vf-landing').style.overflow).not.toBe('hidden')
  })

  it('never renders the custom cursor without a fine pointer', () => {
    const { container } = renderLanding()

    // matchMedia mock reports (pointer: fine) as false — GSAP must not
    // activate the cursor or hide the native one.
    expect(container.querySelector('.vf-landing').classList.contains('vf-no-cursor')).toBe(false)
  })
})

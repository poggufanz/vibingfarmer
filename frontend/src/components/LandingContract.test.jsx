// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LandingHero from './LandingHero.jsx'
import NavBar from './NavBar.jsx'

const here = path.dirname(fileURLToPath(import.meta.url))
const landingFxSource = fs.readFileSync(path.join(here, 'LandingFx.jsx'), 'utf8')
const landingCssSource = fs.readFileSync(path.join(here, 'LandingHero.css'), 'utf8')
const navSource = fs.readFileSync(path.join(here, 'NavBar.jsx'), 'utf8')

let reduceMotion = false

beforeEach(() => {
  reduceMotion = false
  localStorage.clear()
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

function renderLanding(onStart = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LandingHero onStart={onStart} />
    </MemoryRouter>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

describe('Landing frozen contract', () => {
  it('keeps the section order, narrative, anchor, public links, and shared launch callback', () => {
    const onStart = vi.fn()
    const { container } = renderLanding(onStart)
    const sections = [...container.querySelectorAll('[data-landing-section]')]

    expect(sections.map((section) => section.dataset.landingSection)).toEqual([
      'Hero',
      'ProofStrip',
      'ProblemSection',
      'FlowSection',
      'BoundsSection',
      'IntelligenceSection',
      'YieldSection',
      'RelaySection',
      'ObservabilitySection',
      'HonestySection',
      'EcosystemBand',
      'FinalSection',
    ])
    expect(screen.getByText('Yield farming should not feel like clerical work.')).toBeTruthy()
    expect(screen.getByText('From intent to working capital.')).toBeTruthy()
    expect(screen.getByText('Real where it counts. Clear where it is not.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'See how it works' }).getAttribute('href')).toBe(
      '#how-it-works'
    )
    expect(
      [...container.querySelectorAll('nav a')].map((link) => link.getAttribute('href'))
    ).toEqual([
      'https://github.com/poggufanz/vibingfarmer',
      'https://vibingfarmer.gitbook.io/vibingfarmer/',
    ])

    const launchButtons = screen.getAllByRole('button', { name: 'Launch app' })
    expect(launchButtons.length).toBe(3)
    fireEvent.click(launchButtons[1])
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('dismisses the intro without retaining a scroll lock or hijacking later scroll', () => {
    const { container } = renderLanding()
    const root = container.querySelector('.vf-landing')
    const intro = screen.getByLabelText('Welcome')

    expect(root.style.overflow).toBe('hidden')
    fireEvent.click(intro)
    expect(screen.queryByLabelText('Welcome')).toBeNull()
    expect(root.style.overflow).not.toBe('hidden')

    fireEvent.scroll(root)
    expect(root.style.overflow).not.toBe('hidden')
  })

  it('keeps direct NavBar launch persistence and navigation unchanged', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <NavBar />
        <LocationProbe />
      </MemoryRouter>
    )

    fireEvent.click(container.querySelector('.nv-cta'))
    expect(localStorage.getItem('yv_skip_landing')).toBe('true')
    expect(localStorage.getItem('yv_onboarded')).toBe('true')
    expect(screen.getByTestId('location').textContent).toBe('/strategy')
  })

  it('exposes the same content and final state with reduced motion', () => {
    const normal = renderLanding()
    const normalText = normal.container.querySelector('main').textContent
    normal.unmount()

    reduceMotion = true
    const reduced = renderLanding()
    const root = reduced.container.querySelector('.vf-landing')
    expect(reduced.container.querySelector('main').textContent).toBe(normalText)
    expect(screen.queryByLabelText('Welcome')).toBeNull()
    expect(root.style.overflow).not.toBe('hidden')
    expect(reduced.container.querySelector('.vf-progressbar')).toBeNull()
  })
})

describe('Landing decorative source contract', () => {
  it('uses only finite opacity/position/scale effects', () => {
    expect(landingFxSource).toMatch(/opacity/)
    expect(landingFxSource).toMatch(/(?:\by\b|\bx\b|scale)/)
    expect(landingFxSource).toMatch(/duration/)
    expect(landingFxSource).not.toMatch(/ScrollTrigger|Observer|repeat\s*:\s*-1/)
    expect(landingFxSource).not.toMatch(/pointer(?:move|over|down|up|enter|leave)|magnetic|cursor/i)
    expect(landingFxSource).not.toMatch(/gateDone|setGateDone|onDone|progress/i)
    expect(navSource).not.toMatch(/<style>/)
    expect(landingCssSource).not.toMatch(/gradient|glow|shimmer/i)
    expect(landingCssSource).not.toMatch(/vf-progressbar|vf-cursor|vf-magnetic/i)
  })
})

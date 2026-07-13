// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LandingHero, { Player } from './LandingHero.jsx'

let reduceMotion = false
const reducedMotionListeners = new Set()

function setReducedMotion(value) {
  reduceMotion = value
  reducedMotionListeners.forEach((listener) => listener({ matches: value }))
}

beforeEach(() => {
  setReducedMotion(false)
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
    addEventListener: vi.fn((event, listener) => {
      if (event === 'change') reducedMotionListeners.add(listener)
    }),
    removeEventListener: vi.fn((event, listener) => {
      if (event === 'change') reducedMotionListeners.delete(listener)
    }),
    dispatchEvent: vi.fn(),
  }))
})

afterEach(cleanup)

describe('LandingHero Player', () => {
  it('requires explicit playback when motion is reduced', () => {
    const { container } = render(<Player src="/demo.mp4" reduceMotion />)
    const video = container.querySelector('video')

    expect(video.autoplay).toBe(false)
    expect(video.loop).toBe(false)
    expect(video.controls).toBe(true)
  })
})

describe('LandingHero', () => {
  it('explains the bounded Stellar flow without mounting obsolete product videos', () => {
    render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'One signature.Bounded workers.'
    )
    expect(screen.getByText('Autonomy, with a leash.')).toBeTruthy()
    expect(screen.getByText('AI plans. Rules can say no.')).toBeTruthy()
    expect(screen.getByText('Real lending underneath.')).toBeTruthy()
    expect(screen.getByText('Lifeboat needs a mandate.')).toBeTruthy()
    expect(document.querySelectorAll('video')).toHaveLength(0)
  })

  it('renders the capital path stages in flow order', () => {
    const { container } = render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )

    const stages = [...container.querySelectorAll('.vf-capital-path > div')].map((step) => [
      step.querySelector('span')?.textContent,
      step.querySelector('strong')?.textContent,
    ])

    expect(stages).toEqual([
      ['User intent', 'USDC budget'],
      ['Scoped execution', 'Agent accounts'],
      ['Share ledger', 'vfVLT vault'],
      ['Yield source', 'Blend v2'],
    ])
  })

  it('keeps safety and testnet disclosures precise', () => {
    render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )

    expect(screen.getByText(/per-period amount cap/)).toBeTruthy()
    expect(screen.getByText(/edit every worker skill/)).toBeTruthy()
    expect(screen.getByText(/200-scenario check/)).toBeTruthy()
    expect(screen.getByText(/For the initial grant, relay failure/)).toBeTruthy()
    expect(screen.getByText(/optional farm route bridges USDC through CCTP/)).toBeTruthy()
  })

  it('uses opacity-only motion when reduced motion is preferred', () => {
    setReducedMotion(true)
    const { container } = render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )

    const nonZeroTranslations = [...container.querySelectorAll('[style]')].flatMap((element) =>
      [...element.style.transform.matchAll(/translate[XY]\((-?\d+(?:\.\d+)?)px\)/g)]
        .map((match) => Number(match[1]))
        .filter((value) => value !== 0)
    )

    expect(nonZeroTranslations).toHaveLength(0)
  })

  it('uses the same launch callback from the public navigation', () => {
    const onStart = vi.fn()
    render(
      <MemoryRouter>
        <LandingHero onStart={onStart} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Launch app' })[0])
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('keeps the mobile navigation available while toggling Menu and Close', () => {
    render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )

    const navigation = screen.getByRole('navigation', { name: 'Main navigation' })
    const menu = navigation.querySelector('.nv-menu-btn')
    const links = document.getElementById('nv-main-links')
    const navStyles = navigation.querySelector('style')?.textContent ?? ''

    expect(menu?.textContent).toBe('Menu')
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(links).toBeTruthy()
    expect(menu.getAttribute('aria-controls')).toBe(links.id)
    expect(navStyles).toContain('transform-origin: top right;')
    expect(navStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nv-cta:hover \{\s*transform: none;/
    )

    fireEvent.click(menu)
    expect(menu.textContent).toBe('Close')
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(navigation.classList.contains('is-open')).toBe(true)
    expect(document.getElementById('nv-main-links')).toBe(links)

    fireEvent.click(menu)
    expect(menu.textContent).toBe('Menu')
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(navigation.classList.contains('is-open')).toBe(false)
    expect(document.getElementById('nv-main-links')).toBe(links)
  })
})

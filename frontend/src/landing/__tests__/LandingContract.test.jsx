// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMotion } from './motionEnv.js'

vi.mock('../../stellar/vaultReads.js', () => ({
  readSupplyAprBps: async () => null,
  readTotalAssets: async () => null,
}))

import LandingHero from '../LandingHero.jsx'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8')

const SECTIONS = ['Hero', 'SetOnce', 'VibeForever', 'RealYield', 'Leash', 'Risks', 'Final']
const ANIMATED = [
  'sections/Hero.jsx',
  'sections/SetOnce.jsx',
  'sections/VibeForever.jsx',
  'sections/RealYield.jsx',
  'sections/Leash.jsx',
  'sections/Final.jsx',
]

beforeEach(() => {
  setMotion({ reduce: false })
  localStorage.clear()
})

afterEach(cleanup)

function renderLanding(onStart = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LandingHero onStart={onStart} />
    </MemoryRouter>
  )
}

// Text a screen reader gets: decorative (aria-hidden) layers are excluded.
function readableText(container) {
  const main = container.querySelector('main').cloneNode(true)
  main.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
  return main.textContent
}

describe('Landing contract', () => {
  it('keeps the narrative order, one h1, the anchor and the public nav links', () => {
    const { container } = renderLanding()
    const sections = [...container.querySelectorAll('[data-landing-section]')]
    expect(sections.map((section) => section.dataset.landingSection)).toEqual(SECTIONS)
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Set once. Vibe forever.')
    expect(screen.getByRole('link', { name: 'See how it works' }).getAttribute('href')).toBe(
      '#how-it-works'
    )
    expect(container.querySelector('#how-it-works').dataset.landingSection).toBe('SetOnce')
    expect(
      [...container.querySelectorAll('nav a')].map((link) => link.getAttribute('href'))
    ).toEqual([
      'https://github.com/poggufanz/vibingfarmer',
      'https://vibingfarmer.gitbook.io/vibingfarmer/',
    ])
  })

  it('routes every launch button to the shared callback', () => {
    const onStart = vi.fn()
    renderLanding(onStart)
    const buttons = screen.getAllByRole('button', { name: 'Launch app' })
    expect(buttons).toHaveLength(3)
    buttons.forEach((button) => fireEvent.click(button))
    expect(onStart).toHaveBeenCalledTimes(3)
  })

  it('never locks scroll and has no intro gate', () => {
    const { container } = renderLanding()
    expect(container.querySelector('.vf-landing').style.overflow).not.toBe('hidden')
    expect(screen.queryByLabelText('Welcome')).toBeNull()
  })

  it('gives reduced-motion visitors the same readable text', () => {
    const normal = renderLanding()
    const normalText = readableText(normal.container)
    normal.unmount()

    setMotion({ reduce: true })
    const reduced = renderLanding()
    expect(readableText(reduced.container)).toBe(normalText)
  })

  it('shows honest fallbacks when on-chain reads fail', async () => {
    renderLanding()
    await waitFor(() =>
      expect(screen.getAllByText('unavailable · on-chain read failed')).toHaveLength(2)
    )
    expect(screen.getByTestId('hero-apr').textContent).toBe('--')
    expect(screen.getByTestId('yield-tvl').textContent).toBe('--')
  })
})

describe('Landing motion contract', () => {
  it('requires GSAP motion wired to the landing scroller', () => {
    for (const file of ANIMATED) {
      const source = src(file)
      expect(source, file).toMatch(/from '\.\.\/motion\/gsap\.js'/)
      expect(source, file).toMatch(/useGSAP\(/)
      expect(source, file).toMatch(/gsap\.matchMedia\(\)/)
      expect(source, file).toMatch(/scroller/)
      // autoAlpha sets visibility:hidden, which drops pending content (CTAs included) out of the
      // accessibility tree and the tab order until its trigger fires. Reveals use opacity.
      expect(source, file).not.toMatch(/autoAlpha/)
      // Pocket Crew web contract (scripts/check-pocket-crew-web.mjs REPEAT_FOREVER): ambient loops
      // are finite per viewing and restart on re-entry, never endless.
      expect(source, file).not.toMatch(/\brepeat\s*:\s*-1\b/)
    }
    expect(src('sections/VibeForever.jsx')).toMatch(/pin:\s*true/)
    expect(src('sections/VibeForever.jsx')).toMatch(/scrub:/)
    expect(src('motion/gsap.js')).toMatch(/registerPlugin\(useGSAP, ScrollTrigger\)/)
    expect(src('LandingHero.jsx')).toMatch(/ScrollerContext\.Provider/)
  })

  it('keeps landing CSS inside the Pocket Crew web contract', () => {
    const css = fs
      .readdirSync(path.join(here, '..', 'sections'))
      .filter((name) => name.endsWith('.css'))
      .map((name) => `sections/${name}`)
      .concat('LandingHero.css')
    expect(css.length).toBeGreaterThan(5)
    for (const file of css) {
      expect(src(file), file).not.toMatch(/gradient|glow|shimmer|backdrop-filter|infinite/i)
    }
  })
})
